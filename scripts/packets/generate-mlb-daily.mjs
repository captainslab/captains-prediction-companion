#!/usr/bin/env node
// MLB daily packet generator (pre-final-lineup research).
// One packet per Kalshi MLB game event (KXMLBGAME). No trades.
//
// Events = container (the game). Markets = the tradable contracts (per-team
// winner, totals, etc.). Each market is emitted as its own block under the
// event, with strike text sourced from market fields — never ticker fragments.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parsePacketArgs,
  ensurePacketDir,
  writeAudit,
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
  renderMarketBlocks,
  normalizeMarket,
  KALSHI_SOURCES,
} from './lib/kalshi-discovery.mjs';
import { buildEventDisplay, buildMarketDisplay } from './lib/mlb-teams.mjs';
import {
  buildScoreEngineProjection,
  buildYrfiProjection,
  buildKsProjection,
  distributionFloorMean,
} from '../mlb/lib/projection-contracts.mjs';
import {
  describeMoneyline,
  describeRunline,
  describeTotal,
  describeTeamRuns,
  describeYrfi,
  describeKs,
  describeHr,
} from '../mlb/lib/projection-language.mjs';
import {
  buildGameProjections,
  loadStatsRecords,
  leagueRunsPerGame,
  matchStatsRecord,
} from '../mlb/lib/projection-engine.mjs';
import {
  PACKET_SCOPES,
  buildScopedLedger,
  buildInputStatusNote,
  mapProjectionStatusToInput,
  buildHrWatchlist,
} from '../mlb/lib/assumptions-ledger.mjs';
import { writeScopedLedger } from '../mlb/lib/assumptions-writer.mjs';
import { evaluateDecisionProcess, MARKET_TYPES, renderDecisionProcess } from '../shared/decision-process.mjs';
import {
  buildDecisionRow,
  renderDecisionBoard,
  renderSectionedPacket,
  rankDecisionRows,
  buildInventoryArtifact,
  EDGE_STATUS,
  CONFIDENCE,
} from '../shared/decision-packet.mjs';

export { buildInputStatusNote } from '../mlb/lib/assumptions-ledger.mjs';

const PACKET_TYPE = 'mlb-daily';
const PACKET_SCOPE_SET = new Set(PACKET_SCOPES);

// Map an MLB scoring-core classification to the shared edge_status vocabulary.
// The MLB scorer is the authority on the verdict; the shared row carries it as
// statusOverride so the generic threshold logic does not relitigate it. Market
// price is NEVER read back into the composite — fair_value (model) and
// kalshi_ask (market) stay in separate halves of the row.
const MLB_CLASSIFICATION_TO_STATUS = Object.freeze({
  CLEAR_PICK: EDGE_STATUS.PICK,
  PRE_LINEUP_PICK: EDGE_STATUS.PICK,
  LEAN: EDGE_STATUS.LEAN,
  WATCH_FOR_PRICE: EDGE_STATUS.WATCH,
  WATCH_FOR_LISTING: EDGE_STATUS.WATCH,
  CORRELATED_ALTERNATE: EDGE_STATUS.WATCH,
  PASS: EDGE_STATUS.PASS,
  FADE: EDGE_STATUS.FADE,
  BLOCKED: EDGE_STATUS.BLOCKED,
  BLOCKED_SOURCE_GAP: EDGE_STATUS.BLOCKED,
});

const MLB_POSTURE = Object.freeze({
  CLEAR_PICK: 'PICK',
  PRE_LINEUP_PICK: 'EVIDENCE_LEAN',
  LEAN: 'LEAN',
  WATCH_FOR_PRICE: 'WATCH',
  WATCH_FOR_LISTING: 'WATCH',
  CORRELATED_ALTERNATE: 'MARKET_ONLY_LEAN',
  PASS: 'NO_CLEAR_PICK',
  FADE: 'NO_CLEAR_PICK',
  BLOCKED: 'NO_CLEAR_PICK',
  BLOCKED_SOURCE_GAP: 'NO_CLEAR_PICK',
});

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseMlbDailyArgs(argv) {
  const filtered = [];
  let scope = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--scope') {
      scope = argv[++i] ?? null;
      continue;
    }
    filtered.push(a);
  }
  const opts = parsePacketArgs(filtered);
  opts.scope = scope;
  return opts;
}

export function resolvePacketScope({ explicit = null, hasScoring = false, perGame = false } = {}) {
  const requested = explicit == null || explicit === '' ? null : String(explicit).trim().toUpperCase();
  if (requested) {
    if (!PACKET_SCOPE_SET.has(requested)) {
      throw new Error(`Invalid MLB packet scope: ${explicit}`);
    }
    return requested;
  }
  if (perGame) return 'GAME_PACKET';
  if (hasScoring) return 'SLATE_PREVIEW';
  return 'FULL_DAY_PREVIEW';
}

function sourceQualityForInputStatus(status) {
  if (status === 'LOCKED') return 'A';
  if (status === 'PROJECTED') return 'B';
  if (status === 'ASSUMED') return 'C';
  return 'F';
}

function scopeAdjustedInputStatus(scope, status) {
  if (scope === 'FULL_DAY_PREVIEW' && status === 'UNKNOWN') return 'PROJECTED';
  return status;
}

const SCORING_CLASS_RANK = Object.freeze({
  CLEAR_PICK: 100,
  PRE_LINEUP_PICK: 90,
  LEAN: 80,
  WATCH_FOR_PRICE: 55,
  WATCH_FOR_LISTING: 50,
  CORRELATED_ALTERNATE: 30,
  PASS: 20,
  FADE: 15,
  BLOCKED: 10,
  BLOCKED_SOURCE_GAP: 5,
});

function hasModelBackedScoringSignal(pick = {}) {
  return pick?.fair_value != null && Number.isFinite(Number(pick.fair_value));
}

function isActionableScoringClassification(pick = {}) {
  return ['CLEAR_PICK', 'PRE_LINEUP_PICK', 'LEAN'].includes(String(pick?.classification ?? '').toUpperCase());
}

/**
 * Select a game's primary scored row using model posture, never market edge.
 * A scorer-provided primary_pick remains authoritative for non-actionable rows
 * and for actionable rows only when that row has a model-backed fair_value.
 */
export function selectPrimaryScoringPick(gamePicks = []) {
  const picks = safeArray(gamePicks).filter(Boolean);
  if (!picks.length) return null;
  const flagged = picks.find((pick) => pick.primary_pick
    && (!isActionableScoringClassification(pick) || hasModelBackedScoringSignal(pick)));
  if (flagged) return flagged;

  return picks.map((pick, index) => ({ pick, index })).sort((a, b) => {
    const modelA = isActionableScoringClassification(a.pick) && hasModelBackedScoringSignal(a.pick) ? 1 : 0;
    const modelB = isActionableScoringClassification(b.pick) && hasModelBackedScoringSignal(b.pick) ? 1 : 0;
    if (modelB !== modelA) return modelB - modelA;
    const rankA = SCORING_CLASS_RANK[String(a.pick.classification ?? '').toUpperCase()] ?? 0;
    const rankB = SCORING_CLASS_RANK[String(b.pick.classification ?? '').toUpperCase()] ?? 0;
    if (rankB !== rankA) return rankB - rankA;
    return a.index - b.index;
  })[0].pick;
}

function derivePacketStatusSnapshot({ gamePicks = [], statsRecord = null } = {}) {
  const picks = safeArray(gamePicks);
  const allMissing = picks.flatMap((pick) => safeArray(pick?.missing_confirmations));
  const passedText = picks.flatMap((pick) => safeArray(pick?.gates_passed)).join(' | ').toLowerCase();
  const lineupConfirmed = /lineup/.test(passedText) && /confirm/.test(passedText) && !/pending|soft/.test(passedText);
  const lineup_status = lineupConfirmed ? 'confirmed' : ((picks.length || statsRecord) ? 'unconfirmed' : null);
  const weather_status = picks.length
    ? (allMissing.some((m) => /roof|weather/i.test(String(m))) ? 'partial' : 'complete')
    : null;
  const { lineupInput, weatherInput } = mapProjectionStatusToInput({ lineup_status, weather_status });
  const starterInput = lineupInput === 'LOCKED'
    ? 'LOCKED'
    : (statsRecord ? 'PROJECTED' : (picks.length ? 'PROJECTED' : 'UNKNOWN'));
  return {
    lineup_status,
    weather_status,
    lineupInput,
    starterInput,
    weatherInput,
  };
}

