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

function laneSignal(lane, homeLedger, awayLedger, marketContext, isKnockout, lineupConfirmed, probs) {
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

  const homeScore = homeLedger.composite_score ?? 50;
  const awayScore = awayLedger.composite_score ?? 50;
  const diff = homeScore - awayScore;

  // Goal spread lane (full game) — proxy margin only, no cover probability.
  if (lane.key === 'spread_full_game') {
    const env = probs?.ok ? probs.goal_environment : null;
    if (!env) {
      base.recommendation = 'BLOCKED_MODEL_LAYER_MISSING';
      base.explanation = 'No goal-environment proxy (attack/defense layers missing); cannot evaluate goal lines.';
    } else {
      const line = marketContext?.line ?? null;
      const side = marketContext?.side ?? null;
      if (line !== null && (side === 'home' || side === 'away')) {
        const coverMargin = side === 'home' ? env.expected_margin - line : -env.expected_margin - line;
        base.recommendation = coverMargin >= 0.8 ? `LEAN_COVER_${side.toUpperCase()}`
          : coverMargin <= -0.8 ? 'LEAN_FADE' : 'WATCH';
        base.explanation = `Expected margin ${env.expected_margin} vs ${side} line ${line} (proxy margin, no cover probability — no pp edge).`;
      } else {
        base.recommendation = 'WATCH';
        base.explanation = `Expected margin proxy ${env.expected_margin} (home-positive). No parsed goal line to compare.`;
      }
      base.confidence = 'low';
    }
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

  // Total goals lane (full game, heuristic from attack/defense balance).
  // Requires real attack/defense layers — missing layers BLOCK, never default.
  if (lane.key === 'total_goals') {
    const env = probs?.ok ? probs.goal_environment : null;
    if (!env) {
      base.recommendation = 'BLOCKED_MODEL_LAYER_MISSING';
      base.explanation = 'No goal-environment proxy (attack/defense layers missing); cannot evaluate totals.';
      if (marketContext) base.market_context = referenceContext(marketContext);
      return base;
    }
    const goalExpectancy = env.xg_total;
    const line = marketContext?.line ?? null;
    base.recommendation = goalExpectancy > 2.8 ? 'OVER' : goalExpectancy < 2.2 ? 'UNDER' : 'WATCH';
    base.confidence = goalExpectancy > 3.2 || goalExpectancy < 1.8 ? 'medium' : 'low';
    base.explanation = `Goal expectancy ~${round1(goalExpectancy)} from attack/defense balance${line !== null ? ` vs market line ${line}` : ''}. Proxy only — no over/under probability, no pp edge.`;
  }

  // Both teams to score (full game). Same no-default rule.
  if (lane.key === 'both_teams_to_score') {
    const homeAttack = homeLedger.layers.find(l => l.key === 'attacking_strength' && l.present)?.score ?? null;
    const awayAttack = awayLedger.layers.find(l => l.key === 'attacking_strength' && l.present)?.score ?? null;
    const homeDefense = homeLedger.layers.find(l => l.key === 'defensive_strength' && l.present)?.score ?? null;
    const awayDefense = awayLedger.layers.find(l => l.key === 'defensive_strength' && l.present)?.score ?? null;
    if (homeAttack === null || awayAttack === null || homeDefense === null || awayDefense === null) {
      base.recommendation = 'BLOCKED_MODEL_LAYER_MISSING';
      base.explanation = 'Attack/defense layers missing on at least one side; cannot evaluate BTTS.';
      if (marketContext) base.market_context = referenceContext(marketContext);
      return base;
    }
    const homeBtsc = (homeAttack + (100 - awayDefense)) / 2;
    const awayBtsc = (awayAttack + (100 - homeDefense)) / 2;
    const avg = (homeBtsc + awayBtsc) / 2;
    base.recommendation = avg > 60 ? 'YES' : avg < 40 ? 'NO' : 'WATCH';
    base.confidence = avg > 70 || avg < 30 ? 'medium' : 'low';
    base.explanation = `BTTS model ~${round1(avg)} from attack vs opponent defense. Proxy only — no pp edge.`;
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
} = {}) {
  // 1X2 probabilities computed from ledgers BEFORE any market attachment.
  const probs = computeMatchProbabilities({ homeLedger, awayLedger, drawIncentive });

  const lanes = LANES.map(lane => {
    const mc = marketContexts.find(m => m.market_type === lane.key)
      || (lane.key === 'match_winner'
        ? marketContexts.find(m => !m.market_type || m.market_type === 'match_winner')
        : null)
      || null;
    return laneSignal(lane, homeLedger, awayLedger, mc, isKnockout, lineupConfirmed, probs);
  });

  const pickLanes = lanes.filter(l => l.recommendation.startsWith('PICK'));
  const leanLanes = lanes.filter(l => l.recommendation.startsWith('LEAN'));
  const watchLanes = lanes.filter(l => l.recommendation === 'WATCH');

  return {
    lanes,
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
    composite_score_home: homeLedger.composite_score,
    composite_score_away: awayLedger.composite_score,
    layers_present_home: homeLedger.layers_present ?? 0,
    layers_present_away: awayLedger.layers_present ?? 0,
    layers_total: homeLedger.layers_total ?? 14,
    explanation: `Home ${homeLedger.composite_score ?? 'MISSING'} vs Away ${awayLedger.composite_score ?? 'MISSING'}`,
  };
}
