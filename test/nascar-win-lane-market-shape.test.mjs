import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildNascarRows,
  isWinLaneMarket,
} from '../scripts/packets/generate-nascar-sunday.mjs';

// Regression coverage for two NASCAR packet bugs:
//   1. buildNascarRows()'s win filter (`yes_sub_title || expiration_value`)
//      pulled same-event top3/top5/top10 finishing-position contracts onto the
//      WIN board. Only true race-winner markets belong on it.
//   2. The market half only read *_dollars fields, silently dropping live
//      Kalshi `yes_bid`/`yes_ask`/`last_price` (cents) shapes mid-session.
//
// Market price NEVER feeds composite/candidate scoring — verified explicitly.

// A winner market: per-driver binary, rules say "wins the race".
function winMarket(ticker, driver, prices = {}) {
  return {
    ticker,
    yes_sub_title: driver,
    title: `Will ${driver} win the race?`,
    rules_primary: `${driver} wins the race`,
    ...prices,
  };
}

// A top-N finishing-position market: also per-driver, but rules/title say
// "finish in the top N". These must NOT land on the win board.
function topNMarket(ticker, driver, n, prices = {}) {
  return {
    ticker,
    yes_sub_title: driver,
    title: `Will ${driver} finish in the top ${n}?`,
    rules_primary: `${driver} finishes in the top ${n}`,
    ...prices,
  };
}

const DOLLARS = { yes_bid_dollars: 0.18, yes_ask_dollars: 0.20, last_price_dollars: 0.19 };
const CENTS = { yes_bid: 18, yes_ask: 20, last_price: 19 };

test('isWinLaneMarket: true winner markets included, top-N/fastest_lap excluded', () => {
  assert.equal(isWinLaneMarket(winMarket('W-HAML', 'Denny Hamlin')), true);
  assert.equal(isWinLaneMarket(topNMarket('T3-HAML', 'Denny Hamlin', 3)), false);
  assert.equal(isWinLaneMarket(topNMarket('T5-HAML', 'Denny Hamlin', 5)), false);
  assert.equal(isWinLaneMarket(topNMarket('T10-HAML', 'Denny Hamlin', 10)), false);
  assert.equal(
    isWinLaneMarket({
      ticker: 'FL-HAML', yes_sub_title: 'Denny Hamlin',
      title: 'Will Denny Hamlin record the fastest lap?',
      rules_primary: 'Denny Hamlin records the fastest lap',
    }),
    false,
    'fastest_lap excluded',
  );
});

test('isWinLaneMarket: sparse winner listing with no classifiable wording stays (fail-open)', () => {
  // Only a driver sub-title, no title/rules text -> keep on board, do not drop.
  assert.equal(isWinLaneMarket({ ticker: 'W-X', yes_sub_title: 'Kyle Larson' }), true);
  // Not a per-driver binary at all -> not a win market.
  assert.equal(isWinLaneMarket({ ticker: 'NOPE' }), false);
});

test('buildNascarRows excludes top-N lanes from the WIN board', () => {
  const event = {
    event_ticker: 'KXNASCARRACE-MIX26',
    product_metadata: { competition: 'NASCAR Cup Series' },
    markets: [
      winMarket('W-HAML', 'Denny Hamlin', DOLLARS),
      winMarket('W-LARS', 'Kyle Larson', DOLLARS),
      topNMarket('T3-HAML', 'Denny Hamlin', 3, DOLLARS),
      topNMarket('T5-LARS', 'Kyle Larson', 5, DOLLARS),
      topNMarket('T10-BELL', 'Christopher Bell', 10, DOLLARS),
    ],
  };
  const built = buildNascarRows({ event, ceiling: null });
  assert.ok(built, 'rows built');
  // Only the 2 true winner markets survive; 3 top-N contracts excluded.
  assert.equal(built.marketCount, 2, 'only winner markets counted');
  assert.equal(built.rows.length, 2);
  const tickers = built.rows.map((r) => r.market_ticker).sort();
  assert.deepEqual(tickers, ['W-HAML', 'W-LARS']);
  // Every surviving row targets a WIN side.
  for (const r of built.rows) assert.match(r.side_target, /— WIN$/);
});

test('buildNascarRows maps the *_dollars Kalshi shape correctly', () => {
  const event = {
    event_ticker: 'KXNASCARRACE-DOL26',
    product_metadata: { competition: 'NASCAR Cup Series' },
    markets: [winMarket('W-HAML', 'Denny Hamlin', DOLLARS)],
  };
  const built = buildNascarRows({ event, ceiling: null });
  const row = built.rows[0];
  assert.equal(row.market_yes_bid, 0.18);
  assert.equal(row.market_yes_ask, 0.20);
  assert.equal(row.last_price, 0.19);
  // implied prob from dollars mid (0.18+0.20)/2 = 0.19
  assert.equal(row.implied_probability, 0.19);
});

test('buildNascarRows maps the live yes_bid/yes_ask/last_price (cents) shape correctly', () => {
  const event = {
    event_ticker: 'KXNASCARRACE-CTS26',
    product_metadata: { competition: 'NASCAR Cup Series' },
    markets: [winMarket('W-HAML', 'Denny Hamlin', CENTS)],
  };
  const built = buildNascarRows({ event, ceiling: null });
  const row = built.rows[0];
  // Live cents shape must survive onto the row (was previously dropped to null).
  assert.equal(row.market_yes_bid, 18);
  assert.equal(row.market_yes_ask, 20);
  assert.equal(row.last_price, 19);
  // implied prob normalizes cents -> (18+20)/2 = 19c -> 0.19
  assert.equal(row.implied_probability, 0.19);
});

test('market price NEVER enters composite/candidate scoring (cents shape)', () => {
  // Ceiling model carries the only legitimate score signal. Build a winner
  // market whose cents price, if leaked, would be visibly distinguishable from
  // the composite score.
  const ceiling = {
    candidates: [
      {
        driver_name: 'Denny Hamlin', composite_score: 78,
        fundamentals_layer_coverage: 4, fundamentals_layer_coverage_label: '4/4 layers',
        score_breakdown: { inputs_used: [{ layer: 'starting_position' }] },
        lanes: { win: { status: 'EVIDENCE_LEAN', narrative: 'Pole + strong history.' } },
      },
    ],
    source: '/tmp/ceiling_board.json',
    lanes: ['win'],
  };
  const event = {
    event_ticker: 'KXNASCARRACE-NEU26',
    product_metadata: { competition: 'NASCAR Cup Series' },
    markets: [winMarket('W-HAML', 'Denny Hamlin', CENTS)],
  };
  const built = buildNascarRows({ event, ceiling });
  const row = built.rows.find((r) => r.side_target.startsWith('Denny Hamlin'));
  // Composite score is the model value, untouched by the 18/20/19c market half.
  assert.equal(row.composite_score, 78);
  assert.notEqual(row.composite_score, row.market_yes_bid);
  assert.notEqual(row.composite_score, row.market_yes_ask);
  assert.notEqual(row.composite_score, row.last_price);
  // Fair prob derives from composite (single candidate -> 1.0), not the 0.19
  // market implied.
  assert.match(row.fair_probability_or_range, /%$/);
  assert.notEqual(row.fair_probability_or_range, `${Math.round(row.implied_probability * 100)}%`);
});
