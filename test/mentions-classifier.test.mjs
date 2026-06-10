// Tests for language-based mention market classifier.
// Proves: true mention markets are accepted, non-mention markets are rejected,
// CBRL absent stays blocked, no-results path is clean.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyMentionMarket,
  filterMentionEvents,
  KALSHI_SOURCES,
} from '../scripts/packets/lib/kalshi-discovery.mjs';

// ---------------------------------------------------------------------------
// True mention markets (should be accepted)
// ---------------------------------------------------------------------------

function trueMentionEarnings() {
  return {
    event_ticker: 'KXDELLMENTION-99JAN01',
    title: 'Will Dell mention PowerEdge on its earnings call?',
    sub_title: 'Dell earnings call',
    markets: [
      {
        ticker: 'KXDELLMENTION-99JAN01-POWEREDGE',
        title: 'Will Dell mention PowerEdge?',
        yes_sub_title: 'PowerEdge',
        rules_primary: 'If Dell says PowerEdge during the earnings call, this market resolves Yes.',
      },
    ],
  };
}

function trueMentionPolitical() {
  return {
    event_ticker: 'KXTRUMPSPEECH-99JAN01',
    title: 'Will Trump mention tariffs in his speech?',
    markets: [
      {
        ticker: 'KXTRUMPSPEECH-99JAN01-TARIFF',
        title: 'Will Trump say tariff?',
        rules_primary: 'If Trump utters the word "tariff" during the address, resolves Yes.',
      },
    ],
  };
}

