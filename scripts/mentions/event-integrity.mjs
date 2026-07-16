// Event-local identity and publication-integrity helpers for Captain Mentions.
// Pure, state-free, and deliberately independent of quote/market adapters.

import { canonicalKalshiEventUrl, extractDateFromTicker } from '../packets/lib/kalshi-discovery.mjs';
import { FAMILY_PRIORITY, classifyPriorityFamily } from './source-priority-registry.mjs';
import { routeGroupOf } from './route-taxonomy.mjs';

const EVENT_URL_RE = /\/events\/([A-Z0-9_-]+)\/?$/i;
const EVENT_START_FIELDS = Object.freeze([
  'date_time', 'event_time', 'event_time_utc', 'event_window_start', 'start_time',
  'start_time_utc', 'scheduled_start_time', 'scheduled_time',
]);
const PRICE_KEY_RE = /(?:^|_)(?:price|bid|ask|odds|volume|open_interest|liquidity|spread|last_trade)(?:$|_)/i;
const EVENT_TIME_GAP = 'authoritative event start time unconfirmed';
const COMPARATIVE_ROUTE_GROUP = 'comparative_count_or_ranking';
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function text(value) { return value == null ? '' : String(value).trim(); }

function iso(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function exactEventUrl(value, ticker) {
  if (!ticker || !value) return null;
  try {
    const url = new URL(String(value));
    const match = url.pathname.match(EVENT_URL_RE);
    if (!match || match[1].toUpperCase() !== ticker.toUpperCase()) return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function sourceHost(value) {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function proofDomainMatches(value, domain) {
  const host = sourceHost(value);
  const normalized = String(domain ?? '').toLowerCase().replace(/^www\./, '').trim();
  return Boolean(host && normalized && (host === normalized || host.endsWith(`.${normalized}`)));
}

export function declaredSettlementSource(event = {}) {
  const declared = Array.isArray(event.settlement_sources)
    ? event.settlement_sources
      .map((entry) => text(entry?.url))
      .filter(Boolean)
    : [];
  const explicit = text(event.settlement_source_link ?? event.settlement_source);
  const eventTicker = event.event_ticker ?? event.ticker;
  const explicitEventUrl = event.event_url ?? event.url;
  const eventUrl = exactEventUrl(explicitEventUrl, eventTicker)
    ?? (!explicitEventUrl && eventTicker ? canonicalKalshiEventUrl(eventTicker) : null);
  const family = classifyPriorityFamily(event);
  const proofDomains = FAMILY_PRIORITY[family]?.proof ?? FAMILY_PRIORITY.generic.proof;
  const candidate = declared.find((url) => proofDomains.some((domain) => proofDomainMatches(url, domain)))
    ?? declared[0]
    ?? explicit
    ?? null;
  // The Kalshi event page identifies the contract; it is not the settlement
  // authority. Never silently reuse it as settlement_source.
  return candidate && candidate !== eventUrl ? candidate : null;
}

function eventTimeCandidates(event = {}) {
  return EVENT_START_FIELDS
    .map((field) => {
      const raw = text(event[field]);
      if (!raw) return null;
      if (DATE_ONLY_RE.test(raw)) {
        return {
          field,
          iso: `${raw}T00:00:00.000Z`,
          calendarDate: raw,
          status: 'DATE_WINDOW',
        };
      }
      const normalized = iso(raw);
      return normalized
        ? { field, iso: normalized, calendarDate: normalized.slice(0, 10), status: 'EXACT' }
        : null;
    })
    .filter(Boolean);
}

export function canonicalEventTime(event = {}) {
  const candidates = eventTimeCandidates(event);
  const exact = candidates.filter((candidate) => candidate.status === 'EXACT');
  const dateWindows = candidates.filter((candidate) => candidate.status === 'DATE_WINDOW');
  const exactDistinct = [...new Set(exact.map((candidate) => candidate.iso))];
  const dateDistinct = [...new Set(dateWindows.map((candidate) => candidate.calendarDate))];

  const exactDateConflict = exactDistinct.length === 1
    && dateDistinct.length === 1
    && exact[0].calendarDate !== dateDistinct[0];
  if (exactDistinct.length > 1 || dateDistinct.length > 1 || exactDateConflict) {
    return {
      status: 'UNCONFIRMED', iso: null, source: null,
      conflicts: candidates.length > 1 ? candidates : [],
    };
  }
  if (exactDistinct.length === 1) {
    return { status: 'EXACT', iso: exactDistinct[0], source: exact[0].field, conflicts: [] };
  }
  if (dateDistinct.length === 1) {
    return {
      status: 'DATE_WINDOW',
      iso: dateWindows[0].iso,
      calendar_date: dateWindows[0].calendarDate,
      source: dateWindows[0].field,
      conflicts: [],
    };
  }
  return { status: 'UNCONFIRMED', iso: null, source: null, conflicts: [] };
}

function canonicalDate(event, packetDate, ticker) {
  const tickerDate = extractDateFromTicker(ticker);
  const explicit = text(event?.event_date ?? event?.date);
  const supplied = text(packetDate);
  // Packet generation date is operational metadata, not event identity. A
  // future event can be rendered during the prior run; only event-level
  // sources participate in event-date conflict detection.
  const dates = [tickerDate, explicit].filter(Boolean);
  const distinct = [...new Set(dates)];
  return {
    value: tickerDate || explicit || supplied || null,
    conflicts: distinct.length > 1 ? distinct : [],
  };
}

export function buildCanonicalMentionIdentity({
  date = null, event = {}, route = null, generatedUtc = null, researchTimestamp = null,
} = {}) {
  const eventTicker = text(event.event_ticker ?? event.ticker) || null;
  const seriesTicker = text(event.series_ticker ?? event.series) || null;
  const explicitEventUrl = event.event_url ?? event.url;
  const eventUrl = exactEventUrl(explicitEventUrl, eventTicker)
    ?? (!explicitEventUrl && eventTicker ? canonicalKalshiEventUrl(eventTicker) : null);
  const eventTime = canonicalEventTime(event);
  const dateResult = canonicalDate(event, date, eventTicker);
  const generated = iso(generatedUtc) || new Date().toISOString();
  const research = iso(researchTimestamp ?? event.research_timestamp ?? event.researched_at_utc);
  const settlementSource = declaredSettlementSource(event);
  const sourceGaps = [];
  if (!eventTicker) sourceGaps.push('kalshi event ticker unavailable');
  if (!seriesTicker) sourceGaps.push('kalshi series ticker unavailable');
  if (!eventUrl) sourceGaps.push('verified exact event URL unavailable (event-level /events/<event_ticker> required)');
  if (eventTime.status === 'UNCONFIRMED') sourceGaps.push(EVENT_TIME_GAP);
  if (!settlementSource) sourceGaps.push('authoritative settlement source unavailable');
  if (dateResult.conflicts.length) sourceGaps.push(`event date conflict: ${dateResult.conflicts.join(', ')}`);
  return Object.freeze({
    kalshi_event_ticker: eventTicker,
    kalshi_series_ticker: seriesTicker,
    kalshi_event_url: eventUrl,
    declared_source_url: text(event.declared_source_url) || null,
    settlement_source: settlementSource,
    event_date: dateResult.value,
    event_date_conflicts: Object.freeze(dateResult.conflicts),
    event_time_central: Object.freeze({ ...eventTime, timezone: 'America/Chicago' }),
    route: route ?? null,
    route_group: routeGroupOf(route),
    generated_utc: generated,
    generated_central: generated,
    research_timestamp: research,
    source_gaps: Object.freeze([...sourceGaps]),
  });
}

export function validateCanonicalMentionIdentity(identity = {}, route = null) {
  const effectiveRoute = route ?? identity.route ?? null;
  const comparative = routeGroupOf(effectiveRoute) === COMPARATIVE_ROUTE_GROUP;
  // Identity-critical gaps: any of these could mean the wrong contract gets
  // scored/settled (wrong ticker, unverifiable event, no settlement source),
  // so they remain a hard publication stop.
  const identityGaps = (Array.isArray(identity.source_gaps) ? [...identity.source_gaps] : [])
    .filter((gap) => gap !== EVENT_TIME_GAP && gap !== 'generated UTC timestamp unavailable' && gap !== 'research timestamp unavailable');
  if (!text(identity.kalshi_event_ticker)) identityGaps.push('kalshi event ticker unavailable');
  if (!text(identity.kalshi_series_ticker)) identityGaps.push('kalshi series ticker unavailable');
  if (!identity.kalshi_event_url) identityGaps.push('verified exact event URL unavailable');
  if (!identity.settlement_source) identityGaps.push('authoritative settlement source unavailable');
  // Provenance/freshness gaps: event-time precision, generation timestamp,
  // and research timestamp all describe WHEN something happened, never WHICH
  // contract is being scored. None of them risk scoring the wrong contract,
  // so per product rule they degrade an already-valid, already-rendered
  // packet instead of suppressing it — they still surface in source_gaps so
  // the packet can disclose/degrade on them.
  const eventTimeStatus = identity.event_time_central?.status;
  const provenanceGaps = [];
  if (!comparative && eventTimeStatus !== 'EXACT' && eventTimeStatus !== 'DATE_WINDOW') provenanceGaps.push(EVENT_TIME_GAP);
  if (!identity.generated_utc) provenanceGaps.push('generated UTC timestamp unavailable');
  if (!identity.research_timestamp) provenanceGaps.push('research timestamp unavailable');
  return {
    ok: identityGaps.length === 0,
    source_gaps: [...new Set([...identityGaps, ...provenanceGaps])],
  };
}

export function assertPriceBlind(value, path = 'value') {
  if (value == null || typeof value !== 'object') return true;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPriceBlind(entry, `${path}[${index}]`));
    return true;
  }
  for (const [key, child] of Object.entries(value)) {
    if (PRICE_KEY_RE.test(key)) throw new Error(`price firewall violation at ${path}.${key}`);
    assertPriceBlind(child, `${path}.${key}`);
  }
  return true;
}

const SPORTS_FRAMING_RE = /\b(?:announcer|commentator|commentary|pregame|postgame|play-by-play|sports broadcast|game broadcast|sports desk|scoreboard|halftime)\b/i;

export function validateRouteTextIsolation({ route, text: packetText, allowedTerms = [] } = {}) {
  if (route === 'sports_announcer') return { ok: true, gaps: [] };
  const body = text(packetText);
  const scrubbed = (Array.isArray(allowedTerms) ? allowedTerms : [])
    .filter(Boolean)
    .reduce((out, term) => out.replace(new RegExp(String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ''), body);
  return SPORTS_FRAMING_RE.test(scrubbed)
    ? { ok: false, gaps: ['sports-specific framing leaked into a non-sports packet'] }
    : { ok: true, gaps: [] };
}

export function validateMentionPacketIntegrity({ identity, packetText = '', route = null, allowedTerms = [] } = {}) {
  const identityCheck = validateCanonicalMentionIdentity(identity, route);
  const routeCheck = validateRouteTextIsolation({ route, text: packetText, allowedTerms });
  return {
    ok: identityCheck.ok && routeCheck.ok,
    source_gaps: [...identityCheck.source_gaps, ...routeCheck.gaps],
  };
}

export function formatCanonicalEventTime(identity) {
  const status = identity?.event_time_central?.status;
  if (status === 'UNCONFIRMED') return 'UNCONFIRMED';
  const value = new Date(identity.event_time_central.iso);
  if (!Number.isFinite(value.getTime())) return 'UNCONFIRMED';
  if (status === 'DATE_WINDOW') {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC', year: 'numeric', month: 'short', day: '2-digit',
    }).format(value) + ' (DATE_WINDOW)';
  }
  if (status !== 'EXACT') return 'UNCONFIRMED';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: 'short', day: '2-digit',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(value);
}
