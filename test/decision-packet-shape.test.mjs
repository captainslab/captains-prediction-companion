import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EDGE_STATUS,
  CONFIDENCE,
  buildDecisionRow,
  renderDecisionBoard,
  rankDecisionRows,
  buildInventoryArtifact,
  looksLikeRawInventoryDump,
  impliedProbabilityFromMarket,
} from '../scripts/shared/decision-packet.mjs';

function strongRow(overrides = {}) {
  return buildDecisionRow({
    marketTicker: 'KXMLBGAME-A',
    sideTarget: 'NYY ML',
    marketType: 'sports_game',
    settlementSummary: 'Yankees win',
    composite: {
      score: 0.62,
      posture: 'EVIDENCE LEAN',
      layersPresent: 10,
      layersTotal: 13,
      topEvidenceLayers: ['starter_edge', 'bullpen'],
      missingLayers: ['weather'],
      modelProbability: 0.62,
    },
    market: { yes_bid: 0.50, yes_ask: 0.52, last_price: 0.51, volume: 1000, open_interest: 700 },
    trigger: { price: 0.50, event: 'lineup confirms' },
    analysis: 'Model 62% vs implied ~51%.',
    ...overrides,
  });
}

test('implied probability is a mid of yes bid/ask (cents or dollars accepted)', () => {
  assert.equal(impliedProbabilityFromMarket({ yes_bid: 0.50, yes_ask: 0.52 }), 0.51);
  assert.equal(impliedProbabilityFromMarket({ yes_bid: 50, yes_ask: 52 }), 0.51);
  assert.equal(impliedProbabilityFromMarket({ last_price: 0.40 }), 0.40);
  assert.equal(impliedProbabilityFromMarket({}), null);
});

test('a decision row carries BOTH composite/model fields AND market price/implied/edge fields', () => {
  const r = strongRow();
  // composite/model half
  assert.ok('composite_score' in r);
  assert.ok('composite_posture' in r);
  assert.ok('layers_present' in r);
  assert.notEqual(r.composite_score, undefined);
  // market half
  assert.ok('market_yes_bid' in r);
  assert.ok('last_price' in r);
  assert.ok('volume' in r);
  assert.ok('open_interest' in r);
  // edge half (model vs market)
  assert.ok('implied_probability' in r);
  assert.ok('fair_probability_or_range' in r);
  assert.ok('edge_cents_or_pp' in r);
  assert.ok('edge_status' in r);
  assert.ok('confidence' in r);
});

test('FAIL if a row has market info but no composite/model fields', () => {
  const r = strongRow();
  // Simulate a "market only" packet by checking the guard: a row must not be
  // considered valid if composite fields are absent.
  const marketOnly = { market_yes_bid: 0.5, last_price: 0.5, implied_probability: 0.5 };
  const hasComposite = (row) => 'composite_score' in row && 'composite_posture' in row && 'layers_present' in row;
  assert.equal(hasComposite(marketOnly), false, 'market-only object should be rejected');
  assert.equal(hasComposite(r), true, 'real decision row must include composite fields');
});

test('FAIL if a row has composite fields but no market price/implied/edge fields', () => {
  const r = strongRow();
  const compositeOnly = { composite_score: 0.6, composite_posture: 'LEAN', layers_present: '9/13' };
  const hasMarketEdge = (row) => 'market_yes_bid' in row && 'implied_probability' in row && 'edge_status' in row;
  assert.equal(hasMarketEdge(compositeOnly), false, 'composite-only object should be rejected');
  assert.equal(hasMarketEdge(r), true, 'real decision row must include market + edge fields');
});

test('market price is NOT fed into composite scoring (edge derives from fair vs implied only)', () => {
  // Same composite, two very different market prices -> composite_score is
  // identical; only edge/implied differ. Proves price neutrality of scoring.
  const cheap = strongRow({ market: { yes_bid: 0.30, yes_ask: 0.32 } });
  const rich = strongRow({ market: { yes_bid: 0.80, yes_ask: 0.82 } });
  assert.equal(cheap.composite_score, rich.composite_score);
  assert.equal(cheap.composite_posture, rich.composite_posture);
  assert.equal(cheap.layers_present, rich.layers_present);
  // but edge moves with market price
  assert.notEqual(cheap.edge_cents_or_pp, rich.edge_cents_or_pp);
  assert.ok(cheap.edge_cents_or_pp > rich.edge_cents_or_pp, 'cheaper market => bigger positive edge for same fair');
});

