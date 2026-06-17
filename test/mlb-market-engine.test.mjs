import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeMl, analyzeSpread, analyzeTotal, analyzeTotalCeiling,
  analyzeHr, analyzeKs, analyzeYfri, analyzeGame, findLadderInversion,
  _internal,
} from '../scripts/mlb/lib/market-engine.mjs';
import { DECISION_STATUSES } from '../scripts/shared/decision-process.mjs';

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
    { strike: 3, yesAsk: 25, label: '3+' },
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

test('isStaleRung: yes+no overround > 10¢ flagged stale', () => {
  assert.equal(_internal.isStaleRung(19, 98), true);
  assert.equal(_internal.isStaleRung(50, 52), false);
  assert.equal(_internal.isStaleRung(null, 50), true);
  assert.equal(_internal.isStaleRung(40, null), false);
});

test('Total: monotone ladder → PASS', () => {
  const r = analyzeTotal([
    { ticker: 't1', yes_sub_title: 'Over 6.5 runs', yes_ask_dollars: 0.70, no_ask_dollars: 0.32 },
    { ticker: 't2', yes_sub_title: 'Over 7.5 runs', yes_ask_dollars: 0.55, no_ask_dollars: 0.47 },
    { ticker: 't3', yes_sub_title: 'Over 8.5 runs', yes_ask_dollars: 0.40, no_ask_dollars: 0.62 },
  ]);
  assert.equal(r.decision, 'PASS');
});

test('Total: inverted ladder ≥4¢ → CLEAR', () => {
  const r = analyzeTotal([
    { ticker: 't1', yes_sub_title: 'Over 6.5 runs', yes_ask_dollars: 0.55, no_ask_dollars: 0.47 },
    { ticker: 't2', yes_sub_title: 'Over 7.5 runs', yes_ask_dollars: 0.62, no_ask_dollars: 0.40 },
  ]);
  assert.equal(r.decision, 'CLEAR');
  assert.match(r.reason, /inverted/);
});

test('Total: stale rung does NOT cause fake inversion', () => {
  // 9+ rung is stale (yes 19¢ + no 100¢ = 119¢, overround 19¢).
  // Without stale-drop, this would invert against 8+ (12¢) → CLEAR.
  // With stale-drop, the live ladder is monotone → PASS.
  const r = analyzeTotal([
    { ticker: 't1', yes_sub_title: 'Over 7.5 runs', yes_ask_dollars: 0.21, no_ask_dollars: 0.86 },
    { ticker: 't2', yes_sub_title: 'Over 8.5 runs', yes_ask_dollars: 0.12, no_ask_dollars: 0.94 },
    { ticker: 't3', yes_sub_title: 'Over 9.5 runs', yes_ask_dollars: 0.19, no_ask_dollars: 1.00 },
  ]);
  assert.equal(r.decision, 'PASS');
});

test('Total ceiling: returns highest live rung >= 10¢', () => {
  const r = analyzeTotalCeiling([
    { ticker: 't1', yes_sub_title: 'Over 6.5 runs', yes_ask_dollars: 0.55 },
    { ticker: 't2', yes_sub_title: 'Over 7.5 runs', yes_ask_dollars: 0.30 },
    { ticker: 't3', yes_sub_title: 'Over 8.5 runs', yes_ask_dollars: 0.05 },
  ]);
  assert.equal(r.ceiling.strike, 7.5);
});

// ---- spread bucketing -------------------------------------------------------

test('Spread: stable ticker-suffix bucketing yields CLEAR/LEAN', () => {
  // Two MIL ladder rungs encoded by ticker suffix; no event teams needed.
  const r = analyzeSpread([
    { ticker: 'KXMLBSPREAD-X-MIL', event_ticker: 'KXMLBSPREAD-X',
      yes_sub_title: 'milwaukee wins by over 1.5 runs',
      yes_ask_dollars: 0.40, no_ask_dollars: 0.62 },
    { ticker: 'KXMLBSPREAD-X-MIL', event_ticker: 'KXMLBSPREAD-X',
      yes_sub_title: 'milwaukee wins by over 2.5 runs',
      yes_ask_dollars: 0.45, no_ask_dollars: 0.58 },
  ], { away: 'MIL', home: 'CHC' });
  assert.ok(['LEAN', 'CLEAR'].includes(r.decision));
});

