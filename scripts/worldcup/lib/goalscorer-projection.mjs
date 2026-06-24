// World Cup anytime-goalscorer projection sidecar.
//
// Purpose: allocate a team's projected goals across player candidates using a
// pure, price-free, lineup-aware primitive. This module does not read market
// prices, odds, liquidity, or order book fields.
//
// Model rules:
//   - team projected goals are the scoring budget
//   - expected minutes + start probability drive exposure
//   - xG / npxG / shot share / role data drive scoring weight
//   - weak priors are allowed only as provisional pre-lock reads
//   - anytime probability is 1 - exp(-projected_player_goals)
//   - listed-player allocation is capped to a documented share of team goals
//   - first goalscorer and parlays remain out of scope

export const LINEUP_STATUS = Object.freeze({
  PRE_LOCK_PROJECTED: 'PRE_LOCK_PROJECTED',
  LINEUP_WINDOW: 'LINEUP_WINDOW',
  CONFIRMED_XI: 'CONFIRMED_XI',
  UNAVAILABLE: 'UNAVAILABLE',
});

export const PROJECTION_STATUS = Object.freeze({
  READY: 'READY',
  PROVISIONAL_PRE_LOCK: 'PROVISIONAL_PRE_LOCK',
  LINEUP_SENSITIVE: 'LINEUP_SENSITIVE',
  BLOCKED_PLAYER_DATA_MISSING: 'BLOCKED_PLAYER_DATA_MISSING',
  BLOCKED_TEAM_GOALS_MISSING: 'BLOCKED_TEAM_GOALS_MISSING',
});

