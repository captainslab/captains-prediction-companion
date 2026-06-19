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
  summarizeEvent,
  normalizeMarket,
  KALSHI_SOURCES,
  filterMentionEvents,
  fetchMentionEventsBySeries,
} from './lib/kalshi-discovery.mjs';
import { evaluateDecisionProcess, MARKET_TYPES, renderDecisionProcess } from '../shared/decision-process.mjs';
import { composeMentionLedger } from '../mentions/mention-composite-core.mjs';
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
  buildDecisionRow,
  buildInventoryArtifact,
  EDGE_STATUS,
  CONFIDENCE,
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
  renderMentionPacket,
  validateRenderedPacket,
  shortTerm,
  CUSTOMER_RENDERER_ID,
} from '../mentions/render-mention-packet.mjs';
import { resolveResearchRoute } from '../mentions/mention-route-resolver.mjs';
import { gateMentionMarket } from '../mentions/lexical-gate.mjs';
import {
  loadHistory,
  buildHistoryMatch,
  historyToLayerScore,
} from '../mentions/settled-history.mjs';
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

function dollarsToCents(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function numericOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function marketContextFromMarket(market = {}) {
  const yesBid = dollarsToCents(market.yes_bid_dollars);
  const yesAsk = dollarsToCents(market.yes_ask_dollars);
  const noBid = dollarsToCents(market.no_bid_dollars);
  const noAsk = dollarsToCents(market.no_ask_dollars);
  const last = dollarsToCents(market.last_price_dollars);
  const spread = yesBid !== null && yesAsk !== null ? yesAsk - yesBid : null;
  return {
    yes_bid_cents: yesBid,
    yes_ask_cents: yesAsk,
    no_bid_cents: noBid,
    no_ask_cents: noAsk,
    last_trade_price_cents: last,
    spread_cents: spread,
    volume: numericOrNull(market.volume_fp),
    open_interest: numericOrNull(market.open_interest_fp),
  };
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
    const capNote = String(hint.reason ?? '').includes(CAPPED_MAX_POSTURE)
      ? hint.reason
      : `${hint.reason} (capped at ${CAPPED_MAX_POSTURE})`;
    return { posture: capped, applied: capped !== posture, reason: capNote };
  }
  return { posture: bumped, applied: bumped !== posture, reason: hint.reason };
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

export function buildMentionCompositeForMarket({ event = null, market = null, legacy = null, historyRecords = null, earningsQuarterLayer = null, earningsContextDelta = null, sportsSettledResult = null, sportsGameContextResult = null, candidateText = null } = {}) {
  const profileResolution = resolveMentionProfile({ event, market, legacy });
  const route = profileResolution.route ?? null;
  const profileConfig = PROFILE_REGISTRY[profileResolution.profile];
  const targetMention = market ? targetMentionFromMarket(market) : (
    asText(legacy?.target_phrase) ||
    asText(legacy?.phrase) ||
    asText(legacy?.keyword) ||
    'MISSING'
  );

  // ---- Lexical pre-evidence gate (HARD) --------------------------------------
  // The literal lexical engine decides whether this market is even valid before
  // ANY evidence layer is built or any composite/posture is produced. Hard
  // blocks (BLOCKED_RULES_UNCLEAR / OUT_OF_SCOPE_ROLLING) short-circuit here and
  // never reach scoring or rendering. An evaluated NO_MATCH suppresses
  // conviction downstream. MATCH / PENDING proceed to the layer build below.
  const lexicalGate = gateMentionMarket({ event, market, legacy, candidateText });
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
  let historyMatch = null;
  if (route && Array.isArray(historyRecords) && historyRecords.length) {
    historyMatch = buildHistoryMatch({
      records: historyRecords,
      route: route.route,
      entity: route.entity,
      horizon: route.horizon,
      seriesTicker: event?.series_ticker ?? null,
    });
    const historyLayer = historyToLayerScore(historyMatch);
    if (historyLayer.present && !(layerRecords?.historical_tendency?.present)) {
      layerRecords = { ...(layerRecords ?? {}), historical_tendency: historyLayer };
    }
  }
  const result = composeMentionLedger({
    event: eventNameForComposite(event ?? {}, legacy),
    targetMention,
    profile: profileResolution.profile,
    layerDefs: profileConfig.layerDefs,
    layerRecords,
    marketContext: market ? marketContextFromMarket(market) : (legacy?.market_context ?? legacy?.marketContext ?? null),
  });

  // Lexical NO_MATCH suppression: an evaluated literal NO_MATCH means the target
  // did not literally occur in the evidence text, so downstream may NOT invent
  // conviction from context. Force the composite back to NO_CLEAR_PICK with no
  // score/confidence before any source-ladder upgrade can run.
  if (lexicalGate.suppress_conviction) {
    result.posture = 'NO_CLEAR_PICK';
    result.composite_score = null;
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
    profile_basis: profileResolution.basis,
    research_route: route?.route ?? null,
    route_basis: route?.basis ?? null,
    route_entity: route?.entity ?? null,
    route_horizon: route?.horizon ?? null,
    history_match_tier: historyMatch?.match_tier ?? null,
    history_sample_size: historyMatch?.sample_size ?? null,
    history_hits: historyMatch?.hits ?? null,
    history_misses: historyMatch?.misses ?? null,
    history_hit_rate: historyMatch?.hit_rate ?? null,
    history_match_quality_penalty: historyMatch?.match_quality_penalty ?? null,
    history_source_tickers: historyMatch?.source_tickers ?? null,
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
    source_ladder: ladder,
    posture_final: postureFinal,
    posture_cap_reason: postureCap,
    research_quality: market?.research_quality ?? legacy?.research_quality ?? null,
    lexical_gate: lexicalGate,
  };
}

// Hard-blocked composite result for a market the lexical pre-evidence gate
// rejected (BLOCKED_RULES_UNCLEAR / OUT_OF_SCOPE_ROLLING). No evidence layers
// are built and composeMentionLedger is never called — the market can never
// surface a soft verdict (WATCH/LEAN/etc.) or any score/confidence. The shape
// mirrors the normal return so downstream rank/summary/render code is unchanged.
function blockedMentionComposite({ event, market, legacy, targetMention, profileResolution, route, lexicalGate }) {
  const decision = lexicalGate.lexical_result?.status === 'BLOCKED' ? lexicalGate.decision : 'BLOCK';
  const blockReasons = Array.isArray(lexicalGate.lexical_result?.block_reasons)
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
    market_context: null,
    evidence_ledger: [],
    reasoning_summary: `NO_CLEAR_PICK — lexical gate ${decision} (${blockReasons.join(', ') || 'rules unclear'}); market blocked before scoring.`,
    lexical_blocked: true,
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
    source_ladder: null,
    posture_final: 'NO_CLEAR_PICK',
    posture_cap_reason: `lexical_gate:${decision}`,
    research_quality: market?.research_quality ?? legacy?.research_quality ?? null,
    lexical_gate: lexicalGate,
  };
}

