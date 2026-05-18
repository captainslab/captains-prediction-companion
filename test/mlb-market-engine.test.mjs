import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeMl, analyzeSpread, analyzeTotal, analyzeTotalCeiling,
  analyzeHr, analyzeKs, analyzeYfri, analyzeGame, findLadderInversion,
} from '../scripts/mlb/lib/market-engine.mjs';

const m = (overrides = {}) => ({
  ticker: 'X-Y', yes_ask_dollars: 0.5, no_ask_dollars: 0.5,
  yes_bid_dollars: 0.48, no_bid_dollars: 0.48, ...overrides,
});

test('ML: cross-side arb flags CLEAR', () => {
  const r = analyzeMl([
    m({ ticker: 'KX-A', yes_ask_dollars: 0.40 }),
    m({ ticker: 'KX-B', yes_ask_dollars: 0.50 }),
  ]);
  assert.equal(r.decision, 'CLEAR');
  assert.match(r.reason, /arb/i);
});

test('ML: favorite priced higher than 50¢ is NOT a LEAN/CLEAR', () => {
  const r = analyzeMl([
    m({ ticker: 'KX-A', yes_ask_dollars: 0.65, yes_bid_dollars: 0.63 }),
    m({ ticker: 'KX-B', yes_ask_dollars: 0.40, yes_bid_dollars: 0.38 }),
  ]);
  assert.equal(r.decision, 'PASS');
});

test('ML: only one side posted → WATCH', () => {
  const r = analyzeMl([m()]);
  assert.equal(r.decision, 'WATCH');
});

test('ML: missing entirely → NO CLEAR PICK', () => {
  const r = analyzeMl([]);
  assert.equal(r.decision, 'NO CLEAR PICK');
});

test('Ladder inversion: detects worst delta', () => {
  const inv = findLadderInversion([
    { strike: 1, yesAsk: 30, label: '1+' },
    { strike: 2, yesAsk: 20, label: '2+' },
    { strike: 3, yesAsk: 25, label: '3+' }, // inverted vs 2+ by 5¢
  ]);
  assert.ok(inv);
  assert.equal(inv.delta, 5);
  assert.equal(inv.hi.strike, 3);
});

test('Ladder: noise <=1¢ is ignored', () => {
  const inv = findLadderInversion([
    { strike: 1, yesAsk: 30 }, { strike: 2, yesAsk: 31 },
  ]);
  assert.equal(inv, null);
});

test('Total: monotone ladder → PASS', () => {
  const r = analyzeTotal([
    { ticker: 't1', yes_sub_title: 'Over 6.5 runs', yes_ask_dollars: 0.70 },
    { ticker: 't2', yes_sub_title: 'Over 7.5 runs', yes_ask_dollars: 0.55 },
    { ticker: 't3', yes_sub_title: 'Over 8.5 runs', yes_ask_dollars: 0.40 },
  ]);
  assert.equal(r.decision, 'PASS');
});

test('Total: inverted ladder ≥4¢ → CLEAR', () => {
  const r = analyzeTotal([
    { ticker: 't1', yes_sub_title: 'Over 6.5 runs', yes_ask_dollars: 0.55 },
    { ticker: 't2', yes_sub_title: 'Over 7.5 runs', yes_ask_dollars: 0.62 },
  ]);
  assert.equal(r.decision, 'CLEAR');
  assert.match(r.reason, /inverted/);
});

test('Total ceiling: returns highest live rung >= 10¢', () => {
  const r = analyzeTotalCeiling([
    { ticker: 't1', yes_sub_title: 'Over 6.5 runs', yes_ask_dollars: 0.55 },
    { ticker: 't2', yes_sub_title: 'Over 7.5 runs', yes_ask_dollars: 0.30 },
    { ticker: 't3', yes_sub_title: 'Over 8.5 runs', yes_ask_dollars: 0.05 },
  ]);
  assert.equal(r.ceiling.strike, 7.5);
});

test('Spread: inverted ladder → LEAN', () => {
  const r = analyzeSpread([
    { ticker: 's1', yes_sub_title: 'milwaukee wins by over 1.5 runs', yes_ask_dollars: 0.40 },
    { ticker: 's2', yes_sub_title: 'milwaukee wins by over 2.5 runs', yes_ask_dollars: 0.43 },
  ]);
  assert.ok(['LEAN', 'CLEAR'].includes(r.decision));
});

