import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertNoTradeDecisionStatus,
  CANONICAL_LANES,
  ROUTE_STATUSES,
  routeNascarMarket,
} from '../scripts/nascar/lib/router.mjs';

function assertRouted(title, expectedLane, rules = '') {
  const result = routeNascarMarket({ market_title: title, rules_summary: rules });
  assert.equal(result.route_status, 'ROUTED', `expected ROUTED for "${title}", got ${result.route_status}`);
  assert.equal(result.market_lane, expectedLane);
  assert.equal(result.market_scope, 'race');
  assert.deepEqual(result.candidate_lanes, [expectedLane]);
  assert.equal(CANONICAL_LANES.includes(result.market_lane), true);
  assertNoTradeDecisionStatus(result);
  return result;
}

test('win market routes to win', () => {
  assertRouted('Will Driver A win the Cup Series race at Daytona?', 'win');
});

test('top 3 routes to top3', () => {
  assertRouted('Will Driver A finish in the top 3 at Talladega?', 'top3');
});

test('top 5 routes to top5', () => {
  assertRouted('Driver A to finish in the top 5 at Bristol', 'top5');
});

test('top 10 routes to top10', () => {
  assertRouted('Will Driver A finish in the top 10 at Martinsville?', 'top10');
});

test('top 20 finish routes to top20', () => {
  assertRouted('Will Driver A finish in the top 20 at Phoenix Raceway?', 'top20');
});

test('fastest lap routes to fastest_lap', () => {
  assertRouted('Will Driver A record the fastest lap at Charlotte Motor Speedway?', 'fastest_lap');
});

test('"top 20 in current points" wording is NOT routed as top20 market lane', () => {
  const result = routeNascarMarket({
    market_title: 'Will Driver A remain in the top 20 in current points after the next race?',
  });
  // top20 must not be the routed lane — that wording is a candidate-pool rule, not a market.
  assert.notEqual(result.market_lane, 'top20');
  assertNoTradeDecisionStatus(result);
});

test('ambiguous "Kyle Larson top" returns AMBIGUOUS', () => {
  const result = routeNascarMarket({ market_title: 'Kyle Larson top' });
  assert.equal(result.route_status, 'AMBIGUOUS');
  assert.equal(result.market_lane, null);
  assert.equal(result.candidate_lanes.length > 0, true);
  assert.equal(result.needed_clarification.length > 0, true);
  assertNoTradeDecisionStatus(result);
});

test('vague NASCAR market returns BLOCKED', () => {
  const result = routeNascarMarket({
    market_title: 'NASCAR Cup Series race at Daytona — driver outcome',
  });
  assert.equal(result.route_status, 'BLOCKED');
  assert.equal(result.market_lane, null);
  assert.equal(result.needed_clarification.length > 0, true);
  assertNoTradeDecisionStatus(result);
});

test('series futures ticker returns OUT_OF_SCOPE with series scope', () => {
  const result = routeNascarMarket({
    market_title: 'Who will win the 2026 NASCAR Cup Series championship? (KXNASCARCUPSERIES-NCS26)',
  });
  assert.equal(result.route_status, 'OUT_OF_SCOPE');
  assert.equal(result.market_scope, 'series');
  assert.equal(result.market_lane, null);
  assert.equal(result.reject_signals.length > 0, true);
  assertNoTradeDecisionStatus(result);
});

test('championship wording without ticker also returns OUT_OF_SCOPE', () => {
  const result = routeNascarMarket({
    market_title: 'Will Driver A win the NASCAR Cup Series championship this season?',
  });
  assert.equal(result.route_status, 'OUT_OF_SCOPE');
  assert.equal(result.market_scope, 'series');
  assertNoTradeDecisionStatus(result);
});

test('non-NASCAR market returns NOT_NASCAR', () => {
  const result = routeNascarMarket({ market_title: 'Will the next president win the election?' });
  assert.ok(
    result.route_status === 'NOT_NASCAR' || result.route_status === 'OUT_OF_SCOPE',
    `expected NOT_NASCAR or OUT_OF_SCOPE, got ${result.route_status}`,
  );
  assert.equal(result.market_lane, null);
  assertNoTradeDecisionStatus(result);
});

test('UFC market returns NOT_NASCAR', () => {
  const result = routeNascarMarket({ market_title: 'Will Fighter A beat Fighter B at UFC 300?' });
  assert.ok(
    result.route_status === 'NOT_NASCAR' || result.route_status === 'OUT_OF_SCOPE',
    `expected NOT_NASCAR or OUT_OF_SCOPE, got ${result.route_status}`,
  );
  assertNoTradeDecisionStatus(result);
});

test('router never returns trade decision statuses, prices, picks, or ceiling fields', () => {
  const titles = [
    'Will Driver A win the Cup Series race at Daytona?',
    'Will Driver A finish in the top 3 at Talladega?',
    'Driver A to finish in the top 5 at Bristol',
    'Will Driver A finish in the top 10 at Martinsville?',
    'Will Driver A finish in the top 20 at Phoenix Raceway?',
    'Will Driver A record the fastest lap at Charlotte Motor Speedway?',
    'Kyle Larson top',
    'NASCAR Cup Series race at Daytona — driver outcome',
    'Who will win the 2026 NASCAR Cup Series championship? (KXNASCARCUPSERIES-NCS26)',
    'Will the next president win the election?',
    'Will Fighter A beat Fighter B at UFC 300?',
  ];
  const forbidden = [
    'CLEAR_PICK',
    'PASS',
    'WATCH_FOR_LISTING',
    'NOT_TRADEABLE',
    'TRADE_YES',
    'TRADE_NO',
    'NO_TRADE',
    'PLACE_PASSIVE_ORDER',
    'ESCALATE',
  ];
  const forbiddenFields = [
    'price',
    'prices',
    'fair_value',
    'fair_price',
    'pick',
    'picks',
    'recommendation',
    'recommendations',
    'driver_ceiling',
    'ceiling_market',
    'ceiling',
    'edge',
    'kelly',
    'stake',
  ];
  for (const title of titles) {
    const result = routeNascarMarket({ market_title: title });
    assertNoTradeDecisionStatus(result);
    assert.ok(ROUTE_STATUSES.includes(result.route_status));
    for (const status of forbidden) {
      assert.notEqual(result.route_status, status);
    }
    for (const field of forbiddenFields) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(result, field),
        false,
        `result must not contain forbidden field ${field}`,
      );
    }
  }
});