function trueMentionTranscript() {
  return {
    event_ticker: 'KXFBACALL-99JAN01',
    title: 'FBA earnings call transcript mentions',
    markets: [
      {
        ticker: 'KXFBACALL-99JAN01-AI',
        title: 'Will the CEO mention AI during the conference call?',
        rules_primary: 'Resolves Yes if "AI" appears in the official transcript.',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Non-mention markets (should be rejected)
// ---------------------------------------------------------------------------

function falseIpoMarket() {
  return {
    event_ticker: 'KXIPOSTRIPE-26MAY01',
    title: 'When will Stripe officially announce an IPO?',
    markets: [
      { ticker: 'KXIPOSTRIPE-26MAY01', title: 'When will Stripe IPO?' },
    ],
  };
}

function falseMetricMarket() {
  return {
    event_ticker: 'KXTSLAA-28JANPROD',
    title: 'Tesla Inc. total production in 2026',
    markets: [
      { ticker: 'KXTSLAA-28JANPROD-1500000', title: 'Will Tesla Inc. report Above 1.5 million total production in 2026?' },
    ],
  };
}

function falseCeoSuccession() {
  return {
    event_ticker: 'KXNEWROLEJP-35DEC',
    title: 'Who will be the next CEO of JPMorgan Chase?',
    markets: [
      { ticker: 'KXNEWROLEJP-35DEC-MLA', title: 'Who will be the next CEO of JP Morgan Chase?' },
    ],
  };
}

function falseAcquisition() {
  return {
    event_ticker: 'KXCOMPANYACTIONEA-27',
    title: "When will EA's take-private acquisition close?",
    markets: [
      { ticker: 'KXCOMPANYACTIONEA-27-26JUL01', title: 'Will Electronic Arts close its take-private acquisition before Jul 1, 2026?' },
    ],
  };
}

function falseElectionWinner() {
  return {
    event_ticker: 'KXSCRGOVADVANCE-26JUN09',
    title: 'Who will advance in the South Carolina Republican Governor primary?',
    markets: [
      { ticker: 'KXSCRGOVADVANCE-26JUN09-A', title: 'Candidate A' },
    ],
  };
}

// ---------------------------------------------------------------------------
// CBRL absent market (should be rejected as non-mention, no false positive)
// ---------------------------------------------------------------------------

function cbrlEarningsMetric() {
  return {
    event_ticker: 'KXCBRL-28JANREV',
    title: 'Cracker Barrel Old Country Store Inc. revenue in 2026',
    markets: [
      { ticker: 'KXCBRL-28JANREV-1000', title: 'Will Cracker Barrel report Above $1B revenue in 2026?' },
    ],
  };
}

// ---------------------------------------------------------------------------
// classifyMentionMarket unit tests
// ---------------------------------------------------------------------------

test('classifyMentionMarket accepts true mention markets (earnings call)', () => {
  const event = trueMentionEarnings();
  const result = classifyMentionMarket(event, event.markets[0]);
  assert.equal(result.isMention, true);
  assert.equal(result.confidence, 'high');
});

test('classifyMentionMarket accepts true mention markets (political speech)', () => {
  const event = trueMentionPolitical();
  const result = classifyMentionMarket(event, event.markets[0]);
  assert.equal(result.isMention, true);
  assert.equal(result.confidence, 'high');
});

test('classifyMentionMarket accepts true mention markets (transcript)', () => {
  const event = trueMentionTranscript();
  const result = classifyMentionMarket(event, event.markets[0]);
  assert.equal(result.isMention, true);
  assert.equal(result.confidence, 'high');
});

test('classifyMentionMarket rejects IPO timing markets', () => {
  const event = falseIpoMarket();
  const result = classifyMentionMarket(event, event.markets[0]);
  assert.equal(result.isMention, false);
  assert.equal(result.confidence, 'high');
});

test('classifyMentionMarket rejects production metric markets', () => {
  const event = falseMetricMarket();
  const result = classifyMentionMarket(event, event.markets[0]);
  assert.equal(result.isMention, false);
  assert.equal(result.confidence, 'high');
});

test('classifyMentionMarket rejects CEO succession markets', () => {
  const event = falseCeoSuccession();
  const result = classifyMentionMarket(event, event.markets[0]);
  assert.equal(result.isMention, false);
  assert.equal(result.confidence, 'high');
});

test('classifyMentionMarket rejects acquisition close markets', () => {
  const event = falseAcquisition();
  const result = classifyMentionMarket(event, event.markets[0]);
  assert.equal(result.isMention, false);
  assert.equal(result.confidence, 'high');
});

test('classifyMentionMarket rejects election winner markets', () => {
  const event = falseElectionWinner();
  const result = classifyMentionMarket(event, event.markets[0]);
  assert.equal(result.isMention, false);
  assert.equal(result.confidence, 'high');
});

test('classifyMentionMarket rejects CBRL revenue metric (not a mention market)', () => {
  const event = cbrlEarningsMetric();
  const result = classifyMentionMarket(event, event.markets[0]);
  assert.equal(result.isMention, false);
  assert.equal(result.confidence, 'high');
});

// ---------------------------------------------------------------------------
// filterMentionEvents integration tests
// ---------------------------------------------------------------------------

test('filterMentionEvents keeps only mention-style events from mixed catalog', () => {
  const events = [
    trueMentionEarnings(),
    falseIpoMarket(),
    trueMentionPolitical(),
    falseMetricMarket(),
    falseCeoSuccession(),
  ];
  const { mentionEvents, rejectedEvents, stats } = filterMentionEvents(events);
  assert.equal(mentionEvents.length, 2);
  assert.equal(rejectedEvents.length, 3);
  assert.equal(stats.mentionEvents, 2);
  assert.equal(stats.rejectedEvents, 3);
  assert.equal(stats.totalMarkets, 5);
  assert.equal(stats.mentionMarkets, 2);

  // Verify the right events were kept
  const tickers = mentionEvents.map(e => e.event_ticker);
  assert.ok(tickers.includes('KXDELLMENTION-99JAN01'));
  assert.ok(tickers.includes('KXTRUMPSPEECH-99JAN01'));
});

test('filterMentionEvents returns clean zero-result when no mention markets exist', () => {
  const events = [
    falseIpoMarket(),
    falseMetricMarket(),
    falseCeoSuccession(),
    falseAcquisition(),
    falseElectionWinner(),
  ];
  const { mentionEvents, rejectedEvents, stats } = filterMentionEvents(events);
  assert.equal(mentionEvents.length, 0);
  assert.equal(rejectedEvents.length, 5);
  assert.equal(stats.mentionEvents, 0);
  assert.equal(stats.mentionMarkets, 0);
});

test('filterMentionEvents correctly handles CBRL absent scenario', () => {
  // Simulate the real Kalshi catalog: mixed non-mention events, no CBRL mention market
  const events = [
    falseIpoMarket(),
    falseMetricMarket(),
    cbrlEarningsMetric(), // CBRL revenue metric, NOT a mention market
    falseAcquisition(),
    falseElectionWinner(),
  ];
  const { mentionEvents, rejectedEvents, stats } = filterMentionEvents(events);
  assert.equal(mentionEvents.length, 0);
  assert.equal(rejectedEvents.length, 5);
  // CBRL is correctly rejected as non-mention
  const cbrlRejected = rejectedEvents.find(e => e.event_ticker === 'KXCBRL-28JANREV');
  assert.ok(cbrlRejected, 'CBRL revenue metric should be rejected');
});

// ---------------------------------------------------------------------------
// KALSHI_SOURCES broad discovery availability
// ---------------------------------------------------------------------------

test('KALSHI_SOURCES includes broad discovery source (no category filter)', () => {
  assert.ok(KALSHI_SOURCES.broad, 'broad source must exist');
  assert.ok(KALSHI_SOURCES.broad.api_url, 'broad source must have api_url');
  assert.equal(KALSHI_SOURCES.broad.label, 'kalshi-broad-discovery');
  // Must NOT include category=Mentions
  assert.ok(!KALSHI_SOURCES.broad.api_url.includes('category=Mentions'), 'broad source must not use category=Mentions');
});

test('KALSHI_SOURCES mentions source is marked deprecated but kept for compatibility', () => {
  assert.ok(KALSHI_SOURCES.mentions, 'mentions source kept for compatibility');
  assert.ok(KALSHI_SOURCES.mentions.api_url.includes('category=Mentions'), 'mentions source still has old category');
});
