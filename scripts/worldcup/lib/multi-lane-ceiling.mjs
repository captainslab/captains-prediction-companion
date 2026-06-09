// World Cup multi-lane ceiling board.
// Maps composite evidence ledgers to per-market-lane signals.
//
// Lanes:
//   1. match_winner (moneyline style)
//   2. team_to_advance (knockout progression)
//   3. total_goals (over-under)
//   4. both_teams_to_score
//   5. group_qualification (group stage only)
//   6. tournament_futures (if supported)
//
// Market data is attached ONLY after composite scoring as reference context.
// No market field ever feeds into composite_score.

import { LANE_STATUSES } from './evidence-ledger.mjs';

export const LANES = Object.freeze([
  { key: 'match_winner', label: 'Match Winner', requires: ['home', 'away'] },
  { key: 'team_to_advance', label: 'Team to Advance', requires: ['home', 'away'], knockout_only: true },
  { key: 'total_goals', label: 'Total Goals', requires: ['home', 'away'] },
  { key: 'both_teams_to_score', label: 'Both Teams to Score', requires: ['home', 'away'] },
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

function laneSignal(lane, homeLedger, awayLedger, marketContext, isKnockout, lineupConfirmed) {
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

  const homeScore = homeLedger.composite_score ?? 50;
  const awayScore = awayLedger.composite_score ?? 50;
  const diff = homeScore - awayScore;

  // Match winner lane
  if (lane.key === 'match_winner') {
    if (diff > 8) {
      base.recommendation = homeLedger.posture === 'PICK' ? 'PICK_HOME' : 'LEAN_HOME';
      base.confidence = homeLedger.confidence;
      base.explanation = `Home favored by ${diff} composite points. ${homeLedger.posture}`;
    } else if (diff < -8) {
      base.recommendation = awayLedger.posture === 'PICK' ? 'PICK_AWAY' : 'LEAN_AWAY';
      base.confidence = awayLedger.confidence;
      base.explanation = `Away favored by ${Math.abs(diff)} composite points. ${awayLedger.posture}`;
    } else {
      base.recommendation = 'WATCH';
      base.confidence = 'low';
      base.explanation = `Composite diff ${diff} within noise band.`;
    }
    // Pre-lineup confidence downgrade: never emit a full PICK before lineups confirm.
    if (!lineupConfirmed && base.recommendation.startsWith('PICK')) {
      base.recommendation = base.recommendation.replace('PICK', 'LEAN');
      base.explanation += ' Downgraded from PICK: lineups not confirmed.';
    }
  }

  // Total goals lane (heuristic from attack/defense balance)
  if (lane.key === 'total_goals') {
    const attackSum = (homeLedger.layers.find(l => l.key === 'attacking_strength')?.score ?? 50)
      + (awayLedger.layers.find(l => l.key === 'attacking_strength')?.score ?? 50);
    const defenseSum = (homeLedger.layers.find(l => l.key === 'defensive_strength')?.score ?? 50)
      + (awayLedger.layers.find(l => l.key === 'defensive_strength')?.score ?? 50);
    const goalExpectancy = (attackSum - defenseSum + 100) / 50; // rough heuristic
    base.recommendation = goalExpectancy > 2.8 ? 'OVER' : goalExpectancy < 2.2 ? 'UNDER' : 'WATCH';
    base.confidence = goalExpectancy > 3.2 || goalExpectancy < 1.8 ? 'medium' : 'low';
    base.explanation = `Goal expectancy ~${round1(goalExpectancy)} from attack/defense balance.`;
  }

  // Both teams to score
  if (lane.key === 'both_teams_to_score') {
    const homeAttack = homeLedger.layers.find(l => l.key === 'attacking_strength')?.score ?? 50;
    const awayAttack = awayLedger.layers.find(l => l.key === 'attacking_strength')?.score ?? 50;
    const homeDefense = homeLedger.layers.find(l => l.key === 'defensive_strength')?.score ?? 50;
    const awayDefense = awayLedger.layers.find(l => l.key === 'defensive_strength')?.score ?? 50;
    const homeBtsc = (homeAttack + (100 - awayDefense)) / 2;
    const awayBtsc = (awayAttack + (100 - homeDefense)) / 2;
    const avg = (homeBtsc + awayBtsc) / 2;
    base.recommendation = avg > 60 ? 'YES' : avg < 40 ? 'NO' : 'WATCH';
    base.confidence = avg > 70 || avg < 30 ? 'medium' : 'low';
    base.explanation = `BTTS model ~${round1(avg)} from attack vs opponent defense.`;
  }

  // Attach market context AFTER composite scoring
  if (marketContext) {
    base.market_context = {
      ticker: marketContext.ticker ?? null,
      title: marketContext.title ?? null,
      implied_probability: marketContext.implied_probability ?? null,
    };

    // Edge only if we have a model probability
    const imp = base.market_context?.implied_probability ?? null;
    if (lane.key === 'match_winner' && imp !== null) {
      const homeImp = imp;
      const awayImp = 1 - homeImp;
      const homeModelProb = clamp((homeScore / 100), 0.01, 0.99);
      const awayModelProb = clamp((awayScore / 100), 0.01, 0.99);
      base.edge_home_pp = round1((homeModelProb - homeImp) * 100);
      base.edge_away_pp = round1((awayModelProb - awayImp) * 100);
    }
  }

  return base;
}

export function composeMultiLaneCeilingBoard({
  homeLedger,
  awayLedger,
  marketContexts = [],
  isKnockout = false,
  lineupConfirmed = false,
} = {}) {
  const lanes = LANES.map(lane => {
    const mc = marketContexts.find(m => m.market_type === lane.key) || marketContexts[0] || null;
    return laneSignal(lane, homeLedger, awayLedger, mc, isKnockout, lineupConfirmed);
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
    composite_score_home: homeLedger.composite_score,
    composite_score_away: awayLedger.composite_score,
    layers_present_home: homeLedger.layers_present ?? 0,
    layers_present_away: awayLedger.layers_present ?? 0,
    layers_total: homeLedger.layers_total ?? 14,
    explanation: `Home ${homeLedger.composite_score ?? 'MISSING'} vs Away ${awayLedger.composite_score ?? 'MISSING'}`,
  };
}