test('Spread: free-text "Phillies" + "Philadelphia" land in SAME bucket via event teams', () => {
  // The W01 false-positive shape: same team, two nickname variants. Old code
  // split them into two buckets; new code resolves both to PHI.
  const markets = [
    { ticker: 's1', yes_sub_title: 'Philadelphia wins by over 2.5 runs', yes_ask_dollars: 0.29, no_ask_dollars: 0.78 },
    { ticker: 's2', yes_sub_title: 'Phillies wins by over 4.5 runs',     yes_ask_dollars: 0.49, no_ask_dollars: 0.99 },
    { ticker: 's3', yes_sub_title: 'Philadelphia wins by over 3.5 runs', yes_ask_dollars: 0.54, no_ask_dollars: 0.81 },
  ];
  const r = analyzeSpread(markets, { away: 'CIN', home: 'PHI' });
  // All three rungs are STALE (no_ask huge), so live ladder is empty → PASS.
  // The key assertion: we did NOT emit CLEAR on a parsing artifact.
  assert.notEqual(r.decision, 'CLEAR');
  assert.notEqual(r.decision, 'LEAN');
});

test('Spread: ambiguous bucket (unknown team in text, no ticker suffix) → WATCH not CLEAR', () => {
  const markets = [
    { ticker: 's1', yes_sub_title: 'Atlantis wins by over 1.5 runs', yes_ask_dollars: 0.30, no_ask_dollars: 0.72 },
    { ticker: 's2', yes_sub_title: 'Atlantis wins by over 2.5 runs', yes_ask_dollars: 0.45, no_ask_dollars: 0.57 },
  ];
  const r = analyzeSpread(markets, { away: 'CIN', home: 'PHI' });
  assert.equal(r.decision, 'WATCH');
  assert.match(r.reason, /ambiguous market grouping/);
});

test('Spread: when one half of a same-team ladder is stale, no fake CLEAR', () => {
  // PHI live: 1.5=47¢. Stale (high overround) rungs at 2.5/3.5 must not
  // generate "inversion".
  const markets = [
    { ticker: 'KXMLBSPREAD-X-PHI', event_ticker: 'KXMLBSPREAD-X',
      yes_sub_title: 'Philadelphia wins by over 1.5 runs', yes_ask_dollars: 0.47, no_ask_dollars: 0.74 },
    { ticker: 'KXMLBSPREAD-X-PHI', event_ticker: 'KXMLBSPREAD-X',
      yes_sub_title: 'Philadelphia wins by over 2.5 runs', yes_ask_dollars: 0.29, no_ask_dollars: 0.78 },
    { ticker: 'KXMLBSPREAD-X-PHI', event_ticker: 'KXMLBSPREAD-X',
      yes_sub_title: 'Philadelphia wins by over 3.5 runs', yes_ask_dollars: 0.54, no_ask_dollars: 0.81 },
  ], r = analyzeSpread(markets, { away: 'CIN', home: 'PHI' });
  // 1.5 and 3.5 rungs: yes+no = 121¢ and 135¢ → stale, dropped.
  // 2.5 alone is also stale (overround 7¢ is ok actually; 29+78=107¢ → 7¢ overround, NOT stale).
  // Live = [2.5@29¢]. Single rung → no inversion → PASS.
  assert.equal(r.decision, 'PASS');
});

// ---- HR ---------------------------------------------------------------------

test('HR: monotone ladder per player → NO CLEAR PICK', () => {
  const r = analyzeHr([
    { ticker: 'KXMLBHR-26MAY-NYYJUDGE-1', title: 'Aaron Judge: 1+ home runs?', floor_strike: 1, yes_ask_dollars: 0.40, no_ask_dollars: 0.62 },
    { ticker: 'KXMLBHR-26MAY-NYYJUDGE-2', title: 'Aaron Judge: 2+ home runs?', floor_strike: 2, yes_ask_dollars: 0.08, no_ask_dollars: 0.94 },
  ], { away: 'NYY', home: 'BOS' });
  assert.equal(r.decision, 'NO CLEAR PICK');
  assert.equal(r.perPlayer.length, 1);
});

