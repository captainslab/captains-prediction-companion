// Qualification / EDNQ helpers for mentions packets.
//
// EDNQ ("Event does not qualify") is an event-level result/outcome, not a
// spoken-term strike. The helpers here keep that separation explicit while
// also fail-closing packet generation when trusted event metadata conflicts
// with cached / advisory timing.

import { extractDateFromTicker, toEtDate } from '../packets/lib/kalshi-discovery.mjs';
import { declaredSettlementSource } from './event-integrity.mjs';

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

const DIRECT_ROUTE_RE = /\b(trump_event|trump_weekly|trump_monthly)\b/i;
const TRUMP_RE = /\btrump\b/i;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
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

function eventTickerFromSettlementSource(url) {
  const text = asText(url);
  if (!text) return null;
  // Only Kalshi's own event URL shape carries a comparable ticker; a proof/IR
  // settlement source (e.g. investors.example.com/events/...) is not a Kalshi
  // event page and must never be pattern-matched as if it declared one.
  try {
    if (!new URL(text).hostname.toLowerCase().replace(/^www\./, '').endsWith('kalshi.com')) return null;
  } catch {
    return null;
  }
  const match = text.match(/\/events\/([A-Z0-9_-]+)/i);
  return match?.[1]?.toUpperCase() ?? null;
}

function lowerJoined(parts) {
  return parts.map(asText).filter(Boolean).join(' ').toLowerCase();
}

