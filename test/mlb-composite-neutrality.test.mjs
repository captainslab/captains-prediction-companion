// MLB composite model-neutrality protection tests.
//
// Purpose: PIN the correct behavior of the clean 13-layer composite BEFORE any
// scoring-core / odds-derived-fair_value refactor, so that the next change cannot
// silently (a) break layer-weight normalization, (b) break the data-coverage
// PICK gates, or (c) let a market/odds/price field move the independent projection.
//
// These tests assert the CARDINAL RULE: market prices NEVER feed the composite
// score or the lane recommendation. They are pure unit tests — no I/O, no network.
//
// Three groups:
//   1. evidence-ledger weight-sum + missing-layer renormalization + PICK gates
//   2. odds-isolation regression (full pipeline, polluted vs clean → identical)
//   3. guard: a price/odds field reaching a scored layer must NOT change output
//
// If any of these fail after a scoring change, the change touched model neutrality.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  composeEvidenceLedgerForSide,
  composeEvidenceLedgerForGame,
} from '../scripts/mlb/lib/evidence-ledger.mjs';
import { composeMultiLaneCeilingBoard } from '../scripts/mlb/lib/multi-lane-ceiling.mjs';
import { composeBaseFundamentals } from '../scripts/mlb/lib/base-fundamentals.mjs';
import {
  buildFundamentalEnvelopes,
  buildLayerRecords,
} from '../scripts/mlb/source-adapters/research-agent-adapter.mjs';

// Forbidden market/odds/price JSON KEYS that must never appear in composite output.
// Quoted to avoid substring false-positives ('line' is a substring of 'lineup',
// 'baseline', etc., so we match exact JSON keys, mirroring the NASCAR neutrality test).
const FORBIDDEN_KEYS = [
  '"fair_value"', '"edge"', '"kelly"', '"stake"', '"vig"', '"implied_prob"',
  '"market_prob"', '"yes_ask"', '"no_bid"', '"yes_bid"', '"no_ask"',
  '"kalshi_ask"', '"kalshi_bid"', '"moneyline_odds"', '"price"', '"odds"',
];

function assertNoForbiddenKeys(obj, ctx) {
  const json = JSON.stringify(obj);
  for (const k of FORBIDDEN_KEYS) {
    assert.ok(!json.includes(k), `${ctx}: forbidden market/odds key leaked into output: ${k}`);
  }
}

// ---------------------------------------------------------------------------
// GROUP 1a — LAYER_DEFS weights sum to exactly 1.00 (source-of-truth invariant)
// ---------------------------------------------------------------------------
// LAYER_DEFS is module-private, so we assert the literal invariant against source.
// A behavioral cross-check (1b) proves the weights are actually applied as a
// normalized average.

test('evidence-ledger LAYER_DEFS: exactly 13 layers whose weights sum to 1.00', () => {
  const src = readFileSync(new URL('../scripts/mlb/lib/evidence-ledger.mjs', import.meta.url), 'utf8');
  const start = src.indexOf('const LAYER_DEFS = Object.freeze([');
  assert.ok(start !== -1, 'LAYER_DEFS block not found in evidence-ledger.mjs');
  const end = src.indexOf(']);', start);
  assert.ok(end !== -1, 'LAYER_DEFS block terminator not found');
  const block = src.slice(start, end);
  const weights = [...block.matchAll(/weight:\s*([0-9]*\.?[0-9]+)/g)].map(m => Number(m[1]));
  assert.equal(weights.length, 13, `expected 13 layer weights, found ${weights.length}`);
  const sum = weights.reduce((s, w) => s + w, 0);
  assert.ok(Math.abs(sum - 1.0) < 1e-9, `LAYER_DEFS weights must sum to 1.00, got ${sum}`);
});

// ---------------------------------------------------------------------------
// GROUP 1b — Missing-layer renormalization
// ---------------------------------------------------------------------------

const r = (score) => ({ present: true, score });
const NEUTRAL_SIDE_70 = {
  pitcher_quality_rating: 70, team_offense_rating: 70,
  bullpen_quality_rating: 70, park_weather_rating: 70,
};

test('renormalization: all-13-layers-present at equal score → composite equals that score', () => {
  const side = composeEvidenceLedgerForSide({
    sideEntry: NEUTRAL_SIDE_70,
    seasonFormRecord: r(70), recentFormRecord: r(70), pitcherSignalRecord: r(70),
    pitcherAtParkRecord: r(70), pitcherVsOpponentRecord: r(70), parkWeatherRecord: r(70),
    matchupSplitsRecord: r(70), lineupInjuryRecord: r(70), bullpenFatigueRecord: r(70),
    lineupHandednessRecord: r(70), gameVolatilityRecord: r(70), umpireBiasRecord: r(70),
  });
  assert.equal(side.layers_present, 13);
  assert.equal(side.composite_score, 70);
});