test('HR: ambiguous player tokens (no team prefix match) → all dropped → NO CLEAR PICK', () => {
  // Player token "XXJUDGE" doesn't prefix-match NYY or BOS → ambiguous.
  const r = analyzeHr([
    { ticker: 'KXMLBHR-26MAY-XXJUDGE-1', title: 'Aaron Judge: 1+', floor_strike: 1, yes_ask_dollars: 0.20, no_ask_dollars: 0.82 },
    { ticker: 'KXMLBHR-26MAY-XXJUDGE-2', title: 'Aaron Judge: 2+', floor_strike: 2, yes_ask_dollars: 0.40, no_ask_dollars: 0.62 },
  ], { away: 'NYY', home: 'BOS' });
  // No groups formed; ambiguous>0 but no signal to downgrade.
  assert.equal(r.decision, 'NO CLEAR PICK');
});

// ---- K ----------------------------------------------------------------------

test('K props: monotone ladder → WATCH with context-required reason', () => {
  const r = analyzeKs([
    { ticker: 'KXMLBKS-26MAY-LADCOLE-4', title: 'Gerrit Cole: 4.5+ strikeouts?', floor_strike: 4, yes_ask_dollars: 0.72, no_ask_dollars: 0.30 },
    { ticker: 'KXMLBKS-26MAY-LADCOLE-5', title: 'Gerrit Cole: 5.5+ strikeouts?', floor_strike: 5, yes_ask_dollars: 0.55, no_ask_dollars: 0.47 },
    { ticker: 'KXMLBKS-26MAY-LADCOLE-6', title: 'Gerrit Cole: 6.5+ strikeouts?', floor_strike: 6, yes_ask_dollars: 0.35, no_ask_dollars: 0.67 },
  ], 'LAD', { away: 'LAD', home: 'SD' });
  assert.equal(r.decision, 'WATCH');
  assert.match(r.reason, /context|IP|K%/i);
});

test('K props: inverted ladder LEAN cites exact rungs in cents', () => {
  const r = analyzeKs([
    { ticker: 'KXMLBKS-26MAY-LADCOLE-4', title: 'Gerrit Cole: 4.5+ strikeouts?', floor_strike: 4, yes_ask_dollars: 0.50, no_ask_dollars: 0.52 },
    { ticker: 'KXMLBKS-26MAY-LADCOLE-5', title: 'Gerrit Cole: 5.5+ strikeouts?', floor_strike: 5, yes_ask_dollars: 0.53, no_ask_dollars: 0.49 },
  ], 'LAD', { away: 'LAD', home: 'SD' });
  assert.ok(['LEAN', 'CLEAR'].includes(r.decision));
  assert.match(r.reason, /\d+¢/);
});

test('K props: stale tail rung does NOT invent a CLEAR (Cecconi 8+ case)', () => {
  // Reproduces W01 Cecconi: 7+ yes 15¢ / no 91¢ (live); 8+ yes 19¢ / no 98¢ (stale).
  // Old code: 8+ > 7+ by 4¢ → CLEAR. New code drops 8+ as stale → WATCH.
  const r = analyzeKs([
    { ticker: 'KXMLBKS-26MAY-CLECECCONI-5', title: 'Slade Cecconi: 5.5+?', floor_strike: 5, yes_ask_dollars: 0.40, no_ask_dollars: 0.62 },
    { ticker: 'KXMLBKS-26MAY-CLECECCONI-6', title: 'Slade Cecconi: 6.5+?', floor_strike: 6, yes_ask_dollars: 0.27, no_ask_dollars: 0.80 },
    { ticker: 'KXMLBKS-26MAY-CLECECCONI-7', title: 'Slade Cecconi: 7.5+?', floor_strike: 7, yes_ask_dollars: 0.15, no_ask_dollars: 0.91 },
    { ticker: 'KXMLBKS-26MAY-CLECECCONI-8', title: 'Slade Cecconi: 8.5+?', floor_strike: 8, yes_ask_dollars: 0.19, no_ask_dollars: 0.98 },
  ], 'CLE', { away: 'CLE', home: 'DET' });
  assert.equal(r.decision, 'WATCH');
});

test('K props: ambiguous player ticker downgrades CLEAR to WATCH', () => {
  // First two rungs bucketed cleanly to LAD pitcher; third ticker is malformed.
  const r = analyzeKs([
    { ticker: 'KXMLBKS-26MAY-LADCOLE-4', floor_strike: 4, yes_ask_dollars: 0.50, no_ask_dollars: 0.52 },
    { ticker: 'KXMLBKS-26MAY-LADCOLE-5', floor_strike: 5, yes_ask_dollars: 0.56, no_ask_dollars: 0.46 },
    { ticker: 'badticker', floor_strike: 6, yes_ask_dollars: 0.30, no_ask_dollars: 0.72 },
  ], 'LAD', { away: 'LAD', home: 'SD' });
  assert.equal(r.decision, 'WATCH');
  assert.match(r.reason, /ambiguous market grouping/);
});