function buildPacketAssumptionsLedger({
  scope,
  date,
  game = null,
  gameId = null,
  scoring = null,
  gamePicks = [],
  statsRecord = null,
  hrProjection = null,
  sourceRefs = {},
} = {}) {
  const picks = safeArray(gamePicks.length ? gamePicks : scoring?.picks);
  const statusSnapshot = derivePacketStatusSnapshot({ gamePicks: picks, statsRecord });
  const lineupInput = scopeAdjustedInputStatus(scope, statusSnapshot.lineupInput);
  const starterInput = scopeAdjustedInputStatus(scope, statusSnapshot.starterInput);
  const weatherInput = scopeAdjustedInputStatus(scope, statusSnapshot.weatherInput);
  const gameLabel = game?.game ?? statsRecord?.game ?? picks[0]?.game ?? null;
  const eventLabel = game?.ticker ?? picks[0]?.event_ticker ?? null;
  const sharedSource = scoring?.source ?? sourceRefs.scoring ?? sourceRefs.event ?? null;
  const statsSource = sourceRefs.stats ?? null;
  const weatherSource = sourceRefs.weather ?? sharedSource;
  const contextSource = sourceRefs.context ?? sharedSource;
  const lineupBasis = picks.length
    ? `lineup state derived from ${picks.length} scored pick(s)${eventLabel ? ` for ${eventLabel}` : ''}`
    : 'no scored pick inputs available for lineup state';
  const weatherBasis = picks.length
    ? `weather state derived from missing confirmations${eventLabel ? ` for ${eventLabel}` : ''}`
    : 'no weather inputs available in packet data';

  const items = [
    {
      type: 'lineup',
      scope,
      team: null,
      player: null,
      game: gameLabel,
      value: statusSnapshot.lineup_status,
      status: lineupInput,
      basis: lineupBasis,
      source: sharedSource ?? contextSource,
      source_url: null,
      local_source_ref: eventLabel ?? gameId ?? null,
      source_quality: sourceQualityForInputStatus(lineupInput),
    },
    {
      type: 'weather',
      scope,
      team: null,
      player: null,
      game: gameLabel,
      value: statusSnapshot.weather_status,
      status: weatherInput,
      basis: weatherBasis,
      source: weatherSource,
      source_url: null,
      local_source_ref: eventLabel ?? gameId ?? null,
      source_quality: sourceQualityForInputStatus(weatherInput),
    },
  ];

  if (statsRecord?.away_pitcher || statsRecord?.home_pitcher) {
    const starters = [
      ['away', statsRecord.away_team ?? null, statsRecord.away_pitcher ?? null],
      ['home', statsRecord.home_team ?? null, statsRecord.home_pitcher ?? null],
    ];
    for (const [side, team, pitcher] of starters) {
      if (!pitcher && !team) continue;
      items.push({
        type: 'starter',
        scope,
        team,
        player: pitcher?.name ?? null,
        game: gameLabel,
        value: pitcher?.mlb_id ?? null,
        status: starterInput,
        basis: pitcher
          ? `starter stats loaded for ${pitcher.name ?? `${side} starter`} from public stats adapter`
          : 'starter state available only as a placeholder',
        source: statsSource ?? sharedSource ?? null,
        source_url: null,
        local_source_ref: `${eventLabel ?? gameId ?? 'game'}:${side}`,
        source_quality: sourceQualityForInputStatus(starterInput),
      });
    }
  } else {
    items.push({
      type: 'starter',
      scope,
      team: null,
      player: null,
      game: gameLabel,
      value: null,
      status: starterInput,
      basis: 'starter evidence not present in packet inputs',
      source: statsSource ?? sharedSource ?? null,
      source_url: null,
      local_source_ref: eventLabel ?? gameId ?? null,
      source_quality: sourceQualityForInputStatus(starterInput),
    });
  }

  const hrWatchEntries = buildHrWatchlist(
    [
      ...(hrProjection?.outputs ?? [])
        .filter((row) => row?.status === 'ready')
        .map((row) => ({
          scope,
          player: row.player?.player_name ?? (row.player?.mlb_id ? `MLB ${row.player.mlb_id}` : null),
          team: row.player?.team ?? null,
          game: gameLabel,
          status: lineupInput,
          basis: `fitted regular-game HR/PA model; lineup slot ${row.player?.lineup_slot}; ${row.player?.identity_match}`,
          source: statsSource ?? 'scripts/mlb/hr-engine/artifacts/regular-game-model-2025.json',
          source_quality: sourceQualityForInputStatus(lineupInput),
          local_source_ref: `${eventLabel ?? gameId ?? 'game'}:${row.player?.mlb_id ?? 'unknown'}`,
          projected_hr_prob: row.outputs?.probability_at_least_one_hr ?? null,
        })),
      ...picks
      .filter((pick) => pick?.market_lane === 'home_run_hitter')
      .map((pick) => ({
        scope,
        player: pick?.player_name ?? pick?.contract_title ?? pick?.market_title ?? null,
        team: pick?.team ?? null,
        game: pick?.game ?? gameLabel ?? null,
        status: lineupInput,
        basis: `home_run_hitter lane from scored packet${pick?.missing_confirmations?.length ? `; missing: ${safeArray(pick.missing_confirmations).join(', ')}` : ''}`,
        source: sharedSource ?? sourceRefs.event ?? null,
        source_quality: sourceQualityForInputStatus(lineupInput),
        local_source_ref: pick?.market_ticker ?? eventLabel ?? gameId ?? null,
      })),
    ],
    { scope },
  );

  return buildScopedLedger({ scope, date, items: [...items, ...hrWatchEntries] });
}

function buildPacketScopeNote({ scope, gamePicks = [], statsRecord = null, forceFullDay = false } = {}) {
  if (scope === 'FULL_DAY_PREVIEW' || forceFullDay) {
    return buildInputStatusNote({ scope: 'FULL_DAY_PREVIEW' });
  }
  const snapshot = derivePacketStatusSnapshot({ gamePicks, statsRecord });
  return buildInputStatusNote({
    scope,
    lineupInput: snapshot.lineupInput,
    starterInput: snapshot.starterInput,
    weatherInput: snapshot.weatherInput,
  });
}

/**
 * Load the MLB scoring artifacts (picks.json / today-execution-board.json) for
 * a date if the sports-pre-game pipeline already produced them. Read-only.
 * Returns { picks: [], source, runDate, summaryCounts } or null.
 */
export function loadMlbScoring(stateRoot, date) {
  const picksPath = resolve(stateRoot, 'mlb', date, 'picks.json');
  const json = readJsonIfExists(picksPath);
  if (!json || !Array.isArray(json.picks)) return null;
  return {
    picks: json.picks,
    source: picksPath,
    runDate: json.run_date ?? date,
    summaryCounts: json.summary_counts ?? {},
    sourceHealth: json.source_health ?? {},
  };
}

/**
 * Convert one MLB pick record into a shared decision row. fair_value is the
 * MARKET-NEUTRAL model probability from the composite scoring core; kalshi_ask
 * is the market price. Edge derives from fair vs implied only.
 * A lineup_pending confirmation downgrades confidence. Actionable
 * classifications without a model-backed fair_value stay model-insufficient;
 * market-derived edge is display-only and cannot promote the row.
 */
