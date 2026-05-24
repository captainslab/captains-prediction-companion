// NASCAR per-driver fundamentals coverage cap.
//
// Rule under test:
//   0 layers -> NO CLEAR PICK
//   1 layer  -> max LEAN
//   2 layers -> max EVIDENCE_LEAN
//   3+ layers -> PICK eligible (still subject to data_quality + market caps)
//
// driver_skill_rating and driver_ability_to_convert both live in the
// driver_skill layer, so they count as ONE layer of coverage.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { composeMultiLaneCeilingBoard } from '../scripts/nascar/lib/multi-lane-ceiling.mjs';

const MARKET_LANES = [
  { market_lane: 'win',   source_available: true },
  { market_lane: 'top5',  source_available: true },
  { market_lane: 'top10', source_available: true },
  { market_lane: 'top20', source_available: true },
];

function fundamentalsFor(byDriver, overall = 'ok') {
  return {
    by_driver: byDriver,
    overall_data_quality: overall,
    allowed_max_posture: overall === 'ok' ? 'PICK' : 'EVIDENCE_LEAN',
    layer_status: {
      driver_skill: 'ok',
      team_equipment: 'ok',
      pit_crew: 'ok',
      strategy_risk: 'ok',
    },
  };
}

function poolFrom(drivers) {
  return drivers.map(d => ({
    driver_name: d.driver_name,
    car_number: d.car_number,
    team: d.team,
    manufacturer: d.manufacturer,
  }));
}

function build(byDriver, overall = 'ok') {
  return composeMultiLaneCeilingBoard({
    fundamentals: fundamentalsFor(byDriver, overall),
    supportedMarketLanes: MARKET_LANES,
    candidatePool: poolFrom(byDriver),
    candidatePoolBasis: 'cup_points_top_20',
    poolSize: byDriver.length,
  });
}

test('coverage=0 → NO CLEAR PICK across all lanes', () => {
  const board = build([{
    driver_name: 'Zero Layer Driver',
    car_number: 97,
    team: 'Trackhouse',
    manufacturer: 'Chevrolet',
    driver_skill_rating: null,
    driver_ability_to_convert: null,
    team_equipment_quality: null,
    pit_crew_crew_chief_grade: null,
    strategy_risk_rating: null,
    data_quality: 'unavailable',
  }]);
  const c = board.candidates[0];
  assert.equal(c.fundamentals_layer_coverage, 0);
  for (const lane of ['win', 'top_5', 'top_10', 'top_20']) {
    assert.equal(c.lanes[lane].status, 'NO CLEAR PICK', `${lane} should be NO CLEAR PICK`);
  }
});

test('coverage=1 (team_equipment only, score 80) → max LEAN, never EVIDENCE_LEAN', () => {
  const board = build([{
    driver_name: 'Equipment Only Driver',
    car_number: 19,
    team: 'JGR',
    manufacturer: 'Toyota',
    driver_skill_rating: null,
    driver_ability_to_convert: null,
    team_equipment_quality: 80,
    pit_crew_crew_chief_grade: null,
    strategy_risk_rating: null,
    data_quality: 'partial',
  }], 'partial');
  const c = board.candidates[0];
  assert.equal(c.fundamentals_layer_coverage, 1);
  assert.equal(c.composite_score, 80);
  for (const lane of ['win', 'top_5', 'top_10', 'top_20']) {
    const s = c.lanes[lane].status;
    assert.notEqual(s, 'EVIDENCE_LEAN', `${lane} must not be EVIDENCE_LEAN with 1 layer`);
    assert.notEqual(s, 'PICK', `${lane} must not be PICK with 1 layer`);
  }
  // raw_status would be EVIDENCE_LEAN/PICK; coverage cap pulls down to LEAN
  // wherever the threshold allows it.
  assert.equal(c.lanes.win.status, 'LEAN');
  assert.ok(
    c.lanes.win.reasons.includes('fundamentals_coverage_one_layer_cap_lean'),
    'coverage-cap reason must be present',
  );
});

test('coverage=2 → max EVIDENCE_LEAN, never PICK', () => {
  const board = build([{
    driver_name: 'Two Layer Driver',
    car_number: 21,
    team: 'Test',
    manufacturer: 'Ford',
    driver_skill_rating: 90, // driver_skill layer
    driver_ability_to_convert: 85,
    team_equipment_quality: 90, // team_equipment layer
    pit_crew_crew_chief_grade: null,
    strategy_risk_rating: null,
    data_quality: 'partial',
  }], 'ok');
  const c = board.candidates[0];
  assert.equal(c.fundamentals_layer_coverage, 2);
  for (const lane of ['win', 'top_5', 'top_10', 'top_20']) {
    assert.notEqual(c.lanes[lane].status, 'PICK', `${lane} must not be PICK with 2 layers`);
  }
  // Top_20 raw would easily be PICK (score >= 60); coverage cap holds at EVIDENCE_LEAN.
  assert.equal(c.lanes.top_20.status, 'EVIDENCE_LEAN');
  assert.ok(c.lanes.top_20.reasons.includes('fundamentals_coverage_two_layers_cap_evidence_lean'));
});

test('coverage=3+ with ok data_quality → PICK eligible', () => {
  const board = build([{
    driver_name: 'Three Layer Driver',
    car_number: 22,
    team: 'Test',
    manufacturer: 'Ford',
    driver_skill_rating: 95,
    driver_ability_to_convert: 90,
    team_equipment_quality: 95,
    pit_crew_crew_chief_grade: null,
    strategy_risk_rating: 90,
    data_quality: 'ok',
  }], 'ok');
  const c = board.candidates[0];
  assert.equal(c.fundamentals_layer_coverage, 3);
  // Score is high enough; ok data_quality allows PICK.
  assert.equal(c.lanes.top_20.status, 'PICK');
});

test('regression: SVG-like (car not in team aggregate) stays NO CLEAR PICK', () => {
  const board = build([{
    driver_name: 'Shane van Gisbergen',
    car_number: 97,
    team: 'Trackhouse Racing',
    manufacturer: 'Chevrolet',
    driver_skill_rating: null,
    driver_ability_to_convert: null,
    team_equipment_quality: null,
    pit_crew_crew_chief_grade: null,
    strategy_risk_rating: null,
    data_quality: 'unavailable',
  }]);
  const c = board.candidates[0];
  assert.equal(c.fundamentals_layer_coverage, 0);
  assert.equal(c.composite_score, null);
  for (const lane of ['win', 'top_5', 'top_10', 'top_20']) {
    assert.equal(c.lanes[lane].status, 'NO CLEAR PICK');
  }
});

test('regression: Briscoe-like (team_equipment only) capped at LEAN on every lane', () => {
  const board = build([{
    driver_name: 'Chase Briscoe',
    car_number: 19,
    team: 'Joe Gibbs Racing',
    manufacturer: 'Toyota',
    driver_skill_rating: null,
    driver_ability_to_convert: null,
    team_equipment_quality: 80,
    pit_crew_crew_chief_grade: null,
    strategy_risk_rating: null,
    data_quality: 'partial',
  }], 'partial');
  const c = board.candidates[0];
  assert.equal(c.fundamentals_layer_coverage, 1);
  assert.equal(c.composite_score, 80);
  for (const lane of ['win', 'top_5', 'top_10', 'top_20']) {
    const s = c.lanes[lane].status;
    assert.ok(
      s === 'LEAN' || s === 'WATCH' || s === 'NO CLEAR PICK',
      `${lane} must be LEAN/WATCH/NO CLEAR PICK with 1 layer, got ${s}`,
    );
  }
});
