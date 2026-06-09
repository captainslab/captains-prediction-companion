// World Cup draw-model + probability-neutrality tests.
//
// Pins the draw doctrine: Draw is a valid read but requires explicit supports
// (narrow gap AND low goal environment AND a secondary support). Close team
// strength alone → WATCH_ONLY. Missing layers → BLOCKED, not defaulted.
// Probabilities are market-free by construction.

import test from 'node:test';
import assert from 'node:assert/strict';

import { composeEvidenceLedgerForSide, composeEvidenceLedgerForGame } from '../scripts/worldcup/lib/evidence-ledger.mjs';
import { computeMatchProbabilities, goalEnvironmentProxy } from '../scripts/worldcup/lib/match-probabilities.mjs';
import { composeMultiLaneCeilingBoard } from '../scripts/worldcup/lib/multi-lane-ceiling.mjs';

const r = (score) => ({ present: true, score });

function side({ base = 70, atk = base, def = base } = {}) {
  return {
    team_quality_baseline: r(base), recent_form: r(base),
    attacking_strength: r(atk), defensive_strength: r(def),
    opponent_adjusted_attack: r(base), opponent_adjusted_defense: r(base),
    opponent_style_fit: r(base), set_piece_matchup: r(base), goalkeeper_edge: r(base),
    squad_availability: r(base), lineup_strength_delta: r(base),
    rest_travel_venue_climate: r(base), tournament_incentive_state: r(base),
    knockout_extra_time_penalty: r(base),
  };
}

function probsFor(homeSide, awaySide, opts = {}) {
  const ledger = composeEvidenceLedgerForGame(homeSide, awaySide);
  return computeMatchProbabilities({ homeLedger: ledger.home, awayLedger: ledger.away, ...opts });
}

// ---------------------------------------------------------------------------
// Probabilities are well-formed
// ---------------------------------------------------------------------------

test('1X2 probabilities sum to 1 and expose draw risk separately from winner lean', () => {
  const p = probsFor(side({ base: 75 }), side({ base: 62 }));
  assert.ok(p.ok);
  assert.ok(Math.abs(p.p_home + p.p_draw + p.p_away - 1) < 1e-6, 'probabilities must sum to 1');
  assert.equal(p.winner_lean, 'home');
  assert.ok(['LOW', 'MEDIUM', 'HIGH'].includes(p.draw_risk), 'draw risk is its own field');
  assert.ok(p.p_home > p.p_away, 'stronger side carries higher win probability');
});

// ---------------------------------------------------------------------------
// Draw requires explicit supports
// ---------------------------------------------------------------------------

test('draw is ACTIONABLE when narrow gap + low goal environment + defensive matchup exist', () => {
  // Two defensive, evenly-matched sides: attacks 55, defenses 80.
  const p = probsFor(side({ base: 70, atk: 55, def: 80 }), side({ base: 70, atk: 55, def: 80 }));
  assert.ok(p.ok);
  assert.equal(p.draw_evaluation, 'ACTIONABLE');
  assert.equal(p.draw_risk, 'HIGH');
  assert.ok(p.draw_rationale.some(s => s.includes('low — supports draw')), p.draw_rationale.join(' | '));
  assert.ok(p.draw_rationale.some(s => s.includes('defensive/style matchup')));
});

test('close team strength ALONE does not force Draw — attacking even matchup stays WATCH_ONLY', () => {
  // Evenly matched but attack-heavy: attacks 80, defenses 55 → high goal environment.
  const p = probsFor(side({ base: 70, atk: 80, def: 55 }), side({ base: 70, atk: 80, def: 55 }));
  assert.ok(p.ok);
  assert.equal(p.draw_evaluation, 'WATCH_ONLY', 'narrow gap without low-xG support must not be an actionable draw');
  assert.ok(p.draw_rationale.some(s => s.includes('close strength alone is NOT a draw read')));
});

test('board recommendation: LEAN_DRAW only under the support gate, WATCH otherwise', () => {
  const drawy = composeEvidenceLedgerForGame(side({ base: 70, atk: 55, def: 80 }), side({ base: 70, atk: 55, def: 80 }));
  const drawBoard = composeMultiLaneCeilingBoard({ homeLedger: drawy.home, awayLedger: drawy.away, lineupConfirmed: true });
  assert.equal(drawBoard.lanes.find(l => l.lane === 'match_winner').recommendation, 'LEAN_DRAW');

  const attacking = composeEvidenceLedgerForGame(side({ base: 70, atk: 80, def: 55 }), side({ base: 70, atk: 80, def: 55 }));
  const watchBoard = composeMultiLaneCeilingBoard({ homeLedger: attacking.home, awayLedger: attacking.away, lineupConfirmed: true });
  const lane = watchBoard.lanes.find(l => l.lane === 'match_winner');
  assert.equal(lane.recommendation, 'WATCH', 'close attacking matchup is WATCH, not Draw');
  assert.ok(lane.explanation.includes('draw risk'), 'draw risk still surfaced on the WATCH row');
});

