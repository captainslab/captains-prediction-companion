// World Cup multi-lane ceiling board.
// Maps composite evidence ledgers to per-market-lane signals.
//
// Lanes:
//   1. match_winner — 1X2 result incl. Draw (regulation 90'+stoppage)
//   2. spread_full_game — goal handicap, full game
//   3. total_goals — over/under, full game
//   4. both_teams_to_score — BTTS, full game
//   5. match_winner_first_half / spread_first_half / total_goals_first_half /
//      btts_first_half — 1st-half variants. No half-split source data exists,
//      so these are BLOCKED_MODEL_LAYER_MISSING (market reference only) —
//      never modeled from invented half data.
//   6. team_to_advance (knockout; settles incl. ET + penalties)
//   7. group_qualification / tournament_futures
//
// Market data is attached ONLY after composite scoring as reference context.
// No market field ever feeds into composite_score or the 1X2 probabilities.

import { LANE_STATUSES } from './evidence-ledger.mjs';
import { computeMatchProbabilities } from './match-probabilities.mjs';
import { computeAdvance } from './advances-model.mjs';
import { findCachedEloRecord } from './elo-baseline.mjs';
import {
  projectTeamGoals,
  buildScoreGrid,
  totalGoalsFromGrid,
  bttsFromGrid,
  spreadCoverFromGrid,
  poisson1x2FromGrid,
  crossCheck1x2,
} from './goal-projection.mjs';

export const LANES = Object.freeze([
  { key: 'match_winner', label: '1X2 Match Result', requires: ['home', 'away'] },
  { key: 'spread_full_game', label: 'Goal Spread (Full Game)', requires: ['home', 'away'] },
  { key: 'total_goals', label: 'Total Goals', requires: ['home', 'away'] },
  { key: 'both_teams_to_score', label: 'Both Teams to Score', requires: ['home', 'away'] },
  { key: 'match_winner_first_half', label: '1X2 (1st Half)', requires: ['home', 'away'], first_half: true },
  { key: 'spread_first_half', label: 'Goal Spread (1st Half)', requires: ['home', 'away'], first_half: true },
  { key: 'total_goals_first_half', label: 'Total Goals (1st Half)', requires: ['home', 'away'], first_half: true },
  { key: 'btts_first_half', label: 'BTTS (1st Half)', requires: ['home', 'away'], first_half: true },
  { key: 'team_to_advance', label: 'Team to Advance', requires: ['home', 'away'], knockout_only: true },
  { key: 'group_qualification', label: 'Group Qualification', requires: ['home', 'away'], group_only: true },
  { key: 'tournament_futures', label: 'Tournament Futures', requires: ['home', 'away'], futures_only: true },
]);

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function round1(n) {
  return n === null || n === undefined ? null : Math.round(n * 10) / 10;
}

function impliedToDecimal(imp) {
  if (imp === null || imp === undefined || imp <= 0 || imp >= 1) return null;
  return round1(1 / imp);
}

