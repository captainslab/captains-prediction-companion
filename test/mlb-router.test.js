import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNoTradeDecisionStatus, CANONICAL_LANES, routeMlbMarket } from '../scripts/mlb/router-core.mjs';

function assertRouted(title, expectedLane, rules = '') {
  const result = routeMlbMarket({ market_title: title, rules_summary: rules });
  assert.equal(result.route_status, 'ROUTED');
  assert.equal(result.market_lane, expectedLane);
  assert.deepEqual(result.candidate_lanes, [expectedLane]);
  assert.equal(CANONICAL_LANES.includes(result.market_lane), true);
  assertNoTradeDecisionStatus(result);
  return result;
}

test('moneyline placeholder routes to moneyline', () => {
  assertRouted('Will the Alpha City Aces beat the Beta Town Bears?', 'moneyline');
});

test('run line placeholder routes to run_line', () => {
  assertRouted('Alpha City Aces -1.5 runs vs Beta Town Bears', 'run_line');
});

test('game total placeholder routes to game_total', () => {
  assertRouted('Alpha City Aces vs Beta Town Bears: Over 8.5 total runs?', 'game_total');
});

test('YRFI/NRFI placeholder routes to yrfi_nrfi', () => {
  assertRouted('Will there be a run scored in the 1st inning of Aces vs Bears?', 'yrfi_nrfi');
  assertRouted('Aces vs Bears NRFI', 'yrfi_nrfi');
});

test('home run hitter placeholder routes to home_run_hitter', () => {
  assertRouted('Will Placeholder Player hit a home run in Aces vs Bears?', 'home_run_hitter');
});

test('Derby event markets never fall through to home_run_hitter when title omits home run derby', () => {
  const titles = [
    'Will Kyle Schwarber hit the most homers in Round 1?',
    'Will Bryce Harper hit 20+ HRs in the Derby?',
    'Longest home run of the night?',
  ];
  for (const title of titles) {
    const result = routeMlbMarket({ market_title: title, event_title: '2026 T-Mobile Derby' });
    assert.equal(result.route_status, 'OUT_OF_SCOPE');
    assert.equal(result.market_lane, null);
    assert.equal(result.candidate_lanes.includes('home_run_hitter'), false);
  }
});

test('pitcher strikeouts placeholder routes to pitcher_strikeouts', () => {
  assertRouted('Will Placeholder Pitcher record over 5.5 strikeouts?', 'pitcher_strikeouts');
});

test('ambiguous placeholder returns AMBIGUOUS with null market_lane', () => {
  const result = routeMlbMarket({ market_title: 'Aces vs Bears over 1.5' });
  assert.equal(result.route_status, 'AMBIGUOUS');
  assert.equal(result.market_lane, null);
  assert.deepEqual(result.candidate_lanes.sort(), ['game_total', 'run_line'].sort());
  assert.equal(result.needed_clarification.length > 0, true);
  assertNoTradeDecisionStatus(result);
});

test('non-MLB market returns OUT_OF_SCOPE', () => {
  const result = routeMlbMarket({ market_title: 'Will the next president win the election?' });
  assert.equal(result.route_status, 'OUT_OF_SCOPE');
  assert.equal(result.market_lane, null);
  assertNoTradeDecisionStatus(result);
});

test('unsupported baseball market returns OUT_OF_SCOPE', () => {
  const result = routeMlbMarket({ market_title: 'Will the Alpha City Aces win the World Series?' });
  assert.equal(result.route_status, 'OUT_OF_SCOPE');
  assert.equal(result.market_lane, null);
  assertNoTradeDecisionStatus(result);
});

test('clearly MLB-related but vague title returns BLOCKED', () => {
  const result = routeMlbMarket({ market_title: 'Aces vs Bears baseball market' });
  assert.equal(result.route_status, 'BLOCKED');
  assert.equal(result.market_lane, null);
  assert.equal(result.needed_clarification.length > 0, true);
  assertNoTradeDecisionStatus(result);
});

test('router never returns trade decision statuses', () => {
  const titles = [
    'Will the Alpha City Aces beat the Beta Town Bears?',
    'Alpha City Aces -1.5 runs vs Beta Town Bears',
    'Alpha City Aces vs Beta Town Bears: Over 8.5 total runs?',
    'Will there be a run scored in the first inning of Aces vs Bears?',
    'Will Placeholder Player hit a home run in Aces vs Bears?',
    'Will Placeholder Pitcher record over 5.5 strikeouts?',
    'Aces vs Bears over 1.5',
    'Will the next president win the election?',
  ];

  for (const title of titles) {
    const result = routeMlbMarket({ market_title: title });
    assertNoTradeDecisionStatus(result);
    assert.notEqual(result.route_status, 'CLEAR_PICK');
    assert.notEqual(result.route_status, 'PASS');
    assert.notEqual(result.route_status, 'WATCH_FOR_LISTING');
    assert.notEqual(result.route_status, 'NOT_TRADEABLE');
  }
});