// ---- YFRI / analyzeGame -----------------------------------------------------

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
  assert.equal(out.final.coverage.mode, 'LIMITED');
  assert.equal(out.final.coverage.families.ml.status, 'BOARD_ANALYZER_ONLY');
  assert.equal(out.final.coverage.families.yfri.status, 'BOARD_ANALYZER_ONLY');
});

test('analyzeGame: ML arb stays board-only without non-market support', () => {
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
  assert.equal(out.final.decision_status, DECISION_STATUSES.MARKET_ONLY_LEAN);
  assert.match(out.final.reason, /board signal only, not evidence, not a pick/i);
  assert.match(out.final.best_angle, /board signal only, not evidence, not a pick/i);
  assert.equal(out.final.coverage.mode, 'LIMITED');
  assert.equal(out.final.coverage.families.ml.status, 'BOARD_ANALYZER_ONLY');
  assert.equal(out.final.coverage.families.spread.status, 'BLOCKED_MODEL_LAYER_MISSING');
  assert.equal(out.final.coverage.families.total.status, 'BLOCKED_MODEL_LAYER_MISSING');
  assert.equal(out.final.coverage.families.yfri.status, 'BLOCKED_MODEL_LAYER_MISSING');
  assert.equal(out.final.coverage.families.ks.status, 'BLOCKED_MODEL_LAYER_MISSING');
  assert.equal(out.final.coverage.families.hr.status, 'BLOCKED_MODEL_LAYER_MISSING');
});

test('analyzeGame: W01 Phillies 25¢ inversion shape no longer emits CLEAR', () => {
  // Same shape as the suspect signal: free-text "Philadelphia" / "Phillies"
  // ladder with stale rungs around the headline number.
  const game = {
    away: 'CIN', home: 'PHI',
    series: {
      ml: { markets: [
        { ticker: 'KXMLBGAME-X-CIN', yes_ask_dollars: 0.47, no_ask_dollars: 0.55 },
        { ticker: 'KXMLBGAME-X-PHI', yes_ask_dollars: 0.55, no_ask_dollars: 0.46 },
      ]},
      spread: { markets: [
        { ticker: 's1', yes_sub_title: 'Phillies wins by over 4.5 runs',     yes_ask_dollars: 0.49, no_ask_dollars: 0.99 },
        { ticker: 's2', yes_sub_title: 'Philadelphia wins by over 3.5 runs', yes_ask_dollars: 0.54, no_ask_dollars: 0.81 },
        { ticker: 's3', yes_sub_title: 'Philadelphia wins by over 2.5 runs', yes_ask_dollars: 0.29, no_ask_dollars: 0.78 },
        { ticker: 's4', yes_sub_title: 'Philadelphia wins by over 1.5 runs', yes_ask_dollars: 0.47, no_ask_dollars: 0.74 },
        { ticker: 's5', yes_sub_title: 'Cincinnati wins by over 1.5 runs',   yes_ask_dollars: 0.64, no_ask_dollars: 0.79 },
      ]},
      total: { markets: [] }, hr: { markets: [] }, ks: { markets: [] }, rfi: { markets: [] },
    },
  };
  const out = analyzeGame(game);
  assert.notEqual(out.sections.spread.decision, 'CLEAR');
  assert.notEqual(out.sections.spread.decision, 'LEAN');
  assert.notEqual(out.final.decision, 'CLEAR');
});

// ---- soft-LEAN tier tests (Phase A v2) -------------------------------------