function laneSignal(lane, homeLedger, awayLedger, marketContext, isKnockout, lineupConfirmed, probs, goalModel, {
  match = null,
  bracket = null,
  eloBaseline = null,
} = {}) {
  const base = {
    lane: lane.key,
    label: lane.label,
    composite_score_home: homeLedger.composite_score,
    composite_score_away: awayLedger.composite_score,
    posture_home: homeLedger.posture,
    posture_away: awayLedger.posture,
    market_context: null,
    edge_home_pp: null,
    edge_away_pp: null,
    edge_draw_pp: null,
    recommendation: 'NO CLEAR PICK',
    confidence: 'low',
    explanation: '',
  };

  if (lane.knockout_only && !isKnockout) {
    base.recommendation = 'N/A';
    base.explanation = 'Knockout-only lane; not applicable in group stage.';
    return base;
  }

  if (lane.group_only && isKnockout) {
    base.recommendation = 'N/A';
    base.explanation = 'Group-only lane; not applicable in knockout stage.';
    return base;
  }

  // 1st-half lanes: no half-split source data exists. Blocked, not modeled.
  if (lane.first_half) {
    base.recommendation = 'BLOCKED_MODEL_LAYER_MISSING';
    base.explanation = 'No 1st-half model layer (goals/shots by half not sourced). Market shown as reference only; no edge computed.';
    if (marketContext) base.market_context = referenceContext(marketContext);
    return base;
  }

  if (lane.key === 'team_to_advance') {
    const defaultSide = marketContext?.side === 'away' ? 'away' : 'home';
    const teamSide = defaultSide;
    const teamName = teamSide === 'away' ? match?.away_team : match?.home_team;
    const oppName = teamSide === 'away' ? match?.home_team : match?.away_team;
    const teamRecord = findCachedEloRecord(eloBaseline, teamName);
    const oppRecord = findCachedEloRecord(eloBaseline, oppName);
    const derivedBracket = bracket
      ? { ...bracket, team_is_home: teamSide !== 'away' }
      : {
          stage: match?.stage ?? null,
          round: match?.round ?? null,
          next_round: match?.next_round ?? null,
          next_round_label: match?.next_round_label ?? null,
          match_id: match?.match_id ?? null,
          team_is_home: teamSide !== 'away',
        };
    const advance = computeAdvance({
      eloTeam: teamRecord?.elo_rating ?? null,
      eloOpp: oppRecord?.elo_rating ?? null,
      bracket: derivedBracket,
      lineup: { confirmed: lineupConfirmed === true },
      evidence: {
        source: eloBaseline?.source_id ?? null,
        retrieved_at: eloBaseline?.retrieved_at ?? null,
      },
    });

    base.advances = {
      ...advance,
      team_name: teamName ?? null,
      opponent_name: oppName ?? null,
      team_side: teamSide,
      market_context: marketContext ? referenceContext(marketContext) : null,
      cached_elo_source: eloBaseline?.source_id ?? null,
      cached_elo_retrieved_at: eloBaseline?.retrieved_at ?? null,
      team_elo: teamRecord?.elo_rating ?? null,
      opponent_elo: oppRecord?.elo_rating ?? null,
    };
    base.advance_team_name = teamName ?? null;
    base.advance_opponent_name = oppName ?? null;
    base.advance_team_side = teamSide;
    base.market_context = marketContext ? referenceContext(marketContext) : null;
    base.recommendation = advance.status === 'READY'
      ? (advance.p_advance >= 0.58
        ? `PICK_${teamSide.toUpperCase()}`
        : advance.p_advance >= 0.53
          ? `LEAN_${teamSide.toUpperCase()}`
          : 'WATCH')
      : advance.status;
    base.confidence = advance.status === 'READY' ? (advance.p_advance >= 0.58 ? 'medium' : 'low') : 'low';
    base.explanation = advance.status === 'READY'
      ? `${teamName} advances probability ${(advance.p_advance * 100).toFixed(0)}% via ${advance.model_mode}; includes extra time and penalties.`
      : `Advances model ${advance.status}${advance.missing_inputs?.length ? `; missing ${advance.missing_inputs.join(', ')}` : ''}.`;
    return base;
  }

  const homeScore = homeLedger.composite_score ?? 50;
  const awayScore = awayLedger.composite_score ?? 50;
  const diff = homeScore - awayScore;

  // Goal spread lane (full game) — Poisson cover probability from the score grid.
  if (lane.key === 'spread_full_game') {
    if (!goalModel?.ok) {
      base.recommendation = 'BLOCKED_MODEL_LAYER_MISSING';
      base.explanation = 'No goal projection (attack/defense layers missing); cannot evaluate goal spreads.';
      if (marketContext) base.market_context = referenceContext(marketContext);
      return base;
    }
    const line = marketContext?.line ?? null;
    const side = marketContext?.side ?? null;
    const spread = spreadCoverFromGrid({
      grid: goalModel.grid,
      projectedMargin: goalModel.projection.projected_goal_margin_home,
      line,
      side,
    });
    base.projected_goal_margin_home = spread.projected_margin_home;
    base.p_cover = spread.p_cover;
    base.spread_line = spread.line;
    base.spread_side = spread.side;
    base.recommendation = spread.margin_only ? 'WATCH' : spread.status;
    base.confidence = !spread.margin_only && (spread.p_cover >= 0.68 || spread.p_cover <= 0.32) ? 'medium' : 'low';
    base.explanation = spread.margin_only
      ? `Projected goal margin ${spread.projected_margin_home} (home-positive). No parsed goal line to compare — margin-only, no cover probability.`
      : `Projected margin ${spread.projected_margin_home}; P(cover ${side} ${line}) = ${(spread.p_cover * 100).toFixed(0)}% from Poisson grid.`;
  }

  // 1X2 match result lane
  if (lane.key === 'match_winner') {
    if (probs?.ok) {
      base.p_home = probs.p_home;
      base.p_draw = probs.p_draw;
      base.p_away = probs.p_away;
      base.winner_lean = probs.winner_lean;
      base.draw_risk = probs.draw_risk;
      base.draw_evaluation = probs.draw_evaluation;
      base.draw_rationale = probs.draw_rationale;
      // Poisson 1X2 cross-check (logistic stays primary; this is a flag only).
      if (goalModel?.ok) {
        base.poisson_1x2 = goalModel.poisson_1x2;
        base.cross_check_1x2 = goalModel.cross_check_1x2;
      }
    } else {
      base.draw_evaluation = 'BLOCKED_MODEL_LAYER_MISSING';
    }
    if (diff > 8) {
      base.recommendation = homeLedger.posture === 'PICK' ? 'PICK_HOME' : 'LEAN_HOME';
      base.confidence = homeLedger.confidence;
      base.explanation = `Home favored by ${diff} composite points. ${homeLedger.posture}`;
    } else if (diff < -8) {
      base.recommendation = awayLedger.posture === 'PICK' ? 'PICK_AWAY' : 'LEAN_AWAY';
      base.confidence = awayLedger.confidence;
      base.explanation = `Away favored by ${Math.abs(diff)} composite points. ${awayLedger.posture}`;
    } else if (probs?.ok && probs.draw_evaluation === 'ACTIONABLE'
      && probs.p_draw >= probs.p_home && probs.p_draw >= probs.p_away) {
      // Draw read requires the explicit-support gate — never close-strength alone.
      base.recommendation = 'LEAN_DRAW';
      base.confidence = 'medium';
      base.explanation = `Draw actionable: ${probs.draw_rationale.join('; ')}.`;
    } else {
      base.recommendation = 'WATCH';
      base.confidence = 'low';
      base.explanation = `Composite diff ${diff} within noise band${probs?.ok ? ` (draw risk ${probs.draw_risk}, ${probs.draw_evaluation})` : ''}.`;
    }
    // Pre-lineup confidence downgrade: never emit a full PICK before lineups confirm.
    if (!lineupConfirmed && base.recommendation.startsWith('PICK')) {
      base.recommendation = base.recommendation.replace('PICK', 'LEAN');
      base.explanation += ' Downgraded from PICK: lineups not confirmed.';
    }
  }

  // Total goals lane (full game) — Poisson over/under from the score grid.
  // Requires real attack/defense layers — missing layers BLOCK, never default.
  if (lane.key === 'total_goals') {
    if (!goalModel?.ok) {
      base.recommendation = 'BLOCKED_MODEL_LAYER_MISSING';
      base.explanation = 'No goal projection (attack/defense layers missing); cannot evaluate totals.';
      if (marketContext) base.market_context = referenceContext(marketContext);
      return base;
    }
    const line = marketContext?.line ?? null;
    const total = totalGoalsFromGrid({
      grid: goalModel.grid,
      projectedTotal: goalModel.projection.projected_total_goals,
      line,
    });
    base.projected_total_goals = total.projected_total;
    base.p_over = total.p_over;
    base.p_under = total.p_under;
    base.total_line = total.line;
    if (total.projection_only) {
      base.recommendation = 'WATCH';
      base.confidence = 'low';
      base.explanation = `Projected total ${total.projected_total} goals. No total line parsed — projection-only (no over/under probability).`;
    } else {
      base.recommendation = total.status === 'WATCH' ? 'WATCH' : `${total.status}_${total.side}`;
      base.confidence = total.status === 'PICK' ? 'medium' : 'low';
      base.explanation = `Projected total ${total.projected_total}; P(over ${line}) = ${(total.p_over * 100).toFixed(0)}%, P(under ${line}) = ${(total.p_under * 100).toFixed(0)}% from Poisson grid. Status ${total.status}.`;
    }
  }

  // Both teams to score (full game) — Poisson P(Yes) from the score grid.
  if (lane.key === 'both_teams_to_score') {
    if (!goalModel?.ok) {
      base.recommendation = 'BLOCKED_MODEL_LAYER_MISSING';
      base.explanation = 'Attack/defense layers missing on at least one side; cannot evaluate BTTS.';
      if (marketContext) base.market_context = referenceContext(marketContext);
      return base;
    }
    const btts = goalModel.btts;
    base.p_btts_yes = btts.p_yes;
    base.p_btts_no = btts.p_no;
    base.recommendation = btts.status === 'WATCH' ? 'WATCH'
      : btts.status.endsWith('YES') ? 'YES' : 'NO';
    base.confidence = btts.status.startsWith('PICK') ? 'medium' : 'low';
    base.explanation = `BTTS P(Yes) = ${(btts.p_yes * 100).toFixed(0)}% (P(No) = ${(btts.p_no * 100).toFixed(0)}%) from Poisson grid: 1 - P(home=0) - P(away=0) + P(0-0). Status ${btts.status}.`;
  }

  // Attach market context AFTER composite scoring
  if (marketContext) {
    base.market_context = referenceContext(marketContext);

    // Edge ONLY when a model fair probability exists (1X2 lane, probs.ok).
    const imp = base.market_context?.implied_probability ?? null;
    if (lane.key === 'match_winner' && imp !== null && probs?.ok) {
      const side = marketContext.side ?? 'home'; // unparsed legacy contracts price the home side
      const modelProbForSide = side === 'home' ? probs.p_home : side === 'away' ? probs.p_away : probs.p_draw;
      const edge = round1((modelProbForSide - imp) * 100);
      if (side === 'home') {
        base.edge_home_pp = edge;
        base.edge_away_pp = round1((probs.p_away - (1 - imp)) * 100);
      } else if (side === 'away') {
        base.edge_away_pp = edge;
      } else {
        base.edge_draw_pp = edge;
      }
    }
  }

  return base;
}