export function mlbPickToDecisionRow(pick = {}) {
  const cls = String(pick.classification ?? 'PASS').toUpperCase();
  const modelBacked = hasModelBackedScoringSignal(pick);
  const classificationNeedsModel = ['CLEAR_PICK', 'PRE_LINEUP_PICK', 'LEAN'].includes(cls);
  const status = classificationNeedsModel && !modelBacked
    ? EDGE_STATUS.WATCH
    : (MLB_CLASSIFICATION_TO_STATUS[cls] ?? EDGE_STATUS.WATCH);
  const posture = classificationNeedsModel && !modelBacked
    ? 'MODEL_INSUFFICIENT'
    : (MLB_POSTURE[cls] ?? 'WATCH');
  const missing = Array.isArray(pick.missing_confirmations) ? pick.missing_confirmations : [];
  const gates = Array.isArray(pick.gates_passed) ? pick.gates_passed : [];
  const lineupPending = missing.some((m) => /lineup/i.test(String(m)));

  // Confidence: gate coverage, then downgrade once for a pending lineup so the
  // pre-lineup nature is reflected without killing the pick.
  let confidence = gates.length >= 5 ? CONFIDENCE.HIGH : gates.length >= 3 ? CONFIDENCE.MEDIUM : CONFIDENCE.LOW;
  if (lineupPending && confidence === CONFIDENCE.HIGH) confidence = CONFIDENCE.MEDIUM;
  else if (lineupPending && confidence === CONFIDENCE.MEDIUM) confidence = CONFIDENCE.LOW;

  const sideTarget = pick.contract_title
    ? `${pick.contract_title}${pick.game ? ` — ${pick.game}` : ''}`
    : (pick.game ?? pick.market_title ?? 'MISSING');

  const analysisBits = [];
  if (pick.edge_pp != null) {
    // Edge reference: prefer the market-neutral composite fair_value; if the
    // composite produced no probability, fall back to the book-derived
    // market_reference_prob (renamed from fair_value in 3f46ae8 so it is NOT
    // mistaken for the composite). Label the source honestly and never emit NaN.
    const composite = pick.fair_value != null && Number.isFinite(Number(pick.fair_value)) ? Number(pick.fair_value) : null;
    const bookRef = pick.market_reference_prob != null && Number.isFinite(Number(pick.market_reference_prob)) ? Number(pick.market_reference_prob) : null;
    const refProb = composite ?? bookRef;
    const refLabel = composite != null ? 'model fair' : (bookRef != null ? 'book-ref (not composite)' : 'ref');
    const refPct = refProb != null ? `${(refProb * 100).toFixed(0)}%` : 'MISSING';
    const mktPct = Number.isFinite(Number(pick.kalshi_ask)) ? `${(Number(pick.kalshi_ask) * 100).toFixed(0)}%` : 'MISSING';
    analysisBits.push(`${refLabel} ${refPct} vs market ${mktPct} = ${pick.edge_pp >= 0 ? '+' : ''}${Number(pick.edge_pp).toFixed(1)}pp`);
  }
  if (pick.dk_line != null) analysisBits.push(`book line ${pick.dk_line}`);
  if (cls === 'CORRELATED_ALTERNATE') analysisBits.push('reference-only: primary pick selected elsewhere in correlation group');
  if (lineupPending) analysisBits.push('pre-lineup: do not enter until lineup confirmed');
  const analysis = analysisBits.length ? analysisBits.join('; ') : `classification ${cls}`;

  const trigger = {
    price: pick.target_entry ?? null,
    event: lineupPending ? 'lineup confirmation' : (pick.target_entry != null ? 'price reaches target entry' : 'MISSING'),
  };

  return buildDecisionRow({
    marketTicker: pick.market_ticker ?? 'MISSING',
    sideTarget,
    marketType: pick.market_lane ?? 'mlb',
    settlementSummary: pick.market_title ?? pick.contract_title ?? 'MLB market settlement per Kalshi listing',
    composite: {
      score: pick.fair_value != null ? Math.round(Number(pick.fair_value) * 1000) / 10 : null,
      posture,
      layersPresent: gates.length,
      layersTotal: gates.length + missing.length,
      topEvidenceLayers: gates.map((g) => String(g).split(':')[0]),
      missingLayers: missing,
      modelProbability: pick.fair_value ?? null,
    },
    market: {
      yes_ask: pick.kalshi_ask ?? null,
      yes_bid: pick.kalshi_bid ?? null,
      last_price: pick.kalshi_last ?? null,
    },
    fair: { probability: pick.fair_value ?? null },
    confidence,
    analysis,
    trigger,
    statusOverride: status,
    requireModelScore: true,
  });
}

function articleReportPathForGame(stateRoot, date, eventTicker) {
  const gameKey = String(eventTicker ?? '').replace(/^KXMLBGAME-/, '');
  if (!gameKey) return null;
  return resolve(stateRoot, 'mlb', date, 'article-reports', `game-${gameKey}.txt`);
}

function trimArticleHeadline(text = '') {
  const lines = String(text).trimEnd().split(/\r?\n/);
  if (lines.length >= 3 && lines[1] && /^=+$/.test(lines[1].trim())) {
    let idx = 2;
    while (idx < lines.length && !lines[idx].trim()) idx += 1;
    return lines.slice(idx).join('\n').trimEnd();
  }
  return String(text).trimEnd();
}

function stripAuditArtifactsSection(text = '') {
  const raw = String(text);
  const marker = '\n=== 5. AUDIT ARTIFACTS ===';
  const idx = raw.indexOf(marker);
  return idx >= 0 ? raw.slice(0, idx).trimEnd() : raw.trimEnd();
}

function formatGamePacketLead({ event, date, statsRecord = null, packetLabel, generatedAtUtc = new Date().toISOString() }) {
  const display = buildEventDisplay(event);
  const matchupAbbrev = display.away_abbrev && display.home_abbrev
    ? `${display.away_abbrev} @ ${display.home_abbrev}`
    : (display.display_event_title !== 'MISSING' ? display.display_event_title : (event?.title ?? 'MISSING'));
  const matchupFull = display.away_full && display.home_full
    ? `${display.away_full} at ${display.home_full}`
    : (display.display_event_title !== 'MISSING'
      ? display.display_event_title
      : (event?.title ?? 'MISSING'));
  const firstPitch = event?.start_time_utc
    ?? event?.start_utc
    ?? statsRecord?.start_utc
    ?? statsRecord?.start_time_utc
    ?? 'MISSING';
  const venue = event?.venue
    ?? statsRecord?.venue
    ?? 'MISSING';

  return [
    `Captain's MLB Prediction Companion`,
    `Captain MLB — ${matchupAbbrev} ${packetLabel}`,
    matchupFull,
    `Date: ${date} | First pitch: ${firstPitch} | Venue: ${venue}`,
    `CPC Packet: ${packetLabel} | generated_utc: ${generatedAtUtc}`,
  ].join('\n');
}