test('soft-LEAN: ML fair-band + 1.5x OI fav + confirming spread -1.5 → LEAN', () => {
  const game = {
    away: 'MIL', home: 'CHC',
    series: {
      ml: { markets: [
        { ticker: 'KXMLBGAME-X-MIL', yes_ask_dollars: 0.33, no_ask_dollars: 0.69, open_interest_fp: 124000 },
        { ticker: 'KXMLBGAME-X-CHC', yes_ask_dollars: 0.69, no_ask_dollars: 0.33, open_interest_fp: 432000 },
      ]},
      spread: { markets: [
        { ticker: 'KXMLBSPREAD-X-CHC-15', yes_sub_title: 'Cubs wins by over 1.5 runs', yes_ask_dollars: 0.54, no_ask_dollars: 0.50 },
        { ticker: 'KXMLBSPREAD-X-MIL-15', yes_sub_title: 'Brewers wins by over 1.5 runs', yes_ask_dollars: 0.30, no_ask_dollars: 0.75 },
      ]},
      total: { markets: [] }, hr: { markets: [] }, ks: { markets: [] }, rfi: { markets: [] },
    },
  };
  const out = analyzeGame(game);
  assert.equal(out.sections.ml.decision, 'LEAN');
  assert.equal(out.sections.ml.tier, 'soft');
  assert.equal(out.sections.ml.side, 'CHC');
  assert.match(out.sections.ml.reason, /Soft ML LEAN/);
  assert.equal(out.final.decision, 'LEAN');
});

test('soft-LEAN: no forced pick — fair-band fav with weak OI ratio stays PASS', () => {
  const game = {
    away: 'A', home: 'B',
    series: {
      ml: { markets: [
        { ticker: 'KXMLBGAME-X-A', yes_ask_dollars: 0.42, no_ask_dollars: 0.60, open_interest_fp: 50000 },
        { ticker: 'KXMLBGAME-X-B', yes_ask_dollars: 0.59, no_ask_dollars: 0.43, open_interest_fp: 55000 }, // OI ratio ~1.1x
      ]},
      spread: { markets: [] },
      total: { markets: [] }, hr: { markets: [] }, ks: { markets: [] }, rfi: { markets: [] },
    },
  };
  const out = analyzeGame(game);
  assert.equal(out.sections.ml.decision, 'PASS');
  assert.equal(out.final.decision, 'NO CLEAR PICK');
});

test('soft-LEAN: contradicting spread ladder blocks promotion', () => {
  // Favorite by ML but their -1.5 trades very low → market disagrees, no LEAN.
  const game = {
    away: 'CWS', home: 'SEA',
    series: {
      ml: { markets: [
        { ticker: 'KXMLBGAME-X-CWS', yes_ask_dollars: 0.41, no_ask_dollars: 0.60, open_interest_fp: 55000 },
        { ticker: 'KXMLBGAME-X-SEA', yes_ask_dollars: 0.60, no_ask_dollars: 0.42, open_interest_fp: 200000 },
      ]},
      spread: { markets: [
        // SEA -1.5 priced at 15¢ — ladder says fav unlikely to cover, contradicts
        { ticker: 'KXMLBSPREAD-X-SEA-15', yes_sub_title: 'Mariners wins by over 1.5 runs', yes_ask_dollars: 0.15, no_ask_dollars: 0.88 },
      ]},
      total: { markets: [] }, hr: { markets: [] }, ks: { markets: [] }, rfi: { markets: [] },
    },
  };
  const out = analyzeGame(game);
  assert.equal(out.sections.ml.decision, 'PASS');
});

test('soft-LEAN: K props remain WATCH without context even when soft-ML promotes', () => {
  const game = {
    away: 'MIL', home: 'CHC',
    series: {
      ml: { markets: [
        { ticker: 'KXMLBGAME-X-MIL', yes_ask_dollars: 0.33, no_ask_dollars: 0.69, open_interest_fp: 124000 },
        { ticker: 'KXMLBGAME-X-CHC', yes_ask_dollars: 0.69, no_ask_dollars: 0.33, open_interest_fp: 432000 },
      ]},
      spread: { markets: [
        { ticker: 'KXMLBSPREAD-X-CHC-15', yes_sub_title: 'Cubs wins by over 1.5 runs', yes_ask_dollars: 0.54, no_ask_dollars: 0.50 },
      ]},
      total: { markets: [] }, hr: { markets: [] },
      ks: { markets: [
        { ticker: 'KXMLBKS-X-CHCIMANAGA-6', floor_strike: 5.5, yes_ask_dollars: 0.56, no_ask_dollars: 0.46 },
        { ticker: 'KXMLBKS-X-CHCIMANAGA-7', floor_strike: 6.5, yes_ask_dollars: 0.44, no_ask_dollars: 0.58 },
      ]},
      rfi: { markets: [] },
    },
  };
  const out = analyzeGame(game);
  assert.equal(out.sections.ks_home.decision, 'WATCH');
  // Soft ML promotion should still fire alongside.
  assert.equal(out.sections.ml.decision, 'LEAN');
});

