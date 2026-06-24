// World Cup projected team goals + Poisson score grid.
//
// Purpose: turn the existing composite ATTACK / DEFENSE rating layers into a
// real per-team goal projection, then convert that projection into a bounded
// Poisson score grid. The grid is the single source of truth for the derived
// goal-market lanes (Total Goals, BTTS, Goal Spread, and a Poisson 1X2
// cross-check), replacing the earlier heuristic proxies.
//
// Grounding & price isolation:
//   - Inputs are ONLY the home/away evidence ledgers (attacking_strength /
//     defensive_strength, 0-100, 50 = tournament-average). No market price,
//     odds, OI, volume, bid/ask, liquidity, or Kalshi ladder field enters this
//     module. A market line, when present, is used ONLY as the QUESTION being
//     answered ("over 2.5"), never as an input to the projection.
//   - Missing attack/defense layers on either side => BLOCKED_MODEL_LAYER_MISSING.
//     Goals are never fabricated.
//
// Documented priors (revisit against graded results; NOT magic numbers):
//   - BASELINE_TOTAL_GOALS = 2.6 — World Cup group-stage total-goals anchor.
//     A neutral 50/50 fixture projects to this total (1.3 goals per side).
//   - ATTACK_SENSITIVITY / DEFENSE_SENSITIVITY = 0.30 — how strongly a one-
//     standard-band (50 rating points) edge in attack, or in the opponent's
//     defense, multiplies a side's goal mean. Chosen so a maximal mismatch
//     stays inside a believable international score range.
//   - HOME_FIELD_GOAL_MULT = 1.0 by default (NEUTRAL). "home" in the fixture is
//     only slate orientation, not a true host advantage. A caller may pass an
//     explicit, data-backed advantage; we never silently bump every listed
//     home team.
//   - LAMBDA_MIN / LAMBDA_MAX clamp each side's mean to a sane football range.
//   - GRID_MAX = 10 — score grid runs 0..10 per side, then is normalized so the
//     truncated tail does not leak probability mass.

export const BASELINE_TOTAL_GOALS = 2.6;
export const LEAGUE_AVG_TEAM_GOALS = BASELINE_TOTAL_GOALS / 2; // 1.3
export const ATTACK_SENSITIVITY = 0.30;
export const DEFENSE_SENSITIVITY = 0.30;
export const HOME_FIELD_GOAL_MULT = 1.0; // neutral by default
export const RATING_BAND = 50; // points from average (50) to a full-band edge
export const LAMBDA_MIN = 0.2;
export const LAMBDA_MAX = 4.0;
export const GRID_MAX = 10;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function round2(n) { return Math.round(n * 100) / 100; }
function round3(n) { return Math.round(n * 1000) / 1000; }

function layerScore(ledger, key) {
  const l = (ledger?.layers || []).find(x => x.key === key);
  return l && l.present && l.score != null ? l.score : null;
}

/**
 * Project per-team goal means (Poisson lambdas) from attack/defense ratings.
 *
 * @param {object} opts
 * @param {object} opts.homeLedger evidence ledger (carries layers[])
 * @param {object} opts.awayLedger evidence ledger
 * @param {number} [opts.homeFieldGoalMult] explicit, data-backed home multiplier
 *        (>=1 helps home, <1 helps away). Defaults to NEUTRAL (1.0).
 * @returns {object} projection with status PROJECTED or BLOCKED_MODEL_LAYER_MISSING
 */
export function projectTeamGoals({ homeLedger, awayLedger, homeFieldGoalMult = HOME_FIELD_GOAL_MULT } = {}) {
  const ha = layerScore(homeLedger, 'attacking_strength');
  const aa = layerScore(awayLedger, 'attacking_strength');
  const hd = layerScore(homeLedger, 'defensive_strength');
  const ad = layerScore(awayLedger, 'defensive_strength');

  if (ha === null || aa === null || hd === null || ad === null) {
    return {
      projection_status: 'BLOCKED_MODEL_LAYER_MISSING',
      reason: 'attack/defense layers missing on at least one side; goals not projected (never fabricated)',
      projected_home_goals: null,
      projected_away_goals: null,
      projected_total_goals: null,
      projected_goal_margin_home: null,
    };
  }

  // Each side's mean = league-average team goals, scaled UP by its own attack
  // edge and scaled DOWN by the opponent's defensive edge. A multiplicative
  // (log-linear) form keeps means strictly positive and symmetric around the
  // 50/50 baseline.
  const attackFactor = (atk) => Math.exp(ATTACK_SENSITIVITY * (atk - 50) / RATING_BAND);
  const defenseFactor = (def) => Math.exp(-DEFENSE_SENSITIVITY * (def - 50) / RATING_BAND);

  const lambdaHome = clamp(
    LEAGUE_AVG_TEAM_GOALS * attackFactor(ha) * defenseFactor(ad) * homeFieldGoalMult,
    LAMBDA_MIN, LAMBDA_MAX,
  );
  const lambdaAway = clamp(
    LEAGUE_AVG_TEAM_GOALS * attackFactor(aa) * defenseFactor(hd) * (1 / homeFieldGoalMult),
    LAMBDA_MIN, LAMBDA_MAX,
  );

  return {
    projection_status: 'PROJECTED',
    reason: null,
    projected_home_goals: round2(lambdaHome),
    projected_away_goals: round2(lambdaAway),
    projected_total_goals: round2(lambdaHome + lambdaAway),
    projected_goal_margin_home: round2(lambdaHome - lambdaAway),
    lambda_home: lambdaHome,
    lambda_away: lambdaAway,
    basis: `Poisson means from attack vs opponent defense; baseline total ${BASELINE_TOTAL_GOALS} (group-stage anchor), home advantage ${homeFieldGoalMult === 1 ? 'NEUTRAL' : homeFieldGoalMult}`,
  };
}

