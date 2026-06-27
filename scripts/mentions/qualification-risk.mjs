// Qualification / EDNQ helpers for mentions packets.
//
// EDNQ ("Event does not qualify") is an event-level result/outcome, not a
// spoken-term strike. The helpers here keep that separation explicit while
// also fail-closing packet generation when trusted event metadata conflicts
// with cached / advisory timing.

import { extractDateFromTicker, toEtDate } from '../packets/lib/kalshi-discovery.mjs';

export const BLOCKED_EVENT_METADATA_MISMATCH = 'BLOCKED_EVENT_METADATA_MISMATCH';

const PRESENTATION_TIME_FIELDS = Object.freeze([
  'date_time',
  'event_time',
  'event_time_utc',
  'event_window_start',
  'start_time',
  'start_time_utc',
  'scheduled_start_time',
  'scheduled_time',
]);

const FALLBACK_TIME_FIELDS = Object.freeze([
  'close_time',
  'expected_expiration_time',
  'expiration_time',
  'latest_expiration_time',
  'occurrence_datetime',
]);

const DIRECT_ROUTE_RE = /\b(trump_event|trump_weekly|trump_monthly)\b/i;
const TRUMP_RE = /\btrump\b/i;
const RISK_PATTERNS = Object.freeze([
  {
    risk: 'blocked',
    label: 'metadata mismatch',
    patterns: [
      /\bmetadata mismatch\b/i,
      /\bstale cache\b/i,
      /\bsource\/window mismatch\b/i,
      /\bdate\/time mismatch\b/i,
      /\bcancel(?:led|ed)\b/i,
      /\bpostponed\b/i,
      /\breplaced\b/i,
      /\bmaterially changed\b/i,
      /\bremarks outside (?:the )?covered\b/i,
    ],
  },
  {
    risk: 'high',
    label: 'foreign-leader-dominated / bilateral / summit side event',
    patterns: [
      /\bforeign[- ]leader\b/i,
      /\bbilateral\b/i,
      /\bsummit\b/i,
      /\bworking lunch\b/i,
      /\bmeeting\b/i,
      /\bphoto op\b/i,
      /\bpool spray\b/i,
      /\barrival footage\b/i,
      /\bshort q&a\b/i,
      /\bpartial clip\b/i,
      /\bprivate\b/i,
      /\bclosed[- ]door\b/i,
      /\bnot the qualifying speaker\b/i,
      /\bsource cannot verify\b/i,
      /\bno official\/public source\b/i,
      /\bno official public source\b/i,
      /\bunresolved nqe\b/i,
      /\bambiguous qualification evidence\b/i,
    ],
  },
  {
    risk: 'medium',
    label: 'press conference / formal remarks / interview / signing',
    patterns: [
      /\bpress conference\b/i,
      /\bformal remarks\b/i,
      /\bpublic remarks\b/i,
      /\binterview\b/i,
      /\bsigning\b/i,
      /\bconference\b/i,
      /\bpress portion\b/i,
      /\btown hall\b/i,
      /\bspeech\b/i,
    ],
  },
  {
    risk: 'low',
    label: 'direct Trump remarks / rally / conference format',
    patterns: [
      /\bremarks\b/i,
      /\brally\b/i,
      /\bconference\b/i,
      /\bspeech\b/i,
      /\btown hall\b/i,
      /\bpress conference\b/i,
      /\binterview\b/i,
    ],
  },
]);

function asText(value) {
  return value == null ? '' : String(value).trim();
}

function settlementSourceForEvent(event = {}) {
  const explicit = asText(event?.settlement_source_link ?? event?.event_url ?? event?.url);
  if (explicit) return explicit;
  const eventTicker = asText(event?.event_ticker);
  return eventTicker ? `https://kalshi.com/events/${eventTicker}` : '';
}

function eventTickerFromSettlementSource(url) {
  const text = asText(url);
  if (!text) return null;
  const match = text.match(/\/events\/([A-Z0-9_-]+)/i);
  return match?.[1]?.toUpperCase() ?? null;
}

