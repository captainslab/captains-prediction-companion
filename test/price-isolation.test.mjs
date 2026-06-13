// CPC-wide price/market isolation guards.
//
// Rule: price and market data (price, bid/ask, odds, implied probability,
// volume, liquidity, open interest, movement) are NEVER model inputs, score
// inputs, or posture/ranking inputs. They may only appear in display/audit
// sections labeled NOT IN SCORE.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAnalystPrompt, buildRedteamPrompt } from '../scripts/mentions/model-router.mjs';
import { stripPriceLikeFields } from '../scripts/mentions/earnings-context-delta.mjs';
import { computeMentionComposite } from '../scripts/mentions/mention-composite-core.mjs';

const POISONED_INPUT = {
  event_ticker: 'KXTEST-26JUN12',
  summary: { terms: 2 },
  yes_bid: 42,
  yes_ask: 47,
  no_bid: 53,
  price_cents: 45,
  last_trade_price_cents: 44,
  volume: 1200,
  open_interest: 900,
  odds: '-110',
  implied_probability: 0.45,
  nested: {
    liquidity: 5000,
    notional_value: 100,
    safe_note: 'narrative context survives',
  },
};

test('buildAnalystPrompt strips price/market fields from model input', () => {
  const prompt = buildAnalystPrompt(POISONED_INPUT);
  for (const banned of ['yes_bid', 'yes_ask', 'no_bid', 'price_cents', 'last_trade_price_cents', '"volume"', 'open_interest', '"odds"', 'liquidity', 'notional']) {
    assert.ok(!prompt.includes(banned), `analyst prompt must not contain ${banned}`);
  }
  assert.ok(prompt.includes('event_ticker'), 'non-price fields survive');
  assert.ok(prompt.includes('safe_note'), 'nested non-price fields survive');
});

test('buildRedteamPrompt strips price/market fields from model input', () => {
  const prompt = buildRedteamPrompt(POISONED_INPUT);
  for (const banned of ['yes_bid', 'yes_ask', 'price_cents', '"volume"', 'open_interest', 'liquidity']) {
    assert.ok(!prompt.includes(banned), `redteam prompt must not contain ${banned}`);
  }
});

test('stripPriceLikeFields removes implied-probability and movement-style keys', () => {
  const out = stripPriceLikeFields({
    implied_prob_from_price: 0.5,
    price_movement_24h: 0.1,
    bid_ask_spread: 3,
    keep_me: 'yes',
  });
  assert.deepEqual(Object.keys(out), ['keep_me']);
});

test('mention composite rejects any layer carrying pricing fields (score/posture isolation)', () => {
  // Posture/ranking derive from the composite, so the entry guard is the
  // isolation proof: a price-bearing layer can never produce a score at all.
  for (const field of ['yes_bid', 'no_ask', 'last_price', 'volume', 'open_interest', 'odds', 'price']) {
    assert.throws(
      () => computeMentionComposite({ layers: { settled_history: { value: 1, [field]: 10 } } }),
      /forbidden pricing field/i,
      `composite must throw on layer field ${field}`,
    );
  }
});