export function classifyGamePacketRead(gamePicks = [], event = null, { hasModelProjection = false } = {}) {
  const picks = Array.isArray(gamePicks) ? gamePicks : [];
  const primary = selectPrimaryScoringPick(picks);
  const lineupPending = picks.some((p) =>
    Array.isArray(p?.missing_confirmations) && p.missing_confirmations.some((m) => /lineup/i.test(String(m))));
  const actionableLanes = new Set(
    picks
      .filter((p) => ['CLEAR_PICK', 'PRE_LINEUP_PICK', 'LEAN', 'WATCH_FOR_PRICE'].includes(String(p?.classification ?? '').toUpperCase()))
      .map((p) => String(p?.market_lane ?? p?.classification ?? '').toUpperCase())
      .filter(Boolean),
  );
  const modeledFamilies = new Set(
    picks
      .map((p) => String(p?.market_lane ?? '').toUpperCase())
      .filter(Boolean),
  );

  if (!primary) {
    return {
      call: 'NO CLEAR PICK',
      cpcRead: 'PASS',
      readLine: 'no rated view',
      scoringClassification: null,
      reason: 'no model family crosses the threshold',
      summary: 'model outputs remain provisional while no primary rated view is available',
      whatItMeans: 'CPC does not have enough source-backed model agreement to prefer a side.',
      evidenceStatus: 'blocked',
    };
  }

  const marketLabel = (() => {
    const ticker = String(primary.market_ticker ?? primary.ticker ?? '');
    const suffix = ticker.split('-').pop() || '';
    return /^[A-Z]{2,4}$/.test(suffix) ? suffix : (primary.contract_title ?? primary.market_title ?? 'favorite');
  })();

  const classification = String(primary.classification ?? '').toUpperCase();
  const hasModelScore = hasModelBackedScoringSignal(primary);
  const priceOnlyBlocked = picks.length > 0 && picks.every((pick) => {
    const pickClass = String(pick?.classification ?? '').toUpperCase();
    const missing = safeArray(pick?.missing_confirmations);
    return pickClass === 'BLOCKED_SOURCE_GAP'
      && missing.length > 0
      && missing.every((item) => /reference_price/i.test(String(item)));
  });

  if (['CLEAR_PICK', 'PRE_LINEUP_PICK', 'LEAN'].includes(classification)) {
    if (!hasModelScore) {
      return {
        call: 'NO CLEAR PICK',
        cpcRead: 'WATCH',
        readLine: 'monitor only — model-insufficient',
        scoringClassification: 'MODEL_INSUFFICIENT',
        reason: `${classification} lacks model-backed fair_value`,
        summary: `classification ${classification} withheld until a model-backed fair value/projection is present`,
        whatItMeans: `Scoring marked ${classification}, but CPC will not promote it without model-backed signal.`,
        evidenceStatus: lineupPending ? 'provisional_model_insufficient' : 'model_insufficient',
      };
    }
    const cpcRead = classification === 'CLEAR_PICK'
      ? 'PICK'
      : (classification === 'PRE_LINEUP_PICK' ? 'EVIDENCE_LEAN' : 'LEAN');
    return {
      call: `EVIDENCE LEAN — ${marketLabel}`,
      cpcRead,
      readLine: `${classification} — ${marketLabel}`,
      scoringClassification: classification,
      reason: 'required model families and context point the same way',
      summary: `model-backed scoring posture ${classification}; market price remains display-only`,
      whatItMeans: `Board scoring marked this game ${classification} (${marketLabel}).`,
      evidenceStatus: lineupPending ? 'provisional' : 'complete',
    };
  }

  if (priceOnlyBlocked && hasModelProjection) {
    return {
      call: 'NO CLEAR PICK',
      cpcRead: 'MODEL_ONLY',
      readLine: 'model read available; market-context blocked',
      scoringClassification: 'BLOCKED_SOURCE_GAP',
      reason: 'reference_price gap only — market-free model still renders',
      summary: 'scoring blocked on reference_price; composite/model layer is not price-dependent',
      whatItMeans: 'Reference price is missing, so board entry is blocked. Market-free projections still render below.',
      evidenceStatus: hasModelProjection ? 'model_ready_price_gap' : 'blocked',
    };
  }

  if (priceOnlyBlocked) {
    return {
      call: 'NO CLEAR PICK',
      cpcRead: 'BLOCKED',
      readLine: 'no rated view',
      scoringClassification: 'BLOCKED_SOURCE_GAP',
      reason: 'BLOCKED_MODEL_LAYER_MISSING: reference_price gap and stats-backed model projection unavailable',
      summary: 'reference_price gap plus missing stats-backed projection; no model read is claimed',
      whatItMeans: 'CPC cannot promote a market read or model projection until stats-backed inputs are available.',
      evidenceStatus: 'blocked_model_layer_missing',
    };
  }

  if (hasModelScore && classification === 'WATCH_FOR_PRICE') {
    return {
      call: `EVIDENCE LEAN — ${marketLabel}`,
      cpcRead: 'WATCH',
      readLine: `model read available — ${marketLabel}`,
      scoringClassification: classification,
      reason: 'required model families and context point the same way',
      summary: actionableLanes.size
        ? `modeled families present: ${Array.from(actionableLanes).join(', ')}`
        : 'modeled family data present',
      whatItMeans: `The current source-backed model prefers ${marketLabel}.`,
      evidenceStatus: lineupPending ? 'provisional' : 'complete',
    };
  }

  if (lineupPending) {
    return {
      call: 'NO CLEAR PICK',
      cpcRead: 'PASS',
      readLine: 'no rated view',
      scoringClassification: classification || null,
      reason: 'projections provisional due lineup',
      summary: actionableLanes.size
        ? `modeled families present: ${Array.from(actionableLanes).join(', ')}`
        : 'model outputs remain provisional',
      whatItMeans: 'CPC is waiting for lineup confirmation before promoting the model read.',
      evidenceStatus: 'provisional',
    };
  }

  if (actionableLanes.size > 1) {
    return {
      call: 'NO CLEAR PICK',
      cpcRead: 'PASS',
      readLine: 'monitor only',
      scoringClassification: classification || null,
      reason: 'modeled families disagree',
      summary: `modeled families present: ${Array.from(actionableLanes).join(', ')}`,
      whatItMeans: 'CPC sees mixed model-family signals, so the read stays neutral.',
      evidenceStatus: 'thin',
    };
  }

  if (actionableLanes.size === 1 || modeledFamilies.size === 1) {
    const family = actionableLanes.size === 1
      ? Array.from(actionableLanes)[0]
      : Array.from(modeledFamilies)[0];
    return {
      call: 'NO CLEAR PICK',
      cpcRead: 'PASS',
      readLine: 'monitor only',
      scoringClassification: classification || null,
      reason: 'single modeled family only',
      summary: `modeled families present: ${family}`,
      whatItMeans: 'CPC has one modeled family, but not enough cross-family support to promote the read.',
      evidenceStatus: 'thin',
    };
  }

  return {
    call: 'NO CLEAR PICK',
    cpcRead: 'PASS',
    readLine: 'no rated view',
    scoringClassification: classification || null,
    reason: 'no model family crosses the threshold',
    summary: modeledFamilies.size ? `modeled families present: ${Array.from(modeledFamilies).join(', ')}` : 'model outputs remain provisional',
    whatItMeans: 'CPC does not have enough source-backed model agreement to prefer a side.',
    evidenceStatus: 'unavailable',
  };
}

function pct(value, digits = 1) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return `${(value * 100).toFixed(digits)}%`;
}

function distMean(value) {
  const mean = distributionFloorMean(value);
  return typeof mean === 'number' && Number.isFinite(mean) ? mean : null;
}

function buildGamePreviewStory({ event = null, statsRecord = null, read = null, projections = null } = {}) {
  const awayTeam = statsRecord?.away_team ?? event?.away_team ?? event?.away_full ?? 'Away';
  const homeTeam = statsRecord?.home_team ?? event?.home_team ?? event?.home_full ?? 'Home';
  const awayStarter = statsRecord?.away_pitcher?.name ?? event?.away_starter ?? event?.away_pitcher ?? 'away starter';
  const homeStarter = statsRecord?.home_pitcher?.name ?? event?.home_starter ?? event?.home_pitcher ?? 'home starter';
  const call = String(read?.call ?? 'NO CLEAR PICK').trim() || 'NO CLEAR PICK';
  const reason = String(read?.reason ?? '').trim().toLowerCase();

  const moneylineHome = projections?.score?.outputs?.moneyline_home;
  const totalRuns = distMean(projections?.score?.outputs?.total_runs_distribution);
  const awayRuns = distMean(projections?.score?.outputs?.team_runs_distribution?.away);
  const homeRuns = distMean(projections?.score?.outputs?.team_runs_distribution?.home);
  const yrfi = projections?.yrfi?.outputs?.yrfi_prob;
  const awayKs = distMean(projections?.ks_away?.outputs?.distribution);
  const homeKs = distMean(projections?.ks_home?.outputs?.distribution);

  const lines = [];

  if (typeof moneylineHome === 'number' && Number.isFinite(moneylineHome) && typeof awayRuns === 'number' && typeof homeRuns === 'number') {
    const awayWinProb = 1 - moneylineHome;
    const leanTeam = awayWinProb >= moneylineHome ? awayTeam : homeTeam;
    const leanRuns = awayWinProb >= moneylineHome
      ? `${awayTeam} ${awayRuns.toFixed(1)} to ${homeRuns.toFixed(1)}`
      : `${homeTeam} ${homeRuns.toFixed(1)} to ${awayRuns.toFixed(1)}`;
    const leanProb = awayWinProb >= moneylineHome ? awayWinProb : moneylineHome;
    lines.push(`The model leans ${leanTeam} because the projected run split favors ${leanRuns} and the win split lands at ${pct(leanProb)}.`);
  } else {
    lines.push(`Starter matchup: ${awayStarter} vs ${homeStarter}; ${awayTeam} at ${homeTeam} still reads through the sourced model layer.`);
  }

  if (call === 'NO CLEAR PICK') {
    if (reason.includes('single modeled family only')) {
      lines.push(`This remains NO CLEAR PICK because only the MONEYLINE family is fully modeled, so there is no cross-family confirmation to promote it.`);
    } else if (reason.includes('projections provisional due lineup')) {
      lines.push(`This remains NO CLEAR PICK because the line is still provisional on lineup alpha, so the model output cannot be promoted yet.`);
    } else {
      lines.push(`This remains NO CLEAR PICK because ${read?.reason ?? 'the model does not yet clear the internal promotion threshold'}.`);
    }
  } else {
    lines.push(`Current call: ${call}.`);
  }

  const shapeParts = [];
  if (totalRuns !== null) shapeParts.push(`projected total ~${totalRuns.toFixed(1)}`);
  if (yrfi !== null) shapeParts.push(`YRFI ${pct(yrfi, 0)}`);
  if (shapeParts.length) {
    const shapeLead = totalRuns !== null && totalRuns >= 9 ? 'Game shape is offense-friendly' : 'Game shape';
    lines.push(`${shapeLead}: ${shapeParts.join(' with ')}.`);
  }

  const pitchParts = [];
  if (typeof awayKs === 'number') pitchParts.push(`${awayStarter} projects around ${awayKs.toFixed(1)} K`);
  if (typeof homeKs === 'number') pitchParts.push(`${homeStarter} projects around ${homeKs.toFixed(1)} K`);
  if (pitchParts.length) {
    lines.push(`Pitching context: ${pitchParts.join(' while ')}.`);
  }

  if (call === 'NO CLEAR PICK') {
    lines.push('Upgrade trigger: add a confirmed second modeled family or a stronger lane-specific threshold before this moves off no clear pick.');
  }

  return lines.slice(0, 6);
}

