#!/usr/bin/env node
// Mentions daily packet generator.
// One packet per Kalshi Mentions event. No trades. No execution.
// Marks MISSING when source data is unavailable instead of inventing.
//
// Routing rules:
//   * Events are containers. event.event_ticker, title, sub_title, series.
//   * Markets are the contracts. Each gets its own block under the event.
//   * Display strike text comes from market title/subtitle/strike fields,
//     never from ticker shorthand.
//   * Undated long-horizon events are DROPPED from daily windows unless the
//     caller explicitly enables --allow-undated.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parsePacketArgs,
  ensurePacketDir,
  writeAudit,
  previewAudit,
  packetHeader,
  packetFooter,
  printDryRunSummary,
  readJsonIfExists,
  runPacketCommand,
} from './lib/common.mjs';
import {
  fetchKalshiEvents,
  filterByEventDate,
  persistEventArtifacts,
  canonicalKalshiEventUrl,
  summarizeEvent,
  normalizeMarket,
  KALSHI_SOURCES,
  filterMentionEvents,
  fetchMentionEventsBySeries,
  extractDateFromTicker,
} from './lib/kalshi-discovery.mjs';
import { evaluateDecisionProcess, MARKET_TYPES, renderDecisionProcess, describeDecisionStatus } from '../shared/decision-process.mjs';
import { buildPerplexityEntityAttachmentContract } from '../shared/perplexity-attachment-contract.mjs';
import { composeMentionLedgerFromTermRecord } from '../mentions/mention-composite-core.mjs';
import { buildResearchTermNote } from '../mentions/mentions-research-perplexity.mjs';
import { buildCustomerSettlementForms } from '../mentions/rules-analyst.mjs';
import {
  PROFILE_KEY as POLITICAL_PROFILE,
  LAYER_DEFS as POLITICAL_LAYERS,
} from '../mentions/profiles/political-mentions.mjs';
import {
  PROFILE_KEY as EARNINGS_PROFILE,
  LAYER_DEFS as EARNINGS_LAYERS,
} from '../mentions/profiles/earnings-mentions.mjs';
import {
  PROFILE_KEY as SPORTS_ANNOUNCER_PROFILE,
  LAYER_DEFS as SPORTS_ANNOUNCER_LAYERS,
} from '../mentions/profiles/sports-announcer-mentions.mjs';
import {
  evaluateSourceLadder,
  applyQualificationCap,
  renderSourceLadder,
} from '../mentions/source-ladder.mjs';
import {
  collectAlphaMentionIntake,
  formatAlphaIntakeSummary,
} from '../mentions/alpha-intake.mjs';
import {
  buildInventoryArtifact,
  EDGE_STATUS,
} from '../shared/decision-packet.mjs';
import {
  runHermesChat,
  resolveHermesCommand,
} from '../../src/hermesRuntime.js';
import {
  fetchAnalystFields,
  fetchRedteamFields,
} from '../mentions/model-router.mjs';
import {
  detectSourceHealthDisclosure,
} from '../cron/cpc-packet-janitor.mjs';
import {
  renderMentionPacket,
  validateRenderedPacket,
  shortTerm,
  CUSTOMER_RENDERER_ID,
} from '../mentions/render-mention-packet.mjs';
import {
  resolveMentionPresentationMetadata,
  BLOCKED_EVENT_METADATA_MISMATCH,
} from '../mentions/qualification-risk.mjs';
import { resolveResearchRoute } from '../mentions/mention-route-resolver.mjs';
import { gateMentionMarket } from '../mentions/lexical-gate.mjs';
import {
  loadHistoryWithStatus,
  buildHistoryMatch,
  historyToLayerScore,
  buildSettledHistoryArtifact,
} from '../mentions/settled-history.mjs';
import { buildMarketRulesSnapshot } from '../mentions/rules-analyst.mjs';
import { FAMILY_PENALTY_STRONG, FAMILY_PENALTY_THIN, FAMILY_STRONG_MIN_N, earningsHistoryToLayerScore, familyStatsExcludingCompany, fetchEarningsFamilyHistory } from '../mentions/earnings-family-history.mjs';
import {
  resolveEarningsFamily,
  loadEarningsHistory,
  buildEarningsQuarterLayer,
  earningsLayerToHistoricalTendency,
} from '../mentions/earnings-quarter-history.mjs';

import {
  buildEarningsContextDelta,
  postureAdjustmentHint,
  CAPPED_MAX_POSTURE,
} from '../mentions/earnings-context-delta.mjs';
import {
  buildSportsSettledHistory,
  detectSport,
  extractTeamsFromTitle as sportsExtractTeams,
  extractVenueFromTitle as sportsExtractVenue,
  filterBySport,
} from '../mentions/sports-settled-history.mjs';
import { buildSportsGameContext } from '../mentions/sports-game-context.mjs';
import {
  buildPmtAdvisoryContext,
} from '../mentions/pmt-advisory-context.mjs';
import {
  buildCanonicalMentionIdentity,
  validateCanonicalMentionIdentity,
  assertPriceBlind,
} from '../mentions/event-integrity.mjs';

const PACKET_TYPE = 'mentions-daily';
// Normal cron path is today-only: window 0 keeps events whose derived date is
// the run date. The forward-looking week scan survives behind --watchlist
// (or an explicit --window-days N) and writes to a separate packet dir that
// the cron sender never touches.
export const DEFAULT_WINDOW_DAYS = 0;
export const WATCHLIST_WINDOW_DAYS = 7;
export const WATCHLIST_PACKET_TYPE = 'mentions-watchlist';
const PACKET_LIMIT = 60;       // safety cap on packets emitted per run
const PROFILE_REGISTRY = Object.freeze({
  [POLITICAL_PROFILE]: {
    layerDefs: POLITICAL_LAYERS,
  },
  [EARNINGS_PROFILE]: {
    layerDefs: EARNINGS_LAYERS,
  },
  [SPORTS_ANNOUNCER_PROFILE]: {
    layerDefs: SPORTS_ANNOUNCER_LAYERS,
  },
});
const POSTURE_RANK = Object.freeze({
  NO_CLEAR_PICK: 0,
  WATCH: 1,
  LEAN: 2,
  EVIDENCE_LEAN: 3,
  PICK: 4,
});

// Source-status values that mean the research layer did NOT produce usable
// source evidence for this market: either it never ran (no declared official
// source URL), or every fetch path was blocked/timed out. A market carrying one
// of these AND no source-backed (beyond-proximity) evidence layer must FAIL
// CLOSED — it can never become a valid customer row from event proximity alone.
const NO_RESEARCH_SOURCE_STATUSES = Object.freeze(new Set([
  'NO_DECLARED_SOURCES',
  'SOURCE_FETCH_BLOCKED_BY_SITE',
  'SOURCE_FETCH_TIMEOUT',
  'RESEARCH_SCORE_INVALID',
]));

export function isNoResearchSourceStatus(status) {
  return typeof status === 'string' && NO_RESEARCH_SOURCE_STATUSES.has(status);
}

function asText(value) {
  return value == null ? '' : String(value).trim();
}

function validProfile(value) {
  const key = asText(value);
  return Object.hasOwn(PROFILE_REGISTRY, key) ? key : null;
}

function lowerJoined(parts) {
  return parts.map(asText).filter(Boolean).join(' ').toLowerCase();
}

function speakerLabelForEvent(event = {}) {
  const text = lowerJoined([event?.title, event?.sub_title, event?.event_ticker, event?.series_ticker]);
  if (/\btrump\b/.test(text)) return 'Trump';
  return null;
}

// Adapter: fold event + market + legacy text fields into the event-like shape
// the shared route resolver expects, so generator and collector resolve the
// same route from the same resolver (scripts/mentions/mention-route-resolver.mjs).
function routeEventLike({ event = null, market = null, legacy = null } = {}) {
  // Route is an EVENT-level decision: use the whole market board when the
  // event carries one (matching the collector's view), falling back to the
  // single market. Legacy strike terms (target_phrase) belong with markets,
  // never event-level text — a Trump strike on a Mamdani event must not make
  // it a Trump event.
  const markets = Array.isArray(event?.markets) && event.markets.length
    ? event.markets
    : (market ? [market] : []);
  const legacyStrike = lowerJoined([legacy?.target_phrase, legacy?.phrase, legacy?.keyword]) || null;
  return {
    event_ticker: event?.event_ticker ?? legacy?.event_id ?? null,
    series_ticker: event?.series_ticker ?? null,
    title: event?.title ?? null,
    sub_title: lowerJoined([
      event?.sub_title,
      legacy?.speaker,
      legacy?.company,
      legacy?.entity,
      legacy?.context,
      legacy?.event_context,
    ]) || null,
    close_time: event?.close_time ?? null,
    markets: legacyStrike ? [...markets, { title: legacyStrike }] : markets,
  };
}

const EVENT_START_FIELDS = Object.freeze([
  'date_time', 'event_time', 'event_time_utc', 'event_window_start', 'start_time',
  'start_time_utc', 'scheduled_start_time', 'scheduled_time',
]);

function confirmedTimingCandidate(value, confirmed = true) {
  if (!confirmed || value == null || String(value).trim() === '') return null;
  return String(value).trim();
}

const STATED_MONTHS = Object.freeze({
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
});
const STATED_MONTH_DATE_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i;
const STATED_ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/;

