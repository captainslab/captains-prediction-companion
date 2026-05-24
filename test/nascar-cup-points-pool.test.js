import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { composeMultiLaneCeilingBoard, MULTI_LANE_LANES } from '../scripts/nascar/lib/multi-lane-ceiling.mjs';
import { cupPointsTop20Envelope } from '../scripts/nascar/lib/source-adapters/cup-points-top-20.mjs';

const ALL_LANES = [
  { market_lane: 'win', source_available: true },
  { market_lane: 'top5', source_available: true },
  { market_lane: 'top10', source_available: true },
  { market_lane: 'top20', source_available: true },
];

function mkDriver(name, car, opts = {}) {
  return {
    driver_name: name,
    car_number: car,
    team: opts.team ?? 'T',
    manufacturer: opts.manufacturer ?? 'Chevrolet',
    driver_skill_rating: opts.driver_skill_rating ?? 80,
    driver_ability_to_convert: opts.driver_ability_to_convert ?? 70,
    team_equipment_quality: opts.team_equipment_quality ?? 80,
    pit_crew_crew_chief_grade: opts.pit_crew_crew_chief_grade ?? null,
    strategy_risk_rating: opts.strategy_risk_rating ?? 70,
    data_quality: 'partial',
    downgrade_reasons: [],
  };
}

test('cupPointsTop20Envelope reads the snapshot and yields exactly 20 records, in points order', () => {
  const env = cupPointsTop20Envelope({ checked_at_utc: '2026-05-25T18:00:00Z' });
  assert.equal(env.pool_basis, 'cup_points_top_20');
  assert.equal(env.records.length, 20);
  assert.equal(env.records[0].driver_name, 'Tyler Reddick');
  assert.equal(env.records[0].points_position, 1);
  // Each record carries points_position 1..20 in order
  env.records.forEach((r, i) => assert.equal(r.points_position, i + 1));
  // Standings source URL is reported
  assert.ok(env.source_urls.includes('https://en.wikipedia.org/wiki/2026_NASCAR_Cup_Series'));
});

test('cup-points pool is not re-ranked by composite score', () => {
  // Build standings-shaped pool: driver A is points #1 but has the WORST fundamentals.
  const candidatePool = [
    { driver_name: 'A', car_number: 1 },
    { driver_name: 'B', car_number: 2 },
    { driver_name: 'C', car_number: 3 },
  ];
  const by_driver = [
    mkDriver('A', 1, { driver_skill_rating: 30, team_equipment_quality: 30, strategy_risk_rating: 30, driver_ability_to_convert: 30 }),
    mkDriver('B', 2, { driver_skill_rating: 95, team_equipment_quality: 95, strategy_risk_rating: 95, driver_ability_to_convert: 95 }),
    mkDriver('C', 3, { driver_skill_rating: 60, team_equipment_quality: 60, strategy_risk_rating: 60, driver_ability_to_convert: 60 }),
  ];
  const board = composeMultiLaneCeilingBoard({
    fundamentals: { by_driver, overall_data_quality: 'ok', allowed_max_posture: 'PICK' },
    supportedMarketLanes: ALL_LANES,
    candidatePool,
    candidatePoolBasis: 'cup_points_top_20',
  });
  assert.equal(board.candidate_pool_basis, 'cup_points_top_20');
  assert.deepEqual(board.candidates.map(c => c.driver_name), ['A', 'B', 'C']);
  assert.deepEqual(board.candidates.map(c => c.pool_rank), [1, 2, 3]);
});

test('points-pool driver with no fundamentals join stays in pool with NO CLEAR PICK lanes', () => {
  const candidatePool = [
    { driver_name: 'Has Fundamentals', car_number: 5 },
    { driver_name: 'No Fundamentals', car_number: 99 },
  ];
  const by_driver = [
    mkDriver('Has Fundamentals', 5, { driver_skill_rating: 80 }),
  ];
  const board = composeMultiLaneCeilingBoard({
    fundamentals: { by_driver, overall_data_quality: 'ok', allowed_max_posture: 'PICK' },
    supportedMarketLanes: ALL_LANES,
    candidatePool,
    candidatePoolBasis: 'cup_points_top_20',
  });
  assert.equal(board.candidates.length, 2);
  const orphan = board.candidates.find(c => c.car_number === 99);
  assert.ok(orphan, 'orphan must remain in pool');
  for (const lane of MULTI_LANE_LANES) {
    assert.equal(orphan.lanes[lane].status, 'NO CLEAR PICK',
      `orphan lane ${lane} must be NO CLEAR PICK, got ${orphan.lanes[lane].status}`);
  }
  assert.ok(board.candidate_pool_join_warnings.length >= 1);
});

test('every cup-points pool driver gets all four lanes (win/top_5/top_10/top_20)', () => {
  const env = cupPointsTop20Envelope({ checked_at_utc: '2026-05-25T18:00:00Z' });
  const candidatePool = env.records.map(r => ({
    driver_name: r.driver_name, car_number: r.car_number, team: r.team, manufacturer: r.manufacturer,
  }));
  // Provide minimal fundamentals matching only some pool entries — every entry
  // must still get all four lanes.
  const by_driver = candidatePool.slice(0, 10).map(p => mkDriver(p.driver_name, p.car_number));
  const board = composeMultiLaneCeilingBoard({
    fundamentals: { by_driver, overall_data_quality: 'partial', allowed_max_posture: 'EVIDENCE_LEAN' },
    supportedMarketLanes: ALL_LANES,
    candidatePool,
    candidatePoolBasis: 'cup_points_top_20',
  });
  assert.equal(board.candidates.length, 20);
  for (const c of board.candidates) {
    assert.deepEqual(Object.keys(c.lanes).sort(), ['top_10', 'top_20', 'top_5', 'win'].sort());
  }
});

test('Coca-Cola 600 ceiling_board.json on disk uses candidate_pool_basis=cup_points_plus_active_field with full grid', () => {
  // This snapshot is regenerated by the dry-run; if it is missing or shows the
  // legacy basis, the regression has returned.
  const path = 'state/nascar/2026-05-25/ceiling_board.json';
  let board;
  try { board = JSON.parse(readFileSync(path, 'utf8')); }
  catch { assert.fail(`expected ${path} to exist (run scripts/nascar/coca-cola-600-dry-run.mjs)`); }
  assert.equal(board.candidate_pool_basis, 'cup_points_plus_active_field');
  assert.ok(board.candidate_pool_size >= 20, `pool size must include points top-20 head; got ${board.candidate_pool_size}`);
  assert.ok(Array.isArray(board.scored_head) && board.scored_head.length === 20, 'scored_head must contain 20 points-pool drivers');
  assert.ok(Array.isArray(board.field_tail), 'field_tail must be an array');
  for (const c of board.candidates) {
    assert.deepEqual(Object.keys(c.lanes).sort(), ['top_10', 'top_20', 'top_5', 'win'].sort());
  }
  // Sorted scored head: top driver has the max composite among scored_head.
  const top = board.scored_head[0];
  for (const c of board.scored_head) {
    if (Number.isFinite(c.final_composite_score)) {
      assert.ok((top.final_composite_score ?? -1) >= (c.final_composite_score ?? -1));
    }
  }
  // Kyle Busch must NOT appear as a scored candidate (not entered in 2026).
  for (const c of board.candidates) {
    assert.notEqual(c.driver_name, 'Kyle Busch', 'Kyle Busch must not be scored — he is not entered');
  }
});
