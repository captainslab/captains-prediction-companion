#!/usr/bin/env node
// MLB composite model dry-run.
// Exercises base-fundamentals → evidence-ledger → multi-lane-ceiling
// using research-agent structured input (same shape the pick agents return).
//
// Usage:
//   node scripts/mlb/composite-dry-run.mjs
//   node scripts/mlb/composite-dry-run.mjs --game TB@BAL

import { composeBaseFundamentals } from './lib/base-fundamentals.mjs';
import { composeEvidenceLedgerForGame } from './lib/evidence-ledger.mjs';
import { composeMultiLaneCeilingBoard } from './lib/multi-lane-ceiling.mjs';
import {
  buildFundamentalEnvelopes,
  buildLayerRecords,
} from './source-adapters/research-agent-adapter.mjs';

// ---- fixture inputs (mirrors today's agent pick-card data) -----------------

const FIXTURE_GAMES = [
  {
    label: 'TB@BAL',
    game_pk: 1001,
    away_team: 'Tampa Bay Rays',
    home_team: 'Baltimore Orioles',
    // Game-specific pitcher splits (pitcher_at_this_park + pitcher_vs_this_opponent)
    away_pitcher_splits: {
      park:       { era: 1.50, fip: 1.90, hr9: 0.30, games: 4 },  // Jax at Camden Yards
      vsOpponent: { era: 1.80, fip: 2.00, kPct: 0.290, wins: 3, losses: 1, games: 4 },  // Jax vs BAL
    },
    home_pitcher_splits: {
      park:       { era: 5.20, fip: 4.80, hr9: 1.40, games: 3 },  // Baz at Camden Yards
      vsOpponent: { era: 6.10, fip: 5.50, kPct: 0.170, wins: 1, losses: 4, games: 5 },  // Baz vs TB
    },
    away_team_stats: { wins: 34, losses: 17, runDiff: 65, ops: 0.765, last10: '7-3' },
    home_team_stats: { wins: 23, losses: 30, runDiff: -25, ops: 0.710, last10: '4-6' },
    away_bullpen: { era: 3.40, recentLoadPct: 30 },
    home_bullpen: { era: 4.20, recentLoadPct: 55 },
    // Bullpen fatigue detail (layer 10)
    away_bullpen_fatigue: { consecutiveHLDays: 0, keyRelieverAvailable: true },
    home_bullpen_fatigue: { consecutiveHLDays: 2, keyRelieverAvailable: true },
    // Lineup handedness matchup (layer 11)
    away_lineup_handedness: { vsRhpOps: 0.720, vsLhpOps: 0.690, rhbPct: 0.55, lhbPct: 0.45 },
    home_lineup_handedness: { vsRhpOps: 0.680, vsLhpOps: 0.700, rhbPct: 0.40, lhbPct: 0.60 },
    // pitcher hand for handedness matchup
    away_pitcher: { name: 'Griffin Jax', hand: 'R', era: 1.93, fip: 2.10, kPct: 0.268, bbPct: 0.082, recentQualityStarts: 2, recentStarts: 3 },
    home_pitcher: { name: 'Shane Baz', hand: 'R', era: 4.87, fip: 4.50, kPct: 0.195, bbPct: 0.095, recentQualityStarts: 1, recentStarts: 7 },
    park: { factor: 97, name: 'Camden Yards' },
    weather: { temperatureF: 72, windMph: 8, precipRisk: 0.05 },
  },
  {
    label: 'ATL@BOS',
    game_pk: 1002,
    away_team: 'Atlanta Braves',
    home_team: 'Boston Red Sox',
    away_pitcher: { name: 'Spencer Strider', era: 3.00, fip: 2.80, kPct: 0.305, bbPct: 0.078, recentQualityStarts: 3, recentStarts: 4 },
    home_pitcher: { name: 'Ranger Suarez', era: 2.40, fip: 2.70, kPct: 0.225, bbPct: 0.080, recentQualityStarts: 3, recentStarts: 4 },
    away_team_stats: { wins: 36, losses: 18, runDiff: 102, ops: 0.790, last10: '6-4' },
    home_team_stats: { wins: 22, losses: 30, runDiff: -35, ops: 0.695, last10: '4-6' },
    away_bullpen: { era: 3.60, recentLoadPct: 35 },
    home_bullpen: { era: 4.50, recentLoadPct: 45 },
    park: { factor: 109, name: 'Fenway Park' },
    weather: { temperatureF: 68, windMph: 12, precipRisk: 0.10 },
  },
  {
    label: 'CIN@NYM',
    game_pk: 1003,
    away_team: 'Cincinnati Reds',
    home_team: 'New York Mets',
    away_pitcher: { name: 'Chase Burns', era: 1.83, fip: 2.20, kPct: 0.304, bbPct: 0.072, recentQualityStarts: 4, recentStarts: 5 },
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
    game_pk: 1004,
    away_team: 'New York Yankees',
    home_team: 'Kansas City Royals',
    away_pitcher: { name: 'Cam Schlittler', era: 1.50, fip: 1.80, kPct: 0.280, bbPct: 0.058, recentQualityStarts: 5, recentStarts: 7 },
    home_pitcher: { name: 'Bailey Falter', era: 9.82, fip: 7.50, kPct: 0.155, bbPct: 0.125, recentQualityStarts: 0, recentStarts: 2 },
    away_team_stats: { wins: 32, losses: 22, runDiff: 55, ops: 0.745, last10: '6-4' },
    home_team_stats: { wins: 22, losses: 32, runDiff: -40, ops: 0.695, last10: '4-6' },
    away_bullpen: { era: 3.70, recentLoadPct: 35 },
    home_bullpen: { era: 4.40, recentLoadPct: 55 },
    park: { factor: 104, name: 'Kauffman Stadium' },
    weather: { temperatureF: 76, windMph: 10, precipRisk: 0.08 },
  },
];

