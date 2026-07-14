// Event-local identity and publication-integrity helpers for Captain Mentions.
// Pure, state-free, and deliberately independent of quote/market adapters.

import { extractDateFromTicker } from '../packets/lib/kalshi-discovery.mjs';

const EVENT_URL_RE = /\/events\/([A-Z0-9_-]+)\/?$/i;
const EVENT_START_FIELDS = Object.freeze([
  'date_time', 'event_time', 'event_time_utc', 'event_window_start', 'start_time',
  'start_time_utc', 'scheduled_start_time', 'scheduled_time',
]);
const PRICE_KEY_RE = /(?:^|_)(?:price|bid|ask|odds|volume|open_interest|liquidity|spread|last_trade)(?:$|_)/i;

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

function declaredSettlementSource(event = {}) {
  const declared = Array.isArray(event.settlement_sources)
    ? event.settlement_sources
      .map((entry) => text(entry?.url))
      .filter(Boolean)
    : [];
  const explicit = text(event.settlement_source_link ?? event.settlement_source);
  const eventUrl = exactEventUrl(event.event_url ?? event.url, event.event_ticker ?? event.ticker);
  const candidate = declared[0] || explicit || null;
  // The Kalshi event page identifies the contract; it is not the settlement
  // authority. Never silently reuse it as settlement_source.
  return candidate && candidate !== eventUrl ? candidate : null;
}

function eventTimeCandidates(event = {}) {
  return EVENT_START_FIELDS
    .map((field) => ({ field, iso: iso(event[field]) }))
    .filter((candidate) => candidate.iso);
}

function canonicalEventTime(event = {}) {
  const candidates = eventTimeCandidates(event);
  const distinct = [...new Set(candidates.map((candidate) => candidate.iso))];
  if (distinct.length !== 1) {
    return {
      status: 'UNCONFIRMED', iso: null, source: null,
      conflicts: candidates.length > 1 ? candidates : [],
    };
  }
  return { status: 'CONFIRMED', iso: distinct[0], source: candidates[0].field, conflicts: [] };
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
  date = null, event = {}, generatedUtc = null, researchTimestamp = null,
} = {}) {
  const eventTicker = text(event.event_ticker ?? event.ticker) || null;
  const seriesTicker = text(event.series_ticker ?? event.series) || null;
  const eventUrl = exactEventUrl(event.event_url ?? event.url, eventTicker);
  const eventTime = canonicalEventTime(event);
  const dateResult = canonicalDate(event, date, eventTicker);
  const generated = iso(generatedUtc) || new Date().toISOString();
  const research = iso(researchTimestamp ?? event.research_timestamp ?? event.researched_at_utc);
  const settlementSource = declaredSettlementSource(event);
  const sourceGaps = [];
  if (!eventTicker) sourceGaps.push('kalshi event ticker unavailable');
  if (!seriesTicker) sourceGaps.push('kalshi series ticker unavailable');
  if (!eventUrl) sourceGaps.push('verified exact event URL unavailable (event-level /events/<event_ticker> required)');
  if (eventTime.status !== 'CONFIRMED') sourceGaps.push('authoritative event start time unconfirmed');
  if (!settlementSource) sourceGaps.push('authoritative settlement source unavailable');
  if (dateResult.conflicts.length) sourceGaps.push(`event date conflict: ${dateResult.conflicts.join(', ')}`);
  return Object.freeze({
    kalshi_event_ticker: eventTicker,
    kalshi_series_ticker: seriesTicker,
    kalshi_event_url: eventUrl,
    settlement_source: settlementSource,
    event_date: dateResult.value,
    event_date_conflicts: Object.freeze(dateResult.conflicts),
    event_time_central: Object.freeze({ ...eventTime, timezone: 'America/Chicago' }),
    generated_utc: generated,
    generated_central: generated,
    research_timestamp: research,
    source_gaps: Object.freeze([...sourceGaps]),
  });
}

export function validateCanonicalMentionIdentity(identity = {}) {
  const gaps = Array.isArray(identity.source_gaps) ? [...identity.source_gaps] : [];
  if (!text(identity.kalshi_event_ticker)) gaps.push('kalshi event ticker unavailable');
  if (!text(identity.kalshi_series_ticker)) gaps.push('kalshi series ticker unavailable');
  if (!identity.kalshi_event_url) gaps.push('verified exact event URL unavailable');
  if (identity.event_time_central?.status !== 'CONFIRMED') gaps.push('authoritative event start time unconfirmed');
  if (!identity.settlement_source) gaps.push('authoritative settlement source unavailable');
  if (!identity.generated_utc) gaps.push('generated UTC timestamp unavailable');
  if (!identity.research_timestamp) gaps.push('research timestamp unavailable');
  return { ok: gaps.length === 0, source_gaps: [...new Set(gaps)] };
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
  const identityCheck = validateCanonicalMentionIdentity(identity);
  const routeCheck = validateRouteTextIsolation({ route, text: packetText, allowedTerms });
  return {
    ok: identityCheck.ok && routeCheck.ok,
    source_gaps: [...identityCheck.source_gaps, ...routeCheck.gaps],
  };
}

export function formatCanonicalEventTime(identity) {
  if (identity?.event_time_central?.status !== 'CONFIRMED') return 'UNCONFIRMED';
  const value = new Date(identity.event_time_central.iso);
  if (!Number.isFinite(value.getTime())) return 'UNCONFIRMED';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: 'short', day: '2-digit',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(value);
}