function lowerJoined(parts) {
  return parts.map(asText).filter(Boolean).join(' ').toLowerCase();
}

function isoCandidate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function eventMarkets(event) {
  return Array.isArray(event?.markets) ? event.markets : [];
}

function firstMarket(event) {
  return eventMarkets(event)[0] ?? null;
}

function pickPresentationTime(event) {
  const candidates = [];
  const markets = eventMarkets(event);
  for (const field of PRESENTATION_TIME_FIELDS) {
    const iso = isoCandidate(event?.[field]);
    if (iso) candidates.push({ field, iso, source: `event.${field}` });
  }
  for (let i = 0; i < markets.length; i += 1) {
    const m = markets[i];
    for (const field of PRESENTATION_TIME_FIELDS) {
      const iso = isoCandidate(m?.[field]);
      if (iso) candidates.push({ field, iso, source: `markets[${i}].${field}` });
    }
  }

  if (!candidates.length) {
    for (const field of FALLBACK_TIME_FIELDS) {
      const iso = isoCandidate(event?.[field]);
      if (iso) candidates.push({ field, iso, source: `event.${field}`, fallback: true });
    }
    for (let i = 0; i < markets.length; i += 1) {
      const m = markets[i];
      for (const field of FALLBACK_TIME_FIELDS) {
        const iso = isoCandidate(m?.[field]);
        if (iso) candidates.push({ field, iso, source: `markets[${i}].${field}`, fallback: true });
      }
    }
  }

  return candidates;
}

function pushConflict(conflicts, field, expected, actual, source) {
  if (!actual) return;
  conflicts.push({
    field,
    expected,
    actual,
    source,
  });
}

export function detectEventMetadataMismatch({ date = null, event = {} } = {}) {
  const eventTicker = asText(event?.event_ticker);
  const tickerDate = extractDateFromTicker(eventTicker);
  const packetDate = asText(date) || null;
  const expectedDate = packetDate || tickerDate || null;
  const title = asText(event?.title);
  const settlementSource = settlementSourceForEvent(event);
  const conflicts = [];

  const settlementTicker = eventTickerFromSettlementSource(settlementSource);
  if (settlementTicker && eventTicker && settlementTicker !== eventTicker.toUpperCase()) {
    pushConflict(conflicts, 'settlement_source_event_ticker', eventTicker, settlementTicker, 'settlement_source');
  }

  const markets = eventMarkets(event);
  for (let i = 0; i < markets.length; i += 1) {
    const market = markets[i];
    const marketEventTicker = asText(market?.event_ticker);
    if (marketEventTicker && eventTicker && marketEventTicker.toUpperCase() !== eventTicker.toUpperCase()) {
      pushConflict(conflicts, 'market_event_ticker', eventTicker, marketEventTicker, `markets[${i}].event_ticker`);
    }

    const marketDate = marketEventTicker ? extractDateFromTicker(marketEventTicker) : null;
    if (expectedDate && marketDate && marketDate !== expectedDate) {
      pushConflict(conflicts, 'market_date', expectedDate, marketDate, `markets[${i}].ticker`);
    }
  }

  return {
    title,
    settlement_source: settlementSource || null,
    ticker_date: tickerDate,
    packet_date: packetDate,
    expected_date: expectedDate,
    conflicts,
  };
}

/**
 * Resolve the event presentation timestamp for the packet header.
 *
 * Trusted event-start / event-window fields win. Settlement-expiration fields
 * are only accepted when they agree with the packet date / ticker date.
 * Otherwise the packet must fail closed.
 */
