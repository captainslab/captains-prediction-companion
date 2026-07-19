#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runPregameRefresh } from './mlb-workspace.mjs';
import { leagueRunsPerGame, buildGameProjections } from './lib/projection-engine.mjs';
import { runComposite, loadDynamicCompositeSlate } from './late-slate-composite-refresh.mjs';
import {
  buildKalshiGamePacket,
} from '../packets/generate-mlb-daily.mjs';
import { writeAudit } from '../packets/lib/common.mjs';
import {
  deliverDocumentEntry,
  loadLedger,
  saveLedger,
} from '../packets/send-packets-telegram.mjs';
import { inspectPacketFile } from '../cron/cpc-packet-janitor.mjs';
import {
  buildConfirmedLineupRunRecord,
  writeImmutableRunRecord,
  writeLineupsNotLockedArtifact,
  sha256Json,
} from './lib/mlb-run-record.mjs';

const PACKET_TYPE = 'mlb-daily';
const AFFECTED_LAYERS = Object.freeze(['score', 'yrfi', 'ks_home', 'ks_away', 'hr', 'composite']);
const LOCKED_LINEUP_STATUS = 'confirmed_or_boxscore_available';
const DEFAULT_BACKOFF_MS = 250;

const sleep = (ms) => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

function parseArgs(argv) {
  const opts = { date: null, stateRoot: 'state', noSend: false, maxRetries: 2 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--game-pk') opts.gamePk = argv[++i];
    else if (arg === '--date') opts.date = argv[++i];
    else if (arg === '--state-root') opts.stateRoot = argv[++i];
    else if (arg === '--no-send') opts.noSend = true;
    else if (arg === '--max-retries') opts.maxRetries = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (opts.help) return opts;
  if (opts.gamePk == null || opts.gamePk === '') throw new Error('--game-pk is required');
  if (!Number.isInteger(Number(opts.gamePk)) || Number(opts.gamePk) <= 0) throw new Error('--game-pk must be a positive integer');
  if (!opts.date) throw new Error('--date YYYY-MM-DD is required');
  if (!Number.isInteger(opts.maxRetries) || opts.maxRetries < 0) throw new Error('--max-retries must be a non-negative integer');
  return opts;
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function recordsAt(path) {
  return Array.isArray(readJson(path)?.records) ? readJson(path).records : [];
}

function recordForGame(path, gamePk) {
  return recordsAt(path).find(record => String(record?.game_pk) === String(gamePk)) ?? null;
}

function discoveryPath(stateRoot, date, filename) {
  return resolve(stateRoot, 'mlb', date, 'discovery', filename);
}

function lineupIsLocked(context) {
  if (!context) return false;
  const teamStatuses = [context.away_lineup_status, context.home_lineup_status].filter(Boolean);
  if (teamStatuses.length) return teamStatuses.every(status => status === LOCKED_LINEUP_STATUS);
  return context.lineup_status === LOCKED_LINEUP_STATUS;
}

function freshState({ stateRoot, date, gamePk }) {
  const officialPath = discoveryPath(stateRoot, date, 'mlb_official_adapter.json');
  const statsPath = discoveryPath(stateRoot, date, 'stats_adapter.json');
  const weatherPath = discoveryPath(stateRoot, date, 'weather_adapter.json');
  const contextPath = discoveryPath(stateRoot, date, 'context_adapter.json');
  const savantPath = discoveryPath(stateRoot, date, 'baseball_savant_adapter.json');
  const official = recordForGame(officialPath, gamePk);
  const stats = recordForGame(statsPath, gamePk);
  const context = recordForGame(contextPath, gamePk);
  const weather = recordForGame(weatherPath, gamePk);
  if (!official) throw new Error(`fresh official discovery missing game_pk=${gamePk}`);
  if (!stats) throw new Error(`fresh stats discovery missing game_pk=${gamePk}`);

  const snapshot = {
    official: official ?? null,
    stats: stats ?? null,
    weather: weather ?? null,
    context: context ?? null,
    savant: readJson(savantPath) ?? null,
  };
  return { official, stats, context, weather, snapshot, paths: { officialPath, statsPath, weatherPath, contextPath, savantPath } };
}

function orderToBatters(order, side, team) {
  return (Array.isArray(order) ? order : []).map((id, index) => ({
    mlb_id: id,
    batter_id: id,
    lineup_slot: index + 1,
    side,
    team,
  }));
}

function projectionRecord(state) {
  const { stats, context, official, weather } = state;
  const awayOrder = context?.away_batting_order ?? [];
  const homeOrder = context?.home_batting_order ?? [];
  const batters = [
    ...orderToBatters(awayOrder, 'away', stats.away_team ?? official.away_team),
    ...orderToBatters(homeOrder, 'home', stats.home_team ?? official.home_team),
  ];
  return {
    ...stats,
    game_pk: stats.game_pk ?? official.game_pk,
    game_date: stats.game_date ?? official.game_date,
    start_time_utc: official.start_time_utc ?? stats.start_time_utc ?? null,
    game_status: official.mlb_status ?? null,
    away_team: stats.away_team ?? official.away_team,
    home_team: stats.home_team ?? official.home_team,
    venue: stats.venue ?? official.venue ?? weather?.venue ?? null,
    lineup_status: 'confirmed',
    hr_batters: batters,
    hr_evidence: batters,
    weather,
  };
}

function normalizePitcher(pitcher) {
  if (!pitcher) return null;
  return {
    ...pitcher,
    id: pitcher.id ?? pitcher.mlb_id ?? null,
    mlb_id: pitcher.mlb_id ?? pitcher.id ?? null,
    kPct: pitcher.kPct ?? pitcher.k_pct ?? null,
    bbPct: pitcher.bbPct ?? pitcher.bb_pct ?? null,
  };
}

function fallbackCompositeInput(state) {
  const { stats, context, official, weather } = state;
  const lineup = { status: 'confirmed', ilHealth: null };
  return {
    game_pk: official.game_pk,
    away_team: official.away_team ?? stats.away_team,
    home_team: official.home_team ?? stats.home_team,
    away_pitcher: normalizePitcher(stats.away_pitcher),
    home_pitcher: normalizePitcher(stats.home_pitcher),
    away_team_stats: stats.away_team_stats ?? { ops: stats.away_team_ops },
    home_team_stats: stats.home_team_stats ?? { ops: stats.home_team_ops },
    away_bullpen: stats.away_bullpen ?? null,
    home_bullpen: stats.home_bullpen ?? null,
    away_lineup: lineup,
    home_lineup: lineup,
    park: { factor: 100, name: stats.venue ?? official.venue ?? null },
    weather: weather ? {
      temperatureF: weather.temperature ?? weather.temperatureF,
      windMph: weather.wind_speed ?? weather.windMph,
      precipRisk: weather.precipitation_risk ?? weather.precipRisk,
    } : null,
    context_checked_at_utc: context?.checked_at_utc ?? null,
  };
}

function compositeForGame(state, { stateRoot, date, gamePk }) {
  const slate = loadDynamicCompositeSlate({ date, stateRoot, gamePk });
  const input = slate.inputs[0] ?? fallbackCompositeInput(state);
  const { ou_line: _ignoredMarketLine, ...priceFreeInput } = input;
  return runComposite(priceFreeInput);
}

function modelPickFromComposite(composite, state) {
  const top = composite?.board?.top_pick;
  if (!top) return [];
  const classification = top.status === 'PICK'
    ? 'CLEAR_PICK'
    : top.status === 'EVIDENCE_LEAN'
      ? 'LEAN'
      : top.status === 'LEAN' ? 'LEAN' : 'PASS';
  return [{
    matched_game_pk: state.official.game_pk,
    game: `${state.official.away_team} at ${state.official.home_team}`,
    classification,
    market_lane: top.lane,
    contract_title: top.label,
    primary_pick: true,
    gates_passed: ['lineup_context: confirmed lineup posted', 'starter_context: reconfirmed'],
    missing_confirmations: [],
  }];
}

function packetEvent(state) {
  const { official, stats } = state;
  return {
    event_ticker: `MLB-CONFIRMED-${official.game_pk}`,
    title: `${official.away_team} at ${official.home_team}`,
    sub_title: 'Confirmed-lineup model run',
    series_ticker: 'MLB-CONFIRMED-LINEUP',
    start_time_utc: official.start_time_utc ?? stats.start_time_utc ?? null,
    venue: official.venue ?? stats.venue ?? null,
    markets: [],
  };
}

function startersFor(state) {
  const { stats, context } = state;
  const asOf = context?.checked_at_utc ?? stats.checked_at_utc ?? new Date().toISOString();
  const awayName = context?.probable_pitchers?.away ?? stats.away_pitcher?.name ?? null;
  const homeName = context?.probable_pitchers?.home ?? stats.home_pitcher?.name ?? null;
  if (!awayName || !homeName) throw new Error('CURRENT_STARTERS_NOT_RECONFIRMED');
  const sameName = (left, right) => !left || !right || String(left).trim().toLowerCase() === String(right).trim().toLowerCase();
  if (!sameName(context?.probable_pitchers?.away, stats.away_pitcher?.name)
    || !sameName(context?.probable_pitchers?.home, stats.home_pitcher?.name)) {
    throw new Error('CURRENT_STARTERS_MISMATCH');
  }
  return {
    away: { name: awayName, source: context?.probable_pitchers?.away ? 'context_adapter' : 'stats_adapter', as_of: asOf },
    home: { name: homeName, source: context?.probable_pitchers?.home ? 'context_adapter' : 'stats_adapter', as_of: asOf },
  };
}

async function renderAndDeliver({ opts, state, record, composite, sendMessage, sendDocument, inspect }) {
  const date = opts.date;
  const packetDir = resolve(opts.stateRoot, 'packets', date, PACKET_TYPE);
  mkdirSync(packetDir, { recursive: true });
  const stem = `${date}-confirmed-lineup-${opts.gamePk}`;
  const packet = buildKalshiGamePacket({
    date,
    event: packetEvent(state),
    stateRoot: opts.stateRoot,
    artifacts: [],
    primeAttempts: [],
    kalshiSummary: { ok: false, total: 0, matched: 0, error: null },
    sourcePath: discoveryPath(opts.stateRoot, date, 'mlb_official_adapter.json'),
    gamePicks: modelPickFromComposite(composite, state),
    statsRecord: projectionRecord(state),
    leagueRPG: leagueRunsPerGame([state.stats]),
    scope: 'GAME_PACKET',
    sourceRefs: {
      official: state.paths.officialPath,
      stats: state.paths.statsPath,
      weather: state.paths.weatherPath,
      context: state.paths.contextPath,
    },
  });
  const written = writeAudit(packetDir, stem, packet.text, {
    kind: 'confirmed_lineup_game_packet',
    run_type: record.run_type,
    run_id: record.run_id,
    game_pk: record.game_pk,
    run_record: resolve(opts.stateRoot, 'mlb', date, 'runs', `${opts.gamePk}-${record.run_type}.json`),
    input_hash: record.input_hash,
    output_hash: record.output_hash,
    write_chunks: false,
  }, { writeChunks: false });

  const ledgerPath = resolve(packetDir, '.delivery-ledger.json');
  if (!opts.noSend && !existsSync(ledgerPath)) {
    saveLedger(ledgerPath, {
      schema: 'cpc_packet_delivery_ledger_v1',
      created_utc: new Date().toISOString(),
      delivered: {},
    });
  }
  const ledger = loadLedger(ledgerPath);
  const entry = { name: stem, files: [`${stem}.txt`] };
  const outcome = await deliverDocumentEntry({
    entry,
    dir: packetDir,
    packetType: PACKET_TYPE,
    date,
    stateRoot: opts.stateRoot,
    ledgerPath,
    ledger,
    force: false,
    dryRun: opts.noSend,
    idempotencyKey: `mlb:confirmed_lineup:${opts.gamePk}:${date}`,
    sendMessage,
    sendDocument,
    inspect,
  });
  return { packetPath: written.txtPath, packetMetaPath: written.metaPath, delivery: outcome };
}

export async function runPregameGame({
  injectedOptions = null,
  argv = process.argv.slice(2),
  refreshPregame = runPregameRefresh,
  sleepImpl = sleep,
  now = new Date(),
  sendMessage,
  sendDocument,
  inspect = inspectPacketFile,
  backoffMs = DEFAULT_BACKOFF_MS,
} = {}) {
  const opts = injectedOptions ?? parseArgs(argv);
  if (opts.help) {
    console.log('Usage: node scripts/mlb/pregame-game-run.mjs --game-pk <pk> --date YYYY-MM-DD [--no-send] [--max-retries 2]');
    return { help: true };
  }
  const refreshArgs = ['--date', opts.date, '--state-root', opts.stateRoot, '--live-readonly', '--discovery-only'];
  let state;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt += 1) {
    await refreshPregame(refreshArgs);
    state = freshState(opts);
    if (lineupIsLocked(state.context)) break;
    if (attempt === opts.maxRetries) {
      const artifact = writeLineupsNotLockedArtifact({
        stateRoot: opts.stateRoot,
        date: opts.date,
        gamePk: opts.gamePk,
        checkedAtUtc: state.context?.checked_at_utc ?? now.toISOString(),
        affectedLayers: AFFECTED_LAYERS,
      });
      console.log(`[pregame-game-run] lineup not locked game_pk=${opts.gamePk} retries_exhausted=true`);
      return { status: 'lineups_not_locked', artifactPath: artifact.path, sent: false, refreshes: attempt + 1 };
    }
    await sleepImpl(backoffMs);
  }

  const generatedAtUtc = now.toISOString();
  const starters = startersFor(state);
  const projection = buildGameProjections({
    record: projectionRecord(state),
    leagueRPG: leagueRunsPerGame([state.stats]),
    as_of: generatedAtUtc,
    lineup_status: 'confirmed',
    weather_status: state.weather ? 'complete' : null,
  });
  const compositeResult = compositeForGame(state, opts);
  const models = {
    score: projection.score,
    yrfi: projection.yrfi,
    ks_home: projection.ks_home,
    ks_away: projection.ks_away,
    hr: projection.hr,
    composite: { game_ledger: compositeResult.gameLedger, board: compositeResult.board },
  };
  const inputHash = sha256Json(state.snapshot);
  const orderHash = sha256Json({
    away: state.context?.away_batting_order ?? [],
    home: state.context?.home_batting_order ?? [],
  });
  const record = buildConfirmedLineupRunRecord({
    gamePk: Number(opts.gamePk),
    generatedAtUtc,
    generationDate: opts.date,
    lineupSource: { mode: 'current_boxscore', batting_order_hash: orderHash },
    starters,
    models,
    inputHash,
  });
  const stored = writeImmutableRunRecord(opts.stateRoot, opts.date, Number(opts.gamePk), record);
  const delivery = await renderAndDeliver({
    opts,
    state,
    record: stored.record,
    composite: compositeResult,
    sendMessage,
    sendDocument,
    inspect,
  });
  console.log(`[pregame-game-run] confirmed_lineup game_pk=${opts.gamePk} record=${stored.path} packet=${delivery.packetPath} no_send=${opts.noSend}`);
  return {
    status: 'confirmed_lineup',
    recordPath: stored.path,
    recordCreated: stored.created,
    packetPath: delivery.packetPath,
    delivery: delivery.delivery,
    sent: delivery.delivery.status === 'sent',
    refreshes: opts.maxRetries + 1,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runPregameGame().catch(error => {
    console.error(`[pregame-game-run] error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
