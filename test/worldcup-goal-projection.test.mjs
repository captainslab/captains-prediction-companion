// World Cup goal-projection + Poisson score-grid tests.
//
// Pins the projection contract:
//   - neutral 50/50 teams project near the documented group-stage baseline (~2.6)
//   - attack/defense ratings move projected goals in the right direction
//   - the Poisson grid is a proper (normalized) distribution
//   - Total / BTTS / Spread / 1X2 cross-check are derived from the grid only
//   - missing layers BLOCK (never fabricated)
//   - no market price/line can change the projection

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BASELINE_TOTAL_GOALS,
  projectTeamGoals,
  buildScoreGrid,
  totalGoalsFromGrid,
  bttsFromGrid,
  spreadCoverFromGrid,
  poisson1x2FromGrid,
  crossCheck1x2,
  projectGoalLanes,
} from '../scripts/worldcup/lib/goal-projection.mjs';

// Minimal ledger carrying only the layers the projection reads.
function ledger({ attack, defense, extra = {} } = {}) {
  return {
    ...extra,
    layers: [
      { key: 'attacking_strength', present: attack != null, score: attack ?? null },
      { key: 'defensive_strength', present: defense != null, score: defense ?? null },
    ],
  };
}

const NEUTRAL = ledger({ attack: 50, defense: 50 });

function gridFor(homeLedger, awayLedger) {
  const p = projectTeamGoals({ homeLedger, awayLedger });
  const g = buildScoreGrid({ lambdaHome: p.lambda_home, lambdaAway: p.lambda_away });
  return { p, grid: g.grid, sum_raw: g.sum_raw };
}

test('neutral 50/50 teams project near the documented baseline (~2.6 total)', () => {
  const p = projectTeamGoals({ homeLedger: NEUTRAL, awayLedger: NEUTRAL });
  assert.equal(p.projection_status, 'PROJECTED');
  assert.ok(Math.abs(p.projected_total_goals - BASELINE_TOTAL_GOALS) < 0.05,
    `total ${p.projected_total_goals} should be ~${BASELINE_TOTAL_GOALS}`);
  assert.ok(Math.abs(p.projected_home_goals - p.projected_away_goals) < 0.01, 'neutral fixture is symmetric');
  assert.equal(p.projected_goal_margin_home, 0);
});

test('higher attack rating increases projected goals for that side and the total', () => {
  const base = projectTeamGoals({ homeLedger: NEUTRAL, awayLedger: NEUTRAL });
  const strong = projectTeamGoals({ homeLedger: ledger({ attack: 80, defense: 50 }), awayLedger: NEUTRAL });
  assert.ok(strong.projected_home_goals > base.projected_home_goals, 'home goals rise with attack');
  assert.ok(strong.projected_total_goals > base.projected_total_goals, 'total rises with attack');
});

test('stronger opposing defense decreases projected goals', () => {
  const base = projectTeamGoals({ homeLedger: NEUTRAL, awayLedger: NEUTRAL });
  const vsWall = projectTeamGoals({ homeLedger: NEUTRAL, awayLedger: ledger({ attack: 50, defense: 85 }) });
  assert.ok(vsWall.projected_home_goals < base.projected_home_goals, 'home goals fall vs a stronger defense');
});

test('missing attack/defense layers => BLOCKED_MODEL_LAYER_MISSING (never fabricated)', () => {
  const p = projectTeamGoals({ homeLedger: ledger({ attack: null, defense: 50 }), awayLedger: NEUTRAL });
  assert.equal(p.projection_status, 'BLOCKED_MODEL_LAYER_MISSING');
  assert.equal(p.projected_total_goals, null);
  assert.equal(p.projected_home_goals, null);
});

