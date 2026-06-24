import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMarketRulesSnapshot } from '../scripts/mentions/rules-analyst.mjs';
import { evaluateLexicalMention } from '../scripts/mentions/lexical-engine.mjs';
import { RULES_FORBIDDEN_PATTERN } from '../scripts/mentions/rules-analyst.mjs';

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
        rules_primary: 'Resolves YES if Obama says kid or kids during the broadcast interview. Promotional counts and ads are excluded.',
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
        rules_primary: 'Resolves YES only if the press portion is open.',
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
        rules_primary: 'Resolves YES if any company representative says guidance during the call.',
        rules_secondary: 'The company IR transcript is final proof.',
      },
    ],
  };
}

function acronymEvent() {
  return {
    event_ticker: 'KXOBAMAMENTION-26JUN20',
    series_ticker: 'KXOBAMAMENTION',
    title: 'What will Obama say during the interview?',
    sub_title: 'Obama interview',
    settlement_sources: [],
    markets: [
      {
        ticker: 'KXOBAMAMENTION-26JUN20-AI',
        title: 'Will Obama say AI?',
        yes_sub_title: 'AI',
        custom_strike: 'AI',
        rules_primary: 'Resolves YES if Obama says AI during the interview.',
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

function topicMostEvent() {
  return {
    event_ticker: 'KXTOPICMENTION-26JUN21',
    series_ticker: 'KXTOPICMENTION',
    title: 'Which topic will be mentioned most this period?',
    sub_title: 'topic count',
    settlement_sources: [],
    markets: [
      {
        ticker: 'KXTOPICMENTION-26JUN21-KID',
        title: 'Will kid/kids be mentioned most?',
        yes_sub_title: 'kid/kids',
        custom_strike: 'kid/kids',
        rules_primary: 'Resolves YES for the word from the word bank said the most times.',
      },
    ],
  };
}

function thresholdEvent() {
  return {
    event_ticker: 'KXTRUMPMENTION-26JUN24',
    series_ticker: 'KXTRUMPMENTION',
    title: 'What will Trump say during the press portion?',
    sub_title: 'single event',
    settlement_sources: [],
    markets: [
      {
        ticker: 'KXTRUMPMENTION-26JUN24-TARIFF',
        title: 'Will Trump say tariff 3+ times?',
        yes_sub_title: 'tariff',
        custom_strike: 'tariff',
        rules_primary: 'Resolves YES if Trump says tariff 3+ times during the press portion.',
      },
    ],
  };
}

function wordThresholdEvent() {
  return {
    event_ticker: 'KXTRUMPMENTION-26JUN25',
    series_ticker: 'KXTRUMPMENTION',
    title: 'What will Trump say during the press portion?',
    sub_title: 'single event',
    settlement_sources: [],
    markets: [
      {
        ticker: 'KXTRUMPMENTION-26JUN25-TARIFF',
        title: 'Will Trump say tariff at least three times?',
        yes_sub_title: 'tariff',
        custom_strike: 'tariff',
        rules_primary: 'Resolves YES if Trump says tariff at least three times during the press portion.',
      },
    ],
  };
}

test('binary accepted form matches once', () => {
  const snapshot = buildMarketRulesSnapshot(obamaEvent(), obamaEvent().markets[0]);
  const result = evaluateLexicalMention({ rules_snapshot: snapshot, candidate_text: 'the kid waved' });
  assert.equal(result.status, 'MATCH');
  assert.deepEqual(result.matched_forms, ['kid']);
  assert.equal(result.matched_count, 1);
  assert.equal(result.required_count, 1);
});

test('case-insensitive matching is boundary-safe', () => {
  const snapshot = buildMarketRulesSnapshot(obamaEvent(), obamaEvent().markets[0]);
  const upper = evaluateLexicalMention({ rules_snapshot: snapshot, candidate_text: 'KID!' });
  const inside = evaluateLexicalMention({ rules_snapshot: snapshot, candidate_text: 'kidding' });
  assert.equal(upper.status, 'MATCH');
  assert.deepEqual(upper.matched_forms, ['kid']);
  assert.equal(inside.status, 'NO_MATCH');
  assert.equal(inside.matched_count, 0);
});

test('slash bundle variants count independently', () => {
  const snapshot = buildMarketRulesSnapshot(obamaEvent(), obamaEvent().markets[0]);
  const result = evaluateLexicalMention({ rules_snapshot: snapshot, candidate_text: 'kid kids' });
  assert.equal(result.status, 'MATCH');
  assert.deepEqual(result.matched_forms, ['kid', 'kids']);
  assert.equal(result.matched_count, 2);
});

test('invented plurals never match', () => {
  const snapshot = buildMarketRulesSnapshot(obamaEvent(), obamaEvent().markets[0]);
  const result = evaluateLexicalMention({ rules_snapshot: snapshot, candidate_text: 'kidses' });
  assert.equal(result.status, 'NO_MATCH');
  assert.deepEqual(result.matched_forms, []);
  assert.equal(result.matched_count, 0);
});

test('plural and possessive forms match only when accepted_forms include them', () => {
  const snapshot = buildMarketRulesSnapshot(trumpEvent(), trumpEvent().markets[0]);
  const accepted = evaluateLexicalMention({
    rules_snapshot: snapshot,
    candidate_text: "tariff tariffs tariff's tariffs'",
  });
  const rejected = evaluateLexicalMention({
    rules_snapshot: snapshot,
    candidate_text: 'tariffed tariffing tariffest',
  });
  assert.equal(accepted.status, 'MATCH');
  assert.deepEqual(accepted.matched_forms, ['tariff', "tariff's", 'tariffs', "tariffs'"]);
  assert.equal(accepted.matched_count, 4);
  assert.equal(rejected.status, 'NO_MATCH');
  assert.equal(rejected.matched_count, 0);
});

test('guidance only matches accepted forms and rejects other inflections', () => {
  const snapshot = buildMarketRulesSnapshot(fedExEvent(), fedExEvent().markets[0]);
  const accepted = evaluateLexicalMention({
    rules_snapshot: snapshot,
    candidate_text: 'guidance guidances',
  });
  const rejected = evaluateLexicalMention({
    rules_snapshot: snapshot,
    candidate_text: 'guidanceed guidanceing',
  });
  assert.equal(accepted.status, 'MATCH');
  assert.deepEqual(accepted.matched_forms, ['guidance', 'guidances']);
  assert.equal(accepted.matched_count, 2);
  assert.equal(rejected.status, 'NO_MATCH');
  assert.equal(rejected.matched_count, 0);
});

test('closed compounds and hyphenated forms do not count as the literal', () => {
  const snapshot = buildMarketRulesSnapshot(trumpEvent(), trumpEvent().markets[0]);
  const result = evaluateLexicalMention({
    rules_snapshot: snapshot,
    candidate_text: 'anti-tariff stance and tariff-free policy',
  });
  assert.equal(result.status, 'NO_MATCH');
  assert.equal(result.matched_count, 0);
});

test('acronym expansions are not matched', () => {
  const snapshot = buildMarketRulesSnapshot(acronymEvent(), acronymEvent().markets[0]);
  assert.ok(snapshot.blocked_forms.includes('expanded_acronym:artificial intelligence'));
  const result = evaluateLexicalMention({
    rules_snapshot: snapshot,
    candidate_text: 'artificial intelligence',
  });
  assert.equal(result.status, 'NO_MATCH');
  assert.equal(result.matched_count, 0);
});

test('BLOCKED_RULES_UNCLEAR snapshots remain blocked', () => {
  const snapshot = buildMarketRulesSnapshot(emptyRulesEvent(), emptyRulesEvent().markets[0]);
  const result = evaluateLexicalMention({
    rules_snapshot: snapshot,
    candidate_text: 'kid',
  });
  assert.equal(result.status, 'BLOCKED');
  assert.deepEqual(result.matched_forms, []);
  assert.equal(result.matched_count, 0);
  assert.ok(result.block_reasons.includes('BLOCKED_RULES_UNCLEAR'));
});

test('out-of-scope weekly and truth_social snapshots remain blocked', () => {
  for (const event of [weeklyTrumpEvent(), truthSocialEvent()]) {
    const snapshot = buildMarketRulesSnapshot(event, event.markets[0]);
    const result = evaluateLexicalMention({
      rules_snapshot: snapshot,
      candidate_text: 'tariff',
    });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.out_of_scope, true);
    assert.ok(result.block_reasons.includes('OUT_OF_SCOPE_ROLLING'));
  }
});

test('threshold_count requires the parsed threshold', () => {
  const snapshot = buildMarketRulesSnapshot(thresholdEvent(), thresholdEvent().markets[0]);
  assert.equal(snapshot.market_type, 'threshold_count');
  assert.equal(snapshot.required_count, 3);
  const twoHits = evaluateLexicalMention({
    rules_snapshot: snapshot,
    candidate_text: 'tariff tariff',
  });
  const threeHits = evaluateLexicalMention({
    rules_snapshot: snapshot,
    candidate_text: 'tariff tariff tariff',
  });
  assert.equal(twoHits.required_count, 3);
  assert.equal(twoHits.status, 'NO_MATCH');
  assert.equal(twoHits.matched_count, 2);
  assert.equal(threeHits.status, 'MATCH');
  assert.equal(threeHits.matched_count, 3);
});

test('threshold_count parses word-form and at-least thresholds', () => {
  const snapshot = buildMarketRulesSnapshot(wordThresholdEvent(), wordThresholdEvent().markets[0]);
  assert.equal(snapshot.market_type, 'threshold_count');
  assert.equal(snapshot.required_count, 3);
  const result = evaluateLexicalMention({
    rules_snapshot: snapshot,
    candidate_text: 'tariff tariff tariff',
  });
  assert.equal(result.required_count, 3);
  assert.equal(result.status, 'MATCH');
});

test('comparative_count returns sorted topic_counts without a probability field', () => {
  const snapshot = buildMarketRulesSnapshot(topicMostEvent(), topicMostEvent().markets[0]);
  assert.equal(snapshot.market_type, 'comparative_count');
  const result = evaluateLexicalMention({
    rules_snapshot: snapshot,
    candidate_text: "kid kid kids kid's kids",
  });
  assert.equal(result.status, 'MATCH');
  assert.equal(result.required_count, null);
  assert.ok(Array.isArray(result.topic_counts));
  assert.deepEqual(result.topic_counts, [
    { form: 'kid', count: 2 },
    { form: 'kids', count: 2 },
    { form: "kid's", count: 1 },
    { form: "kids'", count: 0 },
  ]);
  assert.ok(!Object.hasOwn(result, 'score'));
});

test('price-like metadata is stripped and never appears in output', () => {
  const snapshot = buildMarketRulesSnapshot(obamaEvent(), obamaEvent().markets[0]);
  const result = evaluateLexicalMention({
    rules_snapshot: snapshot,
    candidate_text: 'the kid waved',
    speaker_meta: {
      yes_bid: 12,
      yes_ask: 14,
      nested: {
        volume: 99,
        open_interest: 100,
        keep_me: 'ok',
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(result), RULES_FORBIDDEN_PATTERN);
});

test('identical input is deterministic', () => {
  const snapshot = buildMarketRulesSnapshot(obamaEvent(), obamaEvent().markets[0]);
  const input = {
    rules_snapshot: snapshot,
    candidate_text: 'the kid waved',
    speaker_meta: {
      yes_bid: 9,
      nested: { no_ask: 4 },
    },
  };
  const first = evaluateLexicalMention(input);
  const second = evaluateLexicalMention(input);
  assert.deepEqual(first, second);
});

test('evidence spans are bounded and price-free', () => {
  const snapshot = buildMarketRulesSnapshot(obamaEvent(), obamaEvent().markets[0]);
  const candidate_text = Array.from({ length: 60 }, () => 'kid').join(' ');
  const result = evaluateLexicalMention({ rules_snapshot: snapshot, candidate_text });
  assert.equal(result.matched_count, 60);
  assert.equal(result.evidence_spans.length, 50);
  assert.equal(result.evidence_spans[0].form, 'kid');
  assert.doesNotMatch(JSON.stringify(result.evidence_spans), RULES_FORBIDDEN_PATTERN);
});
