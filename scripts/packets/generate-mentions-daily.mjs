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

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parsePacketArgs,
  ensurePacketDir,
  writeAudit,
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

const PACKET_TYPE = 'mentions-daily';
const DEFAULT_WINDOW_DAYS = 7; // forward-looking week
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

export function buildKalshiEventPacket({ date, event, sourceUrl }) {
  const s = summarizeEvent(event);
  const marketInfo = marketRows(event);
  const composites = marketInfo.rows.map(({ raw }) => buildMentionCompositeForMarket({ event, market: raw }));
  const compositeSummary = summarizeCompositeRun(composites);
  const process = buildMentionProcess({ event });
  const header = packetHeader({
    title: 'Captain Mentions — Daily Event Packet',
    date,
    packetType: PACKET_TYPE,
    sources: [sourceUrl, KALSHI_SOURCES.mentions.page_url],
  });
  const lines = [];
  lines.push('TLDR:');
  lines.push(`  market_type: ${process.marketType}`);
  lines.push(`  decision_status: ${process.decisionStatus}`);
  lines.push(`  composite_top_posture: ${compositeSummary.best_posture}`);
  lines.push(`  composite_top_score: ${compositeSummary.best_score === null ? 'MISSING' : compositeSummary.best_score}`);
  lines.push(`  composite_top_target: ${compositeSummary.best_target || 'MISSING'}`);
  lines.push('  note: mention-composite is source-layer scoring only; market context is NOT IN SCORE.');
  lines.push('');
  lines.push(renderDecisionProcess(process, { heading: 'Research Completeness' }));
  lines.push('');
  lines.push(`event_ticker: ${s.ticker}`);
  lines.push(`event_title: ${s.title}`);
  lines.push(`event_sub_title: ${s.sub_title || 'MISSING'}`);
  lines.push(`series_ticker: ${s.series}`);
  lines.push(`market_count: ${s.marketCount}`);
  lines.push(`close_time_utc: ${s.close}`);
  lines.push('');
  for (const l of renderCompositeEvidence(composites)) lines.push(l);
  lines.push('');
  for (const l of renderContractInventory(marketInfo)) lines.push(l);
  lines.push('');
  for (const l of renderMarketContextNotInScore(marketInfo)) lines.push(l);
  lines.push('');
  lines.push('resolution_mechanics:');
  lines.push('  See market.rules_primary/rules_secondary per Kalshi listing.');
  lines.push('  Verify exact-string mention criteria before publishing.');
  lines.push('');
  lines.push('verified_vs_inference: MISSING (research-only packet; verification required by mentions-researcher)');
  lines.push(`decision_status: ${process.decisionStatus}`);
  lines.push(`posture: ${compositeSummary.best_posture} (mention composite; research only, no trade)`);
  return {
    text: header + lines.join('\n') + packetFooter(),
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

function buildEmptyDayPacket(date, primeAttempts = [], discovery = null) {
  const process = evaluateDecisionProcess({
    marketType: MARKET_TYPES.MENTION_MARKET,
    rawDecision: 'NO CLEAR PICK',
    checked: { x_chatter_separated: true },
    settlementRules: 'MISSING: no market/event packet.',
    verifiedFacts: 'MISSING: no events discovered.',
    marketSignalText: 'No market board captured.',
    socialChatter: 'Not used.',
    inference: 'No inference.',
    skepticReview: 'MISSING.',
    finalJudgment: 'NO CLEAR PICK.',
  });
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
      '  note: no events found; no pick or lean.',
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
      `  source_page: ${KALSHI_SOURCES.mentions.page_url}`,
      `  source_api: ${KALSHI_SOURCES.mentions.api_url}`,
      `  reachable: ${discovery?.ok ? 'yes' : 'no'}`,
      ...(discovery?.error ? [`  error: ${discovery.error}`] : []),
      '',
      'status: MISSING',
      `reason: no Kalshi Mentions events found with derived event-date inside window [${date}, +${DEFAULT_WINDOW_DAYS}d].`,
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

function parseExtraArgs(argv) {
  // Lets caller pass --allow-undated and --window-days N without breaking parsePacketArgs.
  const passthrough = [];
  const extra = { allowUndated: false, windowDays: DEFAULT_WINDOW_DAYS };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--allow-undated') extra.allowUndated = true;
    else if (a === '--window-days') { extra.windowDays = Number(argv[++i]); }
    else passthrough.push(a);
  }
  if (!Number.isFinite(extra.windowDays)) extra.windowDays = DEFAULT_WINDOW_DAYS;
  return { passthrough, extra };
}

async function main() {
  const { passthrough, extra } = parseExtraArgs(process.argv.slice(2));
  const opts = parsePacketArgs(passthrough);
  if (opts.help) {
    console.log('Usage: node scripts/packets/generate-mentions-daily.mjs --date YYYY-MM-DD [--dry-run] [--window-days N] [--allow-undated]');
    return;
  }
  const dir = ensurePacketDir(opts.stateRoot, opts.date, PACKET_TYPE);
  const primeAttempts = primeMentionResearch(opts.date);

  const discovery = await fetchKalshiEvents('mentions');
  const dateFilter = filterByEventDate(opts.date, {
    windowDays: extra.windowDays,
    allowUndated: extra.allowUndated,
  });
  const filteredEvents = discovery.events.filter(dateFilter);

  let persistedCount = 0;
  if (filteredEvents.length) {
    const persisted = persistEventArtifacts({
      stateRoot: opts.stateRoot,
      sport: 'mentions',
      date: opts.date,
      events: filteredEvents,
    });
    persistedCount = persisted.written.length;
  }

  const localEvents = discoverMentionEvents(opts.stateRoot, opts.date);

  let totalMarketCount = 0;
  let missingMarketEventCount = 0;
  let missingStrikeTextCount = 0;
  const items = [];

  if (!localEvents.length && !filteredEvents.length) {
    const txt = buildEmptyDayPacket(opts.date, primeAttempts, discovery);
    const w = writeAudit(dir, `${opts.date}-no-events`, txt, {
      event_count: 0,
      total_market_count: 0,
      missing_market_count: 0,
      missing_strike_text_count: 0,
      window_days: extra.windowDays,
      allow_undated: extra.allowUndated,
      kalshi_discovery: { ok: discovery.ok, error: discovery.error, total_returned: discovery.events.length, window_matched: filteredEvents.length },
      research_prime: primeAttempts.map(({ label, ok, status, stderr, error, skipped }) => ({ label, ok, status, stderr, error, skipped })),
    });
    items.push({ name: 'no-events', ...w });
  } else {
    const seen = new Set();
    for (const ev of filteredEvents) {
      const ticker = ev?.event_ticker;
      if (!ticker || seen.has(ticker)) continue;
      seen.add(ticker);
      const sourcePath = resolve(opts.stateRoot, 'mentions', opts.date, 'kalshi-events', `${ticker.replace(/[^A-Z0-9_-]/gi, '_').slice(0, 80)}.json`);
      const built = buildKalshiEventPacket({ date: opts.date, event: ev, sourceUrl: sourcePath });
      totalMarketCount += built.marketCount;
      if (built.missingMarkets) missingMarketEventCount += 1;
      missingStrikeTextCount += built.missingStrikeCount;
      const w = writeAudit(dir, `${opts.date}-${ticker}`, built.text, {
        event_ticker: ticker,
        market_count: built.marketCount,
        missing_markets: built.missingMarkets,
        missing_strike_text_count: built.missingStrikeCount,
        composite_scored_count: built.compositeSummary.scored_count,
        composite_best_posture: built.compositeSummary.best_posture,
        composite_best_score: built.compositeSummary.best_score,
        composite_pricing_excluded: built.compositeSummary.pricing_excluded,
        kalshi_source_api: KALSHI_SOURCES.mentions.api_url,
        kalshi_source_page: KALSHI_SOURCES.mentions.page_url,
      });
      items.push({ name: ticker, ...w });
    }
    for (const ev of localEvents) {
      const baseName = `${opts.date}-${(ev.parsed?.event_id || ev.name).toString()}`;
      const txt = buildLegacyEventPacket({ date: opts.date, event: ev });
      const w = writeAudit(dir, baseName, txt, {
        source_file: ev.file,
        research_prime: primeAttempts.map(({ label, ok, status, stderr, error, skipped }) => ({ label, ok, status, stderr, error, skipped })),
      });
      items.push({ name: baseName, ...w });
    }
  }

  const eventCount = filteredEvents.length + localEvents.length;
  // Guard: event_count > 0 but total_market_count === 0 -> fail (Kalshi side only).
  let exitCode = 0;
  if (filteredEvents.length > 0 && totalMarketCount === 0) {
    console.error(`[${PACKET_TYPE}] FAIL: ${filteredEvents.length} Kalshi events but zero markets across all of them.`);
    exitCode = 2;
  }

  console.log(printDryRunSummary({ packetType: PACKET_TYPE, date: opts.date, dir, items }));
  console.log(`[${PACKET_TYPE}] summary event_count=${eventCount} kalshi_window_matched=${filteredEvents.length} total_market_count=${totalMarketCount} packets_written=${items.length} missing_market_count=${missingMarketEventCount} missing_strike_text_count=${missingStrikeTextCount} persisted=${persistedCount} window_days=${extra.windowDays} allow_undated=${extra.allowUndated}`);
  if (exitCode) process.exit(exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`[${PACKET_TYPE}] error: ${err.message}`);
    process.exit(1);
  });
}