// Confirmed calendar DATE (never an instant) stated in the event's own Kalshi
// metadata: an explicit human-readable date in sub_title/title, accepted ONLY
// when it agrees with the event ticker's own date suffix. Two independent
// Kalshi-native signals must corroborate; otherwise null (fail closed). This
// never reads close/expiration/occurrence/settlement fields — it is a calendar
// date, not a start instant, so it feeds the timing contract as DATE_WINDOW.
export function kalshiStatedEventDate(event = {}) {
  const tickerDate = extractDateFromTicker(event?.event_ticker ?? event?.ticker);
  if (!tickerDate) return null;
  const text = [event?.sub_title, event?.title].map(asText).filter(Boolean).join(' ');
  if (!text) return null;
  let stated = null;
  const monthMatch = text.match(STATED_MONTH_DATE_RE);
  if (monthMatch) {
    const mm = STATED_MONTHS[monthMatch[1].toLowerCase().slice(0, 3)];
    const day = Number(monthMatch[2]);
    if (mm && day >= 1 && day <= 31) stated = `${monthMatch[3]}-${mm}-${String(day).padStart(2, '0')}`;
  }
  if (!stated) {
    const isoMatch = text.match(STATED_ISO_DATE_RE);
    if (isoMatch) stated = `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }
  return stated && stated === tickerDate ? tickerDate : null;
}

// Research/discovery may know the schedule without the Kalshi event object
// carrying it yet. Project only confirmed, non-settlement timing onto the
// existing event_time field. Expiration/close fields are intentionally absent.
export function attachConfirmedEventTiming(event, route, { researchEntry = null, earningsQuarters = null } = {}) {
  const existing = EVENT_START_FIELDS.find((field) => event?.[field] != null && String(event[field]).trim() !== '');
  if (existing) return { ...event };

  const sources = [
    { value: researchEntry?.event_time, confirmed: true },
    { value: researchEntry?.event_time_utc, confirmed: true },
    { value: event?.schedule?.event_date_utc, confirmed: event?.schedule?.confirmed === true },
    { value: researchEntry?.schedule?.event_date_utc, confirmed: researchEntry?.schedule?.confirmed === true },
    { value: event?.earnings_schedule?.call_date_utc, confirmed: event?.earnings_schedule?.confirmed === true },
    { value: researchEntry?.earnings_schedule?.call_date_utc, confirmed: researchEntry?.earnings_schedule?.confirmed === true },
    { value: event?.sports_discovery?.kickoff_utc, confirmed: event?.sports_discovery?.confirmed === true },
    { value: event?.sports_discovery?.start_time_utc, confirmed: event?.sports_discovery?.confirmed === true },
    { value: researchEntry?.sports_discovery?.kickoff_utc, confirmed: researchEntry?.sports_discovery?.confirmed === true },
    { value: researchEntry?.sports_discovery?.start_time_utc, confirmed: researchEntry?.sports_discovery?.confirmed === true },
  ];

  if (route === 'earnings_call' && Array.isArray(earningsQuarters)) {
    const matchingQuarter = earningsQuarters.find((quarter) => quarter?.event_ticker === event?.event_ticker);
    sources.push({ value: matchingQuarter?.event_time, confirmed: true });
    sources.push({ value: matchingQuarter?.event_date, confirmed: true });
  }

  // Confirmed research/schedule/earnings timing (may be an EXACT instant) wins.
  // When none exists, fall back to the event's own Kalshi-stated calendar date
  // (date-only -> DATE_WINDOW). Never an invented instant, never expiration.
  const timing = sources.map(({ value, confirmed }) => confirmedTimingCandidate(value, confirmed)).find(Boolean)
    ?? kalshiStatedEventDate(event);
  return timing ? { ...event, event_time: timing } : { ...event };
}

function resolveMentionProfile({ event = null, market = null, legacy = null } = {}) {
  // Research route is resolved FIRST — before any source fetch or model
  // extraction — and is the single shared classification authority.
  const route = resolveResearchRoute(routeEventLike({ event, market, legacy }));
  const explicit = [
    market?.mention_profile,
    market?.mentionProfile,
    market?.composite_profile,
    market?.profile,
    market?.mention_composite?.profile,
    market?.mentionComposite?.profile,
    event?.mention_profile,
    event?.mentionProfile,
    event?.composite_profile,
    event?.profile,
    legacy?.mention_profile,
    legacy?.mentionProfile,
    legacy?.composite_profile,
    legacy?.profile,
  ].map(validProfile).find(Boolean);
  if (explicit) return { profile: explicit, basis: 'explicit_profile', route };

  // Profile (scoring weights) derives from the research route (alpha plan)
  // via the shared ROUTE_TO_PROFILE map — one classification authority.
  const profile = validProfile(route.profile_key) ?? POLITICAL_PROFILE;
  return { profile, basis: `route:${route.basis}`, route };
}

function firstLayerRecordMap(...carriers) {
  const keys = [
    'layer_records',
    'layerRecords',
    'mention_layer_records',
    'mentionLayerRecords',
    'composite_layer_records',
    'compositeLayerRecords',
  ];
  for (const carrier of carriers) {
    if (!carrier || typeof carrier !== 'object') continue;
    for (const key of keys) {
      const value = carrier[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    }
    for (const nestedKey of ['mention_composite', 'mentionComposite', 'composite']) {
      const nested = carrier[nestedKey];
      if (!nested || typeof nested !== 'object') continue;
      for (const key of keys) {
        const value = nested[key];
        if (value && typeof value === 'object' && !Array.isArray(value)) return value;
      }
    }
  }
  return {};
}

function strikeWordFromMarket(market = {}) {
  const custom = market.custom_strike;
  if (typeof custom === 'string' && custom.trim()) return custom.trim();
  if (custom && typeof custom === 'object') {
    for (const key of ['Word', 'word', 'text', 'value', 'label']) {
      if (typeof custom[key] === 'string' && custom[key].trim()) return custom[key].trim();
    }
  }
  for (const key of ['functional_strike', 'yes_sub_title', 'subtitle', 'title']) {
    if (typeof market[key] === 'string' && market[key].trim()) return market[key].trim();
  }
  return null;
}

export function fullMentionStrikeText(market = {}) {
  const title = asText(market.title);
  const strike = strikeWordFromMarket(market);
  if (title && strike && title !== strike) return `${title} -- ${strike}`;
  if (title) return title;
  if (strike) return strike;
  const normalized = normalizeMarket(market);
  return normalized.full_strike_display || normalized.ticker || 'MISSING';
}

function targetMentionFromMarket(market = {}) {
  const normalized = normalizeMarket(market);
  return (
    fullMentionStrikeText(market) ||
    normalized.full_strike_display ||
    normalized.yes_sub_title ||
    normalized.functional_strike ||
    normalized.title ||
    normalized.ticker ||
    'MISSING'
  );
}

// A market is the structural EDNQ ("Event does not qualify") fallback only when
// its OWN strike text says so — never from the event-level cancellation boilerplate
// that detectMarketType folds into every market's combined text (which would wrongly
// flag normal content terms like "Biden" as qualification terms).
const EDNQ_STRIKE_RE = /event does not qualify|does not occur/i;
function strikeIsEdnq(text) { return EDNQ_STRIKE_RE.test(String(text ?? '')); }

function eventNameForComposite(event = {}, legacy = null) {
  return (
    asText(legacy?.event_context) ||
    asText(legacy?.context) ||
    [event?.title, event?.sub_title].map(asText).filter(Boolean).join(' - ') ||
    asText(event?.event_ticker) ||
    asText(legacy?.event_id) ||
    'MISSING'
  );
}

function firstSourceLadderInputs(...carriers) {
  const keys = ['source_ladder', 'sourceLadder', 'source_ladder_inputs', 'sourceLadderInputs'];
  for (const carrier of carriers) {
    if (!carrier || typeof carrier !== 'object') continue;
    for (const key of keys) {
      const value = carrier[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    }
    for (const nestedKey of ['mention_composite', 'mentionComposite', 'composite']) {
      const nested = carrier[nestedKey];
      if (!nested || typeof nested !== 'object') continue;
      for (const key of keys) {
        const value = nested[key];
        if (value && typeof value === 'object' && !Array.isArray(value)) return value;
      }
    }
  }
  return null;
}

// --- Phase 2 earnings alpha helpers (earnings_call route only) ---------------
// Quarter history is priority-one alpha; context delta is priority-two.
// Both are code-owned and deterministic; prices never enter either input.

const POSTURE_LADDER = Object.freeze(['NO_CLEAR_PICK', 'WATCH', 'LEAN', 'EVIDENCE_LEAN', 'PICK']);

function findTermKeyCaseInsensitive(keys, term) {
  const want = asText(term).toLowerCase();
  if (!want) return null;
  for (const key of keys) {
    if (asText(key).toLowerCase() === want) return key;
  }
  for (const key of keys) {
    const k = asText(key).toLowerCase();
    if (k && (want.includes(k) || k.includes(want))) return key;
  }
  return null;
}

// Deterministic posture adjustment from the earnings context-delta hint:
//   upgrade        -> one rung up (requires an evidence-backed base posture)
//   downgrade      -> one rung down (never below NO_CLEAR_PICK)
//   upgrade_capped -> one rung up, but final posture capped at LEAN (WATCH+/LEAN)
// Hints with sample_size < 2 never reach here (hint module returns 'none').
function applyEarningsPostureHint(posture, hint) {
  const rank = POSTURE_RANK[posture];
  if (!hint || hint.direction === 'none' || !Number.isInteger(rank)) {
    return { posture, applied: false, reason: hint?.reason ?? null };
  }
  if (hint.direction === 'downgrade') {
    const next = POSTURE_LADDER[Math.max(0, rank - 1)];
    return { posture: next, applied: next !== posture, reason: hint.reason };
  }
  // upgrades require an existing evidence-backed posture — never manufacture
  // conviction from NO_CLEAR_PICK.
  if (rank < 1) return { posture, applied: false, reason: 'upgrade hint ignored: no evidence-backed base posture' };
  const bumped = POSTURE_LADDER[Math.min(POSTURE_LADDER.length - 1, rank + 1)];
  if (hint.direction === 'upgrade_capped') {
    const capped = POSTURE_RANK[bumped] > POSTURE_RANK.LEAN ? 'LEAN' : bumped;
    return { posture: capped, applied: capped !== posture, reason: hint.reason ?? 'capped upward adjustment' };
  }
  return { posture: bumped, applied: bumped !== posture, reason: hint.reason };
}

function postureFromScore(score, result) {
  const scoreableLayersPresent = Array.isArray(result?.evidence_ledger)
    ? result.evidence_ledger.filter((layer) => layer?.present && layer.category !== 'event_proximity').length
    : Math.max(0, Number(result?._meta?.layers_present ?? 0) - (Number(result?._meta?.event_proximity_present ?? 0) || 0));
  if (scoreableLayersPresent === 0 || score === null) return 'NO_CLEAR_PICK';
  if (scoreableLayersPresent === 1) return score >= 65 ? 'LEAN' : 'WATCH';
  if (scoreableLayersPresent === 2) return score >= 70 ? 'EVIDENCE_LEAN' : score >= 55 ? 'LEAN' : 'WATCH';
  if (score >= 80) return 'PICK';
  if (score >= 68) return 'EVIDENCE_LEAN';
  if (score >= 55) return 'LEAN';
  if (score >= 40) return 'WATCH';
  return 'NO_CLEAR_PICK';
}

function recomputePostureAfterScoreAdjustment({ score, result, ladder, earningsHint, suppressConviction }) {
  let posture = postureFromScore(score, result);
  let postureCap = null;
  if (ladder) {
    const capRes = applyQualificationCap(posture, ladder);
    posture = capRes.posture;
    postureCap = capRes.capped ? capRes.cap_reason : null;
  }
  let earningsAdjustment = null;
  if (earningsHint && !suppressConviction) {
    const adjusted = applyEarningsPostureHint(posture, earningsHint);
    earningsAdjustment = {
      direction: earningsHint.direction,
      applied: adjusted.applied,
      from: posture,
      to: adjusted.posture,
      reason: adjusted.reason,
    };
    posture = adjusted.posture;
  }
  return { posture, postureCap, earningsAdjustment };
}

// Synchronous sports settled-history builder for use in map() where records
// are already loaded. Mirrors buildSportsSettledHistory but avoids async.
function buildSportsSettledHistorySync({ eventTicker, seriesTicker, eventTitle, term, route, entity, horizon, allRecords }) {
  const sport = detectSport(eventTicker, seriesTicker, eventTitle);
  const teams = sportsExtractTeams(eventTitle);
  const venue = sportsExtractVenue(eventTitle);

  const histMatch = buildHistoryMatch({
    records: allRecords,
    route,
    entity,
    horizon,
    seriesTicker,
    maxSamples: 5,
  });

  const settledLayer = historyToLayerScore(histMatch);
  const sportRecords = filterBySport(allRecords, sport);

  // Inline phrase frequency and venue/team relevance (mirroring the async module)
  const phraseFreqLayer = buildSportsPhraseFreqSync(sportRecords, term);
  const venueTeamLayer = buildSportsVenueTeamSync(sportRecords, term, teams, venue);

  return {
    sport,
    teams,
    venue,
    historyMatch: histMatch,
    layers: {
      settled_mentions_history: settledLayer,
      sport_phrase_frequency: phraseFreqLayer,
      venue_team_phrase_relevance: venueTeamLayer,
    },
  };
}

function buildSportsPhraseFreqSync(sportRecords, term) {
  if (!term || !sportRecords.length) {
    return { present: false, score: null, source_basis: 'no sport records for phrase frequency', source_path: null, detail: null, missing_note: 'no settled sports mention history available' };
  }
  const termLower = term.toLowerCase();
  const matching = sportRecords.filter(r => String(r.strike_term ?? '').toLowerCase().includes(termLower) || String(r.context ?? '').toLowerCase().includes(termLower));
  const settled = matching.filter(r => r.result === 'yes' || r.result === 'no');
  if (settled.length < 2) {
    return { present: false, score: null, source_basis: 'insufficient settled data for phrase frequency (n<2)', source_path: null, detail: `found ${settled.length} settled record(s) for "${term}"`, missing_note: 'insufficient settled history (n<2)' };
  }
  const hits = settled.filter(r => r.result === 'yes').length;
  const rate = hits / settled.length;
  const score = Math.max(0, Math.min(100, Math.round(100 * rate)));
  return { present: true, score, source_basis: `sport phrase frequency: ${hits}/${settled.length} YES for "${term}"`, source_path: null, detail: `rate=${rate.toFixed(4)}`, missing_note: null };
}

function buildSportsVenueTeamSync(sportRecords, term, teams, venue) {
  if (!term || (!teams.length && !venue) || !sportRecords.length) {
    return { present: false, score: null, source_basis: 'no venue/team context for relevance scoring', source_path: null, detail: null, missing_note: 'no venue/team context' };
  }
  const termLower = term.toLowerCase();
  const contextMatching = sportRecords.filter(r => {
    const ctx = String(r.context ?? '').toLowerCase();
    return teams.some(t => ctx.includes(t.toLowerCase())) || (venue && ctx.includes(venue.toLowerCase()));
  });
  if (!contextMatching.length) {
    return { present: false, score: null, source_basis: `no settled history for teams/venue [${teams.join(', ')}]`, source_path: null, detail: null, missing_note: `no settled history for ${teams.join('/')}` };
  }
  const termMatching = contextMatching.filter(r => String(r.strike_term ?? '').toLowerCase().includes(termLower) || String(r.context ?? '').toLowerCase().includes(termLower));
  const settled = termMatching.filter(r => r.result === 'yes' || r.result === 'no');
  if (settled.length < 2) {
    return { present: false, score: null, source_basis: 'insufficient venue/team data (n<2)', source_path: null, detail: `found ${settled.length}`, missing_note: 'n<2' };
  }
  const hits = settled.filter(r => r.result === 'yes').length;
  const rate = hits / settled.length;
  const score = Math.max(0, Math.min(100, Math.round(100 * rate)));
  return { present: true, score, source_basis: `venue/team phrase relevance: ${hits}/${settled.length} YES for "${term}" with ${teams.join('/')}`, source_path: null, detail: `rate=${rate.toFixed(4)}`, missing_note: null };
}

// Exact-series history via the Kalshi-native scan intentionally leaves
// hits/misses null (the scan reports a percentage, not per-strike counts).
// Reconstruct real hits/misses from that percentage for display so the
// rendered history line matches the number that actually drove the score,
// instead of coercing an intentionally-absent value to a literal 0.
function reconstructHitsFromNativePct(pct, n) {
  const p = Number(pct);
  const total = Number(n);
  if (!Number.isFinite(p) || !Number.isFinite(total) || total <= 0) return null;
  const hits = Math.max(0, Math.min(total, Math.round((p / 100) * total)));
  return { hits, misses: total - hits };
}

export function buildMentionCompositeForMarket({ event = null, market = null, legacy = null, historyRecords = null, historyStoreStatus = null, earningsQuarterLayer = null, earningsContextDelta = null, earningsFamilyHistory = null, sportsSettledResult = null, sportsGameContextResult = null, candidateText = null } = {}) {
  const profileResolution = resolveMentionProfile({ event, market, legacy });
  const route = profileResolution.route ?? null;
  const profileConfig = PROFILE_REGISTRY[profileResolution.profile];
  const targetMention = market ? targetMentionFromMarket(market) : (
    asText(legacy?.target_phrase) ||
    asText(legacy?.phrase) ||
    asText(legacy?.keyword) ||
    'MISSING'
  );

  const lexicalGate = gateMentionMarket({ event, market, legacy, candidateText });
  if (strikeIsEdnq(targetMention)) {
    return blockedMentionComposite({
      event,
      market,
      legacy,
      targetMention,
      profileResolution,
      route,
      lexicalGate,
      qualificationBlocked: true,
    });
  }

  // ---- Lexical pre-evidence gate (HARD) --------------------------------------
  // The literal lexical engine decides whether this market is even valid before
  // ANY evidence layer is built or any composite/posture is produced. Hard
  // blocks (BLOCKED_RULES_UNCLEAR / OUT_OF_SCOPE_ROLLING) short-circuit here and
  // never reach scoring or rendering. An evaluated NO_MATCH suppresses
  // conviction downstream. MATCH / PENDING proceed to the layer build below.
  if (lexicalGate.hard_blocked) {
    return blockedMentionComposite({
      event,
      market,
      legacy,
      targetMention,
      profileResolution,
      route,
      lexicalGate,
    });
  }

  let layerRecords = firstLayerRecordMap(market, event, legacy);
  let earningsFamilyEvidence = null;
  let earningsFamilyHistoryLayer = null;

  // Phase 2 priority-one alpha (earnings_call only): last-four-quarter per-term
  // hit/miss history feeds historical_tendency BEFORE generic settled history
  // and before any source/model extraction. Research-supplied layer still wins.
  let earningsTermStats = null;
  let earningsLfq = null;
  let earningsDeltaEntry = null;
  let earningsHint = null;

  if (route?.route === 'earnings_call' && earningsQuarterLayer?.terms) {
    const termKey = findTermKeyCaseInsensitive(Object.keys(earningsQuarterLayer.terms), targetMention);
    if (termKey) {
      earningsTermStats = earningsQuarterLayer.terms[termKey];
      earningsLfq = earningsQuarterLayer.last_four_quarter_hit_rate?.[termKey] ?? null;
      const quarterLayer = earningsLayerToHistoricalTendency(earningsQuarterLayer, termKey);
      if (quarterLayer?.present && !(layerRecords?.historical_tendency?.present)) {
        layerRecords = { ...(layerRecords ?? {}), historical_tendency: quarterLayer };
      }
    }
  }

  if (route?.route === 'earnings_call' && earningsFamilyHistory) {
    const nativeN = Number(market?.kalshi_native_n);
    const sameCompanyN = Number(earningsTermStats?.sample_size ?? 0);
    const familyWord = market?.yes_sub_title || market?.subtitle || targetMention;
    const familyStatsLookup = familyStatsExcludingCompany(earningsFamilyHistory, familyWord, route?.entity);
    const familyStats = familyStatsLookup.stats;
    if (nativeN >= 2) {
      // Exact-series evidence is already represented by the Kalshi-native path.
      earningsFamilyEvidence = { tier: 'exact_series', n: nativeN, hits: null, misses: null, hit_rate: null, penalty: 0, scan_ok: earningsFamilyHistory.scan_ok !== false };
    } else if (sameCompanyN >= 2) {
      // Existing same-company quarter history outranks the cross-company pool.
      earningsFamilyEvidence = {
        tier: 'exact_series',
        n: sameCompanyN,
        hits: Number(earningsTermStats.hits ?? 0),
        misses: Number(earningsTermStats.misses ?? 0),
        hit_rate: Number(earningsTermStats.four_quarter_hit_rate ?? 0),
        penalty: 0,
        scan_ok: earningsFamilyHistory.scan_ok !== false,
      };
    } else if (earningsFamilyHistory.scan_ok === false) {
      earningsFamilyEvidence = { tier: 'lookup_failed', n: 0, hits: 0, misses: 0, hit_rate: null, penalty: null, scan_ok: false, error: earningsFamilyHistory.error ?? null };
    } else if (!familyStatsLookup.available) {
      earningsFamilyEvidence = { tier: 'lookup_failed', n: 0, hits: 0, misses: 0, hit_rate: null, penalty: null, scan_ok: false, error: 'earnings family cache lacks per-company provenance' };
    } else if (Number(familyStats?.n) >= 2) {
      const n = Number(familyStats.n);
      earningsFamilyEvidence = { tier: 'earnings_family', n, hits: Number(familyStats.hits ?? 0), misses: Number(familyStats.misses ?? 0), hit_rate: Number(familyStats.hits ?? 0) / n, penalty: n >= FAMILY_STRONG_MIN_N ? FAMILY_PENALTY_STRONG : FAMILY_PENALTY_THIN, scan_ok: true };
    } else {
      earningsFamilyEvidence = { tier: 'none', n: Number(familyStats?.n ?? 0), hits: Number(familyStats?.hits ?? 0), misses: Number(familyStats?.misses ?? 0), hit_rate: null, penalty: null, scan_ok: true };
    }
    // Never synthesize a layer from exact-series evidence's intentionally
    // absent hits/misses. Defer the cross-company fallback until after the
    // generic settled-history lookup so exact same-company history wins.
    if (earningsFamilyEvidence.tier === 'earnings_family') {
      earningsFamilyHistoryLayer = earningsHistoryToLayerScore({ ...earningsFamilyEvidence, sample_size: earningsFamilyEvidence.n });
    }
  }

  // Phase 2 priority-two alpha: prior-quarter vs current-quarter context delta
  // (declared sources/fixtures only) produces a deterministic posture hint.
  if (route?.route === 'earnings_call' && Array.isArray(earningsContextDelta?.terms)) {
    earningsDeltaEntry = earningsContextDelta.terms.find(
      (t) => findTermKeyCaseInsensitive([t.term], targetMention),
    ) ?? null;
    if (earningsDeltaEntry) {
      earningsHint = postureAdjustmentHint({
        four_quarter_hit_rate: earningsTermStats?.four_quarter_hit_rate ?? null,
        sample_size: earningsTermStats?.sample_size ?? 0,
        delta: earningsDeltaEntry.earnings_context_delta?.value ?? 'absent',
      });
    }
  }

  // Phase 3: sports_announcer settled history + game context (priority-one alpha).
  // Runs BEFORE generic settled-history and before source/model extraction.
  let sportsHistory = null;
  let sportsGameCtx = null;
  if (route?.route === 'sports_announcer') {
    if (sportsSettledResult) {
      sportsHistory = sportsSettledResult;
      const sportsLayers = sportsSettledResult.layers ?? {};
      for (const [key, layer] of Object.entries(sportsLayers)) {
        if (layer?.present && !(layerRecords?.[key]?.present)) {
          layerRecords = { ...(layerRecords ?? {}), [key]: layer };
        }
      }
      if (sportsSettledResult.layers?.settled_mentions_history?.present && !(layerRecords?.historical_tendency?.present)) {
        layerRecords = { ...(layerRecords ?? {}), historical_tendency: sportsSettledResult.layers.settled_mentions_history };
      }
    }
    if (sportsGameContextResult) {
      sportsGameCtx = sportsGameContextResult;
      const ctxLayers = sportsGameContextResult.layers ?? {};
      for (const [key, layer] of Object.entries(ctxLayers)) {
        if (layer?.present && !(layerRecords?.[key]?.present)) {
          layerRecords = { ...(layerRecords ?? {}), [key]: layer };
        }
      }
    }
  }

  // Settled-history alpha: price-free hit/miss records (settled YES/NO only)
  // feed the historical_tendency layer when no research-supplied record exists.
  // Empty/no-match history stays absent — never fake conviction.
  //
  // ORDER (Phase 4): Rules Analyst -> lexical gate -> settled history. History
  // lookup runs ONLY after the lexical gate clears the market to evidence
  // (MATCH / PENDING / ROLLING_SUPPORTED). It NEVER runs for a hard block
  // (BLOCKED_RULES_UNCLEAR / OUT_OF_SCOPE — already short-circuited above) nor
  // for an evaluated NO_MATCH (suppress_conviction): a literal non-occurrence
  // must not pull in settled comparables and manufacture conviction.
  let historyMatch = null;
  let settledHistory = null;
  if (route && !lexicalGate.suppress_conviction && Array.isArray(historyRecords) && historyRecords.length) {
    historyMatch = buildHistoryMatch({
      records: historyRecords,
      route: route.route,
      entity: route.entity,
      horizon: route.horizon,
      seriesTicker: event?.series_ticker ?? null,
    });
    settledHistory = buildSettledHistoryArtifact({
      records: historyRecords,
      route: route.route,
      entity: route.entity,
      horizon: route.horizon,
      seriesTicker: event?.series_ticker ?? null,
      acceptedForms: lexicalGate.lexical_result?.matched_forms ?? [],
    });
    const historyLayer = historyToLayerScore(historyMatch);
    if (historyLayer.present && !(layerRecords?.historical_tendency?.present)) {
      layerRecords = { ...(layerRecords ?? {}), historical_tendency: historyLayer };
    }
    if (
      route.route === 'earnings_call'
      && historyMatch?.match_tier === 'exact_horizon'
      && Number(historyMatch.sample_size) >= 2
    ) {
      earningsFamilyEvidence = {
        tier: 'exact_series',
        n: historyMatch.sample_size,
        hits: historyMatch.hits,
        misses: historyMatch.misses,
        hit_rate: historyMatch.hit_rate,
        penalty: 0,
        scan_ok: earningsFamilyHistory?.scan_ok !== false,
      };
      earningsFamilyHistoryLayer = null;
    }
  }
  if (
    earningsFamilyEvidence?.tier === 'earnings_family'
    && earningsFamilyHistoryLayer?.present
    && !(layerRecords?.historical_tendency?.present)
  ) {
    layerRecords = { ...(layerRecords ?? {}), historical_tendency: earningsFamilyHistoryLayer };
  }
  const nativeReconstructedHistory = earningsFamilyEvidence?.tier === 'exact_series' && earningsFamilyEvidence.hits === null
    ? reconstructHitsFromNativePct(market?.kalshi_native_pct, earningsFamilyEvidence.n)
    : null;
  const canonicalHistory = settledHistory
    ? settledHistory
    : earningsFamilyEvidence
      ? {
        evidence_class: 'earnings_family_history',
        status: earningsFamilyEvidence.tier === 'lookup_failed' ? 'failure' : earningsFamilyEvidence.tier === 'none' ? 'verified_zero' : 'present',
        match_tier: earningsFamilyEvidence.tier,
        sample_size: earningsFamilyEvidence.n ?? 0,
        // hits/misses are intentionally null for exact_series-via-native-scan
        // (the scan reports a percentage, not per-strike counts). Reconstruct
        // from that percentage rather than coercing to a fabricated 0; if
        // reconstruction is impossible, stay null (never fake a verified zero).
        hits: nativeReconstructedHistory ? nativeReconstructedHistory.hits : earningsFamilyEvidence.hits,
        misses: nativeReconstructedHistory ? nativeReconstructedHistory.misses : earningsFamilyEvidence.misses,
        hit_rate: earningsFamilyEvidence.hit_rate ?? (nativeReconstructedHistory ? nativeReconstructedHistory.hits / Math.max(1, Number(earningsFamilyEvidence.n) || 1) : null),
        route: route?.route ?? null,
        entity: route?.entity ?? null,
        horizon: route?.horizon ?? null,
      }
      : {
        evidence_class: 'settled_history',
        status: historyStoreStatus === 'read_error' ? 'failure' : historyStoreStatus === 'store_missing' ? 'unavailable' : 'verified_zero',
        match_tier: 'none', sample_size: 0, hits: 0, misses: 0, hit_rate: null,
        route: route?.route ?? null, entity: route?.entity ?? null, horizon: route?.horizon ?? null,
      };
  let result;
  const researchInput = market ?? legacy ?? {};
  const hasResearchProvenance = Number.isFinite(Number(researchInput?.proof_pct))
    || Number.isFinite(Number(researchInput?.handicap_pct))
    || ['live', 'source_backed'].includes(researchInput?.research_quality)
    || (researchInput?.kalshi_scan_ok === true
      && Number.isFinite(Number(researchInput?.kalshi_native_n))
      && Number(researchInput.kalshi_native_n) >= 1);
  const researchScoreInput = hasResearchProvenance && Number.isFinite(Number(researchInput?.blended_pct))
    ? Number(researchInput.blended_pct)
    : null;
  // "Cited" means real, verifiable current-event evidence — either an actual
  // Perplexity citation (research_quality only reaches 'source_backed' when a
  // real citation exists, see collect-mentions-research.mjs) or a real settled
  // Kalshi native scan (verifiable market data, not opinion). Anything else is
  // an uncited estimate and must not be allowed to move a score that already
  // has real layer evidence behind it.
  const researchScoreCited = researchInput?.research_quality === 'source_backed'
    || (researchInput?.kalshi_scan_ok === true
      && Number.isFinite(Number(researchInput?.kalshi_native_n))
      && Number(researchInput.kalshi_native_n) >= 1);
  // composeMentionLedgerFromTermRecord (canonical Pd x Ph x Pe path,
  // mention-composite-core.mjs) is the single authoritative production score
  // path. researchScoreInput/researchScoreCited (the old override-blend
  // inputs) now feed the canonical record as Pd (door) evidence via
  // researchEvidence — see mapLayerRecordsToTermEvidence's comment in
  // mention-composite-core.mjs for why a live-research finding is Pd, not Ph.
  const acceptedFormsForTerm = Array.isArray(lexicalGate.lexical_result?.matched_forms) && lexicalGate.lexical_result.matched_forms.length
    ? lexicalGate.lexical_result.matched_forms
    : [targetMention].filter(Boolean);
  const requiredCountForTerm = Number.isFinite(Number(lexicalGate.lexical_result?.required_count))
    ? Number(lexicalGate.lexical_result.required_count)
    : 1;
  result = composeMentionLedgerFromTermRecord({
    event: eventNameForComposite(event ?? {}, legacy),
    targetMention,
    profile: profileResolution.profile,
    layerDefs: profileConfig.layerDefs,
    layerRecords,
    canonicalHistory,
    acceptedForms: acceptedFormsForTerm,
    requiredCount: requiredCountForTerm,
    researchEvidence: researchScoreInput !== null
      ? { value: researchScoreInput / 100, cited: researchScoreCited, kind: 'source_backed_research' }
      : null,
  });

  // Lexical NO_MATCH suppression: an evaluated literal NO_MATCH means the target
  // did not literally occur in the evidence text, so downstream may NOT invent
  // conviction from context. Force the composite back to NO_CLEAR_PICK with no
  // score/confidence before any source-ladder upgrade can run.
  if (lexicalGate.suppress_conviction) {
    result.posture = 'NO_CLEAR_PICK';
    result.composite_score = null;
    result.raw_model_score = null;
    result.raw_model_probability = null;
    result.confidence = null;
    result.reasoning_summary = `NO_CLEAR_PICK — lexical NO_MATCH: "${targetMention}" not literally present in evaluated evidence.`;
  }

  // Source ladder (optional — runs if explicit inputs are supplied via market/event/legacy)
  let ladder = null;
  let postureFinal = result.posture;
  let postureCap = null;
  const ladderInputs = firstSourceLadderInputs(market, event, legacy);
  if (ladderInputs) {
    ladder = evaluateSourceLadder({ profile: profileResolution.profile, inputs: ladderInputs });
    const capRes = applyQualificationCap(result.posture, ladder);
    postureFinal = capRes.posture;
    postureCap = capRes.capped ? capRes.cap_reason : null;
  }

  // Earnings context-delta posture adjustment runs AFTER the qualification cap
  // and is fully code-owned/deterministic (see applyEarningsPostureHint).
  let earningsAdjustment = null;
  if (earningsHint && !lexicalGate.suppress_conviction) {
    const adjusted = applyEarningsPostureHint(postureFinal, earningsHint);
    earningsAdjustment = {
      direction: earningsHint.direction,
      applied: adjusted.applied,
      from: postureFinal,
      to: adjusted.posture,
      reason: adjusted.reason,
    };
    postureFinal = adjusted.posture;
  }

  return {
    market_ticker: market?.ticker ?? legacy?.ticker ?? legacy?.event_id ?? 'MISSING',
    full_strike_text: targetMention ?? legacy?.target_phrase ?? 'MISSING',
    profile_basis: profileResolution.basis,
    research_route: route?.route ?? null,
    route_basis: route?.basis ?? null,
    route_entity: route?.entity ?? null,
    route_horizon: route?.horizon ?? null,
    route_event_format: route?.event_format ?? null,
    market_type: lexicalGate.lexical_result?.market_type ?? null,
    required_count: Number.isFinite(Number(lexicalGate.lexical_result?.required_count)) ? Number(lexicalGate.lexical_result.required_count) : null,
    repeat_requirement: Number.isFinite(Number(lexicalGate.lexical_result?.required_count)) && Number(lexicalGate.lexical_result.required_count) > 1
      ? `${Number(lexicalGate.lexical_result.required_count)}+ times`
      : null,
    is_qualification_term: strikeIsEdnq(
      market ? targetMentionFromMarket(market) : (legacy?.target_phrase ?? legacy?.target_mention ?? '')
    ),
    settled_history: settledHistory,
    canonical_history: canonicalHistory,
    history_match_tier: historyMatch?.match_tier ?? null,
    history_sample_size: historyMatch?.sample_size ?? null,
    history_hits: historyMatch?.hits ?? null,
    history_misses: historyMatch?.misses ?? null,
    history_hit_rate: historyMatch?.hit_rate ?? null,
    history_match_quality_penalty: historyMatch?.match_quality_penalty ?? null,
    history_source_tickers: historyMatch?.source_tickers ?? null,
    earnings_family_history: earningsFamilyEvidence,
    last_four_quarter_hit_rate: earningsLfq,
    earnings_quarter_terms: earningsTermStats,
    earnings_quarter_sample_size: earningsTermStats?.sample_size ?? null,
    earnings_context_delta: earningsDeltaEntry,
    earnings_posture_adjustment: earningsAdjustment,
    sports_history: sportsHistory ? {
      sport: sportsHistory.sport,
      teams: sportsHistory.teams,
      venue: sportsHistory.venue,
      history_match_tier: sportsHistory.historyMatch?.match_tier ?? null,
      history_sample_size: sportsHistory.historyMatch?.sample_size ?? null,
      history_hits: sportsHistory.historyMatch?.hits ?? null,
      history_misses: sportsHistory.historyMatch?.misses ?? null,
      history_hit_rate: sportsHistory.historyMatch?.hit_rate ?? null,
    } : null,
    sports_game_context: sportsGameCtx?.gameContext ?? null,
    result,
    proof_pct: market?.proof_pct ?? null,
    handicap_pct: market?.handicap_pct ?? null,
    kalshi_native_pct: market?.kalshi_native_pct ?? null,
    kalshi_native_n: market?.kalshi_native_n ?? null,
    kalshi_scan_ok: market?.kalshi_scan_ok ?? null,
    kalshi_events_scanned: market?.kalshi_events_scanned ?? null,
    kalshi_scan_error: market?.kalshi_scan_error ?? null,
    history_store_status: historyStoreStatus,
    confidence: market?.confidence ?? null,
    reason: market?.research_reason ?? null,
    proof_reason: market?.proof_reason ?? null,
    handicap_reason: market?.handicap_reason ?? null,
    research_citations: Array.isArray(market?.research_citations) ? market.research_citations : [],
    research_term_note: market?.research_term_note ?? null,
    source_ladder: ladder,
    posture_final: postureFinal,
    posture_cap_reason: postureCap,
    research_quality: market?.research_quality ?? legacy?.research_quality ?? null,
    source_status: market?.source_status ?? legacy?.source_status ?? null,
    lexical_gate: lexicalGate,
    pmt_advisory_context: buildPmtAdvisoryContext({
      route: route?.route ?? null,
      eventTitle: event?.title ?? null,
      eventSubtitle: event?.sub_title ?? event?.subtitle ?? null,
      speaker: 'Trump',
    }),
  };
}

// Hard-blocked composite result for a market the lexical pre-evidence gate
// rejected (BLOCKED_RULES_UNCLEAR / OUT_OF_SCOPE_ROLLING). No evidence layers
// are built and composeMentionLedger is never called — the market can never
// surface a soft verdict (WATCH/LEAN/etc.) or any score/confidence. The shape
// mirrors the normal return so downstream rank/summary/render code is unchanged.
function blockedMentionComposite({ event, market, legacy, targetMention, profileResolution, route, lexicalGate, qualificationBlocked = false }) {
  const decision = qualificationBlocked
    ? 'QUALIFICATION'
    : (lexicalGate.lexical_result?.status === 'BLOCKED' ? lexicalGate.decision : 'BLOCK');
  const blockReasons = qualificationBlocked
    ? ['EDNQ qualification result excluded from composite scoring']
    : Array.isArray(lexicalGate.lexical_result?.block_reasons)
      ? lexicalGate.lexical_result.block_reasons
      : [];
  const result = {
    event: eventNameForComposite(event ?? {}, legacy),
    target_mention: targetMention,
    profile: profileResolution.profile,
    composite_score: null,
    confidence: null,
    posture: 'NO_CLEAR_PICK',
    top_supporting_layers: [],
    missing_layers: [],
    source_notes: [],
    evidence_ledger: [],
    reasoning_summary: `NO_CLEAR_PICK — ${qualificationBlocked ? 'qualification' : 'lexical'} gate ${decision} (${blockReasons.join(', ') || 'rules unclear'}); market blocked before scoring.`,
    lexical_blocked: !qualificationBlocked,
    _meta: {
      schema_version: 'mention_composite_v1',
      layers_present: 0,
      layers_total: 0,
      pricing_excluded: true,
      lexical_gate_decision: decision,
    },
  };
  return {
    market_ticker: market?.ticker ?? legacy?.ticker ?? legacy?.event_id ?? 'MISSING',
    profile_basis: profileResolution.basis,
    research_route: route?.route ?? null,
    route_basis: route?.basis ?? null,
    route_entity: route?.entity ?? null,
    route_horizon: route?.horizon ?? null,
    route_event_format: route?.event_format ?? null,
    market_type: lexicalGate.lexical_result?.market_type ?? null,
    required_count: Number.isFinite(Number(lexicalGate.lexical_result?.required_count)) ? Number(lexicalGate.lexical_result.required_count) : null,
    repeat_requirement: Number.isFinite(Number(lexicalGate.lexical_result?.required_count)) && Number(lexicalGate.lexical_result.required_count) > 1
      ? `${Number(lexicalGate.lexical_result.required_count)}+ times`
      : null,
    is_qualification_term: strikeIsEdnq(
      market ? targetMentionFromMarket(market) : (legacy?.target_phrase ?? legacy?.target_mention ?? '')
    ),
    settled_history: null,
    history_match_tier: null,
    history_sample_size: null,
    history_hits: null,
    history_misses: null,
    history_hit_rate: null,
    history_match_quality_penalty: null,
    history_source_tickers: null,
    last_four_quarter_hit_rate: null,
    earnings_quarter_terms: null,
    earnings_quarter_sample_size: null,
    earnings_context_delta: null,
    earnings_posture_adjustment: null,
    sports_history: null,
    sports_game_context: null,
    result,
    proof_pct: market?.proof_pct ?? null,
    handicap_pct: market?.handicap_pct ?? null,
    kalshi_native_pct: market?.kalshi_native_pct ?? null,
    kalshi_native_n: market?.kalshi_native_n ?? null,
    confidence: market?.confidence ?? null,
    reason: market?.research_reason ?? null,
    proof_reason: market?.proof_reason ?? null,
    handicap_reason: market?.handicap_reason ?? null,
    research_citations: Array.isArray(market?.research_citations) ? market.research_citations : [],
    research_term_note: market?.research_term_note ?? null,
    source_ladder: null,
    posture_final: 'NO_CLEAR_PICK',
    posture_cap_reason: `lexical_gate:${decision}`,
    research_quality: market?.research_quality ?? legacy?.research_quality ?? null,
    lexical_gate: lexicalGate,
    pmt_advisory_context: buildPmtAdvisoryContext({
      route: route?.route ?? null,
      eventTitle: event?.title ?? null,
      eventSubtitle: event?.sub_title ?? event?.subtitle ?? null,
      speaker: 'Trump',
    }),
  };
}

function bestComposite(composites) {
  const ranked = composites
    .filter(c => c?.result && !c?.is_qualification_term)
    .slice()
    .sort((a, b) => {
      const postureDiff = (POSTURE_RANK[b.result.posture] ?? -1) - (POSTURE_RANK[a.result.posture] ?? -1);
      if (postureDiff !== 0) return postureDiff;
      return (b.result.composite_score ?? -1) - (a.result.composite_score ?? -1);
    });
  return ranked[0] ?? null;
}

function compositePresentCategories(composite) {
  const ledger = composite?.result?.evidence_ledger;
  if (Array.isArray(ledger)) return ledger.filter((row) => row.present).map((row) => row.category);
  const top = composite?.result?.top_supporting_layers;
  return Array.isArray(top) ? top.map((row) => row.category).filter(Boolean) : [];
}

function isProximityOnlyComposite(composite) {
  const cats = compositePresentCategories(composite);
  return cats.length === 1 && cats[0] === 'event_proximity';
}

function hasBeyondProximityEvidence(composite) {
  return compositePresentCategories(composite).some((category) => category !== 'event_proximity');
}

function summarizeCompositeRun(composites) {
  const contentComposites = composites.filter((c) => !c?.is_qualification_term);
  const scoredRows = contentComposites
    .map((composite) => ({ composite, row: mentionCompositeToDecisionRow(composite) }))
    .filter(({ row }) => row?.composite_score !== null && row?.composite_score !== undefined)
    .sort((a, b) => Number(b.row.composite_score) - Number(a.row.composite_score));
  const best = scoredRows[0] ?? null;
  return {
    market_count: composites.length,
    scored_count: scoredRows.length,
    source_backed_count: contentComposites.filter(hasBeyondProximityEvidence).length,
    proximity_only_count: contentComposites.filter(isProximityOnlyComposite).length,
    best_posture: best?.row?.composite_posture ?? 'NO_CLEAR_PICK',
    best_score: best?.row?.composite_score ?? null,
    best_target: best?.row?.side_target ?? null,
    pricing_excluded: true,
  };
}

function mentionAttachmentId(composite = {}, index = 0) {
  return String(
    composite.market_ticker
      ?? composite?.result?.target_mention
      ?? composite.side_target
      ?? composite.full_strike_text
      ?? composite.target_mention
      ?? composite.marketTicker
      ?? '',
  ).trim() || `mention_term:${index + 1}`;
}

function buildMentionAttachmentContract(composites = []) {
  const contentRows = (Array.isArray(composites) ? composites : []).filter((composite) => composite?.is_qualification_term !== true);
  return buildPerplexityEntityAttachmentContract({
    entity_type: 'mention_term',
    entity_ids: contentRows.map((composite, index) => mentionAttachmentId(composite, index)),
    attached_entity_ids: contentRows
      .filter((composite) => hasBeyondProximityEvidence(composite))
      .map((composite, index) => mentionAttachmentId(composite, index)),
  });
}

// Mention composite posture -> shared edge vocabulary. The composite core is the
// authority on posture; we carry it as statusOverride so the generic threshold
// logic does not relitigate it. Edge stays MISSING unless a calibrated model
// probability exists — composite_score is a 0-100 conviction, NOT a probability,
// so it is never converted into a fake fair probability or fake edge.
const MENTION_POSTURE_TO_EDGE = Object.freeze({
  PICK: EDGE_STATUS.PICK,
  EVIDENCE_LEAN: EDGE_STATUS.LEAN,
  LEAN: EDGE_STATUS.LEAN,
  WATCH: EDGE_STATUS.WATCH,
  NO_CLEAR_PICK: EDGE_STATUS.PASS,
});

/**
 * computeEvidenceAvailability — pure. Derives a per-strike evidence-availability
 * record from a mention composite, WITHOUT inventing any evidence.
 *
 *   settled_evidence: { status, n, hits, misses }
 *     present          — real comparables: kalshi_native_n >= 2, OR a
 *                        settled_history artifact with a non-'none' tier
 *                        (the price-free settled store produced usable hits).
 *     none_for_series  — looked up successfully and the series genuinely has
 *                        NO settled comparables (kalshi scan ran, n=0, and no
 *                        settled_history artifact). This is real-world absence.
 *     store_missing    — the settled-history store was never ingested on this
 *                        worktree (no settled_history artifact AND no kalshi
 *                        native scan ran / n is null/0). Declared honestly.
 *     error            — lookup failed (not currently distinguishable upstream;
 *                        reserved for future loadHistoryWithStatus wiring).
 *
 *   transcript_evidence: { status }
 *     present          — prior_transcript_word_match has evidence-bearing
 *                        status ('used', 'undercounted', or 'proxy').
 *     missing          — otherwise (the earnings-research-collector stub
 *                        returns 'missing' when fetchExternalResearchData is
 *                        unimplemented; reported honestly, never fabricated).
 *
 * Pure on its inputs — reads only existing composite fields. Never touches the
 * network or state/. Never reads a price field.
 */
export function computeEvidenceAvailability(composite) {
  const nativeRaw = composite?.kalshi_native_n;
  const kalshiNativeN = nativeRaw == null ? null : Number(nativeRaw);
  const hasNative = Number.isFinite(kalshiNativeN) && kalshiNativeN >= 2;
  const sh = composite?.settled_history ?? null;
  const canonical = composite?.canonical_history ?? null;
  const hasSettledHistory = sh?.usable === true;
  const storeStatus = composite?.history_store_status ?? null;
  const scanOk = composite?.kalshi_scan_ok === true;
  const scanFailed = composite?.kalshi_scan_ok === false || Boolean(composite?.kalshi_scan_error);
  const eventsScanned = Number(composite?.kalshi_events_scanned);
  const scanRan = scanOk && Number.isFinite(eventsScanned) && eventsScanned > 0;

  let settledStatus;
  if (canonical?.status === 'failure') {
    settledStatus = 'error';
  } else if (canonical?.status === 'unavailable') {
    settledStatus = 'unavailable';
  } else if (canonical?.status === 'verified_zero') {
    settledStatus = 'none_for_series';
  } else if (canonical?.status === 'present') {
    settledStatus = Number(canonical.sample_size) >= 2 ? 'present' : 'unavailable';
  } else if (hasNative) {
    settledStatus = 'present';
  } else if (hasSettledHistory) {
    settledStatus = 'present';
  } else if (scanFailed) {
    settledStatus = 'error';
  } else if (scanRan && kalshiNativeN === 0) {
    settledStatus = 'none_for_series';
  } else if (storeStatus === 'read_error') {
    settledStatus = 'error';
  } else if (storeStatus === 'store_missing') {
    settledStatus = 'store_missing';
  } else {
    settledStatus = 'unavailable';
  }

  const evidenceN = hasNative
    ? kalshiNativeN
    : hasSettledHistory
      ? Number(sh.sample_size)
      : (Number.isFinite(kalshiNativeN) ? kalshiNativeN : 0);
  const cats = Array.isArray(composite?.source_ladder?.categories) ? composite.source_ladder.categories : [];
  const transcriptCat = cats.find((c) => c?.category === 'prior_transcript_word_match');
  const transcriptStatus = ['used', 'undercounted', 'proxy'].includes(transcriptCat?.status)
    ? 'present'
    : 'missing';

  return {
    settled_evidence: {
      status: settledStatus,
      store_status: storeStatus ?? 'unavailable',
      kalshi_scan_status: scanFailed ? 'error' : scanRan ? 'ok' : 'unavailable',
      n: evidenceN,
      hits: sh?.hits ?? 0,
      misses: sh?.misses ?? 0,
    },
    transcript_evidence: {
      status: transcriptStatus,
    },
  };
}

// Score ceiling for a strike with NO historical evidence (no settled
// comparables AND no transcript word-match). The customer tier is a pure
// function of cpc_score (>=65 STRONG YES, render-mention-packet.mjs:53-60),
// and the janitor FAILS a packet where score>=65 but tier != STRONG YES
// (cpc-packet-janitor.mjs:729). Clamping the NUMERIC SCORE below 65 (not the
// tier) makes the tier fall to WEAK YES consistently and keeps the janitor
// happy — capping the tier alone would trip it. Max WEAK YES is the honest
// ceiling for current-context-only evidence.
const NO_HISTORY_CONFIDENCE_CAP = 64;
const NO_HISTORY_CONFIDENCE_FLOOR = 35;
const NO_HISTORY_CONFIDENCE_CAP_REASON =
  'current-context-only evidence: no settled comparables and no transcript word-match; score capped below STRONG YES';

/**
 * Convert one mention composite into a model-only decision row. Display-only
 * quotes are attached later by render-mention-packet.mjs after this row is
 * frozen and hashed.
 *
 * HARD RULE: when the composite has zero source-backed layers
 * (layers_present === 0) the row is BLOCKED_SOURCE_LAYER_MISSING — a research
 * gap, not a useful final verdict — with the exact missing source layers, the
 * target phrase, and the next research trigger. "source_ladder: MISSING" is
 * never presented as an actionable result.
 */
export function mentionCompositeToDecisionRow(composite) {
  const r = composite?.result ?? {};
  const meta = r._meta ?? {};
  const layersPresent = Number(meta.layers_present ?? 0);
  const layersTotal = Number(meta.layers_total ?? 0);
  const lexical = composite?.lexical_gate?.lexical_result ?? null;
  const marketType = lexical?.market_type ?? null;
  const requiredCount = Number.isFinite(Number(lexical?.required_count)) ? Number(lexical.required_count) : null;
  const ladder = composite?.source_ladder ?? null;
  const qualificationStatus = composite?.source_ladder?.qualification_status ?? null;
  const qualificationPostureCap = composite?.source_ladder?.posture_cap ?? null;

  const missingCats = Array.isArray(r.missing_layers) ? r.missing_layers.map((l) => l.category) : [];
  const topLayers = Array.isArray(r.top_supporting_layers) ? r.top_supporting_layers.map((l) => l.category) : [];
  const presentCats = Array.isArray(r.evidence_ledger)
    ? r.evidence_ledger.filter((l) => l.present).map((l) => l.category)
    : topLayers;
  const target = r.target_mention ?? composite?.market_ticker ?? 'MISSING';
  const adjustmentInput = composite?.earnings_posture_adjustment ?? null;
  const earningsHint = adjustmentInput
    ? { direction: adjustmentInput.direction, reason: adjustmentInput.reason }
    : null;
  const suppressConviction = composite?.lexical_gate?.suppress_conviction === true;

  // No source-backed evidence at all -> BLOCKED on the missing source layers.
  const sourceBlocked = layersPresent === 0;
  const proximityOnly = layersPresent === 1 && presentCats.length === 1 && presentCats[0] === 'event_proximity';
  // Beyond-proximity source evidence = any present layer that is not the
  // event_proximity scaffold. This is what separates a real researched row from
  // a "schedule confirmed, nothing else" row.
  const hasBeyondProximityEvidence = presentCats.some((c) => c !== 'event_proximity');
  // FAIL-CLOSED gate: when the research layer never produced usable source
  // evidence for this market (no declared source / blocked / timed-out fetch)
  // AND there is no beyond-proximity evidence layer, the row is NOT a valid
  // customer WATCH — it is a research gap. event_proximity (schedule confirmed)
  // alone can never carry a customer row. This is the product-failure fix: a
  // NO_DECLARED_SOURCES / no-live-research event must fail closed, not render.
  const noResearchPerformed = isNoResearchSourceStatus(composite?.source_status);
  const noUsableSources = !hasBeyondProximityEvidence && noResearchPerformed;
  let postureFinal = composite?.posture_final ?? r.posture ?? 'NO_CLEAR_PICK';

  // Stub cap: never allow LEAN/EVIDENCE_LEAN/PICK from stub-only or uncited
  // research. 'no_source' covers both "sources consulted, found nothing" and
  // (post-honesty-fix) "Perplexity produced a finding but no real citation
  // backs it" — an uncited estimate must not carry a customer row any further
  // than a stub does.
  const isStub = ['stub', 'no_source'].includes(meta.research_quality) || ['stub', 'no_source'].includes(composite?.research_quality);
  if (isStub && POSTURE_RANK[postureFinal] > POSTURE_RANK.WATCH) {
    postureFinal = 'WATCH';
  }

  let statusOverride;
  let blocker = null;
  let analysis;
  let trigger;

  if (sourceBlocked || noUsableSources) {
    postureFinal = 'NO_CLEAR_PICK';
    statusOverride = EDGE_STATUS.BLOCKED;
    const reasonCode = sourceBlocked && !noResearchPerformed
      ? 'BLOCKED_SOURCE_LAYER_MISSING'
      : 'NO_USABLE_SOURCES';
    const why = noResearchPerformed
      ? `research did not run or returned no usable evidence for this event (source_status=${composite?.source_status})`
      : `no usable evidence channels present`;
    blocker = `${reasonCode}: no usable evidence channels for "${target}" (${why})`;
    analysis = `Contract exists; mention composite has ${layersPresent}/${layersTotal} evidence channels and no usable evidence beyond schedule context for "${target}". Not a rated view or a pass — research gap (${why}). Missing: ${missingCats.join(', ') || 'all evidence channels'}.`;
    trigger = {
      price: null,
        event: `run mentions research for "${target}" (transcripts > quotes > context), then re-score`,
    };
  } else if (proximityOnly) {
    postureFinal = 'WATCH';
    statusOverride = EDGE_STATUS.WATCH;
    analysis = `LOW-SOURCE WATCH only -- no rated view. Event timing exists, but transcript/history/topic evidence is missing for "${target}". Missing: ${missingCats.join(', ') || 'evidence channels'}.`;
    trigger = {
      price: null,
      event: 'upgrade only after transcript, direct quote, historical tendency, or topic-path evidence lands',
    };
  } else {
    statusOverride = MENTION_POSTURE_TO_EDGE[postureFinal] ?? EDGE_STATUS.WATCH;
    const capNote = composite?.posture_cap_reason ? ` (ladder cap: ${composite.posture_cap_reason})` : '';
    analysis = `${r.reasoning_summary ?? `composite ${r.composite_score ?? 'n/a'} [${postureFinal}]`}${capNote}`;
    trigger = {
      price: null,
      event: postureFinal === 'PICK' || postureFinal === 'EVIDENCE_LEAN'
        ? 'confirm exact settlement wording + official event source, then enter on value'
        : 'await stronger evidence (transcript/quote confirmation)',
    };
  }

  // Per-strike evidence availability — computed once here so both the cap
  // below and the renderer (SOURCE GAPS) can read it. Pure on the composite.
  const evidenceAvail = computeEvidenceAvailability(composite);
  const hasHistoricalEvidence =
    evidenceAvail.settled_evidence.status === 'present'
    || evidenceAvail.transcript_evidence.status === 'present'
    || presentCats.includes('historical_tendency');

  // HARD confidence cap (Change D): a strike with NO historical evidence
  // (no settled comparables AND no transcript word-match) is scoring on
  // current-context only. Clamp the NUMERIC score below 65 so the customer
  // tier — a pure function of cpc_score — falls to WEAK YES (max), never
  // STRONG YES. The cap is on the score, not the tier, because the janitor
  // fails score>=65 paired with a non-STRONG-YES tier. Blocked/null scores
  // are left untouched (null stays null; the cap only bounds a real number).
  // ─── Customer score-adjustment contract ──────────────────────────────────
  // raw_model_score (== canonical_term_record.score, gated) is the single
  // starting point. customerScore only ever moves through an explicit,
  // logged entry in customerAdjustments — no other code path may change it.
  // For a route with zero adjustments, customerScore stays byte-identical to
  // rawModelScore (requirement: raw_model_score == customer_score when no
  // downstream policy applies).
  const rawModelScore = r.raw_model_score ?? r.composite_score ?? null;
  let customerScore = rawModelScore;
  const customerAdjustments = [];
  let confidenceCapReason = null;
  let familyScoreAdjusted = false;
  const familyEvidence = composite?.earnings_family_history ?? null;
  const familyHasEvidence = familyEvidence?.tier === 'exact_series' || familyEvidence?.tier === 'earnings_family';
  if (familyHasEvidence && customerScore !== null && Number.isFinite(Number(customerScore)) && familyEvidence.tier === 'earnings_family') {
    const beforeFamilyBlock = Number(customerScore);
    const penalty = Number(familyEvidence.penalty);
    const inputScore = customerScore;
    customerScore = Math.round(50 + (inputScore - 50) * (1 - penalty));
    customerAdjustments.push({
      type: 'earnings_family_penalty',
      reason: `cross-company earnings family fallback (n=${familyEvidence.n}, hit_rate=${familyEvidence.hit_rate ?? 'n/a'}); no same-company settled comparables`,
      input_score: inputScore,
      output_score: customerScore,
      penalty,
    });
    if (familyEvidence.n < FAMILY_STRONG_MIN_N) {
      confidenceCapReason = 'thin cross-company earnings family sample: score capped below STRONG YES';
      const beforeCap = customerScore;
      customerScore = Math.min(NO_HISTORY_CONFIDENCE_CAP, customerScore);
      customerAdjustments.push({
        type: 'thin_family_sample_cap',
        reason: confidenceCapReason,
        input_score: beforeCap,
        output_score: customerScore,
        cap: NO_HISTORY_CONFIDENCE_CAP,
      });
    }
    if (customerScore !== beforeFamilyBlock) {
      familyScoreAdjusted = true;
      const recomputed = recomputePostureAfterScoreAdjustment({
        score: customerScore,
        result: r,
        ladder,
        earningsHint,
        suppressConviction,
      });
      postureFinal = recomputed.posture;
      statusOverride = MENTION_POSTURE_TO_EDGE[postureFinal] ?? EDGE_STATUS.WATCH;
      const capNote = familyEvidence.n < FAMILY_STRONG_MIN_N
        ? `; ${confidenceCapReason}`
        : '';
      analysis = `research score=${customerScore} [${postureFinal}] — cross-company earnings family penalty=${penalty.toFixed(2)} adjusted raw model score ${beforeFamilyBlock} to ${customerScore}${capNote}.`;
      trigger = {
        price: null,
        event: postureFinal === 'PICK' || postureFinal === 'EVIDENCE_LEAN'
          ? 'confirm exact settlement wording + official event source, then enter on value'
          : 'await stronger evidence (transcript/quote confirmation)',
      };
    }
  }
  if (
    !hasHistoricalEvidence && !familyHasEvidence
    && customerScore !== null
    && Number.isFinite(Number(customerScore))
    && !(sourceBlocked || noUsableSources || proximityOnly)
  ) {
    const inputScore = Number(customerScore);
    if (inputScore > NO_HISTORY_CONFIDENCE_CAP || inputScore < NO_HISTORY_CONFIDENCE_FLOOR) {
      customerScore = Math.max(NO_HISTORY_CONFIDENCE_FLOOR, Math.min(NO_HISTORY_CONFIDENCE_CAP, inputScore));
      confidenceCapReason = NO_HISTORY_CONFIDENCE_CAP_REASON;
      customerAdjustments.push({
        type: 'no_historical_evidence_cap',
        reason: NO_HISTORY_CONFIDENCE_CAP_REASON,
        input_score: inputScore,
        output_score: customerScore,
        cap: NO_HISTORY_CONFIDENCE_CAP,
        floor: NO_HISTORY_CONFIDENCE_FLOOR,
      });
      postureFinal = 'WATCH';
      statusOverride = EDGE_STATUS.WATCH;
      analysis = `research score=${customerScore} — ${NO_HISTORY_CONFIDENCE_CAP_REASON}. Raw model score ${inputScore} was limited because the historical proof was insufficient.`;
    }
  }

  // Final model-only row. This intentionally does not call the shared
  // market/edge row builder: quote fields must not exist during decision-row
  // construction. The score is the sole input to final posture, status,
  // confidence, explanation, tier, and downstream ranking.
  const finalScore = customerScore === null || customerScore === undefined
    ? null
    : Math.max(0, Math.min(100, Math.round(Number(customerScore))));
  if (finalScore !== null && !Number.isFinite(finalScore)) {
    throw new Error(`mention model score is not finite for ${target}`);
  }
  const finalCustomerProbability = finalScore === null ? null : finalScore / 100;
  if (!(sourceBlocked || noUsableSources || proximityOnly)) {
    postureFinal = postureFromScore(finalScore, r);
    if (ladder) postureFinal = applyQualificationCap(postureFinal, ladder).posture;
    if (earningsHint && !suppressConviction) postureFinal = applyEarningsPostureHint(postureFinal, earningsHint).posture;
    if (isStub && POSTURE_RANK[postureFinal] > POSTURE_RANK.WATCH) postureFinal = 'WATCH';
  }
  const finalStatus = blocker
    ? EDGE_STATUS.BLOCKED
    : (MENTION_POSTURE_TO_EDGE[postureFinal] ?? EDGE_STATUS.WATCH);
  const ratio = layersTotal > 0 ? layersPresent / layersTotal : 0;
  const finalConfidence = finalScore === null || finalStatus === EDGE_STATUS.BLOCKED
    ? 'low'
    : finalScore >= 80 && ratio >= 0.7
      ? 'high'
      : finalScore >= 55 && ratio >= 0.4
        ? 'medium'
        : 'low';
  const scoreLabel = finalScore === null ? 'UNAVAILABLE' : `${finalScore}/100`;
  const finalAnalysis = blocker
    ? analysis
    : confidenceCapReason
      ? `CPC YES SCORE: ${scoreLabel} — final posture ${postureFinal}; ${confidenceCapReason}.`
      : (proximityOnly ? analysis : `CPC YES SCORE: ${scoreLabel} — final posture ${postureFinal}; ${layersPresent}/${layersTotal} evidence channels present.`);
  const row = {
    market_ticker: composite?.market_ticker ?? 'MISSING',
    side_target: target,
    full_strike_text: composite?.full_strike_text ?? target,
    settlement_summary: 'Exact-string mention settlement per Kalshi listing; verify the event rules and source before acting.',
    // composite_score/cpc_yes_score are the CUSTOMER-facing score (post
    // adjustment) — kept for back-compat with existing sort/render call
    // sites, always equal to customer_score below. raw_model_score is the
    // one true pre-adjustment number; customer_adjustments is the full,
    // explicit trail from raw_model_score to customer_score.
    composite_score: finalScore,
    cpc_yes_score: finalScore,
    raw_model_score: rawModelScore,
    raw_model_probability: r.raw_model_probability ?? null,
    customer_score: finalScore,
    customer_adjustments: customerAdjustments,
    final_customer_probability: finalCustomerProbability,
    composite_posture: postureFinal,
    edge_status: finalStatus,
    layers_present: `${presentCats.length}/${layersTotal}`,
    present_layer_categories: presentCats,
    layers_total: layersTotal,
    missing_layers: missingCats,
    top_evidence_layers: topLayers,
    confidence: finalConfidence,
    analysis: finalAnalysis,
    trigger_event: trigger?.event ?? null,
    blocker,
    blocker_if_any: blocker,
    model_probability: null,
  };
  assertPriceBlind(row, `mention decision row ${row.market_ticker}`);
  const output = {
    ...row,
    pmt_advisory_context: composite?.pmt_advisory_context ?? null,
    proof_pct: composite?.proof_pct ?? null,
    handicap_pct: composite?.handicap_pct ?? null,
    kalshi_native_pct: composite?.kalshi_native_pct ?? null,
    kalshi_native_n: composite?.kalshi_native_n ?? null,
    confidence: finalConfidence,
    reason: (familyScoreAdjusted || confidenceCapReason || proximityOnly || blocker)
      ? finalAnalysis
      : (composite?.reason ?? finalAnalysis),
    proof_reason: composite?.proof_reason ?? null,
    handicap_reason: composite?.handicap_reason ?? null,
    research_citations: Array.isArray(composite?.research_citations) ? composite.research_citations : [],
    research_term_note: composite?.research_term_note ?? null,
    market_type: marketType,
    research_route: composite?.research_route ?? null,
    route_event_format: composite?.route_event_format ?? null,
    required_count: requiredCount,
    repeat_requirement: requiredCount && requiredCount > 1 ? `${requiredCount}+ times` : null,
    qualification_status: qualificationStatus,
    qualification_posture_cap: qualificationPostureCap,
    is_qualification_term: strikeIsEdnq(r.target_mention),
    evidence_availability: evidenceAvail,
    confidence_cap_reason: confidenceCapReason,
    earnings_family_history: familyEvidence,
    canonical_history: composite?.canonical_history ?? null,
    // Pd x Ph x Pe term-probability record (mention-composite-core.mjs
    // composeMentionLedgerFromTermRecord) — carried through so the renderer's
    // renderCanonicalTermModelBlock can surface Pd/Ph/Pe/historical
    // prior/final probability/score/citations on the rendered card.
    canonical_term_record: r.canonical_term_record ?? null,
  };
  assertPriceBlind(output, `final mention decision row ${output.market_ticker}`);
  return output;
}

/**
 * Build the customer-facing v2 mentions packet from the per-market composites
 * of a Kalshi mention event. renderMentionPacket() is the only .txt renderer.
 * The raw contract inventory + full market context go to a separate audit
 * artifact, never the board rows.
 * Returns { text, rows, inventoryText, counts } or null when no composites.
 */
// Deterministic provenance block for earnings_call composites: last-four-quarter
// hit/miss table (priority-one alpha) and context-delta evidence (priority-two).
// Outcomes only — no prices anywhere in the inputs or output.
function renderEarningsAlphaProvenance(composites) {
  const withQuarters = composites.filter((c) => c?.earnings_quarter_terms);
  const withDelta = composites.filter((c) => c?.earnings_context_delta);
  if (!withQuarters.length && !withDelta.length) return null;
  const hm = (v) => (v === true ? 'HIT' : v === false ? 'MISS' : '--');
  const lines = ['earnings_alpha (route=earnings_call, outcomes only, prices excluded):'];
  if (withQuarters.length) {
    lines.push('  last_four_quarter_history (priority-one alpha):');
    lines.push('    term                  | Q-1  | Q-2  | Q-3  | Q-4  | hit_rate | rw_rate | n');
    for (const c of withQuarters) {
      const t = c.earnings_quarter_terms;
      const lfq = c.last_four_quarter_hit_rate ?? {};
      lines.push(`    ${shortTerm(String(c.result?.target_mention ?? c.market_ticker)).padEnd(21)} | ${hm(t.q_minus_1).padEnd(4)} | ${hm(t.q_minus_2).padEnd(4)} | ${hm(t.q_minus_3).padEnd(4)} | ${hm(t.q_minus_4).padEnd(4)} | ${t.four_quarter_hit_rate == null ? 'n/a' : t.four_quarter_hit_rate.toFixed(2)}     | ${t.recency_weighted_hit_rate == null ? 'n/a' : t.recency_weighted_hit_rate.toFixed(2)}    | ${lfq.sample_size ?? t.sample_size ?? 0}`);
    }
  }
  if (withDelta.length) {
    lines.push('  context_delta (priority-two alpha, declared sources only):');
    for (const c of withDelta) {
      const d = c.earnings_context_delta;
      const provSrc = (d.earnings_context_delta?.provenance ?? []).join(',') || 'none';
      lines.push(`    ${shortTerm(String(c.result?.target_mention ?? c.market_ticker)).padEnd(21)} | delta=${d.earnings_context_delta?.value ?? 'absent'} continuity=${d.transcript_theme_continuity?.value ?? 'n/a'} qa_likelihood=${d.analyst_question_likelihood?.value ?? 'n/a'} catalyst=${d.current_quarter_catalyst?.value ?? 'n/a'} settlement_fit=${d.settlement_fit?.value ?? 'unknown'} sources=${provSrc}`);
      if (c.earnings_posture_adjustment?.applied) {
        const adj = c.earnings_posture_adjustment;
        lines.push(`      context_adjustment: capped upward adjustment (${adj.reason})`);
      }
    }
  }
  return lines.join('\n');
}

// Most-recent source tickers shown per settled_history line; the rest collapse
// to a bounded "+N more" count so a long comparable list can never blow up the
// rendered packet.
const SETTLED_HISTORY_TICKER_CAP = 8;

// Deterministic settled-history provenance block. Surfaces the PRICE-FREE
// settled_history artifact attached after the lexical gate clears a market to
// evidence (Phase 4) so the rendered packet shows match tier, sample size,
// hits/misses, hit rate, the full settlement-class breakdown
// (resolved_yes/resolved_no/ednq/ambiguous/unresolved), bounded source tickers,
// and the usable/fail_safe flag. n<2 / soft-only history renders as fail_safe
// (never a bullish signal); a null settled_history (hard block, Truth Social
// out-of-scope, or evaluated NO_MATCH suppression) renders NOTHING — no invented
// confidence. This is render-only: it reads the existing artifact and never
// re-scores. Prices never appear; the artifact carries no price-shaped field.
function renderSettledHistoryProvenance(composites) {
  const withHistory = composites.filter((c) => c && c.settled_history);
  if (!withHistory.length) return [];
  const lines = ['settled_history (Kalshi settled comparables; outcomes only, prices excluded):'];
  for (const c of withHistory) {
    const h = c.settled_history;
    const label = shortTerm(String(c.result?.target_mention ?? c.market_ticker ?? 'unknown'));
    const hitRate = h.hit_rate === null || h.hit_rate === undefined ? 'n/a' : Number(h.hit_rate).toFixed(2);
    lines.push(`  - ${label}: tier=${h.match_tier} n=${h.sample_size} hits=${h.hits} misses=${h.misses} hit_rate=${hitRate} usable=${h.usable === true} fail_safe=${h.fail_safe === true}`);
    const b = h.settlement_breakdown ?? {};
    lines.push(`      settlement_breakdown: resolved_yes=${b.resolved_yes ?? 0} resolved_no=${b.resolved_no ?? 0} ednq=${b.ednq ?? 0} ambiguous=${b.ambiguous ?? 0} unresolved=${b.unresolved ?? 0}`);
    const tickers = Array.isArray(h.source_tickers) ? h.source_tickers : [];
    const shown = tickers.slice(0, SETTLED_HISTORY_TICKER_CAP);
    const more = tickers.length - shown.length;
    const tickerText = shown.length
      ? `${shown.join(',')}${more > 0 ? ` (+${more} more)` : ''}`
      : 'none';
    lines.push(`      source_tickers: ${tickerText} (count=${tickers.length})`);
    if (h.note) lines.push(`      note: ${h.note}`);
  }
  return lines;
}

function renderEarningsFamilyProvenance(composites) {
  const rows = composites.filter((c) => c?.earnings_family_history);
  if (!rows.length) return [];
  const lines = ['earnings_family_history (outcomes only, cross-company fallback explicit):'];
  for (const c of rows) {
    const h = c.earnings_family_history;
    const label = shortTerm(String(c.result?.target_mention ?? c.market_ticker));
    const rate = h.hit_rate == null ? 'n/a' : Number(h.hit_rate).toFixed(2);
    if (h.tier === 'lookup_failed') {
      lines.push(`  - ${label}: earnings family lookup FAILED (unavailable; not verified zero)`);
    } else if (h.tier === 'earnings_family') {
      lines.push(`  - ${label}: settled_history: tier=earnings_family n=${h.n} hits=${h.hits} misses=${h.misses} hit_rate=${rate} penalty=${Number(h.penalty).toFixed(2)} (cross-company earnings base rate; ${c.route_entity ?? 'company'} has no settled comparables of its own)`);
    } else if (h.tier === 'none') {
      lines.push(`  - ${label}: same-company history absent (n<2); no family history with n>=2`);
    } else {
      lines.push(`  - ${label}: settled_history: tier=exact_series n=${h.n} penalty=0 (same-company series)`);
    }
  }
  return lines;
}

function renderResearchCitationProvenance(composites) {
  const ranked = composites
    .filter((c) => Array.isArray(c?.research_citations) && c.research_citations.length)
    .slice()
    .sort((a, b) => (b?.result?.composite_score ?? -1) - (a?.result?.composite_score ?? -1))
    .slice(0, 3);
  if (!ranked.length) return [];
  const lines = ['research_citations (proof + handicapping, URLs only):'];
  for (const c of ranked) {
    const label = shortTerm(String(c.result?.target_mention ?? c.market_ticker ?? 'unknown'));
    const citations = c.research_citations.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim()).slice(0, 4);
    if (!citations.length) continue;
    lines.push(`  - ${label}: ${citations.join(', ')}`);
  }
  return lines.length > 1 ? lines : [];
}

function injectSourceHealthDisclosure(text, sourceHealthDisclosure) {
  const disclosure = String(sourceHealthDisclosure ?? '').trim();
  if (!disclosure) return text;
  const body = String(text ?? '');
  const anchor = '\n---\nrenderer_contract:';
  const idx = body.lastIndexOf(anchor);
  if (idx < 0) {
    return `${body.trimEnd()}\n${disclosure}\n`;
  }
  const head = body.slice(0, idx).trimEnd();
  const tail = body.slice(idx);
  return `${head}\n\n${disclosure}\n${tail}`;
}

export function buildMentionSlatePacket({ date, event, composites, sourcePath = null, inventoryPath = null, sourceHealthDisclosure = null, presentation = null, marketQuotes = [], generatedUtc = null }) {
  if (!Array.isArray(composites) || !composites.length) return null;
  const s = summarizeEvent(event);
  const rows = composites.map((c) => mentionCompositeToDecisionRow(c));
  const summary = summarizeCompositeRun(composites);
  const pmtAdvisoryContext = composites.find((c) => c?.pmt_advisory_context)?.pmt_advisory_context
    ?? rows.find((r) => r?.pmt_advisory_context)?.pmt_advisory_context
    ?? null;

  const blockedCount = rows.filter((r) => r.edge_status === EDGE_STATUS.BLOCKED).length;
  const prov = composites[0] ?? null;
  const provenanceLines = [];
  if (prov?.research_route) {
    provenanceLines.push(`research_route: ${prov.research_route}${prov.route_horizon ? ` (horizon=${prov.route_horizon})` : ''}`);
  }
  provenanceLines.push(...renderSettledHistoryProvenance(composites));
  const canonicalHistoryLines = composites
    .filter((c) => c?.canonical_history && !c?.settled_history)
    .map((c) => {
      const h = c.canonical_history;
      const label = shortTerm(String(c.result?.target_mention ?? c.market_ticker ?? 'unknown'));
      // hits/misses can be genuinely null (reconstruction from the native-scan
      // percentage was impossible) — never render that as a fabricated 0.
      const hitsDisplay = h.hits === null || h.hits === undefined ? 'n/a' : h.hits;
      const missesDisplay = h.misses === null || h.misses === undefined ? 'n/a' : h.misses;
      return `canonical_history: ${label} class=${h.evidence_class} status=${h.status} tier=${h.match_tier ?? 'none'} n=${h.sample_size ?? 0} hits=${hitsDisplay} misses=${missesDisplay}`;
    });
  provenanceLines.push(...[...new Set(canonicalHistoryLines)]);
  provenanceLines.push(...renderEarningsFamilyProvenance(composites));
  provenanceLines.push(...renderResearchCitationProvenance(composites));
  const earningsNote = renderEarningsAlphaProvenance(composites);
  if (earningsNote) provenanceLines.push(...earningsNote.split('\n'));
  const synthesisInput = buildMentionsSynthesisInput({
    date,
    event,
    rows,
    sourceUrl: sourcePath,
    inventoryPath,
    compositeSummary: summary,
    provenanceLines,
    sourceHealthDisclosure,
    pmtAdvisoryContext,
    presentation,
  });
  if (presentation?.publication_blocked && synthesisInput.canonical_event) {
    synthesisInput.event = {
      ...synthesisInput.event,
      canonical_event: synthesisInput.canonical_event,
    };
    synthesisInput.canonical_event = null;
    if (synthesisInput.presentation) {
      synthesisInput.presentation = { ...synthesisInput.presentation, canonical_event: null };
    }
  }
  const text = renderMentionPacket(synthesisInput, {
    generatedAtUtc: generatedUtc ?? new Date().toISOString(),
    marketQuotes,
    marketSnapshotUtc: generatedUtc ?? new Date().toISOString(),
    analystTier: 'none',
  });
  const finalText = injectSourceHealthDisclosure(text, sourceHealthDisclosure);
  const previewValidationInput = presentation?.publication_blocked
    ? {
      ...synthesisInput,
      canonical_event: null,
      presentation: synthesisInput.presentation
        ? { ...synthesisInput.presentation, canonical_event: null }
        : synthesisInput.presentation,
    }
    : synthesisInput;
  validateRenderedPacket(finalText, previewValidationInput);

  // Raw per-contract inventory + market context -> audit artifact only.
  const quoteByTicker = new Map((Array.isArray(marketQuotes) ? marketQuotes : [])
    .map((quote) => [String(quote?.ticker ?? quote?.market_ticker ?? ''), quote]));
  const inventoryLines = rows.map((r, i) =>
    `#${i + 1} [${r.edge_status}] ${r.market_ticker} :: ${r.side_target} | score=${r.composite_score} posture=${r.composite_posture} layers=${r.layers_present} quote=${JSON.stringify(quoteByTicker.get(r.market_ticker) ?? null)} conf=${r.confidence}`);
  const inventoryText = buildInventoryArtifact({
    marketType: 'mentions',
    date,
    eventTicker: s.ticker,
    inventoryLines,
    meta: {
      best_posture: summary.best_posture,
      best_score: summary.best_score ?? 'MISSING',
      scored_count: summary.scored_count,
      blocked_count: blockedCount,
      pricing_excluded: true,
    },
  });

  return {
    text: finalText,
    rows,
    synthesisInput,
    inventoryText,
    counts: { total: rows.length, blocked: blockedCount, scored: summary.scored_count },
    compositeSummary: summary,
    marketQuotes,
  };
}

function termBucketForRow(row) {
  if (row.edge_status === EDGE_STATUS.BLOCKED) return 'blocked/no-source';
  if (row.composite_score === null || row.composite_score === undefined) return 'research-gap';
  return 'research-backed';
}

function evidenceStatusForRow(row) {
  if (row.edge_status === EDGE_STATUS.BLOCKED) return 'research gap';
  if (row.composite_score === null || row.composite_score === undefined) return 'research gap';
  return 'research-backed';
}

function scoreToTier(score) {
  const s = Number(score);
  if (!Number.isFinite(s)) return 'RESEARCH GAP';
  if (s >= 65) return 'STRONG YES';
  if (s >= 50) return 'WEAK YES';
  if (s >= 35) return 'WEAK NO';
  return 'STRONG NO';
}

/**
 * Decision rows carry layers_present in mixed shapes ("1/4" coverage strings
 * from decision-packet, raw counts from mention-composite-core, or layer-name
 * arrays). Normalize to an array of strings before any user-facing join.
 */
export function normalizeLayerList(value) {
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === 'string' ? v : v?.category ?? v?.label ?? (v == null ? '' : String(v))))
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s || s === 'MISSING') return [];
    return s.split(',').map((x) => x.trim()).filter(Boolean);
  }
  if (value && typeof value === 'object') return Object.keys(value);
  return [];
}