test('renormalization: only 3 layers present at equal score → SAME composite (missing layers are not zero-filled)', () => {
  const side = composeEvidenceLedgerForSide({
    sideEntry: NEUTRAL_SIDE_70,        // baseline_fundamentals present (70)
    seasonFormRecord: r(70),           // season_form present (70)
    recentFormRecord: r(70),           // recent_form present (70)
    // all other 10 layers omitted → missing
  });
  assert.equal(side.layers_present, 3);
  // If missing layers were treated as 0, composite would collapse far below 70.
  assert.equal(side.composite_score, 70);
  // present rows' normalized weights must re-sum to 1.00
  const present = side.evidence_ledger.filter(x => x.present);
  const nwSum = present.reduce((s, x) => s + x.normalized_weight, 0);
  // normalized_weight is stored .toFixed(4) (see evidence-ledger.mjs), so allow
  // for 4-decimal display rounding. Tolerance still catches zero-fill dilution,
  // which would push the re-sum to ~0.35.
  assert.ok(Math.abs(nwSum - 1.0) < 1e-3, `normalized weights of present layers must re-sum to 1.00, got ${nwSum}`);
});

test('renormalization: composite is the weighted average of PRESENT layers only, not diluted by missing', () => {
  // baseline_fundamentals=80 (w0.12) and season_form=40 (w0.12), nothing else.
  // Renormalized: (80*0.12 + 40*0.12) / (0.12+0.12) = 60.
  // If missing layers diluted (den=1.0): (9.6+4.8)/1.0 = 14 → would FAIL this assert.
  const side = composeEvidenceLedgerForSide({
    sideEntry: {
      pitcher_quality_rating: 80, team_offense_rating: 80,
      bullpen_quality_rating: 80, park_weather_rating: 80,
    },
    seasonFormRecord: r(40),
  });
  assert.equal(side.layers_present, 2);
  assert.equal(side.composite_score, 60);
});

test('renormalization: zero usable layers → composite null + NO CLEAR PICK reasoning', () => {
  const side = composeEvidenceLedgerForSide({ sideEntry: {} });
  assert.equal(side.composite_score, null);
  assert.equal(side.layers_present, 0);
  assert.match(side.reasoning_summary, /NO CLEAR PICK/);
});

// ---------------------------------------------------------------------------
// GROUP 1c — Data-coverage PICK gates (multi-lane-ceiling)
// ---------------------------------------------------------------------------
// Drive the real composer with synthetic ledgers giving exact control over
// composite_score and layers_present, then assert the documented caps:
//   0 layers → NO CLEAR PICK ; degraded DQ → WATCH max ;
//   2 layers → EVIDENCE_LEAN max ; 3+ layers ok DQ + big diff → PICK eligible.

function mkSide(composite, layersPresent, baselineValue, teamName) {
  return {
    composite_score: composite,
    layers_present: layersPresent,
    team_name: teamName,
    evidence_ledger: [
      { category: 'baseline_fundamentals', present: composite !== null, value: composite !== null ? baselineValue : null },
    ],
  };
}
function mkLedger(away, home) {
  return {
    schema_version: 'mlb_evidence_ledger_v1',
    game_pk: 9001, away_team: away.team_name, home_team: home.team_name,
    away, home,
    total_signal: { over_signal: null, under_signal: null, layers_present: 0 },
  };
}

test('PICK gate: 3+ layers, ok data quality, differential >= 25 → moneyline PICK eligible', () => {
  const ledger = mkLedger(mkSide(80, 3, 70, 'Away'), mkSide(50, 3, 70, 'Home'));
  const board = composeMultiLaneCeilingBoard({ gameLedger: ledger });
  assert.equal(board.score_differential, 30);
  assert.equal(board.stronger_side, 'away');
  assert.equal(board.combined_data_quality, 'ok');
  assert.equal(board.lanes.moneyline_away.raw_status, 'PICK');
  assert.equal(board.lanes.moneyline_away.status, 'PICK');
});

test('PICK gate: identical strong differential but only 2 layers → capped, never PICK', () => {
  const ledger = mkLedger(mkSide(80, 2, 70, 'Away'), mkSide(50, 2, 70, 'Home'));
  const board = composeMultiLaneCeilingBoard({ gameLedger: ledger });
  const ml = board.lanes.moneyline_away;
  assert.equal(ml.raw_status, 'PICK');
  assert.notEqual(ml.status, 'PICK');
  assert.ok(ml.reasons.length > 0, 'a cap reason must be recorded when downgrading from PICK');
  assert.ok(ml.downgraded, 'lane must be flagged downgraded');
});