function poissonPmf(k, lambda) {
  // e^{-λ} λ^k / k!
  let logp = -lambda + k * Math.log(lambda);
  for (let n = 2; n <= k; n += 1) logp -= Math.log(n);
  return Math.exp(logp);
}

/**
 * Build a bounded, normalized Poisson score grid from two goal means.
 * grid[i][j] = P(home scores i, away scores j), i,j in 0..GRID_MAX.
 * The truncated tail is folded back via normalization so the grid sums to ~1.
 *
 * @returns {object} { ok, grid, max, lambda_home, lambda_away, sum_raw } or { ok:false }
 */
export function buildScoreGrid({ lambdaHome, lambdaAway, max = GRID_MAX } = {}) {
  if (!(lambdaHome > 0) || !(lambdaAway > 0)) {
    return { ok: false, reason: 'goal means unavailable; cannot build score grid' };
  }
  const homePmf = [];
  const awayPmf = [];
  for (let i = 0; i <= max; i += 1) {
    homePmf.push(poissonPmf(i, lambdaHome));
    awayPmf.push(poissonPmf(i, lambdaAway));
  }
  const grid = [];
  let sumRaw = 0;
  for (let i = 0; i <= max; i += 1) {
    const row = [];
    for (let j = 0; j <= max; j += 1) {
      const p = homePmf[i] * awayPmf[j];
      row.push(p);
      sumRaw += p;
    }
    grid.push(row);
  }
  // Normalize so the truncated tail beyond `max` does not leak probability.
  for (let i = 0; i <= max; i += 1) {
    for (let j = 0; j <= max; j += 1) {
      grid[i][j] /= sumRaw;
    }
  }
  return { ok: true, grid, max, lambda_home: lambdaHome, lambda_away: lambdaAway, sum_raw: round3(sumRaw) };
}

function gridSum(grid, predicate) {
  let p = 0;
  for (let i = 0; i < grid.length; i += 1) {
    for (let j = 0; j < grid[i].length; j += 1) {
      if (predicate(i, j)) p += grid[i][j];
    }
  }
  return p;
}

/**
 * Total Goals from the grid. The projected total is the handicap; a market
 * line (when present) is only the question. With no line we stay projection-only.
 *
 * @param {object} opts { grid, projectedTotal, line }
 */
export function totalGoalsFromGrid({ grid, projectedTotal, line = null } = {}) {
  if (line === null || line === undefined) {
    return {
      status: 'WATCH',
      projection_only: true,
      projected_total: round2(projectedTotal),
      p_over: null,
      p_under: null,
      line: null,
      reason: 'no total line parsed; projection-only',
    };
  }
  const pOver = gridSum(grid, (i, j) => (i + j) > line);
  const pUnder = gridSum(grid, (i, j) => (i + j) < line);
  // Integer lines can push; expose it but classify off over/under only.
  const pPush = gridSum(grid, (i, j) => (i + j) === line);
  const lean = Math.max(pOver, pUnder);
  const status = lean >= 0.68 ? 'PICK' : lean >= 0.60 ? 'LEAN' : 'WATCH';
  return {
    status,
    projection_only: false,
    projected_total: round2(projectedTotal),
    p_over: round3(pOver),
    p_under: round3(pUnder),
    p_push: round3(pPush),
    side: pOver >= pUnder ? 'OVER' : 'UNDER',
    line,
  };
}

/**
 * BTTS (both teams to score) from the grid.
 * P(Yes) = 1 - P(home=0) - P(away=0) + P(0-0).
 */
export function bttsFromGrid({ grid } = {}) {
  const pHomeZero = gridSum(grid, (i) => i === 0);
  const pAwayZero = gridSum(grid, (_i, j) => j === 0);
  const pZeroZero = gridSum(grid, (i, j) => i === 0 && j === 0);
  const pYes = clamp(1 - pHomeZero - pAwayZero + pZeroZero, 0, 1);
  const status = pYes >= 0.68 ? 'PICK_YES'
    : pYes >= 0.60 ? 'LEAN_YES'
    : pYes <= 0.32 ? 'PICK_NO'
    : pYes <= 0.40 ? 'LEAN_NO'
    : 'WATCH';
  return {
    status,
    p_yes: round3(pYes),
    p_no: round3(1 - pYes),
    recommendation: pYes >= 0.5 ? 'YES' : 'NO',
  };
}

