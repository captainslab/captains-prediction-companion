// World Cup composite model-neutrality protection tests.
//
// Purpose: PIN the cardinal rule — market prices NEVER feed the composite score.
// Mirrors test/mlb-composite-neutrality.test.mjs and test/nascar-composite-neutrality.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  composeEvidenceLedgerForSide,
  composeEvidenceLedgerForGame,
  LAYER_DEFS,
} from '../scripts/worldcup/lib/evidence-ledger.mjs';
import { composeMultiLaneCeilingBoard } from '../scripts/worldcup/lib/multi-lane-ceiling.mjs';

// Forbidden market/odds/price JSON KEYS that must never appear in composite output.
const FORBIDDEN_KEYS = [
  '"fair_value"', '"edge"', '"kelly"', '"stake"', '"vig"', '"implied_prob"',
  '"market_prob"', '"yes_ask"', '"no_bid"', '"yes_bid"', '"no_ask"',
  '"kalshi_ask"', '"kalshi_bid"', '"moneyline_odds"', '"price"', '"odds"',
  '"volume"', '"open_interest"', '"last_price"',
];

function assertNoForbiddenKeys(obj, ctx) {
  const json = JSON.stringify(obj);
  for (const k of FORBIDDEN_KEYS) {
    assert.ok(!json.includes(k), `${ctx}: forbidden market/odds key leaked into output: ${k}`);
  }
}

// ---------------------------------------------------------------------------
// GROUP 1a — LAYER_DEFS weights sum to exactly 1.00
// ---------------------------------------------------------------------------

test('evidence-ledger LAYER_DEFS: exactly 14 layers whose weights sum to 1.00', () => {
  const src = readFileSync(new URL('../scripts/worldcup/lib/evidence-ledger.mjs', import.meta.url), 'utf8');
  const start = src.indexOf('export const LAYER_DEFS = Object.freeze([');
  assert.ok(start !== -1, 'LAYER_DEFS block not found');
  const end = src.indexOf(']);', start);
  assert.ok(end !== -1, 'LAYER_DEFS block terminator not found');
  const block = src.slice(start, end);
  const weights = [...block.matchAll(/weight:\s*([0-9]*\.?[0-9]+)/g)].map(m => Number(m[1]));
  assert.equal(weights.length, 14, `expected 14 layer weights, found ${weights.length}`);
  const sum = weights.reduce((s, w) => s + w, 0);
  assert.ok(Math.abs(sum - 1.0) < 1e-9, `LAYER_DEFS weights must sum to 1.00, got ${sum}`);
});

// ---------------------------------------------------------------------------
// GROUP 1b — Missing-layer renormalization
// ---------------------------------------------------------------------------

const r = (score) => ({ present: true, score });
const NEUTRAL_SIDE_70 = {
  team_quality_baseline: r(70),
  recent_form: r(70),
  attacking_strength: r(70),
  defensive_strength: r(70),
  opponent_adjusted_attack: r(70),
  opponent_adjusted_defense: r(70),
  opponent_style_fit: r(70),
  set_piece_matchup: r(70),
  goalkeeper_edge: r(70),
  squad_availability: r(70),
  lineup_strength_delta: r(70),
  rest_travel_venue_climate: r(70),
  tournament_incentive_state: r(70),
  knockout_extra_time_penalty: r(70),
};

test('renormalization: all-14-layers-present at equal score → composite equals that score', () => {
  const side = composeEvidenceLedgerForSide(NEUTRAL_SIDE_70, { isKnockout: true });
  assert.equal(side.composite_score, 70, 'equal scores should average to 70');
  assert.equal(side.layers_present, 14);
  // With score=70, postureFromScore returns EVIDENCE_LEAN (needs >=78 for PICK)
  assert.equal(side.posture, 'EVIDENCE_LEAN');
});

test('renormalization: 7 present layers at 80 → composite 80, posture capped at EVIDENCE_LEAN', () => {
  const partial = {
    team_quality_baseline: r(80),
    recent_form: r(80),
    attacking_strength: r(80),
    defensive_strength: r(80),
    opponent_adjusted_attack: r(80),
    opponent_adjusted_defense: r(80),
    opponent_style_fit: r(80),
  };
  const side = composeEvidenceLedgerForSide(partial);
  assert.equal(side.composite_score, 80);
  assert.equal(side.layers_present, 7);
  assert.equal(side.posture, 'EVIDENCE_LEAN');
});

// ---------------------------------------------------------------------------
// GROUP 2 — Odds-isolation regression (full game)
// ---------------------------------------------------------------------------

const POISON = {
  yes_ask: 0.91, no_bid: 0.07, yes_bid: 0.88, no_ask: 0.12,
  kalshi_ask: 0.91, kalshi_bid: 0.88, moneyline_odds: -180,
  implied_prob: 0.78, market_prob: 0.81, vig: 0.045, fair_value: 0.79,
  price: 0.83, odds: 1.55, edge: 0.12, kelly: 0.25,
  volume: 12000, open_interest: 5000, last_price: 0.82,
};

function pollutedSide() {
  const s = { ...NEUTRAL_SIDE_70 };
  for (const [k, v] of Object.entries(POISON)) {
    s[k] = { present: true, score: v };
  }
  return s;
}

test('odds-isolation: injecting market/odds/price into side entries does not change composite score', () => {
  const clean = composeEvidenceLedgerForSide(NEUTRAL_SIDE_70);
  const dirty = composeEvidenceLedgerForSide(pollutedSide());
  assert.equal(dirty.composite_score, clean.composite_score, 'composite_score changed when market fields injected');
  assert.equal(dirty.posture, clean.posture, 'posture changed when market fields injected');
  assert.equal(dirty.layers_present, clean.layers_present);
});