export function buildMentionsSynthesisInput({
  date,
  event,
  rows = [],
  sourceUrl = null,
  inventoryPath = null,
  compositeSummary = {},
  provenanceLines = [],
  sourceHealthDisclosure = null,
  pmtAdvisoryContext = null,
  presentation = null,
} = {}) {
  const s = summarizeEvent(event);
  const trustedPresentation = presentation ?? resolveMentionPresentationMetadata({ date, event });
  const rules = firstMarketRules(event);
  const contentRows = rows.filter((row) => row.is_qualification_term !== true);
  const qualificationRows = rows.filter((row) => row.is_qualification_term === true);
  const advisoryContext = pmtAdvisoryContext
    ?? rows.find((row) => row?.pmt_advisory_context)?.pmt_advisory_context
    ?? null;
  // Compact each term to only what the model needs for the article.
  const terms = rows.map((row) => ({
    market_ticker: row.market_ticker ?? null,
    full_strike_text: row.full_strike_text ?? row.side_target,
    short_term: shortTerm(row.side_target, s.title),
    cpc_score: row.composite_score ?? null,
    p_yes_tier: scoreToTier(row.composite_score),
    bucket: row.is_qualification_term ? 'qualification/fallback' : termBucketForRow(row),
    evidence_status: row.is_qualification_term ? 'qualification fallback' : evidenceStatusForRow(row),
    research_state: row.is_qualification_term ? 'qualification fallback' : evidenceStatusForRow(row),
    layers_present: normalizeLayerList(row.layers_present),
    composite_posture: row.composite_posture,
    missing_research_layers: Array.isArray(row.missing_layers)
      ? row.missing_layers.map((l) => l.category ?? l.label ?? String(l)).slice(0, 5)
      : [],
    upgrade_trigger: row.trigger_event,
    research_reason: row.reason ?? null,
    market_type: row.market_type ?? null,
    required_count: Number.isFinite(Number(row.required_count)) ? Number(row.required_count) : null,
    repeat_requirement: row.repeat_requirement ?? null,
    qualification_status: row.qualification_status ?? null,
    qualification_posture_cap: row.qualification_posture_cap ?? null,
    is_qualification_term: row.is_qualification_term === true,
    proof_pct: row.proof_pct ?? null,
    handicap_pct: row.handicap_pct ?? null,
    kalshi_native_pct: row.kalshi_native_pct ?? null,
    kalshi_native_n: row.kalshi_native_n ?? null,
    confidence: row.confidence ?? null,
    proof_reason: row.proof_reason ?? null,
    handicap_reason: row.handicap_reason ?? null,
    research_citations: Array.isArray(row.research_citations) ? row.research_citations : [],
    research_term_note: row.research_term_note ?? null,
    pmt_advisory_context: row.pmt_advisory_context ?? advisoryContext,
    evidence_availability: row.evidence_availability ?? null,
    canonical_history: row.canonical_history ?? null,
    confidence_cap_reason: row.confidence_cap_reason ?? null,
    canonical_term_record: row.canonical_term_record ?? null,
    raw_model_score: row.raw_model_score ?? null,
    raw_model_probability: row.raw_model_probability ?? null,
    customer_adjustments: Array.isArray(row.customer_adjustments) ? row.customer_adjustments : [],
    final_customer_probability: row.final_customer_probability ?? null,
    ...(row.earnings_family_history ? { earnings_family_history: row.earnings_family_history } : {}),
  }));
  const nonBlocked = terms.filter((term) => term.bucket !== 'blocked/no-source');
  const allResearchGap = nonBlocked.length > 0 && nonBlocked.every((term) => term.research_state === 'research gap');

  return {
    packet_kind: 'mentions_customer_packet_v2',
    date,
    event: {
      title: s.title,
      subtitle: s.sub_title,
      date_time: trustedPresentation?.event_time_iso ?? null,
      declared_source_url: s.declared_source_url,
      settlement_source_link: trustedPresentation?.canonical_event?.settlement_source ?? null,
      rules_primary: rules.primary,
    },
    canonical_event: trustedPresentation?.canonical_event ?? null,
    presentation: trustedPresentation,
    synthesis_rules: {
      output_style: 'concise research article / Substack-style brief',
      research_only: true,
      no_trade: true,
      model_written_final_packet_allowed: false,
      use_full_strike_text_only: true,
      market_context_not_in_score: true,
      all_terms_proximity_only: allResearchGap,
      all_terms_research_gap: allResearchGap,
      research_gap_label: allResearchGap ? 'research gap only -- no score' : null,
      forbidden_claims_when_all_terms_proximity_only: ['source-backed composite', 'source backed composite', 'composite score'],
    },
    summary: {
      market_count: compositeSummary.market_count ?? rows.length,
      source_backed_count: compositeSummary.source_backed_count ?? null,
      research_backed_count: compositeSummary.source_backed_count ?? null,
      proximity_only_count: compositeSummary.proximity_only_count ?? null,
      content_term_count: contentRows.length,
      qualification_term_count: qualificationRows.length,
      research_gap_count: contentRows.length - (compositeSummary.source_backed_count ?? 0),
      best_posture: compositeSummary.best_posture ?? null,
      best_tier: scoreToTier(compositeSummary.best_score ?? null),
    },
    deterministic_provenance_lines: Array.isArray(provenanceLines) ? provenanceLines : [],
    source_health_disclosure: sourceHealthDisclosure || null,
    research_provenance: {
      research_route: rows.find((row) => row?.research_route)?.research_route ?? null,
      event_format: rows.find((row) => row?.route_event_format)?.route_event_format ?? null,
      canonical_history: rows.find((row) => row?.canonical_history)?.canonical_history ?? null,
      ...(advisoryContext ? { pmt_advisory_context: advisoryContext } : {}),
    },
    terms,
  };
}