test('Poisson grid is a normalized distribution (sums to ~1.0)', () => {
  const { grid } = gridFor(NEUTRAL, NEUTRAL);
  let sum = 0;
  for (const row of grid) for (const c of row) sum += c;
  assert.ok(Math.abs(sum - 1) < 1e-9, `grid sum ${sum} must be ~1.0`);
  // Pre-normalization mass for these means should already be very close to 1.
  const { sum_raw } = gridFor(NEUTRAL, NEUTRAL);
  assert.ok(sum_raw > 0.999, `raw mass ${sum_raw} should be near 1 before normalization`);
});

test('Total Goals over-probability is monotonic in the projected total', () => {
  const low = gridFor(ledger({ attack: 30, defense: 50 }), ledger({ attack: 30, defense: 50 }));
  const mid = gridFor(NEUTRAL, NEUTRAL);
  const high = gridFor(ledger({ attack: 80, defense: 50 }), ledger({ attack: 80, defense: 50 }));
  const pOver = (g, total) => totalGoalsFromGrid({ grid: g.grid, projectedTotal: total, line: 2.5 }).p_over;
  const a = pOver(low, low.p.projected_total_goals);
  const b = pOver(mid, mid.p.projected_total_goals);
  const c = pOver(high, high.p.projected_total_goals);
  assert.ok(low.p.projected_total_goals < mid.p.projected_total_goals
    && mid.p.projected_total_goals < high.p.projected_total_goals, 'projected totals ordered');
  assert.ok(a < b && b < c, `P(over 2.5) must rise with the total: ${a} < ${b} < ${c}`);
});

test('Total Goals with no line is projection-only (no over/under probability)', () => {
  const { grid, p } = gridFor(NEUTRAL, NEUTRAL);
  const t = totalGoalsFromGrid({ grid, projectedTotal: p.projected_total_goals, line: null });
  assert.equal(t.projection_only, true);
  assert.equal(t.p_over, null);
  assert.equal(t.p_under, null);
  assert.equal(t.status, 'WATCH');
  assert.ok(t.projected_total > 0);
});

test('BTTS follows 1 - P(h=0) - P(a=0) + P(0-0) and is monotonic in both means', () => {
  const { grid } = gridFor(NEUTRAL, NEUTRAL);
  // Re-derive the formula independently from the same grid.
  const sum = (pred) => {
    let s = 0;
    for (let i = 0; i < grid.length; i += 1) for (let j = 0; j < grid[i].length; j += 1) if (pred(i, j)) s += grid[i][j];
    return s;
  };
  const expected = 1 - sum(i => i === 0) - sum((_i, j) => j === 0) + sum((i, j) => i === 0 && j === 0);
  const btts = bttsFromGrid({ grid });
  // p_yes is rounded to 3 decimals for clean output; compare within that tolerance.
  assert.ok(Math.abs(btts.p_yes - expected) < 5e-4, `BTTS ${btts.p_yes} must equal formula ${expected}`);

  const low = bttsFromGrid({ grid: gridFor(ledger({ attack: 30, defense: 60 }), ledger({ attack: 30, defense: 60 })).grid });
  const high = bttsFromGrid({ grid: gridFor(ledger({ attack: 80, defense: 40 }), ledger({ attack: 80, defense: 40 })).grid });
  assert.ok(high.p_yes > low.p_yes, `P(BTTS Yes) rises as both means rise: ${high.p_yes} > ${low.p_yes}`);
});

test('Goal Spread cover probability comes from the grid and requires a parsed line', () => {
  const { grid, p } = gridFor(ledger({ attack: 80, defense: 60 }), ledger({ attack: 40, defense: 50 }));
  const noLine = spreadCoverFromGrid({ grid, projectedMargin: p.projected_goal_margin_home, line: null, side: null });
  assert.equal(noLine.margin_only, true);
  assert.equal(noLine.p_cover, null);
  assert.ok(noLine.projected_margin_home > 0, 'margin still shown without a line');

  const withLine = spreadCoverFromGrid({ grid, projectedMargin: p.projected_goal_margin_home, line: -0.5, side: 'home' });
  assert.equal(withLine.margin_only, false);
  assert.ok(withLine.p_cover > 0 && withLine.p_cover < 1, 'cover probability in (0,1)');
  // Cross-check the grid math: home -0.5 covers iff home wins (i > j).
  let pWin = 0;
  for (let i = 0; i < grid.length; i += 1) for (let j = 0; j < grid[i].length; j += 1) if (i > j) pWin += grid[i][j];
  // p_cover is rounded to 3 decimals for clean output; compare within that tolerance.
  assert.ok(Math.abs(withLine.p_cover - pWin) < 5e-4, 'home -0.5 cover == P(home win)');
});