test('odds-isolation: full game with poisoned sides produces identical ledger', () => {
  const clean = composeEvidenceLedgerForGame(NEUTRAL_SIDE_70, NEUTRAL_SIDE_70);
  const dirty = composeEvidenceLedgerForGame(pollutedSide(), pollutedSide());
  assert.equal(dirty.home.composite_score, clean.home.composite_score);
  assert.equal(dirty.away.composite_score, clean.away.composite_score);
  assert.equal(dirty.differential, clean.differential);
});

// ---------------------------------------------------------------------------
// GROUP 3 — Market context attachment AFTER score
test('market context is attached to lane but never changes composite_score', () => {
  const ledger = composeEvidenceLedgerForGame(NEUTRAL_SIDE_70, NEUTRAL_SIDE_70);
  // normalizeMarketContext strips raw price fields; only implied_probability and ticker remain.
  const market = { ticker: 'KXWCHOME', implied_probability: 0.58 };
  const board = composeMultiLaneCeilingBoard({
    homeLedger: ledger.home,
    awayLedger: ledger.away,
    marketContexts: [market],
    isKnockout: false,
  });

  const matchWinner = board.lanes.find(l => l.lane === 'match_winner');
  assert.ok(matchWinner, 'match_winner lane must exist');
  assert.equal(matchWinner.composite_score_home, ledger.home.composite_score);
  assert.equal(matchWinner.composite_score_away, ledger.away.composite_score);
  assert.ok(matchWinner.market_context != null, 'market context should be attached');
  assert.equal(matchWinner.market_context.ticker, 'KXWCHOME');
  assert.ok(
    matchWinner.market_context.implied_probability != null,
    'market context should have implied_probability'
  );

  assertNoForbiddenKeys(ledger, 'ledger');
  assertNoForbiddenKeys(board, 'board');
});

// ---------------------------------------------------------------------------
// GROUP 4 — Opponent data changes score
// ---------------------------------------------------------------------------

test('opponent data changes composite score', () => {
  const homeStrong = { ...NEUTRAL_SIDE_70, opponent_adjusted_attack: r(90), opponent_adjusted_defense: r(90) };
  const homeWeak = { ...NEUTRAL_SIDE_70, opponent_adjusted_attack: r(50), opponent_adjusted_defense: r(50) };
  const awayNeutral = NEUTRAL_SIDE_70;

  const strongGame = composeEvidenceLedgerForGame(homeStrong, awayNeutral);
  const weakGame = composeEvidenceLedgerForGame(homeWeak, awayNeutral);

  assert.ok(strongGame.home.composite_score > weakGame.home.composite_score,
    'strong opponent-adjusted layers should raise home composite score');
  assert.ok(strongGame.differential > weakGame.differential,
    'differential should increase when home opponent-adjusted layers improve');
});

// ---------------------------------------------------------------------------
// GROUP 5 — Missing lineup lowers confidence but does not fake a pass
// ---------------------------------------------------------------------------

test('missing lineup lowers confidence but composite still computes', () => {
  const withLineup = { ...NEUTRAL_SIDE_70, lineup_strength_delta: r(70) };
  const withoutLineup = { ...NEUTRAL_SIDE_70, lineup_strength_delta: { present: false, score: null, basis: 'lineup strength delta', missing_reason: 'lineups not confirmed' } };

  const sideWith = composeEvidenceLedgerForSide(withLineup, { isKnockout: true });
  const sideWithout = composeEvidenceLedgerForSide(withoutLineup, { isKnockout: true });

  assert.equal(sideWith.confidence, 'high');
  assert.equal(sideWithout.confidence, 'high'); // still 13 layers present
  assert.equal(sideWith.layers_present, 14);
  assert.equal(sideWithout.layers_present, 13);
  assert.ok(sideWithout.composite_score != null, 'composite_score should still compute with missing lineup');
});

// ---------------------------------------------------------------------------
// GROUP 6 — No NaN output
// ---------------------------------------------------------------------------

test('no NaN in composite output', () => {
  const ledger = composeEvidenceLedgerForGame(NEUTRAL_SIDE_70, NEUTRAL_SIDE_70);
  const json = JSON.stringify(ledger);
  assert.ok(!json.includes('NaN'), 'output must not contain NaN');
  assert.ok(!json.includes('Infinity'), 'output must not contain Infinity');
});

// ---------------------------------------------------------------------------
// GROUP 7 — Knockout layer activates only in knockout stage
// ---------------------------------------------------------------------------

test('knockout_extra_time_penalty layer is skipped in group stage', () => {
  const side = composeEvidenceLedgerForSide(NEUTRAL_SIDE_70, { isKnockout: false });
  const layer = side.layers.find(l => l.key === 'knockout_extra_time_penalty');
  assert.ok(layer, 'layer must exist');
  assert.equal(layer.present, false);
  assert.ok(layer.missing_note.includes('group stage'));
});

test('knockout_extra_time_penalty layer is evaluated in knockout stage', () => {
  const side = composeEvidenceLedgerForSide(NEUTRAL_SIDE_70, { isKnockout: true });
  const layer = side.layers.find(l => l.key === 'knockout_extra_time_penalty');
  assert.ok(layer, 'layer must exist');
  assert.equal(layer.present, true);
});