export function resolveMentionPresentationMetadata({ date = null, event = {} } = {}) {
  const mismatch = detectEventMetadataMismatch({ date, event });
  const tickerDate = mismatch.ticker_date;
  const packetDate = mismatch.packet_date;
  const title = mismatch.title;
  const settlementSource = mismatch.settlement_source;
  const candidates = pickPresentationTime(event);
  const explicit = candidates.filter((candidate) => !candidate.fallback);
  const fallback = candidates.filter((candidate) => candidate.fallback);

  const conflicts = [...mismatch.conflicts];
  let selected = null;

  if (explicit.length) {
    selected = explicit[0];
    for (const candidate of explicit.slice(1)) {
      if (candidate.iso !== selected.iso) {
        pushConflict(conflicts, candidate.field, selected.iso, candidate.iso, candidate.source);
      }
    }
  } else if (fallback.length) {
    // Settlement-expiration fields (close_time / expected_expiration_time /
    // occurrence_datetime) are far-future ceilings for open-ended "live now" markets,
    // not the event-start date. Use the first only for display; never let these
    // ceilings — or their disagreements with each other — fail-close the packet.
    selected = fallback[0];
  }

  const eventDate = selected ? toEtDate(selected.iso) : null;
  const expectedDate = mismatch.expected_date || null;
  const selectedSource = selected?.source ?? null;

  if (selected) {
    // Only an explicit event-start timestamp may contradict the expected date.
    // A settlement-expiration fallback is a display-only ceiling and must not block.
    if (!selected.fallback && expectedDate && eventDate && expectedDate !== eventDate) {
      pushConflict(conflicts, 'event_time', expectedDate, eventDate, selectedSource);
    }
    if (packetDate && tickerDate && packetDate !== tickerDate) {
      pushConflict(conflicts, 'event_date', tickerDate, packetDate, 'event_ticker/date input');
    }
  }

  const blocked = conflicts.length > 0;

  if (blocked) {
    const blocker_conflicts = conflicts.length ? conflicts : [
      {
        field: 'event_time',
        expected: expectedDate ?? 'trusted event start time',
        actual: selected?.iso ?? 'missing',
        source: selectedSource ?? 'event metadata',
      },
    ];
    return {
      blocked: true,
      blocker_code: BLOCKED_EVENT_METADATA_MISMATCH,
      reason: 'cached / advisory timing conflicts with trusted event metadata',
      title,
      settlement_source: settlementSource,
      ticker_date: tickerDate,
      packet_date: packetDate,
      event_time_iso: selected?.iso ?? null,
      event_date: eventDate,
      event_time_source: selectedSource,
      conflicts: blocker_conflicts,
    };
  }

  return {
    blocked: false,
    blocker_code: null,
    reason: selected ? null : 'no trusted event-start timestamp found',
    title,
    settlement_source: settlementSource,
    ticker_date: tickerDate,
    packet_date: packetDate,
    event_time_iso: selected?.iso ?? null,
    event_date: eventDate,
    event_time_source: selectedSource,
    conflicts: [],
  };
}

function lowerTextParts(event = {}) {
  const markets = eventMarkets(event);
  return lowerJoined([
    event?.event_ticker,
    event?.series_ticker,
    event?.title,
    event?.sub_title,
    ...markets.flatMap((m) => [m?.title, m?.subtitle, m?.yes_sub_title, m?.no_sub_title, m?.rules_primary, m?.rules_secondary]),
  ]);
}

function pickRiskPattern(text) {
  for (const entry of RISK_PATTERNS) {
    if (entry.patterns.some((re) => re.test(text))) return entry;
  }
  return null;
}

function qualificationTermsSummary(qualificationTerms) {
  if (!Array.isArray(qualificationTerms) || !qualificationTerms.length) {
    return {
      count: 0,
      labels: [],
      label_text: 'none',
    };
  }
  const labels = qualificationTerms
    .map((term) => asText(term?._short ?? term?.short_term ?? term?.full_strike_text))
    .filter(Boolean);
  return {
    count: labels.length,
    labels,
    label_text: labels.join(', '),
  };
}

export function normalizeQualificationResult(value) {
  const text = asText(value).toLowerCase();
  if (text === 'blocked') return 'blocked';
  if (text === 'high') return 'high';
  if (text === 'medium') return 'medium';
  if (text === 'low') return 'low';
  return 'not confirmed';
}

