#!/usr/bin/env node
// Late-slate composite model refresh — manual trigger for today's games.
// Runs the 13-layer composite model on games with available pitcher/team data,
// writes a compact Telegram-ready artifact, and flags it for delivery.
//
// Usage:
//   node scripts/mlb/late-slate-composite-refresh.mjs [--date YYYY-MM-DD] [--dry-run] [--no-send]
//
// Requires: state/mlb/DATE/discovery/{mlb_official,stats,weather,context}_adapter.json
// No trades. No bankroll. Composite model only.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { composeBaseFundamentals } from './lib/base-fundamentals.mjs';
import { composeEvidenceLedgerForGame } from './lib/evidence-ledger.mjs';
import { composeMultiLaneCeilingBoard } from './lib/multi-lane-ceiling.mjs';
import {
  buildFundamentalEnvelopes,
  buildLayerRecords,
} from './source-adapters/research-agent-adapter.mjs';

// ---- Arg parsing -----------------------------------------------------------

function parseArgs(argv) {
  const opts = { date: null, stateRoot: 'state', dryRun: false, noSend: false, allowPendingLineups: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') opts.date = argv[++i];
    else if (a === '--state-root') opts.stateRoot = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--no-send') opts.noSend = true;
    else if (a === '--allow-pending-lineups') opts.allowPendingLineups = true;
    else if (a === '--help' || a === '-h') { opts.help = true; }
    else { throw new Error(`Unknown argument: ${a}`); }
  }
  if (!opts.date) opts.date = new Date().toISOString().slice(0, 10);
  return opts;
}

// ---- Composite pipeline for one game ---------------------------------------

export function runComposite(input) {
  const game = { game_pk: input.game_pk, away_team: input.away_team, home_team: input.home_team };
  const envelopes = buildFundamentalEnvelopes(input);
  const fundamentals = composeBaseFundamentals({ game, envelopes });
  const layers = buildLayerRecords(input);
  const gameLedger = composeEvidenceLedgerForGame({
    game,
    awaySide:              fundamentals.away,
    homeSide:              fundamentals.home,
    awaySeasonForm:        layers.away.seasonForm         ?? null,
    homeSeasonForm:        layers.home.seasonForm         ?? null,
    awayRecentForm:        layers.away.recentForm         ?? null,
    homeRecentForm:        layers.home.recentForm         ?? null,
    awayPitcherSignal:     layers.away.pitcherSignal      ?? null,
    homePitcherSignal:     layers.home.pitcherSignal      ?? null,
    awayPitcherAtPark:     layers.away.pitcherAtPark      ?? null,
    homePitcherAtPark:     layers.home.pitcherAtPark      ?? null,
    awayPitcherVsOpponent: layers.away.pitcherVsOpponent  ?? null,
    homePitcherVsOpponent: layers.home.pitcherVsOpponent  ?? null,
    parkWeatherRecord:     layers.away.parkWeather        ?? null,
    awayMatchupSplits:     layers.away.matchupSplits      ?? null,
    homeMatchupSplits:     layers.home.matchupSplits      ?? null,
    awayLineupInjury:      layers.away.lineupInjury       ?? null,
    homeLineupInjury:      layers.home.lineupInjury       ?? null,
    awayBullpenFatigue:    layers.away.bullpenFatigue     ?? null,
    homeBullpenFatigue:    layers.home.bullpenFatigue     ?? null,
    awayLineupHandedness:  layers.away.lineupHandedness   ?? null,
    homeLineupHandedness:  layers.home.lineupHandedness   ?? null,
    gameVolatilityRecord:  layers.away.gameVolatility     ?? null,
    umpireBiasRecord:      layers.away.umpireBias         ?? null,
  });
  const board = composeMultiLaneCeilingBoard({ gameLedger });
  return { game, gameLedger, board };
}

// ---- Compact renderer ------------------------------------------------------

const PICK_ICON   = { PICK: '★', EVIDENCE_LEAN: '◆', LEAN: '◇', WATCH: '○' };

function topPickMetricText(tp) {
  if (!tp) return '';
  const sideLane = tp.lane?.startsWith('moneyline') || tp.lane?.startsWith('run_line');
  if (sideLane) return tp.differential != null ? `(diff: ${tp.differential > 0 ? '+' : ''}${tp.differential})` : '';
  return tp.score != null ? `(signal: ${tp.score})` : '';
}