function referenceContext(mc) {
  return {
    ticker: mc.ticker ?? null,
    title: mc.title ?? null,
    market_family: mc.market_family ?? null,
    period: mc.period ?? null,
    side: mc.side ?? null,
    line: mc.line ?? null,
    settlement: mc.settlement ?? null,
    normalized_target: mc.normalized_target ?? null,
    implied_probability: mc.implied_probability ?? null,
  };
}

export function composeMultiLaneCeilingBoard({
  homeLedger,
  awayLedger,
  marketContexts = [],
  isKnockout = false,
  lineupConfirmed = false,
  drawIncentive = false,
  match = null,
  bracket = null,
  eloBaseline = null,
} = {}) {
  // 1X2 probabilities computed from ledgers BEFORE any market attachment.
  const probs = computeMatchProbabilities({ homeLedger, awayLedger, drawIncentive });

  // Projected team goals + Poisson score grid (market-free). The grid is the
  // single source for the derived goal lanes (total / BTTS / spread) and the
  // Poisson 1X2 cross-check. Built ONCE per match from attack/defense layers;
  // no market line/price enters the projection.
  const projection = projectTeamGoals({ homeLedger, awayLedger });
  let goalModel = { ok: false, projection };
  if (projection.projection_status === 'PROJECTED') {
    const gridRes = buildScoreGrid({ lambdaHome: projection.lambda_home, lambdaAway: projection.lambda_away });
    if (gridRes.ok) {
      const poisson = poisson1x2FromGrid({ grid: gridRes.grid });
      goalModel = {
        ok: true,
        projection,
        grid: gridRes.grid,
        grid_sum: gridRes.sum_raw,
        btts: bttsFromGrid({ grid: gridRes.grid }),
        poisson_1x2: poisson,
        cross_check_1x2: crossCheck1x2({
          logistic: probs.ok ? { p_home: probs.p_home, p_draw: probs.p_draw, p_away: probs.p_away } : null,
          poisson,
        }),
      };
    }
  }

  const lanes = LANES.map(lane => {
    const mc = marketContexts.find(m => m.market_type === lane.key)
      || (lane.key === 'match_winner'
        ? marketContexts.find(m => !m.market_type || m.market_type === 'match_winner')
        : null)
      || null;
    return laneSignal(lane, homeLedger, awayLedger, mc, isKnockout, lineupConfirmed, probs, goalModel, { match, bracket, eloBaseline });
  });

  const advancesLane = lanes.find((lane) => lane.lane === 'team_to_advance') ?? null;

  const pickLanes = lanes.filter(l => l.recommendation.startsWith('PICK'));
  const leanLanes = lanes.filter(l => l.recommendation.startsWith('LEAN'));
  const watchLanes = lanes.filter(l => l.recommendation === 'WATCH');

  return {
    lanes,
    advances: advancesLane?.advances ?? null,
    pick_count: pickLanes.length,
    lean_count: leanLanes.length,
    watch_count: watchLanes.length,
    top_recommendations: [...pickLanes, ...leanLanes].slice(0, 3),
    overall_confidence: homeLedger.confidence === 'high' && awayLedger.confidence === 'high'
      ? 'high'
      : homeLedger.confidence === 'low' && awayLedger.confidence === 'low'
      ? 'low'
      : 'medium',
    is_knockout: isKnockout,
    probabilities: probs.ok ? {
      p_home: probs.p_home,
      p_draw: probs.p_draw,
      p_away: probs.p_away,
      winner_lean: probs.winner_lean,
      draw_risk: probs.draw_risk,
      draw_evaluation: probs.draw_evaluation,
      draw_rationale: probs.draw_rationale,
      goal_environment: probs.goal_environment,
    } : { blocked_reason: probs.blocked_reason, draw_evaluation: probs.draw_evaluation },
    goal_projection: goalModel.ok ? {
      projected_home_goals: goalModel.projection.projected_home_goals,
      projected_away_goals: goalModel.projection.projected_away_goals,
      projected_total_goals: goalModel.projection.projected_total_goals,
      projected_goal_margin_home: goalModel.projection.projected_goal_margin_home,
      grid_sum: goalModel.grid_sum,
      poisson_1x2: goalModel.poisson_1x2,
      cross_check_1x2: goalModel.cross_check_1x2,
      projection_status: 'PROJECTED',
    } : { projection_status: goalModel.projection.projection_status, reason: goalModel.projection.reason },
    composite_score_home: homeLedger.composite_score,
    composite_score_away: awayLedger.composite_score,
    layers_present_home: homeLedger.layers_present ?? 0,
    layers_present_away: awayLedger.layers_present ?? 0,
    layers_total: homeLedger.layers_total ?? 14,
    explanation: `Home ${homeLedger.composite_score ?? 'MISSING'} vs Away ${awayLedger.composite_score ?? 'MISSING'}`,
  };
}