function renderGamePacketSourceLedger({ sourceRefs = {}, gamePicks = [], statsRecord = null } = {}) {
  const hasRef = (value) => Boolean(String(value ?? '').trim());
  const backed = (value) => (hasRef(value) ? 'BACKED' : 'UNAVAILABLE');
  const lines = ['Source Ledger'];
  lines.push(`  MLB_OFFICIAL: ${backed(sourceRefs.official ?? sourceRefs.event)}`);
  lines.push(`  STATS_ADAPTER: ${backed(sourceRefs.stats)}`);
  lines.push(`  WEATHER_ADAPTER: ${backed(sourceRefs.weather)}`);
  lines.push(`  CONTEXT_ADAPTER: ${backed(sourceRefs.context)}`);
  lines.push(`  MODEL_OUTPUT: ${Array.isArray(gamePicks) && gamePicks.length ? 'BACKED' : 'UNAVAILABLE'}`);
  lines.push('  AUDIT_ARTIFACTS_AVAILABLE: yes (customer text omits local paths; artifacts stay in inventory/meta/audit files).');
  if (statsRecord?.game_pk != null) {
    lines.push(`  GAME_PK: ${statsRecord.game_pk}`);
  }
  return lines.join('\n');
}

/**
 * Build the compact, sectioned MLB slate packet from picks.json scoring rows.
 * Returns { text, rows, inventoryText, counts } or null if no scoring exists.
 * The main user-facing text contains ONLY the sectioned decision board (TLDR +
 * Top Edge / Watchlist / Fades / Blocked + audit pointers). The full per-pick
 * inventory goes to a separate audit artifact, never the packet body.
 */
export function buildMlbSlatePacket({ date, scoring, artifacts = [], inventoryPath = null, scope = null, sourceRefs = {}, hrProjections = [] }) {
  if (!scoring || !Array.isArray(scoring.picks) || !scoring.picks.length) return null;
  const resolvedScope = resolvePacketScope({
    explicit: scope,
    hasScoring: true,
    perGame: false,
  });
  // Skip pure reference rows from the headline board so we don't pad sections,
  // but keep them in the inventory artifact.
  const allRows = scoring.picks.map((p) => mlbPickToDecisionRow(p));
  const boardRows = allRows.filter((r) => r.market_type !== 'correlated_alternate');

  const lineupPending = scoring.picks.filter((p) =>
    Array.isArray(p.missing_confirmations) && p.missing_confirmations.some((m) => /lineup/i.test(String(m)))).length;

  const tldrNote = lineupPending
    ? `Pre-lineup slate: ${lineupPending} pick(s) await confirmed lineups — confidence is downgraded, not the board.`
    : 'Lineups confirmed where available.';

  const body = renderSectionedPacket(boardRows, {
    tldrNote,
    auditArtifacts: [],
    perSectionLimit: 14,
  });
  const cleanedBody = stripAuditArtifactsSection(body);

  const header = [
    "Captain's MLB Prediction Companion",
    'Captain MLB — Daily Slate Board',
    `CPC Packet: Daily Slate Board`,
    `date: ${date}`,
    `packet_type: ${PACKET_TYPE}`,
    `generated_utc: ${new Date().toISOString()}`,
  ].join('\n');
  const inputStatusNote = buildPacketScopeNote({
    scope: resolvedScope,
    gamePicks: scoring.picks,
  });
  const neutralityNote = 'Composite scoring is market-neutral: model fair_value never reads market price. Edge = fair − implied.';
  const readyHr = hrProjections.flatMap((projection) => projection?.outputs ?? [])
    .filter((row) => row?.status === 'ready');
  const hrSection = [
    'Anytime-HR Model',
    ...(readyHr.length
      ? readyHr.slice(0, 12).map((row) => `  ${row.player?.player_name ?? `MLB ${row.player?.mlb_id}`}: ${(row.outputs.probability_at_least_one_hr * 100).toFixed(1)}% at least one HR; per-PA ${(row.outputs.per_pa_probability * 100).toFixed(2)}%; expected PA ${row.outputs.expected_pa.toFixed(2)}.`)
      : ['  MODEL_INSUFFICIENT — no confirmed, uniquely matched batter evidence is attached to this slate.']),
  ].join('\n');
  const text = [header, inputStatusNote, neutralityNote, cleanedBody, hrSection, packetFooter()].filter(Boolean).join('\n\n');

  // Full per-pick inventory -> audit artifact only. Each line carries model and
  // market fields together for routing/audit; pricing here is NOT a score input.
  const inventoryLines = allRows.map((r, i) =>
    `#${i + 1} [${r.edge_status}] ${r.market_ticker} :: ${r.side_target} | fair=${r.fair_probability_or_range} score=${r.composite_score} implied=${r.implied_probability} ask=${r.market_yes_ask} edge=${r.edge_cents_or_pp === null ? 'MISSING' : `${r.edge_cents_or_pp}pp`} conf=${r.confidence}`);
  const inventoryText = buildInventoryArtifact({
    marketType: 'mlb',
    date,
    eventTicker: `MLB-SLATE-${date}`,
    inventoryLines: [
      ...inventoryLines,
      ...hrProjections.flatMap((projection) => (projection?.outputs ?? []).map((row) =>
        `HR_MODEL player=${row.player?.player_name ?? row.player?.mlb_id ?? 'UNKNOWN'} status=${row.model_status} any_hr=${row.outputs?.probability_at_least_one_hr ?? 'MODEL_INSUFFICIENT'} blocked=${row.blocked_reasons?.join('|') || 'none'}`)),
    ],
    meta: { summary_counts: JSON.stringify(scoring.summaryCounts ?? {}), board_rows: boardRows.length, total_rows: allRows.length },
  });
  const assumptionsLedger = buildPacketAssumptionsLedger({
    scope: resolvedScope,
    date,
    scoring,
    gamePicks: scoring.picks,
    hrProjection: {
      outputs: hrProjections.flatMap((projection) => projection?.outputs ?? []),
    },
    sourceRefs: {
      scoring: sourceRefs.scoring ?? scoring.source ?? null,
      event: sourceRefs.event ?? scoring.source ?? null,
    },
  });

  return {
    text,
    rows: boardRows,
    inventoryText,
    assumptionsLedger,
    counts: { total: allRows.length, board: boardRows.length, lineupPending },
  };
}

function buildMlbPacketProcess({ event = null, marketCount = 0, artifacts = [] }) {
  const hasParticipants = Boolean(event?.title || event?.sub_title || marketCount > 0);
  return evaluateDecisionProcess({
    marketType: MARKET_TYPES.SPORTS_GAME,
    rawDecision: 'WATCH',
    forceWatch: true,
    checked: {
      projected_participants: hasParticipants,
      lineup_injury_news: false,
      venue_context: false,
      recent_form_matchup: false,
      market_board_context: marketCount > 0,
      evidence_supported_side: false,
    },
    topEvidence: [
      marketCount > 0 ? `Kalshi MLB board captured with ${marketCount} market(s).` : null,
      artifacts.length ? `${artifacts.length} local MLB artifact(s) available.` : null,
    ].filter(Boolean),
    settlementRules: 'MLB market settlement criteria not independently pulled by this packet.',
    verifiedFacts: hasParticipants ? 'Game/event identity captured; lineup, starter, weather, and matchup context still required.' : 'No game identity verified.',
    marketSignalText: marketCount > 0 ? 'Market board captured for research; no pick inferred.' : 'No market board captured.',
    socialChatter: 'Not used as verified fact.',
    inference: 'MLB inference blocked until starters, lineups/news, venue/weather, and matchup context are complete.',
    skepticReview: 'MISSING: no skeptic review in packet generator.',
    finalJudgment: 'WATCH only; no evidence lean from market board alone.',
    wouldChangeView: [
      'Probable/confirmed starters and lineups are available.',
      'Weather/park and recent matchup context support the same side as a board signal.',
      'A starter scratch, lineup surprise, or weather change invalidates the setup.',
    ],
  });
}

