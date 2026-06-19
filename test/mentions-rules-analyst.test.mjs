import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMarketRulesSnapshot,
  buildRulesSnapshot,
  RULES_FORBIDDEN_PATTERN,
  RULES_SOURCE_ORDER,
} from '../scripts/mentions/rules-analyst.mjs';
import { resolveResearchRoute } from '../scripts/mentions/mention-route-resolver.mjs';

function obamaEvent() {
  return {
    event_ticker: 'KXOBAMAMENTION-26JUN19',
    series_ticker: 'KXOBAMAMENTION',
    title: 'What will Obama say during the broadcast interview?',
    sub_title: 'Obama interview',
    settlement_sources: [
      { name: 'network', url: 'https://network.example/obama-settlement' },
    ],
    markets: [
      {
        ticker: 'KXOBAMAMENTION-26JUN19-KID',
        title: 'Will Obama say kid/kids?',
        yes_sub_title: 'kid/kids',
        custom_strike: 'kid/kids',
        rules_primary: 'Resolves YES if Obama says kid or kids during the broadcast interview. Promotional counts and ads are excluded. https://rules.example/ignore-me',
        rules_secondary: 'Promos and ads do not count.',
      },
    ],
  };
}

function trumpEvent() {
  return {
    event_ticker: 'KXTRUMPMENTION-26JUN18',
    series_ticker: 'KXTRUMPMENTION',
    title: 'What will Trump say during the press portion of the event?',
    sub_title: 'Single event press interview',
    settlement_sources: [],
    markets: [
      {
        ticker: 'KXTRUMPMENTION-26JUN18-TARIFF',
        title: 'Will Trump say tariff?',
        yes_sub_title: 'tariff',
        custom_strike: 'tariff',
        rules_primary: 'Resolves YES only if the press portion is open. Archival or prerecorded replays do not count.',
        rules_secondary: 'Archived replay does not qualify.',
      },
    ],
  };
}

function fedExEvent() {
  return {
    event_ticker: 'KXEARNINGSMENTIONFDX-26JUN23',
    series_ticker: 'KXEARNINGSMENTIONFDX',
    title: 'What will FedEx say on its earnings call?',
    sub_title: 'Q4 earnings call',
    settlement_sources: [
      { name: 'FedEx IR', url: 'https://investors.fedex.com/events-and-presentations' },
    ],
    markets: [
      {
        ticker: 'KXEARNINGSMENTIONFDX-26JUN23-GUIDANCE',
        title: 'Will FedEx say guidance?',
        yes_sub_title: 'guidance',
        custom_strike: 'guidance',
        rules_primary: 'Resolves YES if any company representative, including the operator or Q&A participant, says guidance during the call. https://rules.example/ignore-me',
        rules_secondary: 'The company IR transcript is final proof.',
      },
    ],
  };
}

function weeklyTrumpEvent() {
  return {
    event_ticker: 'KXTRUMPMENTIONW-26JUN18',
    series_ticker: 'KXTRUMPMENTIONW',
    title: 'What will Trump say this week?',
    markets: [
      {
        ticker: 'KXTRUMPMENTIONW-26JUN18-TARIFF',
        title: 'Will Trump say tariff?',
        yes_sub_title: 'tariff',
        custom_strike: 'tariff',
        rules_primary: 'Resolves YES if Trump says tariff this week.',
      },
    ],
  };
}

function monthlyTrumpEvent() {
  return {
    event_ticker: 'KXTRUMPMENTIONM-26JUL18',
    series_ticker: 'KXTRUMPMENTIONM',
    title: 'What will Trump say this month?',
    markets: [
      {
        ticker: 'KXTRUMPMENTIONM-26JUL18-TARIFF',
        title: 'Will Trump say tariff?',
        yes_sub_title: 'tariff',
        custom_strike: 'tariff',
        rules_primary: 'Resolves YES if Trump says tariff this month.',
      },
    ],
  };
}

function truthSocialEvent() {
  return {
    event_ticker: 'KXTRUMPTRUTHSOCIAL-26JUN18',
    series_ticker: 'KXTRUMPTRUTHSOCIAL',
    title: 'What will Trump post on Truth Social?',
    markets: [
      {
        ticker: 'KXTRUMPTRUTHSOCIAL-26JUN18-TARIFF',
        title: 'Will Trump say tariff?',
        yes_sub_title: 'tariff',
        custom_strike: 'tariff',
        rules_primary: 'Resolves YES if Trump posts tariff on Truth Social.',
      },
    ],
  };
}

function emptyRulesEvent() {
  return {
    event_ticker: 'KXGARBAGE-26JUN18',
    series_ticker: 'KXGARBAGE',
    title: '',
    sub_title: '',
    settlement_sources: [],
    markets: [
      {
        ticker: 'KXGARBAGE-26JUN18-A',
      },
    ],
  };
}

function assertNoForbiddenKeys(value) {
  const walk = (node, path = []) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, [...path, index]));
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      assert.doesNotMatch(key, RULES_FORBIDDEN_PATTERN, `forbidden key ${[...path, key].join('.')}`);
      walk(child, [...path, key]);
    }
  };
  walk(value);
}

