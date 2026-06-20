import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mlbPickToDecisionRow,
  buildMlbSlatePacket,
} from '../scripts/packets/generate-mlb-daily.mjs';

// A realistic pre-lineup MLB pick: strong model edge, market price separate,
// lineup confirmation still pending.
function prelineupPick(overrides = {}) {
  return {
    market_ticker: 'KXMLBTOTAL-26MAY291905TORBAL-6',
    contract_title: 'Over 5.5 runs scored',
    game: 'Toronto Blue Jays at Baltimore Orioles',
    market_lane: 'total',
    classification: 'PRE_LINEUP_PICK',
    edge_pp: 8.04,
    fair_value: 0.8504,
    kalshi_ask: 0.77,
    primary_pick: true,
    missing_confirmations: ['lineup_pending', 'weather_data_pending'],
    gates_passed: ['g1:a', 'g2:b', 'g3:c', 'g4:d', 'g5:e', 'g6:f'],
    ...overrides,
  };
}

test('MLB pick -> decision row keeps model and market in separate halves', () => {
  const row = mlbPickToDecisionRow(prelineupPick());
  // model half carries fair_value, NOT the market price
  assert.equal(row.fair_probability_or_range, '85%');
  assert.equal(row.composite_score, 85);
  // market half carries the price
  assert.equal(row.market_yes_ask, 0.77);
  // edge is derived (fair - implied), positive, status PICK from scorer override
  assert.equal(row.edge_status, 'PICK');
  assert.ok(row.edge_cents_or_pp > 0, 'positive edge expected');
  // composite score must not equal the market price
  assert.notEqual(row.composite_score, row.market_yes_ask * 100);
});

test('pending lineup downgrades confidence but does NOT collapse to WATCH', () => {
  const row = mlbPickToDecisionRow(prelineupPick());
  assert.equal(row.edge_status, 'PICK', 'strong pre-lineup edge still surfaces as PICK');
  assert.notEqual(row.confidence, 'high', 'lineup pending should downgrade from high');
  assert.match(row.analysis, /pre-lineup/i);
  assert.match(row.trigger_event, /lineup/i);
});

test('MLB slate packet renders sectioned board and excludes raw inventory', () => {
  const scoring = {
    picks: [
      prelineupPick(),
      prelineupPick({ market_ticker: 'KXMLBGAME-1', classification: 'PASS', edge_pp: 0.4, fair_value: 0.5, kalshi_ask: 0.5, primary_pick: false }),
      prelineupPick({ market_ticker: 'KXMLBGAME-2', classification: 'FADE', edge_pp: -9.1, fair_value: 0.4, kalshi_ask: 0.49, primary_pick: false }),
    ],
    source: '/tmp/picks.json',
    summaryCounts: { pre_lineup_pick: 1, pass: 1, fade: 1 },
  };
  const slate = buildMlbSlatePacket({ date: '2026-05-29', scoring, inventoryPath: '/tmp/inv.txt' });
  assert.ok(slate, 'slate packet built');

  // 1. main packet does NOT contain a raw inventory dump
  assert.doesNotMatch(slate.text, /RAW CONTRACT INVENTORY/);
  // raw inventory lives in its own artifact and is flagged
  assert.match(slate.inventoryText, /RAW CONTRACT INVENTORY/);

  // 2. sectioned board present (TLDR + named sections)
  assert.match(slate.text, /TLDR BOARD:/);
  assert.match(slate.text, /TOP EDGE CANDIDATES/);
  assert.match(slate.text, /WATCHLIST \/ TRIGGER BOARD/);
  assert.match(slate.text, /FADES \/ OVERPRICED/);
  assert.match(slate.text, /BLOCKED \/ NEEDS SOURCE/);
  assert.match(slate.text, /AUDIT ARTIFACTS/);

  // 3. rows carry both composite/model fields AND market/implied/edge fields
  assert.match(slate.text, /model: fair=/);
  assert.match(slate.text, /market: implied=/);
  assert.match(slate.text, /edge=/);

  // 4. PASS rows are summarized out of the headline (not dumped row-by-row)
  assert.match(slate.text, /pass_rows_not_shown:/);

  // 5. FADE row routed into the FADES section
  const fadesIdx = slate.text.indexOf('FADES / OVERPRICED');
  const blockedIdx = slate.text.indexOf('BLOCKED / NEEDS SOURCE');
  const fadeRow = slate.text.indexOf('KXMLBGAME-2');
  assert.ok(fadeRow > fadesIdx && fadeRow < blockedIdx, 'FADE row sits in the FADES section');
});