export function primeMlbResearch(date, options = {}) {
  const runner = options.runner;
  const cwd = options.cwd ?? process.cwd();
  const commands = [
    ['node', ['scripts/mlb/mlb-workspace.mjs', 'discover', '--date', date, '--live-readonly', '--source', 'all']],
    ['node', ['scripts/mlb/mlb-workspace.mjs', 'outputs', '--date', date]],
  ];
  const attempts = [];
  for (const [command, args] of commands) {
    const result = runPacketCommand(command, args, { cwd, runner });
    attempts.push(result);
    if (!result.ok) break;
  }
  return attempts;
}

export function locateMlbArtifacts(stateRoot, date) {
  const root = resolve(stateRoot, 'mlb');
  if (!existsSync(root)) return [];
  const hits = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try { entries = readdirSync(cur); } catch { continue; }
    for (const e of entries) {
      const p = join(cur, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) {
        if (e === date || p.endsWith(`/${date}`)) {
          try {
            for (const f of readdirSync(p)) {
              const fp = join(p, f);
              if (statSync(fp).isFile() && f.endsWith('.json')) hits.push(fp);
            }
          } catch {}
        } else {
          stack.push(p);
        }
      }
    }
  }
  return hits;
}

/**
 * Read MLB workflow slate_manifest.json files and normalize to a flat list of
 * { game_id, matchup, start_utc, away, home } records. Tolerates missing/bad
 * files. Used by tests and as a fallback when no Kalshi events are available.
 */
export function extractGames(paths = []) {
  const out = [];
  for (const p of paths) {
    if (!p || !existsSync(p)) continue;
    let raw;
    try { raw = readFileSync(p, 'utf8'); } catch { continue; }
    let json;
    try { json = JSON.parse(raw); } catch { continue; }
    const games = Array.isArray(json?.games) ? json.games : [];
    for (const g of games) {
      if (!g) continue;
      out.push({
        game_id: g.game_pk ?? g.game_id ?? null,
        matchup: g.game || g.matchup
          || (g.teams ? `${g.teams.away ?? '?'} at ${g.teams.home ?? '?'}` : 'MISSING'),
        start_utc: g.start_time_utc || g.start_utc || null,
        away: g.teams?.away ?? g.away ?? null,
        home: g.teams?.home ?? g.home ?? null,
      });
    }
  }
  return out;
}

// Projection-FIRST read for one game. Renders what the MODEL layer projects
// (win prob, total/team runs, YRFI, Ks, HR) through the price-isolated
// projection contracts + language — NEVER a board line or an over/under call.
//
// Inputs are derived ONLY from confirmation gaps (lineup/roof/weather), never
// from market price, odds, or board shape. We do NOT fabricate projection
// outputs: with no model outputs available the contracts return blocked /
// provisional, and the language layer states that honestly. This is the wire
// that lets real model outputs flow the moment they exist.
export function buildProjectionFirstBlock({ date, gamePicks = [], statsRecord = null, leagueRPG = null, projections = null } = {}) {
  const picks = Array.isArray(gamePicks) ? gamePicks : [];
  const as_of = `${date || 'unknown-date'}T00:00:00Z`;
  const FOOTER = 'Projection layer only — model outputs feed this read; no market signal does.';

  // Team names: prefer the matched stats record, else parse "Away at Home".
  let away = statsRecord?.away_team || 'Away';
  let home = statsRecord?.home_team || 'Home';
  const gameStr = picks.find((p) => typeof p?.game === 'string' && / at /.test(p.game))?.game;
  if (!statsRecord && gameStr) {
    const [a, h] = gameStr.split(' at ');
    if (a?.trim()) away = a.trim();
    if (h?.trim()) home = h.trim();
  }

  // Confirmation-derived status — NOT price-derived. Honest default is
  // UNCONFIRMED (this is the pre-final-lineup packet): we only call a lineup
  // confirmed on a POSITIVE signal, never on the mere absence of a pending
  // token (some lanes simply don't gate on lineups). So real projections render
  // as provisional until lineups actually post.
  const allMissing = picks.flatMap((p) => (Array.isArray(p.missing_confirmations) ? p.missing_confirmations : []));
  const passedText = picks.flatMap((p) => (Array.isArray(p.gates_passed) ? p.gates_passed : [])).join(' | ').toLowerCase();
  const lineupConfirmed = /lineup/.test(passedText) && /confirm/.test(passedText) && !/pending|soft/.test(passedText);
  const lineup_status = lineupConfirmed ? 'confirmed' : ((picks.length || statsRecord) ? 'unconfirmed' : null);
  const weather_status = picks.length
    ? (allMissing.some((m) => /roof|weather/i.test(String(m))) ? 'partial' : 'complete')
    : null;

  // ---- Real projections when a public-stats record matched this game ----
  if (statsRecord) {
    const proj = projections ?? buildGameProjections({ record: statsRecord, leagueRPG, as_of, lineup_status, weather_status });
    const apName = statsRecord.away_pitcher?.name || `${away} starter`;
    const hpName = statsRecord.home_pitcher?.name || `${home} starter`;
    return [
      '--- PROJECTION-FIRST READ (model layer, market-free) ---',
      describeMoneyline(proj.score, { home_team: home, away_team: away }),
      describeRunline(proj.score, { home_team: home }),
      describeTotal(proj.score),
      describeTeamRuns(proj.score, 'home', home),
      describeTeamRuns(proj.score, 'away', away),
      describeYrfi(proj.yrfi),
      describeKs(proj.ks_away, apName),
      describeKs(proj.ks_home, hpName),
      describeHr(proj.hr),
      FOOTER,
    ];
  }

  // ---- No matched inputs: honest blocked read, never fabricated ----
  const game_id = String(picks[0]?.matched_game_pk ?? picks[0]?.event_ticker ?? 'unknown');
  const park = picks[0]?.matched_game_pk != null ? { id: String(picks[0].matched_game_pk), roof: null } : null;
  const common = { game_id, as_of, lineup_status, weather_status };
  const score = buildScoreEngineProjection({ ...common, inputs: { park }, outputs: null });
  const yrfi = buildYrfiProjection({ ...common, inputs: { park }, outputs: null });
  const ks = buildKsProjection({ game_id, as_of, lineup_status, inputs: {}, outputs: null });

  return [
    '--- PROJECTION-FIRST READ (model layer, market-free) ---',
    describeMoneyline(score, { home_team: home, away_team: away }),
    describeTotal(score),
    describeTeamRuns(score, 'home', home),
    describeTeamRuns(score, 'away', away),
    describeYrfi(yrfi),
    describeKs(ks),
    describeHr({ status: 'blocked', blocked_reasons: ['MODEL_INPUTS_MISSING'], outputs: [] }),
    FOOTER,
  ];
}