export function buildMentionsSynthesisPrompt(input = {}) {
  throw new Error('model-written mentions packet_text synthesis is disabled; use renderMentionPacket/v2 with JSON-only analyst fields');
}

export function describeMentionsHermesInvocation(options = {}) {
  return {
    command: options.command ?? resolveHermesCommand(),
    subcommand: 'chat',
    provider_arg: 'omitted',
    model_arg: 'omitted',
    source: 'mentions-watch-packet-synthesis',
    note: 'provider/model are intentionally omitted so Hermes uses its active runtime default',
  };
}

// Deterministic compliance appendix (option b of the full-strike requirement):
// the narrative stays model-generated, but every contract's exact full strike
// text — including special contracts like "Event does not qualify" — is
// appended verbatim so no model omission can drop a strike from the packet.
export function buildFullStrikeInventoryAppendix(input = {}) {
  const terms = Array.isArray(input.terms) ? input.terms : [];
  const strikes = terms
    .filter((t) => t?.is_qualification_term !== true && !/event does not qualify/i.test(String(t?.full_strike_text ?? '')))
    .map((t) => String(t.full_strike_text ?? '').trim())
    .filter(Boolean);
  if (!strikes.length) return '';
  return [
    '',
    '--- Full Strike Inventory (exact strike text, every contract) ---',
    ...strikes.map((s) => `- ${s}`),
    '',
  ].join('\n');
}