// ---- run composite model for one game -------------------------------------

function runCompositeForGame(input) {
  const game = { game_pk: input.game_pk, away_team: input.away_team, home_team: input.home_team };

  // 1. Build fundamental envelopes from research-agent data
  const envelopes = buildFundamentalEnvelopes(input);

  // 2. Compose base fundamentals (4 layers → per-side ratings + data quality)
  const fundamentals = composeBaseFundamentals({ game, envelopes });

  // 3. Build layer records (season form, recent form, pitcher signal, etc.)
  const layers = buildLayerRecords(input);

  // 4. Compose 13-layer evidence ledger for both sides
  const gameLedger = composeEvidenceLedgerForGame({
    game,
    awaySide:               fundamentals.away,
    homeSide:               fundamentals.home,
    awaySeasonForm:         layers.away.seasonForm          ?? null,
    homeSeasonForm:         layers.home.seasonForm          ?? null,
    awayRecentForm:         layers.away.recentForm          ?? null,
    homeRecentForm:         layers.home.recentForm          ?? null,
    awayPitcherSignal:      layers.away.pitcherSignal       ?? null,
    homePitcherSignal:      layers.home.pitcherSignal       ?? null,
    awayPitcherAtPark:      layers.away.pitcherAtPark       ?? null,
    homePitcherAtPark:      layers.home.pitcherAtPark       ?? null,
    awayPitcherVsOpponent:  layers.away.pitcherVsOpponent   ?? null,
    homePitcherVsOpponent:  layers.home.pitcherVsOpponent   ?? null,
    parkWeatherRecord:      layers.away.parkWeather         ?? null,
    awayMatchupSplits:      layers.away.matchupSplits       ?? null,
    homeMatchupSplits:      layers.home.matchupSplits       ?? null,
    awayLineupInjury:       layers.away.lineupInjury        ?? null,
    homeLineupInjury:       layers.home.lineupInjury        ?? null,
    awayBullpenFatigue:     layers.away.bullpenFatigue      ?? null,
    homeBullpenFatigue:     layers.home.bullpenFatigue      ?? null,
    awayLineupHandedness:   layers.away.lineupHandedness    ?? null,
    homeLineupHandedness:   layers.home.lineupHandedness    ?? null,
    gameVolatilityRecord:   layers.away.gameVolatility      ?? null,
    umpireBiasRecord:       layers.away.umpireBias          ?? null,
  });

  // 5. Produce per-lane ceiling board
  const board = composeMultiLaneCeilingBoard({ gameLedger });

  return { game, fundamentals, gameLedger, board };
}