function topPickLine(label, board, ouLine) {
  const tp = board.top_pick;
  if (!tp || tp.status === 'NO CLEAR PICK' || tp.status === 'WATCH') return null;
  const icon = PICK_ICON[tp.status] ?? '·';
  const metric = topPickMetricText(tp);
  let pickLabel = tp.label;
  if (ouLine != null && (tp.lane === 'total_over' || tp.lane === 'total_under')) {
    pickLabel = tp.label.replace(/^Total /, '') + ' ' + ouLine;
  }
  return `${icon} ${tp.status.padEnd(13)} ${label.padEnd(10)} →  ${pickLabel}${metric ? `  ${metric}` : ''}`;
}

function whyLine(board, gameLedger) {
  // Find the strongest away and home pitcher signal details
  const awayLedger = gameLedger.away;
  const homeLedger = gameLedger.home;
  const reasons = [];

  // Pitcher signal details for the STRONGER side
  const strongerSide = board.stronger_side;
  const strongerLedger = strongerSide === 'away' ? awayLedger : homeLedger;
  const weakerLedger   = strongerSide === 'away' ? homeLedger : awayLedger;

  const pitchRow = strongerLedger?.evidence_ledger?.find(r => r.category === 'starting_pitcher_signal');
  if (pitchRow?.present) reasons.push(pitchRow.detail);

  const vsRow = strongerLedger?.evidence_ledger?.find(r => r.category === 'pitcher_vs_this_opponent');
  if (vsRow?.present && vsRow.detail) reasons.push(`vs-opp: ${vsRow.detail.split(',')[0]}`);

  const recentRow = strongerLedger?.evidence_ledger?.find(r => r.category === 'recent_form');
  if (recentRow?.present && recentRow.detail) reasons.push(recentRow.detail);

  const weakerPitchRow = weakerLedger?.evidence_ledger?.find(r => r.category === 'starting_pitcher_signal');
  if (weakerPitchRow?.present && weakerPitchRow.detail) {
    const frag = weakerPitchRow.detail.split(',').slice(0, 2).join(',');
    reasons.push(`opp: ${frag}`);
  }

  const bfRow = strongerLedger?.evidence_ledger?.find(r => r.category === 'bullpen_fatigue_availability');
  if (bfRow?.present && bfRow.score < 55) reasons.push(`bullpen load: ${bfRow.detail?.split(',')[1]?.trim() ?? 'taxed'}`);

  const handRow = strongerLedger?.evidence_ledger?.find(r => r.category === 'lineup_handedness_matchup');
  if (handRow?.present && handRow.detail) reasons.push(`hand: ${handRow.detail.split(',')[0]}`);

  const full = reasons.filter(Boolean).join('. ').replace(/\s+/g, ' ');
  // Max 2 sentences / 220 chars
  const sentences = full.split('. ').filter(Boolean);
  const out = sentences.length > 2 ? sentences.slice(0, 2).join('. ') + '.' : full;
  return out.length > 220 ? out.slice(0, 217) + '...' : out;
}

function renderCompactRefresh({ date, results, watchGames }) {
  const lines = [
    `=== Captain MLB — Composite Refresh ${date} ===`,
    `13-layer model (market-neutral). Evidence scores only. No trades placed.`,
    '',
  ];

  // Picks section
  let pickCount = 0;
  for (const { result, label, ouLine } of results) {
    const { board, gameLedger } = result;
    const line = topPickLine(label, board, ouLine);
    if (line) {
      lines.push(line);
      const why = whyLine(board, gameLedger);
      if (why) lines.push(`  ↳ ${why}`);
      pickCount++;
    }
  }

  if (pickCount === 0) {
    lines.push('○ NO CLEAR PICKS — composite data insufficient for actionable signals today.');
  }

  // Watch section
  if (watchGames.length > 0) {
    lines.push('');
    lines.push(`○ WATCH (composite pending): ${watchGames.join(' · ')}`);
    lines.push('  Composite requires confirmed lineup state plus source-backed pitcher/team stats.');
  }

  lines.push('');
  lines.push('Composite model — no bets placed, no trades executed.');
  return lines.join('\n');
}

// ---- Dynamic discovery input builder ---------------------------------------

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function indexByGamePk(envelope) {
  const map = new Map();
  for (const record of safeArray(envelope?.records)) {
    if (record.game_pk !== null && record.game_pk !== undefined && !map.has(record.game_pk)) {
      map.set(record.game_pk, record);
    }
  }
  return map;
}

function labelForGame(game, stats) {
  if (stats?.label) return stats.label;
  if (stats?.away_team_abbrev && stats?.home_team_abbrev) return `${stats.away_team_abbrev}@${stats.home_team_abbrev}`;
  const abbrev = name => String(name ?? '')
    .split(/\s+/)
    .map(part => part[0])
    .join('')
    .slice(0, 3)
    .toUpperCase();
  return `${abbrev(game?.away_team)}@${abbrev(game?.home_team)}`;
}

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).match(/-?\d+(\.\d+)?/)?.[0] ?? value);
  return Number.isFinite(n) ? n : null;
}