function intersect(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}

test('Obama broadcast interview snapshot captures slash bundle, plural/possessive handling, and promo/ad window policy', () => {
  const snapshot = buildMarketRulesSnapshot(obamaEvent(), obamaEvent().markets[0]);
  assert.equal(snapshot.rule_family, 'talk_show_media');
  assert.equal(snapshot.market_type, 'binary');
  assert.equal(snapshot.slash_bundle_policy.is_bundle, true);
  assert.deepEqual(snapshot.slash_bundle_policy.variants, ['kid', 'kids']);
  assert.deepEqual([...snapshot.accepted_forms].sort(), ['kid', "kid's", 'kids', "kids'"]);
  assert.ok(!snapshot.accepted_forms.includes('kidses'));
  assert.ok(!snapshot.accepted_forms.includes("kidses'"));
  assert.equal(snapshot.plural_possessive_allowed, true);
  assert.equal(snapshot.other_inflections_allowed, false);
  assert.match(snapshot.content_window_policy, /promos.*ads/i);
  assert.equal(snapshot.speaker_scope_policy, 'single_speaker');
  assertNoForbiddenKeys(snapshot);
  assert.doesNotMatch(JSON.stringify(snapshot), RULES_FORBIDDEN_PATTERN);
});

test('Trump event snapshot stays single-event, requires the press portion to be open, and excludes archival replays', () => {
  const snapshot = buildMarketRulesSnapshot(trumpEvent(), trumpEvent().markets[0]);
  assert.equal(snapshot.rule_family, 'trump_event');
  assert.equal(snapshot.out_of_scope, false);
  assert.equal(snapshot.market_type, 'binary');
  assert.match(snapshot.qualification_requirements.join(' '), /press.*open/i);
  assert.match(snapshot.content_window_policy, /archive|replay/i);
  assert.ok(snapshot.ednq_trigger_set.includes('press_portion_not_open'));
  assert.ok(snapshot.ednq_trigger_set.includes('archival_or_prerecorded_replay'));
  assertNoForbiddenKeys(snapshot);
});

test('FedEx earnings call snapshot is broad on speakers and only trusts settlement URLs from event.settlement_sources', () => {
  const event = fedExEvent();
  const snapshot = buildMarketRulesSnapshot(event, event.markets[0]);
  assert.equal(snapshot.rule_family, 'earnings_call');
  assert.equal(snapshot.speaker_scope_policy, 'any_company_representative_incl_operator_and_qa');
  assert.deepEqual(snapshot.eligible_speaker_set, ['company_representative', 'operator', 'q_and_a_participant']);
  assert.deepEqual(snapshot.settlement_sources, ['https://investors.fedex.com/events-and-presentations']);
  assert.deepEqual(snapshot.source_order, RULES_SOURCE_ORDER);
  assert.match(snapshot.content_window_policy, /operator.*qa/i);
  assert.ok(!snapshot.settlement_sources.includes('https://rules.example/ignore-me'));
  assertNoForbiddenKeys(snapshot);
});

test('slash bundles produce multiple accepted variants', () => {
  const snapshot = buildMarketRulesSnapshot(obamaEvent(), obamaEvent().markets[0]);
  assert.ok(snapshot.accepted_forms.includes('kid'));
  assert.ok(snapshot.accepted_forms.includes('kids'));
  assert.deepEqual(snapshot.slash_bundle_policy.variants, ['kid', 'kids']);
});

test('plural and possessive are allowed, while other inflections are blocked', () => {
  const snapshot = buildMarketRulesSnapshot(obamaEvent(), obamaEvent().markets[0]);
  assert.equal(snapshot.plural_possessive_allowed, true);
  assert.equal(snapshot.other_inflections_allowed, false);
  assert.ok(!snapshot.accepted_forms.includes('kidding'));
  assert.ok(!snapshot.accepted_forms.includes('kiddo'));
  assert.ok(snapshot.blocked_forms.length > 0);
});

test('blocked forms stay category-based and disjoint from accepted forms', () => {
  const trumpSnapshot = buildMarketRulesSnapshot(trumpEvent(), trumpEvent().markets[0]);
  const fedSnapshot = buildMarketRulesSnapshot(fedExEvent(), fedExEvent().markets[0]);

  for (const [snapshot, baseWord, fabricatedForms] of [
    [trumpSnapshot, 'tariff', ['tariffed', 'tariffest']],
    [fedSnapshot, 'guidance', ['guidanceed', 'guidanceing']],
  ]) {
    assert.ok(snapshot.blocked_forms.includes('other_inflections'));
    assert.ok(!snapshot.blocked_forms.includes(baseWord));
    assert.deepEqual(intersect(snapshot.accepted_forms, snapshot.blocked_forms), []);
    for (const fabricated of fabricatedForms) {
      assert.ok(!snapshot.blocked_forms.includes(fabricated));
    }
  }

  const obamaSnapshot = buildMarketRulesSnapshot(obamaEvent(), obamaEvent().markets[0]);
  assert.ok(!obamaSnapshot.blocked_forms.includes('kided'));
  assert.ok(!obamaSnapshot.blocked_forms.includes('kidsest'));
});

