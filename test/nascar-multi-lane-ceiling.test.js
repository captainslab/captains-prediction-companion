import test from 'node:test';
import assert from 'node:assert/strict';

import { composeMultiLaneCeilingBoard, MULTI_LANE_LANES, MULTI_LANE_STATUSES } from '../scripts/nascar/lib/multi-lane-ceiling.mjs';

function mkDriver(name, car, opts = {}) {
  return {
    driver_name: name,
    car_number: car,
    team: opts.team ?? 'Team X',
    manufacturer: opts.manufacturer ?? 'Chevrolet',
    driver_skill_rating: opts.driver_skill_rating ?? 70,
    driver_ability_to_convert: opts.driver_ability_to_convert ?? 65,
    team_equipment_quality: opts.team_equipment_quality ?? 80,
    pit_crew_crew_chief_grade: opts.pit_crew_crew_chief_grade ?? null,
    strategy_risk_rating: opts.strategy_risk_rating ?? 70,
    data_quality: opts.data_quality ?? 'partial',
    downgrade_reasons: opts.downgrade_reasons ?? [],
  };
}

function mkFundamentals({ count = 25, overall = 'ok', drivers = null } = {}) {
  const by_driver = drivers ?? Array.from({ length: count }, (_, i) =>
    mkDriver(`Driver ${i + 1}`, i + 1, {
      driver_skill_rating: 95 - i * 2,
      driver_ability_to_convert: 90 - i * 2,
      team_equipment_quality: 92 - i * 2,
      strategy_risk_rating: 90 - i * 2,
    }));
  return {
    by_driver,
    overall_data_quality: overall,
    allowed_max_posture: overall === 'ok' ? 'PICK' : (overall === 'partial' ? 'EVIDENCE_LEAN' : 'WATCH'),
  };
}

const ALL_LANES_AVAILABLE = [
  { market_lane: 'win', source_available: true },
  { market_lane: 'top5', source_available: true },
  { market_lane: 'top10', source_available: true },
  { market_lane: 'top20', source_available: true },
];

test('candidate pool is exactly 20 when universe >= 20', () => {
  const f = mkFundamentals({ count: 25 });
  const board = composeMultiLaneCeilingBoard({
    fundamentals: f,
    supportedMarketLanes: ALL_LANES_AVAILABLE,
  });
  assert.equal(board.candidate_pool_size, 20);
  assert.equal(board.candidates.length, 20);
  assert.equal(board.pool_short_reason, null);
});

test('candidate pool truncates with pool_short_reason when universe < 20', () => {
  const f = mkFundamentals({ count: 12 });
  const board = composeMultiLaneCeilingBoard({
    fundamentals: f,
    supportedMarketLanes: ALL_LANES_AVAILABLE,
  });
  assert.equal(board.candidate_pool_size, 12);
  assert.match(board.pool_short_reason, /only 12/);
});

test('candidate pool is deterministic from same fundamentals', () => {
  const a = composeMultiLaneCeilingBoard({ fundamentals: mkFundamentals({ count: 25 }), supportedMarketLanes: ALL_LANES_AVAILABLE });
  const b = composeMultiLaneCeilingBoard({ fundamentals: mkFundamentals({ count: 25 }), supportedMarketLanes: ALL_LANES_AVAILABLE });
  assert.deepEqual(a.candidates.map(c => c.driver_name), b.candidates.map(c => c.driver_name));
});

test('every candidate has all four lanes win/top_5/top_10/top_20', () => {
  const board = composeMultiLaneCeilingBoard({
    fundamentals: mkFundamentals({ count: 25 }),
    supportedMarketLanes: ALL_LANES_AVAILABLE,
  });
  for (const c of board.candidates) {
    assert.deepEqual(Object.keys(c.lanes).sort(), ['top_10', 'top_20', 'top_5', 'win'].sort());
    for (const lane of MULTI_LANE_LANES) {
      assert.ok(MULTI_LANE_STATUSES.includes(c.lanes[lane].status), `bad status ${c.lanes[lane].status}`);
    }
  }
});

test('non-top20 driver does not appear on the main ceiling board', () => {
  const drivers = Array.from({ length: 25 }, (_, i) =>
    mkDriver(`Driver ${i + 1}`, i + 1, { driver_skill_rating: 95 - i * 2 }));
  // Add a clearly-weak storyline-only candidate at the end
  drivers.push(mkDriver('Storyline Only', 999, {
    driver_skill_rating: 30, driver_ability_to_convert: 30, team_equipment_quality: 30, strategy_risk_rating: 30,
  }));
  const board = composeMultiLaneCeilingBoard({
    fundamentals: { by_driver: drivers, overall_data_quality: 'ok', allowed_max_posture: 'PICK' },
    supportedMarketLanes: ALL_LANES_AVAILABLE,
    storylineBeneficiary: { driver_name: 'Storyline Only', car_number: 999 },
  });
  assert.equal(board.candidates.length, 20);
  assert.ok(!board.candidates.some(c => c.car_number === 999), 'weak storyline-only driver leaked into top 20');
});