function isoCandidate(value) {
  const raw = asText(value);
  if (!raw) return null;
  if (DATE_ONLY_RE.test(raw)) return `${raw}T00:00:00.000Z`;
  const d = new Date(raw);
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
  for (const field of PRESENTATION_TIME_FIELDS) {
    const raw = asText(event?.[field]);
    const iso = isoCandidate(raw);
    if (iso) candidates.push({
      field,
      iso,
      calendar_date: DATE_ONLY_RE.test(raw) ? raw : null,
      status: DATE_ONLY_RE.test(raw) ? 'DATE_WINDOW' : 'EXACT',
      source: `event.${field}`,
    });
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
  // The run date is not the event start date: packets may be generated before
  // a future event. Prefer the event-level ticker date and use packet date only
  // when no event date can be derived at all.
  const expectedDate = tickerDate || packetDate || null;
  const title = asText(event?.title);
  const settlementSource = declaredSettlementSource(event);
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
 * are never accepted as event timing. Otherwise the packet must fail closed.
 */
export function resolveMentionPresentationMetadata({ date = null, event = {} } = {}) {
  const mismatch = detectEventMetadataMismatch({ date, event });
  const tickerDate = mismatch.ticker_date;
  const packetDate = mismatch.packet_date;
  const title = mismatch.title;
  const settlementSource = mismatch.settlement_source;
  const candidates = pickPresentationTime(event);

  const conflicts = [...mismatch.conflicts];
  let selected = null;

  if (candidates.length) {
    selected = candidates[0];
    for (const candidate of candidates.slice(1)) {
      if (candidate.iso !== selected.iso) {
        pushConflict(conflicts, candidate.field, selected.iso, candidate.iso, candidate.source);
      }
    }
  }

  const eventDate = selected
    ? (selected.calendar_date ?? toEtDate(selected.iso))
    : null;
  const expectedDate = mismatch.expected_date || null;
  const selectedSource = selected?.source ?? null;

  if (selected) {
    if (expectedDate && eventDate && expectedDate !== eventDate) {
      pushConflict(conflicts, 'event_time', expectedDate, eventDate, selectedSource);
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
      event_time_status: selected?.status ?? 'UNCONFIRMED',
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
    event_time_status: selected?.status ?? 'UNCONFIRMED',
    event_date: eventDate,
    event_time_source: selectedSource,
    conflicts: [],
  };
}

function presentationTimeLabel(presentation) {
  if (presentation?.event_time_status === 'DATE_WINDOW') {
    return `${presentation.event_date || 'date unavailable'} (DATE_WINDOW)`;
  }
  return presentation?.event_time_iso ?? null;
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

function ednqRouteFamily(route, directTrump) {
  const r = asText(route).toLowerCase();
  if (directTrump || r.startsWith('trump_')) return 'trump';
  if (r === 'news_broadcast') return 'news';
  if (r === 'speech_event') return 'speech';
  if (r === 'interview_media') return 'interview';
  if (r === 'political_general' || r === 'debate_hearing' || r === 'fed_agency') return 'politics';
  if (r === 'earnings_call') return 'earnings';
  if (r === 'sports_announcer') return 'sports';
  if (r === 'talk_show_media') return 'talk_show';
  if (r === 'entertainment_reality') return 'entertainment';
  if (r === 'topic_most_mentioned') return 'topic';
  return 'generic';
}

const EDNQ_FAMILY_WORDING = Object.freeze({
  news: {
    event_type: 'news-broadcast format',
    no_format: 'No confirmed broadcast edition or source window is set yet.',
    cancel: 'The event may fail to qualify if the covered newscast is preempted, replaced, rescheduled, or the term appears outside that edition.',
    source: 'Source/window risk rises when the official broadcast video or matching transcript is delayed, partial, unavailable, or for a different edition.',
    historical: 'EDNQ history for news-broadcast mention markets is edition-specific; do not assume a generic news base rate.',
  },
  speech: {
    event_type: 'speech or remarks format',
    no_format: 'No confirmed speech venue, speaker, or public source window is set yet.',
    cancel: 'The event may fail to qualify if remarks are canceled, materially changed, private, or outside the covered speech.',
    source: 'Source/window risk rises when the official video or transcript is delayed, partial, or for a different appearance.',
    historical: 'EDNQ history for speeches is appearance-specific; do not transfer it across venues or speakers.',
  },
  interview: {
    event_type: 'interview format',
    no_format: 'No confirmed interview program, guest slot, or source window is set yet.',
    cancel: 'The event may fail to qualify if the interview is canceled, replaced, or the wording appears outside the covered segment.',
    source: 'Source/window risk rises when the program video or transcript is delayed, partial, unavailable, or for a different segment.',
    historical: 'EDNQ history for interviews is program- and guest-specific; do not assume a generic interview base rate.',
  },
  politics: {
    event_type: 'political event format',
    no_format: 'No strong event-format indicator confirms qualification yet.',
    cancel: 'Event could fail to qualify if it is canceled, postponed, replaced, materially changed, becomes private or unavailable, lacks public qualifying remarks from the covered speaker, or occurs outside the covered settlement window.',
    source: 'Source/window risk rises when the source shows arrival footage, a photo op, a partial clip, or a short Q&A instead of qualifying remarks from the covered speaker.',
    historical: 'Prior verified EDNQ outcomes clustered in unusual event structures such as format changes, non-qualifying appearances, or coverage gaps. This sample is limited and not exhaustive.',
  },
  earnings: {
    event_type: 'earnings-call format',
    no_format: 'No confirmed earnings-call schedule or format detail is set yet.',
    cancel: 'Event could fail to qualify if the earnings call is canceled, rescheduled, or the wording is said outside the covered earnings call / Q&A window.',
    source: 'Source/window risk rises when the webcast or transcript is delayed, partial, or the term appears only in written materials rather than the covered call.',
    historical: 'EDNQ history for earnings-call mention markets is limited; treat qualification as event-specific rather than assuming a base rate.',
  },
  sports: {
    event_type: 'live sports broadcast format',
    no_format: 'No confirmed broadcast or announcer detail is set yet for this match.',
    cancel: 'Event could fail to qualify if the match or broadcast is postponed, abandoned, or the wording is said outside the covered live broadcast window.',
    source: 'Source/window risk rises when the broadcast feed, announcer coverage, or transcript is unavailable, partial, or differs from the covered coverage.',
    historical: 'EDNQ history for sports-broadcast mention markets is limited; treat qualification as event-specific rather than assuming a base rate.',
  },
  talk_show: {
    event_type: 'talk-show / broadcast format',
    no_format: 'No confirmed show or segment detail is set yet for this appearance.',
    cancel: 'Event could fail to qualify if the show is preempted, the segment is cut, or the wording is said outside the covered broadcast window.',
    source: 'Source/window risk rises when the episode airing, guest lineup, or transcript is delayed, partial, or differs from the covered broadcast.',
    historical: 'EDNQ history for talk-show mention markets is limited; treat qualification as event-specific rather than assuming a base rate.',
  },
  entertainment: {
    event_type: 'episode broadcast format',
    no_format: 'No confirmed episode detail is set yet for this show.',
    cancel: 'Event could fail to qualify if the episode is preempted, rescheduled, or the wording is said outside the covered episode window.',
    source: 'Source/window risk rises when the episode airing or transcript is delayed, partial, or differs from the covered broadcast.',
    historical: 'EDNQ history for entertainment mention markets is limited; treat qualification as event-specific rather than assuming a base rate.',
  },
  topic: {
    event_type: 'counting-window format',
    no_format: 'No confirmed counting-window detail is set yet.',
    cancel: 'Event could fail to qualify if the counting window is canceled, rescheduled, or the wording is counted outside the covered window.',
    source: 'Source/window risk rises when the counting-window feed or transcript is delayed, partial, or differs from the covered window.',
    historical: 'EDNQ history for word-bank / most-mentioned markets is limited; treat qualification as event-specific rather than assuming a base rate.',
  },
  generic: {
    event_type: 'event format',
    no_format: 'No strong format indicator confirms qualification yet.',
    cancel: 'Event could fail to qualify if it is canceled, postponed, replaced, materially changed, becomes private or unavailable, or occurs outside the covered settlement window.',
    source: 'Source/window risk rises when the covering source is delayed, partial, or unavailable, or the wording appears outside the covered window.',
    historical: 'EDNQ history for this market type is limited; treat qualification as event-specific rather than assuming a base rate.',
  },
});

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

  const family = ednqRouteFamily(route, directTrump);
  if (family !== 'trump') {
    const w = EDNQ_FAMILY_WORDING[family] ?? EDNQ_FAMILY_WORDING.generic;
    const politicsPattern = family === 'politics' ? pattern : null;
    let familyRisk = 'not confirmed';
    if (presentationBlocked) familyRisk = 'blocked';
    else if (politicsPattern?.risk === 'high') familyRisk = 'high';
    else if (politicsPattern?.risk === 'medium') familyRisk = 'medium';
    else if (politicsPattern?.risk === 'low') familyRisk = 'low';

    const familyWhy = [];
    familyWhy.push(politicsPattern?.label ? `Pattern match: ${politicsPattern.label}.` : w.no_format);
    familyWhy.push(w.cancel);
    familyWhy.push(w.source);
    if (qualifier.count > 0) {
      familyWhy.push(`EDNQ result tracked separately from ${qualifier.count} event-level result${qualifier.count === 1 ? '' : 's'} and excluded from the content-term inventory.`);
    }
    if (presentation?.reason) familyWhy.push(presentation.reason);

    const familyCheck = [];
    if (presentationBlocked) {
      familyCheck.push(`BLOCKED_EVENT_METADATA_MISMATCH: ${presentation.reason || 'cached timing conflicts with trusted metadata'}.`);
    } else if (presentationTimeLabel(presentation)) {
      familyCheck.push(`Trusted event time: ${presentationTimeLabel(presentation)}.`);
    } else {
      familyCheck.push('Trusted event time not yet confirmed; do not treat settlement expiration as the event start.');
    }

    return {
      event_type: politicsPattern?.label ?? w.event_type,
      ednq_risk: normalizeQualificationResult(familyRisk),
      cpc_read: normalizeQualificationResult(familyRisk),
      result_label: 'Event does not qualify',
      why_ednq: familyWhy,
      current_check: familyCheck,
      historical_note: w.historical,
      active_blockers: blockers,
      content_term_note: 'Content-term reads are conditional on qualification.',
      qualification_term_count: qualifier.count,
      qualification_term_labels: qualifier.labels,
    };
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
  } else if (presentationTimeLabel(presentation)) {
    currentCheck.push(`Trusted event time: ${presentationTimeLabel(presentation)}.`);
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