test('PICK gate: degraded coverage (1 layer) caps moneyline at WATCH', () => {
  const ledger = mkLedger(mkSide(80, 1, 70, 'Away'), mkSide(50, 1, 70, 'Home'));
  const board = composeMultiLaneCeilingBoard({ gameLedger: ledger });
  assert.equal(board.lanes.moneyline_away.status, 'WATCH');
});

test('PICK gate: zero usable layers → moneyline NO CLEAR PICK', () => {
  const ledger = mkLedger(mkSide(null, 0, null, 'Away'), mkSide(null, 0, null, 'Home'));
  const board = composeMultiLaneCeilingBoard({ gameLedger: ledger });
  assert.equal(board.lanes.moneyline_away.status, 'NO CLEAR PICK');
  assert.ok(board.lanes.moneyline_away.reasons.includes('coverage_zero_layers'));
});

// ---------------------------------------------------------------------------
// GROUP 2 — Odds-isolation regression (full pipeline)
// ---------------------------------------------------------------------------
// Run the canonical pipeline on a fixture, then run it again with market/odds/
// price fields injected at EVERY level of the input, and assert the composite
// scores AND the full ceiling board are byte-for-byte identical.

const FIXTURE = {
  game_pk: 1001,
  away_team: 'Tampa Bay Rays',
  home_team: 'Baltimore Orioles',
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
  away_pitcher: { name: 'Griffin Jax', hand: 'R', era: 1.93, fip: 2.10, kPct: 0.268, bbPct: 0.082, recentQualityStarts: 2, recentStarts: 3 },
  home_pitcher: { name: 'Shane Baz', hand: 'R', era: 4.87, fip: 4.50, kPct: 0.195, bbPct: 0.095, recentQualityStarts: 1, recentStarts: 7 },
  park: { factor: 97, name: 'Camden Yards' },
  weather: { temperatureF: 72, windMph: 8, precipRisk: 0.05 },
};

function runComposite(input) {
  const game = { game_pk: input.game_pk, away_team: input.away_team, home_team: input.home_team };
  const envelopes = buildFundamentalEnvelopes(input);
  const fundamentals = composeBaseFundamentals({ game, envelopes });
  const layers = buildLayerRecords(input);
  const gameLedger = composeEvidenceLedgerForGame({
    game,
    awaySide: fundamentals.away, homeSide: fundamentals.home,
    awaySeasonForm: layers.away.seasonForm ?? null, homeSeasonForm: layers.home.seasonForm ?? null,
    awayRecentForm: layers.away.recentForm ?? null, homeRecentForm: layers.home.recentForm ?? null,
    awayPitcherSignal: layers.away.pitcherSignal ?? null, homePitcherSignal: layers.home.pitcherSignal ?? null,
    awayPitcherAtPark: layers.away.pitcherAtPark ?? null, homePitcherAtPark: layers.home.pitcherAtPark ?? null,
    awayPitcherVsOpponent: layers.away.pitcherVsOpponent ?? null, homePitcherVsOpponent: layers.home.pitcherVsOpponent ?? null,
    parkWeatherRecord: layers.away.parkWeather ?? null,
    awayMatchupSplits: layers.away.matchupSplits ?? null, homeMatchupSplits: layers.home.matchupSplits ?? null,
    awayLineupInjury: layers.away.lineupInjury ?? null, homeLineupInjury: layers.home.lineupInjury ?? null,
    awayBullpenFatigue: layers.away.bullpenFatigue ?? null, homeBullpenFatigue: layers.home.bullpenFatigue ?? null,
    awayLineupHandedness: layers.away.lineupHandedness ?? null, homeLineupHandedness: layers.home.lineupHandedness ?? null,
    gameVolatilityRecord: layers.away.gameVolatility ?? null,
    umpireBiasRecord: layers.away.umpireBias ?? null,
  });
  const board = composeMultiLaneCeilingBoard({ gameLedger });
  return { gameLedger, board };
}

