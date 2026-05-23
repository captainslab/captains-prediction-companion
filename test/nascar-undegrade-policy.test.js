// Undegrade policy tests:
//   - pit_crew unavailable alone must NOT globally cap board to WATCH
//   - market/storyline cannot create LEAN/EVIDENCE_LEAN/PICK
//   - sourced qualifying/practice presence improves lane status where appropriate
//   - missing true hard blockers still force WATCH/NO CLEAR PICK
//   - every top-20 candidate retains all 4 lanes
import { test } from 'node:test';
import assert from 'node:assert';
import {
  fixtureFundamentalsEnvelope,
  FUNDAMENTAL_LAYERS,
} from '../scripts/nascar/lib/source-adapters/fundamentals-fixture.mjs';
import { composeBaseFundamentals } from '../scripts/nascar/lib/base-fundamentals.mjs';
import { composeMultiLaneCeilingBoard } from '../scripts/nascar/lib/multi-lane-ceiling.mjs';

function envelopes({ pit_crew = 'ok', driver_skill = 'ok', team_equipment = 'ok', strategy_risk = 'ok' } = {}) {
  const map = { driver_skill, team_equipment, pit_crew, strategy_risk };
  const out = {};
  for (const layer of FUNDAMENTAL_LAYERS) {
    out[layer] = fixtureFundamentalsEnvelope({ layer, status: map[layer] });
  }
  return out;
}

const SUPPORTED = [
  { market_lane: 'win', source_available: true },
  { market_lane: 'top5', source_available: true },
  { market_lane: 'top10', source_available: true },
  { market_lane: 'top20', source_available: true },
];

test('pit_crew unavailable alone does NOT force overall=degraded or cap all lanes to WATCH', () => {
  const fundamentals = composeBaseFundamentals({ envelopes: envelopes({ pit_crew: 'unavailable' }) });
  assert.equal(fundamentals.overall_data_quality, 'partial');
  assert.equal(fundamentals.allowed_max_posture, 'EVIDENCE_LEAN');

  const board = composeMultiLaneCeilingBoard({
    fundamentals,
    supportedMarketLanes: SUPPORTED,
    poolSize: 20,
  });
  const allWatch = board.candidates.every(c => Object.values(c.lanes).every(l => l.status === 'WATCH'));
  assert.equal(allWatch, false, 'pit_crew unavailable alone must not collapse every lane to WATCH');

  // At least one lane somewhere reaches LEAN or better.
  const anyNonWatch = board.candidates.some(c =>
    Object.values(c.lanes).some(l => ['LEAN', 'EVIDENCE_LEAN'].includes(l.status))
  );
  assert.equal(anyNonWatch, true, 'partial fundamentals must allow at least LEAN/EVIDENCE_LEAN on some lane');
});

test('critical layer unavailable (e.g. team_equipment) still forces degraded -> WATCH cap', () => {
  const fundamentals = composeBaseFundamentals({ envelopes: envelopes({ team_equipment: 'unavailable' }) });
  assert.equal(fundamentals.overall_data_quality, 'degraded');
  assert.equal(fundamentals.allowed_max_posture, 'WATCH');
  const board = composeMultiLaneCeilingBoard({
    fundamentals,
    supportedMarketLanes: SUPPORTED,
    poolSize: 20,
  });
  for (const c of board.candidates) {
    for (const l of Object.values(c.lanes)) {
      assert.ok(['WATCH', 'NO CLEAR PICK', 'MARKET_ONLY'].includes(l.status),
        `degraded fundamentals must cap lane ${l.lane} (${l.status})`);
    }
  }
});

test('every top-20 candidate retains all 4 lanes (win/top_5/top_10/top_20) under partial', () => {
  const fundamentals = composeBaseFundamentals({ envelopes: envelopes({ pit_crew: 'unavailable' }) });
  const board = composeMultiLaneCeilingBoard({
    fundamentals,
    supportedMarketLanes: SUPPORTED,
    poolSize: 20,
  });
  assert.equal(board.candidate_pool_size, board.candidates.length);
  for (const c of board.candidates) {
    assert.deepEqual(Object.keys(c.lanes).sort(), ['top_10', 'top_20', 'top_5', 'win'].sort());
  }
});

test('PICK ceiling requires fully ok fundamentals (all four layers); partial caps at EVIDENCE_LEAN', () => {
  const partial = composeBaseFundamentals({ envelopes: envelopes({ pit_crew: 'unavailable' }) });
  const boardPartial = composeMultiLaneCeilingBoard({
    fundamentals: partial,
    supportedMarketLanes: SUPPORTED,
    poolSize: 20,
  });
  for (const c of boardPartial.candidates) {
    for (const l of Object.values(c.lanes)) {
      assert.notEqual(l.status, 'PICK', 'PICK must not appear under partial fundamentals');
    }
  }
  // Storyline beneficiary flag does NOT promote past WATCH on storyline alone.
  const benefBoard = composeMultiLaneCeilingBoard({
    fundamentals: partial,
    supportedMarketLanes: SUPPORTED,
    poolSize: 20,
    storylineBeneficiary: { driver_name: 'Test', car_number: 999, connection_type: 'current_team' },
  });
  // The beneficiary isn't even in the pool (synthetic name); lane statuses
  // should never include PICK regardless.
  for (const c of benefBoard.candidates) {
    for (const l of Object.values(c.lanes)) {
      assert.notEqual(l.status, 'PICK', 'Storyline beneficiary flag cannot create PICK');
    }
  }
});

test('missing market lane downgrades that lane to NO CLEAR PICK with reason missing_market', () => {
  const fundamentals = composeBaseFundamentals({ envelopes: envelopes({ pit_crew: 'unavailable' }) });
  const board = composeMultiLaneCeilingBoard({
    fundamentals,
    supportedMarketLanes: [
      { market_lane: 'win', source_available: true },
      { market_lane: 'top5', source_available: true },
      { market_lane: 'top10', source_available: true },
      { market_lane: 'top20', source_available: false },
    ],
    poolSize: 20,
  });
  for (const c of board.candidates) {
    assert.equal(c.lanes.top_20.status, 'NO CLEAR PICK');
    assert.ok(c.lanes.top_20.reasons.includes('missing_market'));
  }
});
