// World Cup evidence ledger — 14-layer composite per match side.
//
// Mirrors scripts/mlb/lib/evidence-ledger.mjs for World Cup matches.
// Produces one evidence ledger per SIDE (home / away) of a matchup,
// then derives per-lane ceiling signals from the side differentials.
//
// Layers                          Weight  Source / rationale
//  1. team_quality_baseline        0.20   FIFA ranking / Elo. International football has the
//                                         widest talent spread of any major competition; the
//                                         Elo gap is the single strongest outcome predictor.
//  2. recent_form                  0.05   Deliberately LOW: international form = friendlies +
//                                         rotated qualifier squads. Noisy, weak signal.
//  3. attacking_strength           0.07   Goals scored / xG / shot quality.
//  4. defensive_strength           0.08   Slightly above attack: tournament football is
//                                         low-scoring; defensive solidity travels better.
//  5. opponent_adjusted_attack     0.09   Attack vs THIS opponent's defense (UFC-style).
//  6. opponent_adjusted_defense    0.09   Defense vs THIS opponent's attack.
//  7. opponent_style_fit           0.05   Press/possession asymmetry; real but hard to measure.
//  8. set_piece_matchup            0.06   ~30% of World Cup goals are set-piece derived and it
//                                         is the most stable team skill over a short tournament.
//  9. goalkeeper_edge              0.04   Matters most in tight/knockout games.
// 10. squad_availability           0.08   Tournaments are attrition contests; one missing
//                                         talisman moves win probability more than form.
// 11. lineup_strength_delta        0.06   Confirmed XI vs expected XI; round-3 group rotation
//                                         is a known result-mover.
// 12. rest_travel_venue_climate    0.06   2026-specific: three host countries, Mexico City
//                                         altitude (2,240m), June heat, long travel legs.
// 13. tournament_incentive_state   0.05   Dead rubbers / playing-for-a-draw / seeding angles.
// 14. knockout_extra_time_penalty  0.02   Shootouts are near coin-flips; only a sliver of
//                                         persistent edge (GK, taker quality). Knockout only.
//
// Weights sum to 1.00 exactly. Weights are first-principles analyst priors,
// NOT fitted parameters and NOT equal-weight defaults; revisit after grading
// real 2026 results (post-match grade cron).
// Missing layers are renormalized out automatically (same pattern as MLB).
//
// Data coverage caps (see dataQualityCap):
//   0 layers   → NO CLEAR PICK
//   1-3 layers → max WATCH
//   4-6 layers → max LEAN
//   7-9 layers → max EVIDENCE_LEAN
//   10+ layers → PICK eligible
//
// Pure ESM. No I/O. No live network. No market price input.

export const LANE_STATUSES = Object.freeze([
  'PICK', 'EVIDENCE_LEAN', 'LEAN', 'WATCH', 'NO CLEAR PICK', 'MARKET_ONLY',
]);

export const LAYER_DEFS = Object.freeze([
  { key: 'team_quality_baseline',        weight: 0.20, label: 'FIFA ranking / Elo baseline' },
  { key: 'recent_form',                  weight: 0.05, label: 'Last 5-10 international results' },
  { key: 'attacking_strength',           weight: 0.07, label: 'Goals scored / xG / shot quality' },
  { key: 'defensive_strength',           weight: 0.08, label: 'Goals conceded / xGA / shot suppression' },
  { key: 'opponent_adjusted_attack',     weight: 0.09, label: 'Attack vs opponent defense (opponent-adjusted)' },
  { key: 'opponent_adjusted_defense',    weight: 0.09, label: 'Defense vs opponent attack (opponent-adjusted)' },
  { key: 'opponent_style_fit',           weight: 0.05, label: 'Possession/pressing vs opponent buildup fit' },
  { key: 'set_piece_matchup',            weight: 0.06, label: 'Set-piece attack vs opponent set-piece defense' },
  { key: 'goalkeeper_edge',              weight: 0.04, label: 'Goalkeeper shot-stopping vs opponent chance quality' },
  { key: 'squad_availability',           weight: 0.08, label: 'Injuries / suspensions / squad depth' },
  { key: 'lineup_strength_delta',        weight: 0.06, label: 'Confirmed XI vs expected XI strength' },
  { key: 'rest_travel_venue_climate',    weight: 0.06, label: 'Rest days / travel / altitude / climate' },
  { key: 'tournament_incentive_state',   weight: 0.05, label: 'Group standing / knockout incentive / rotation risk' },
  { key: 'knockout_extra_time_penalty',  weight: 0.02, label: 'Extra time / penalty history (knockout only)' },
]);

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function gradeLabel(s) {
  if (s === null || s === undefined) return 'n/a';
  if (s >= 80) return 'A';
  if (s >= 70) return 'B';
  if (s >= 60) return 'C';
  if (s >= 45) return 'D';
  return 'F';
}

