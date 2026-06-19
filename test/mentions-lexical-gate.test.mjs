// Lexical pre-evidence gate — unit + pipeline-integration coverage.
//
// Proves the literal lexical engine is wired into the downstream mention
// pipeline (buildMentionCompositeForMarket) as a HARD pre-evidence gate, and
// that price-like fields can never influence the gate or its output.

import test from 'node:test';
import assert from 'node:assert/strict';

import { gateMentionMarket } from '../scripts/mentions/lexical-gate.mjs';
import { buildMarketRulesSnapshot } from '../scripts/mentions/rules-analyst.mjs';
import { buildMentionCompositeForMarket } from '../scripts/packets/generate-mentions-daily.mjs';

// ---- fixtures (mirror test/mentions-lexical-engine.test.mjs) ----------------

function obamaEvent() {
  return {
    event_ticker: 'KXOBAMAMENTION-26JUN19',
    series_ticker: 'KXOBAMAMENTION',
    title: 'What will Obama say during the broadcast interview?',
    sub_title: 'Obama interview',
    settlement_sources: [{ name: 'network', url: 'https://network.example/obama' }],
    markets: [
      {
        ticker: 'KXOBAMAMENTION-26JUN19-KID',
        title: 'Will Obama say kid/kids?',
        yes_sub_title: 'kid/kids',
        custom_strike: 'kid/kids',
        rules_primary: 'Resolves YES if Obama says kid or kids during the broadcast interview.',
        rules_secondary: 'Promos and ads do not count.',
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
    markets: [{ ticker: 'KXGARBAGE-26JUN18-A' }],
  };
}

function weeklyTrumpEvent() {
  return {
    event_ticker: 'KXTRUMPMENTIONW-26JUN18',
    series_ticker: 'KXTRUMPMENTIONW',
    title: 'What will Trump say this week?',
    sub_title: 'Trump weekly mention market',
    markets: [
      {
        ticker: 'KXTRUMPMENTIONW-26JUN18-TARIFF',
        title: 'Will Trump say tariff this week?',
        yes_sub_title: 'tariff',
        custom_strike: 'tariff',
        rules_primary: 'Resolves YES if Trump says tariff this week.',
      },
    ],
  };
}

// Object-form custom_strike (item 6): must extract the word, not "[object Object]".
function objectStrikeEvent() {
  return {
    event_ticker: 'KXGUTFELDMENTION-26MAY28',
    title: 'Gutfeld!',
    sub_title: 'mention',
    markets: [{ ticker: 'KXGUTFELD-1', custom_strike: { Word: 'Fraud' }, yes_sub_title: 'Fraud' }],
  };
}

const PRICE_FIELDS = {
  yes_bid_dollars: 0.62,
  yes_ask_dollars: 0.65,
  no_bid_dollars: 0.35,
  no_ask_dollars: 0.38,
  last_price_dollars: 0.64,
  volume_fp: 99999,
  open_interest_fp: 4242,
  spread_cents: 3,
};

// ===========================================================================
// Gate unit behavior
// ===========================================================================

test('gate: BLOCKED_RULES_UNCLEAR is a hard block, never a soft verdict', () => {
  const ev = emptyRulesEvent();
  const gate = gateMentionMarket({ event: ev, market: ev.markets[0], candidateText: 'whatever text' });
  assert.equal(gate.decision, 'BLOCK');
  assert.equal(gate.hard_blocked, true);
  assert.equal(gate.proceed_to_evidence, false);
  assert.equal(gate.lexical_result.status, 'BLOCKED');
  assert.ok(gate.lexical_result.block_reasons.includes('BLOCKED_RULES_UNCLEAR'));
});

test('gate: out-of-scope (Truth Social) is a hard block, never active', () => {
  const ev = truthSocialEvent();
  const gate = gateMentionMarket({ event: ev, market: ev.markets[0], candidateText: 'tariff tariff' });
  assert.equal(gate.decision, 'OUT_OF_SCOPE');
  assert.equal(gate.hard_blocked, true);
  assert.equal(gate.proceed_to_evidence, false);
  assert.equal(gate.lexical_result.out_of_scope, true);
});

test('gate: evaluated NO_MATCH suppresses, MATCH proceeds', () => {
  const ev = obamaEvent();
  const noMatch = gateMentionMarket({ event: ev, market: ev.markets[0], candidateText: 'the adult waved' });
  assert.equal(noMatch.decision, 'NO_MATCH');
  assert.equal(noMatch.suppress_conviction, true);
  assert.equal(noMatch.evidence_evaluated, true);

  const match = gateMentionMarket({ event: ev, market: ev.markets[0], candidateText: 'the kid waved' });
  assert.equal(match.decision, 'MATCH');
  assert.equal(match.suppress_conviction, false);
  assert.equal(match.proceed_to_evidence, true);
  assert.equal(match.lexical_result.matched_count, 1);
});

test('gate: rules valid but no evidence text yet is PENDING (not suppressed)', () => {
  const ev = obamaEvent();
  const gate = gateMentionMarket({ event: ev, market: ev.markets[0] });
  assert.equal(gate.decision, 'PENDING');
  assert.equal(gate.suppress_conviction, false);
  assert.equal(gate.proceed_to_evidence, true);
  assert.equal(gate.evidence_evaluated, false);
});

test('gate: threshold below N suppresses, at N proceeds', () => {
  const ev = thresholdEvent();
  const snap = buildMarketRulesSnapshot(ev, ev.markets[0]);
  assert.equal(snap.market_type, 'threshold_count');

  const below = gateMentionMarket({ event: ev, market: ev.markets[0], candidateText: 'tariff and tariff again' });
  assert.equal(below.lexical_result.required_count, 3);
  assert.equal(below.lexical_result.matched_count, 2);
  assert.equal(below.decision, 'NO_MATCH');
  assert.equal(below.suppress_conviction, true);

  const atN = gateMentionMarket({ event: ev, market: ev.markets[0], candidateText: 'tariff tariff tariff' });
  assert.equal(atN.lexical_result.matched_count, 3);
  assert.equal(atN.decision, 'MATCH');
});

test('gate: comparative_count carries deterministic topic_counts only', () => {
  const ev = topicMostEvent();
  const snap = buildMarketRulesSnapshot(ev, ev.markets[0]);
  assert.equal(snap.market_type, 'comparative_count');
  const gate = gateMentionMarket({ event: ev, market: ev.markets[0], candidateText: 'kid kid kids' });
  assert.ok(Array.isArray(gate.lexical_result.topic_counts));
  // count-only, descending; no probability/rank scoring field present
  for (const entry of gate.lexical_result.topic_counts) {
    assert.deepEqual(Object.keys(entry).sort(), ['count', 'form']);
  }
  // Deterministic, count-descending; first two carry the literal counts, the
  // remaining accepted forms stay at count 0 (no probability/rank scoring).
  assert.deepEqual(gate.lexical_result.topic_counts.slice(0, 2), [
    { form: 'kid', count: 2 },
    { form: 'kids', count: 1 },
  ]);
  for (const entry of gate.lexical_result.topic_counts.slice(2)) {
    assert.equal(entry.count, 0);
  }
});

test('gate: price-like fields cannot change the decision', () => {
  const ev = obamaEvent();
  const clean = gateMentionMarket({ event: ev, market: ev.markets[0], candidateText: 'the kid waved' });
  const priced = gateMentionMarket({
    event: ev,
    market: { ...ev.markets[0], ...PRICE_FIELDS },
    candidateText: 'the kid waved',
  });
  assert.equal(priced.decision, clean.decision);
  assert.equal(priced.lexical_result.matched_count, clean.lexical_result.matched_count);
  // no price field leaked into the lexical artifact
  const json = JSON.stringify(priced.lexical_result);
  assert.doesNotMatch(json, /bid|ask|volume|open_interest|spread|last_price|odds/i);
});

test('gate: rolling weekly/monthly is legacy-supported, NOT hard-blocked', () => {
  const ev = weeklyTrumpEvent();
  const gate = gateMentionMarket({ event: ev, market: ev.markets[0] });
  // snapshot is rolling-out-of-scope, but the gate keeps it as a supported route
  assert.equal(gate.lexical_result.out_of_scope, true);
  assert.equal(gate.decision, 'ROLLING_SUPPORTED');
  assert.equal(gate.hard_blocked, false);
  assert.equal(gate.proceed_to_evidence, true);
});

test('gate: object-form custom_strike resolves real accepted_forms (no "[object Object]")', () => {
  const ev = objectStrikeEvent();
  const snap = buildMarketRulesSnapshot(ev, ev.markets[0]);
  assert.ok(snap.accepted_forms.includes('fraud'), 'expected literal "fraud" accepted form');
  for (const form of snap.accepted_forms) {
    assert.doesNotMatch(form, /\[object/i);
  }
  // determinable strike + binary type => not a fake BLOCKED_RULES_UNCLEAR
  assert.ok(!snap.block_reasons.includes('BLOCKED_RULES_UNCLEAR'));
  const gate = gateMentionMarket({ event: ev, market: ev.markets[0], candidateText: 'that is fraud' });
  assert.equal(gate.decision, 'MATCH');
  assert.deepEqual(gate.lexical_result.matched_forms, ['fraud']);
});

test('gate: legacy carrier with a determinable strike is not fake-blocked', () => {
  const gate = gateMentionMarket({
    legacy: { ticker: 'KXTEST-SCORED', target_phrase: 'recession', event_context: 'White House press briefing' },
  });
  assert.equal(gate.hard_blocked, false);
  assert.equal(gate.decision, 'PENDING');
});

// ===========================================================================
// Pipeline integration — buildMentionCompositeForMarket consumes the gate
// ===========================================================================

test('pipeline: composite attaches lexical_gate (downstream path calls the engine)', () => {
  const ev = obamaEvent();
  const out = buildMentionCompositeForMarket({ event: ev, market: ev.markets[0], candidateText: 'the kid waved' });
  assert.ok(out.lexical_gate, 'lexical_gate must be attached to every composite');
  assert.equal(out.lexical_gate.decision, 'MATCH');
  assert.equal(out.lexical_gate.lexical_result.status, 'MATCH');
});

test('pipeline: BLOCKED_RULES_UNCLEAR stops before scoring/rendering', () => {
  const ev = emptyRulesEvent();
  const out = buildMentionCompositeForMarket({ event: ev, market: ev.markets[0], candidateText: 'kid' });
  assert.equal(out.lexical_gate.decision, 'BLOCK');
  assert.equal(out.posture_final, 'NO_CLEAR_PICK');
  assert.equal(out.result.posture, 'NO_CLEAR_PICK');
  assert.equal(out.result.composite_score, null);
  assert.equal(out.result.confidence, null);
  assert.equal(out.result.lexical_blocked, true);
  assert.deepEqual(out.result.evidence_ledger, []);
});

test('pipeline: OUT_OF_SCOPE stops before active route handling', () => {
  const ev = truthSocialEvent();
  const out = buildMentionCompositeForMarket({ event: ev, market: ev.markets[0], candidateText: 'tariff' });
  assert.equal(out.lexical_gate.decision, 'OUT_OF_SCOPE');
  assert.equal(out.result.lexical_blocked, true);
  assert.equal(out.posture_final, 'NO_CLEAR_PICK');
  assert.equal(out.result.composite_score, null);
});

test('pipeline: evaluated NO_MATCH cannot produce positive posture/confidence', () => {
  const ev = obamaEvent();
  // Inject strong present layers that WOULD score a PICK — suppression must win.
  const market = {
    ...ev.markets[0],
    layer_records: {
      baseline_relevance: { present: true, score: 95, source_basis: 'test' },
      event_proximity: { present: true, score: 95, source_basis: 'test' },
      direct_mention_pathway: { present: true, score: 95, source_basis: 'test' },
    },
  };
  const out = buildMentionCompositeForMarket({ event: ev, market, candidateText: 'the adult spoke' });
  assert.equal(out.lexical_gate.decision, 'NO_MATCH');
  assert.equal(out.result.posture, 'NO_CLEAR_PICK');
  assert.equal(out.posture_final, 'NO_CLEAR_PICK');
  assert.equal(out.result.composite_score, null);
  assert.equal(out.result.confidence, null);
});

test('pipeline: MATCH proceeds with lexical_result attached and not blocked', () => {
  const ev = obamaEvent();
  const out = buildMentionCompositeForMarket({ event: ev, market: ev.markets[0], candidateText: 'the kid waved' });
  assert.equal(out.lexical_gate.decision, 'MATCH');
  assert.notEqual(out.result.lexical_blocked, true);
  assert.equal(out.lexical_gate.lexical_result.matched_count, 1);
});

test('pipeline: threshold below N does not upgrade; at N proceeds', () => {
  const ev = thresholdEvent();
  const below = buildMentionCompositeForMarket({ event: ev, market: ev.markets[0], candidateText: 'tariff tariff' });
  assert.equal(below.lexical_gate.decision, 'NO_MATCH');
  assert.equal(below.result.composite_score, null);
  assert.equal(below.posture_final, 'NO_CLEAR_PICK');

  const atN = buildMentionCompositeForMarket({ event: ev, market: ev.markets[0], candidateText: 'tariff tariff tariff' });
  assert.equal(atN.lexical_gate.decision, 'MATCH');
  assert.notEqual(atN.result.lexical_blocked, true);
});

test('pipeline: topic_most_mentioned preserves deterministic topic_counts only', () => {
  const ev = topicMostEvent();
  const out = buildMentionCompositeForMarket({ event: ev, market: ev.markets[0], candidateText: 'kid kid kids' });
  const counts = out.lexical_gate.lexical_result.topic_counts;
  assert.deepEqual(counts.slice(0, 2), [
    { form: 'kid', count: 2 },
    { form: 'kids', count: 1 },
  ]);
  for (const entry of counts.slice(2)) assert.equal(entry.count, 0);
});

test('pipeline: price-like fields cannot affect gate or leak into output', () => {
  const ev = obamaEvent();
  const market = { ...ev.markets[0], ...PRICE_FIELDS };
  const out = buildMentionCompositeForMarket({ event: ev, market, candidateText: 'the kid waved' });
  assert.equal(out.lexical_gate.decision, 'MATCH');
  const json = JSON.stringify(out.lexical_gate);
  assert.doesNotMatch(json, /bid|ask|volume|open_interest|spread|last_price|odds/i);
});
