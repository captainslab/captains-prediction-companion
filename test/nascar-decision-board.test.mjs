import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildNascarRows,
  buildRacePacket,
  loadNascarCeiling,
} from '../scripts/packets/generate-nascar-sunday.mjs';
import { looksLikeRawInventoryDump } from '../scripts/shared/decision-packet.mjs';

// A minimal Kalshi NASCAR win-market event: per-driver binary contracts keyed
// by yes_sub_title. Prices in dollars (Kalshi public listing shape).
function nascarEvent(overrides = {}) {
  return {
    event_ticker: 'KXNASCARRACE-TEST26',
    title: 'Test 400 Winner',
    product_metadata: { competition: 'NASCAR Cup Series' },
    markets: [
      {
        ticker: 'KXNASCARRACE-TEST26-HAML', yes_sub_title: 'Denny Hamlin',
        yes_bid_dollars: 0.18, yes_ask_dollars: 0.20, last_price_dollars: 0.19,
        volume_fp: 5000, open_interest_fp: 12000, rules_primary: 'Wins the race',
      },
      {
        ticker: 'KXNASCARRACE-TEST26-LARS', yes_sub_title: 'Kyle Larson',
        yes_bid_dollars: 0.14, yes_ask_dollars: 0.16, last_price_dollars: 0.15,
        volume_fp: 4000, open_interest_fp: 9000, rules_primary: 'Wins the race',
      },
      {
        ticker: 'KXNASCARRACE-TEST26-BELL', yes_sub_title: 'Christopher Bell',
        yes_bid_dollars: 0.09, yes_ask_dollars: 0.11, last_price_dollars: 0.10,
        volume_fp: 2000, open_interest_fp: 6000, rules_primary: 'Wins the race',
      },
    ],
    ...overrides,
  };
}

// A real ceiling-board shape (candidates with composite_score + lanes), the
// MODEL signal. No market price in here — fair win prob is derived from score.
function ceiling(overrides = {}) {
  return {
    candidates: [
      {
        driver_name: 'Denny Hamlin', composite_score: 78,
        fundamentals_layer_coverage: 4, fundamentals_layer_coverage_label: '4/4 layers',
        score_breakdown: { inputs_used: [{ layer: 'starting_position' }, { layer: 'practice_speed' }] },
        lanes: { win: { status: 'EVIDENCE_LEAN', narrative: 'Pole + strong concrete-track history.' } },
      },
      {
        driver_name: 'Kyle Larson', composite_score: 60,
        fundamentals_layer_coverage: 3, fundamentals_layer_coverage_label: '3/4 layers',
        score_breakdown: { inputs_used: [{ layer: 'starting_position' }] },
        lanes: { win: { status: 'WATCH', narrative: 'Top equipment, mid start.' } },
      },
    ],
    source: '/tmp/ceiling_board.json',
    lanes: ['win'],
    ...overrides,
  };
}

test('JOINED mode: ceiling model joins win markets and produces model-vs-market edge rows', () => {
  const built = buildNascarRows({ event: nascarEvent(), ceiling: ceiling() });
  assert.ok(built, 'rows built');
  assert.equal(built.mode, 'JOINED');
  assert.equal(built.joined, 2, 'two drivers joined to model');
  assert.equal(built.marketCount, 3);

  const hamlin = built.rows.find((r) => r.side_target.startsWith('Denny Hamlin'));
  // model half carries composite, NOT the market price
  assert.equal(hamlin.composite_score, 78);
  // fair win prob is normalized from composite (78/(78+60) ~ 0.565), not market
  assert.match(hamlin.fair_probability_or_range, /%$/);
  // market half carries the price
  assert.equal(hamlin.market_yes_ask, 0.20);
  // edge is numeric (fair - implied) since both halves present
  assert.ok(hamlin.edge_cents_or_pp !== null, 'numeric edge present in JOINED mode');
  // composite score must not equal the implied market price
  assert.notEqual(hamlin.composite_score, hamlin.implied_probability * 100);
});

test('MARKET_ONLY mode: no ceiling -> rows BLOCKED on missing model but keep market data', () => {
  const built = buildNascarRows({ event: nascarEvent(), ceiling: null });
  assert.ok(built, 'rows built');
  assert.equal(built.mode, 'MARKET_ONLY');
  assert.equal(built.joined, 0);
  for (const r of built.rows) {
    assert.equal(r.edge_status, 'BLOCKED');
    assert.match(r.blocker_if_any, /BLOCKED_MODEL_LAYER_MISSING/);
    // market data still present so the row is useful
    assert.ok(r.market_yes_ask !== null, 'market price retained');
    assert.ok(r.implied_probability !== null, 'implied prob retained');
    // explicit missing model layer + actionable trigger
    assert.ok(r.missing_layers.includes('ceiling_board_composite'));
    assert.match(r.trigger_event, /ceiling board/i);
  }
});

test('NASCAR packet: sectioned board, market+composite together, raw inventory audit-only', () => {
  const packet = buildRacePacket({
    date: '2026-05-31',
    event: nascarEvent(),
    sourcePath: '/tmp/event.json',
    artifacts: [], // no ceiling artifact -> MARKET_ONLY/BLOCKED path
    workspaceResult: null,
  });
  assert.ok(packet, 'packet built');

  // main packet has the sectioned board
  assert.match(packet.text, /TLDR BOARD:/);
  assert.match(packet.text, /TOP EDGE CANDIDATES/);
  assert.match(packet.text, /WATCHLIST \/ TRIGGER BOARD/);
  assert.match(packet.text, /FADES \/ OVERPRICED/);
  assert.match(packet.text, /BLOCKED \/ NEEDS SOURCE/);
  assert.match(packet.text, /AUDIT ARTIFACTS/);

  // rows carry market fields AND explicit BLOCKED model fields
  assert.match(packet.text, /market: implied=/);
  assert.match(packet.text, /BLOCKED_MODEL_LAYER_MISSING/);

  // raw inventory NOT in main packet
  assert.equal(looksLikeRawInventoryDump(packet.text), false);
  // raw inventory lives in its own audit artifact
  assert.ok(looksLikeRawInventoryDump(packet.inventoryText), 'inventory artifact is the raw dump');
  assert.equal(packet.marketCount, 3);
});

test('JOINED packet: real model edge rows with composite scores surface above BLOCKED', () => {
  // Event with ONLY the two modeled drivers -> every market joins the model.
  const ev = nascarEvent({
    markets: nascarEvent().markets.filter((m) =>
      m.yes_sub_title === 'Denny Hamlin' || m.yes_sub_title === 'Kyle Larson'),
  });
  const cb = ceiling();
  const loaded = { candidates: cb.candidates, source: cb.source, lanes: cb.lanes };
  const built = buildNascarRows({ event: ev, ceiling: loaded });
  // No row should be BLOCKED when every driver joined the model.
  const blocked = built.rows.filter((r) => r.edge_status === 'BLOCKED');
  assert.equal(blocked.length, 0, 'fully-joined board has no BLOCKED rows');
  // composite score present on every joined row
  for (const r of built.rows) assert.ok(r.composite_score !== null, 'composite score present');
});

test('loadNascarCeiling ignores artifacts without candidates', () => {
  // A fixtures-only placeholder with `ceilings` (not `candidates`) must NOT join.
  assert.equal(loadNascarCeiling([]), null);
});
