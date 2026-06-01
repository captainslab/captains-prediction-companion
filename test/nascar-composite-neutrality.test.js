// NASCAR composite model-neutrality protection tests.
//
// Purpose: PIN the cardinal rule for the NASCAR ceiling model — market prices
// (bid/ask/last/volume/OI/implied) NEVER feed the composite score or the lane
// recommendation. Market data may only gate lane AVAILABILITY (a boolean) and
// may only DOWNGRADE a lane (e.g. to NO CLEAR PICK when a market is missing);
// it can never raise a score or create a PICK.
//
// This mirrors test/mlb-composite-neutrality.test.mjs (the MLB gold standard):
// a polluted-vs-clean odds-injection regression that asserts the full board is
// byte-for-byte identical with vs without market/odds/price fields injected at
// every level of the input.
//
// If this fails after a scoring change, the change touched market-neutrality.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  composeMultiLaneCeilingBoard,
  MULTI_LANE_LANES,
} from '../scripts/nascar/lib/multi-lane-ceiling.mjs';

// Forbidden market/odds/price JSON KEYS that must never appear in composite
// output. Quoted to avoid substring false-positives.
const FORBIDDEN_KEYS = [
  '"fair_value"', '"edge"', '"kelly"', '"stake"', '"vig"', '"implied_prob"',
  '"market_prob"', '"yes_ask"', '"no_bid"', '"yes_bid"', '"no_ask"',
  '"kalshi_ask"', '"kalshi_bid"', '"moneyline_odds"', '"price"', '"odds"',
  '"volume"', '"open_interest"', '"last_price"',
];

function assertNoForbiddenKeys(obj, ctx) {
  const json = JSON.stringify(obj);
  for (const k of FORBIDDEN_KEYS) {
    assert.ok(!json.includes(k), `${ctx}: forbidden market/odds key leaked into output: ${k}`);
  }
}

function mkDriver(name, car, opts = {}) {
  return {
    driver_name: name,
    car_number: car,
    team: opts.team ?? 'Team X',
    manufacturer: opts.manufacturer ?? 'Chevrolet',
    driver_skill_rating: opts.driver_skill_rating ?? 70,
    driver_ability_to_convert: opts.driver_ability_to_convert ?? 65,
    team_equipment_quality: opts.team_equipment_quality ?? 80,
    pit_crew_crew_chief_grade: opts.pit_crew_crew_chief_grade ?? 60,
    strategy_risk_rating: opts.strategy_risk_rating ?? 70,
    data_quality: opts.data_quality ?? 'ok',
    downgrade_reasons: opts.downgrade_reasons ?? [],
  };
}

function mkFundamentals() {
  const by_driver = Array.from({ length: 22 }, (_, i) =>
    mkDriver(`Driver ${i + 1}`, i + 1, {
      driver_skill_rating: 95 - i * 2,
      driver_ability_to_convert: 90 - i * 2,
      team_equipment_quality: 92 - i * 2,
      strategy_risk_rating: 90 - i * 2,
    }));
  return { by_driver, overall_data_quality: 'ok', allowed_max_posture: 'PICK' };
}

const ALL_LANES_AVAILABLE = [
  { market_lane: 'win', source_available: true },
  { market_lane: 'top5', source_available: true },
  { market_lane: 'top10', source_available: true },
  { market_lane: 'top20', source_available: true },
];

function runBoard(opts) {
  return composeMultiLaneCeilingBoard({
    fundamentals: mkFundamentals(),
    supportedMarketLanes: ALL_LANES_AVAILABLE,
    ...opts,
  });
}

// Inject market/odds/price fields at every level of the driver fundamentals
// and into the supportedMarketLanes records. A neutral model must ignore them.
const POISON = {
  yes_ask: 0.91, no_bid: 0.07, yes_bid: 0.88, no_ask: 0.12,
  kalshi_ask: 0.91, kalshi_bid: 0.88, moneyline_odds: -180,
  implied_prob: 0.78, market_prob: 0.81, vig: 0.045, fair_value: 0.79,
  price: 0.83, odds: 1.55, edge: 0.12, kelly: 0.25,
  volume: 12000, open_interest: 5000, last_price: 0.82,
};

function pollutedFundamentals() {
  const f = mkFundamentals();
  for (const d of f.by_driver) Object.assign(d, POISON);
  Object.assign(f, { market: { kalshi_yes_ask: 0.91, dk_odds: -180 } });
  return f;
}

function pollutedLanes() {
  return ALL_LANES_AVAILABLE.map(l => ({ ...l, ...POISON }));
}

// ---------------------------------------------------------------------------
// GROUP 1 — Odds-isolation regression (full board)
// ---------------------------------------------------------------------------

test('odds-isolation: injecting market/odds/price into driver fundamentals does not change any composite score', () => {
  const clean = runBoard();
  const dirty = composeMultiLaneCeilingBoard({
    fundamentals: pollutedFundamentals(),
    supportedMarketLanes: ALL_LANES_AVAILABLE,
  });
  assert.equal(dirty.candidates.length, clean.candidates.length);
  for (let i = 0; i < clean.candidates.length; i++) {
    assert.equal(
      dirty.candidates[i].composite_score,
      clean.candidates[i].composite_score,
      `driver index ${i} composite_score changed when market fields were injected`,
    );
  }
  // sanity: the fixture actually produces a real projection (not a null no-op)
  assert.ok(clean.candidates[0].composite_score !== null, 'fixture must produce a non-null top composite');
});

test('odds-isolation: the entire ceiling board (every candidate + lane) is identical with vs without odds', () => {
  const clean = runBoard();
  const dirty = composeMultiLaneCeilingBoard({
    fundamentals: pollutedFundamentals(),
    supportedMarketLanes: pollutedLanes(),
  });
  assert.deepEqual(dirty.candidates, clean.candidates);
  assert.deepEqual(dirty.lanes, clean.lanes);
});

test('odds-isolation: the clean board carries no market/odds/price keys at all', () => {
  const board = runBoard();
  assertNoForbiddenKeys(board, 'nascar ceiling board');
});

// ---------------------------------------------------------------------------
// GROUP 2 — Market availability may only DOWNGRADE, never upgrade
// ---------------------------------------------------------------------------

test('market lanes only gate availability: a missing market downgrades to NO CLEAR PICK, never lifts a score', () => {
  const withMarket = runBoard();
  const withoutTop5 = composeMultiLaneCeilingBoard({
    fundamentals: mkFundamentals(),
    supportedMarketLanes: [
      { market_lane: 'win', source_available: true },
      { market_lane: 'top5', source_available: false },
      { market_lane: 'top10', source_available: true },
      { market_lane: 'top20', source_available: true },
    ],
  });
  for (let i = 0; i < withMarket.candidates.length; i++) {
    // composite score is unchanged — availability is not a scoring input
    assert.equal(
      withoutTop5.candidates[i].composite_score,
      withMarket.candidates[i].composite_score,
    );
    // but the top_5 lane is downgraded for missing market
    assert.equal(withoutTop5.candidates[i].lanes.top_5.status, 'NO CLEAR PICK');
    assert.ok(withoutTop5.candidates[i].lanes.top_5.reasons.includes('missing_market'));
  }
});

test('guard: a polluted board still exposes only the four canonical lanes (no smuggled price lane)', () => {
  const dirty = composeMultiLaneCeilingBoard({
    fundamentals: pollutedFundamentals(),
    supportedMarketLanes: pollutedLanes(),
  });
  for (const c of dirty.candidates) {
    assert.deepEqual(Object.keys(c.lanes).sort(), [...MULTI_LANE_LANES].sort());
  }
});