function normalizePrecip(value) {
  const n = numeric(value);
  if (n === null) return null;
  return n > 1 ? n / 100 : n;
}

function normalizeLineupStatus(context) {
  const raw = String(context?.lineup_status ?? '').toLowerCase();
  if (!raw) return null;
  if (raw === 'confirmed' || raw === 'confirmed_or_boxscore_available' || raw.includes('boxscore')) return 'confirmed';
  if (raw.includes('pending')) return 'pending';
  if (raw.includes('incomplete')) return 'incomplete';
  return raw;
}

function mapPitcher(pitcher) {
  if (!pitcher) return null;
  return {
    name: pitcher.name ?? null,
    id: pitcher.id ?? pitcher.mlb_id ?? null,
    mlb_id: pitcher.mlb_id ?? pitcher.id ?? null,
    hand: pitcher.hand ?? null,
    era: numeric(pitcher.era),
    fip: numeric(pitcher.fip),
    fip_source: pitcher.fip_source ?? null,
    era_source: pitcher.era_source ?? null,
    whip: numeric(pitcher.whip),
    k_per_9: numeric(pitcher.k_per_9),
    bb_per_9: numeric(pitcher.bb_per_9),
    kPct: numeric(pitcher.kPct ?? pitcher.k_pct),
    bbPct: numeric(pitcher.bbPct ?? pitcher.bb_pct),
    recentQualityStarts: numeric(pitcher.recentQualityStarts ?? pitcher.quality_starts),
    recentStarts: numeric(pitcher.recentStarts ?? pitcher.games_started),
    isBullpenGame: pitcher.isBullpenGame ?? false,
  };
}

function mapTeamStats(teamStats) {
  if (!teamStats) return null;
  return {
    wins: numeric(teamStats.wins),
    losses: numeric(teamStats.losses),
    gamesPlayed: numeric(teamStats.gamesPlayed),
    runDiff: numeric(teamStats.runDiff ?? teamStats.run_diff),
    ops: numeric(teamStats.ops),
    woba: numeric(teamStats.woba),
    woba_proxy: numeric(teamStats.woba_proxy),
    woba_proxy_source: teamStats.woba_proxy_source ?? null,
    last10: teamStats.last10 ?? null,
    last5: teamStats.last5 ?? null,
    trend: teamStats.trend ?? null,
  };
}

function mapPitcherSplits(pitcher, opponentTeamName) {
  if (!pitcher) return null;
  const out = {};
  const park = pitcher.at_park ?? null;
  if (park && (park.era != null || park.ip != null || park.gs != null)) {
    out.park = {
      era: numeric(park.era),
      fip: null,
      hr9: null,
      games: numeric(park.gs),
      source_path: park.source_path ?? null,
    };
  }
  const vs = pitcher.vs_opponent ?? null;
  if (vs && (vs.era != null || vs.ip != null)) {
    out.vsOpponent = {
      era: numeric(vs.era),
      fip: null,
      kPct: null,
      wins: null,
      losses: null,
      games: null,
      span: vs.span ?? null,
      source_path: vs.source_path ?? null,
      opponent: opponentTeamName ?? null,
    };
  }
  return Object.keys(out).length ? out : null;
}

function mapBullpen(bullpen) {
  if (!bullpen) return null;
  return {
    era: numeric(bullpen.era),
    whip: numeric(bullpen.whip),
    recentLoadPct: numeric(bullpen.recentLoadPct),
  };
}

function mapLineupHandedness(source) {
  if (!source) return null;
  return {
    vsRhpOps: numeric(source.vsRhpOps ?? source.vs_rhp_ops),
    vsLhpOps: numeric(source.vsLhpOps ?? source.vs_lhp_ops),
    rhbPct: numeric(source.rhbPct),
    lhbPct: numeric(source.lhbPct),
  };
}

function mapWeather(weather) {
  if (!weather) return null;
  return {
    temperatureF: numeric(weather.temperature ?? weather.temperatureF),
    windMph: numeric(weather.wind_speed ?? weather.windMph),
    precipRisk: normalizePrecip(weather.precipitation_risk ?? weather.precipRisk),
    roofType: weather.roof_type ?? weather.roof_status ?? null,
  };
}