test('Poisson 1X2 computes home/draw/away and the cross-check flags directions', () => {
  const homeFav = gridFor(ledger({ attack: 85, defense: 70 }), ledger({ attack: 40, defense: 45 }));
  const x = poisson1x2FromGrid({ grid: homeFav.grid });
  assert.ok(Math.abs(x.p_home + x.p_draw + x.p_away - 1) < 1e-9, '1X2 probabilities sum to 1');
  assert.equal(x.winner, 'home');

  // Agreement → CONSISTENT
  const agree = crossCheck1x2({ logistic: { p_home: 0.6, p_draw: 0.25, p_away: 0.15 }, poisson: x });
  assert.equal(agree.verdict, 'CONSISTENT');
  // Opposite favorite → MISMATCH
  const clash = crossCheck1x2({ logistic: { p_home: 0.15, p_draw: 0.25, p_away: 0.60 }, poisson: x });
  assert.equal(clash.verdict, 'MISMATCH');
  // One side draw → WATCH
  const soft = crossCheck1x2({ logistic: { p_home: 0.30, p_draw: 0.45, p_away: 0.25 }, poisson: x });
  assert.equal(soft.verdict, 'WATCH');
  // Missing logistic → WATCH
  const missing = crossCheck1x2({ logistic: null, poisson: x });
  assert.equal(missing.verdict, 'WATCH');
});

test('price/line fields cannot change the projection or grid (price isolation)', () => {
  const clean = projectTeamGoals({ homeLedger: NEUTRAL, awayLedger: NEUTRAL });
  // Attach price-shaped junk to the ledgers; projection must be byte-identical.
  const dirtyHome = ledger({ attack: 50, defense: 50, extra: { yes_ask: 0.62, volume: 9000, open_interest: 1234, line: 2.5, price: 55 } });
  const dirtyAway = ledger({ attack: 50, defense: 50, extra: { no_bid: 0.40, bid: 41, ask: 43, ladder: [1, 2, 3] } });
  const dirty = projectTeamGoals({ homeLedger: dirtyHome, awayLedger: dirtyAway });
  assert.deepEqual(
    { h: dirty.projected_home_goals, a: dirty.projected_away_goals, t: dirty.projected_total_goals, m: dirty.projected_goal_margin_home },
    { h: clean.projected_home_goals, a: clean.projected_away_goals, t: clean.projected_total_goals, m: clean.projected_goal_margin_home },
  );
  // The market line only changes the QUESTION (over 2.5), never the grid.
  const lanesNoLine = projectGoalLanes({ homeLedger: dirtyHome, awayLedger: dirtyAway });
  const lanesWithLine = projectGoalLanes({ homeLedger: dirtyHome, awayLedger: dirtyAway, totalLine: 2.5 });
  assert.deepEqual(lanesNoLine.projection, lanesWithLine.projection, 'line does not move the projection');
  assert.equal(lanesNoLine.total_goals.projection_only, true);
  assert.equal(lanesWithLine.total_goals.projection_only, false);
});

test('projectGoalLanes blocks cleanly when layers are missing', () => {
  const res = projectGoalLanes({ homeLedger: ledger({ attack: null, defense: 50 }), awayLedger: NEUTRAL });
  assert.equal(res.ok, false);
  assert.equal(res.projection.projection_status, 'BLOCKED_MODEL_LAYER_MISSING');
});