// Inject market/odds/price fields at every level of the input.
function pollute(input) {
  const c = structuredClone(input);
  const poison = {
    yes_ask: 0.91, no_bid: 0.07, yes_bid: 0.88, no_ask: 0.12,
    kalshi_ask: 0.91, kalshi_bid: 0.88, moneyline_odds: -180,
    implied_prob: 0.78, market_prob: 0.81, vig: 0.045, fair_value: 0.79,
    price: 0.83, odds: 1.55, line: -1.5, edge: 0.12, kelly: 0.25,
  };
  Object.assign(c, poison);                       // top level
  Object.assign(c.away_pitcher, poison);          // per-pitcher
  Object.assign(c.home_pitcher, poison);
  Object.assign(c.away_team_stats, poison);       // per-team
  Object.assign(c.home_team_stats, poison);
  Object.assign(c.park, poison);                  // park
  Object.assign(c.weather, poison);               // weather
  c.market = { kalshi_yes_ask: 0.91, dk_moneyline: -180, no_vig_fair: 0.79 };
  c.away_pitcher_splits.park.yes_ask = 0.5;
  c.home_pitcher_splits.vsOpponent.kalshi_bid = 0.5;
  return c;
}

test('odds-isolation: injecting market/odds/price fields does not change composite scores', () => {
  const clean = runComposite(FIXTURE);
  const dirty = runComposite(pollute(FIXTURE));
  assert.equal(dirty.board.away_composite_score, clean.board.away_composite_score);
  assert.equal(dirty.board.home_composite_score, clean.board.home_composite_score);
  assert.equal(dirty.board.score_differential, clean.board.score_differential);
  assert.equal(dirty.board.stronger_side, clean.board.stronger_side);
  // sanity: the fixture actually produces a real projection (not a null no-op)
  assert.ok(clean.board.away_composite_score !== null, 'fixture must produce a non-null away composite');
});

test('odds-isolation: the entire ceiling board (every lane status) is identical with vs without odds', () => {
  const clean = runComposite(FIXTURE);
  const dirty = runComposite(pollute(FIXTURE));
  assert.deepEqual(dirty.board, clean.board);
  assert.deepEqual(dirty.gameLedger, clean.gameLedger);
});

test('odds-isolation: the clean board carries no market/odds/price keys at all', () => {
  const { board, gameLedger } = runComposite(FIXTURE);
  assertNoForbiddenKeys(board, 'ceiling board');
  assertNoForbiddenKeys(gameLedger, 'evidence ledger');
});

// ---------------------------------------------------------------------------
// GROUP 3 — Guard: a price/odds field reaching a scored layer must be inert
// ---------------------------------------------------------------------------
// If a future change reads a market field from a layer record, this fails:
// the polluted layer record must produce the SAME score and leak NO market key.

test('guard: a market field smuggled into a layer record does not move the score', () => {
  const clean = composeEvidenceLedgerForSide({
    sideEntry: NEUTRAL_SIDE_70,
    seasonFormRecord: r(60),
    recentFormRecord: r(80),
  });
  const dirty = composeEvidenceLedgerForSide({
    sideEntry: { ...NEUTRAL_SIDE_70, yes_ask: 0.9, market_prob: 0.8, fair_value: 0.7 },
    seasonFormRecord: { present: true, score: 60, yes_ask: 0.9, kalshi_bid: 0.5, implied_prob: 0.77 },
    recentFormRecord: { present: true, score: 80, moneyline_odds: -150, edge: 0.2 },
  });
  assert.equal(dirty.composite_score, clean.composite_score);
  assert.equal(dirty.layers_present, clean.layers_present);
  assertNoForbiddenKeys(dirty, 'side ledger with smuggled market fields');
});

test('guard: multi-lane board exposes the market-neutrality safety contract', () => {
  const ledger = mkLedger(mkSide(80, 3, 70, 'Away'), mkSide(50, 3, 70, 'Home'));
  const board = composeMultiLaneCeilingBoard({ gameLedger: ledger });
  // The board must still declare the no-odds-in-score guarantee and keep CLV
  // strictly out of scoring.
  assert.ok(board.safety_notes.some(n => /Market prices do not create PICK/.test(n)));
  assert.ok(board.safety_notes.some(n => /No trade, order, stake, fair_value, edge, kelly/.test(n)));
  assert.equal(board.clv_tracking.safety, 'market_price_not_in_score');
});

test('guard: CLV price inputs are recorded as metadata only and never alter lane status', () => {
  const ledger = mkLedger(mkSide(80, 3, 70, 'Away'), mkSide(50, 3, 70, 'Home'));
  const withoutClv = composeMultiLaneCeilingBoard({ gameLedger: ledger });
  const withClv = composeMultiLaneCeilingBoard({
    gameLedger: ledger,
    clvInputs: [{ lane: 'moneyline_away', direction: 'away', open_price: 0.55, current_price: 0.71 }],
  });
  // CLV metadata is recorded...
  assert.equal(withClv.clv_tracking.entries.length, 1);
  assert.equal(withClv.clv_tracking.entries[0].note, 'CLV metadata only — never used as composite score input');
  // ...but lane statuses are byte-identical with and without it.
  assert.deepEqual(withClv.lanes, withoutClv.lanes);
});