function missingStatsReasons(stats) {
  const reasons = [];
  if (!stats) return ['stats_missing'];
  if (numeric(stats.away_pitcher?.era) === null) reasons.push('away_pitcher_era_missing');
  if (numeric(stats.home_pitcher?.era) === null) reasons.push('home_pitcher_era_missing');
  if (numeric(stats.away_team_stats?.ops ?? stats.away_team_ops) === null) reasons.push('away_team_ops_missing');
  if (numeric(stats.home_team_stats?.ops ?? stats.home_team_ops) === null) reasons.push('home_team_ops_missing');
  if (!stats.away_pitcher?.mlb_id && !stats.away_pitcher?.id) reasons.push('away_probable_id_missing');
  if (!stats.home_pitcher?.mlb_id && !stats.home_pitcher?.id) reasons.push('home_probable_id_missing');
  return reasons;
}

function buildResearchInput({ game, stats, weather, context }) {
  const lineupStatus = normalizeLineupStatus(context) ?? 'pending';
  const venueName = weather?.venue ?? stats?.venue ?? game?.venue ?? null;
  return {
    label: labelForGame(game, stats),
    game_pk: game?.game_pk ?? stats?.game_pk ?? null,
    away_team: game?.away_team ?? stats?.away_team ?? null,
    home_team: game?.home_team ?? stats?.home_team ?? null,
    away_pitcher: mapPitcher(stats?.away_pitcher),
    home_pitcher: mapPitcher(stats?.home_pitcher),
    away_team_stats: mapTeamStats(stats?.away_team_stats ?? {
      ops: stats?.away_team_ops,
      woba: stats?.away_team_woba,
      woba_proxy: stats?.away_team_woba_proxy,
    }),
    home_team_stats: mapTeamStats(stats?.home_team_stats ?? {
      ops: stats?.home_team_ops,
      woba: stats?.home_team_woba,
      woba_proxy: stats?.home_team_woba_proxy,
    }),
    away_pitcher_splits: mapPitcherSplits(stats?.away_pitcher, game?.home_team ?? stats?.home_team),
    home_pitcher_splits: mapPitcherSplits(stats?.home_pitcher, game?.away_team ?? stats?.away_team),
    away_bullpen: mapBullpen(stats?.away_bullpen),
    home_bullpen: mapBullpen(stats?.home_bullpen),
    away_lineup: { status: lineupStatus, ilHealth: null },
    home_lineup: { status: lineupStatus, ilHealth: null },
    away_lineup_handedness: mapLineupHandedness(stats?.away_lineup_handedness),
    home_lineup_handedness: mapLineupHandedness(stats?.home_lineup_handedness),
    park: venueName ? { factor: 100, name: venueName, factor_note: 'neutral default; park-factor adapter not wired' } : null,
    weather: mapWeather(weather),
  };
}

export function loadDynamicCompositeSlate({ date, stateRoot = 'state', allowPendingLineups = false } = {}) {
  const discoveryDir = resolve(stateRoot, 'mlb', date, 'discovery');
  const mlb = readJsonIfExists(resolve(discoveryDir, 'mlb_official_adapter.json'));
  const stats = readJsonIfExists(resolve(discoveryDir, 'stats_adapter.json'));
  const weather = readJsonIfExists(resolve(discoveryDir, 'weather_adapter.json'));
  const context = readJsonIfExists(resolve(discoveryDir, 'context_adapter.json'));

  const sportsbook = readJsonIfExists(resolve(discoveryDir, 'sportsbook_adapter.json'));
  const statsByGame = indexByGamePk(stats);
  const weatherByGame = indexByGamePk(weather);
  const contextByGame = indexByGamePk(context);
  const sbOuByTeams = new Map();
  for (const rec of safeArray(sportsbook?.records)) {
    if (rec.over_under != null) sbOuByTeams.set(`${rec.away_team}|${rec.home_team}`, rec.over_under);
  }
  const games = safeArray(mlb?.records).length > 0 ? safeArray(mlb.records) : safeArray(stats?.records);
  const inputs = [];
  const watchDetails = [];

  for (const game of games) {
    const statsRecord = statsByGame.get(game.game_pk);
    const weatherRecord = weatherByGame.get(game.game_pk) ?? null;
    const contextRecord = contextByGame.get(game.game_pk) ?? null;
    const label = labelForGame(game, statsRecord);
    const reasons = missingStatsReasons(statsRecord);
    const lineupStatus = normalizeLineupStatus(contextRecord);
    if (!allowPendingLineups && lineupStatus !== 'confirmed') {
      reasons.push(`lineup_${lineupStatus ?? 'missing'}`);
    }

    if (reasons.length > 0) {
      watchDetails.push({ label, game_pk: game.game_pk ?? null, reasons });
      continue;
    }

    const input = buildResearchInput({
      game,
      stats: statsRecord,
      weather: weatherRecord,
      context: contextRecord,
    });
    input.ou_line = sbOuByTeams.get(`${game.away_team}|${game.home_team}`) ?? null;
    inputs.push(input);
  }

  return {
    discoveryDir,
    inputs,
    watchDetails,
    watchGames: watchDetails.map(item => `${item.label} (${item.reasons.join(', ')})`),
    counts: {
      mlb_games: games.length,
      stats_records: safeArray(stats?.records).length,
      weather_records: safeArray(weather?.records).length,
      context_records: safeArray(context?.records).length,
    },
  };
}