test('EDNQ triggers are extracted from rules text', () => {
  const snapshot = buildMarketRulesSnapshot(trumpEvent(), trumpEvent().markets[0]);
  assert.ok(snapshot.ednq_trigger_set.includes('archival_or_prerecorded_replay'));
  assert.ok(snapshot.ednq_trigger_set.includes('press_portion_not_open'));
});

test('settlement_sources comes only from event.settlement_sources[].url', () => {
  const snapshot = buildMarketRulesSnapshot(fedExEvent(), fedExEvent().markets[0]);
  assert.deepEqual(snapshot.settlement_sources, ['https://investors.fedex.com/events-and-presentations']);
  assert.ok(!snapshot.settlement_sources.includes('https://rules.example/ignore-me'));
});

test('price-like fields are stripped recursively before snapshot output', () => {
  const dirtyEvent = {
    ...fedExEvent(),
    metadata: {
      yes_bid: 11,
      nested: [
        { open_interest: 200, keep_me: 'yes' },
        { settlement_value_dollars: 1234, deep: { no_ask: 99 } },
      ],
    },
  };
  const dirtyMarket = {
    ...dirtyEvent.markets[0],
    yes_bid: 42,
    yes_ask: 45,
    volume: 99,
    open_interest: 100,
    nested: {
      settlement_value_dollars: 999,
      child: { last_trade_price: 1, safe: 'ok' },
    },
  };
  const snapshot = buildMarketRulesSnapshot(dirtyEvent, dirtyMarket);
  assertNoForbiddenKeys(snapshot);
  assert.doesNotMatch(JSON.stringify(snapshot), RULES_FORBIDDEN_PATTERN);
  assert.ok(!Object.prototype.hasOwnProperty.call(snapshot, 'yes_bid'));
  assert.ok(!Object.prototype.hasOwnProperty.call(snapshot, 'open_interest'));
  assert.ok(!Object.prototype.hasOwnProperty.call(snapshot, 'settlement_value_dollars'));
});

test('weekly/monthly/truth_social variants are out of scope', () => {
  const wrapper = buildRulesSnapshot(weeklyTrumpEvent());
  assert.equal(wrapper.out_of_scope, true);
  assert.equal(wrapper.markets.length, 1);
  const weekly = buildMarketRulesSnapshot(weeklyTrumpEvent(), weeklyTrumpEvent().markets[0]);
  const monthly = buildMarketRulesSnapshot(monthlyTrumpEvent(), monthlyTrumpEvent().markets[0]);
  const truth = buildMarketRulesSnapshot(truthSocialEvent(), truthSocialEvent().markets[0]);
  for (const snapshot of [weekly, monthly, truth]) {
    assert.equal(snapshot.out_of_scope, true);
    assert.equal(snapshot.rule_family, null);
    assert.ok(snapshot.block_reasons.includes('OUT_OF_SCOPE_ROLLING'));
  }
});

test('rules snapshot output is deterministic and hash-stable for identical input', () => {
  const event = fedExEvent();
  const a = buildMarketRulesSnapshot(event, event.markets[0]);
  const b = buildMarketRulesSnapshot(structuredClone(event), structuredClone(event.markets[0]));
  assert.deepEqual(a, b);
  assert.equal(a.rules_snapshot_hash, b.rules_snapshot_hash);
});

test('unclear rules are marked unsupported and blocked', () => {
  const snapshot = buildMarketRulesSnapshot(emptyRulesEvent(), emptyRulesEvent().markets[0]);
  assert.equal(snapshot.market_type, 'unsupported');
  assert.ok(snapshot.block_reasons.includes('BLOCKED_RULES_UNCLEAR'));
});

test('resolver uses active rules_snapshot and falls back to regex when the snapshot is out of scope', () => {
  const fedEvent = fedExEvent();
  const fedSnapshot = buildMarketRulesSnapshot(fedEvent, fedEvent.markets[0]);
  const snapshotRoute = resolveResearchRoute(fedEvent, { now: new Date('2026-06-12T12:00:00Z'), rulesSnapshot: fedSnapshot });
  assert.equal(snapshotRoute.route, 'earnings_call');
  assert.equal(snapshotRoute.basis, 'rules_snapshot');

  const weeklyEvent = weeklyTrumpEvent();
  const weeklySnapshot = buildMarketRulesSnapshot(weeklyEvent, weeklyEvent.markets[0]);
  const fallbackRoute = resolveResearchRoute(weeklyEvent, { now: new Date('2026-06-12T12:00:00Z'), rulesSnapshot: weeklySnapshot });
  assert.equal(fallbackRoute.route, 'trump_weekly');
  assert.equal(fallbackRoute.basis, 'trump_weekly_ticker_term');
});