function bestComposite(composites) {
  const ranked = composites
    .filter(c => c?.result)
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
  const best = bestComposite(composites);
  return {
    market_count: composites.length,
    scored_count: composites.filter(c => c?.result?.composite_score !== null).length,
    source_backed_count: composites.filter(hasBeyondProximityEvidence).length,
    proximity_only_count: composites.filter(isProximityOnlyComposite).length,
    best_posture: best?.result?.posture ?? 'NO_CLEAR_PICK',
    best_score: best?.result?.composite_score ?? null,
    best_target: best?.result?.target_mention ?? null,
    pricing_excluded: true,
  };
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
 * Convert one mention composite (model) + its market context into a shared
 * decision row. Market price lives only in the `market` half and never enters
 * the composite score.
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
  const mc = r.market_context ?? {};

  // market half (cents from composite core; buildDecisionRow treats >1.5 as cents)
  const market = {
    yes_bid: mc.yes_bid_cents ?? null,
    yes_ask: mc.yes_ask_cents ?? null,
    last_price: mc.last_trade_price_cents ?? null,
    volume: mc.volume ?? null,
    open_interest: mc.open_interest ?? null,
    price_units: 'cents',
  };

  const missingCats = Array.isArray(r.missing_layers) ? r.missing_layers.map((l) => l.category) : [];
  const topLayers = Array.isArray(r.top_supporting_layers) ? r.top_supporting_layers.map((l) => l.category) : [];
  const presentCats = Array.isArray(r.evidence_ledger)
    ? r.evidence_ledger.filter((l) => l.present).map((l) => l.category)
    : topLayers;
  const target = r.target_mention ?? composite?.market_ticker ?? 'MISSING';

  // No source-backed evidence at all -> BLOCKED on the missing source layers.
  const sourceBlocked = layersPresent === 0;
  const proximityOnly = layersPresent === 1 && presentCats.length === 1 && presentCats[0] === 'event_proximity';
  let postureFinal = composite?.posture_final ?? r.posture ?? 'NO_CLEAR_PICK';

  // Stub cap: never allow LEAN/EVIDENCE_LEAN/PICK from stub-only research
  const isStub = (meta.research_quality === 'stub' || composite?.research_quality === 'stub');
  if (isStub && POSTURE_RANK[postureFinal] > POSTURE_RANK.WATCH) {
    postureFinal = 'WATCH';
  }

  let statusOverride;
  let blocker = null;
  let analysis;
  let trigger;

  if (sourceBlocked) {
    statusOverride = EDGE_STATUS.BLOCKED;
    blocker = `BLOCKED_SOURCE_LAYER_MISSING: no source-backed evidence layers for "${target}"`;
    analysis = `Market priced; mention composite has 0/${layersTotal} source layers. Not a pick or a pass — research gap. Missing: ${missingCats.join(', ') || 'all source layers'}.`;
    trigger = {
      price: null,
        event: `run mentions research for "${target}" (transcripts > quotes > context > prompt source ladder), then re-score`,
    };
  } else if (proximityOnly) {
    postureFinal = 'WATCH';
    statusOverride = EDGE_STATUS.WATCH;
    analysis = `LOW-SOURCE WATCH only -- no pick. Event timing exists, but transcript/history/topic/source layers are missing for "${target}". Missing: ${missingCats.join(', ') || 'source research layers'}.`;
    trigger = {
      price: null,
      event: 'upgrade only after exact-source research adds transcript, direct quote, historical tendency, or topic-path evidence',
    };
  } else {
    statusOverride = MENTION_POSTURE_TO_EDGE[postureFinal] ?? EDGE_STATUS.WATCH;
    const capNote = composite?.posture_cap_reason ? ` (ladder cap: ${composite.posture_cap_reason})` : '';
    analysis = `${r.reasoning_summary ?? `composite ${r.composite_score ?? 'n/a'} [${postureFinal}]`}${capNote}`;
    trigger = {
      price: null,
      event: postureFinal === 'PICK' || postureFinal === 'EVIDENCE_LEAN'
        ? 'confirm exact settlement wording + official event source, then enter on value'
        : 'await stronger source layer (transcript/quote confirmation)',
    };
  }

  return buildDecisionRow({
    marketTicker: composite?.market_ticker ?? 'MISSING',
    sideTarget: target,
    marketType: `mention_${r.profile ?? 'unknown'}`,
    settlementSummary: 'Exact-string mention settlement per Kalshi listing — verify wording before acting.',
    composite: {
      score: r.composite_score ?? null,
      posture: postureFinal,
      layersPresent,
      layersTotal,
      topEvidenceLayers: topLayers,
      missingLayers: missingCats,
      // composite_score is conviction, NOT a probability -> no modelProbability.
    },
    market,
    confidence: layersPresent >= Math.ceil(layersTotal * 0.5) && layersTotal > 0
      ? CONFIDENCE.MEDIUM
      : CONFIDENCE.LOW,
    analysis,
    trigger,
    statusOverride,
    blocker,
  });
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
        lines.push(`      posture_adjustment: ${adj.direction} ${adj.from} -> ${adj.to} (${adj.reason})`);
      }
    }
  }
  return lines.join('\n');
}