export const LISTED_PLAYER_ALLOCATION_SHARE = 0.85;
export const PENALTY_ROLE_BOOST_CAP = 0.20;
export const SET_PIECE_ROLE_BOOST_CAP = 0.10;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function round(n, digits = 4) {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeProbability(value) {
  const n = toNumber(value);
  if (n === null) return null;
  if (n > 1.5) return clamp(n / 100, 0, 1);
  return clamp(n, 0, 1);
}

function normalizeBinaryBoost(value) {
  if (value === true) return 1;
  if (value === false || value === null || value === undefined) return 0;
  if (typeof value === 'string') {
    if (/^true$/i.test(value)) return 1;
    if (/^false$/i.test(value)) return 0;
  }
  const n = normalizeProbability(value);
  return n ?? 0;
}

function normalizeTeamSide(value) {
  const side = String(value ?? '').trim().toLowerCase();
  if (side === 'home' || side === 'away') return side;
  return null;
}

function normalizeLineupStatus(value) {
  const status = String(value ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (status === LINEUP_STATUS.PRE_LOCK_PROJECTED
    || status === LINEUP_STATUS.LINEUP_WINDOW
    || status === LINEUP_STATUS.CONFIRMED_XI
    || status === LINEUP_STATUS.UNAVAILABLE) {
    return status;
  }
  return LINEUP_STATUS.UNAVAILABLE;
}

function normalizeCandidate(candidate = {}, fallbackSide = null, fallbackLineupStatus = LINEUP_STATUS.UNAVAILABLE) {
  const teamSide = normalizeTeamSide(candidate.team_side ?? candidate.teamSide ?? candidate.side ?? fallbackSide);
  const lineupStatus = normalizeLineupStatus(candidate.lineup_status ?? candidate.lineupStatus ?? fallbackLineupStatus);

  return {
    player_id: candidate.player_id ?? candidate.playerId ?? candidate.id ?? null,
    player_name: candidate.player_name ?? candidate.playerName ?? candidate.name ?? candidate.fullName ?? null,
    team_side: teamSide,
    position: candidate.position ?? candidate.role ?? candidate.playing_position ?? null,
    lineup_status: lineupStatus,
    start_probability: normalizeProbability(candidate.start_probability ?? candidate.startProbability),
    expected_minutes: toNumber(candidate.expected_minutes ?? candidate.expectedMinutes),
    bench_entry_probability: normalizeProbability(candidate.bench_entry_probability ?? candidate.benchEntryProbability),
    xg_per_90: toNumber(candidate.xg_per_90 ?? candidate.xg90 ?? candidate.npxg_per_90 ?? candidate.npxg90),
    shot_share: normalizeProbability(candidate.shot_share ?? candidate.shotShare),
    penalty_role: normalizeBinaryBoost(candidate.penalty_role ?? candidate.penaltyRole ?? candidate.penalty_taker ?? candidate.penaltyTaker),
    set_piece_role: normalizeBinaryBoost(candidate.set_piece_role ?? candidate.setPieceRole ?? candidate.set_piece_taker ?? candidate.setPieceTaker),
    raw: candidate,
  };
}

function isReadyStarter(player) {
  return player.lineup_status === LINEUP_STATUS.CONFIRMED_XI
    && (player.start_probability ?? 0) >= 0.7
    && (player.expected_minutes ?? 0) >= 60;
}

function positionPriorGoalsPer90(position) {
  const p = String(position ?? '').trim().toLowerCase();
  if (!p) return null;

  if (/(striker|forward|centre forward|center forward|cf|fw)/.test(p)) return 0.24;
  if (/(winger|wide forward|inside forward|left wing|right wing|lw|rw)/.test(p)) return 0.18;
  if (/(attacking midfielder|attacking mid|am|cam|second striker)/.test(p)) return 0.15;
  if (/(midfielder|cm|rm|lm|dm|holding midfielder)/.test(p)) return 0.09;
  if (/(fullback|full-back|wingback|wing-back|defender|centre back|center back|cb|lb|rb|lwb|rwb)/.test(p)) return 0.03;
  if (/(goalkeeper|keeper|gk)/.test(p)) return 0.005;
  return 0.08;
}

function deriveExpectedMinutes(player) {
  if (player.expected_minutes !== null && player.expected_minutes !== undefined) {
    return clamp(player.expected_minutes, 0, 90);
  }

  const start = player.start_probability;
  const bench = player.bench_entry_probability;

  if (start !== null && bench !== null) {
    return clamp(Math.max(18 + (72 * start), 8 + (36 * bench)), 0, 90);
  }
  if (start !== null) return clamp(18 + (72 * start), 0, 90);
  if (bench !== null) return clamp(8 + (36 * bench), 0, 90);

  switch (player.lineup_status) {
    case LINEUP_STATUS.CONFIRMED_XI:
      return 72;
    case LINEUP_STATUS.PRE_LOCK_PROJECTED:
      return 28;
    case LINEUP_STATUS.LINEUP_WINDOW:
      return 24;
    default:
      return 18;
  }
}

function deriveStartProbability(player) {
  if (player.start_probability !== null && player.start_probability !== undefined) return player.start_probability;
  switch (player.lineup_status) {
    case LINEUP_STATUS.CONFIRMED_XI:
      return 0.85;
    case LINEUP_STATUS.PRE_LOCK_PROJECTED:
      return 0.58;
    case LINEUP_STATUS.LINEUP_WINDOW:
      return 0.45;
    default:
      return 0.25;
  }
}

function scoringSource(player) {
  if (player.xg_per_90 !== null && player.xg_per_90 !== undefined) return 'xg';
  const prior = positionPriorGoalsPer90(player.position);
  if (prior !== null) return 'weak_prior';
  return null;
}

function buildModelNotes({ source, lineupStatus, penaltyRole, setPieceRole, weakPrior, expectedMinutes, startProbability, allocationShare, teamProjectedGoals }) {
  const notes = [
    `team_goal_budget=${round(teamProjectedGoals, 3)}`,
    `listed_player_allocation_share=${allocationShare}`,
    `exposure_uses_expected_minutes_and_start_probability`,
  ];

  if (source === 'xg') notes.push('scoring_weight_anchored_by_xg_or_npxg');
  if (weakPrior) notes.push('weak_prior_used_for_position_or_role_only');
  if (penaltyRole > 0) notes.push(`penalty_role_boost_capped_at_${Math.round(PENALTY_ROLE_BOOST_CAP * 100)}pct`);
  if (setPieceRole > 0) notes.push(`set_piece_role_boost_capped_at_${Math.round(SET_PIECE_ROLE_BOOST_CAP * 100)}pct`);
  if (lineupStatus === LINEUP_STATUS.CONFIRMED_XI) notes.push('confirmed_xi_can_upgrade_eligible_players_to_ready');
  if (lineupStatus !== LINEUP_STATUS.CONFIRMED_XI) notes.push('pre_lock_or_lineup_window_output_remains_lineup_sensitive_or_provisional');
  notes.push(`expected_minutes=${round(expectedMinutes, 1)}`);
  notes.push(`start_probability=${round(startProbability, 3)}`);
  return notes;
}

function buildCandidateProjection({
  player,
  teamProjectedGoals,
  allocationShare,
}) {
  if (!Number.isFinite(teamProjectedGoals)) {
    return {
      player_id: player.player_id ?? null,
      player_name: player.player_name ?? null,
      team_side: player.team_side ?? null,
      projection_status: PROJECTION_STATUS.BLOCKED_TEAM_GOALS_MISSING,
      expected_minutes: null,
      start_probability: null,
      projected_player_goals: null,
      anytime_goal_probability: null,
      reason: 'team projected goals missing; player scoring not projected',
      model_notes: ['team_goal_projection_required'],
      input_status: player.lineup_status,
      price_free: true,
      _eligible: false,
      _raw_weight: 0,
    };
  }

  if (!player.player_id || !player.player_name || !player.team_side) {
    return {
      player_id: player.player_id ?? null,
      player_name: player.player_name ?? null,
      team_side: player.team_side ?? null,
      projection_status: PROJECTION_STATUS.BLOCKED_PLAYER_DATA_MISSING,
      expected_minutes: null,
      start_probability: null,
      projected_player_goals: null,
      anytime_goal_probability: null,
      reason: 'player identity or team side missing; player scoring not projected',
      model_notes: ['player_identity_and_team_side_required'],
      input_status: player.lineup_status,
      price_free: true,
      _eligible: false,
      _raw_weight: 0,
    };
  }

  const source = scoringSource(player);
  if (!source) {
    return {
      player_id: player.player_id,
      player_name: player.player_name,
      team_side: player.team_side,
      projection_status: PROJECTION_STATUS.BLOCKED_PLAYER_DATA_MISSING,
      expected_minutes: null,
      start_probability: null,
      projected_player_goals: null,
      anytime_goal_probability: null,
      reason: 'player scoring data missing and no position prior available',
      model_notes: ['xg_or_position_role_required'],
      input_status: player.lineup_status,
      price_free: true,
      _eligible: false,
      _raw_weight: 0,
    };
  }

  const expectedMinutes = deriveExpectedMinutes(player);
  const startProbability = deriveStartProbability(player);
  const baseGoalsPer90 = source === 'xg' ? player.xg_per_90 : positionPriorGoalsPer90(player.position);
  const shotBoost = player.shot_share !== null && player.shot_share !== undefined
    ? clamp(1 + (0.35 * player.shot_share), 1, 1.35)
    : 1;
  const penaltyBoost = clamp(1 + (PENALTY_ROLE_BOOST_CAP * player.penalty_role), 1, 1 + PENALTY_ROLE_BOOST_CAP);
  const setPieceBoost = clamp(1 + (SET_PIECE_ROLE_BOOST_CAP * player.set_piece_role), 1, 1 + SET_PIECE_ROLE_BOOST_CAP);
  const exposure = clamp((expectedMinutes / 90) * (0.35 + (0.65 * startProbability)), 0, 1);
  const weakPriorFactor = source === 'weak_prior' ? 0.82 : 1;
  const rawWeight = clamp((baseGoalsPer90 ?? 0) * exposure * shotBoost * penaltyBoost * setPieceBoost * weakPriorFactor, 0, Number.POSITIVE_INFINITY);

  let projectionStatus;
  let reason;
  if (isReadyStarter(player)) {
    projectionStatus = PROJECTION_STATUS.READY;
    reason = source === 'xg'
      ? 'confirmed starter with xG-based scoring weight'
      : 'confirmed starter with position-based prior';
  } else if (source === 'weak_prior') {
    projectionStatus = PROJECTION_STATUS.PROVISIONAL_PRE_LOCK;
    reason = 'weak pre-lock prior from position/role while xG is missing';
  } else {
    projectionStatus = PROJECTION_STATUS.LINEUP_SENSITIVE;
    reason = player.lineup_status === LINEUP_STATUS.CONFIRMED_XI
      ? 'confirmed XI but exposure is still starter-sensitive'
      : 'lineup not confirmed; player output remains lineup-sensitive';
  }

  const modelNotes = buildModelNotes({
    source,
    lineupStatus: player.lineup_status,
    penaltyRole: player.penalty_role,
    setPieceRole: player.set_piece_role,
    weakPrior: source === 'weak_prior',
    expectedMinutes,
    startProbability,
    allocationShare,
    teamProjectedGoals,
  });

  return {
    player_id: player.player_id,
    player_name: player.player_name,
    team_side: player.team_side,
    projection_status: projectionStatus,
    expected_minutes: round(expectedMinutes, 1),
    start_probability: round(startProbability, 3),
    projected_player_goals: round(rawWeight, 4),
    anytime_goal_probability: round(1 - Math.exp(-rawWeight), 4),
    reason,
    model_notes: modelNotes,
    input_status: player.lineup_status,
    price_free: true,
    _eligible: true,
    _raw_weight: rawWeight,
  };
}

export function projectAnytimeGoalscorers({
  match = null,
  fixture = null,
  team_side = null,
  projected_team_goals = null,
  player_candidates = [],
  lineup_status = LINEUP_STATUS.UNAVAILABLE,
  allocation_share = LISTED_PLAYER_ALLOCATION_SHARE,
} = {}) {
  const matchId = fixture?.match_id ?? fixture?.id ?? match?.match_id ?? match?.id ?? null;
  const teamSide = normalizeTeamSide(team_side);
  const teamProjectedGoals = toNumber(projected_team_goals);
  const normalizedLineupStatus = normalizeLineupStatus(lineup_status);
  const normalizedCandidates = Array.isArray(player_candidates)
    ? player_candidates.map((candidate) => normalizeCandidate(candidate, teamSide, normalizedLineupStatus))
    : [];

  const base = {
    match_id: matchId,
    team_side: teamSide,
    lineup_status: normalizedLineupStatus,
    projected_team_goals: teamProjectedGoals !== null ? round(teamProjectedGoals, 4) : null,
    allocation_share: round(allocation_share, 4),
    listed_player_goal_budget: teamProjectedGoals !== null ? round(teamProjectedGoals * allocation_share, 4) : null,
    total_projected_player_goals: null,
    price_free: true,
  };

  const provisional = normalizedCandidates.map((player) => buildCandidateProjection({
    player,
    teamProjectedGoals,
    allocationShare: allocation_share,
  }));

  if (!Number.isFinite(teamProjectedGoals)) {
    return {
      ...base,
      total_projected_player_goals: null,
      players: provisional.map(({ _eligible, _raw_weight, ...projection }) => projection),
    };
  }

  const eligible = provisional.filter((p) => p._eligible);
  const totalRawWeight = eligible.reduce((sum, player) => sum + player._raw_weight, 0);
  const budget = teamProjectedGoals * allocation_share;

  const players = provisional.map((player) => {
    if (!player._eligible) {
      const { _eligible, _raw_weight, ...projection } = player;
      return projection;
    }

    const rawShare = totalRawWeight > 0 ? (player._raw_weight / totalRawWeight) : (eligible.length > 0 ? 1 / eligible.length : 0);
    const projectedGoals = round(budget * rawShare, 4);
    const anytimeGoalProbability = round(1 - Math.exp(-projectedGoals), 4);
    const { _eligible, _raw_weight, ...projection } = player;
    return {
      ...projection,
      projected_player_goals: projectedGoals,
      anytime_goal_probability: anytimeGoalProbability,
    };
  });

  const totalProjectedPlayerGoals = players.reduce((sum, player) => sum + (player.projected_player_goals ?? 0), 0);

  return {
    ...base,
    total_projected_player_goals: round(totalProjectedPlayerGoals, 4),
    players,
  };
}

export function projectAnytimeGoalscorer(input = {}) {
  const candidate = input.player_candidate ?? input.player ?? input;
  const res = projectAnytimeGoalscorers({
    ...input,
    player_candidates: [candidate],
  });
  return res.players[0] ?? null;
}

