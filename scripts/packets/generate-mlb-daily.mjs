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
} from '../mlb/lib/projection-contracts.mjs';
import {
  describeMoneyline,
  describeRunline,
  describeTotal,
  describeTeamRuns,
  describeYrfi,
  describeKs,
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
    picks
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
 * A lineup_pending confirmation downgrades confidence but does NOT collapse the
 * row to WATCH — a strong pre-lineup edge still surfaces as a PICK.
 */
export function mlbPickToDecisionRow(pick = {}) {
  const cls = String(pick.classification ?? 'PASS').toUpperCase();
  const status = MLB_CLASSIFICATION_TO_STATUS[cls] ?? EDGE_STATUS.WATCH;
  const posture = MLB_POSTURE[cls] ?? 'WATCH';
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
    edgeOverridePp: Number.isFinite(Number(pick.edge_pp)) ? Number(pick.edge_pp) : undefined,
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

function classifyGamePacketRead(gamePicks = []) {
  const picks = Array.isArray(gamePicks) ? gamePicks : [];
  const primary = picks.find((p) => p?.primary_pick) ?? picks[0] ?? null;
  const lineupPending = picks.some((p) =>
    Array.isArray(p?.missing_confirmations) && p.missing_confirmations.some((m) => /lineup/i.test(String(m))));
  const modeledFamilies = new Set(
    picks
      .map((p) => String(p?.market_lane ?? p?.classification ?? '').toUpperCase())
      .filter(Boolean),
  );

  if (!primary) {
    return {
      call: 'NO CLEAR PICK',
      reason: 'no model family crosses the threshold',
      summary: 'model outputs remain provisional while no primary pick is available',
    };
  }

  const marketLabel = (() => {
    const ticker = String(primary.market_ticker ?? primary.ticker ?? '');
    const suffix = ticker.split('-').pop() || '';
    return /^[A-Z]{2,4}$/.test(suffix) ? suffix : (primary.contract_title ?? primary.market_title ?? 'favorite');
  })();

  const classification = String(primary.classification ?? '').toUpperCase();
  const hasModelScore = primary.fair_value != null && Number.isFinite(Number(primary.fair_value));
  if (hasModelScore && (['LEAN', 'CLEAR_PICK', 'PRE_LINEUP_PICK'].includes(classification) || Number(primary.edge_pp) > 0)) {
    return {
      call: `EVIDENCE LEAN — ${marketLabel}`,
      reason: 'required model families and context point the same way',
      summary: modeledFamilies.size ? `modeled families present: ${Array.from(modeledFamilies).join(', ')}` : 'modeled family data present',
    };
  }

  if (lineupPending) {
    return {
      call: 'NO CLEAR PICK',
      reason: 'projections provisional due lineup',
      summary: modeledFamilies.size ? `modeled families present: ${Array.from(modeledFamilies).join(', ')}` : 'model outputs remain provisional',
    };
  }

  if (modeledFamilies.size > 1) {
    return {
      call: 'NO CLEAR PICK',
      reason: 'modeled families disagree',
      summary: modeledFamilies.size ? `modeled families present: ${Array.from(modeledFamilies).join(', ')}` : 'model outputs remain provisional',
    };
  }

  if (modeledFamilies.size === 1) {
    return {
      call: 'NO CLEAR PICK',
      reason: 'single modeled family only',
      summary: `modeled families present: ${Array.from(modeledFamilies).join(', ')}`,
    };
  }

  return {
    call: 'NO CLEAR PICK',
    reason: 'no model family crosses the threshold',
    summary: modeledFamilies.size ? `modeled families present: ${Array.from(modeledFamilies).join(', ')}` : 'model outputs remain provisional',
  };
}

function buildGamePreviewLine({ event = null, statsRecord = null, read = null } = {}) {
  const awayStarter = statsRecord?.away_pitcher?.name ?? event?.away_starter ?? event?.away_pitcher ?? 'away starter';
  const homeStarter = statsRecord?.home_pitcher?.name ?? event?.home_starter ?? event?.home_pitcher ?? 'home starter';
  const matchup = statsRecord?.game ?? event?.title ?? 'the game';
  const call = String(read?.call ?? '').trim();
  const reason = String(read?.reason ?? '').toLowerCase();
  if (reason.includes('projections provisional due lineup')) {
    return `Starter matchup is ${awayStarter} vs ${homeStarter}; ${matchup} stays provisional until the required alpha clears.`;
  }
  if (!call || call === 'NO CLEAR PICK') {
    return `Starter matchup is ${awayStarter} vs ${homeStarter}; ${matchup} is a no clear pick for now.`;
  }
  return `Starter matchup is ${awayStarter} vs ${homeStarter}; ${matchup} currently reads ${call}.`;
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
export function buildMlbSlatePacket({ date, scoring, artifacts = [], inventoryPath = null, scope = null, sourceRefs = {} }) {
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
  const text = [header, inputStatusNote, neutralityNote, cleanedBody, packetFooter()].filter(Boolean).join('\n\n');

  // Full per-pick inventory -> audit artifact only. Each line carries model and
  // market fields together for routing/audit; pricing here is NOT a score input.
  const inventoryLines = allRows.map((r, i) =>
    `#${i + 1} [${r.edge_status}] ${r.market_ticker} :: ${r.side_target} | fair=${r.fair_probability_or_range} score=${r.composite_score} implied=${r.implied_probability} ask=${r.market_yes_ask} edge=${r.edge_cents_or_pp === null ? 'MISSING' : `${r.edge_cents_or_pp}pp`} conf=${r.confidence}`);
  const inventoryText = buildInventoryArtifact({
    marketType: 'mlb',
    date,
    eventTicker: `MLB-SLATE-${date}`,
    inventoryLines,
    meta: { summary_counts: JSON.stringify(scoring.summaryCounts ?? {}), board_rows: boardRows.length, total_rows: allRows.length },
  });
  const assumptionsLedger = buildPacketAssumptionsLedger({
    scope: resolvedScope,
    date,
    scoring,
    gamePicks: scoring.picks,
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
export function buildProjectionFirstBlock({ date, gamePicks = [], statsRecord = null, leagueRPG = null } = {}) {
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
    const proj = buildGameProjections({ record: statsRecord, leagueRPG, as_of, lineup_status, weather_status });
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

  if (hasComposite) {
    const read = classifyGamePacketRead(gamePicks);
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
    lines.push(`  ${buildGamePreviewLine({ event, statsRecord, read })}`);
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
    lines.push(`  ${buildGamePreviewLine({ event, statsRecord, read: { call: 'NO CLEAR PICK' } })}`);
    lines.push('');
  }

  lines.push('');
  lines.push('Game Model Results');
  lines.push('');
  for (const l of buildProjectionFirstBlock({ date, gamePicks, statsRecord, leagueRPG })) lines.push(l);
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