export function buildMentionSlatePacket({ date, event, composites, sourcePath = null, inventoryPath = null }) {
  if (!Array.isArray(composites) || !composites.length) return null;
  const s = summarizeEvent(event);
  const rows = composites.map((c) => mentionCompositeToDecisionRow(c));
  const summary = summarizeCompositeRun(composites);

  const blockedCount = rows.filter((r) => r.edge_status === EDGE_STATUS.BLOCKED).length;
  const prov = composites[0] ?? null;
  const provenanceLines = [];
  if (prov?.research_route) {
    provenanceLines.push(`research_route: ${prov.research_route}${prov.route_horizon ? ` (horizon=${prov.route_horizon})` : ''} | settled_history: tier=${prov.history_match_tier ?? 'none'} n=${prov.history_sample_size ?? 0} hits=${prov.history_hits ?? 0} misses=${prov.history_misses ?? 0} hit_rate=${prov.history_hit_rate == null ? 'n/a' : prov.history_hit_rate.toFixed(2)}`);
  }
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
  });
  const text = renderMentionPacket(synthesisInput, {
    generatedAtUtc: new Date().toISOString(),
    analystTier: 'none',
  });
  validateRenderedPacket(text, synthesisInput);

  // Raw per-contract inventory + market context -> audit artifact only.
  const inventoryLines = rows.map((r, i) =>
    `#${i + 1} [${r.edge_status}] ${r.market_ticker} :: ${r.side_target} | score=${r.composite_score} posture=${r.composite_posture} layers=${r.layers_present} implied=${r.implied_probability} ask=${r.market_yes_ask} bid=${r.market_yes_bid} vol=${r.volume} oi=${r.open_interest} conf=${r.confidence}`);
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
    text,
    rows,
    synthesisInput,
    inventoryText,
    counts: { total: rows.length, blocked: blockedCount, scored: summary.scored_count },
    compositeSummary: summary,
  };
}