/**
 * Goal Spread cover probability from the grid. Requires a parsed line + side;
 * with no line we report margin-only (no fabricated cover edge).
 *
 * Convention: a home line of -0.5 means home must win by > 0.5 (i.e. >=1) to
 * cover; an away line of +0.5 covers when away loses by < 0.5 (draw or win).
 *
 * @param {object} opts { grid, projectedMargin, line, side }
 */
export function spreadCoverFromGrid({ grid, projectedMargin, line = null, side = null } = {}) {
  if (line === null || line === undefined || (side !== 'home' && side !== 'away')) {
    return {
      status: 'WATCH',
      margin_only: true,
      projected_margin_home: round2(projectedMargin),
      p_cover: null,
      line: line ?? null,
      side: side ?? null,
      reason: 'no parsed spread line/side; margin-only (no cover probability)',
    };
  }
  // margin_home = i - j. Home covers a (home) line L when (i - j) + L > 0.
  // Away covers an (away) line L when (j - i) + L > 0.
  const pCover = side === 'home'
    ? gridSum(grid, (i, j) => (i - j) + line > 0)
    : gridSum(grid, (i, j) => (j - i) + line > 0);
  const status = pCover >= 0.68 ? `PICK_COVER_${side.toUpperCase()}`
    : pCover >= 0.60 ? `LEAN_COVER_${side.toUpperCase()}`
    : pCover <= 0.40 ? 'LEAN_FADE'
    : 'WATCH';
  return {
    status,
    margin_only: false,
    projected_margin_home: round2(projectedMargin),
    p_cover: round3(pCover),
    line,
    side,
  };
}

/**
 * Poisson 1X2 from the grid: P(home win) / P(draw) / P(away win).
 */
export function poisson1x2FromGrid({ grid } = {}) {
  const pHome = gridSum(grid, (i, j) => i > j);
  const pDraw = gridSum(grid, (i, j) => i === j);
  const pAway = gridSum(grid, (i, j) => i < j);
  let winner = 'draw';
  if (pHome >= pDraw && pHome >= pAway) winner = 'home';
  else if (pAway >= pDraw && pAway >= pHome) winner = 'away';
  return {
    p_home: round3(pHome),
    p_draw: round3(pDraw),
    p_away: round3(pAway),
    winner,
  };
}

/**
 * Cross-check the Poisson 1X2 winner direction against the primary logistic
 * 1X2. The logistic model stays primary; this is a consistency flag only.
 *
 * @param {object} opts { logistic:{p_home,p_draw,p_away}, poisson:{winner,...} }
 * @returns {object} { verdict: CONSISTENT|MISMATCH|WATCH, ... }
 */
export function crossCheck1x2({ logistic, poisson } = {}) {
  if (!logistic || logistic.p_home == null) {
    return { verdict: 'WATCH', reason: 'logistic 1X2 unavailable', poisson_winner: poisson?.winner ?? null, logistic_winner: null };
  }
  const logWinner = (() => {
    const { p_home, p_draw, p_away } = logistic;
    if (p_home >= p_draw && p_home >= p_away) return 'home';
    if (p_away >= p_draw && p_away >= p_home) return 'away';
    return 'draw';
  })();
  const poiWinner = poisson.winner;

  let verdict;
  if (logWinner === poiWinner) {
    verdict = 'CONSISTENT';
  } else if ((logWinner === 'home' && poiWinner === 'away') || (logWinner === 'away' && poiWinner === 'home')) {
    // Decisive disagreement (opposite favorite) is a material mismatch.
    verdict = 'MISMATCH';
  } else {
    // One side reads draw, or a small/provisional difference: watch, not alarm.
    verdict = 'WATCH';
  }
  return { verdict, logistic_winner: logWinner, poisson_winner: poiWinner };
}

/**
 * One-call convenience: project goals, build the grid, and derive every lane.
 * Returns a single object the lane board / renderer can consume.
 */
export function projectGoalLanes({ homeLedger, awayLedger, logistic = null, totalLine = null, spreadLine = null, spreadSide = null, homeFieldGoalMult = HOME_FIELD_GOAL_MULT } = {}) {
  const projection = projectTeamGoals({ homeLedger, awayLedger, homeFieldGoalMult });
  if (projection.projection_status !== 'PROJECTED') {
    return { ok: false, projection };
  }
  const gridRes = buildScoreGrid({ lambdaHome: projection.lambda_home, lambdaAway: projection.lambda_away });
  if (!gridRes.ok) {
    return { ok: false, projection, reason: gridRes.reason };
  }
  const grid = gridRes.grid;
  const poisson = poisson1x2FromGrid({ grid });
  return {
    ok: true,
    projection,
    grid,
    grid_sum: gridRes.sum_raw,
    total_goals: totalGoalsFromGrid({ grid, projectedTotal: projection.projected_total_goals, line: totalLine }),
    btts: bttsFromGrid({ grid }),
    spread: spreadCoverFromGrid({ grid, projectedMargin: projection.projected_goal_margin_home, line: spreadLine, side: spreadSide }),
    poisson_1x2: poisson,
    cross_check_1x2: crossCheck1x2({ logistic, poisson }),
  };
}