function evalLayer(layerDef, sideEntry) {
  const rec = sideEntry?.[layerDef.key];
  if (!rec || rec.present !== true || rec.score === null || rec.score === undefined) {
    return {
      present: false,
      score: null,
      grade: 'n/a',
      basis: layerDef.label,
      missing_note: rec?.missing_reason ?? `no ${layerDef.key} data for this team`,
    };
  }
  const score = clamp(Number(rec.score), 0, 100);
  return {
    present: true,
    score,
    grade: gradeLabel(score),
    basis: rec.basis ?? layerDef.label,
    detail: rec.detail ?? null,
    missing_note: null,
  };
}

function dataQualityCap(presentCount) {
  if (presentCount >= 10) return { max: 'PICK', label: 'PICK' };
  if (presentCount >= 7)  return { max: 'EVIDENCE_LEAN', label: 'EVIDENCE_LEAN' };
  if (presentCount >= 4)  return { max: 'LEAN', label: 'LEAN' };
  if (presentCount >= 1)  return { max: 'WATCH', label: 'WATCH' };
  return { max: 'NO CLEAR PICK', label: 'NO CLEAR PICK' };
}

function postureFromScore(score, capLabel) {
  if (capLabel === 'NO CLEAR PICK') return 'NO CLEAR PICK';
  if (score >= 78) return capLabel === 'PICK' ? 'PICK' : capLabel;
  if (score >= 68) return capLabel === 'PICK' || capLabel === 'EVIDENCE_LEAN' ? 'EVIDENCE_LEAN' : capLabel;
  if (score >= 58) return 'LEAN';
  if (score >= 48) return 'WATCH';
  return 'NO CLEAR PICK';
}

export function composeEvidenceLedgerForSide(sideEntry, { isKnockout = false } = {}) {
  const layers = [];
  let presentCount = 0;
  let totalWeight = 0;
  let weightedSum = 0;

  for (const def of LAYER_DEFS) {
    // Knockout-only layer: skip in group stage
    if (def.key === 'knockout_extra_time_penalty' && !isKnockout) {
      layers.push({
        key: def.key,
        present: false,
        score: null,
        grade: 'n/a',
        basis: def.label,
        missing_note: 'group stage — knockout layer not applicable',
      });
      continue;
    }

    const ev = evalLayer(def, sideEntry);
    layers.push({ key: def.key, ...ev });
    if (ev.present) {
      presentCount += 1;
      totalWeight += def.weight;
      weightedSum += ev.score * def.weight;
    }
  }

  const compositeScore = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : null;
  const cap = dataQualityCap(presentCount);
  const posture = compositeScore !== null ? postureFromScore(compositeScore, cap.max) : 'NO CLEAR PICK';

  return {
    composite_score: compositeScore,
    posture,
    confidence: presentCount >= 10 ? 'high' : presentCount >= 6 ? 'medium' : 'low',
    layers_present: presentCount,
    layers_total: LAYER_DEFS.length,
    top_supporting_layers: layers
      .filter(l => l.present)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 3)
      .map(l => ({ key: l.key, score: l.score, basis: l.basis })),
    missing_layers: layers
      .filter(l => !l.present)
      .map(l => ({ key: l.key, basis: l.basis, note: l.missing_note })),
    blocker_if_any: presentCount < 4 ? `Only ${presentCount} layer(s) present; need 4+ for LEAN` : null,
    layers,
  };
}

export function composeEvidenceLedgerForGame(homeEntry, awayEntry, { isKnockout = false } = {}) {
  const homeLedger = composeEvidenceLedgerForSide(homeEntry, { isKnockout });
  const awayLedger = composeEvidenceLedgerForSide(awayEntry, { isKnockout });

  const diff = (homeLedger.composite_score ?? 50) - (awayLedger.composite_score ?? 50);

  return {
    home: homeLedger,
    away: awayLedger,
    differential: diff,
    favored_side: diff > 5 ? 'home' : diff < -5 ? 'away' : 'even',
    explanation: `Home composite ${homeLedger.composite_score ?? 'MISSING'} vs Away composite ${awayLedger.composite_score ?? 'MISSING'} (diff ${diff > 0 ? '+' : ''}${diff})`,
  };
}