// ---- print helper ----------------------------------------------------------

function printBoard(label, board) {
  const { away_team: at, home_team: ht, score_differential: diff, stronger_side: ss } = board;
  console.log(`\n${'='.repeat(56)}`);
  console.log(`  ${label}  |  ${at} @ ${ht}`);
  console.log(`  Away composite: ${board.away_composite_score ?? 'n/a'}  |  Home composite: ${board.home_composite_score ?? 'n/a'}`);
  console.log(`  Differential: ${diff ?? 'n/a'}  |  Stronger: ${ss ?? 'n/a'}`);
  console.log(`  Combined DQ: ${board.combined_data_quality}`);
  console.log(`${'─'.repeat(56)}`);

  const lanes = board.lanes;
  for (const [key, lane] of Object.entries(lanes)) {
    if (lane.status === 'NO CLEAR PICK' && lane.score === null) continue; // skip pure nulls
    const flag = lane.status === 'PICK' ? '★ ' : lane.status === 'EVIDENCE_LEAN' ? '◆ ' : lane.status === 'LEAN' ? '◇ ' : '  ';
    console.log(`  ${flag}${lane.label.padEnd(22)} ${lane.status.padEnd(14)} score=${String(lane.score ?? '—').padStart(3)}${lane.differential != null ? `  diff=${lane.differential}` : ''}`);
    if (lane.reasons?.length) console.log(`      ↳ ${lane.reasons.join(', ')}`);
  }

  if (board.top_pick) {
    console.log(`${'─'.repeat(56)}`);
    console.log(`  TOP PICK: ${board.top_pick.label} → ${board.top_pick.status}`);
  }
}

function printEvidenceLedger(side, ledger) {
  if (!ledger) return;
  console.log(`\n  Evidence ledger — ${ledger.team_name ?? side} (composite: ${ledger.composite_score ?? 'n/a'}, layers: ${ledger.layers_present})`);
  for (const row of ledger.evidence_ledger ?? []) {
    const mark = row.present ? '✓' : '✗';
    console.log(`    ${mark} ${row.category.padEnd(28)} ${row.present ? `score=${String(row.value).padStart(3)} (${row.grade})` : 'MISSING'}`);
    if (row.missing_note) console.log(`        → ${row.missing_note}`);
  }
}

// ---- main ------------------------------------------------------------------

const targetLabel = process.argv.find(a => !a.startsWith('--') && a.includes('@'));
const games = targetLabel
  ? FIXTURE_GAMES.filter(g => g.label.toLowerCase().includes(targetLabel.toLowerCase()))
  : FIXTURE_GAMES;

if (games.length === 0) {
  console.error(`No fixture game matching "${targetLabel}". Available: ${FIXTURE_GAMES.map(g => g.label).join(', ')}`);
  process.exit(1);
}

console.log(`\nMLB Composite Dry-Run — ${new Date().toISOString().slice(0, 10)}`);
console.log(`Running ${games.length} game(s)...\n`);

for (const input of games) {
  try {
    const { gameLedger, board } = runCompositeForGame(input);
    printBoard(input.label, board);
    if (process.argv.includes('--verbose')) {
      printEvidenceLedger('away', gameLedger.away);
      printEvidenceLedger('home', gameLedger.home);
    }
  } catch (err) {
    console.error(`\nERROR on ${input.label}: ${err.message}`);
    if (process.argv.includes('--verbose')) console.error(err.stack);
  }
}

console.log(`\n${'='.repeat(56)}`);
console.log('Composite dry-run complete. No trades placed.');
