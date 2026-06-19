import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIVE_ROUTES,
  OUT_OF_SCOPE_ROUTES,
  ROUTE_GROUPS,
  ROUTE_CONTRACT,
  HARD_BLOCK_GATE,
  getRouteContract,
  routeGroupOf,
  isActiveRoute,
  isOutOfScopeRoute,
  classifyRouteFromSnapshot,
  RULES_FORBIDDEN_PATTERN,
} from '../scripts/mentions/route-taxonomy.mjs';
import {
  buildMarketRulesSnapshot,
  buildRulesSnapshot,
} from '../scripts/mentions/rules-analyst.mjs';
import { resolveResearchRoute } from '../scripts/mentions/mention-route-resolver.mjs';

const EXPECTED_ACTIVE = [
  'earnings_call',
  'fed_agency',
  'trump_event',
  'political_general',
  'debate_hearing',
  'sports_announcer',
  'talk_show_media',
  'entertainment_reality',
  'topic_most_mentioned',
];

test('active route table contains exactly the 9 active routes', () => {
  assert.equal(ACTIVE_ROUTES.length, 9);
  assert.deepEqual([...ACTIVE_ROUTES].sort(), [...EXPECTED_ACTIVE].sort());
  for (const route of EXPECTED_ACTIVE) {
    assert.ok(isActiveRoute(route), `expected active: ${route}`);
    assert.ok(Object.hasOwn(ROUTE_CONTRACT, route), `missing contract: ${route}`);
  }
});

test('out-of-scope list is exactly trump_weekly, trump_monthly, truth_social reserved hook', () => {
  assert.deepEqual([...OUT_OF_SCOPE_ROUTES], ['trump_weekly', 'trump_monthly', 'truth_social']);
  for (const route of OUT_OF_SCOPE_ROUTES) {
    assert.ok(isOutOfScopeRoute(route), `expected out-of-scope: ${route}`);
    assert.ok(!isActiveRoute(route), `out-of-scope must not be active: ${route}`);
    assert.equal(getRouteContract(route), null, `out-of-scope must have no active contract: ${route}`);
    assert.equal(routeGroupOf(route), 'out_of_scope');
  }
});

test('every active route has all required contract fields', () => {
  const required = [
    'route_group',
    'market_shape',
    'comparable_unit',
    'history_window_policy',
    'trusted_corpus_policy',
    'settlement_proof_policy',
    'minimum_rules_fields',
    'block_gates',
    'first_proof_lane_priority',
  ];
  for (const route of ACTIVE_ROUTES) {
    const c = ROUTE_CONTRACT[route];
    for (const field of required) {
      assert.ok(Object.hasOwn(c, field), `${route} missing ${field}`);
    }
    assert.ok(Array.isArray(c.minimum_rules_fields) && c.minimum_rules_fields.length > 0);
    assert.ok(Array.isArray(c.block_gates) && c.block_gates.includes(HARD_BLOCK_GATE));
    assert.ok(typeof c.comparable_unit === 'string' && c.comparable_unit.length > 0);
  }
});

test('route groups map exactly as specced', () => {
  assert.deepEqual([...ROUTE_GROUPS.event_bound_binary_or_threshold], [
    'earnings_call',
    'fed_agency',
    'trump_event',
    'political_general',
    'debate_hearing',
    'sports_announcer',
    'talk_show_media',
    'entertainment_reality',
  ]);
  assert.deepEqual([...ROUTE_GROUPS.comparative_count_or_ranking], ['topic_most_mentioned']);
  assert.deepEqual([...ROUTE_GROUPS.out_of_scope], ['trump_weekly', 'trump_monthly', 'truth_social']);

  // The two active groups partition the 9 active routes with no overlap.
  const grouped = [
    ...ROUTE_GROUPS.event_bound_binary_or_threshold,
    ...ROUTE_GROUPS.comparative_count_or_ranking,
  ];
  assert.deepEqual([...grouped].sort(), [...ACTIVE_ROUTES].sort());
});

test('topic_most_mentioned is comparative_count_or_ranking, not a normal binary', () => {
  const c = ROUTE_CONTRACT.topic_most_mentioned;
  assert.equal(c.route_group, 'comparative_count_or_ranking');
  assert.equal(c.market_shape, 'comparative_count_or_ranking');
  assert.notEqual(c.market_shape, 'binary_or_threshold');
});

test('earnings_call proof lane: Kalshi history, trusted transcript corpus, current-context research, settlement final', () => {
  const c = ROUTE_CONTRACT.earnings_call;
  assert.deepEqual(c.first_proof_lane_priority, [
    'kalshi_historical_hits_misses',
    'trusted_transcript_corpus',
    'bounded_current_context_research',
    'settlement_source_final_proof',
  ]);
  assert.match(c.settlement_proof_policy, /transcript.*final|final.*transcript/i);
});

test('trump_event comparable_unit is conditioned by same speaker, event format, and rule family', () => {
  const c = ROUTE_CONTRACT.trump_event;
  assert.match(c.comparable_unit, /speaker/i);
  assert.match(c.comparable_unit, /format/i);
  assert.match(c.comparable_unit, /rule_family/i);
});

test('sports_announcer policy says context is not spoken-word proof', () => {
  const c = ROUTE_CONTRACT.sports_announcer;
  assert.match(c.settlement_proof_policy, /context.*not.*spoken[_\s-]?word.*proof/i);
});

