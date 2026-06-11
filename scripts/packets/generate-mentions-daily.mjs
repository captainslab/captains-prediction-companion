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
  renderSectionedPacket,
  buildInventoryArtifact,
  EDGE_STATUS,
  CONFIDENCE,
} from '../shared/decision-packet.mjs';

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

function resolveMentionProfile({ event = null, market = null, legacy = null } = {}) {
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
  if (explicit) return { profile: explicit, basis: 'explicit_profile' };

  const text = lowerJoined([
    event?.event_ticker,
    event?.series_ticker,
    event?.title,
    event?.sub_title,
    market?.ticker,
    market?.title,
    market?.subtitle,
    market?.yes_sub_title,
    market?.no_sub_title,
    market?.rules_primary,
    market?.rules_secondary,
    legacy?.event_id,
    legacy?.target_phrase,
    legacy?.speaker,
    legacy?.company,
    legacy?.entity,
    legacy?.context,
    legacy?.event_context,
  ]);

  if (/\b(earnings|earnings call|quarterly results|guidance|eps|revenue|cfo|ceo|investor relations|10-k|10-q|sec filing)\b/.test(text)) {
    return { profile: EARNINGS_PROFILE, basis: 'inferred_earnings_terms' };
  }
  if (/\b(announcer|broadcast|commentator|commentary|pregame|postgame|espn|fox sports|tnt|cbs sports|nbc sports|game broadcast)\b/.test(text)) {
    return { profile: SPORTS_ANNOUNCER_PROFILE, basis: 'inferred_broadcast_terms' };
  }
  if (/\b(president|trump|biden|vance|senate|congress|governor|mayor|election|debate|speech|rally|hearing|white house|secretary|minister|campaign|candidate)\b/.test(text)) {
    return { profile: POLITICAL_PROFILE, basis: 'inferred_political_terms' };
  }
  return { profile: POLITICAL_PROFILE, basis: 'default_mentions_calendar_profile' };
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

function targetMentionFromMarket(market = {}) {
  const normalized = normalizeMarket(market);
  return (
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

export function buildMentionCompositeForMarket({ event = null, market = null, legacy = null } = {}) {
  const profileResolution = resolveMentionProfile({ event, market, legacy });
  const profileConfig = PROFILE_REGISTRY[profileResolution.profile];
  const targetMention = market ? targetMentionFromMarket(market) : (
    asText(legacy?.target_phrase) ||
    asText(legacy?.phrase) ||
    asText(legacy?.keyword) ||
    'MISSING'
  );
  const layerRecords = firstLayerRecordMap(market, event, legacy);
  const result = composeMentionLedger({
    event: eventNameForComposite(event ?? {}, legacy),
    targetMention,
    profile: profileResolution.profile,
    layerDefs: profileConfig.layerDefs,
    layerRecords,
    marketContext: market ? marketContextFromMarket(market) : (legacy?.market_context ?? legacy?.marketContext ?? null),
  });

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

  return {
    market_ticker: market?.ticker ?? legacy?.ticker ?? legacy?.event_id ?? 'MISSING',
    profile_basis: profileResolution.basis,
    result,
    source_ladder: ladder,
    posture_final: postureFinal,
    posture_cap_reason: postureCap,
    research_quality: market?.research_quality ?? legacy?.research_quality ?? null,
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

function summarizeCompositeRun(composites) {
  const best = bestComposite(composites);
  return {
    market_count: composites.length,
    scored_count: composites.filter(c => c?.result?.composite_score !== null).length,
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
  };

  const missingCats = Array.isArray(r.missing_layers) ? r.missing_layers.map((l) => l.category) : [];
  const topLayers = Array.isArray(r.top_supporting_layers) ? r.top_supporting_layers.map((l) => l.category) : [];
  const target = r.target_mention ?? composite?.market_ticker ?? 'MISSING';

  // No source-backed evidence at all -> BLOCKED on the missing source layers.
  const sourceBlocked = layersPresent === 0;
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
 * Build the compact, sectioned mentions decision board from the per-market
 * composites of a Kalshi mention event. Main text carries ONLY the sectioned
 * board (TLDR + sections + audit pointers). The raw contract inventory + full
 * market context go to a separate audit artifact, never the packet body.
 * Returns { text, rows, inventoryText, counts } or null when no composites.
 */
export function buildMentionSlatePacket({ date, event, composites, sourcePath = null, inventoryPath = null }) {
  if (!Array.isArray(composites) || !composites.length) return null;
  const s = summarizeEvent(event);
  const rows = composites.map((c) => mentionCompositeToDecisionRow(c));
  const summary = summarizeCompositeRun(composites);

  const blockedCount = rows.filter((r) => r.edge_status === EDGE_STATUS.BLOCKED).length;
  const tldrNote = blockedCount === rows.length
    ? `All ${rows.length} contract(s) BLOCKED on missing source layers — research the source ladder, then re-score. No tradeable edge yet.`
    : `${summary.scored_count}/${rows.length} contract(s) have source-backed composite; best posture ${summary.best_posture}.`;

  const body = renderSectionedPacket(rows, {
    tldrNote,
    auditArtifacts: [inventoryPath, sourcePath].filter(Boolean),
    perSectionLimit: 16,
  });

  const header = packetHeader({
    title: `Captain Mentions — Daily Decision Board: ${s.title}`,
    date,
    packetType: PACKET_TYPE,
    sources: [sourcePath, KALSHI_SOURCES.mentions.page_url].filter(Boolean),
  });
  const neutralityNote = 'Mention composite is source-layer scoring only; Kalshi price/volume/OI is shown beside it for edge detection but is NEVER a composite input.';
  const text = [header, neutralityNote, body, packetFooter()].filter(Boolean).join('\n\n');

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
    inventoryText,
    counts: { total: rows.length, blocked: blockedCount, scored: summary.scored_count },
    compositeSummary: summary,
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

export function buildKalshiEventPacket({ date, event, sourceUrl, inventoryPath = null }) {
  const s = summarizeEvent(event);
  const marketInfo = marketRows(event);
  const composites = marketInfo.rows.map(({ raw }) => buildMentionCompositeForMarket({ event, market: raw }));
  const compositeSummary = summarizeCompositeRun(composites);

  // Preferred path: compact sectioned decision board (model + market + edge),
  // raw inventory routed to a separate audit artifact.
  const slate = buildMentionSlatePacket({
    date,
    event,
    composites,
    sourcePath: sourceUrl,
    inventoryPath,
  });
  if (slate) {
    return {
      text: slate.text,
      inventoryText: slate.inventoryText,
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

  const {
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
  });

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
    const seen = new Set();
    const researchMap = loadResearchForDate(opts.stateRoot, opts.date);
    for (const ev of events) {
      const ticker = ev?.event_ticker;
      if (!ticker || seen.has(ticker)) continue;
      seen.add(ticker);
      const researchEntry = researchMap.get(ticker);
      const mergedEvent = mergeResearchIntoEvent(ev, researchEntry);
      const sourcePath = resolve(opts.stateRoot, 'mentions', opts.date, 'kalshi-events', `${ticker.replace(/[^A-Z0-9_-]/gi, '_').slice(0, 80)}.json`);
      const inventoryName = `${opts.date}-${ticker}.inventory`;
      const inventoryPath = `${inventoryName}.txt`;
      const built = buildKalshiEventPacket({ date: opts.date, event: mergedEvent, sourceUrl: sourcePath, inventoryPath });
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
      const w = audit(dir, `${opts.date}-${ticker}`, built.text, {
        event_ticker: ticker,
        market_count: built.marketCount,
        missing_markets: built.missingMarkets,
        missing_strike_text_count: built.missingStrikeCount,
        composite_scored_count: built.compositeSummary.scored_count,
        composite_best_posture: built.compositeSummary.best_posture,
        composite_best_score: built.compositeSummary.best_score,
        composite_pricing_excluded: built.compositeSummary.pricing_excluded,
        kalshi_source_api: KALSHI_SOURCES.broad.api_url,
        kalshi_source_page: KALSHI_SOURCES.broad.page_url,
        research_prime: allPrimeAttempts.map(({ label, ok, status, stderr, error, skipped }) => ({ label, ok, status, stderr, error, skipped })),
      });
      items.push({ name: ticker, ...w });
    }
    for (const ev of localEvents) {
      const baseName = `${opts.date}-${(ev.parsed?.event_id || ev.name).toString()}`;
      const txt = buildLegacyEventPacket({ date: opts.date, event: ev });
      const w = audit(dir, baseName, txt, {
        source_file: ev.file,
        research_prime: allPrimeAttempts.map(({ label, ok, status, stderr, error, skipped }) => ({ label, ok, status, stderr, error, skipped })),
      });
      items.push({ name: baseName, ...w });
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
  console.log(`[${PACKET_TYPE}] summary event_count=${eventCount} kalshi_window_matched=${dateFilteredEvents.length} mention_events=${combinedStats.mentionEvents} rejected_events=${combinedStats.rejectedEvents} total_markets_scanned=${combinedStats.totalMarkets} mention_markets=${combinedStats.mentionMarkets} total_market_count=${totalMarketCount} packets_written=${items.length} missing_market_count=${missingMarketEventCount} missing_strike_text_count=${missingStrikeTextCount} persisted=${persistedCount} window_days=${extra.windowDays} watchlist=${extra.watchlist} only=${extra.only ? extra.only.join(',') : 'none'} allow_undated=${extra.allowUndated}`);
  if (exitCode) process.exit(exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`[${PACKET_TYPE}] error: ${err.message}`);
    process.exit(1);
  });
}
