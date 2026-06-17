// Proves the MLB daily packet emits PROJECTION-FIRST language (model-layer
// vocabulary) and never leaks an over/under call or price-derived posture into
// that read. Drives the exported buildProjectionFirstBlock helper directly so
// the assertions are deterministic and offline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProjectionFirstBlock } from '../scripts/packets/generate-mlb-daily.mjs';

const DATE = '2026-06-17';

// A pre-lineup pick like the ones in state/mlb/<date>/picks.json.
const prelinePicks = [
  {
    event_ticker: 'KXMLBTOTAL-26JUN171410DETHOU',
    matched_game_pk: 824178,
    game: 'Detroit Tigers at Houston Astros',
    classification: 'CORRELATED_ALTERNATE',
    contract_title: 'Over 5.5 runs scored',
    kalshi_ask: 0.76,
    market_reference_prob: 0.8504,
    edge_pp: 9.04,
    missing_confirmations: ['lineup_pending', 'roof_state_unknown', 'bullpen_unknown'],
  },
];

test('projection block carries projected runs / YRFI / Ks / HR vocabulary', () => {
  const block = buildProjectionFirstBlock({ date: DATE, gamePicks: prelinePicks });
  const text = block.join('\n');

  assert.match(text, /PROJECTION-FIRST READ/);
  assert.match(text, /Projected runs|run-scoring distribution|Total runs/);
  assert.match(text, /YRFI/, 'first-inning-run (YRFI) language present');
  assert.match(text, /Strikeouts/, 'strikeout-count language present');
  assert.match(text, /HR risk|home run/, 'home-run language present');
  assert.match(text, /Win probability|win probability/, 'derived win-prob language present');
});

test('no over/under "take" call and no price-derived posture leaks', () => {
  const text = buildProjectionFirstBlock({ date: DATE, gamePicks: prelinePicks }).join('\n');
  assert.doesNotMatch(text, /take the over|take the under|take over|take under|hammer the|bet the/i);
  assert.doesNotMatch(text, /buy yes|sell no|enter at|target entry|stake|bankroll|units?\b/i);
});

test('no market price / odds / board terms appear in the projection read', () => {
  const text = buildProjectionFirstBlock({ date: DATE, gamePicks: prelinePicks }).join('\n');
  // Price-isolation invariant: the model-layer read renders no market signal.
  assert.doesNotMatch(text, /\bprice\b|\bodds\b|\bbid\b|\bask\b|kalshi_ask|implied[_ ]?prob|open[_ ]?interest|\bvolume\b|moneyline odds|board shape/i);
});

test('missing model outputs are stated honestly, never fabricated', () => {
  const text = buildProjectionFirstBlock({ date: DATE, gamePicks: prelinePicks }).join('\n');
  // With no model outputs supplied the read must say so (blocked/not modeled),
  // not invent a number.
  assert.match(text, /BLOCKED_MODEL_LAYER_MISSING|not modeled/);
});

test('confirmed lineup removes the "lineup unconfirmed" provisional tag', () => {
  const confirmed = [{ ...prelinePicks[0], missing_confirmations: [] }];
  const text = buildProjectionFirstBlock({ date: DATE, gamePicks: confirmed }).join('\n');
  assert.doesNotMatch(text, /lineup unconfirmed/);
});

test('team names are parsed from the pick game string, not invented', () => {
  const text = buildProjectionFirstBlock({ date: DATE, gamePicks: prelinePicks }).join('\n');
  assert.match(text, /Houston Astros/);
  assert.match(text, /Detroit Tigers/);
});

test('empty slate still renders a market-free projection-first block', () => {
  const block = buildProjectionFirstBlock({ date: DATE, gamePicks: [] });
  const text = block.join('\n');
  assert.match(text, /PROJECTION-FIRST READ/);
  assert.doesNotMatch(text, /\bprice\b|\bodds\b|\bask\b/i);
});
