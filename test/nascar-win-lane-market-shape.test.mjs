import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildNascarRows,
  isWinLaneMarket,
} from '../scripts/packets/generate-nascar-sunday.mjs';
import {
  normalizeNascarWinMarkets,
} from '../scripts/nascar/lib/win-market-normalization.mjs';
import { normalizeNascarDriverName } from '../scripts/nascar/lib/driver-name.mjs';

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

const PRODUCTION_FIELD = [
  'Ryan Blaney', 'Joey Logano', 'Kyle Larson', 'Austin Dillon', 'Daniel Suarez',
  'Alex Bowman', 'Chase Elliott', 'Austin Cindric', 'Ross Chastain', 'Brad Keselowski',
  'Erik Jones', 'Shane Van Gisbergen', 'Chris Buescher', 'Carson Hocevar', 'Ricky Stenhouse Jr',
  'Ty Dillon', 'Josh Berry', 'Michael McDowell', 'Ryan Preece', 'Chase Briscoe',
  'Todd Gilliland', 'Bubba Wallace', 'Ty Gibbs', 'John Nemechek', 'Connor Zilisch',
  'William Byron', 'AJ Allmendinger', 'Denny Hamlin', 'Riley Herbst', 'Austin Hill',
  'Tyler Reddick', 'Christopher Bell', 'Cole Custer', 'Zane Smith', 'Cody Ware',
  'Noah Gragson', 'BJ McLeod', 'Chad Finchum',
];

test('official suffix variants join the same production driver identity', () => {
  assert.equal(normalizeNascarDriverName('Ricky Stenhouse Jr.'), normalizeNascarDriverName('Ricky Stenhouse'));
});

function productionShapeEvent() {
  const eventTicker = 'KXNASCARRACE-QUAKER26';
  return {
    event_ticker: eventTicker,
    title: 'Quaker State 400 Winner',
    product_metadata: { competition: 'NASCAR Cup Series' },
    markets: PRODUCTION_FIELD.map((driver, index) => ({
      ticker: `${eventTicker}-${String(index + 1).padStart(2, '0')}`,
      event_ticker: eventTicker,
      title: `Will ${driver} win the Quaker State 400?`,
      subtitle: 'Quaker State 400 Winner',
      yes_sub_title: driver,
      no_sub_title: `Field excluding ${driver}`,
      expiration_value: '',
      rules_primary: `${driver} wins the race`,
      occurrence_datetime: '2026-07-12T23:00:00Z',
      expected_expiration_time: '2026-07-13T03:00:00Z',
      close_time: '2026-07-12T23:00:00Z',
      yes_bid_dollars: (0.01 + index / 1000).toFixed(3),
      yes_ask_dollars: (0.02 + index / 1000).toFixed(3),
      no_bid_dollars: (0.97 - index / 1000).toFixed(3),
      no_ask_dollars: (0.98 - index / 1000).toFixed(3),
      last_price_dollars: (0.015 + index / 1000).toFixed(3),
      volume_fp: String(1000 + index),
      open_interest_fp: String(2000 + index),
      status: 'active',
    })),
  };
}

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

test('production-shape event normalizes all 38 top-level win markets without dropping audit fields', () => {
  const event = productionShapeEvent();
  const before = structuredClone(event);
  const normalized = normalizeNascarWinMarkets(event);

  assert.equal(normalized.length, 38);
  assert.equal(new Set(normalized.map((market) => market.ticker)).size, 38);
  assert.deepEqual(event, before, 'normalization must not mutate the persisted event');

  const first = normalized[0];
  assert.equal(first.event_ticker, event.event_ticker);
  assert.equal(first.yes_sub_title, 'Ryan Blaney');
  assert.equal(first.title, 'Will Ryan Blaney win the Quaker State 400?');
  assert.equal(first.subtitle, 'Quaker State 400 Winner');
  assert.equal(first.expiration_value, null);
  assert.equal(first.rules_primary, 'Ryan Blaney wins the race');
  assert.equal(first.occurrence_datetime, '2026-07-12T23:00:00Z');
  assert.equal(first.yes_bid_dollars, '0.010');
  assert.equal(first.yes_ask_dollars, '0.020');
  assert.equal(first.last_price_dollars, '0.015');
  assert.equal(first.volume_fp, '1000');
  assert.equal(first.open_interest_fp, '2000');

  const built = buildNascarRows({ event: { ...event, markets: normalized }, ceiling: null });
  assert.ok(built);
  assert.equal(built.marketCount, 38);
  assert.equal(built.rows.length, 38);
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