test('soft-LEAN: stale ML quotes do not trigger promotion', () => {
  // Fav has yes_ask but partner is null — null asks cannot dev-vig, ML is WATCH,
  // soft-LEAN should not apply.
  const game = {
    away: 'A', home: 'B',
    series: {
      ml: { markets: [
        { ticker: 'KXMLBGAME-X-A', yes_ask_dollars: 0.33, no_ask_dollars: 0.70, open_interest_fp: 100000 },
        { ticker: 'KXMLBGAME-X-B', yes_ask_dollars: null, no_ask_dollars: null, open_interest_fp: 300000 },
      ]},
      spread: { markets: [] },
      total: { markets: [] }, hr: { markets: [] }, ks: { markets: [] }, rfi: { markets: [] },
    },
  };
  const out = analyzeGame(game);
  assert.notEqual(out.sections.ml.decision, 'LEAN');
});

test('soft-LEAN: final game rollup preserves board-only rollup without evidence support', () => {
  const game = {
    away: 'MIL', home: 'CHC',
    series: {
      ml: { markets: [
        { ticker: 'KXMLBGAME-X-MIL', yes_ask_dollars: 0.33, no_ask_dollars: 0.69, open_interest_fp: 124000 },
        { ticker: 'KXMLBGAME-X-CHC', yes_ask_dollars: 0.69, no_ask_dollars: 0.33, open_interest_fp: 432000 },
      ]},
      spread: { markets: [
        { ticker: 'KXMLBSPREAD-X-CHC-15', yes_sub_title: 'Cubs wins by over 1.5 runs', yes_ask_dollars: 0.54, no_ask_dollars: 0.50 },
      ]},
      total: { markets: [] }, hr: { markets: [] }, ks: { markets: [] }, rfi: { markets: [] },
    },
  };
  const out = analyzeGame(game);
  assert.equal(out.final.decision, 'LEAN');
  assert.equal(out.final.decision_status, DECISION_STATUSES.MARKET_ONLY_LEAN);
  assert.match(out.sections.ml.reason, /Soft ML LEAN CHC/);
  assert.match(out.final.best_angle, /board signal only, not evidence, not a pick/i);
  assert.equal(out.final.coverage.families.ml.status, 'BOARD_ANALYZER_ONLY');
  assert.equal(out.final.coverage.families.spread.status, 'BOARD_ANALYZER_ONLY');
});

// ---- Game-pick vs prop-watchlist separation -------------------------------

test('HR ladder inversion does NOT promote game-level CLEAR/LEAN; lands in prop_watchlist', () => {
  // ML/spread/total give no signal; only HR has a "CLEAR"-shape inversion.
  const game = {
    away: 'NYY', home: 'BOS',
    series: {
      ml: { markets: [
        { ticker: 'KXMLBGAME-X-NYY', yes_ask_dollars: 0.50, no_ask_dollars: 0.52 },
        { ticker: 'KXMLBGAME-X-BOS', yes_ask_dollars: 0.50, no_ask_dollars: 0.52 },
      ]},
      spread: { markets: [] },
      total: { markets: [] },
      hr: { markets: [
        // Inverted: 2+ priced ABOVE 1+ — anomaly.
        { ticker: 'KXMLBHR-26MAY-NYYJUDGE-1', title: 'Aaron Judge: 1+ home runs?', floor_strike: 1, yes_ask_dollars: 0.20, no_ask_dollars: 0.82 },
        { ticker: 'KXMLBHR-26MAY-NYYJUDGE-2', title: 'Aaron Judge: 2+ home runs?', floor_strike: 2, yes_ask_dollars: 0.40, no_ask_dollars: 0.62 },
      ]},
      ks: { markets: [] },
      rfi: { markets: [] },
    },
  };
  const out = analyzeGame(game);
  // Game-level final must NOT be CLEAR/LEAN from HR.
  assert.equal(out.final.decision, 'NO CLEAR PICK');
  assert.equal(out.clear_lean_count, 0);
  // But the HR anomaly should appear in the prop watchlist as WATCH (not CLEAR).
  assert.ok(Array.isArray(out.final.prop_watchlist));
  const hrAlerts = out.final.prop_watchlist.filter((a) => a.kind === 'HR');
  assert.ok(hrAlerts.length >= 1, 'expected HR anomaly in prop_watchlist');
  for (const a of hrAlerts) assert.equal(a.decision, 'WATCH');
});