export function buildKalshiGamePacket({
  date,
  event,
  stateRoot = 'state',
  artifacts,
  primeAttempts,
  kalshiSummary,
  sourcePath,
  gamePicks,
  statsRecord = null,
  leagueRPG = null,
  scope = null,
  sourceRefs = {},
}) {
  const s = summarizeEvent(event);
  const block = renderMarketBlocks(event, { limit: 40 });
  const process = buildMlbPacketProcess({ event, marketCount: block.marketCount, artifacts });
  const hasComposite = Array.isArray(gamePicks) && gamePicks.length > 0;
  const resolvedScope = resolvePacketScope({
    explicit: scope,
    hasScoring: hasComposite,
    perGame: true,
  });
  const lines = [];
  const packetStatusSnapshot = derivePacketStatusSnapshot({ gamePicks, statsRecord });
  const packetProjections = statsRecord
    ? buildGameProjections({
      record: statsRecord,
      leagueRPG,
      as_of: `${date || 'unknown-date'}T00:00:00Z`,
      lineup_status: packetStatusSnapshot.lineup_status,
      weather_status: packetStatusSnapshot.weather_status,
    })
    : null;

  if (hasComposite) {
    const read = classifyGamePacketRead(gamePicks, event, { hasModelProjection: Boolean(statsRecord) });
    lines.push('TLDR');
    lines.push(`  Call: ${read.call}.`);
    lines.push(`  Why: ${read.reason}.`);
    lines.push(`  Model summary: ${read.summary}.`);
    lines.push('  Context: starters, lineup status, weather/park, and recent form sourced from adapters.');
    lines.push('  Market data is display-only and NOT IN SCORE.');
    lines.push('');
    lines.push('Research Status');
    lines.push(`  ${buildPacketScopeNote({ scope: resolvedScope, gamePicks, statsRecord })}`);
    lines.push('');
    lines.push('Event Preview / Storyline');
    for (const storyLine of buildGamePreviewStory({ event, statsRecord, read, projections: packetProjections })) {
      lines.push(`  ${storyLine}`);
    }
    lines.push('');
  } else {
    lines.push('TLDR');
    lines.push('  Call: NO CLEAR PICK.');
    lines.push('  Why: no MLB event with a composite-ready game packet was found.');
    lines.push('  Model summary: model outputs are unavailable.');
    lines.push('  Context: no scored game inputs were attached.');
    lines.push('  Market data is display-only and NOT IN SCORE.');
    lines.push('');
    lines.push('Research Status');
    lines.push(`  ${buildPacketScopeNote({ scope: resolvedScope, gamePicks, statsRecord })}`);
    lines.push('');
    lines.push('Event Preview / Storyline');
    for (const storyLine of buildGamePreviewStory({ event, statsRecord, read: { call: 'NO CLEAR PICK' } })) {
      lines.push(`  ${storyLine}`);
    }
    lines.push('');
  }

  lines.push('');
  lines.push('Game Model Results');
  lines.push('');
  for (const l of buildProjectionFirstBlock({ date, gamePicks, statsRecord, leagueRPG, projections: packetProjections })) lines.push(l);
  lines.push('');
  lines.push(renderGamePacketSourceLedger({ sourceRefs, gamePicks, statsRecord }));
  lines.push('');

  const inventoryLines = [];
  inventoryLines.push(`event_ticker: ${s.ticker}`);
  inventoryLines.push(`event_title: ${s.title}`);
  inventoryLines.push(`event_sub_title: ${s.sub_title || 'MISSING'}`);
  const evDisp = buildEventDisplay(event);
  inventoryLines.push(`display_event_title: ${evDisp.display_event_title}`);
  inventoryLines.push(`display_name_status: ${evDisp.display_name_status}`);
  inventoryLines.push(`series_ticker: ${s.series}`);
  inventoryLines.push(`market_count: ${s.marketCount}`);
  inventoryLines.push(`close_time_utc: ${s.close}`);
  inventoryLines.push(`hr_model_status: ${packetProjections?.hr?.model_status ?? 'MODEL_INSUFFICIENT'}`);
  for (const row of packetProjections?.hr?.outputs ?? []) {
    inventoryLines.push(`hr_model_player: ${row.player?.player_name ?? row.player?.mlb_id ?? 'UNKNOWN'} | status=${row.model_status} | any_hr=${row.outputs?.probability_at_least_one_hr ?? 'MODEL_INSUFFICIENT'}`);
  }
  inventoryLines.push('');
  inventoryLines.push('markets:');
  for (const l of block.lines) inventoryLines.push(l);
  const rawMarkets = Array.isArray(event?.markets) ? event.markets : [];
  if (rawMarkets.length) {
    inventoryLines.push('');
    inventoryLines.push('market_display:');
    for (const raw of rawMarkets) {
      const m = normalizeMarket(raw);
      const md = buildMarketDisplay(m, evDisp);
      inventoryLines.push(`  - market_ticker: ${m.ticker || 'MISSING'}`);
      inventoryLines.push(`    display_market_title: ${md.display_market_title}`);
      inventoryLines.push(`    display_yes_label: ${md.display_yes_label}`);
      inventoryLines.push(`    display_no_label: ${md.display_no_label}`);
      inventoryLines.push(`    display_name_status: ${md.display_name_status}`);
    }
  }

  const assumptionsLedger = buildPacketAssumptionsLedger({
    scope: resolvedScope,
    date,
    game: s,
    gameId: statsRecord?.game_pk ?? s.ticker,
    gamePicks,
    statsRecord,
    hrProjection: packetProjections?.hr ?? null,
    sourceRefs: {
      event: sourceRefs.event ?? sourcePath ?? null,
      scoring: sourceRefs.scoring ?? sourcePath ?? null,
      stats: sourceRefs.stats ?? null,
      weather: sourceRefs.weather ?? null,
      context: sourceRefs.context ?? null,
    },
  });

  const lead = formatGamePacketLead({
    event,
    date,
    statsRecord,
    packetLabel: hasComposite ? 'Game Board' : 'Pre-Final-Lineup',
  });

  return {
    text: [lead, lines.join('\n'), packetFooter()].filter(Boolean).join('\n\n'),
    inventoryText: inventoryLines.join('\n'),
    marketCount: block.marketCount,
    missingStrikeCount: block.missingStrikeCount,
    missingMarkets: block.missingMarkets,
    assumptionsLedger,
    hrProjection: packetProjections?.hr ?? null,
  };
}

function buildEmptyPacket({ date, artifacts, primeAttempts, kalshiSummary }) {
  const process = evaluateDecisionProcess({
    marketType: MARKET_TYPES.SPORTS_GAME,
    rawDecision: 'NO CLEAR PICK',
    checked: {},
    settlementRules: 'MISSING: no MLB event packet.',
    verifiedFacts: 'MISSING: no matching MLB events discovered.',
    marketSignalText: 'No market board captured.',
    socialChatter: 'Not used.',
    inference: 'No inference.',
    skepticReview: 'MISSING.',
    finalJudgment: 'NO CLEAR PICK.',
  });
  const header = [
    "Captain's MLB Prediction Companion",
    'Captain MLB — Pre-Final-Lineup',
    'CPC Packet: Pre-Final-Lineup',
    `date: ${date}`,
    `packet_type: ${PACKET_TYPE}`,
    `generated_utc: ${new Date().toISOString()}`,
  ].join('\n');
  const lines = [];
  lines.push('TLDR:');
  lines.push(`  market_type: ${process.marketType}`);
  lines.push(`  decision_status: ${process.decisionStatus}`);
  lines.push('  note: no MLB events found; no pick or lean.');
  lines.push('');
  lines.push(renderDecisionProcess(process, { heading: 'Research Completeness' }));
  lines.push('');
  lines.push('research_prime:');
  if (primeAttempts.length) {
    for (const attempt of primeAttempts) {
      lines.push(`  - command: ${attempt.label}`);
      lines.push(`    status: ${attempt.ok ? 'ok' : 'MISSING'}`);
      if (!attempt.ok) lines.push(`    error: ${attempt.error || attempt.stderr || 'command failed'}`);
    }
  } else {
    lines.push('  - MISSING: no discovery command attempted');
  }
  lines.push('');
  if (kalshiSummary) {
    lines.push('kalshi_discovery:');
    lines.push(`  source_page: ${KALSHI_SOURCES.mlb.page_url}`);
    lines.push(`  source_api: ${KALSHI_SOURCES.mlb.api_url}`);
    lines.push(`  reachable: ${kalshiSummary.ok ? 'yes' : 'no'}`);
    lines.push(`  total_events: ${kalshiSummary.total}`);
    lines.push(`  window_matched: ${kalshiSummary.matched}`);
    if (kalshiSummary.error) lines.push(`  error: ${kalshiSummary.error}`);
    lines.push('');
  }
  lines.push('status: MISSING');
  lines.push(`reason: no Kalshi MLB events with derived event-date ${date}.`);
  return [header, lines.join('\n'), packetFooter()].filter(Boolean).join('\n\n');
}