function termBucketForRow(row) {
  const analysis = String(row.analysis ?? '').toLowerCase();
  if (row.edge_status === EDGE_STATUS.BLOCKED) return 'blocked/no-source';
  if (analysis.includes('low-source watch only')) return 'watch-only';
  if (row.edge_status === EDGE_STATUS.PICK || row.edge_status === EDGE_STATUS.LEAN) return 'most-likely';
  return 'watch-only';
}

function evidenceStatusForRow(row) {
  const analysis = String(row.analysis ?? '');
  if (row.edge_status === EDGE_STATUS.BLOCKED) return 'blocked/no-source';
  if (/LOW-SOURCE WATCH only/i.test(analysis)) return 'proximity-only source cap -- no pick';
  if (Array.isArray(row.top_evidence_layers) && row.top_evidence_layers.length) {
    return `source evidence present: ${row.top_evidence_layers.map((x) => x.category ?? x.label ?? String(x)).join(', ')}`;
  }
  return 'missing source-backed research';
}

function compactMarketContext(row) {
  return {
    implied_probability: row.implied_probability,
    yes_bid_cents: row.market_yes_bid,
    yes_ask_cents: row.market_yes_ask,
    last_price_cents: row.last_price,
    volume: row.volume,
    open_interest: row.open_interest,
    note: 'NOT IN SCORE',
  };
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

export function buildMentionsSynthesisInput({ date, event, rows = [], sourceUrl = null, inventoryPath = null, compositeSummary = {}, provenanceLines = [] } = {}) {
  const s = summarizeEvent(event);
  const rules = firstMarketRules(event);
  // Compact each term to only what the model needs for the article.
  const terms = rows.map((row) => ({
    full_strike_text: row.side_target,
    short_term: shortTerm(row.side_target, s.title),
    cpc_score: row.composite_score ?? null,
    bucket: termBucketForRow(row),
    evidence_status: evidenceStatusForRow(row),
    layers_present: normalizeLayerList(row.layers_present),
    composite_posture: row.composite_posture,
    missing_research_layers: Array.isArray(row.missing_layers)
      ? row.missing_layers.map((l) => l.category ?? l.label ?? String(l)).slice(0, 5)
      : [],
    upgrade_trigger: row.trigger_event,
    market_context: {
      implied: row.implied_probability,
      bid_cents: row.market_yes_bid,
      ask_cents: row.market_yes_ask,
      note: 'NOT IN SCORE',
    },
  }));
  const nonBlocked = terms.filter((term) => term.bucket !== 'blocked/no-source');
  const allProximityOnly = nonBlocked.length > 0 && nonBlocked.every((term) => term.evidence_status === 'proximity-only source cap -- no pick');

  return {
    packet_kind: 'mentions_customer_packet_v2',
    date,
    event: {
      title: s.title,
      subtitle: s.sub_title,
      date_time: s.close,
      settlement_source_link: event?.event_url ?? event?.url ?? `https://kalshi.com/events/${s.ticker}`,
      rules_primary: rules.primary,
    },
    synthesis_rules: {
      output_style: 'concise research article / Substack-style brief',
      research_only: true,
      no_trade: true,
      model_written_final_packet_allowed: false,
      use_full_strike_text_only: true,
      market_context_not_in_score: true,
      all_terms_proximity_only: allProximityOnly,
      proximity_only_label: allProximityOnly ? 'LOW-SOURCE WATCH only -- no pick' : null,
      forbidden_claims_when_all_terms_proximity_only: ['source-backed composite', 'source backed composite'],
    },
    summary: {
      market_count: compositeSummary.market_count ?? rows.length,
      source_backed_count: compositeSummary.source_backed_count ?? null,
      proximity_only_count: compositeSummary.proximity_only_count ?? null,
      best_posture: compositeSummary.best_posture ?? null,
    },
    deterministic_provenance_lines: Array.isArray(provenanceLines) ? provenanceLines : [],
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
  if (input?.synthesis_rules?.all_terms_proximity_only && /source-backed composite/i.test(text)) {
    throw new Error('Hermes packet violated proximity-only labeling: used "source-backed composite"');
  }
  for (const term of input?.terms ?? []) {
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
} = {}) {
  if (!input || typeof input !== 'object') throw new Error('mentions packet compose input missing');
  const analystRun = await fetchAnalystFields({ input, summary: input.summary ?? {}, env, chatRunner });
  const redteamRun = await fetchRedteamFields({ input, env, chatRunner });
  const text = renderMentionPacket(input, {
    analyst: analystRun.analyst,
    redteam: redteamRun.redteam,
    generatedAtUtc: now(),
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
      marketCount > 0 ? `Kalshi board captured with ${marketCount} market(s).` : null,
      rules.primary ? 'Settlement wording present in source packet.' : null,
      hasLocalEvidence ? 'Legacy source evidence present.' : null,
    ].filter(Boolean),
    settlementRules: rules.primary || rules.secondary || 'MISSING: exact settlement wording not present in packet.',
    verifiedFacts: hasLocalEvidence ? 'Legacy source evidence present; requires research review.' : 'No verified transcript/event facts supplied by packet generator.',
    marketSignalText: marketCount > 0 ? 'Market board captured for research; no pick inferred.' : 'No market board captured.',
    socialChatter: 'Separated: packet generator does not promote X chatter to fact.',
    inference: 'Mention-market inference blocked until exact source, transcript path, and word-match rules are checked.',
    skepticReview: 'MISSING: no skeptic review in packet generator.',
    finalJudgment: 'WATCH only; no pick without exact wording, source/event path, and public statement/schedule evidence.',
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
    lines.push(`    composite_posture: ${r.posture}`);
    lines.push(`    layers_present: ${r._meta.layers_present}/${r._meta.layers_total}`);
    lines.push('    top_support:');
    if (r.top_supporting_layers.length) {
      for (const layer of r.top_supporting_layers) {
        lines.push(`      - ${layer.category}: value=${layer.value} contribution=${layer.contribution}`);
      }
    } else {
      lines.push('      - MISSING: no source-backed layers supplied');
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
function loadResearchForDate(stateRoot, date) {
  const researchDir = resolve(stateRoot, 'mentions', date, 'research');
  if (!existsSync(researchDir)) return new Map();
  const map = new Map();
  for (const entry of readdirSync(researchDir)) {
    if (!entry.endsWith('.json')) continue;
    const p = join(researchDir, entry);
    const data = readJsonIfExists(p);
    if (!data || !data.event_ticker) continue;
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

function loadExactMentionEventsFromArtifacts({ date, tickers = [], stateRoots = [] } = {}) {
  const roots = uniqueResolved(stateRoots.length ? stateRoots : ['state']);
  const events = [];
  const loaded = [];
  const missing = [];
  for (const ticker of tickers) {
    let found = null;
    for (const root of roots) {
      const eventPath = resolve(root, 'mentions', date, 'kalshi-events', `${ticker}.json`);
      const event = readJsonIfExists(eventPath);
      if (!event?.event_ticker) continue;
      const researchEntry = loadResearchForDate(root, date).get(ticker);
      found = {
        event: mergeResearchIntoEvent(event, researchEntry),
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

function mergeResearchIntoEvent(event, researchEntry) {
  if (!researchEntry) return event;
  const cloned = { ...event };
  const markets = Array.isArray(cloned.markets) ? cloned.markets.slice() : [];
  const marketMap = researchEntry._marketMap || new Map();

  cloned.markets = markets.map(m => {
    const ticker = m.ticker;
    const r = marketMap.get(ticker);
    if (!r) return m;
    const merged = { ...m };
    if (r.layer_records) {
      merged.layer_records = r.layer_records;
    }
    if (r.source_ladder_inputs) {
      merged.source_ladder_inputs = r.source_ladder_inputs;
    }
    if (r.research_quality) {
      merged.research_quality = r.research_quality;
    }
    return merged;
  });

  return cloned;
}

export function buildKalshiEventPacket({ date, event, sourceUrl, inventoryPath = null, historyRecords = null, earningsQuarters = null, earningsContextSources = null }) {
  const s = summarizeEvent(event);
  const marketInfo = marketRows(event);

  // Phase 2 earnings alpha (earnings_call route only): the per-term quarter
  // layer and context delta are built once per event from fixtures/cache —
  // never from crawling — then shared by every market composite.
  let earningsQuarterLayer = null;
  let earningsContextDelta = null;
  const eventRoute = resolveResearchRoute(routeEventLike({ event }));
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
      event, market: raw, historyRecords,
      earningsQuarterLayer, earningsContextDelta,
      sportsSettledResult: perMarketSportsHistory,
      sportsGameContextResult: perMarketGameCtx,
    });
  });
  const compositeSummary = summarizeCompositeRun(composites);
  const prov = composites[0] ?? null;
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
  } : null;

  // Preferred path: v2 customer renderer; raw inventory routed to a separate
  // audit artifact.
  const slate = buildMentionSlatePacket({
    date,
    event,
    composites,
    sourcePath: sourceUrl,
    inventoryPath,
  });
  if (slate) {
    if (researchProvenance) slate.synthesisInput.research_provenance = researchProvenance;
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
      counts: slate.counts,
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
  lines.push(`  decision_status: ${process.decisionStatus}`);
  lines.push('');
  lines.push(renderDecisionProcess(process, { heading: 'Research Completeness' }));
  return {
    text: header + lines.join('\n') + packetFooter(),
    inventoryText: buildInventoryArtifact({ marketType: 'mentions', date, eventTicker: s.ticker, inventoryLines: [], meta: { mode: 'NO_MARKETS' } }),
    marketCount: marketInfo.marketCount,
    missingStrikeCount: marketInfo.missingStrikeCount,
    missingMarkets: marketInfo.missingMarkets,
    compositeSummary,
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
  lines.push(`  decision_status: ${process.decisionStatus}`);
  lines.push(`  composite_top_posture: ${compositeSummary.best_posture}`);
  lines.push(`  composite_top_score: ${compositeSummary.best_score === null ? 'MISSING' : compositeSummary.best_score}`);
  lines.push('  note: legacy artifact uses mention-composite only when source layer records are present.');
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
  lines.push(`decision_status: ${process.decisionStatus}`);
  lines.push(`posture: ${compositeSummary.best_posture} (mention composite; research only, no trade)`);
  return header + lines.join('\n') + packetFooter();
}

function buildEmptyDayPacket(date, primeAttempts = [], discovery = null, mentionStats = null) {
  const process = evaluateDecisionProcess({
    marketType: MARKET_TYPES.MENTION_MARKET,
    rawDecision: 'NO CLEAR PICK',
    checked: { x_chatter_separated: true },
    settlementRules: 'MISSING: no market/event packet.',
    verifiedFacts: 'MISSING: no mention-style events discovered.',
    marketSignalText: 'No market board captured.',
    socialChatter: 'Not used.',
    inference: 'No inference.',
    skepticReview: 'MISSING.',
    finalJudgment: 'NO CLEAR PICK.',
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
      `  decision_status: ${process.decisionStatus}`,
      '  note: no mention-style events found; no pick or lean.',
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
}) {
  let totalMarketCount = 0;
  let missingMarketEventCount = 0;
  let missingStrikeTextCount = 0;
  const items = [];
  const failedTickers = [];
  const seen = new Set();
  const researchMap = loadResearchForDate(stateRoot, date);
  // Settled-history records (price-free, outcomes only) load once per run and
  // feed historical_tendency BEFORE any model extraction. Missing dir -> [].
  const historyRecords = await loadHistory({ stateRoot });
  for (const ev of events) {
    const ticker = ev?.event_ticker;
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    const researchEntry = researchMap.get(ticker);
    const mergedEvent = mergeResearchIntoEvent(ev, researchEntry);
    const sourcePath = resolve(stateRoot, 'mentions', date, 'kalshi-events', `${ticker.replace(/[^A-Z0-9_-]/gi, '_').slice(0, 80)}.json`);
    const inventoryName = `${date}-${ticker}.inventory`;
    const inventoryPath = `${inventoryName}.txt`;
    // Phase 2 earnings alpha inputs: quarter history cache + declared context
    // sources load from local state only (no crawling), earnings_call routes only.
    let earningsQuarters = null;
    let earningsContextSources = null;
    const evRoute = resolveResearchRoute(routeEventLike({ event: mergedEvent }));
    if (evRoute?.route === 'earnings_call') {
      const family = resolveEarningsFamily(mergedEvent);
      if (family?.ticker) {
        earningsQuarters = await loadEarningsHistory({ ticker: family.ticker, stateRoot });
        earningsContextSources = readJsonIfExists(
          resolve(stateRoot, 'mentions', 'earnings-context', `${family.ticker}.json`),
        );
      }
    }
    const built = buildKalshiEventPacket({ date, event: mergedEvent, sourceUrl: sourcePath, inventoryPath, historyRecords, earningsQuarters, earningsContextSources });
    totalMarketCount += built.marketCount;
    if (built.missingMarkets) missingMarketEventCount += 1;
    missingStrikeTextCount += built.missingStrikeCount;
    // Raw per-contract inventory -> audit artifact only (never the packet body).
    if (built.inventoryText) {
      const invW = audit(dir, inventoryName, built.inventoryText, {
        kind: 'raw_inventory_audit',
        event_ticker: ticker,
      });
      items.push({ name: inventoryName, ...invW });
    }
    let packetText = built.text;
    let modelSynthesisInvocation = null;
    if (!dryRun) {
      try {
        const synthesized = await synthesizeImpl({ input: built.synthesisInput });
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
      telegram_delivery_mode: 'document_txt',
      kalshi_source_api: KALSHI_SOURCES.broad.api_url,
      kalshi_source_page: KALSHI_SOURCES.broad.page_url,
      research_prime: allPrimeAttempts.map(({ label, ok, status, stderr, error, skipped }) => ({ label, ok, status, stderr, error, skipped })),
    }, { writeChunks: false });
    items.push({ name: ticker, ...w, previewText: dryRun ? packetText : null });
  }
  return { items, failedTickers, totalMarketCount, missingMarketEventCount, missingStrikeTextCount };
}

async function main() {
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
    const todayGuard = filterByEventDate(opts.date, { windowDays: extra.windowDays, allowUndated: false });
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
