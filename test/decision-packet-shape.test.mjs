import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EDGE_STATUS,
  EDGE_THRESHOLDS,
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

// --- P1 guard: statusOverride reconciled against numeric edge -----------------
// A domain scorer can pass an authoritative statusOverride, but a POSITIVE
// override (PICK/LEAN) must never survive when the numeric edge contradicts it.
// BLOCKED still wins over everything. Market price never enters these checks —
// edge is model-fair-vs-implied only.

function overrideRow(overrides = {}) {
  // fair 10% vs implied 80% => -70pp edge; the override claims a positive status.
  return buildDecisionRow({
    marketTicker: 'KXNASCAR-A',
    sideTarget: 'Driver X to win',
    marketType: 'sports_winner',
    settlementSummary: 'Driver X wins the race',
    composite: { score: 0.10, posture: 'EVIDENCE LEAN', layersPresent: 8, layersTotal: 12, modelProbability: 0.10 },
    fair: { probability: 0.10 },
    market: { yes_bid: 0.79, yes_ask: 0.81 },
    analysis: 'Model 10% vs implied ~80%.',
    ...overrides,
  });
}

test('P1: a PICK override does NOT survive a clearly negative edge -> surfaces as FADE', () => {
  const r = overrideRow({ statusOverride: EDGE_STATUS.PICK });
  assert.ok(r.edge_cents_or_pp < 0, 'precondition: numeric edge is negative');
  assert.equal(r.edge_status, EDGE_STATUS.FADE, 'positive override must yield to negative edge');
  assert.notEqual(r.edge_status, EDGE_STATUS.PICK);
  assert.notEqual(r.edge_status, EDGE_STATUS.LEAN);
});

test('P1: a LEAN override does NOT survive a clearly negative edge -> surfaces as FADE', () => {
  const r = overrideRow({ statusOverride: EDGE_STATUS.LEAN });
  assert.equal(r.edge_status, EDGE_STATUS.FADE);
});

test('P1: a contradicted positive override is NOT promoted into Top Edge by its magnitude', () => {
  // The bug: large _edge_abs (70) on a LEAN row pushed it into the topEdge bucket.
  const bad = overrideRow({ statusOverride: EDGE_STATUS.LEAN, marketTicker: 'BAD' });
  const good = strongRow({ marketTicker: 'GOOD' }); // genuine +11pp LEAN
  const ranked = rankDecisionRows([bad, good]);
  // FADE sorts below LEAN, so the genuine positive edge must rank first.
  assert.equal(ranked[0].market_ticker, 'GOOD');
  assert.equal(bad.edge_status, EDGE_STATUS.FADE);
});

test('P1: a PICK/LEAN override inside the noise band downgrades to the threshold verdict (PASS)', () => {
  // fair 50% vs implied ~50.5% => ~ -0.5pp, inside NOISE_PP band.
  const r = buildDecisionRow({
    marketTicker: 'KXNASCAR-B', sideTarget: 'Driver Y', marketType: 'sports_winner', settlementSummary: 's',
    composite: { score: 0.5, posture: 'EVIDENCE LEAN', layersPresent: 8, layersTotal: 12, modelProbability: 0.5 },
    fair: { probability: 0.50 },
    market: { yes_bid: 0.50, yes_ask: 0.51 },
    statusOverride: EDGE_STATUS.LEAN,
  });
  assert.ok(Math.abs(r.edge_cents_or_pp) <= 1.5, 'precondition: edge inside noise band');
  assert.equal(r.edge_status, EDGE_STATUS.PASS, 'no real edge => override downgraded to PASS');
});

test('P1: a VALID positive edge still honors a PICK/LEAN override', () => {
  // fair 62% vs implied ~51% => +11pp; override should be preserved.
  const r = strongRow({ statusOverride: EDGE_STATUS.LEAN });
  assert.ok(r.edge_cents_or_pp >= EDGE_THRESHOLDS.LEAN_PP, 'precondition: clear positive edge');
  assert.equal(r.edge_status, EDGE_STATUS.LEAN, 'valid positive edge keeps the override');
});

test('P1: a FADE override is always honored (negative statuses never overstate edge)', () => {
  // Even with a positive edge, a domain FADE call is trusted as-is.
  const r = strongRow({ statusOverride: EDGE_STATUS.FADE });
  assert.equal(r.edge_status, EDGE_STATUS.FADE);
});

test('P1: BLOCKED still overrides everything, including a positive override on a positive edge', () => {
  const r = strongRow({ statusOverride: EDGE_STATUS.PICK, blocker: 'BLOCKED_SETTLEMENT_UNCLEAR' });
  assert.equal(r.edge_status, EDGE_STATUS.BLOCKED);
});

test('P1: a positive override with NO numeric edge (model-only lane) is preserved', () => {
  // No fair probability and no market implied => edge is null; override stands.
  const r = buildDecisionRow({
    marketTicker: 'KXNASCAR-C', sideTarget: 'Driver Z', marketType: 'sports_winner', settlementSummary: 's',
    composite: { score: 0.7, posture: 'STRONG EVIDENCE LEAN', layersPresent: 9, layersTotal: 12 },
    market: {}, // no price => no implied => edge null
    statusOverride: EDGE_STATUS.PICK,
  });
  assert.equal(r.edge_cents_or_pp, null, 'precondition: no numeric edge');
  assert.equal(r.edge_status, EDGE_STATUS.PICK, 'model-only lane keeps the override');
});

test('P1 neutrality: the guard reads only the model-vs-implied edge, never raw market price as a composite input', () => {
  // Same composite + override, two wildly different prices: composite half is
  // identical; only the reconciled edge_status flips with the edge direction.
  const cheap = strongRow({ statusOverride: EDGE_STATUS.LEAN, market: { yes_bid: 0.30, yes_ask: 0.32 } });
  const rich = strongRow({ statusOverride: EDGE_STATUS.LEAN, market: { yes_bid: 0.90, yes_ask: 0.92 } });
  assert.equal(cheap.composite_score, rich.composite_score);
  assert.equal(cheap.composite_posture, rich.composite_posture);
  assert.equal(cheap.edge_status, EDGE_STATUS.LEAN, 'cheap market: real positive edge keeps LEAN');
  assert.equal(rich.edge_status, EDGE_STATUS.FADE, 'rich market: negative edge forces FADE despite override');
});