test('draw incentive counts as a secondary support', () => {
  // Narrow gap + low xG but NO defensive matchup (defense == attack at low scores).
  const balanced = side({ base: 70, atk: 50, def: 50 });
  const withoutIncentive = probsFor(balanced, balanced);
  const withIncentive = probsFor(balanced, balanced, { drawIncentive: true });
  // defensiveMatchup is true when def >= atk; make defense strictly below attack:
  const atkSide = side({ base: 70, atk: 52, def: 50 });
  const noSupport = probsFor(atkSide, atkSide);
  const incentive = probsFor(atkSide, atkSide, { drawIncentive: true });
  assert.equal(noSupport.draw_evaluation, 'WATCH_ONLY');
  assert.equal(incentive.draw_evaluation, 'ACTIONABLE');
  assert.ok(withIncentive.p_draw > withoutIncentive.p_draw, 'incentive raises draw probability');
});

test('missing attack/defense layers → draw evaluation BLOCKED_MODEL_LAYER_MISSING, not defaulted', () => {
  const thin = { team_quality_baseline: r(70), opponent_adjusted_attack: r(70), opponent_adjusted_defense: r(70), squad_availability: r(70) };
  const ledger = composeEvidenceLedgerForGame(thin, thin);
  assert.equal(goalEnvironmentProxy(ledger.home, ledger.away), null, 'no proxy without layers');
  const p = computeMatchProbabilities({ homeLedger: ledger.home, awayLedger: ledger.away });
  assert.equal(p.draw_evaluation, 'BLOCKED_MODEL_LAYER_MISSING');
});

// ---------------------------------------------------------------------------
// Neutrality — market fields cannot move probabilities; edge is post-model
// ---------------------------------------------------------------------------

const POISON = {
  yes_ask: 0.91, no_bid: 0.07, yes_bid: 0.88, no_ask: 0.12,
  kalshi_ask: 0.91, kalshi_bid: 0.88, moneyline_odds: -180,
  implied_prob: 0.78, market_prob: 0.81, vig: 0.045, fair_value: 0.79,
  price: 0.83, odds: 1.55, edge: 0.12, kelly: 0.25,
  volume: 12000, open_interest: 5000, last_price: 0.82,
};

test('injecting market fields into side entries does not change 1X2 probabilities', () => {
  const clean = side({ base: 72 });
  const dirty = { ...side({ base: 72 }) };
  for (const [k, v] of Object.entries(POISON)) dirty[k] = { present: true, score: v };

  const pClean = probsFor(clean, side({ base: 64 }));
  const pDirty = probsFor(dirty, side({ base: 64 }));
  assert.equal(pDirty.p_home, pClean.p_home);
  assert.equal(pDirty.p_draw, pClean.p_draw);
  assert.equal(pDirty.p_away, pClean.p_away);
  assert.equal(pDirty.draw_evaluation, pClean.draw_evaluation);
});

test('changing market PRICE changes edge but never composite or probabilities', () => {
  const ledger = composeEvidenceLedgerForGame(side({ base: 75 }), side({ base: 62 }));
  const mk = (imp) => [{ ticker: 'KX1X2', market_type: 'match_winner', side: 'home', implied_probability: imp }];

  const cheap = composeMultiLaneCeilingBoard({ homeLedger: ledger.home, awayLedger: ledger.away, marketContexts: mk(0.40), lineupConfirmed: true });
  const rich = composeMultiLaneCeilingBoard({ homeLedger: ledger.home, awayLedger: ledger.away, marketContexts: mk(0.80), lineupConfirmed: true });

  assert.equal(cheap.composite_score_home, rich.composite_score_home, 'composite unmoved by price');
  assert.equal(cheap.probabilities.p_home, rich.probabilities.p_home, 'probabilities unmoved by price');
  const cheapLane = cheap.lanes.find(l => l.lane === 'match_winner');
  const richLane = rich.lanes.find(l => l.lane === 'match_winner');
  assert.notEqual(cheapLane.edge_home_pp, richLane.edge_home_pp, 'edge is the only thing price moves');
  assert.ok(cheapLane.edge_home_pp > richLane.edge_home_pp, 'cheaper price → bigger positive edge');
});

test('edge for the Draw side exists only against the model draw probability', () => {
  const ledger = composeEvidenceLedgerForGame(side({ base: 70 }), side({ base: 68 }));
  const board = composeMultiLaneCeilingBoard({
    homeLedger: ledger.home,
    awayLedger: ledger.away,
    marketContexts: [{ ticker: 'KXDRAW', market_type: 'match_winner', side: 'draw', implied_probability: 0.20 }],
    lineupConfirmed: true,
  });
  const lane = board.lanes.find(l => l.lane === 'match_winner');
  assert.ok(lane.edge_draw_pp != null, 'draw edge computed');
  assert.ok(Math.abs(lane.edge_draw_pp - (board.probabilities.p_draw - 0.20) * 100) < 0.11,
    'draw edge = model p_draw − implied');
  assert.equal(lane.edge_home_pp, null, 'no home edge fabricated from a draw contract');
});