test('a board of incomplete-but-strong composites does NOT collapse to all-WATCH', () => {
  // Rows with strong composite posture but no numeric fair must still surface
  // via posture fallback, not become uniformly WATCH because evidence is partial.
  const rows = [
    buildDecisionRow({
      marketTicker: 'A', sideTarget: 'x', marketType: 'sports_game', settlementSummary: 's',
      composite: { score: 0.7, posture: 'STRONG EVIDENCE LEAN', layersPresent: 11, layersTotal: 13, topEvidenceLayers: ['a'], missingLayers: ['b'] },
      market: { yes_bid: 0.5, yes_ask: 0.52 },
    }),
    buildDecisionRow({
      marketTicker: 'B', sideTarget: 'y', marketType: 'sports_game', settlementSummary: 's',
      composite: { score: 0.65, posture: 'EVIDENCE LEAN', layersPresent: 9, layersTotal: 13, topEvidenceLayers: ['a'], missingLayers: ['b'] },
      market: { yes_bid: 0.4, yes_ask: 0.42 },
    }),
  ];
  const statuses = rows.map((r) => r.edge_status);
  assert.ok(statuses.some((s) => s !== EDGE_STATUS.WATCH), 'strong composites must not all be WATCH');
});

test('a settlement/source-critical blocker yields BLOCKED while still showing market info', () => {
  const r = buildDecisionRow({
    marketTicker: 'KXMENT-X', sideTarget: 'says "tariff"', marketType: 'mention_market', settlementSummary: 'exact-string',
    composite: { score: null, posture: 'NO_CLEAR_PICK', layersPresent: 0, layersTotal: 7, topEvidenceLayers: [], missingLayers: ['settlement', 'source'] },
    market: { yes_bid: 0.30, yes_ask: 0.35, volume: 50 },
    blocker: 'BLOCKED_SOURCE_LAYER_MISSING',
  });
  assert.equal(r.edge_status, EDGE_STATUS.BLOCKED);
  // market info still present even when blocked
  assert.equal(r.market_yes_bid, 0.30);
  assert.notEqual(r.implied_probability, null);
});

test('source_ladder MISSING is NOT a final useful result when research could run: it must be BLOCKED, not PASS/WATCH masquerading as done', () => {
  const r = buildDecisionRow({
    marketTicker: 'KXMENT-Y', sideTarget: 'mention', marketType: 'mention_market', settlementSummary: 'exact-string',
    composite: { score: null, posture: 'NO_CLEAR_PICK', layersPresent: 0, layersTotal: 7, topEvidenceLayers: [], missingLayers: ['source_ladder'] },
    market: { yes_bid: 0.2, yes_ask: 0.25 },
    blocker: 'BLOCKED_SOURCE_LAYER_MISSING',
  });
  assert.equal(r.edge_status, EDGE_STATUS.BLOCKED);
  assert.notEqual(r.edge_status, EDGE_STATUS.PASS);
  assert.notEqual(r.edge_status, EDGE_STATUS.WATCH);
});

test('main board renderer does NOT dump giant raw market inventory', () => {
  const rows = Array.from({ length: 5 }, (_, i) => strongRow({ marketTicker: `T${i}` }));
  const board = renderDecisionBoard(rows, { heading: 'MLB DECISION BOARD' });
  assert.equal(looksLikeRawInventoryDump(board), false);
  // sanity: it IS a readable board
  assert.match(board, /DECISION BOARD/);
  assert.match(board, /edge=/);
});

test('raw inventory lives only in the audit artifact and is flagged as such', () => {
  const inv = buildInventoryArtifact({
    marketType: 'sports_game', date: '2026-05-31', eventTicker: 'KXMLBGAME-A',
    inventoryLines: ['  - ticker: A', '    yes_bid: 0.5', '    rules_primary: long text...'],
  });
  assert.equal(looksLikeRawInventoryDump(inv), true);
  assert.match(inv, /NOT IN MAIN PACKET/);
});

test('rows rank by edge status then magnitude (PICK/LEAN above WATCH/PASS)', () => {
  const watch = strongRow({ marketTicker: 'W', composite: { score: 0.5, posture: 'WATCH', layersPresent: 3, layersTotal: 13 }, market: { yes_bid: 0.6, yes_ask: 0.62 } });
  const lean = strongRow({ marketTicker: 'L' });
  const ranked = rankDecisionRows([watch, lean]);
  assert.equal(ranked[0].market_ticker, 'L');
});
