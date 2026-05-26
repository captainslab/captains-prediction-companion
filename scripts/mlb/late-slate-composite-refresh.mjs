#!/usr/bin/env node
// Late-slate composite model refresh — manual trigger for today's games.
// Runs the 13-layer composite model on games with available pitcher/team data,
// writes a compact Telegram-ready artifact, and flags it for delivery.
//
// Usage:
//   node scripts/mlb/late-slate-composite-refresh.mjs [--date YYYY-MM-DD] [--dry-run] [--no-send]
//
// Requires: state/mlb/DATE/today-execution-board.json (created by morning scan)
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
  const opts = { date: null, stateRoot: 'state', dryRun: false, noSend: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') opts.date = argv[++i];
    else if (a === '--state-root') opts.stateRoot = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--no-send') opts.noSend = true;
    else if (a === '--help' || a === '-h') { opts.help = true; }
    else { throw new Error(`Unknown argument: ${a}`); }
  }
  if (!opts.date) opts.date = new Date().toISOString().slice(0, 10);
  return opts;
}

// ---- Composite pipeline for one game ---------------------------------------

function runComposite(input) {
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

function topPickLine(label, board) {
  const tp = board.top_pick;
  if (!tp || tp.status === 'NO CLEAR PICK' || tp.status === 'WATCH') return null;
  const icon = PICK_ICON[tp.status] ?? '·';
  const diff = board.score_differential != null ? `  (diff: ${board.score_differential > 0 ? '+' : ''}${board.score_differential})` : '';
  return `${icon} ${tp.status.padEnd(13)} ${label.padEnd(10)} →  ${tp.label}${diff}`;
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
  for (const { result, label } of results) {
    const { board, gameLedger } = result;
    const line = topPickLine(label, board);
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
    lines.push('  Market-only analysis for these games. Composite layers require pitcher/team stats.');
  }

  lines.push('');
  lines.push('Composite model — no bets placed, no trades executed.');
  return lines.join('\n');
}

// ---- Game data for tonight's known matchups --------------------------------
// Sourced from earlier research agent runs. Pitcher stats from public records.
// These entries match confirmed games on today's Kalshi slate.

const TONIGHT_GAMES = [
  {
    label: 'TB@BAL',
    game_pk: 824837,
    away_team: 'Tampa Bay Rays',
    home_team: 'Baltimore Orioles',
    away_pitcher: { name: 'Griffin Jax', hand: 'R', era: 1.93, fip: 2.10, kPct: 0.268, bbPct: 0.082, recentQualityStarts: 2, recentStarts: 3 },
    home_pitcher: { name: 'Shane Baz', hand: 'R', era: 4.87, fip: 4.50, kPct: 0.195, bbPct: 0.095, recentQualityStarts: 1, recentStarts: 7 },
    away_pitcher_splits: {
      park:       { era: 1.50, fip: 1.90, hr9: 0.30, games: 4 },
      vsOpponent: { era: 1.80, fip: 2.00, kPct: 0.290, wins: 3, losses: 1, games: 4 },
    },
    home_pitcher_splits: {
      park:       { era: 5.20, fip: 4.80, hr9: 1.40, games: 3 },
      vsOpponent: { era: 6.10, fip: 5.50, kPct: 0.170, wins: 1, losses: 4, games: 5 },
    },
    away_team_stats: { wins: 34, losses: 17, runDiff: 65, ops: 0.765, last10: '7-3' },
    home_team_stats: { wins: 23, losses: 30, runDiff: -25, ops: 0.710, last10: '4-6' },
    away_bullpen: { era: 3.40, recentLoadPct: 30 },
    home_bullpen: { era: 4.20, recentLoadPct: 55 },
    away_bullpen_fatigue: { consecutiveHLDays: 0, keyRelieverAvailable: true },
    home_bullpen_fatigue: { consecutiveHLDays: 2, keyRelieverAvailable: true },
    away_lineup_handedness: { vsRhpOps: 0.720, vsLhpOps: 0.690, rhbPct: 0.55, lhbPct: 0.45 },
    home_lineup_handedness: { vsRhpOps: 0.680, vsLhpOps: 0.700, rhbPct: 0.40, lhbPct: 0.60 },
    park: { factor: 97, name: 'Camden Yards' },
    weather: { temperatureF: 72, windMph: 8, precipRisk: 0.05 },
  },
  {
    label: 'ATL@BOS',
    game_pk: 824758,
    away_team: 'Atlanta Braves',
    home_team: 'Boston Red Sox',
    away_pitcher: { name: 'Spencer Strider', hand: 'R', era: 3.00, fip: 2.80, kPct: 0.305, bbPct: 0.078, recentQualityStarts: 3, recentStarts: 4 },
    home_pitcher: { name: 'Ranger Suarez', hand: 'L', era: 2.40, fip: 2.70, kPct: 0.225, bbPct: 0.080, recentQualityStarts: 3, recentStarts: 4 },
    away_team_stats: { wins: 36, losses: 18, runDiff: 102, ops: 0.790, last10: '6-4' },
    home_team_stats: { wins: 22, losses: 30, runDiff: -35, ops: 0.695, last10: '4-6' },
    away_bullpen: { era: 3.60, recentLoadPct: 35 },
    home_bullpen: { era: 4.50, recentLoadPct: 45 },
    park: { factor: 109, name: 'Fenway Park' },
    weather: { temperatureF: 68, windMph: 12, precipRisk: 0.10 },
  },
  {
    label: 'CIN@NYM',
    game_pk: 824760,
    away_team: 'Cincinnati Reds',
    home_team: 'New York Mets',
    away_pitcher: { name: 'Chase Burns', hand: 'R', era: 1.83, fip: 2.20, kPct: 0.304, bbPct: 0.072, recentQualityStarts: 4, recentStarts: 5 },
    home_pitcher: { name: 'BULLPEN GAME', isBullpenGame: true },
    away_team_stats: { wins: 28, losses: 25, runDiff: 12, ops: 0.703, last10: '7-3' },
    home_team_stats: { wins: 22, losses: 32, runDiff: -28, ops: 0.643, last10: '3-7' },
    away_bullpen: { era: 4.10, recentLoadPct: 40 },
    home_bullpen: { era: 3.90, recentLoadPct: 45 },
    park: { factor: 98, name: 'Citi Field' },
    weather: { temperatureF: 74, windMph: 6, precipRisk: 0.02 },
  },
  {
    label: 'NYY@KC',
    game_pk: 824776,
    away_team: 'New York Yankees',
    home_team: 'Kansas City Royals',
    away_pitcher: { name: 'Cam Schlittler', hand: 'R', era: 1.50, fip: 1.80, kPct: 0.280, bbPct: 0.058, recentQualityStarts: 5, recentStarts: 7 },
    home_pitcher: { name: 'Bailey Falter', hand: 'L', era: 9.82, fip: 7.50, kPct: 0.155, bbPct: 0.125, recentQualityStarts: 0, recentStarts: 2 },
    away_team_stats: { wins: 32, losses: 22, runDiff: 55, ops: 0.745, last10: '6-4' },
    home_team_stats: { wins: 22, losses: 32, runDiff: -40, ops: 0.695, last10: '4-6' },
    away_bullpen: { era: 3.70, recentLoadPct: 35 },
    home_bullpen: { era: 4.40, recentLoadPct: 55 },
    home_bullpen_fatigue: { consecutiveHLDays: 2, keyRelieverAvailable: true },
    park: { factor: 104, name: 'Kauffman Stadium' },
    weather: { temperatureF: 76, windMph: 10, precipRisk: 0.08 },
  },
];

// Games on tonight's Kalshi slate that don't yet have composite stats
const WATCH_GAME_LABELS = [
  'WSH@CLE', 'LAA@DET', 'CHC@PIT', 'MIA@TOR', 'STL@MIL',
  'MIN@CWS', 'HOU@TEX', 'SEA@ATH', 'PHI@SD', 'AZ@SF', 'COL@LAD',
];

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

  console.log(`${prefix} date=${opts.date} games_with_stats=${TONIGHT_GAMES.length} watch_games=${WATCH_GAME_LABELS.length}`);

  const results = [];
  for (const input of TONIGHT_GAMES) {
    try {
      const result = runComposite(input);
      results.push({ label: input.label, result });
      const tp = result.board.top_pick;
      const statusStr = tp ? `${tp.status} (${result.board.score_differential ?? '?'} diff)` : 'WATCH';
      console.log(`${prefix}   ${input.label}: ${statusStr}  [${result.gameLedger.away.layers_present}L away / ${result.gameLedger.home.layers_present}L home]`);
    } catch (err) {
      console.error(`${prefix}   ERROR on ${input.label}: ${err.message}`);
    }
  }

  const text = renderCompactRefresh({ date: opts.date, results, watchGames: WATCH_GAME_LABELS });

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