// ---- Plan file helpers -----------------------------------------------------

function atomicWrite(filePath, content) {
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, content);
  renameSync(tmp, filePath);
}

function addRefreshWindow(planPath, artifactPath, compactPath) {
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const windowId = `composite-refresh-${Date.now()}`;
  const window = {
    cluster_id: 'composite-refresh',
    idempotency_key: windowId,
    report_at_utc: new Date().toISOString(),
    status: 'rendered',
    last_artifact: artifactPath,
    compact_artifact: compactPath,
    delivered_idempotency_key: null,
    source: 'late-slate-composite-refresh',
  };
  if (!Array.isArray(plan.report_windows)) plan.report_windows = [];
  // Remove any previous composite-refresh windows to avoid duplicates
  plan.report_windows = plan.report_windows.filter(w => w.cluster_id !== 'composite-refresh');
  plan.report_windows.push(window);
  atomicWrite(planPath, JSON.stringify(plan, null, 2));
  return windowId;
}

// ---- Main ------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const prefix = opts.dryRun ? '[dry-run]' : '[composite-refresh]';
  const stateDir = resolve(opts.stateRoot, 'mlb', opts.date);
  mkdirSync(stateDir, { recursive: true });
  const slate = loadDynamicCompositeSlate({
    date: opts.date,
    stateRoot: opts.stateRoot,
    allowPendingLineups: opts.allowPendingLineups,
  });

  console.log(`${prefix} date=${opts.date} games_evaluated=${slate.inputs.length} watch_games=${slate.watchGames.length} stats_records=${slate.counts.stats_records}`);

  const results = [];
  for (const input of slate.inputs) {
    try {
      const result = runComposite(input);
      results.push({ label: input.label, result, ouLine: input.ou_line ?? null });
      const tp = result.board.top_pick;
      const metric = topPickMetricText(tp);
      const statusStr = tp ? `${tp.status}${metric ? ` ${metric}` : ''}` : 'WATCH';
      console.log(`${prefix}   ${input.label}: ${statusStr}  [${result.gameLedger.away.layers_present}L away / ${result.gameLedger.home.layers_present}L home]`);
    } catch (err) {
      console.error(`${prefix}   ERROR on ${input.label}: ${err.message}`);
    }
  }

  const text = renderCompactRefresh({ date: opts.date, results, watchGames: slate.watchGames });

  const outPath    = resolve(stateDir, 'composite-refresh-verbose.txt');
  const compactPath = resolve(stateDir, 'composite-refresh-compact.txt');

  if (!opts.dryRun) {
    writeFileSync(outPath, text, 'utf8');
    writeFileSync(compactPath, text, 'utf8');
    console.log(`${prefix} artifact_written=${compactPath}`);

    const planPath = resolve(stateDir, 'slate-run-plan.json');
    if (existsSync(planPath)) {
      const windowId = addRefreshWindow(planPath, outPath, compactPath);
      console.log(`${prefix} report_window_added id=${windowId}`);
    } else {
      console.log(`${prefix} no slate-run-plan.json — skipping window registration`);
    }
  } else {
    console.log(`${prefix} [DRY-RUN] would write artifact to ${compactPath}`);
  }

  console.log('');
  console.log(text);
  console.log('');
  console.log(`${prefix} No trades placed. Composite model scores only.`);

  if (!opts.noSend && !opts.dryRun) {
    console.log(`${prefix} Running _send-due.mjs ...`);
    const r = spawnSync(process.execPath, ['scripts/mlb/_send-due.mjs'], {
      stdio: 'inherit',
      env: { ...process.env },
    });
    if (r.status !== 0) {
      console.error(`${prefix} _send-due.mjs exited status=${r.status}`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`[composite-refresh] error: ${err.message}`);
    if (process.argv.includes('--verbose')) console.error(err.stack);
    process.exit(1);
  });
}
