// World Cup match outcome probabilities (1X2) + goal-environment proxies.
//
// Inputs: composite evidence ledgers ONLY (home + away). No market field is
// read here — probabilities exist BEFORE any market context is attached, so
// edge = model probability − market implied is strictly post-model.
//
// Draw doctrine:
//   Draw is a valid model read but never a lazy default for close matches.
//   A Draw read is ACTIONABLE only with explicit supports:
//     REQUIRED: narrow strength gap AND low expected-goal environment
//     PLUS at least one of: defensive/style matchup, draw incentive,
//     scoring-suppression context (rest/travel/venue/climate present & poor).
//   Close team strength alone → WATCH_ONLY (draw risk shown, not picked).
//   Missing attack/defense layers → BLOCKED_MODEL_LAYER_MISSING (no xG proxy,
//   no draw evaluation, no fabricated probabilities for derivative lanes).
//
// Calibration anchors (documented priors, revisit against grades):
//   - World Cup group-stage draw base rate ≈ 22% → base 0.22
//   - low-xG and narrow-gap boosts capped so p_draw ∈ [0.10, 0.42]

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function layerScore(ledger, key) {
  const l = (ledger?.layers || []).find(x => x.key === key);
  return l && l.present ? l.score : null;
}

/**
 * Goal-environment proxy from attack/defense layers (same heuristic family
 * as the total_goals lane). Returns null when layers are missing — callers
 * must treat null as BLOCKED, never default it.
 */
export function goalEnvironmentProxy(homeLedger, awayLedger) {
  const ha = layerScore(homeLedger, 'attacking_strength');
  const aa = layerScore(awayLedger, 'attacking_strength');
  const hd = layerScore(homeLedger, 'defensive_strength');
  const ad = layerScore(awayLedger, 'defensive_strength');
  if (ha === null || aa === null || hd === null || ad === null) return null;

  const xgTotal = clamp((ha + aa - hd - ad + 100) / 50, 0.4, 5.0);
  // Split by attacking propensity vs the opposing defense.
  const homePropensity = (ha + (100 - ad)) / 2;
  const awayPropensity = (aa + (100 - hd)) / 2;
  const homeShare = homePropensity / (homePropensity + awayPropensity);
  return {
    xg_total: round2(xgTotal),
    xg_home: round2(xgTotal * homeShare),
    xg_away: round2(xgTotal * (1 - homeShare)),
    expected_margin: round2(xgTotal * homeShare - xgTotal * (1 - homeShare)),
    basis: 'attack/defense layer heuristic proxy (not a fitted xG model)',
  };
}

function round2(n) { return Math.round(n * 100) / 100; }
function round3(n) { return Math.round(n * 1000) / 1000; }

/**
 * Compute 1X2 probabilities + draw evaluation from ledgers only.
 *
 * options.drawIncentive: caller-supplied flag for group-table draw incentive
 * (e.g. final group matchday where a point suits both). Defaults false.
 */
export function computeMatchProbabilities({ homeLedger, awayLedger, drawIncentive = false } = {}) {
  const hs = homeLedger?.composite_score ?? null;
  const as_ = awayLedger?.composite_score ?? null;
  if (hs === null || as_ === null) {
    return {
      ok: false,
      blocked_reason: 'composite score missing for at least one side',
      draw_evaluation: 'BLOCKED_MODEL_LAYER_MISSING',
    };
  }

  const diff = hs - as_;
  const env = goalEnvironmentProxy(homeLedger, awayLedger);

  // --- Draw probability ---
  // Without a goal environment the draw read is blocked; fall back to the
  // base rate for the headline split but mark the evaluation blocked.
  const narrowGapBoost = 0.08 * clamp((8 - Math.abs(diff)) / 8, 0, 1);
  const lowXgBoost = env ? 0.08 * clamp((2.6 - env.xg_total) / 1.2, 0, 1) : 0;
  const blowoutSuppression = 0.06 * clamp((Math.abs(diff) - 15) / 20, 0, 1);

  const homeDef = layerScore(homeLedger, 'defensive_strength');
  const homeAtk = layerScore(homeLedger, 'attacking_strength');
  const awayDef = layerScore(awayLedger, 'defensive_strength');
  const awayAtk = layerScore(awayLedger, 'attacking_strength');
  const defensiveMatchup = homeDef !== null && awayDef !== null && homeAtk !== null && awayAtk !== null
    && homeDef >= homeAtk && awayDef >= awayAtk;

  // Suppression support requires the rest/travel/venue/climate layer to show
  // genuinely poor conditions for BOTH sides — mere presence is not support.
  const homeRest = layerScore(homeLedger, 'rest_travel_venue_climate');
  const awayRest = layerScore(awayLedger, 'rest_travel_venue_climate');
  const suppressionContext = homeRest !== null && awayRest !== null && homeRest <= 45 && awayRest <= 45;

  const pDraw = clamp(
    0.22 + narrowGapBoost + lowXgBoost + (defensiveMatchup ? 0.04 : 0) + (drawIncentive ? 0.05 : 0) - blowoutSuppression,
    0.10, 0.42,
  );

  // --- Decisive split (logistic on composite diff) ---
  const pHomeGivenDecisive = 1 / (1 + Math.exp(-diff / 10));
  const pHome = (1 - pDraw) * pHomeGivenDecisive;
  const pAway = 1 - pDraw - pHome;

  // --- Draw evaluation gate (explicit supports, never a lazy default) ---
  const narrowGap = Math.abs(diff) <= 6;
  const lowXg = env !== null && env.xg_total <= 2.3;
  const secondarySupport = defensiveMatchup || drawIncentive || suppressionContext;

  const rationale = [];
  if (narrowGap) rationale.push(`narrow strength gap (|diff|=${Math.abs(diff)})`);
  if (env === null) rationale.push('goal environment UNAVAILABLE (attack/defense layers missing)');
  else rationale.push(`goal environment ${env.xg_total} ${lowXg ? '(low — supports draw)' : '(not low)'}`);
  if (defensiveMatchup) rationale.push('defensive/style matchup (both defenses outrate attacks)');
  if (drawIncentive) rationale.push('group-table draw incentive flagged');
  if (suppressionContext) rationale.push('scoring-suppression context present (rest/travel/venue/climate)');

  let drawEvaluation;
  if (env === null) {
    drawEvaluation = 'BLOCKED_MODEL_LAYER_MISSING';
    rationale.push('draw read blocked: no goal-environment proxy');
  } else if (narrowGap && lowXg && secondarySupport) {
    drawEvaluation = 'ACTIONABLE';
  } else {
    drawEvaluation = 'WATCH_ONLY';
    if (narrowGap && !lowXg) rationale.push('close strength alone is NOT a draw read — watch only');
  }

  return {
    ok: true,
    p_home: round3(pHome),
    p_draw: round3(pDraw),
    p_away: round3(pAway),
    winner_lean: diff > 5 ? 'home' : diff < -5 ? 'away' : 'none',
    draw_risk: pDraw >= 0.30 ? 'HIGH' : pDraw >= 0.24 ? 'MEDIUM' : 'LOW',
    draw_evaluation: drawEvaluation,
    draw_rationale: rationale,
    goal_environment: env,
    basis: 'composite-ledger logistic split with calibrated draw prior; market-free by construction',
  };
}