test('rules_snapshot rule_family overrides regex for active routes (classify + resolver agree)', () => {
  const fedEvent = {
    event_ticker: 'KXEARNINGSMENTIONFDX-26JUN23',
    series_ticker: 'KXEARNINGSMENTIONFDX',
    title: 'What will FedEx say on its earnings call?',
    sub_title: 'Q4 earnings call',
    settlement_sources: [{ name: 'FedEx IR', url: 'https://investors.fedex.com/events' }],
    markets: [{
      ticker: 'KXEARNINGSMENTIONFDX-26JUN23-GUIDANCE',
      title: 'Will FedEx say guidance?',
      yes_sub_title: 'guidance',
      custom_strike: 'guidance',
      rules_primary: 'Resolves YES if any company representative says guidance during the call.',
    }],
  };
  const snapshot = buildMarketRulesSnapshot(fedEvent, fedEvent.markets[0]);
  const verdict = classifyRouteFromSnapshot(snapshot);
  assert.equal(verdict.status, 'active');
  assert.equal(verdict.route, 'earnings_call');
  assert.equal(verdict.route_group, 'event_bound_binary_or_threshold');
  assert.equal(verdict.contract, ROUTE_CONTRACT.earnings_call);

  // Resolver, fed the same snapshot, agrees and marks the basis as snapshot-driven.
  const routed = resolveResearchRoute(fedEvent, { now: new Date('2026-06-12T12:00:00Z'), rulesSnapshot: snapshot });
  assert.equal(routed.route, 'earnings_call');
  assert.equal(routed.basis, 'rules_snapshot');
});

test('out-of-scope snapshot does not activate weekly/monthly/truth_social', () => {
  const weekly = {
    event_ticker: 'KXTRUMPMENTIONW-26JUN18',
    series_ticker: 'KXTRUMPMENTIONW',
    title: 'What will Trump say this week?',
    markets: [{ ticker: 'KXTRUMPMENTIONW-26JUN18-TARIFF', title: 'Will Trump say tariff?', yes_sub_title: 'tariff', custom_strike: 'tariff', rules_primary: 'Resolves YES if Trump says tariff this week.' }],
  };
  const truth = {
    event_ticker: 'KXTRUMPTRUTHSOCIAL-26JUN18',
    series_ticker: 'KXTRUMPTRUTHSOCIAL',
    title: 'What will Trump post on Truth Social?',
    markets: [{ ticker: 'KXTRUMPTRUTHSOCIAL-26JUN18-TARIFF', title: 'Will Trump say tariff?', yes_sub_title: 'tariff', custom_strike: 'tariff', rules_primary: 'Resolves YES if Trump posts tariff on Truth Social.' }],
  };
  for (const event of [weekly, truth]) {
    const wrapper = buildRulesSnapshot(event);
    assert.equal(wrapper.out_of_scope, true);
    const verdict = classifyRouteFromSnapshot(wrapper);
    assert.equal(verdict.status, 'out_of_scope');
    assert.equal(verdict.route, null);
    assert.ok(!isActiveRoute(verdict.route));
  }
});

test('BLOCKED_RULES_UNCLEAR remains a hard block (never softened)', () => {
  const garbage = {
    event_ticker: 'KXGARBAGE-26JUN18',
    series_ticker: 'KXGARBAGE',
    title: '',
    sub_title: '',
    settlement_sources: [],
    markets: [{ ticker: 'KXGARBAGE-26JUN18-A' }],
  };
  const snapshot = buildMarketRulesSnapshot(garbage, garbage.markets[0]);
  assert.ok(snapshot.block_reasons.includes('BLOCKED_RULES_UNCLEAR'));
  const verdict = classifyRouteFromSnapshot(snapshot);
  assert.equal(verdict.status, 'blocked');
  assert.equal(verdict.route, null);
  assert.deepEqual([...verdict.block_gates], ['BLOCKED_RULES_UNCLEAR']);
  // Not softened to a posture.
  assert.ok(!['WATCH', 'NO_CLEAR_PICK', 'LOW_SOURCE', 'PASS'].includes(verdict.status));
});

test('price-like fields are ignored and cannot affect route output or leak into contract artifacts', () => {
  // No forbidden key appears anywhere in the frozen contract.
  assert.doesNotMatch(JSON.stringify(ROUTE_CONTRACT), RULES_FORBIDDEN_PATTERN);
  assert.doesNotMatch(JSON.stringify(ROUTE_GROUPS), RULES_FORBIDDEN_PATTERN);

  const clean = {
    rule_family: 'sports_announcer',
    out_of_scope: false,
    block_reasons: [],
  };
  const priced = {
    ...clean,
    yes_bid: 42,
    yes_ask: 47,
    volume: 12345,
    open_interest: 678,
    liquidity: 9,
    spread: 5,
    notional_value: 100,
    settlement_value_dollars: 1000,
  };
  const cleanVerdict = classifyRouteFromSnapshot(clean);
  const pricedVerdict = classifyRouteFromSnapshot(priced);
  assert.deepEqual(cleanVerdict, pricedVerdict);
  assert.doesNotMatch(JSON.stringify(pricedVerdict), RULES_FORBIDDEN_PATTERN);
  assert.equal(pricedVerdict.route, 'sports_announcer');
});

test('classify is deterministic for identical input', () => {
  const snapshot = { rule_family: 'trump_event', out_of_scope: false, block_reasons: [] };
  assert.deepEqual(
    classifyRouteFromSnapshot(snapshot),
    classifyRouteFromSnapshot({ ...snapshot }),
  );
});
