// World Cup team-advances model.
//
// Generative Elo -> Poisson path:
//   1. Convert the Elo gap into an expected-goal supremacy using a conservative
//      600 Elo points per 1 goal of supremacy prior.
//   2. Split the match's expected 90-minute goal total around that supremacy.
//   3. Use the Poisson score grid for regulation, then a 30-minute extra-time
//      slice (lambda * 1/3), then penalties with a tight capped prior.
//
// The model is deliberately baseline-only: no player adjustment, no price data,
// no odds, no liquidity, and no scorecard-style weighting.

export const ELO_GOAL_SUPREMACY_DIVISOR = 600;
export const ADVANCES_BASELINE_TOTAL_GOALS = 2.4;
export const ADVANCES_GRID_MAX = 10;
export const ADVANCES_CALIBRATION_STATUS = 'V1_PROVISIONAL';

// Tunable constants for the backtest/calibration harness. Defaults reproduce the
// legacy hardcoded behavior exactly; the calibration harness tunes these on a
// train split without forking the model's computation.
export const DEFAULT_ADVANCES_CONFIG = {
  eloGoalSupremacyDivisor: ELO_GOAL_SUPREMACY_DIVISOR,
  baselineTotalGoals: ADVANCES_BASELINE_TOTAL_GOALS,
  homeAdvantageElo: 0,
  penaltyPrior: 0.5,
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function factorialLog(n) {
  let out = 0;
  for (let i = 2; i <= n; i += 1) out += Math.log(i);
  return out;
}

function poissonPmf(k, lambda) {
  if (!(lambda > 0)) return 0;
  return Math.exp((-lambda) + (k * Math.log(lambda)) - factorialLog(k));
}

function resolveElo(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function extractSourceText(evidence = null) {
  if (!evidence) return null;
  const source = typeof evidence.source === 'string' ? evidence.source.trim() : '';
  const cited = typeof evidence.cited_source === 'string' ? evidence.cited_source.trim() : '';
  const note = typeof evidence.note === 'string' ? evidence.note.trim() : '';
  return source || cited || note || null;
}

export function eloToLambdas(eloTeam, eloOpp, opts = {}) {
  const cfg = { ...DEFAULT_ADVANCES_CONFIG, ...(opts.config || {}) };
  const team = resolveElo(eloTeam, null);
  const opp = resolveElo(eloOpp, null);
  if (team === null || opp === null) {
    return {
      ok: false,
      reason: 'elo missing for at least one side',
      lambdaTeam: null,
      lambdaOpp: null,
      goalSupremacy: null,
      eloDiff: null,
      baselineTotalGoals: opts.baselineTotalGoals ?? cfg.baselineTotalGoals,
      divisor: opts.divisor ?? cfg.eloGoalSupremacyDivisor,
    };
  }

  const baselineTotalGoals = Number(opts.baselineTotalGoals ?? cfg.baselineTotalGoals) || ADVANCES_BASELINE_TOTAL_GOALS;
  const divisor = Number(opts.divisor ?? cfg.eloGoalSupremacyDivisor) || ELO_GOAL_SUPREMACY_DIVISOR;
  const eloDiff = (team - opp) + Number(cfg.homeAdvantageElo || 0);
  const goalSupremacy = clamp(eloDiff / divisor, -1.35, 1.35);
  const halfTotal = baselineTotalGoals / 2;

  return {
    ok: true,
    lambdaTeam: clamp(halfTotal + (goalSupremacy / 2), 0.15, 4.5),
    lambdaOpp: clamp(halfTotal - (goalSupremacy / 2), 0.15, 4.5),
    goalSupremacy: round3(goalSupremacy),
    eloDiff: round3(eloDiff),
    baselineTotalGoals: round3(baselineTotalGoals),
    divisor,
  };
}

export function poissonMatrix(lambdaA, lambdaB, maxGoals = ADVANCES_GRID_MAX) {
  if (!(lambdaA > 0) || !(lambdaB > 0)) {
    return { ok: false, reason: 'goal means unavailable; cannot build score grid' };
  }

  const homePmf = [];
  const awayPmf = [];
  for (let i = 0; i <= maxGoals; i += 1) {
    homePmf.push(poissonPmf(i, lambdaA));
    awayPmf.push(poissonPmf(i, lambdaB));
  }

  const matrix = [];
  let sumRaw = 0;
  for (let i = 0; i <= maxGoals; i += 1) {
    const row = [];
    for (let j = 0; j <= maxGoals; j += 1) {
      const p = homePmf[i] * awayPmf[j];
      row.push(p);
      sumRaw += p;
    }
    matrix.push(row);
  }

  for (let i = 0; i <= maxGoals; i += 1) {
    for (let j = 0; j <= maxGoals; j += 1) {
      matrix[i][j] /= sumRaw;
    }
  }

  return { ok: true, matrix, maxGoals, lambdaA, lambdaB, sumRaw: round3(sumRaw) };
}

export function regulationWDL(matrix, teamIsHome = true) {
  if (!Array.isArray(matrix) || !matrix.length) {
    return { ok: false, reason: 'regulation matrix unavailable', pWin: null, pDraw: null, pLoss: null };
  }

  let pWin = 0;
  let pDraw = 0;
  let pLoss = 0;
  for (let home = 0; home < matrix.length; home += 1) {
    for (let away = 0; away < matrix[home].length; away += 1) {
      const p = matrix[home][away];
      if (home === away) {
        pDraw += p;
      } else if (teamIsHome ? home > away : away > home) {
        pWin += p;
      } else {
        pLoss += p;
      }
    }
  }

  const sum = pWin + pDraw + pLoss;
  return {
    ok: true,
    pWin: round3(pWin),
    pDraw: round3(pDraw),
    pLoss: round3(pLoss),
    sum: round3(sum),
  };
}

export function extraTimePoisson(lambdaA, lambdaB, etFraction = 1 / 3) {
  const etA = Number(lambdaA) * etFraction;
  const etB = Number(lambdaB) * etFraction;
  const grid = poissonMatrix(etA, etB);
  if (!grid.ok) {
    return { ok: false, reason: grid.reason, etWin: null, etDraw: null, etLoss: null };
  }
  const result = regulationWDL(grid.matrix, true);
  return {
    ok: true,
    etWin: result.pWin,
    etDraw: result.pDraw,
    etLoss: result.pLoss,
    matrix: grid.matrix,
    sum: result.sum,
  };
}

export function penaltyWin({ evidence = null, penaltyPrior = 0.5 } = {}) {
  const raw = resolveElo(
    evidence?.penaltyWin ?? evidence?.penalty_win ?? evidence?.penalty_probability ?? penaltyPrior,
    penaltyPrior,
  );
  const strongEvidence = evidence?.strongKeeperTakerEvidence;
  const sourceText = extractSourceText(strongEvidence);
  const hasStrongEvidence = Boolean(sourceText);
  const min = hasStrongEvidence ? 0.45 : 0.47;
  const max = hasStrongEvidence ? 0.55 : 0.53;
  return {
    penWin: clamp(raw, min, max),
    range: [min, max],
    evidence_source: sourceText,
  };
}

function lineupLimitations(lineup = null) {
  if (lineup?.confirmed === true) return [];
  return ['No confirmed lineup; baseline Elo→Poisson only.'];
}

export function computeAdvance({
  eloTeam,
  eloOpp,
  bracket = null,
  lineup = null,
  evidence = null,
  config = null,
} = {}) {
  const cfg = { ...DEFAULT_ADVANCES_CONFIG, ...(config || {}) };
  const missingInputs = [];
  const limitations = [];
  const teamIsHome = bracket?.team_is_home !== false;
  const bracketPresent = Boolean(bracket && (bracket.stage || bracket.round || bracket.next_round || bracket.label || bracket.match_id));
  const teamElo = resolveElo(eloTeam, null);
  const oppElo = resolveElo(eloOpp, null);

  if (teamElo === null) missingInputs.push('eloTeam');
  if (oppElo === null) missingInputs.push('eloOpp');
  if (!bracketPresent) missingInputs.push('bracket_context');

  const baseArtifact = {
    market_type: 'worldcup_advances',
    settlement_scope: 'team_advances_to_next_round',
    includes_extra_time: true,
    includes_penalties: true,
    regulation_only: false,
    model_mode: 'BASELINE_ELO_POISSON_NO_PLAYER_ADJUSTMENT',
    status: 'READY',
    missing_inputs: [],
    limitations: [],
    calibration_status: ADVANCES_CALIBRATION_STATUS,
    p_advance: null,
    p_advance_derivation: null,
    reg: { pWin: null, pDraw: null, pLoss: null },
    et: { etWin: null, etDraw: null, etLoss: null },
    pen: { penWin: null },
    lean: null,
    team_is_home: teamIsHome,
  };

  if (missingInputs.includes('eloTeam') || missingInputs.includes('eloOpp')) {
    return {
      ...baseArtifact,
      status: 'BLOCKED',
      missing_inputs: missingInputs,
      limitations: ['Missing cached Elo baseline for one or both teams.'],
    };
  }

  if (missingInputs.includes('bracket_context')) {
    return {
      ...baseArtifact,
      status: 'RESEARCH_ONLY',
      missing_inputs: missingInputs,
      limitations: ['Bracket context missing; cannot safely resolve the next-round path.'],
    };
  }

  const lambdas = eloToLambdas(teamElo, oppElo, { ...(evidence?.eloPrior ?? {}), config: cfg });
  if (!lambdas.ok) {
    return {
      ...baseArtifact,
      status: 'BLOCKED',
      missing_inputs: missingInputs.length ? missingInputs : ['elo_poisson_path'],
      limitations: ['Unable to map Elo to Poisson lambdas.'],
    };
  }

  const homeLambda = teamIsHome ? lambdas.lambdaTeam : lambdas.lambdaOpp;
  const awayLambda = teamIsHome ? lambdas.lambdaOpp : lambdas.lambdaTeam;
  const regGrid = poissonMatrix(homeLambda, awayLambda);
  if (!regGrid.ok) {
    return {
      ...baseArtifact,
      status: 'BLOCKED',
      missing_inputs: ['poisson_grid'],
      limitations: ['Unable to build the regulation Poisson grid.'],
    };
  }

  const reg = regulationWDL(regGrid.matrix, teamIsHome);
  const et = extraTimePoisson(lambdas.lambdaTeam, lambdas.lambdaOpp);
  const pen = penaltyWin({ evidence, penaltyPrior: cfg.penaltyPrior });
  const pAdvance = reg.pWin + (reg.pDraw * (et.etWin + (et.etDraw * pen.penWin)));
  const lineupNotes = lineupLimitations(lineup);

  return {
    ...baseArtifact,
    status: 'READY',
    missing_inputs: [],
    limitations: lineupNotes,
    elo_diff: lambdas.eloDiff,
    goal_supremacy: lambdas.goalSupremacy,
    lambdas: {
      team: lambdas.lambdaTeam,
      opp: lambdas.lambdaOpp,
      home: homeLambda,
      away: awayLambda,
      baseline_total_goals: lambdas.baselineTotalGoals,
      divisor: lambdas.divisor,
    },
    reg,
    et: {
      etWin: et.etWin,
      etDraw: et.etDraw,
      etLoss: et.etLoss,
    },
    pen: {
      penWin: pen.penWin,
      range: pen.range,
      evidence_source: pen.evidence_source,
    },
    p_advance: round3(pAdvance),
    p_advance_derivation: 'pWin + pDraw * (etWin + etDraw * penWin)',
    lean: pAdvance >= 0.5 ? 'TEAM_ADVANCES' : 'OPPONENT_ADVANCES',
    bracket: bracket ?? null,
  };
}