test('HR: monotone ladder per player → NO CLEAR PICK', () => {
  const r = analyzeHr([
    { ticker: 'KXMLBHR-X-NYYJUDGE-1', title: 'Aaron Judge: 1+ home runs?', floor_strike: 1, yes_ask_dollars: 0.40 },
    { ticker: 'KXMLBHR-X-NYYJUDGE-2', title: 'Aaron Judge: 2+ home runs?', floor_strike: 2, yes_ask_dollars: 0.08 },
  ]);
  assert.equal(r.decision, 'NO CLEAR PICK');
  assert.equal(r.perPlayer.length, 1);
});

test('K props: monotone ladder → WATCH with context-required reason', () => {
  const r = analyzeKs([
    { ticker: 'KXMLBKS-X-LADCOLE-4', title: 'Gerrit Cole: 4.5+ strikeouts?', floor_strike: 4, yes_ask_dollars: 0.72 },
    { ticker: 'KXMLBKS-X-LADCOLE-5', title: 'Gerrit Cole: 5.5+ strikeouts?', floor_strike: 5, yes_ask_dollars: 0.55 },
    { ticker: 'KXMLBKS-X-LADCOLE-6', title: 'Gerrit Cole: 6.5+ strikeouts?', floor_strike: 6, yes_ask_dollars: 0.35 },
  ], 'LAD');
  assert.equal(r.decision, 'WATCH');
  assert.match(r.reason, /context|IP|K%/i);
});

test('K props: inverted ladder LEAN cites exact rungs in cents', () => {
  const r = analyzeKs([
    { ticker: 'KXMLBKS-X-LADCOLE-4', title: 'Gerrit Cole: 4.5+ strikeouts?', floor_strike: 4, yes_ask_dollars: 0.50 },
    { ticker: 'KXMLBKS-X-LADCOLE-5', title: 'Gerrit Cole: 5.5+ strikeouts?', floor_strike: 5, yes_ask_dollars: 0.53 },
  ], 'LAD');
  assert.ok(['LEAN', 'CLEAR'].includes(r.decision));
  assert.match(r.reason, /\d+¢/);
});

test('YFRI: incomplete quotes → WATCH; complete fair → PASS', () => {
  const w = analyzeYfri([{ ticker: 'rfi-1', yes_ask_dollars: 0.5, no_ask_dollars: null }]);
  assert.equal(w.decision, 'WATCH');
  const p = analyzeYfri([{ ticker: 'rfi-1', yes_ask_dollars: 0.52, no_ask_dollars: 0.52 }]);
  assert.equal(p.decision, 'PASS');
  const c = analyzeYfri([{ ticker: 'rfi-1', yes_ask_dollars: 0.40, no_ask_dollars: 0.40 }]);
  assert.equal(c.decision, 'CLEAR');
});

test('analyzeGame: no clear/lean across all sections → final NO CLEAR PICK', () => {
  const game = {
    away: 'SF', home: 'AZ',
    series: {
      ml: { markets: [
        m({ ticker: 'KXMLBGAME-X-SF', yes_ask_dollars: 0.55 }),
        m({ ticker: 'KXMLBGAME-X-AZ', yes_ask_dollars: 0.50 }),
      ]},
      spread: { markets: [] },
      total: { markets: [] },
      hr: { markets: [] },
      ks: { markets: [] },
      rfi: { markets: [{ ticker: 'r', yes_ask_dollars: 0.52, no_ask_dollars: 0.52 }] },
    },
  };
  const out = analyzeGame(game);
  assert.equal(out.final.decision, 'NO CLEAR PICK');
  assert.equal(out.clear_lean_count, 0);
});

test('analyzeGame: ML arb makes final CLEAR and best_angle includes evidence', () => {
  const game = {
    away: 'SF', home: 'AZ',
    series: {
      ml: { markets: [
        m({ ticker: 'KXMLBGAME-X-SF', yes_ask_dollars: 0.40 }),
        m({ ticker: 'KXMLBGAME-X-AZ', yes_ask_dollars: 0.50 }),
      ]},
      spread: { markets: [] }, total: { markets: [] }, hr: { markets: [] },
      ks: { markets: [] }, rfi: { markets: [] },
    },
  };
  const out = analyzeGame(game);
  assert.equal(out.final.decision, 'CLEAR');
  assert.match(out.final.best_angle, /arb/i);
});
