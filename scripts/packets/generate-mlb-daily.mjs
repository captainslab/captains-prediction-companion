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
import { isNotYetStartedStatus } from './send-packets-telegram.mjs';
import { runComposite, loadDynamicCompositeSlate } from '../mlb/late-slate-composite-refresh.mjs';
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
  describeProjectedSpread,
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
import { writeJsonAtomic } from '../mlb/file-io.mjs';
import { hashRunRecordValue, writeRunRecord } from '../mlb/lib/mlb-run-record.mjs';
import { evaluateDecisionProcess, MARKET_TYPES, renderDecisionProcess } from '../shared/decision-process.mjs';
import {
  buildDecisionRow,
  renderDecisionBoard,
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

function proxyLineupLabel(statsRecord) {
  if (statsRecord?.lineup_status !== 'proxy') return null;
  const source = String(statsRecord?.hr_lineup_source ?? '').replace(/^LAST_LOCKED_LINEUP_PROXY\s*/i, '').trim();
  return `Lineup: PROXY ${source || 'from prior confirmed game'}`;
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
  const lineup_status = statsRecord?.lineup_status === 'proxy'
    ? 'proxy'
    : (lineupConfirmed ? 'confirmed' : ((picks.length || statsRecord) ? 'unconfirmed' : null));
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
  const lineupBasis = statsRecord?.lineup_status === 'proxy'
    ? (statsRecord.hr_lineup_source ?? 'LAST_LOCKED_LINEUP_PROXY')
    : picks.length
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
export function mlbPickToDecisionRow(pick = {}, { suppressLineupLanguage = false } = {}) {
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
  if (lineupPending && !suppressLineupLanguage) analysisBits.push('pre-lineup: do not enter until lineup confirmed');
  const analysis = analysisBits.length ? analysisBits.join('; ') : `classification ${cls}`;

  const trigger = {
    price: pick.target_entry ?? null,
    event: !suppressLineupLanguage && lineupPending
      ? 'lineup confirmation'
      : (pick.target_entry != null ? 'price reaches target entry' : 'MISSING'),
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

export function formatGamePacketLead({ event, date, statsRecord = null, packetLabel, generatedAtUtc = new Date().toISOString() }) {
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
  const gameStatus = statsRecord?.game_status == null
    ? ''
    : String(statsRecord.game_status).trim();
  const statusSuffix = gameStatus ? ` | Status: ${gameStatus}` : '';

  return [
    `Captain's MLB Prediction Companion`,
    `Captain MLB — ${matchupAbbrev} ${packetLabel}`,
    matchupFull,
    `Date: ${date} | First pitch: ${firstPitch} | Venue: ${venue}${statusSuffix}`,
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
      call: `EVIDENCE LEAN — ${marketLabel}`,
      cpcRead: 'MODEL_ONLY',
      readLine: 'model read available; market-context blocked',
      scoringClassification: 'LEAN',
      reason: 'reference_price gap only — model-backed posture stands',
      summary: 'model-backed scoring posture LEAN; market-edge comparison is omitted because reference_price is unavailable',
      whatItMeans: 'Reference price is unavailable, so market-edge comparison is omitted. The model-backed projection remains the active read.',
      evidenceStatus: 'model_ready_price_gap',
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

function slateTeamNames({ game = null, picks = [] } = {}) {
  const record = game?.statsRecord ?? game?.officialRecord ?? game ?? {};
  let away = record.away_team ?? record.away_full ?? record.away;
  let home = record.home_team ?? record.home_full ?? record.home;
  const matchup = picks.find((pick) => typeof pick?.game === 'string' && /\s+at\s+/i.test(pick.game))?.game;
  if ((!away || !home) && matchup) {
    const [parsedAway, parsedHome] = matchup.split(/\s+at\s+/i);
    away ??= parsedAway?.trim();
    home ??= parsedHome?.trim();
  }
  return { away: away || 'Away', home: home || 'Home' };
}

function slateGameKey(value = null) {
  if (value == null) return null;
  return String(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

function slateMatchupKey({ game = null, picks = [] } = {}) {
  const teams = slateTeamNames({ game, picks });
  return `${teams.away}|${teams.home}`.toLowerCase().replace(/[^a-z0-9|]+/g, '');
}

function slateRecordKey({ game = null, picks = [] } = {}) {
  const record = game?.statsRecord ?? game?.officialRecord ?? game ?? {};
  return slateGameKey(record.game_pk ?? record.event_ticker ?? record.ticker)
    ?? slateMatchupKey({ game, picks });
}

function slateGamePk(game = null) {
  return game?.officialRecord?.game_pk
    ?? game?.statsRecord?.game_pk
    ?? game?.contextRecord?.game_pk
    ?? game?.game_pk
    ?? null;
}

function slateGameStatus(game = null) {
  const sources = [
    game?.officialRecord,
    game?.statsRecord,
    game?.contextRecord,
    game,
  ];
  const values = [
    ...sources.map((source) => source?.mlb_status),
    ...sources.flatMap((source) => [source?.game_status, source?.status]),
  ];
  return String(values.find((value) => String(value ?? '').trim()) ?? 'UNKNOWN').trim() || 'UNKNOWN';
}

function slateGameHasStarted(status) {
  const normalized = String(status ?? '').trim();
  return Boolean(normalized) && normalized.toUpperCase() !== 'UNKNOWN' && !isNotYetStartedStatus(normalized);
}

function slatePickKey(pick = {}) {
  return slateGameKey(pick.matched_game_pk ?? pick.game_pk)
    ?? (pick.game ? slateMatchupKey({ picks: [pick] }) : null)
    ?? slateGameKey(pick.event_ticker ?? pick.ticker);
}

function slatePitcher({ game = null, side = 'away' } = {}) {
  const stats = game?.statsRecord ?? {};
  const official = game?.officialRecord ?? {};
  const context = game?.contextRecord ?? {};
  const pitcher = stats[`${side}_pitcher`]
    ?? stats.probable_pitchers?.[side]
    ?? context.probable_pitchers?.[side]
    ?? official.probable_pitchers?.[side]
    ?? null;
  const name = typeof pitcher === 'string'
    ? pitcher
    : pitcher?.name ?? pitcher?.fullName ?? pitcher?.full_name ?? null;
  const explicitStatus = String(
    pitcher?.status
      ?? pitcher?.starter_status
      ?? pitcher?.confirmation_status
      ?? stats[`${side}_starter_status`]
      ?? official[`${side}_starter_status`]
      ?? '',
  ).toLowerCase();
  const changed = pitcher?.changed === true
    || stats[`${side}_pitcher_changed`] === true
    || /changed|scratch|replacement/.test(explicitStatus);
  const confirmed = pitcher?.confirmed === true
    || /confirm|lock|official|starting/.test(explicitStatus);
  const status = changed ? 'CHANGED' : confirmed ? 'CONFIRMED' : 'EXPECTED';
  return `${name || 'MISSING'} — ${status}`;
}

function buildSlateGameProjection({ date, game = null, leagueRPG = null } = {}) {
  if (game?.projection) return game.projection;
  const statsRecord = game?.statsRecord ?? null;
  if (!statsRecord) return null;
  return buildGameProjections({
    record: statsRecord,
    leagueRPG,
    as_of: `${date || 'unknown-date'}T00:00:00Z`,
    lineup_status: statsRecord.lineup_status ?? 'proxy',
    weather_status: statsRecord.weather_status ?? null,
  });
}

function renderFullSlateGameBlock({ date, game, gamePicks = [], index, leagueRPG = null } = {}) {
  const teams = slateTeamNames({ game, picks: gamePicks });
  const record = game?.statsRecord ?? game?.officialRecord ?? game ?? {};
  const projection = buildSlateGameProjection({ date, game, leagueRPG });
  const score = projection?.score ?? {
    status: 'blocked',
    blocked_reasons: ['MODEL_INPUTS_MISSING'],
  };
  const awayRuns = score.status === 'blocked' ? null : projection?.means?.lambdaAway;
  const homeRuns = score.status === 'blocked' ? null : projection?.means?.lambdaHome;
  const event = {
    event_ticker: record.event_ticker ?? record.ticker,
    title: `${teams.away} at ${teams.home}`,
  };
  const read = classifyGamePacketRead(gamePicks, event, {
    hasModelProjection: Boolean(projection?.score && projection.score.status !== 'blocked'),
  });
  const modelPosture = projection?.score?.status === 'blocked'
    ? 'MODEL_INSUFFICIENT'
    : (read.cpcRead ?? read.call ?? 'PASS');
  const scoreText = Number.isFinite(awayRuns) && Number.isFinite(homeRuns)
    ? `${teams.away} ${awayRuns.toFixed(1)}, ${teams.home} ${homeRuns.toFixed(1)}`
    : 'not modeled — model inputs unavailable';
  const status = slateGameStatus(game);
  const firstPitch = game?.officialRecord?.start_time_utc
    ?? game?.officialRecord?.start_utc
    ?? game?.statsRecord?.start_utc
    ?? game?.statsRecord?.start_time_utc
    ?? record.start_time_utc
    ?? record.start_utc
    ?? 'MISSING';
  const venue = game?.officialRecord?.venue ?? game?.statsRecord?.venue ?? record.venue ?? 'MISSING';

  return [
    `GAME ${index}`,
    `${teams.away} AT ${teams.home}`,
    `STATUS: ${status}`,
    ...(slateGameHasStarted(status)
      ? ['PREGAME PROXY NOTICE: This is a pregame-proxy model context only, generated before/without knowledge of what has actually happened in the game, and does not reflect live in-game state.']
      : []),
    `FIRST PITCH: ${firstPitch}`,
    `VENUE: ${venue}`,
    'LINEUP MODE: LAST_LOCKED_LINEUP_PROXY',
    'STARTING PITCHERS:',
    `  ${teams.away}: ${slatePitcher({ game, side: 'away' })}`,
    `  ${teams.home}: ${slatePitcher({ game, side: 'home' })}`,
    `PROJECTED SCORE: ${scoreText}`,
    `CPC PROJECTED SPREAD: ${describeProjectedSpread(awayRuns, homeRuns, {
      away_team: teams.away,
      home_team: teams.home,
      status: score.status,
      blocked_reasons: score.blocked_reasons,
    })}`,
    `CPC PROJECTED TOTAL: ${describeTotal(score)}`,
    `WIN PROBABILITY: ${describeMoneyline(score, { home_team: teams.home, away_team: teams.away })}`,
    `YRFI/NRFI: ${describeYrfi(projection?.yrfi ?? {
      status: 'blocked',
      blocked_reasons: ['MODEL_INPUTS_MISSING'],
    })}`,
    `MODEL POSTURE: ${modelPosture}`,
  ].join('\n');
}

const SLATE_POSTURE_STRENGTH = Object.freeze({
  PICK: 5,
  MODEL_ONLY: 4,
  EVIDENCE_LEAN: 3,
  LEAN: 2,
  WATCH: 1,
  PASS: 0,
  BLOCKED: -1,
  MODEL_INSUFFICIENT: -2,
});

function buildFullSlateBoardEntries({ date, scoring, slateGames = [], leagueRPG = null } = {}) {
  const picks = safeArray(scoring?.picks);
  const groupedPicks = new Map();
  for (const pick of picks) {
    const key = slatePickKey(pick);
    if (!groupedPicks.has(key)) groupedPicks.set(key, []);
    groupedPicks.get(key).push(pick);
  }

  const scheduled = safeArray(slateGames).map((game) => ({
    ...game,
    picks: groupedPicks.get(slateRecordKey({ game }))
      ?? groupedPicks.get(slateMatchupKey({ game }))
      ?? [],
  }));
  const consumed = new Set(scheduled.flatMap((game) => game.picks.map(slatePickKey)));
  for (const [key, gamePicks] of groupedPicks) {
    if (gamePicks.some((pick) => consumed.has(slatePickKey(pick)))) continue;
    scheduled.push({ picks: gamePicks, officialRecord: { event_ticker: key } });
  }

  const entries = scheduled.map((game, index) => {
    // The slate runner normally supplies projection objects. For direct callers
    // and tests, build the same market-free projection once and pass it through
    // to the existing per-game renderer and the wrapper sections.
    const projection = game.projection ?? buildSlateGameProjection({ date, game, leagueRPG });
    const boardGame = game.projection == null && projection ? { ...game, projection } : game;
    const teams = slateTeamNames({ game: boardGame, picks: game.picks });
    const record = boardGame?.statsRecord ?? boardGame?.officialRecord ?? boardGame ?? {};
    const score = projection?.score ?? {
      status: 'blocked',
      blocked_reasons: ['MODEL_INPUTS_MISSING'],
    };
    const awayRuns = score.status === 'blocked' ? null : projection?.means?.lambdaAway;
    const homeRuns = score.status === 'blocked' ? null : projection?.means?.lambdaHome;
    const event = {
      event_ticker: record.event_ticker ?? record.ticker,
      title: `${teams.away} at ${teams.home}`,
    };
    const read = classifyGamePacketRead(game.picks, event, {
      hasModelProjection: Boolean(projection?.score && projection.score.status !== 'blocked'),
    });
    const modelPosture = projection?.score?.status === 'blocked'
      ? 'MODEL_INSUFFICIENT'
      : (read.cpcRead ?? read.call ?? 'PASS');
    const status = slateGameStatus(boardGame);
    const statusCandidates = [
      status,
      boardGame?.officialRecord?.mlb_status,
      boardGame?.statsRecord?.mlb_status,
      boardGame?.contextRecord?.mlb_status,
      boardGame?.officialRecord?.game_status,
      boardGame?.officialRecord?.status,
      boardGame?.statsRecord?.game_status,
      boardGame?.statsRecord?.status,
      boardGame?.contextRecord?.game_status,
      boardGame?.contextRecord?.status,
    ].map((value) => String(value ?? '').trim()).filter(Boolean);
    const operationsStatus = statusCandidates.find((value) => /delay|postpon|suspend|double\s*header/i.test(value)) ?? status;
    const totalRuns = distMean(score.outputs?.total_runs_distribution);
    const winProbability = score.outputs?.moneyline_home;
    const doubleheader = [boardGame, boardGame?.officialRecord, boardGame?.statsRecord, boardGame?.contextRecord]
      .some((source) => source?.doubleheader === true
        || /^(?:true|yes|y|1)$/i.test(String(source?.doubleheader ?? ''))
        || source?.is_doubleheader === true
        || source?.double_header === true
        || source?.doubleheader_game_number != null
        || /double\s*header/i.test(String(source?.series_description ?? source?.game_description ?? ''))
        || /double\s*header/i.test(String(source?.game_status ?? source?.status ?? '')));
    const delayed = statusCandidates.some((value) => /delay|postpon|suspend/i.test(value));
    return {
      date,
      game: boardGame,
      gamePicks: game.picks,
      index: index + 1,
      leagueRPG,
      teams,
      projection,
      score,
      awayRuns,
      homeRuns,
      totalRuns,
      winProbability,
      read,
      modelPosture,
      status,
      operationsStatus,
      delayed,
      doubleheader,
    };
  });

  const matchupGroups = new Map();
  for (const entry of entries) {
    const key = slateMatchupKey({ game: entry.game, picks: entry.gamePicks });
    const gamePk = slateGamePk(entry.game);
    if (!matchupGroups.has(key)) matchupGroups.set(key, { entries: [], gamePks: new Set() });
    const group = matchupGroups.get(key);
    group.entries.push(entry);
    if (gamePk != null) group.gamePks.add(String(gamePk));
  }
  for (const [key, group] of matchupGroups) {
    if (group.gamePks.size < 2) continue;
    for (const entry of group.entries) entry.doubleheaderGroupKey = key;
  }
  return entries.map((entry) => ({
    ...entry,
    doubleheader: entry.doubleheader || Boolean(entry.doubleheaderGroupKey),
  }));
}

function renderFullSlateBoardEntries(entries = []) {
  if (!entries.length) return 'FULL SLATE BOARD\n\n  MISSING — no scheduled game records were supplied.';
  return [
    'FULL SLATE BOARD',
    ...entries.map((entry) => renderFullSlateGameBlock({
      date: entry.date,
      game: entry.game,
      gamePicks: entry.gamePicks,
      index: entry.index,
      leagueRPG: entry.leagueRPG,
    })),
  ].join('\n\n');
}

function formatSlateScore(entry) {
  return Number.isFinite(entry.awayRuns) && Number.isFinite(entry.homeRuns)
    ? `${entry.teams.away} ${entry.awayRuns.toFixed(1)}, ${entry.teams.home} ${entry.homeRuns.toFixed(1)}`
    : 'not modeled — model inputs unavailable';
}

function slateSpreadText(entry) {
  return describeProjectedSpread(entry.awayRuns, entry.homeRuns, {
    away_team: entry.teams.away,
    home_team: entry.teams.home,
    status: entry.score.status,
    blocked_reasons: entry.score.blocked_reasons,
  });
}

function slateTotalText(entry) {
  return describeTotal(entry.score);
}

function slateWinProbabilityText(entry) {
  return describeMoneyline(entry.score, {
    home_team: entry.teams.home,
    away_team: entry.teams.away,
  });
}

function slateGameLabel(entry) {
  return `${entry.teams.away} AT ${entry.teams.home}`;
}

function renderFastRead(entries = []) {
  const postureEntries = entries
    .filter((entry) => !['PASS', 'BLOCKED', 'MODEL_INSUFFICIENT'].includes(entry.modelPosture))
    .sort((a, b) => (SLATE_POSTURE_STRENGTH[b.modelPosture] ?? -99)
      - (SLATE_POSTURE_STRENGTH[a.modelPosture] ?? -99) || a.index - b.index)
    .slice(0, 3);
  const runEntries = entries
    .filter((entry) => Number.isFinite(entry.totalRuns))
    .sort((a, b) => b.totalRuns - a.totalRuns || a.index - b.index)
    .slice(0, 3);
  const pitcherEntries = entries.flatMap((entry) => [
    { entry, side: 'away', projection: entry.projection?.ks_away },
    { entry, side: 'home', projection: entry.projection?.ks_home },
  ])
    .filter(({ projection }) => projection?.status !== 'blocked' && Number.isFinite(distMean(projection?.outputs?.distribution)))
    .sort((a, b) => distMean(b.projection.outputs.distribution) - distMean(a.projection.outputs.distribution)
      || a.entry.index - b.entry.index)
    .slice(0, 3);

  const lines = ['FAST READ', 'TOP SIDE POSTURES'];
  if (postureEntries.length) {
    for (const entry of postureEntries) {
      lines.push(`  ${slateGameLabel(entry)} — posture: ${entry.modelPosture}; projected score: ${formatSlateScore(entry)}; ${slateSpreadText(entry)}; ${slateTotalText(entry)}; ${slateWinProbabilityText(entry)}`);
    }
  } else {
    lines.push('  none available — no model-backed side posture is available.');
  }
  lines.push('TOP RUN ENVIRONMENTS');
  if (runEntries.length) {
    for (const entry of runEntries) {
      lines.push(`  ${slateGameLabel(entry)} — total: ${entry.totalRuns.toFixed(1)} runs; ${describeYrfi(entry.projection?.yrfi ?? { status: 'blocked', blocked_reasons: ['MODEL_INPUTS_MISSING'] })}`);
    }
  } else {
    lines.push('  none available — projected totals are unavailable.');
  }
  lines.push('TOP PITCHER PROP SIGNALS');
  if (pitcherEntries.length) {
    for (const { entry, side, projection } of pitcherEntries) {
      const pitcher = slatePitcher({ game: entry.game, side });
      lines.push(`  ${slateGameLabel(entry)} — ${describeKs(projection, pitcher)}`);
    }
  } else {
    lines.push('  none available — pitcher K projections are unavailable.');
  }
  return lines.join('\n');
}

function projectionAvailabilityReason(projection, fallback = 'MODEL_INPUTS_MISSING') {
  const reasons = [
    ...safeArray(projection?.blocked_reasons),
    ...(projection?.status === 'provisional' && projection?.lineup_status && projection.lineup_status !== 'confirmed'
      ? [`lineup_status=${projection.lineup_status}`] : []),
    ...(projection?.status === 'provisional' && projection?.weather_status && projection.weather_status !== 'complete'
      ? [`weather_status=${projection.weather_status}`] : []),
  ];
  return [...new Set(reasons)].join(', ') || fallback;
}

function renderAvailabilityLine(label, entries, available) {
  const total = entries.length;
  const count = available.length;
  const degraded = available.filter(({ projection }) => projection?.status === 'provisional');
  const unavailable = entries.filter((entry) => !available.some((item) => item.entry === entry));
  const reasons = [...new Set(unavailable.map(({ projection }) => projectionAvailabilityReason(projection)))];
  const status = count
    ? `available for ${count}/${total} game(s)${degraded.length ? `; degraded/provisional: ${[...new Set(degraded.map(({ projection }) => projectionAvailabilityReason(projection)))] .join(', ')}` : ''}`
    : `unavailable — ${reasons.join('; ') || 'MODEL_INPUTS_MISSING'}`;
  return `  ${label}: ${status}`;
}

function renderModelAvailability(entries = [], readyHr = []) {
  const fields = [
    ['projected runs', (entry) => entry.score?.outputs?.team_runs_distribution
      && Number.isFinite(entry.awayRuns) && Number.isFinite(entry.homeRuns), (entry) => entry.score],
    ['spread', (entry) => Number.isFinite(entry.score?.outputs?.runline_home_minus_1_5)
      && Number.isFinite(entry.awayRuns) && Number.isFinite(entry.homeRuns), (entry) => entry.score],
    ['total', (entry) => Number.isFinite(entry.totalRuns), (entry) => entry.score],
    ['win probability', (entry) => Number.isFinite(entry.winProbability), (entry) => entry.score],
    ['YRFI/NRFI', (entry) => Number.isFinite(entry.projection?.yrfi?.outputs?.yrfi_prob)
      && Number.isFinite(entry.projection?.yrfi?.outputs?.nrfi_prob), (entry) => entry.projection?.yrfi],
    ['K projections', (entry) => [entry.projection?.ks_away, entry.projection?.ks_home]
      .some((projection) => projection?.status !== 'blocked' && Number.isFinite(distMean(projection?.outputs?.distribution))), (entry) => entry.projection?.ks_away ?? entry.projection?.ks_home],
    ['threshold probabilities', (entry) => [entry.projection?.ks_away, entry.projection?.ks_home]
      .some((projection) => Object.keys(projection?.outputs?.derived_probs ?? {}).length > 0), (entry) => entry.projection?.ks_away ?? entry.projection?.ks_home],
  ];
  const lines = ['MODEL AVAILABILITY'];
  for (const [label, isAvailable, projectionForStatus] of fields) {
    const available = entries.filter((entry) => isAvailable(entry)).map((entry) => ({ entry, projection: projectionForStatus(entry) }));
    lines.push(renderAvailabilityLine(label, entries, available));
  }
  lines.push(readyHr.length
    ? `  anytime-HR model: available for ${readyHr.length} batter signal(s).`
    : '  anytime-HR model: unavailable/degraded — MODEL_INSUFFICIENT; batter-level evidence is unavailable for this slate.');
  return lines.join('\n');
}

function renderOperationsWatch(entries = []) {
  const watched = entries.filter((entry) => entry.delayed || entry.doubleheader);
  const lines = ['OPERATIONS WATCH'];
  if (!watched.length) {
    lines.push('  none');
    return lines.join('\n');
  }
  const emittedDoubleheaderGroups = new Set();
  for (const entry of watched) {
    if (entry.doubleheaderGroupKey) {
      if (emittedDoubleheaderGroups.has(entry.doubleheaderGroupKey)) continue;
      emittedDoubleheaderGroups.add(entry.doubleheaderGroupKey);
      const groupEntries = entries.filter((candidate) => candidate.doubleheaderGroupKey === entry.doubleheaderGroupKey);
      const statuses = [...new Set(groupEntries.map((candidate) => candidate.status).filter(Boolean))].join(' / ');
      lines.push(`  [DOUBLEHEADER_GAME] ${slateGameLabel(entry)} — status: ${statuses || entry.operationsStatus}; required action: Refresh bullpen usage, lineups, starters, and weather before the affected game.`);
      continue;
    }
    const actions = [];
    if (entry.delayed) actions.push('recheck official first pitch/status and rerun before release');
    if (entry.doubleheader) actions.push('confirm game number/order and rerun with each game\'s official starters and locked lineups');
    lines.push(`  ${slateGameLabel(entry)} — status: ${entry.operationsStatus}; required action: ${actions.join('; ')}.`);
  }
  return lines.join('\n');
}

function formatGeneratedCt(date = new Date()) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

function renderSlateDeliveryAudit({ date, gameCount }) {
  return [
    'DELIVERY AND AUDIT',
    '  packet type: mlb-daily',
    '  customer artifact: morning_proxy slate packet',
    `  canonical state: MLB morning_proxy state for ${date}`,
    `  games included: ${gameCount}`,
    '  generation result: rendered successfully',
  ].join('\n');
}

/**
 * Build the compact, sectioned MLB slate packet from picks.json scoring rows.
 * Returns { text, rows, inventoryText, counts } or null if no scoring exists.
 * The main user-facing text contains the morning wrapper and the literal full
 * slate board. The full per-pick inventory goes to a separate audit artifact,
 * never the packet body.
 */
export function buildMlbSlatePacket({ date, scoring, artifacts = [], inventoryPath = null, scope = null, sourceRefs = {}, hrProjections = [], slateGames = [], leagueRPG = null }) {
  if (!scoring || !Array.isArray(scoring.picks) || !scoring.picks.length) return null;
  const resolvedScope = resolvePacketScope({
    explicit: scope,
    hasScoring: true,
    perGame: false,
  });
  // Skip pure reference rows from the headline board so we don't pad sections,
  // but keep them in the inventory artifact.
  const suppressLineupLanguage = resolvedScope === 'FULL_DAY_PREVIEW';
  const allRows = scoring.picks.map((p) => mlbPickToDecisionRow(p, { suppressLineupLanguage }));
  const boardRows = allRows.filter((r) => r.market_type !== 'correlated_alternate');

  const lineupPending = scoring.picks.filter((p) =>
    Array.isArray(p.missing_confirmations) && p.missing_confirmations.some((m) => /lineup/i.test(String(m)))).length;

  const slateEntries = buildFullSlateBoardEntries({ date, scoring, slateGames, leagueRPG });
  const generatedAt = new Date();
  const header = [
    "Captain's MLB Prediction Companion",
    'MORNING FULL-SLATE BOARD',
    'CPC Packet: Morning Full-Slate Board',
    `Date: ${date}`,
    `Generated: ${formatGeneratedCt(generatedAt)} CT`,
    'Run type: morning_proxy',
    `Games scheduled: ${slateEntries.length}`,
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
      : ['  MODEL_INSUFFICIENT — batter-level evidence is unavailable for this slate.']),
  ].join('\n');
  const important = [
    'IMPORTANT',
    '  This morning report uses each team\'s most recent confirmed locked batting order as a lineup proxy.',
    '  Today\'s official starting pitchers are required.',
    '  Every game will be rerun with today\'s confirmed lineups before first pitch.',
    `  ${inputStatusNote}`,
  ].join('\n');
  const marketContext = [
    'MARKET CONTEXT',
    `  ${neutralityNote}`,
    '  Market context is display-only / NOT IN SCORE.',
    '  Missing market prices may disable market comparison, but they must not hide or block valid CPC model projections.',
  ].join('\n');
  const fullSlateBoard = renderFullSlateBoardEntries(slateEntries);
  const text = [
    header,
    important,
    marketContext,
    renderFastRead(slateEntries),
    renderOperationsWatch(slateEntries),
    fullSlateBoard,
    hrSection,
    renderModelAvailability(slateEntries, readyHr),
    renderSlateDeliveryAudit({ date, gameCount: slateEntries.length }),
    packetFooter(),
  ].filter(Boolean).join('\n\n');

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
  const lineup_status = statsRecord?.lineup_status === 'proxy'
    ? 'proxy'
    : (lineupConfirmed ? 'confirmed' : ((picks.length || statsRecord) ? 'unconfirmed' : null));
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
      ...(proxyLineupLabel(statsRecord) ? [proxyLineupLabel(statsRecord)] : []),
      describeMoneyline(proj.score, { home_team: home, away_team: away }),
      describeRunline(proj.score, { home_team: home }),
      describeTotal(proj.score),
      describeTeamRuns(proj.score, 'away', away),
      describeTeamRuns(proj.score, 'home', home),
      describeProjectedSpread(
        proj.means?.lambdaAway,
        proj.means?.lambdaHome,
        {
          away_team: away,
          home_team: home,
          status: proj.score?.status,
          blocked_reasons: proj.score?.blocked_reasons,
        },
      ),
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
    describeTeamRuns(score, 'away', away),
    describeTeamRuns(score, 'home', home),
    describeProjectedSpread(undefined, undefined, {
      away_team: away,
      home_team: home,
      status: score.status,
      blocked_reasons: score.blocked_reasons,
    }),
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
  audit = null,
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

  const generatedAtUtc = new Date().toISOString();
  const display = buildEventDisplay(event);
  const awayTeam = statsRecord?.away_team ?? event?.away_full ?? event?.away_team
    ?? display.away_full ?? 'Away';
  const homeTeam = statsRecord?.home_team ?? event?.home_full ?? event?.home_team
    ?? display.home_full ?? 'Home';
  const awayStarter = statsRecord?.away_pitcher?.name ?? event?.away_starter ?? event?.away_pitcher ?? 'MISSING';
  const homeStarter = statsRecord?.home_pitcher?.name ?? event?.home_starter ?? event?.home_pitcher ?? 'MISSING';
  const gameStatus = String(statsRecord?.game_status ?? event?.game_status ?? event?.status ?? 'UNKNOWN').trim() || 'UNKNOWN';
  const firstPitch = event?.start_time_utc
    ?? event?.start_utc
    ?? statsRecord?.start_utc
    ?? statsRecord?.start_time_utc
    ?? 'MISSING';
  const venue = event?.venue ?? statsRecord?.venue ?? 'MISSING';
  const latestUpdate = statsRecord?.checked_at_utc ?? statsRecord?.updated_at_utc ?? 'MISSING';
  const delayed = /delay/i.test(gameStatus);
  const alreadyStarted = /\b(?:in progress|live|warmup|final|completed|game over|manager challenge|review)\b/i.test(gameStatus);
  const frontRead = hasComposite
    ? classifyGamePacketRead(gamePicks, event, { hasModelProjection: Boolean(statsRecord) })
    : {
      cpcRead: 'PASS',
      call: 'NO CLEAR PICK',
      reason: 'no MLB event with a composite-ready game packet was found',
      summary: 'model outputs are unavailable',
    };
  const scoreProjection = packetProjections?.score ?? null;
  const awayRuns = packetProjections?.means?.lambdaAway;
  const homeRuns = packetProjections?.means?.lambdaHome;
  const projectedSpread = describeProjectedSpread(awayRuns, homeRuns, {
    away_team: awayTeam,
    home_team: homeTeam,
    status: scoreProjection?.status ?? 'blocked',
    blocked_reasons: scoreProjection?.blocked_reasons ?? ['MODEL_INPUTS_MISSING'],
  });
  const scoreValue = (value) => Number.isFinite(value) ? value.toFixed(1) : 'not modeled';
  const lineupState = packetStatusSnapshot.lineup_status === 'confirmed' ? 'LOCKED' : String(packetStatusSnapshot.lineup_status ?? 'UNKNOWN').toUpperCase();
  const starterState = packetStatusSnapshot.starterInput === 'LOCKED' ? 'CONFIRMED' : String(packetStatusSnapshot.starterInput ?? 'UNKNOWN').toUpperCase();
  const favoriteRuns = Number.isFinite(awayRuns) && Number.isFinite(homeRuns)
    ? (awayRuns >= homeRuns ? awayRuns : homeRuns)
    : null;
  const opponentRuns = Number.isFinite(awayRuns) && Number.isFinite(homeRuns)
    ? (awayRuns >= homeRuns ? homeRuns : awayRuns)
    : null;
  const calculation = favoriteRuns == null || opponentRuns == null
    ? 'not modeled'
    : `${favoriteRuns.toFixed(1)} minus ${opponentRuns.toFixed(1)} equals ${(favoriteRuns - opponentRuns).toFixed(1)}`;
  const primaryPick = selectPrimaryScoringPick(gamePicks);
  const blockedKs = { status: 'blocked', blocked_reasons: ['MODEL_INPUTS_MISSING'] };
  const propPosture = (side, pitcherName) => {
    const candidate = safeArray(gamePicks).find((pick) => {
      const laneText = `${pick?.market_lane ?? ''} ${pick?.market_title ?? ''} ${pick?.contract_title ?? ''} ${pick?.player_name ?? ''}`;
      const sideText = `${pick?.side ?? ''} ${pick?.team ?? ''} ${pick?.player_name ?? ''}`;
      return /strikeout|pitcher|\bks\b/i.test(laneText)
        && (new RegExp(side, 'i').test(sideText) || new RegExp(String(pitcherName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(sideText));
    });
    return candidate?.classification ?? frontRead.cpcRead ?? 'UNAVAILABLE';
  };
  const probabilityText = (value) => Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)}%` : 'MISSING';
  const ppText = (value) => Number.isFinite(Number(value)) ? `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(1)}pp` : 'MISSING';

  const auditInput = audit && typeof audit === 'object'
    ? audit
    : (!Array.isArray(artifacts) && artifacts && typeof artifacts === 'object' ? artifacts : null);
  const auditGamePk = auditInput?.game_pk ?? auditInput?.game_id ?? statsRecord?.game_pk ?? event?.game_pk ?? null;
  const canonicalRunRef = auditGamePk != null
    ? `mlb/${date}/runs/${auditGamePk}-confirmed_lineup.json`
    : 'MISSING';
  const runRecordPath = auditGamePk != null
    ? resolve(stateRoot, 'mlb', date, 'runs', `${auditGamePk}-confirmed_lineup.json`)
    : null;
  const persistedRunRecord = runRecordPath ? readJsonIfExists(runRecordPath) : null;
  const runRecord = auditInput?.run_record_object ?? persistedRunRecord ?? null;
  const packetStem = auditGamePk != null ? `${date}-confirmed-lineup-${auditGamePk}` : null;
  const packetDir = resolve(stateRoot, 'packets', date, PACKET_TYPE);
  const packetMeta = packetStem ? readJsonIfExists(join(packetDir, `${packetStem}.meta.json`)) : null;
  const deliveryLedger = readJsonIfExists(join(packetDir, '.delivery-ledger.json'));
  const deliveryKey = auditInput?.idempotency_key ?? (auditGamePk != null ? `mlb:confirmed_lineup:${auditGamePk}:${date}` : null);
  const deliveryEntry = deliveryKey ? deliveryLedger?.delivered?.[deliveryKey] : null;
  const auditMeta = auditInput?.meta ?? packetMeta ?? {};
  const auditArtifactName = auditInput?.artifact_name
    ?? auditMeta.artifact_name
    ?? (packetStem ? `${packetStem}.txt` : 'MISSING');
  const artifactName = String(auditArtifactName).split(/[\\/]/).pop() || 'MISSING';
  const sourceStatus = (backed) => backed ? 'BACKED' : 'MISSING — no backing data supplied';
  const hasOfficialRef = Boolean(sourceRefs.official ?? sourceRefs.event ?? sourcePath);
  const hasStatsRef = Boolean(sourceRefs.stats);
  const hasWeatherRef = Boolean(sourceRefs.weather);
  const hasContextRef = Boolean(sourceRefs.context);
  const hasLockedOrders = packetStatusSnapshot.lineup_status === 'confirmed'
    && (Array.isArray(statsRecord?.hr_batters) && statsRecord.hr_batters.length > 0
      || Array.isArray(statsRecord?.away_batting_order) && statsRecord.away_batting_order.length > 0
      || Array.isArray(statsRecord?.home_batting_order) && statsRecord.home_batting_order.length > 0);
  const hasStatistics = Boolean(
    statsRecord?.away_pitcher || statsRecord?.home_pitcher
      || statsRecord?.away_team_stats || statsRecord?.home_team_stats
      || statsRecord?.away_team_ops != null || statsRecord?.home_team_ops != null,
  );
  const hasHrEvidence = Boolean(
    (Array.isArray(statsRecord?.hr_evidence) && statsRecord.hr_evidence.length > 0)
      || (Array.isArray(statsRecord?.hr_batters) && statsRecord.hr_batters.length > 0),
  );
  const hasModelOutput = Boolean(
    [packetProjections?.score, packetProjections?.yrfi, packetProjections?.ks_away, packetProjections?.ks_home, packetProjections?.hr]
      .some((projection) => projection && projection.status !== 'blocked')
      || safeArray(gamePicks).some((pick) => hasModelBackedScoringSignal(pick)),
  );
  const sourceRows = [
    ['MLB_OFFICIAL', 'MLB official schedule', hasOfficialRef && Boolean(event?.title || event?.event_ticker || statsRecord?.game_pk)],
    ['OFFICIAL_GAME_STATUS', 'official game status', hasOfficialRef && gameStatus !== 'UNKNOWN'],
    ['LOCKED_BATTING_ORDERS / CONTEXT_ADAPTER', 'locked batting orders', hasContextRef && hasLockedOrders],
    ['STARTING_PITCHERS', 'starting pitchers', hasStatsRef && awayStarter !== 'MISSING' && homeStarter !== 'MISSING'],
    ['STATS_ADAPTER', 'statistics', hasStatsRef && hasStatistics],
    ['WEATHER_ADAPTER', 'weather', hasWeatherRef && Boolean(statsRecord?.weather || event?.weather)],
    ['HR_EVIDENCE', 'HR evidence', (hasStatsRef || hasContextRef) && hasHrEvidence],
    ['MODEL_OUTPUT', 'model output', hasModelOutput],
  ];
  const runType = auditInput?.run_type ?? runRecord?.run_type ?? 'confirmed_lineup';
  const gameId = auditInput?.game_id ?? auditInput?.game_pk ?? runRecord?.game_pk ?? statsRecord?.game_pk ?? event?.game_pk ?? 'MISSING';
  const runId = auditInput?.run_id ?? runRecord?.run_id ?? 'MISSING';
  const inputHash = auditInput?.input_hash ?? runRecord?.input_hash ?? 'MISSING';
  const outputHash = auditInput?.output_hash ?? runRecord?.output_hash ?? 'MISSING';
  const janitorResult = auditInput?.janitor_result
    ?? auditMeta.janitor_result
    ?? auditMeta.janitor_verdict
    ?? deliveryEntry?.janitor_verdict
    ?? 'MISSING';
  const deliveryStatus = auditInput?.delivery_status
    ?? auditMeta.delivery_status
    ?? (deliveryEntry ? 'sent' : 'NOT_RECORDED');
  const telegramDocumentId = auditInput?.telegram_document_id
    ?? auditMeta.telegram_document_id
    ?? deliveryEntry?.document_message_id
    ?? 'MISSING';

  lines.push('STATUS');
  lines.push(`  game status: ${gameStatus}`);
  lines.push(`  first pitch: ${firstPitch}`);
  lines.push(`  venue: ${venue}`);
  lines.push('  run type: confirmed_lineup');
  lines.push(`  generated time: ${generatedAtUtc}`);
  if (delayed) lines.push(`  delay notice: official status ${gameStatus}; scheduled first pitch ${firstPitch}; latest update ${latestUpdate}`);
  if (alreadyStarted) lines.push('This is a pregame model projection generated from confirmed locked lineups and starters. It is not a live in-game projection and does not include events after first pitch.');
  lines.push('');

  lines.push('RESEARCH STATUS');
  lines.push(`  lineups ${lineupState} — ${awayTeam}: ${lineupState}; ${homeTeam}: ${lineupState}`);
  lines.push(`  starters ${starterState} — ${awayTeam}: ${awayStarter}; ${homeTeam}: ${homeStarter}`);
  lines.push(`  weather status: ${String(packetStatusSnapshot.weather_status ?? 'UNKNOWN').toUpperCase()}`);
  lines.push('  market-display-only-not-in-score');
  lines.push('');

  lines.push('FAST READ');
  lines.push(`  model posture: ${frontRead.cpcRead ?? frontRead.call}`);
  lines.push(`  projected score: ${awayTeam} ${scoreValue(awayRuns)}, ${homeTeam} ${scoreValue(homeRuns)}`);
  lines.push(`  ${projectedSpread}`);
  lines.push(`  CPC projected total: ${describeTotal(scoreProjection ?? { status: 'blocked', blocked_reasons: ['MODEL_INPUTS_MISSING'] })}`);
  lines.push(`  ${describeMoneyline(scoreProjection ?? { status: 'blocked', blocked_reasons: ['MODEL_INPUTS_MISSING'] }, { home_team: homeTeam, away_team: awayTeam })}`);
  lines.push('');

  lines.push('GAME MODEL');
  lines.push(`  projected score: ${awayTeam} ${scoreValue(awayRuns)}, ${homeTeam} ${scoreValue(homeRuns)}`);
  lines.push(`  ${projectedSpread}`);
  lines.push(`  CALCULATION: ${calculation}`);
  lines.push(`  CPC projected total: ${describeTotal(scoreProjection ?? { status: 'blocked', blocked_reasons: ['MODEL_INPUTS_MISSING'] })}`);
  lines.push(`  ${describeMoneyline(scoreProjection ?? { status: 'blocked', blocked_reasons: ['MODEL_INPUTS_MISSING'] }, { home_team: homeTeam, away_team: awayTeam })}`);
  lines.push(`  YRFI/NRFI: ${describeYrfi(packetProjections?.yrfi ?? { status: 'blocked', blocked_reasons: ['MODEL_INPUTS_MISSING'] })}`);
  lines.push(`  model posture: ${frontRead.cpcRead ?? frontRead.call}`);
  lines.push(`  WHY: ${frontRead.reason ?? frontRead.summary ?? 'model posture unavailable'}`);
  lines.push('');

  if (hasComposite) {
    const read = classifyGamePacketRead(gamePicks, event, { hasModelProjection: Boolean(statsRecord) });
    lines.push('Research Status');
    lines.push(`  ${buildPacketScopeNote({ scope: resolvedScope, gamePicks, statsRecord })}`);
    lines.push('');
    lines.push('Event Preview / Storyline');
    for (const storyLine of buildGamePreviewStory({ event, statsRecord, read, projections: packetProjections })) {
      lines.push(`  ${storyLine}`);
    }
    lines.push('');
  } else {
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
  lines.push('PLAYER PROPS');
  lines.push(`  ${describeKs(packetProjections?.ks_away ?? blockedKs, awayStarter)}`);
  lines.push(`  away pitcher prop posture: ${propPosture('away', awayStarter)}`);
  lines.push(`  ${describeKs(packetProjections?.ks_home ?? blockedKs, homeStarter)}`);
  lines.push(`  home pitcher prop posture: ${propPosture('home', homeStarter)}`);
  lines.push('');

  lines.push('ANYTIME HOME RUN');
  lines.push(`  ${describeHr(packetProjections?.hr ?? { status: 'blocked', blocked_reasons: ['MODEL_INPUTS_MISSING'], outputs: [] })}`);
  lines.push('');

  lines.push('MARKET COMPARISON');
  const cpcProbability = primaryPick?.fair_value;
  const marketImpliedProbability = primaryPick?.kalshi_ask;
  if (Number.isFinite(Number(cpcProbability)) && Number.isFinite(Number(marketImpliedProbability))) {
    lines.push(`  CPC posture: ${frontRead.cpcRead ?? frontRead.call}; CPC probability: ${probabilityText(cpcProbability)}; market implied probability: ${probabilityText(marketImpliedProbability)}; difference: ${ppText(primaryPick?.edge_pp)}.`);
  } else if (!Number.isFinite(Number(marketImpliedProbability))) {
    lines.push(`  CPC posture: ${frontRead.cpcRead ?? frontRead.call}; CPC probability: ${probabilityText(cpcProbability)}; market implied probability: MISSING; difference: MISSING.`);
    lines.push('  Missing market pricing does not erase the CPC model projection.');
  } else {
    lines.push(`  CPC posture: ${frontRead.cpcRead ?? frontRead.call}; CPC probability: MISSING; market implied probability: ${probabilityText(marketImpliedProbability)}; difference: MISSING.`);
  }
  lines.push('');

  lines.push('LIMITATIONS');
  lines.push('  The projected score is an expected value, not an exact-score call.');
  lines.push('  The CPC projected spread is the difference between the two projected team scores.');
  lines.push('  Market data is display-only and NOT IN SCORE.');
  if (frontRead.whatItMeans) lines.push(`  ${frontRead.whatItMeans}`);
  lines.push('');

  lines.push('SOURCE STATUS');
  lines.push('  Source Ledger: 8 categories; MISSING means no backing data was supplied for that category.');
  for (const [label, description, backed] of sourceRows) {
    lines.push(`  ${label}: ${sourceStatus(backed)} (${description})`);
  }
  lines.push('  AUDIT_ARTIFACTS_AVAILABLE: yes (customer text omits local paths; artifacts stay in inventory/meta/audit files).');
  lines.push('');

  lines.push('DELIVERY AND AUDIT');
  lines.push(`  run type: ${runType}`);
  lines.push(`  game ID: ${gameId}`);
  lines.push(`  run ID: ${runId}`);
  lines.push(`  input hash: ${inputHash}`);
  lines.push(`  output hash: ${outputHash}`);
  lines.push(`  artifact name: ${artifactName}`);
  lines.push(`  canonical state reference: ${auditInput?.canonical_state_reference ?? canonicalRunRef}`);
  lines.push(`  janitor result: ${janitorResult}`);
  lines.push(`  delivery status: ${deliveryStatus}`);
  lines.push(`  Telegram document ID: ${telegramDocumentId}`);
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
    generatedAtUtc,
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

function discoveryRecords(path) {
  const payload = readJsonIfExists(path);
  return Array.isArray(payload?.records) ? payload.records : [];
}

function gameRecordFor(records, gamePk) {
  return records.find((record) => String(record?.game_pk ?? '') === String(gamePk)) ?? null;
}

function lineupSourceForRecord(statsRecord) {
  const explicit = statsRecord?.lineup_source && typeof statsRecord.lineup_source === 'object'
    ? statsRecord.lineup_source
    : {};
  const raw = String(statsRecord?.hr_lineup_source ?? '');
  const status = String(statsRecord?.lineup_status ?? '').toLowerCase();
  const orders = Array.isArray(statsRecord?.hr_batters)
    ? statsRecord.hr_batters.map((batter) => ({
      mlb_id: batter?.mlb_id ?? batter?.batter_id ?? null,
      lineup_slot: batter?.lineup_slot ?? null,
      side: batter?.side ?? null,
    }))
    : [
      ...(Array.isArray(statsRecord?.away_batting_order) ? statsRecord.away_batting_order.map((mlb_id) => ({ side: 'away', mlb_id })) : []),
      ...(Array.isArray(statsRecord?.home_batting_order) ? statsRecord.home_batting_order.map((mlb_id) => ({ side: 'home', mlb_id })) : []),
    ];
  const proxyDate = explicit.proxy_date
    ?? raw.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1]
    ?? null;
  const mode = explicit.mode
    ?? (status === 'proxy' ? 'LAST_LOCKED_LINEUP_PROXY' : status === 'confirmed' ? 'CONFIRMED_LINEUP' : 'UNAVAILABLE');
  return {
    mode,
    proxy_date: proxyDate,
    proxy_game_pk: explicit.proxy_game_pk ?? statsRecord?.proxy_game_pk ?? null,
    batting_order_hash: explicit.batting_order_hash ?? hashRunRecordValue(orders),
  };
}

function starterRecord({ statsRecord, officialRecord, side, generationDate }) {
  const key = `${side}_pitcher`;
  const statsPitcher = statsRecord?.[key] ?? null;
  const probable = statsRecord?.probable_pitchers?.[side]
    ?? officialRecord?.probable_pitchers?.[side]
    ?? null;
  const value = statsPitcher ?? probable;
  const name = typeof value === 'string' ? value : value?.name ?? value?.fullName ?? null;
  return {
    name,
    source: statsPitcher ? 'stats_adapter' : probable ? 'mlb_official_adapter' : null,
    as_of: generationDate,
  };
}

function priceNeutralCompositeSlot(compositeResult) {
  if (!compositeResult) return { status: null, outputs: null };
  const status = compositeResult.board?.top_pick?.status ?? null;
  const outputs = { game_ledger: compositeResult.gameLedger ?? null, board: compositeResult.board ?? null };
  return { status, outputs };
}

function modelAuditEntry(name, model) {
  const status = model?.status ?? null;
  const blocked = status === null || /blocked|insufficient/i.test(String(status));
  const reason = status === null
    ? 'model was not invoked'
    : blocked
      ? `projection status ${status}`
      : null;
  return { name, status, ran: !blocked, skipped: blocked, reason };
}

function buildInvocationAudit({ date, generatedAtUtc, records }) {
  const games = records.map(({ gamePk, record, path }) => {
    const models = Object.fromEntries(
      ['score', 'yrfi', 'ks_home', 'ks_away', 'hr', 'composite']
        .map((name) => [name, modelAuditEntry(name, record.models[name])]),
    );
    const ranModels = Object.values(models).filter((model) => model.ran).map((model) => model.name);
    const skippedModels = Object.values(models)
      .filter((model) => model.skipped)
      .map((model) => ({ model: model.name, reason: model.reason }));
    return {
      game_pk: record.game_pk ?? gamePk,
      run_record_path: path,
      models,
      ran_models: ranModels,
      skipped_models: skippedModels,
      all_models_ran: skippedModels.length === 0,
    };
  });
  return {
    run_type: 'morning_proxy',
    generation_date: date,
    generated_at_utc: generatedAtUtc,
    games,
  };
}

function buildMorningProxyRecord({ date, generatedAtUtc, statsRecord, officialRecord, weatherRecord, contextRecord, projection, compositeResult }) {
  const gamePk = statsRecord?.game_pk ?? officialRecord?.game_pk;
  const lineupConfidence = statsRecord?.lineup_status === 'confirmed' ? 'CONFIRMED' : 'PROXY';
  const models = {
    score: projection?.score ?? null,
    yrfi: projection?.yrfi ?? null,
    ks_home: projection?.ks_home ?? null,
    ks_away: projection?.ks_away ?? null,
    hr: projection?.hr ?? null,
    composite: priceNeutralCompositeSlot(compositeResult),
  };
  const inputSnapshot = {
    official: officialRecord,
    stats: statsRecord,
    weather: weatherRecord,
    context: contextRecord,
  };
  return {
    run_type: 'morning_proxy',
    game_pk: gamePk,
    generated_at_utc: generatedAtUtc,
    generation_date: date,
    lineup_confidence: lineupConfidence,
    lineup_source: lineupSourceForRecord(statsRecord),
    starters: {
      away: starterRecord({ statsRecord, officialRecord, side: 'away', generationDate: date }),
      home: starterRecord({ statsRecord, officialRecord, side: 'home', generationDate: date }),
    },
    models,
    input_hash: hashRunRecordValue(inputSnapshot),
  };
}

export async function main(argv = process.argv.slice(2), { primeResearch = primeMlbResearch, fetchEvents = fetchKalshiEvents } = {}) {
  const opts = parseMlbDailyArgs(argv);
  if (opts.help) {
    console.log('Usage: node scripts/packets/generate-mlb-daily.mjs --date YYYY-MM-DD [--dry-run] [--scope FULL_DAY_PREVIEW|SLATE_PREVIEW|GAME_PACKET]');
    return;
  }
  const dir = ensurePacketDir(opts.stateRoot, opts.date, PACKET_TYPE);
  const primeAttempts = await primeResearch(opts.date);
  const artifacts = locateMlbArtifacts(opts.stateRoot, opts.date);
  const statsSourceRef = resolve(opts.stateRoot, 'mlb', opts.date, 'discovery', 'stats_adapter.json');
  const weatherSourceRef = resolve(opts.stateRoot, 'mlb', opts.date, 'discovery', 'weather_adapter.json');
  const contextSourceRef = resolve(opts.stateRoot, 'mlb', opts.date, 'discovery', 'context_adapter.json');
  const officialSourceRef = resolve(opts.stateRoot, 'mlb', opts.date, 'discovery', 'mlb_official_adapter.json');

  // Public-stats projection inputs (price-free). Drives real model-layer reads.
  const statsRecords = loadStatsRecords(opts.stateRoot, opts.date);
  const leagueRPG = leagueRunsPerGame(statsRecords);
  const projectionsByGamePk = new Map();
  const slateProjections = statsRecords.map((record) => {
    const projection = buildGameProjections({
      record,
      leagueRPG,
      as_of: `${opts.date}T00:00:00Z`,
      lineup_status: record?.lineup_status === 'confirmed' || record?.lineup_status === 'proxy'
        ? record.lineup_status
        : 'unconfirmed',
      weather_status: record?.weather_status ?? null,
    });
    projectionsByGamePk.set(String(record?.game_pk ?? ''), projection);
    return projection;
  });
  const slateHrProjections = slateProjections.map((projection) => projection.hr);

  const discovery = await fetchEvents('mlb');
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

  // Immutable morning invocation records are written alongside the existing
  // packet outputs. The customer-facing board remains sourced from scoring and
  // keeps its current render/send behavior.
  const officialRecords = discoveryRecords(officialSourceRef);
  const weatherRecords = discoveryRecords(weatherSourceRef);
  const contextRecords = discoveryRecords(contextSourceRef);
  const gameInputs = new Map();
  for (const record of officialRecords) {
    if (record?.game_pk != null) gameInputs.set(String(record.game_pk), { officialRecord: record });
  }
  for (const record of statsRecords) {
    if (record?.game_pk == null) continue;
    const key = String(record.game_pk);
    gameInputs.set(key, { ...(gameInputs.get(key) ?? {}), statsRecord: record });
  }
  for (const pick of scoring?.picks ?? []) {
    if (pick?.matched_game_pk == null) continue;
    const key = String(pick.matched_game_pk);
    if (!gameInputs.has(key)) gameInputs.set(key, {});
  }

  const generatedAtUtc = new Date().toISOString();
  const writtenRunRecords = [];
  // Composite model slot is sourced from the price-neutral runComposite engine
  // (same engine the pregame confirmed_lineup run uses), not the price-aware
  // scoring-core classification that drives the customer board — the Price
  // Isolation Invariant bars price-derived classifications from stored model
  // outputs, even with pending/proxy lineups.
  const compositeSlate = loadDynamicCompositeSlate({ date: opts.date, stateRoot: opts.stateRoot, allowPendingLineups: true });
  const compositeInputByGamePk = new Map(compositeSlate.inputs.map((input) => [String(input.game_pk), input]));
  for (const [gamePk, input] of gameInputs) {
    const statsRecord = input.statsRecord ?? null;
    const officialRecord = input.officialRecord ?? null;
    const projection = statsRecord ? projectionsByGamePk.get(gamePk) ?? null : null;
    const compositeInput = compositeInputByGamePk.get(gamePk) ?? null;
    const compositeResult = compositeInput
      ? runComposite((({ ou_line: _ignoredMarketLine, ...priceFreeInput }) => priceFreeInput)(compositeInput))
      : null;
    const result = writeRunRecord(opts.stateRoot, buildMorningProxyRecord({
      date: opts.date,
      generatedAtUtc,
      statsRecord,
      officialRecord,
      weatherRecord: gameRecordFor(weatherRecords, gamePk),
      contextRecord: gameRecordFor(contextRecords, gamePk),
      projection,
      compositeResult,
    }));
    writtenRunRecords.push({ gamePk, record: result.record, path: result.path });
  }
  const auditPath = resolve(opts.stateRoot, 'mlb', opts.date, 'runs', 'invocation-audit.json');
  writeJsonAtomic(auditPath, buildInvocationAudit({ date: opts.date, generatedAtUtc, records: writtenRunRecords }));

  if (scoring) {
    const slateGames = [];
    const seenSlateGamePks = new Set();
    for (const officialRecord of officialRecords) {
      const gamePk = officialRecord?.game_pk;
      if (gamePk != null) seenSlateGamePks.add(String(gamePk));
      slateGames.push({
        officialRecord,
        statsRecord: gameRecordFor(statsRecords, gamePk),
        weatherRecord: gameRecordFor(weatherRecords, gamePk),
        contextRecord: gameRecordFor(contextRecords, gamePk),
        projection: projectionsByGamePk.get(String(gamePk ?? '')) ?? null,
      });
    }
    for (const statsRecord of statsRecords) {
      const gamePk = statsRecord?.game_pk;
      if (gamePk == null || seenSlateGamePks.has(String(gamePk))) continue;
      slateGames.push({
        statsRecord,
        weatherRecord: gameRecordFor(weatherRecords, gamePk),
        contextRecord: gameRecordFor(contextRecords, gamePk),
        projection: projectionsByGamePk.get(String(gamePk)) ?? null,
      });
    }
    const slateScope = resolvePacketScope({
      explicit: opts.scope ?? 'FULL_DAY_PREVIEW',
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
      slateGames,
      leagueRPG,
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
  }

  let exitCode = 0;
  if (!scoring && kalshiEvents.length > 0 && totalMarketCount === 0) {
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