test('BLOCKED MLB rows compact into event-level notes and never render score=MISSING rows', () => {
  const blockedPick = (market_ticker) => ({
    market_ticker,
    contract_title: 'Blocked HR market',
    game: 'Toronto Blue Jays at Baltimore Orioles',
    market_lane: 'home_run_hitter',
    classification: 'BLOCKED',
    fair_value: null,
    kalshi_ask: null,
    edge_pp: null,
    primary_pick: false,
    missing_confirmations: ['statcast_hr_optional_source_unavailable'],
    gates_passed: [],
  });

  const scoring = {
    picks: [
      blockedPick('KXMLB-HR-1'),
      blockedPick('KXMLB-HR-2'),
    ],
    source: '/tmp/picks.json',
    summaryCounts: { blocked: 2 },
  };
  const slate = buildMlbSlatePacket({ date: '2026-05-29', scoring, inventoryPath: '/tmp/inv.txt' });
  assert.ok(slate, 'slate packet built');
  assert.match(slate.text, /BLOCKED \/ NEEDS SOURCE/);
  assert.match(slate.text, /2 blocked row\(s\)/);
  assert.doesNotMatch(slate.text, /#\d+\s+\[BLOCKED\]/);
  assert.doesNotMatch(slate.text, /score=MISSING/);
});

test('market price is never folded into the composite score', () => {
  // Two picks identical except market price; composite_score must be identical.
  const a = mlbPickToDecisionRow(prelineupPick({ kalshi_ask: 0.77 }));
  const b = mlbPickToDecisionRow(prelineupPick({ kalshi_ask: 0.10 }));
  assert.equal(a.composite_score, b.composite_score, 'market price must not move composite score');
  assert.notEqual(a.edge_cents_or_pp, undefined);
});

test('null composite fair_value never renders NaN and is labeled as book-ref, not model fair', () => {
  // Real-world picks.json shape: the market-neutral composite produced no
  // probability (fair_value null) but a book-derived market_reference_prob and
  // edge_pp exist. The row must (a) never print NaN%, and (b) NOT claim the
  // book reference is the composite "model fair".
  const row = mlbPickToDecisionRow(prelineupPick({
    fair_value: null,
    market_reference_prob: 0.7438,
    kalshi_ask: 0.70,
    edge_pp: 4.382,
  }));
  assert.doesNotMatch(row.analysis, /NaN/, 'must never emit NaN in the analysis line');
  assert.match(row.analysis, /book-ref \(not composite\)/, 'book reference must be labeled honestly');
  assert.doesNotMatch(row.analysis, /model fair \d/, 'a null composite must NOT be presented as model fair');
  assert.match(row.analysis, /74% vs market 70% = \+4\.4pp/, 'book-ref edge math still rendered');
  // Composite score stays MISSING because the neutral model gave no probability.
  assert.equal(row.composite_score, null);
});

test('present composite fair_value is labeled as model fair', () => {
  const row = mlbPickToDecisionRow(prelineupPick({ fair_value: 0.8504, kalshi_ask: 0.77, edge_pp: 8.04 }));
  assert.match(row.analysis, /model fair 85% vs market 77%/);
  assert.doesNotMatch(row.analysis, /book-ref/);
});