async function main() {
  const opts = parseMlbDailyArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node scripts/packets/generate-mlb-daily.mjs --date YYYY-MM-DD [--dry-run] [--scope FULL_DAY_PREVIEW|SLATE_PREVIEW|GAME_PACKET]');
    return;
  }
  const dir = ensurePacketDir(opts.stateRoot, opts.date, PACKET_TYPE);
  const primeAttempts = primeMlbResearch(opts.date);
  const artifacts = locateMlbArtifacts(opts.stateRoot, opts.date);
  const statsSourceRef = resolve(opts.stateRoot, 'mlb', opts.date, 'discovery', 'stats_adapter.json');
  const weatherSourceRef = resolve(opts.stateRoot, 'mlb', opts.date, 'discovery', 'weather_adapter.json');
  const contextSourceRef = resolve(opts.stateRoot, 'mlb', opts.date, 'discovery', 'context_adapter.json');
  const officialSourceRef = resolve(opts.stateRoot, 'mlb', opts.date, 'discovery', 'mlb_official_adapter.json');

  // Public-stats projection inputs (price-free). Drives real model-layer reads.
  const statsRecords = loadStatsRecords(opts.stateRoot, opts.date);
  const leagueRPG = leagueRunsPerGame(statsRecords);
  const slateHrProjections = statsRecords.map((record) => buildGameProjections({
    record,
    leagueRPG,
    as_of: `${opts.date}T00:00:00Z`,
    lineup_status: record?.lineup_status === 'confirmed' ? 'confirmed' : 'unconfirmed',
    weather_status: record?.weather_status ?? null,
  }).hr);

  const discovery = await fetchKalshiEvents('mlb');
  const dateFilter = filterByEventDate(opts.date, { windowDays: 0, allowUndated: false });
  const kalshiEvents = discovery.events.filter(dateFilter);

  let persistedCount = 0;
  if (kalshiEvents.length) {
    const p = persistEventArtifacts({ stateRoot: opts.stateRoot, sport: 'mlb', date: opts.date, events: kalshiEvents });
    persistedCount = p.written.length;
  }

  const kalshiSummary = {
    ok: discovery.ok,
    total: discovery.events.length,
    matched: kalshiEvents.length,
    error: discovery.error,
  };

  let totalMarketCount = 0;
  let missingMarketEventCount = 0;
  let missingStrikeTextCount = 0;
  const items = [];
  const primeMeta = primeAttempts.map(({ label, ok, status, stderr, error }) => ({ label, ok, status, stderr, error }));

  // PRIMARY OUTPUT: when the MLB scoring pipeline already produced picks.json,
  // emit the compact sectioned decision board as the headline packet and push
  // the full per-pick inventory to a separate audit artifact. This replaces the
  // old all-WATCH per-event dump as the main user-facing result.
  const scoring = loadMlbScoring(opts.stateRoot, opts.date);
  if (scoring) {
    const slateScope = resolvePacketScope({
      explicit: opts.scope,
      hasScoring: true,
      perGame: false,
    });
    const inventoryName = `${opts.date}-mlb-daily.inventory`;
    const slate = buildMlbSlatePacket({
      date: opts.date,
      scoring,
      artifacts,
      inventoryPath: join(dir, `${inventoryName}.txt`),
      scope: slateScope,
      sourceRefs: {
        scoring: scoring.source,
      },
      hrProjections: slateHrProjections,
    });
    if (slate) {
      const invW = writeAudit(dir, inventoryName, slate.inventoryText, {
        kind: 'raw_inventory_audit',
        total_rows: slate.counts.total,
        board_rows: slate.counts.board,
      });
      items.push({ name: 'mlb-daily.inventory', ...invW });
      const w = writeAudit(dir, `${opts.date}-mlb-daily-board`, slate.text, {
        kind: 'decision_board',
        board_rows: slate.counts.board,
        total_rows: slate.counts.total,
        lineup_pending: slate.counts.lineupPending,
        inventory_artifact: invW.txtPath ?? `${inventoryName}.txt`,
        scoring_source: scoring.source,
        research_prime: primeMeta,
        hr_model_ready_players: slateHrProjections.flatMap((projection) => projection?.outputs ?? []).filter((row) => row.status === 'ready').length,
        hr_model_market_inputs_used: false,
      });
      items.push({ name: 'mlb-daily-board', ...w });
      const assumptionsPath = writeScopedLedger(opts.stateRoot, opts.date, slateScope, slate.assumptionsLedger);
      items.push({ name: `mlb-assumptions-${slateScope.toLowerCase()}`, txtPath: assumptionsPath, chunkCount: 1 });
    }
  }

  if (!kalshiEvents.length) {
    const txt = buildEmptyPacket({ date: opts.date, artifacts, primeAttempts, kalshiSummary });
    const w = writeAudit(dir, `${opts.date}-mlb-daily-MISSING`, txt, {
      event_count: 0,
      total_market_count: 0,
      missing_market_count: 0,
      missing_strike_text_count: 0,
      artifact_count: artifacts.length,
      kalshi_discovery: kalshiSummary,
      research_prime: primeMeta,
    });
    items.push({ name: 'mlb-daily-MISSING', ...w });
  } else {
    const gameScope = resolvePacketScope({
      explicit: opts.scope,
      hasScoring: Boolean(scoring),
      perGame: true,
    });
    for (const ev of kalshiEvents) {
      const ticker = ev?.event_ticker;
      if (!ticker) continue;
      const sourcePath = resolve(opts.stateRoot, 'mlb', opts.date, 'kalshi-events', `${ticker.replace(/[^A-Z0-9_-]/gi, '_').slice(0, 80)}.json`);
      const gamePicks = scoring ? scoring.picks.filter((p) => p.event_ticker === ticker) : null;
      const statsRecord = matchStatsRecord(statsRecords, {
        eventTicker: ticker,
        awayName: ev?.away_team ?? '',
        homeName: ev?.home_team ?? '',
      });
      const built = buildKalshiGamePacket({
        date: opts.date,
        event: ev,
        stateRoot: opts.stateRoot,
        artifacts,
        primeAttempts,
        kalshiSummary,
        sourcePath,
        gamePicks,
        statsRecord,
        leagueRPG,
        scope: gameScope,
        sourceRefs: {
          event: sourcePath,
          stats: statsSourceRef,
          weather: weatherSourceRef,
          context: contextSourceRef,
          official: officialSourceRef,
        },
      });
      totalMarketCount += built.marketCount;
      if (built.missingMarkets) missingMarketEventCount += 1;
      missingStrikeTextCount += built.missingStrikeCount;
      if (built.inventoryText) {
        const invW = writeAudit(dir, `${opts.date}-${ticker}.inventory`, built.inventoryText, {
          kind: 'raw_inventory_audit',
          event_ticker: ticker,
          market_count: built.marketCount,
        });
        items.push({ name: `${ticker}.inventory`, ...invW });
      }
      const w = writeAudit(dir, `${opts.date}-${ticker}`, built.text, {
        event_ticker: ticker,
        market_count: built.marketCount,
        missing_markets: built.missingMarkets,
        missing_strike_text_count: built.missingStrikeCount,
        artifact_count: artifacts.length,
        has_composite: Array.isArray(gamePicks) && gamePicks.length > 0,
        kalshi_discovery: kalshiSummary,
        research_prime: primeMeta,
        hr_model_status: built.hrProjection?.model_status ?? 'MODEL_INSUFFICIENT',
        hr_model_ready_players: (built.hrProjection?.outputs ?? []).filter((row) => row.status === 'ready').length,
        hr_model_market_inputs_used: false,
      });
      items.push({ name: ticker, ...w });
      const assumptionsPath = writeScopedLedger(opts.stateRoot, opts.date, gameScope, built.assumptionsLedger, {
        gameId: statsRecord?.game_pk ?? ticker,
      });
      items.push({ name: `${ticker}.assumptions`, txtPath: assumptionsPath, chunkCount: 1 });
    }
  }

  let exitCode = 0;
  if (kalshiEvents.length > 0 && totalMarketCount === 0) {
    console.error(`[${PACKET_TYPE}] FAIL: ${kalshiEvents.length} events but zero markets total.`);
    exitCode = 2;
  }

  console.log(printDryRunSummary({ packetType: PACKET_TYPE, date: opts.date, dir, items }));
  console.log(`[${PACKET_TYPE}] summary event_count=${kalshiEvents.length} total_market_count=${totalMarketCount} packets_written=${items.length} missing_market_count=${missingMarketEventCount} missing_strike_text_count=${missingStrikeTextCount} persisted=${persistedCount} local_artifacts=${artifacts.length}`);
  if (exitCode) process.exit(exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`[${PACKET_TYPE}] error: ${err.message}`);
    process.exit(1);
  });
}