test('missing market lane downgrades to NO CLEAR PICK with reason missing_market', () => {
  const board = composeMultiLaneCeilingBoard({
    fundamentals: mkFundamentals({ count: 20 }),
    supportedMarketLanes: [
      { market_lane: 'win', source_available: true },
      { market_lane: 'top5', source_available: false },
      { market_lane: 'top10', source_available: true },
      { market_lane: 'top20', source_available: true },
    ],
  });
  for (const c of board.candidates) {
    assert.equal(c.lanes.top_5.status, 'NO CLEAR PICK');
    assert.ok(c.lanes.top_5.reasons.includes('missing_market'));
  }
});

test('degraded fundamentals cap every lane at WATCH (no PICK/EVIDENCE_LEAN/LEAN)', () => {
  const board = composeMultiLaneCeilingBoard({
    fundamentals: mkFundamentals({ count: 20, overall: 'degraded' }),
    supportedMarketLanes: ALL_LANES_AVAILABLE,
  });
  for (const c of board.candidates) {
    for (const lane of MULTI_LANE_LANES) {
      assert.ok(['WATCH', 'NO CLEAR PICK'].includes(c.lanes[lane].status),
        `degraded fundamentals must cap to WATCH/NO CLEAR PICK, got ${c.lanes[lane].status}`);
    }
  }
});

test('partial fundamentals cap PICK -> EVIDENCE_LEAN', () => {
  // Force a top driver with very high score on partial fundamentals
  const drivers = [mkDriver('Top Dog', 1, {
    driver_skill_rating: 99, driver_ability_to_convert: 99, team_equipment_quality: 99, strategy_risk_rating: 99,
  })];
  for (let i = 2; i <= 20; i++) drivers.push(mkDriver(`D${i}`, i, { driver_skill_rating: 50 }));
  const board = composeMultiLaneCeilingBoard({
    fundamentals: { by_driver: drivers, overall_data_quality: 'partial', allowed_max_posture: 'EVIDENCE_LEAN' },
    supportedMarketLanes: ALL_LANES_AVAILABLE,
  });
  const top = board.candidates[0];
  assert.equal(top.lanes.win.raw_status, 'PICK');
  assert.equal(top.lanes.win.status, 'EVIDENCE_LEAN');
  assert.ok(top.lanes.win.reasons.includes('fundamentals_partial_cap_evidence_lean'));
});

test('storyline beneficiary alone cannot create PICK/EVIDENCE_LEAN', () => {
  // Beneficiary with weak score on degraded fundamentals; even being beneficiary cannot upgrade past WATCH
  const drivers = [mkDriver('Austin Hill', 33, {
    driver_skill_rating: 50, driver_ability_to_convert: 50, team_equipment_quality: 60, strategy_risk_rating: 50,
  })];
  for (let i = 2; i <= 20; i++) drivers.push(mkDriver(`D${i}`, i, { driver_skill_rating: 70 }));
  const board = composeMultiLaneCeilingBoard({
    fundamentals: { by_driver: drivers, overall_data_quality: 'degraded', allowed_max_posture: 'WATCH' },
    supportedMarketLanes: ALL_LANES_AVAILABLE,
    storylineBeneficiary: { driver_name: 'Austin Hill', car_number: 33 },
  });
  const ah = board.candidates.find(c => c.car_number === 33);
  assert.ok(ah, 'beneficiary must appear since they qualified on pool rank');
  for (const lane of MULTI_LANE_LANES) {
    assert.ok(!['PICK', 'EVIDENCE_LEAN', 'LEAN'].includes(ah.lanes[lane].status),
      `storyline beneficiary lane ${lane} upgraded to ${ah.lanes[lane].status}`);
  }
});

test('board emits no forbidden fields (trade/order/fair_value/edge/kelly/etc)', () => {
  const board = composeMultiLaneCeilingBoard({
    fundamentals: mkFundamentals({ count: 20 }),
    supportedMarketLanes: ALL_LANES_AVAILABLE,
  });
  const json = JSON.stringify(board);
  for (const f of ['"fair_value"', '"edge"', '"kelly"', '"stake"', '"trade"', '"order"', '"pick"', '"execution"']) {
    assert.ok(!json.includes(f), `forbidden field present: ${f}`);
  }
});

test('schema_version and lanes constants are stable', () => {
  const board = composeMultiLaneCeilingBoard({
    fundamentals: mkFundamentals({ count: 20 }),
    supportedMarketLanes: ALL_LANES_AVAILABLE,
  });
  assert.equal(board.schema_version, 'nascar_multi_lane_ceiling_board_v1');
  assert.deepEqual(board.lanes, ['win', 'top_5', 'top_10', 'top_20']);
  assert.deepEqual(board.statuses, ['PICK', 'EVIDENCE_LEAN', 'LEAN', 'WATCH', 'NO CLEAR PICK', 'MARKET_ONLY']);
});