export function appendFullStrikeInventory(text, input) {
  const appendix = buildFullStrikeInventoryAppendix(input);
  if (!appendix) return text;
  return `${String(text ?? '').replace(/\s+$/, '')}\n${appendix}`;
}

export function validateSynthesizedMentionPacket(text, input) {
  if (!text || !text.trim()) throw new Error('Hermes returned an empty mentions packet');
  const forbiddenJargon = /\b(EVIDENCE_LEAN|LEAN|WATCH|NO_CLEAR_PICK|source-backed composite|source layer(?:s)?|event_proximity|proximity-only|stub|scaffold|composite score)\b/i;
  if ((input?.synthesis_rules?.all_terms_proximity_only || input?.synthesis_rules?.all_terms_research_gap) && forbiddenJargon.test(text)) {
    throw new Error('Hermes packet violated research-gap labeling: used legacy customer jargon');
  }
  for (const term of (input?.terms ?? []).filter((t) => t?.is_qualification_term !== true && !/event does not qualify/i.test(String(t?.full_strike_text ?? '')))) {
    const full = String(term.full_strike_text ?? '').trim();
    if (full && !text.includes(full)) {
      throw new Error(`Hermes packet omitted full strike text: ${full}`);
    }
  }
  if (!/Market Context\s*[-–—:(]*\s*NOT IN SCORE/i.test(text)) {
    throw new Error('Hermes packet omitted Market Context - NOT IN SCORE section');
  }
  if (!/research[- ]only/i.test(text)) {
    throw new Error('Hermes packet omitted research-only footer');
  }
}

export async function synthesizeMentionsUserPacket({ input, chatRunner = runHermesChat } = {}) {
  throw new Error('model-written mentions packet_text synthesis is disabled; customer packets must be rendered by renderMentionPacket/v2');
}


/**
 * Deterministic packet composition (current default path).
 *
 * Models contribute strict-JSON fields only (analyst narrative via the model
 * router; optional red-team flags). Code validates them, falls back to empty
 * fields on any failure, and renderMentionPacket() writes the final .txt.
 * A model can therefore never control layout, scores, or section order, and
 * proximity-only events never spend a model call at all.
 */
export async function composeMentionPacketDeterministic({
  input,
  env = process.env,
  chatRunner = runHermesChat,
  now = () => new Date().toISOString(),
  marketQuotes = [],
} = {}) {
  if (!input || typeof input !== 'object') throw new Error('mentions packet compose input missing');
  const generated = now();
  const analystRun = await fetchAnalystFields({ input, summary: input.summary ?? {}, env, chatRunner });
  const redteamRun = await fetchRedteamFields({ input, env, chatRunner });
  const text = renderMentionPacket(input, {
    analyst: analystRun.analyst,
    redteam: redteamRun.redteam,
    generatedAtUtc: generated,
    marketQuotes,
    marketSnapshotUtc: generated,
    analystTier: analystRun.tier,
  });
  validateRenderedPacket(text, input);
  return {
    text,
    invocation: {
      renderer: CUSTOMER_RENDERER_ID,
      analyst_tier: analystRun.tier,
      analyst_invocation: analystRun.invocation,
      analyst_fallback: analystRun.fallback === true,
      analyst_reason: analystRun.reason,
      redteam_invocation: redteamRun.invocation,
      redteam_reason: redteamRun.reason,
    },
  };
}

function firstMarketRules(event) {
  const markets = Array.isArray(event?.markets) ? event.markets : [];
  const m = markets.find((x) => x?.rules_primary || x?.rules_secondary);
  return {
    primary: m?.rules_primary || null,
    secondary: m?.rules_secondary || null,
  };
}

function buildMentionProcess({ event, hasLocalEvidence = false, legacy = null }) {
  const rules = legacy
    ? { primary: legacy.resolution || legacy.resolution_mechanics || null, secondary: null }
    : firstMarketRules(event);
  const marketCount = Array.isArray(event?.markets) ? event.markets.length : 0;
  return evaluateDecisionProcess({
    marketType: MARKET_TYPES.MENTION_MARKET,
    rawDecision: 'WATCH',
    forceWatch: true,
    checked: {
      exact_settlement_wording: Boolean(rules.primary || rules.secondary),
      likely_event_source: Boolean(legacy?.event_context || legacy?.context),
      word_matching_rules_aliases: Boolean(rules.primary || rules.secondary),
      recent_public_statements: hasLocalEvidence,
      official_schedule_event: Boolean(legacy?.official_schedule || legacy?.schedule),
      x_chatter_separated: true,
      market_board_context: marketCount > 0 || Boolean(legacy),
    },
    topEvidence: [
      marketCount > 0 ? `Kalshi market set captured with ${marketCount} market(s).` : null,
      rules.primary ? 'Settlement wording present in source packet.' : null,
      hasLocalEvidence ? 'Legacy source evidence present.' : null,
    ].filter(Boolean),
    settlementRules: rules.primary || rules.secondary || 'MISSING: exact settlement wording not present in packet.',
    verifiedFacts: hasLocalEvidence ? 'Legacy source evidence present; requires research review.' : 'No verified transcript/event facts supplied by packet generator.',
    marketSignalText: marketCount > 0 ? 'Price context captured for research; no CPC read inferred from price.' : 'No price context captured.',
    socialChatter: 'Separated: packet generator does not promote X chatter to fact.',
    inference: 'Mention-market inference blocked until exact source, transcript path, and word-match rules are checked.',
    skepticReview: 'MISSING: no skeptic review in packet generator.',
    finalJudgment: 'WATCH only; no CPC read without exact wording, source/event path, and public statement/schedule evidence.',
    wouldChangeView: [
      'Official event or transcript source is identified.',
      'Exact word-match/alias rules are confirmed.',
      'Recent official/public statement context supports one side.',
    ],
  });
}

function formatMaybe(value) {
  return value === null || value === undefined || value === '' ? 'MISSING' : String(value);
}

function marketRows(event) {
  const markets = Array.isArray(event?.markets) ? event.markets.slice(0, PACKET_LIMIT) : [];
  let missingStrikeCount = 0;
  const rows = markets.map((raw) => {
    const normalized = normalizeMarket(raw);
    if (normalized.missing_strike_text) missingStrikeCount += 1;
    return { raw, normalized };
  });
  return {
    rows,
    marketCount: Array.isArray(event?.markets) ? event.markets.length : 0,
    missingStrikeCount,
    missingMarkets: !Array.isArray(event?.markets) || event.markets.length === 0,
    truncatedCount: Array.isArray(event?.markets) ? Math.max(0, event.markets.length - rows.length) : 0,
  };
}

function renderContractInventory(marketInfo) {
  const lines = [];
  lines.push('kalshi_contract_inventory_NOT_IN_SCORE:');
  lines.push('  note: contract metadata and settlement wording are listed for routing/research; not used as composite evidence layers.');
  if (marketInfo.missingMarkets) {
    lines.push('  MISSING_MARKETS: event has no markets[]');
    return lines;
  }
  for (const { normalized: m } of marketInfo.rows) {
    lines.push(`  - market_ticker: ${formatMaybe(m.ticker)}`);
    lines.push(`    market_title: ${formatMaybe(m.title)}`);
    lines.push(`    market_subtitle: ${formatMaybe(m.subtitle)}`);
    lines.push(`    yes_sub_title: ${formatMaybe(m.yes_sub_title)}`);
    lines.push(`    no_sub_title: ${formatMaybe(m.no_sub_title)}`);
    lines.push(`    strike_source_used: ${formatMaybe(m.strike_source_used || 'MISSING_STRIKE_TEXT')}`);
    lines.push(`    full_strike_display: ${formatMaybe(m.full_strike_display || 'MISSING_STRIKE_TEXT')}`);
    lines.push(`    close_time_utc: ${formatMaybe(m.close_time)}`);
    lines.push(`    expected_expiration_utc: ${formatMaybe(m.expected_expiration_time)}`);
    lines.push(`    rules_primary: ${formatMaybe(m.rules_primary)}`);
    lines.push(`    rules_secondary: ${formatMaybe(m.rules_secondary)}`);
  }
  if (marketInfo.truncatedCount > 0) {
    lines.push(`  ... ${marketInfo.truncatedCount} additional markets truncated`);
  }
  return lines;
}

function renderCompositeEvidence(composites) {
  const lines = [];
  lines.push('--- Composite Evidence ---');
  lines.push('scoring_model: mention_composite_v1');
  lines.push('pricing_excluded: true');
  lines.push('pricing_exclusion_note: market context is excluded from all layer records and composite math.');
  if (!composites.length) {
    lines.push('composite_markets: 0');
    lines.push('composite_status: NO_CLEAR_PICK (no markets available for scoring)');
    return lines;
  }
  lines.push(`composite_markets: ${composites.length}`);
  for (const c of composites) {
    const r = c.result;
    lines.push(`  - market_ticker: ${formatMaybe(c.market_ticker)}`);
    lines.push(`    target_mention: ${formatMaybe(r.target_mention)}`);
    lines.push(`    profile: ${r.profile}`);
    lines.push(`    profile_basis: ${c.profile_basis}`);
    lines.push(`    research_route: ${formatMaybe(c.research_route)}`);
    if (c.history_match_tier && c.history_match_tier !== 'none') {
      lines.push(`    settled_history: tier=${c.history_match_tier} n=${c.history_sample_size} hits=${c.history_hits} misses=${c.history_misses} hit_rate=${c.history_hit_rate ?? 'n/a'}`);
    }
    lines.push(`    composite_score: ${r.composite_score === null ? 'MISSING' : r.composite_score}`);
    lines.push(`    composite_tier: ${scoreToTier(r.composite_score)}`);
    lines.push(`    layers_present: ${r._meta.layers_present}/${r._meta.layers_total}`);
    lines.push('    top_support:');
    if (r.top_supporting_layers.length) {
      for (const layer of r.top_supporting_layers) {
        lines.push(`      - ${layer.category}: value=${layer.value} contribution=${layer.contribution}`);
      }
    } else {
      lines.push('      - MISSING: no evidence channels supplied');
    }
    lines.push('    missing_layers:');
    if (r.missing_layers.length) {
      for (const layer of r.missing_layers) {
        lines.push(`      - ${layer.category}: ${layer.missing_note}`);
      }
    } else {
      lines.push('      - none');
    }
    lines.push('    source_notes:');
    if (r.source_notes.length) {
      for (const note of r.source_notes) lines.push(`      - ${note}`);
    } else {
      lines.push('      - MISSING: no source notes from present layers');
    }
    lines.push(`    reasoning_summary: ${r.reasoning_summary}`);
    if (c.source_ladder) {
      for (const ladderLine of renderSourceLadder(c.source_ladder)) {
        lines.push(`    ${ladderLine}`);
      }
      lines.push(`    posture_final_after_ladder_cap: ${c.posture_final}`);
      if (c.posture_cap_reason) {
        lines.push(`    posture_cap_reason: ${c.posture_cap_reason}`);
      }
    } else {
      lines.push('    source_ladder: MISSING (no source-ladder inputs supplied; pricing is still NOT IN SCORE)');
    }
  }
  return lines;
}

function renderMarketContextNotInScore(marketInfo) {
  const lines = [];
  lines.push('--- Market Context - NOT IN SCORE ---');
  lines.push('note: Kalshi prices, liquidity, volume, and open interest are displayed only for validation/context and never enter mention_composite scoring.');
  if (marketInfo.missingMarkets) {
    lines.push('  MISSING_MARKETS: event has no markets[]');
    return lines;
  }
  for (const { normalized: m } of marketInfo.rows) {
    lines.push(`  - market_ticker: ${formatMaybe(m.ticker)}`);
    lines.push(`    yes_bid: ${formatMaybe(m.yes_bid_dollars)}`);
    lines.push(`    yes_ask: ${formatMaybe(m.yes_ask_dollars)}`);
    lines.push(`    no_bid: ${formatMaybe(m.no_bid_dollars)}`);
    lines.push(`    no_ask: ${formatMaybe(m.no_ask_dollars)}`);
    lines.push(`    last_price: ${formatMaybe(m.last_price_dollars)}`);
    lines.push(`    liquidity: ${formatMaybe(m.liquidity_dollars)}`);
    lines.push(`    volume: ${formatMaybe(m.volume_fp)}`);
    lines.push(`    open_interest: ${formatMaybe(m.open_interest_fp)}`);
  }
  if (marketInfo.truncatedCount > 0) {
    lines.push(`  ... ${marketInfo.truncatedCount} additional market contexts truncated`);
  }
  return lines;
}

export function discoverMentionEvents(stateRoot, date) {
  const roots = [
    resolve(stateRoot, 'mentions', date),
    resolve(stateRoot, 'mentions', 'events', date),
    resolve('channels', 'mentions', date),
  ];
  const events = [];
  for (const root of roots) {
    if (!existsSync(root) || !statSync(root).isDirectory()) continue;
    for (const entry of readdirSync(root)) {
      const p = join(root, entry);
      try {
        if (!statSync(p).isFile()) continue;
        if (!/\.(json|md)$/i.test(entry)) continue;
        const raw = readFileSync(p, 'utf8');
        let parsed = null;
        if (entry.endsWith('.json')) parsed = readJsonIfExists(p);
        events.push({ file: p, name: entry, body: raw, parsed });
      } catch {}
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Research merge: read state/mentions/<date>/research/*.json and merge
// layer_records + source_ladder_inputs into the Kalshi event/market objects.
// ---------------------------------------------------------------------------
function utcMs(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// Research is collected by the orchestrator immediately BEFORE generation (collect
// -> generate, minutes apart), so a fresh artifact is produced slightly earlier
// than the generation run start — never after it. "Fresh" therefore means "from
// the current collection cycle": produced within MAX_RESEARCH_AGE_MS of the run.
// Genuinely stale (prior-day / prior-cycle) artifacts are rejected so the packet
// fails closed rather than rendering yesterday's research. Exact per-cycle
// freshness (threading a cycle id from the orchestrator) is tracked separately.
const MAX_RESEARCH_AGE_MS = 6 * 60 * 60 * 1000;
function researchArtifactIsFresh(entry, runStartedAtUtc) {
  const runStart = utcMs(runStartedAtUtc);
  if (runStart === null) return false;
  const cutoff = runStart - MAX_RESEARCH_AGE_MS;
  const generated = utcMs(entry?.generated_utc);
  const produced = utcMs(entry?.produced_at);
  const stamp = Math.max(
    generated ?? Number.NEGATIVE_INFINITY,
    produced ?? Number.NEGATIVE_INFINITY,
  );
  return Number.isFinite(stamp) && stamp >= cutoff;
}

function researchRowHasUsableSignal(row) {
  if (!row || typeof row !== 'object') return false;
  const layerRecords = row.layer_records && typeof row.layer_records === 'object' ? row.layer_records : null;
  const sourceLadderInputs = row.source_ladder_inputs && typeof row.source_ladder_inputs === 'object' ? row.source_ladder_inputs : null;
  return [
    row.blended_pct,
    row.proof_pct,
    row.handicap_pct,
    row.kalshi_native_pct,
    layerRecords && Object.keys(layerRecords).length ? 1 : null,
    sourceLadderInputs && Object.keys(sourceLadderInputs).length ? 1 : null,
  ].some((v) => Number.isFinite(Number(v)))
    && (!Number.isFinite(Number(row.kalshi_native_n)) || Number(row.kalshi_native_n) >= 0);
}

function researchEntryHasUsableSignal(entry) {
  return Array.isArray(entry?.markets) && entry.markets.some(researchRowHasUsableSignal);
}

function loadResearchForDate(stateRoot, date, { runStartedAtUtc = null } = {}) {
  const researchDir = resolve(stateRoot, 'mentions', date, 'research');
  if (!existsSync(researchDir)) {
    const empty = new Map();
    empty._staleTickers = new Set();
    return empty;
  }
  const map = new Map();
  map._staleTickers = new Set();
  for (const entry of readdirSync(researchDir)) {
    if (!entry.endsWith('.json')) continue;
    const p = join(researchDir, entry);
    const data = readJsonIfExists(p);
    if (!data || !data.event_ticker) continue;
    if (runStartedAtUtc && !researchArtifactIsFresh(data, runStartedAtUtc)) {
      map._staleTickers.add(data.event_ticker);
    }
    // Build a per-market-ticker lookup
    const marketMap = new Map();
    for (const m of data.markets || []) {
      if (m.market_ticker) marketMap.set(m.market_ticker, m);
    }
    map.set(data.event_ticker, { ...data, _marketMap: marketMap });
  }
  return map;
}

function uniqueResolved(paths) {
  const out = [];
  const seen = new Set();
  for (const p of paths) {
    const r = resolve(p);
    if (seen.has(r)) continue;
    seen.add(r);
    out.push(r);
  }
  return out;
}

function localOnlyDiscoveryStats(events) {
  const marketCount = events.reduce((sum, ev) => sum + (Array.isArray(ev.markets) ? ev.markets.length : 0), 0);
  return {
    totalEvents: events.length,
    mentionEvents: events.length,
    rejectedEvents: 0,
    totalMarkets: marketCount,
    mentionMarkets: marketCount,
    broadEvents: 0,
    seriesEvents: 0,
  };
}

function loadExactMentionEventsFromArtifacts({ date, tickers = [], stateRoots = [], runStartedAtUtc = null } = {}) {
  const roots = uniqueResolved(stateRoots.length ? stateRoots : ['state']);
  const events = [];
  const loaded = [];
  const missing = [];
  for (const ticker of tickers) {
    let found = null;
    for (const root of roots) {
      const eventPath = resolve(root, 'mentions', date, 'kalshi-events', `${ticker}.json`);
      const rawEvent = readJsonIfExists(eventPath);
      const event = rawEvent?.event_ticker
        ? { ...rawEvent, event_url: rawEvent.event_url ?? canonicalKalshiEventUrl(rawEvent.event_ticker) }
        : rawEvent;
      if (!event?.event_ticker) continue;
      const researchMap = loadResearchForDate(root, date, { runStartedAtUtc });
      const researchEntry = researchMap.get(ticker);
      const staleResearch = researchMap._staleTickers?.has(ticker) ?? false;
      found = {
        event: mergeResearchIntoEvent(event, researchEntry, { staleResearch }),
        root,
        eventPath,
        researchPath: resolve(root, 'mentions', date, 'research', `${ticker}.json`),
      };
      break;
    }
    if (found) {
      events.push(found.event);
      loaded.push({ ticker, root: found.root, eventPath: found.eventPath, researchPath: found.researchPath });
    } else {
      missing.push(ticker);
    }
  }
  return { events, loaded, missing, roots };
}

export async function resolveOnlyMentionEvents({
  stateRoot,
  date,
  tickers = [],
  windowDays = WATCHLIST_WINDOW_DAYS,
  allowUndated = false,
  env = process.env,
  deps = {},
  runStartedAtUtc = null,
} = {}) {
  const stateRoots = deps.stateRoots ?? [stateRoot, 'state'];
  const loadExactMentionEventsFromArtifactsImpl = deps.loadExactMentionEventsFromArtifacts || loadExactMentionEventsFromArtifacts;
  const gatherMentionEventsImpl = deps.gatherMentionEvents || ((args) => gatherMentionEvents({
    ...args,
    deps: deps.gatherDeps ?? {},
  }));

  const localOnlyLoad = loadExactMentionEventsFromArtifactsImpl({
    date,
    tickers,
    stateRoots,
    runStartedAtUtc,
  });
  const hasAllRequestedArtifacts = tickers.length > 0
    && localOnlyLoad.loaded.length === tickers.length
    && localOnlyLoad.missing.length === 0;

  if (hasAllRequestedArtifacts) {
    return {
      mode: 'fast-path',
      localOnlyLoad,
      allEvents: localOnlyLoad.events,
      combinedStats: localOnlyDiscoveryStats(localOnlyLoad.events),
      discovery: {
        ok: true,
        events: localOnlyLoad.events,
        source: {
          label: 'local-only-artifact-fast-path',
          api_url: '(skipped live discovery for --only local artifact)',
          page_url: KALSHI_SOURCES.broad.page_url,
        },
        error: null,
      },
      dateFilteredEvents: localOnlyLoad.events,
      persistedCount: 0,
      allPrimeAttempts: [{
        ok: true,
        skipped: true,
        label: `--only local artifact fast path (${localOnlyLoad.loaded.map((x) => x.ticker).join(',')})`,
        status: 0,
        stderr: '',
        error: null,
      }],
      loadedAfterGather: localOnlyLoad.loaded,
      missingAfterGather: [],
      gathered: null,
    };
  }

  const gathered = await gatherMentionEventsImpl({
    stateRoot,
    date,
    windowDays,
    allowUndated,
    env,
    deps: deps.gatherDeps ?? {},
  });
  const reloaded = loadExactMentionEventsFromArtifactsImpl({
    date,
    tickers,
    stateRoots,
    runStartedAtUtc,
  });

  return {
    mode: 'self-heal',
    localOnlyLoad,
    gathered,
    allEvents: reloaded.events,
    combinedStats: gathered.combinedStats,
    discovery: gathered.discovery,
    dateFilteredEvents: reloaded.events,
    persistedCount: gathered.persistedCount,
    allPrimeAttempts: gathered.allPrimeAttempts,
    loadedAfterGather: reloaded.loaded,
    missingAfterGather: reloaded.missing,
  };
}

export function mergeResearchIntoEvent(event, researchEntry, { staleResearch = false } = {}) {
  const keepOnlyEventProximity = (layerRecords = {}) => {
    if (!layerRecords || typeof layerRecords !== 'object') return {};
    return layerRecords.event_proximity ? { event_proximity: layerRecords.event_proximity } : {};
  };
  if (!researchEntry && !staleResearch) {
    return { ...event };
  }
  const cloned = { ...event };
  const routed = resolveResearchRoute(routeEventLike({ event: cloned }));
  const timed = attachConfirmedEventTiming(cloned, routed?.route, { researchEntry });
  if (!EVENT_START_FIELDS.some((field) => cloned?.[field] != null && String(cloned[field]).trim() !== '')
      && timed.event_time != null) {
    cloned.event_time = timed.event_time;
  }
  cloned.declared_source_url = cloned.declared_source_url
    ?? researchEntry?.declared_source_url
    ?? researchEntry?.declared_source_urls?.[0]
    ?? null;
  // Keep the research run timestamp even when its content is stale or lacks
  // a usable signal. Research quality and research timing are separate facts.
  cloned.research_timestamp = cloned.research_timestamp ?? researchEntry?.produced_at ?? researchEntry?.generated_utc ?? null;
  if (staleResearch || (researchEntry && !researchEntryHasUsableSignal(researchEntry))) {
    cloned.source_status = 'NO_DECLARED_SOURCES';
    cloned.markets = (Array.isArray(cloned.markets) ? cloned.markets : []).map((m) => ({
      ...m,
      source_status: 'NO_DECLARED_SOURCES',
      layer_records: keepOnlyEventProximity(m.layer_records),
      source_ladder_inputs: null,
      research_quality: 'stub',
      blended_pct: null,
    }));
    return cloned;
  }
  const markets = Array.isArray(cloned.markets) ? cloned.markets.slice() : [];
  const marketMap = researchEntry._marketMap || new Map();
  const hasUsableResearch = researchEntryHasUsableSignal(researchEntry);
  const eventSourceStatus = hasUsableResearch ? (researchEntry.source_status ?? null) : 'NO_DECLARED_SOURCES';
  const proofCitations = Array.isArray(researchEntry.proof_pass?.citations) ? researchEntry.proof_pass.citations : [];
  const handicappingCitations = Array.isArray(researchEntry.handicapping_pass?.citations) ? researchEntry.handicapping_pass.citations : [];
  const combinedCitations = [...new Set([...proofCitations, ...handicappingCitations].filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim()))];
  if (eventSourceStatus) {
    cloned.source_status = eventSourceStatus;
  }

  cloned.markets = markets.map(m => {
    const ticker = m.ticker;
    const r = marketMap.get(ticker);
    const merged = { ...m };
    if (eventSourceStatus) {
      merged.source_status = eventSourceStatus;
    }
    if (!r) return merged;
    if (!hasUsableResearch) {
      merged.layer_records = keepOnlyEventProximity(m.layer_records);
      merged.source_ladder_inputs = null;
      merged.research_quality = 'stub';
      merged.blended_pct = null;
      return merged;
    }
    if (r.layer_records) {
      merged.layer_records = r.layer_records;
    }
    if (r.source_ladder_inputs) {
      merged.source_ladder_inputs = r.source_ladder_inputs;
    }
    if (r.research_quality) {
      merged.research_quality = r.research_quality;
    }
    if (Number.isFinite(Number(r.blended_pct))) {
      merged.blended_pct = Number(r.blended_pct);
    }
    if (r.proof_pct !== undefined) {
      merged.proof_pct = r.proof_pct;
    }
    if (r.handicap_pct !== undefined) {
      merged.handicap_pct = r.handicap_pct;
    }
    if (r.kalshi_native_pct !== undefined) {
      merged.kalshi_native_pct = r.kalshi_native_pct;
    }
    if (r.kalshi_native_n !== undefined) {
      merged.kalshi_native_n = r.kalshi_native_n;
    }
    if (r.kalshi_scan_ok !== undefined) {
      merged.kalshi_scan_ok = r.kalshi_scan_ok;
    }
    if (r.kalshi_events_scanned !== undefined) {
      merged.kalshi_events_scanned = r.kalshi_events_scanned;
    }
    if (r.kalshi_scan_error !== undefined) {
      merged.kalshi_scan_error = r.kalshi_scan_error;
    }
    if (r.confidence) {
      merged.confidence = r.confidence;
    }
    if (r.proof_reason) {
      merged.proof_reason = r.proof_reason;
    }
    if (r.handicap_reason) {
      merged.handicap_reason = r.handicap_reason;
    }
    if (r.reason) {
      merged.research_reason = r.reason;
    }
    if (r.market_type !== undefined) {
      merged.market_type = r.market_type;
    }
    if (r.required_count !== undefined) {
      merged.required_count = r.required_count;
    }
    if (r.repeat_requirement !== undefined) {
      merged.repeat_requirement = r.repeat_requirement;
    }
    if (r.is_qualification_term !== undefined) {
      merged.is_qualification_term = r.is_qualification_term;
    }
    if (r.qualification_status !== undefined) {
      merged.qualification_status = r.qualification_status;
    }
    if (r.qualification_posture_cap !== undefined) {
      merged.qualification_posture_cap = r.qualification_posture_cap;
    }
    if (combinedCitations.length) {
      merged.research_citations = combinedCitations;
    }
    // Settlement text must reference the bare strike token and its accepted
    // alternative forms (genuine slash variants from the rules
    // snapshot), NEVER the full market title. targetMentionFromMarket returns
    // "<title> -- <strike>"; strikeWordFromMarket returns the bare token.
    // Build accepted_forms from the rules snapshot so the settlement line can
    // list the strike token and its alternatives (e.g. Afford / Affordable /
    // Affordability) without interpolating the event title. Lexical inflections
    // are described in prose, not enumerated here.
    const strikeToken = strikeWordFromMarket(m);
    let acceptedForms = null;
    if (strikeToken) {
      try {
        const snap = buildMarketRulesSnapshot(event, m);
        const customerForms = buildCustomerSettlementForms(strikeToken);
        if (Array.isArray(snap?.accepted_forms) && snap.accepted_forms.length && customerForms.length) {
          acceptedForms = customerForms;
        }
      } catch {
        // rules snapshot is best-effort for settlement text; fall back to the
        // slash variants embedded in the strike token itself.
      }
    }
    const researchNote = buildResearchTermNote({
      phrase: strikeToken ?? targetMentionFromMarket(m),
      reason: r.reason ?? null,
      kalshiNativePct: r.kalshi_native_pct ?? null,
      kalshiNativeN: r.kalshi_native_n ?? null,
      proofPct: r.proof_pct ?? null,
      handicapPct: r.handicap_pct ?? null,
      requiredCount: r.required_count ?? null,
      acceptedForms,
      speaker: speakerLabelForEvent(event),
      citations: combinedCitations,
    });
    if (researchNote) {
      merged.research_term_note = researchNote;
    }
    return merged;
  });

  return cloned;
}

export function buildKalshiEventPacket({ date, event, sourceUrl, inventoryPath = null, historyRecords = null, historyStoreStatus = null, earningsQuarters = null, earningsContextSources = null, earningsFamilyHistory = null, sourceHealthDisclosure = null, generatedUtc = null, researchTimestamp = null, marketQuotes = null, researchEntry = null }) {
  const eventRoute = resolveResearchRoute(routeEventLike({ event }));
  event = attachConfirmedEventTiming(event, eventRoute?.route, { researchEntry, earningsQuarters });
  const s = summarizeEvent(event);
  const marketInfo = marketRows(event);
  const canonicalEvent = buildCanonicalMentionIdentity({
    date,
    event,
    route: eventRoute?.route ?? null,
    generatedUtc: generatedUtc ?? new Date().toISOString(),
    researchTimestamp: researchTimestamp ?? event?.research_timestamp ?? event?.researched_at_utc ?? null,
  });
  const canonicalValidation = validateCanonicalMentionIdentity(canonicalEvent, eventRoute?.route ?? null);
  const presentationBase = resolveMentionPresentationMetadata({ date, event });
  const presentation = {
    ...presentationBase,
    canonical_event: canonicalEvent,
    blocked: presentationBase.blocked,
    blocker_code: presentationBase.blocker_code,
    reason: presentationBase.blocked
      ? presentationBase.reason
      : presentationBase.reason,
    source_gaps: canonicalValidation.source_gaps,
    publication_blocked: !canonicalValidation.ok,
    event_time_iso: canonicalEvent.event_time_central.iso ?? presentationBase.event_time_iso ?? null,
    event_date: canonicalEvent.event_date ?? presentationBase.event_date ?? null,
    event_time_source: canonicalEvent.event_time_central.source ?? presentationBase.event_time_source ?? null,
    settlement_source: canonicalEvent.settlement_source,
  };

  if (presentation.blocked) {
    const blocker = {
      event_ticker: s.ticker,
      date,
      stage: 'event_metadata',
      blocker_code: BLOCKED_EVENT_METADATA_MISMATCH,
      reason: presentation.reason,
      title: presentation.title,
      settlement_source: presentation.settlement_source,
      packet_date: presentation.packet_date,
      ticker_date: presentation.ticker_date,
      event_time_iso: presentation.event_time_iso,
      event_date: presentation.event_date,
      event_time_source: presentation.event_time_source,
      conflicts: presentation.conflicts,
      source_gaps: canonicalValidation.source_gaps,
      blocked_at_utc: new Date().toISOString(),
      delivered: false,
    };
    return {
      blocked: true,
      blocker,
      text: null,
      inventoryText: null,
      rows: [],
      synthesisInput: null,
      researchProvenance: null,
      marketCount: marketInfo.marketCount,
      missingStrikeCount: marketInfo.missingStrikeCount,
      missingMarkets: marketInfo.missingMarkets,
      compositeSummary: {
        market_count: marketInfo.marketCount,
        scored_count: 0,
        source_backed_count: 0,
        proximity_only_count: 0,
        best_posture: 'NO_CLEAR_PICK',
        best_score: null,
        pricing_excluded: true,
      },
      counts: {
        total: marketInfo.marketCount,
        blocked: marketInfo.marketCount,
        scored: 0,
      },
      marketQuotes,
    };
  }

  // Phase 2 earnings alpha (earnings_call route only): the per-term quarter
  // layer and context delta are built once per event from fixtures/cache —
  // never from crawling — then shared by every market composite.
  let earningsQuarterLayer = null;
  let earningsContextDelta = null;
  if (eventRoute?.route === 'earnings_call') {
    const family = resolveEarningsFamily(event);
    // Use the bare strike term (yes_sub_title / custom strike word), not the
    // full display text, so terms line up with quarter-history outcome keys.
    const strikeTerms = marketInfo.rows
      .map(({ raw }) => asText(raw?.yes_sub_title) || asText(raw?.custom_strike?.Word) || targetMentionFromMarket(raw))
      .filter((t) => t && t !== 'MISSING');
    if (family && Array.isArray(earningsQuarters) && earningsQuarters.length && strikeTerms.length) {
      earningsQuarterLayer = buildEarningsQuarterLayer({
        family: family.family,
        ticker: family.ticker,
        terms: strikeTerms,
        quarters: earningsQuarters,
      });
    }
    if (earningsContextSources && strikeTerms.length) {
      earningsContextDelta = buildEarningsContextDelta({
        strikeTerms,
        declaredSources: earningsContextSources,
      });
    }
  }

  // Phase 3: sports_announcer per-market settled history + game context.
  // Uses already-loaded historyRecords (no async needed). Game context is
  // per-term since phrase triggers differ by strike term.
  const composites = marketInfo.rows.map(({ raw }) => {
    let perMarketSportsHistory = null;
    let perMarketGameCtx = null;
    if (eventRoute?.route === 'sports_announcer') {
      const term = asText(raw?.yes_sub_title) || asText(raw?.custom_strike?.Word) || targetMentionFromMarket(raw);
      if (Array.isArray(historyRecords) && historyRecords.length) {
        perMarketSportsHistory = buildSportsSettledHistorySync({
          eventTicker: event?.event_ticker,
          seriesTicker: event?.series_ticker,
          eventTitle: event?.title,
          term,
          route: eventRoute.route,
          entity: eventRoute.entity,
          horizon: eventRoute.horizon,
          allRecords: historyRecords,
        });
      }
      perMarketGameCtx = buildSportsGameContext({ event, term });
    }
    return buildMentionCompositeForMarket({
      event, market: raw, historyRecords, historyStoreStatus,
      earningsQuarterLayer, earningsContextDelta, earningsFamilyHistory,
      sportsSettledResult: perMarketSportsHistory,
      sportsGameContextResult: perMarketGameCtx,
    });
  });
  const compositeSummary = summarizeCompositeRun(composites);
  const attachmentContract = buildMentionAttachmentContract(composites);
  const prov = composites.find((c) => !c?.is_qualification_term) ?? bestComposite(composites) ?? null;
  const researchProvenance = prov ? {
    research_route: prov.research_route ?? null,
    route_basis: prov.route_basis ?? null,
    route_entity: prov.route_entity ?? null,
    route_horizon: prov.route_horizon ?? null,
    history_match_tier: prov.history_match_tier ?? null,
    history_sample_size: prov.history_sample_size ?? null,
    history_hits: prov.history_hits ?? null,
    history_misses: prov.history_misses ?? null,
    history_hit_rate: prov.history_hit_rate ?? null,
    history_match_quality_penalty: prov.history_match_quality_penalty ?? null,
    history_source_tickers: prov.history_source_tickers ?? null,
    earnings_family_history: prov.earnings_family_history ?? null,
    last_four_quarter_hit_rate: earningsQuarterLayer?.last_four_quarter_hit_rate ?? null,
    earnings_quarters_considered: earningsQuarterLayer?.quarters_considered ?? null,
    earnings_context_delta: earningsContextDelta ? {
      declared_source_keys: earningsContextDelta.declared_source_keys ?? null,
      missing_source_keys: earningsContextDelta.missing_source_keys ?? null,
      terms: (earningsContextDelta.terms ?? []).map((t) => ({
        term: t.term,
        earnings_context_delta: t.earnings_context_delta ?? null,
        transcript_theme_continuity: t.transcript_theme_continuity ?? null,
        analyst_question_likelihood: t.analyst_question_likelihood ?? null,
        current_quarter_catalyst: t.current_quarter_catalyst ?? null,
        settlement_fit: t.settlement_fit ?? null,
      })),
    } : null,
    earnings_posture_adjustments: composites
      .filter((c) => c.earnings_posture_adjustment)
      .map((c) => ({ market_ticker: c.market_ticker, ...c.earnings_posture_adjustment })),
    sports_history: prov?.sports_history ?? null,
    sports_game_context: prov?.sports_game_context ?? null,
    pmt_advisory_context: prov?.pmt_advisory_context ?? composites.find((c) => c?.pmt_advisory_context)?.pmt_advisory_context ?? null,
  } : null;

  // Preferred path: v2 customer renderer; raw inventory routed to a separate
  // audit artifact.
  const slate = buildMentionSlatePacket({
    date,
    event,
    composites,
    sourcePath: sourceUrl,
    inventoryPath,
    sourceHealthDisclosure,
    presentation,
    marketQuotes: marketQuotes ?? marketInfo.rows.map(({ raw }) => ({ ...raw, captured_at_utc: raw?.captured_at_utc ?? canonicalEvent.generated_utc })),
    generatedUtc: canonicalEvent.generated_utc,
  });
  if (slate) {
    if (researchProvenance) {
      slate.synthesisInput.research_provenance = {
        ...(slate.synthesisInput.research_provenance ?? {}),
        ...researchProvenance,
      };
    }
    return {
      text: slate.text,
      inventoryText: slate.inventoryText,
      rows: slate.rows,
      synthesisInput: slate.synthesisInput,
      researchProvenance,
      marketCount: marketInfo.marketCount,
      missingStrikeCount: marketInfo.missingStrikeCount,
      missingMarkets: marketInfo.missingMarkets,
      compositeSummary,
      attachmentContract,
      marketQuotes: slate.marketQuotes,
      counts: slate.counts,
      publication_blocked: !canonicalValidation.ok,
      publication_blocker: !canonicalValidation.ok ? {
        event_ticker: s.ticker,
        date,
        stage: 'publication_gate',
        blocker_code: BLOCKED_EVENT_METADATA_MISMATCH,
        reason: canonicalValidation.source_gaps.join('; '),
        source_gaps: canonicalValidation.source_gaps,
        event_time_status: canonicalEvent.event_time_central.status,
        event_time_iso: canonicalEvent.event_time_central.iso,
        event_time_source: canonicalEvent.event_time_central.source,
        delivered: false,
      } : null,
    };
  }

  // Fallback (no markets parsed): research-completeness note, no YAML wall.
  const process = buildMentionProcess({ event });
  const header = packetHeader({
    title: 'Captain Mentions — Daily Event Packet',
    date,
    packetType: PACKET_TYPE,
    sources: [sourceUrl, KALSHI_SOURCES.mentions.page_url],
  });
  const lines = [];
  lines.push('TLDR BOARD:');
  lines.push(`  no markets parsed for ${s.title}; nothing to score or rank.`);
  lines.push(`  decision_status: ${describeDecisionStatus(process.decisionStatus)}`);
  lines.push('');
  lines.push(renderDecisionProcess(process, { heading: 'Research Completeness' }));
  return {
    text: header + lines.join('\n') + packetFooter(),
    inventoryText: buildInventoryArtifact({ marketType: 'mentions', date, eventTicker: s.ticker, inventoryLines: [], meta: { mode: 'NO_MARKETS' } }),
    marketCount: marketInfo.marketCount,
    missingStrikeCount: marketInfo.missingStrikeCount,
    missingMarkets: marketInfo.missingMarkets,
    compositeSummary,
    attachmentContract,
    researchProvenance,
  };
}

function buildLegacyEventPacket({ date, event }) {
  const p = event.parsed || {};
  const composite = buildMentionCompositeForMarket({ legacy: p });
  const compositeSummary = summarizeCompositeRun([composite]);
  const process = buildMentionProcess({ event: null, hasLocalEvidence: Boolean((p.evidence || p.sources || []).length), legacy: p });
  const header = packetHeader({
    title: 'Captain Mentions — Daily Event Packet (legacy artifact)',
    date,
    packetType: PACKET_TYPE,
    sources: [event.file],
  });
  const lines = [];
  lines.push('TLDR:');
  lines.push(`  market_type: ${process.marketType}`);
  lines.push(`  decision_status: ${describeDecisionStatus(process.decisionStatus)}`);
  lines.push(`  composite_top_posture: ${compositeSummary.best_posture}`);
  lines.push(`  composite_top_score: ${compositeSummary.best_score === null ? 'MISSING' : compositeSummary.best_score}`);
  lines.push('  note: legacy artifact uses mention-composite only when evidence records are present.');
  lines.push('');
  lines.push(renderDecisionProcess(process, { heading: 'Research Completeness' }));
  lines.push('');
  lines.push(`event_id: ${p.event_id || p.id || 'MISSING'}`);
  lines.push(`target_phrase: ${p.target_phrase || p.phrase || 'MISSING'}`);
  lines.push(`speaker_or_company: ${p.speaker || p.company || p.entity || 'MISSING'}`);
  lines.push(`event_context: ${p.context || p.event_context || 'MISSING'}`);
  lines.push('');
  lines.push('resolution_mechanics:');
  lines.push(`  ${p.resolution || p.resolution_mechanics || 'MISSING'}`);
  lines.push('');
  lines.push('source_evidence:');
  const evidence = p.evidence || p.sources || [];
  if (Array.isArray(evidence) && evidence.length) {
    for (const e of evidence) lines.push(`  - ${typeof e === 'string' ? e : JSON.stringify(e)}`);
  } else {
    lines.push('  MISSING');
  }
  lines.push('');
  for (const l of renderCompositeEvidence([composite])) lines.push(l);
  lines.push('');
  lines.push(`verified_vs_inference: ${p.verified_vs_inference || 'MISSING'}`);
  lines.push(`decision_status: ${describeDecisionStatus(process.decisionStatus)}`);
  lines.push(`posture: ${compositeSummary.best_posture} (mention composite; research only, no trade)`);
  return header + lines.join('\n') + packetFooter();
}

function buildEmptyDayPacket(date, primeAttempts = [], discovery = null, mentionStats = null) {
  const process = evaluateDecisionProcess({
    marketType: MARKET_TYPES.MENTION_MARKET,
    rawDecision: 'PASS',
    checked: { x_chatter_separated: true },
    settlementRules: 'MISSING: no market/event packet.',
    verifiedFacts: 'MISSING: no mention-style events discovered.',
    marketSignalText: 'No price context captured.',
    socialChatter: 'Not used.',
    inference: 'No inference.',
    skepticReview: 'MISSING.',
    finalJudgment: 'PASS.',
  });

  const classificationNote = mentionStats
    ? `Language-based filtering scanned ${mentionStats.totalMarkets} market(s) across ${mentionStats.totalEvents} event(s); ${mentionStats.mentionMarkets} mention-style market(s) found, ${mentionStats.rejectedEvents} non-mention event(s) rejected.`
    : 'No mention classification stats available.';

  return (
    packetHeader({
      title: 'Captain Mentions — Daily Event Packet',
      date,
      packetType: PACKET_TYPE,
      sources: discovery?.source ? [discovery.source.api_url, discovery.source.page_url] : [],
    }) +
    [
      'TLDR:',
      `  market_type: ${process.marketType}`,
      `  decision_status: ${describeDecisionStatus(process.decisionStatus)}`,
      '  note: no mention-style events found; no rated view.',
      `  classification_note: ${classificationNote}`,
      '',
      renderDecisionProcess(process, { heading: 'Research Completeness' }),
      '',
      'research_prime:',
      ...(primeAttempts.length
        ? primeAttempts.flatMap(attempt => [
            `  - command: ${attempt.label}`,
            `    status: ${attempt.ok ? 'ok' : 'MISSING'}`,
            ...(attempt.ok ? [] : [`    error: ${attempt.error || attempt.stderr || 'command unavailable'}`]),
          ])
        : ['  - MISSING: no discovery command attempted']),
      '',
      'kalshi_discovery:',
      `  source_page: ${KALSHI_SOURCES.broad.page_url}`,
      `  source_api: ${KALSHI_SOURCES.broad.api_url}`,
      `  reachable: ${discovery?.ok ? 'yes' : 'no'}`,
      ...(discovery?.error ? [`  error: ${discovery.error}`] : []),
      ...(mentionStats ? [
        `  total_events_scanned: ${mentionStats.totalEvents}`,
        `  mention_events_found: ${mentionStats.mentionEvents}`,
        `  rejected_non_mention_events: ${mentionStats.rejectedEvents}`,
        `  total_markets_scanned: ${mentionStats.totalMarkets}`,
        `  mention_markets_found: ${mentionStats.mentionMarkets}`,
      ] : []),
      '',
      'status: MISSING',
      `reason: no Kalshi mention-style events found with derived event-date inside window [${date}, +${DEFAULT_WINDOW_DAYS}d].`,
      'posture: PASS (no data)',
    ].join('\n') +
    packetFooter()
  );
}

export function resolveMentionDiscoveryWorkflow(options = {}) {
  const commandPath = resolve('scripts', 'mentions', 'mentions-workspace.mjs');
  if (existsSync(commandPath)) {
    return {
      available: true,
      command: 'node',
      argsForDate: date => [commandPath, 'discover', '--date', date, '--live-readonly'],
      note: 'Detected scripts/mentions/mentions-workspace.mjs.',
    };
  }
  const alternatePath = resolve('scripts', 'mentions', 'discover.mjs');
  if (existsSync(alternatePath)) {
    return {
      available: true,
      command: 'node',
      argsForDate: date => [alternatePath, '--date', date, '--live-readonly'],
      note: 'Detected scripts/mentions/discover.mjs.',
    };
  }
  return {
    available: false,
    missing_interface:
      'No safe mention discovery CLI found. Expected one of: node scripts/mentions/mentions-workspace.mjs discover --date <date> --live-readonly; node scripts/mentions/discover.mjs --date <date> --live-readonly.',
  };
}

export function primeMentionResearch(date, options = {}) {
  const workflow = options.workflow ?? resolveMentionDiscoveryWorkflow();
  if (!workflow.available) {
    return [{ ok: false, skipped: true, label: 'mentions discovery workflow', status: null, stderr: workflow.missing_interface, error: workflow.missing_interface }];
  }
  return [runPacketCommand(workflow.command, workflow.argsForDate(date), { cwd: options.cwd ?? process.cwd(), runner: options.runner })];
}

export function primeMentionSourceResearch(date, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  return [
    runPacketCommand('node', ['scripts/mentions/collect-mentions-research.mjs', '--date', date], {
      cwd,
      runner: options.runner,
    }),
  ];
}

export function parseExtraArgs(argv) {
  // Lets caller pass mentions-specific flags without breaking parsePacketArgs.
  const passthrough = [];
  const extra = { allowUndated: false, windowDays: null, watchlist: false, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--allow-undated') extra.allowUndated = true;
    else if (a === '--window-days') { extra.windowDays = Number(argv[++i]); }
    else if (a === '--watchlist') extra.watchlist = true;
    else if (a === '--only') {
      extra.only = String(argv[++i] ?? '').split(',').map(s => s.trim()).filter(Boolean);
    }
    else passthrough.push(a);
  }
  if (!Number.isFinite(extra.windowDays)) {
    extra.windowDays = extra.watchlist ? WATCHLIST_WINDOW_DAYS : DEFAULT_WINDOW_DAYS;
  }
  // Any forward window beyond today is watchlist territory: its packets must
  // land in the watchlist dir so the cron sender can never deliver them.
  if (extra.windowDays > 0 || extra.allowUndated) extra.watchlist = true;
  return { passthrough, extra };
}

export async function gatherMentionEvents({
  stateRoot,
  date,
  // Library default stays the forward research window: direct callers gather
  // breadth for research/persistence. The CLI/cron path always passes its own
  // windowDays (today-only by default — see parseExtraArgs).
  windowDays = WATCHLIST_WINDOW_DAYS,
  allowUndated = false,
  env = process.env,
  deps = {},
} = {}) {
  const fetchKalshiEventsImpl = deps.fetchKalshiEvents || fetchKalshiEvents;
  const fetchMentionEventsBySeriesImpl = deps.fetchMentionEventsBySeries || fetchMentionEventsBySeries;
  const collectAlphaMentionIntakeImpl = deps.collectAlphaMentionIntake || collectAlphaMentionIntake;
  const filterMentionEventsImpl = deps.filterMentionEvents || filterMentionEvents;
  const primeMentionResearchImpl = deps.primeMentionResearch || primeMentionResearch;
  const primeMentionSourceResearchImpl = deps.primeMentionSourceResearch || primeMentionSourceResearch;
  const persistEventArtifactsImpl = deps.persistEventArtifacts || persistEventArtifacts;
  const consoleLog = deps.consoleLog || console.log;

  const primeAttempts = primeMentionResearchImpl(date);

  // 1. Explicit Alpha intake FIRST (manual_queue + env seeds), no fallback
  const alphaIntake = await collectAlphaMentionIntakeImpl({
    stateRoot,
    env,
    fallbackEvents: [],
  });
  const explicitIntakeEvents = alphaIntake.events || [];
  const hadExplicitIntake = (alphaIntake.summary.manual_queue_offered > 0) || (alphaIntake.summary.env_seeds_offered > 0);

  // 2. Broad + series discovery
  const discovery = await fetchKalshiEventsImpl('broad');
  const dateFilter = filterByEventDate(date, {
    windowDays,
    allowUndated,
  });
  const dateFilteredEvents = discovery.events.filter(dateFilter);

  const { mentionEvents: filteredEvents, stats: mentionStats } = filterMentionEventsImpl(dateFilteredEvents);

  const seriesDiscovery = await fetchMentionEventsBySeriesImpl();
  const seriesDateFiltered = seriesDiscovery.events.filter(dateFilter);
  const { mentionEvents: seriesMentionEvents, stats: seriesStats } = filterMentionEventsImpl(seriesDateFiltered);

  // Merge broad and series-scan results, deduplicating by event_ticker
  let allEvents = [...filteredEvents];
  const seenTickers = new Set(filteredEvents.map(e => e.event_ticker));
  for (const ev of seriesMentionEvents) {
    if (!seenTickers.has(ev.event_ticker)) {
      allEvents.push(ev);
      seenTickers.add(ev.event_ticker);
    }
  }

  // Combined stats for reporting (discovery-only, same semantics as before)
  const combinedStats = {
    totalEvents: mentionStats.totalEvents + seriesStats.totalEvents,
    mentionEvents: allEvents.length,
    rejectedEvents: mentionStats.rejectedEvents + seriesStats.rejectedEvents,
    totalMarkets: mentionStats.totalMarkets + seriesStats.totalMarkets,
    mentionMarkets: mentionStats.mentionMarkets + seriesStats.mentionMarkets,
    broadEvents: mentionStats.totalEvents,
    seriesEvents: seriesStats.totalEvents,
  };

  // 3. Fallback intake only when no explicit intake existed
  if (!hadExplicitIntake && !explicitIntakeEvents.length && allEvents.length > 0) {
    const fallbackIntake = await collectAlphaMentionIntakeImpl({
      stateRoot,
      env,
      fallbackEvents: allEvents,
    });
    if (fallbackIntake.events.length) {
      for (const ev of fallbackIntake.events) {
        const ticker = ev?.event_ticker;
        if (!ticker || seenTickers.has(ticker)) continue;
        seenTickers.add(ticker);
        allEvents.push(ev);
      }
    }
    if (fallbackIntake.summary.fallback_used) {
      consoleLog(`[mentions-alpha-intake] ${formatAlphaIntakeSummary(fallbackIntake.summary)}`);
    }
  }

  // 4. Merge explicit intake events into allEvents (deduped)
  if (explicitIntakeEvents.length) {
    for (const ev of explicitIntakeEvents) {
      const ticker = ev?.event_ticker;
      if (!ticker || seenTickers.has(ticker)) continue;
      seenTickers.add(ticker);
      allEvents.push(ev);
    }
  }
  if (
    alphaIntake.summary.accepted > 0 ||
    alphaIntake.summary.manual_queue_consumed > 0 ||
    alphaIntake.summary.env_seeds_consumed > 0
  ) {
    consoleLog(`[mentions-alpha-intake] ${formatAlphaIntakeSummary(alphaIntake.summary)}`);
  }

  let persistedCount = 0;
  if (allEvents.length) {
    const persisted = persistEventArtifactsImpl({
      stateRoot,
      sport: 'mentions',
      date,
      events: allEvents,
    });
    persistedCount = persisted.written.length;
  }

  const researchPrimeAttempts = allEvents.length ? primeMentionSourceResearchImpl(date) : [];
  const allPrimeAttempts = [...primeAttempts, ...researchPrimeAttempts];

  return {
    allEvents,
    combinedStats,
    discovery,
    dateFilteredEvents,
    persistedCount,
    allPrimeAttempts,
    seenTickers,
  };
}

// Per-event Kalshi packet loop, extracted from main() so the blocker path is
// directly testable. A synthesis failure for one event writes a blocker
// artifact, lands the ticker in failedTickers, and never throws — only
// infrastructure errors (fs, discovery) propagate to the caller.
export async function writeKalshiEventPackets({
  events,
  date,
  stateRoot,
  dir,
  audit,
  dryRun = false,
  allPrimeAttempts = [],
  synthesizeImpl = composeMentionPacketDeterministic,
  runStartedAtUtc = null,
  fetchImpl = fetch,
}) {
  let totalMarketCount = 0;
  let missingMarketEventCount = 0;
  let missingStrikeTextCount = 0;
  const items = [];
  const failedTickers = [];
  const seen = new Set();
  const researchMap = loadResearchForDate(stateRoot, date, { runStartedAtUtc });
  // Settled-history records (price-free, outcomes only) load once per run and
  // feed historical_tendency BEFORE any model extraction. Preserve loader
  // status so a missing/corrupt store cannot masquerade as verified absence.
  const historyLoad = await loadHistoryWithStatus({ stateRoot });
  const historyRecords = historyLoad.records;
  const sourceHealthDisclosure = detectSourceHealthDisclosure({
    stateRoot,
    date,
    packetType: PACKET_TYPE,
  }).disclosureLine;
  let earningsFamilyHistory = null;
  let earningsFamilyHistoryFetched = false;
  for (const ev of events) {
    const ticker = ev?.event_ticker;
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    const researchEntry = researchMap.get(ticker);
    const staleResearch = researchMap._staleTickers?.has(ticker) ?? false;
    const mergedEvent = mergeResearchIntoEvent(ev, researchEntry, { staleResearch });
    const sourcePath = resolve(stateRoot, 'mentions', date, 'kalshi-events', `${ticker.replace(/[^A-Z0-9_-]/gi, '_').slice(0, 80)}.json`);
    const inventoryName = `${date}-${ticker}.inventory`;
    const inventoryPath = `${inventoryName}.txt`;
    // Phase 2 earnings alpha inputs: quarter history cache + declared context
    // sources load from local state only (no crawling), earnings_call routes only.
    let earningsQuarters = null;
    let earningsContextSources = null;
    const evRoute = resolveResearchRoute(routeEventLike({ event: mergedEvent }));
    if (evRoute?.route === 'earnings_call') {
      if (!earningsFamilyHistoryFetched) {
        earningsFamilyHistoryFetched = true;
        try {
          earningsFamilyHistory = await fetchEarningsFamilyHistory({ stateRoot, fetchImpl });
        } catch (err) {
          earningsFamilyHistory = {
            scan_ok: false,
            series_scanned: 0,
            series_with_history: 0,
            settled_markets: 0,
            by_word: {},
            updated_utc: new Date().toISOString(),
            error: err?.message ?? String(err),
          };
        }
      }
      const family = resolveEarningsFamily(mergedEvent);
      if (family?.ticker) {
        earningsQuarters = await loadEarningsHistory({ ticker: family.ticker, stateRoot });
        earningsContextSources = readJsonIfExists(
          resolve(stateRoot, 'mentions', 'earnings-context', `${family.ticker}.json`),
        );
      }
    }
    let built;
    try {
      built = buildKalshiEventPacket({
        date,
        event: mergedEvent,
        sourceUrl: sourcePath,
        inventoryPath,
        historyRecords,
        historyStoreStatus: historyLoad.status,
        earningsQuarters,
        earningsContextSources,
        earningsFamilyHistory,
        sourceHealthDisclosure,
        generatedUtc: runStartedAtUtc ?? new Date().toISOString(),
        researchTimestamp: mergedEvent?.research_timestamp ?? mergedEvent?.researched_at_utc ?? null,
        researchEntry,
      });
    } catch (err) {
      const blockerDir = resolve(stateRoot, 'mentions', date, 'blockers');
      mkdirSync(blockerDir, { recursive: true });
      const blockerPath = resolve(blockerDir, `${date}-${ticker}.json`);
      writeFileSync(blockerPath, JSON.stringify({
        event_ticker: ticker,
        date,
        stage: 'publication_gate',
        reason: 'PACKET_INTEGRITY_VALIDATION_FAILED',
        error: err?.message ?? String(err),
        blocked_at_utc: new Date().toISOString(),
        delivered: false,
      }, null, 2));
      console.error(`[${PACKET_TYPE}] BLOCKED ${ticker}: ${err?.message ?? String(err)} (blocker: ${blockerPath})`);
      failedTickers.push(ticker);
      continue;
    }
    totalMarketCount += built.marketCount;
    if (built.missingMarkets) missingMarketEventCount += 1;
    missingStrikeTextCount += built.missingStrikeCount;

    if (built.blocked) {
      const blockerDir = resolve(stateRoot, 'mentions', date, 'blockers');
      mkdirSync(blockerDir, { recursive: true });
      const blockerPath = resolve(blockerDir, `${date}-${ticker}.json`);
      writeFileSync(blockerPath, JSON.stringify({
        ...built.blocker,
        event_ticker: ticker,
        date,
        stage: 'event_metadata',
        delivered: false,
      }, null, 2));
      console.error(`[${PACKET_TYPE}] BLOCKED ${ticker}: ${built.blocker?.reason || 'event metadata mismatch'} (blocker: ${blockerPath})`);
      failedTickers.push(ticker);
      continue;
    }

    // EVENT-LEVEL FAIL-CLOSED gate: if every decision row is BLOCKED (no usable
    // source evidence anywhere on the board — the NO_DECLARED_SOURCES /
    // no-live-research case), this event has no customer-deliverable research.
    // Write a source-research blocker artifact and skip the .txt entirely, the
    // same isolation the model-synthesis blocker path uses. A normal board
    // (real WATCH/LEAN/PICK rows alongside the EDNQ blocked row) is unaffected.
    const counts = built.counts ?? null;
    if (built.publication_blocked) {
      const blockerDir = resolve(stateRoot, 'mentions', date, 'blockers');
      mkdirSync(blockerDir, { recursive: true });
      const blockerPath = resolve(blockerDir, `${date}-${ticker}.json`);
      writeFileSync(blockerPath, JSON.stringify({
        ...(built.publication_blocker ?? {}),
        event_ticker: ticker,
        date,
        stage: 'publication_gate',
        delivered: false,
      }, null, 2));
      console.error(`[${PACKET_TYPE}] BLOCKED ${ticker}: canonical publication gate failed (blocker: ${blockerPath})`);
      failedTickers.push(ticker);
      if (built.inventoryText) {
        const invW = audit(dir, inventoryName, built.inventoryText, {
          kind: 'raw_inventory_audit',
          event_ticker: ticker,
          fail_closed: true,
        });
        items.push({ name: inventoryName, ...invW });
      }
      continue;
    }
    // A zero-evidence board (every row honestly shows a research gap) is not
    // an identity risk, malformed output, a duplicate, or a price leak — per
    // product rule it degrades the packet, it does not suppress it. Record
    // it for observability, then continue to the normal render+write path
    // below: the renderer already produces an honest, fully-structured
    // "RESEARCH GAP — 0/N" packet for exactly this case.
    const allRowsBlocked = counts && counts.total > 0 && counts.blocked >= counts.total;
    if (allRowsBlocked) {
      const blockerDir = resolve(stateRoot, 'mentions', date, 'blockers');
      mkdirSync(blockerDir, { recursive: true });
      const blockerPath = resolve(blockerDir, `${date}-${ticker}.degraded.json`);
      const evSourceStatus = mergedEvent?.markets?.find?.((m) => m?.source_status)?.source_status
        ?? researchEntry?.source_status ?? null;
      writeFileSync(blockerPath, JSON.stringify({
        event_ticker: ticker,
        date,
        stage: 'source_research',
        reason: isNoResearchSourceStatus(evSourceStatus) ? 'NO_USABLE_SOURCES' : 'SOURCE_RESEARCH_MISSING',
        source_status: evSourceStatus,
        rows_total: counts.total,
        rows_blocked: counts.blocked,
        note: `no usable source-backed evidence for any market on ${ticker} (source_status=${evSourceStatus}); rendering DEGRADED instead of suppressing`,
        degraded_at_utc: new Date().toISOString(),
      }, null, 2));
      console.error(`[${PACKET_TYPE}] DEGRADED ${ticker}: no usable source evidence on any row (source_status=${evSourceStatus}); rendering honest research-gap packet instead of suppressing`);
    }

    // Raw per-contract inventory -> audit artifact only (never the packet body).
    if (built.inventoryText) {
      const invW = audit(dir, inventoryName, built.inventoryText, {
        kind: 'raw_inventory_audit',
        event_ticker: ticker,
      });
      items.push({ name: inventoryName, ...invW });
    }
    let packetText = built.text;
    if (sourceHealthDisclosure && !packetText.includes(sourceHealthDisclosure)) {
      packetText = injectSourceHealthDisclosure(packetText, sourceHealthDisclosure);
    }
    let modelSynthesisInvocation = null;
    if (!dryRun) {
      try {
        const synthesized = await synthesizeImpl({
          input: built.synthesisInput,
          marketQuotes: built.marketQuotes ?? [],
        });
        if (synthesized?.invocation?.renderer !== CUSTOMER_RENDERER_ID) {
          throw new Error('customer mentions packet compose did not return renderMentionPacket/v2 contract');
        }
        validateRenderedPacket(synthesized.text, built.synthesisInput);
        packetText = synthesized.text;
        modelSynthesisInvocation = synthesized.invocation;
      } catch (err) {
        // Per-event isolation: one bad model packet must not abort the rest.
        // No .txt is written for this event (nothing deliverable), a blocker
        // artifact is recorded outside the packet dir, and we continue.
        const blockerDir = resolve(stateRoot, 'mentions', date, 'blockers');
        mkdirSync(blockerDir, { recursive: true });
        const blockerPath = resolve(blockerDir, `${date}-${ticker}.json`);
        writeFileSync(blockerPath, JSON.stringify({
          event_ticker: ticker,
          date,
          stage: 'model_synthesis',
          error: err.message,
          blocked_at_utc: new Date().toISOString(),
          delivered: false,
        }, null, 2));
        console.error(`[${PACKET_TYPE}] BLOCKED ${ticker}: ${err.message} (blocker: ${blockerPath})`);
        failedTickers.push(ticker);
        continue;
      }
    }
    const attachmentContract = built.attachmentContract ?? buildMentionAttachmentContract([]);
    const w = audit(dir, `${date}-${ticker}`, packetText, {
      event_ticker: ticker,
      market_count: built.marketCount,
      missing_markets: built.missingMarkets,
      missing_strike_text_count: built.missingStrikeCount,
      composite_scored_count: built.compositeSummary.scored_count,
      composite_source_backed_count: built.compositeSummary.source_backed_count,
      composite_proximity_only_count: built.compositeSummary.proximity_only_count,
      composite_best_posture: built.compositeSummary.best_posture,
      composite_best_score: built.compositeSummary.best_score,
      composite_pricing_excluded: built.compositeSummary.pricing_excluded,
      research_route: built.researchProvenance?.research_route ?? null,
      history_match_tier: built.researchProvenance?.history_match_tier ?? null,
      history_sample_size: built.researchProvenance?.history_sample_size ?? null,
      history_hit_rate: built.researchProvenance?.history_hit_rate ?? null,
      last_four_quarter_hit_rate: built.researchProvenance?.last_four_quarter_hit_rate ?? null,
      earnings_quarters_considered: built.researchProvenance?.earnings_quarters_considered ?? null,
      earnings_context_delta: built.researchProvenance?.earnings_context_delta ?? null,
      earnings_posture_adjustments: built.researchProvenance?.earnings_posture_adjustments ?? null,
      render_mode: 'deterministic_code_renderer_v2',
      renderer_contract: CUSTOMER_RENDERER_ID,
      model_synthesis_required: false,
      model_synthesis_invocation: modelSynthesisInvocation ?? 'skipped_in_dry_run',
      research_attachment_contract: attachmentContract,
      telegram_delivery_mode: 'document_txt',
      kalshi_source_api: KALSHI_SOURCES.broad.api_url,
      kalshi_source_page: KALSHI_SOURCES.broad.page_url,
      research_prime: allPrimeAttempts.map(({ label, ok, status, stderr, error, skipped }) => ({ label, ok, status, stderr, error, skipped })),
    }, { writeChunks: false });
    items.push({
      name: ticker,
      ...w,
      previewText: dryRun ? packetText : null,
      attachmentContract,
    });
  }
  return { items, failedTickers, totalMarketCount, missingMarketEventCount, missingStrikeTextCount };
}

async function main() {
  const runStartedAtUtc = new Date().toISOString();
  const { passthrough, extra } = parseExtraArgs(process.argv.slice(2));
  const opts = parsePacketArgs(passthrough);
  if (opts.help) {
    console.log('Usage: node scripts/packets/generate-mentions-daily.mjs --date YYYY-MM-DD [--dry-run] [--only TICKER1,TICKER2] [--watchlist] [--window-days N] [--allow-undated]');
    console.log('  Default is today-only (window 0). --watchlist (or any --window-days > 0 /');
    console.log(`  --allow-undated) scans the forward window and writes to ${WATCHLIST_PACKET_TYPE}/,`);
    console.log('  which the cron sender never delivers from.');
    return;
  }
  const packetType = extra.watchlist ? WATCHLIST_PACKET_TYPE : PACKET_TYPE;
  // Dry-run must leave NO artifacts in the packet dir: anything written there
  // is deliverable by the sender on its next pass.
  const dir = opts.dryRun
    ? resolve(opts.stateRoot, 'packets', opts.date, packetType)
    : ensurePacketDir(opts.stateRoot, opts.date, packetType);
  const audit = opts.dryRun ? previewAudit : writeAudit;

  let allEvents;
  let combinedStats;
  let discovery;
  let dateFilteredEvents;
  let persistedCount;
  let allPrimeAttempts;
  let localOnlyLoad = null;

  if (extra.only?.length) {
    const onlyResolution = await resolveOnlyMentionEvents({
      stateRoot: opts.stateRoot,
      date: opts.date,
      tickers: extra.only,
      windowDays: extra.windowDays,
      allowUndated: extra.allowUndated,
      runStartedAtUtc,
    });
    localOnlyLoad = onlyResolution.localOnlyLoad;
    allEvents = onlyResolution.allEvents;
    combinedStats = onlyResolution.combinedStats;
    discovery = onlyResolution.discovery;
    dateFilteredEvents = onlyResolution.dateFilteredEvents;
    persistedCount = onlyResolution.persistedCount;
    allPrimeAttempts = onlyResolution.allPrimeAttempts;

    if (onlyResolution.mode === 'fast-path') {
      console.log(`[${PACKET_TYPE}] --only local artifact fast path loaded ${localOnlyLoad.loaded.length}/${extra.only.length}: ${localOnlyLoad.loaded.map((x) => `${x.ticker}@${x.root}`).join(', ')}`);
    } else {
      console.log(`[${PACKET_TYPE}] --only local artifacts missing; gathered and reloaded ${onlyResolution.loadedAfterGather.length}/${extra.only.length}: ${onlyResolution.loadedAfterGather.map((x) => `${x.ticker}@${x.root}`).join(', ')}`);
      if (onlyResolution.missingAfterGather.length) {
        console.error(`[${PACKET_TYPE}] --only still missing after gather: ${onlyResolution.missingAfterGather.join(', ')} (fail closed)`);
      }
    }
  } else {
    ({
      allEvents,
      combinedStats,
      discovery,
      dateFilteredEvents,
      persistedCount,
      allPrimeAttempts,
    } = await gatherMentionEvents({
      stateRoot: opts.stateRoot,
      date: opts.date,
      windowDays: extra.windowDays,
      allowUndated: extra.allowUndated,
    }));
  }

  let localEvents = discoverMentionEvents(opts.stateRoot, opts.date);
  let events = allEvents;

  // Today-only guard for the normal (non-watchlist) path. Discovery already
  // window-filters, but Alpha/manual-queue intake merges in unfiltered — those
  // events stay persisted as research/state, they just don't get a packet (or
  // a send) until their event date arrives.
  if (!extra.watchlist) {
    // Dry-run --only previews may target a local artifact that has no derived
    // event date yet. Keep that previewable without widening normal runs.
    const todayGuard = filterByEventDate(opts.date, {
      windowDays: extra.windowDays,
      allowUndated: opts.dryRun && Boolean(extra.only),
    });
    const deferred = events.filter((ev) => !todayGuard(ev));
    if (deferred.length) {
      console.log(`[${PACKET_TYPE}] deferred ${deferred.length} non-today event(s): ${deferred.map(e => e.event_ticker).join(', ')} (watchlist scope — no packet on the cron path)`);
    }
    events = events.filter(todayGuard);
  }

  if (extra.only) {
    const wanted = new Set(extra.only);
    events = events.filter((ev) => wanted.has(ev.event_ticker));
    localEvents = localEvents.filter((ev) => wanted.has(String(ev.parsed?.event_id || ev.name)));
  }

  let totalMarketCount = 0;
  let missingMarketEventCount = 0;
  let missingStrikeTextCount = 0;
  const items = [];
  const failedTickers = [];

  if (extra.only && !localEvents.length && !events.length) {
    // Incremental caller asked for specific tickers that aren't present —
    // nothing to write, and emitting a no-events packet here would trick the
    // sender into a spurious status message.
    console.log(`[${PACKET_TYPE}] --only matched no events for ${opts.date} — nothing written.`);
    return;
  }

  if (!localEvents.length && !events.length) {
    const txt = buildEmptyDayPacket(opts.date, allPrimeAttempts, discovery, combinedStats);
    const w = audit(dir, `${opts.date}-no-events`, txt, {
      event_count: 0,
      total_market_count: 0,
      missing_market_count: 0,
      missing_strike_text_count: 0,
      window_days: extra.windowDays,
      allow_undated: extra.allowUndated,
      kalshi_discovery: { ok: discovery.ok, error: discovery.error, total_returned: discovery.events.length, window_matched: dateFilteredEvents.length, mention_events: combinedStats.mentionEvents, rejected_events: combinedStats.rejectedEvents, total_markets_scanned: combinedStats.totalMarkets, mention_markets: combinedStats.mentionMarkets, broad_events: combinedStats.broadEvents, series_events: combinedStats.seriesEvents },
      research_prime: allPrimeAttempts.map(({ label, ok, status, stderr, error, skipped }) => ({ label, ok, status, stderr, error, skipped })),
    });
    items.push({ name: 'no-events', ...w });
  } else {
    const kalshiResult = await writeKalshiEventPackets({
      events,
      date: opts.date,
      stateRoot: opts.stateRoot,
      dir,
      audit,
      dryRun: opts.dryRun,
      allPrimeAttempts,
      runStartedAtUtc,
    });
    totalMarketCount += kalshiResult.totalMarketCount;
    missingMarketEventCount += kalshiResult.missingMarketEventCount;
    missingStrikeTextCount += kalshiResult.missingStrikeTextCount;
    items.push(...kalshiResult.items);
    failedTickers.push(...kalshiResult.failedTickers);
    for (const ev of localEvents) {
      const label = (ev.parsed?.event_id || ev.name).toString();
      console.log(`[${PACKET_TYPE}] skipped legacy local artifact ${label}: old local renderer is internal-only; customer packets require Kalshi event + renderMentionPacket/v2`);
    }
  }

  const eventCount = events.length + localEvents.length;
  // Guard: event_count > 0 but total_market_count === 0 -> fail (Kalshi side only).
  let exitCode = 0;
  if (events.length > 0 && totalMarketCount === 0) {
    console.error(`[${PACKET_TYPE}] FAIL: ${events.length} Kalshi events but zero markets across all of them.`);
    exitCode = 2;
  }

  console.log(printDryRunSummary({ packetType, date: opts.date, dir, items }));
  if (opts.dryRun && extra.only) {
    for (const item of items) {
      if (!item.previewText) continue;
      console.log(`[dry-run] preview_begin ${item.name}`);
      console.log(item.previewText);
      console.log(`[dry-run] preview_end ${item.name}`);
    }
  }
  console.log(`[${PACKET_TYPE}] summary event_count=${eventCount} kalshi_window_matched=${dateFilteredEvents.length} mention_events=${combinedStats.mentionEvents} rejected_events=${combinedStats.rejectedEvents} total_markets_scanned=${combinedStats.totalMarkets} mention_markets=${combinedStats.mentionMarkets} total_market_count=${totalMarketCount} packets_written=${items.length} missing_market_count=${missingMarketEventCount} missing_strike_text_count=${missingStrikeTextCount} persisted=${persistedCount} window_days=${extra.windowDays} watchlist=${extra.watchlist} only=${extra.only ? extra.only.join(',') : 'none'} allow_undated=${extra.allowUndated} synthesis_blocked=${failedTickers.length ? failedTickers.join(',') : 'none'}`);
  if (exitCode) process.exit(exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`[${PACKET_TYPE}] error: ${err.message}`);
    process.exit(1);
  });
}
