// Phase 5 — render the price-free settled_history artifact in the customer
// mentions packet text. Render-only: the deterministic Section 6 provenance slot
// surfaces match tier, sample size, hits/misses, hit rate, the full
// settlement-class breakdown, bounded source tickers, and the usable/fail_safe
// flag. n<2 / soft-only history must read as fail-safe (never bullish); a null
// settled_history must invent NOTHING; Truth Social blocked output renders no
// history; weekly/monthly Trump (legacy-supported) renders normally; and no
// price-shaped field may appear inside the rendered history block.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMentionCompositeForMarket,
  buildMentionSlatePacket,
} from '../scripts/packets/generate-mentions-daily.mjs';

// ---- fixtures ---------------------------------------------------------------

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
      },
    ],
  };
}

function trumpWeeklyEvent() {
  return {
    event_ticker: 'KXTRUMPMENTION-26JUN13',
    series_ticker: 'KXTRUMPMENTION',
    title: 'What will Trump say this week?',
    sub_title: 'Trump weekly mention market',
    close_time: '2026-06-14T03:00:00Z',
    markets: [
      {
        ticker: 'KXTRUMPMENTION-26JUN13-TARIFF',
        title: 'Will President Trump say "Tariff" this week?',
        yes_sub_title: 'Tariff',
        custom_strike: 'Tariff',
        rules_primary: 'Resolves Yes if Trump says "Tariff" during the weekly window.',
        close_time: '2026-06-14T03:00:00Z',
        // price-like fields — must never appear in the rendered history block
        yes_bid: 41, yes_ask: 44, volume: 1200, open_interest: 900,
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

const obamaHistory = [
  { market_ticker: 'OB-1', series_ticker: 'KXOBAMAMENTION', event_date: '2026-05-01', result: 'yes', settlement_result: 'resolved_yes' },
  { market_ticker: 'OB-2', series_ticker: 'KXOBAMAMENTION', event_date: '2026-05-08', result: 'no', settlement_result: 'resolved_no' },
  { market_ticker: 'OB-3', series_ticker: 'KXOBAMAMENTION', event_date: '2026-05-15', result: 'yes', settlement_result: 'resolved_yes' },
];

// Mixed settlement classes: resolved YES/NO drive hits/misses; ednq/ambiguous/
// unresolved are recorded in the breakdown but carry no result (never settled).
const obamaMixedHistory = [
  { market_ticker: 'OBM-1', series_ticker: 'KXOBAMAMENTION', event_date: '2026-05-01', result: 'yes', settlement_result: 'resolved_yes' },
  { market_ticker: 'OBM-2', series_ticker: 'KXOBAMAMENTION', event_date: '2026-05-08', result: 'no', settlement_result: 'resolved_no' },
  { market_ticker: 'OBM-3', series_ticker: 'KXOBAMAMENTION', event_date: '2026-05-15', result: null, settlement_result: 'ednq' },
  { market_ticker: 'OBM-4', series_ticker: 'KXOBAMAMENTION', event_date: '2026-05-22', result: null, settlement_result: 'ambiguous' },
  { market_ticker: 'OBM-5', series_ticker: 'KXOBAMAMENTION', event_date: '2026-05-29', result: null, settlement_result: 'unresolved' },
];

// Single settled outcome -> n<2 -> usable=false, fail_safe=true.
const obamaThinHistory = [
  { market_ticker: 'OBT-1', series_ticker: 'KXOBAMAMENTION', event_date: '2026-05-01', result: 'yes', settlement_result: 'resolved_yes' },
];

const trumpWeeklyHistory = [
  { market_ticker: 'TW-1', series_ticker: 'KXTRUMPMENTION', event_date: '2026-05-01', result: 'yes', settlement_result: 'resolved_yes', route: 'trump_weekly', entity: 'trump', horizon: 'weekly' },
  { market_ticker: 'TW-2', series_ticker: 'KXTRUMPMENTION', event_date: '2026-05-08', result: 'no', settlement_result: 'resolved_no', route: 'trump_weekly', entity: 'trump', horizon: 'weekly' },
];

// ---- helpers ----------------------------------------------------------------

function renderPacket(event, market, candidateText, historyRecords) {
  const composite = buildMentionCompositeForMarket({
    event, market, candidateText, historyRecords,
  });
  const slate = buildMentionSlatePacket({
    date: '2026-06-19', event, composites: [composite],
  });
  assert.ok(slate?.text, 'slate packet must render text');
  return { text: slate.text, composite };
}

// Extract only the rendered settled_history detail block (header + indented
// lines) so price-isolation assertions never trip on Section 5 market context.
function settledHistoryBlock(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('- settled_history (Kalshi settled comparables'));
  if (start < 0) return '';
  // Section 6 prefixes every provenance line with "- "; continuation lines of
  // this block therefore render as "- " followed by indentation ("-   - kid").
  const block = [lines[start]];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^- \s/.test(lines[i])) block.push(lines[i]);
    else break;
  }
  return block.join('\n');
}

const PRICE_TOKENS = ['yes_bid', 'yes_ask', 'no_bid', 'no_ask', 'last_price', 'liquidity', 'volume', 'open_interest', 'bid', 'ask', 'implied', 'notional', '41', '44', '1200', '900'];

// ===========================================================================
// Rendering behavior
// ===========================================================================

test('exact_horizon settled_history renders tier, n, hits/misses, hit_rate, and tickers', () => {
  const ev = obamaEvent();
  const { text, composite } = renderPacket(ev, ev.markets[0], 'the kid waved', obamaHistory);
  assert.ok(composite.settled_history, 'guard: artifact attached');
  const block = settledHistoryBlock(text);
  assert.ok(block, 'settled_history block must render in packet text');
  assert.match(block, /tier=exact_horizon/);
  assert.match(block, /n=3/);
  assert.match(block, /hits=2/);
  assert.match(block, /misses=1/);
  assert.match(block, /hit_rate=0\.67/);
  assert.match(block, /usable=true/);
  assert.match(block, /fail_safe=false/);
  assert.match(block, /source_tickers: OB-/);
  assert.match(block, /count=3/);
});

test('EDNQ/ambiguous/unresolved render in the breakdown without becoming hits/misses', () => {
  const ev = obamaEvent();
  const { text } = renderPacket(ev, ev.markets[0], 'the kid waved', obamaMixedHistory);
  const block = settledHistoryBlock(text);
  assert.ok(block, 'block renders');
  // Only the two resolved outcomes feed hits/misses.
  assert.match(block, /hits=1/);
  assert.match(block, /misses=1/);
  // Soft classes are surfaced but isolated to the breakdown.
  assert.match(block, /settlement_breakdown: resolved_yes=1 resolved_no=1 ednq=1 ambiguous=1 unresolved=1/);
  // hit_rate is computed from resolved only (1/2), never inflated by soft rows.
  assert.match(block, /hit_rate=0\.50/);
});

test('n<2 settled history renders fail_safe / insufficient, never a positive signal', () => {
  const ev = obamaEvent();
  const { text, composite } = renderPacket(ev, ev.markets[0], 'the kid waved', obamaThinHistory);
  assert.equal(composite.settled_history.usable, false);
  assert.equal(composite.settled_history.fail_safe, true);
  const block = settledHistoryBlock(text);
  assert.match(block, /usable=false/);
  assert.match(block, /fail_safe=true/);
  assert.match(block, /insufficient settled history \(n<2/);
});

test('null settled_history (evaluated NO_MATCH) invents no history text', () => {
  const ev = obamaEvent();
  const { text, composite } = renderPacket(ev, ev.markets[0], 'the adult spoke', obamaHistory);
  assert.equal(composite.settled_history, null, 'guard: NO_MATCH suppresses history');
  assert.equal(settledHistoryBlock(text), '', 'no settled_history detail block may render');
  assert.ok(!text.includes('settlement_breakdown:'), 'no breakdown line when history is null');
});

test('Truth Social out-of-scope output renders no settled history', () => {
  const ev = truthSocialEvent();
  const { text, composite } = renderPacket(ev, ev.markets[0], 'tariff', [
    { market_ticker: 'TS-1', series_ticker: 'KXTRUMPTRUTHSOCIAL', event_date: '2026-05-01', result: 'yes', settlement_result: 'resolved_yes' },
    { market_ticker: 'TS-2', series_ticker: 'KXTRUMPTRUTHSOCIAL', event_date: '2026-05-08', result: 'yes', settlement_result: 'resolved_yes' },
  ]);
  assert.equal(composite.settled_history, null, 'guard: Truth Social blocked');
  assert.equal(settledHistoryBlock(text), '', 'blocked packet must not render settled history');
  assert.ok(!text.includes('settlement_breakdown:'));
});

test('weekly Trump (legacy-supported) renders settled history normally', () => {
  const ev = trumpWeeklyEvent();
  const { text, composite } = renderPacket(ev, ev.markets[0], 'tariff', trumpWeeklyHistory);
  assert.ok(composite.settled_history, 'guard: weekly Trump attaches history');
  const block = settledHistoryBlock(text);
  assert.ok(block, 'weekly/monthly supported history renders');
  assert.match(block, /tier=exact_horizon/);
  assert.match(block, /hits=1/);
  assert.match(block, /misses=1/);
});

test('no price-shaped field appears inside the rendered settled_history block', () => {
  const ev = trumpWeeklyEvent();
  const { text } = renderPacket(ev, ev.markets[0], 'tariff', trumpWeeklyHistory);
  const block = settledHistoryBlock(text);
  assert.ok(block, 'block renders');
  for (const token of PRICE_TOKENS) {
    assert.ok(!block.includes(token), `settled_history block must not contain price token "${token}"`);
  }
});

test('settled_history rendering is deterministic across repeated renders', () => {
  const ev = obamaEvent();
  const a = renderPacket(ev, ev.markets[0], 'the kid waved', obamaHistory);
  const b = renderPacket(ev, ev.markets[0], 'the kid waved', obamaHistory);
  assert.equal(settledHistoryBlock(a.text), settledHistoryBlock(b.text));
});