/**
 * Classify EDNQ risk for customer-facing rendering.
 */
export function classifyEdnqRisk({
  event = {},
  researchRoute = null,
  qualificationTerms = [],
  presentation = null,
} = {}) {
  const route = asText(researchRoute);
  const text = lowerTextParts(event);
  const pattern = pickRiskPattern(text);
  const qualifier = qualificationTermsSummary(qualificationTerms);
  const directTrump = DIRECT_ROUTE_RE.test(route) || TRUMP_RE.test(text);
  const presentationBlocked = Boolean(presentation?.blocked);
  const blockers = [];

  if (presentationBlocked) {
    blockers.push(presentation.blocker_code || BLOCKED_EVENT_METADATA_MISMATCH);
    for (const conflict of Array.isArray(presentation.conflicts) ? presentation.conflicts : []) {
      blockers.push(`${conflict.field}: ${conflict.expected} != ${conflict.actual}`);
    }
  }

  let risk = 'not confirmed';
  let eventType = pattern?.label ?? 'direct Trump remarks / conference format';

  if (presentationBlocked) {
    risk = 'blocked';
  } else if (pattern?.risk === 'high') {
    risk = 'high';
  } else if (pattern?.risk === 'medium') {
    risk = directTrump ? 'low' : 'medium';
  } else if (pattern?.risk === 'low') {
    risk = pattern.risk;
  } else if (directTrump) {
    risk = 'low';
  }

  if (!pattern && qualifier.count > 0 && risk !== 'blocked') {
    risk = 'not confirmed';
  }

  const why = [];
  if (pattern?.label) {
    why.push(`Pattern match: ${pattern.label}.`);
  } else if (directTrump) {
    why.push('Direct Trump remarks, rally, or conference format usually reduces EDNQ risk.');
  } else {
    why.push('No strong format indicator confirms qualification yet.');
  }
  why.push('Event could fail to qualify if it is canceled, postponed, replaced, materially changed, becomes private or unavailable, lacks public qualifying Trump remarks, or occurs outside the covered settlement window.');
  why.push('Source/window risk rises when the source shows arrival footage, a photo op, pool spray, foreign leader remarks, a partial clip, or short Q&A instead of qualifying Trump remarks.');
  if (qualifier.count > 0) {
    why.push(`EDNQ result tracked separately from ${qualifier.count} event-level result${qualifier.count === 1 ? '' : 's'} and excluded from the content-term inventory.`);
  }
  if (presentation?.reason) {
    why.push(presentation.reason);
  }

  const currentCheck = [];
  if (presentationBlocked) {
    currentCheck.push(`BLOCKED_EVENT_METADATA_MISMATCH: ${presentation.reason || 'cached timing conflicts with trusted metadata'}.`);
  } else if (presentation?.event_time_iso) {
    currentCheck.push(`Trusted event time: ${presentation.event_time_iso} (${presentation.event_date || 'date unavailable'}).`);
  } else {
    currentCheck.push('Trusted event time not yet confirmed; do not treat settlement expiration as the event start.');
  }
  if (directTrump) {
    currentCheck.push('Direct Trump route confirmed; content-term scoring remains conditional on qualification.');
  }

  const historicalNote = 'Prior verified EDNQ YES examples were concentrated in unusual event structures such as foreign-leader-dominated or multi-party working-lunch-style formats. This sample is limited and not exhaustive.';

  return {
    event_type: eventType,
    ednq_risk: normalizeQualificationResult(risk),
    cpc_read: normalizeQualificationResult(risk),
    result_label: 'Event does not qualify',
    why_ednq: why,
    current_check: currentCheck,
    historical_note: historicalNote,
    active_blockers: blockers,
    content_term_note: 'Content-term reads are conditional on qualification.',
    qualification_term_count: qualifier.count,
    qualification_term_labels: qualifier.labels,
  };
}
