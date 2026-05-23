// NASCAR Storyline Modifier (pure, deterministic, no I/O)
// schema_version: nascar_storyline_modifier_v1
//
// Purpose: convert an off-track "storyline" (tragedy tribute, replacement
// driver, final start, illness, same-weekend event, track dominance, etc.)
// into a bounded modifier on top of base fundamentals. A storyline NEVER
// overrides fundamentals -- "storyline does not create speed". The module
// emits its own posture_hint vocabulary and never returns PICK / EVIDENCE_LEAN.

const SHORT_TYPES = new Set([
  'tragedy_tribute',
  'replacement_driver',
  'final_start',
  'illness_injury',
  'same_weekend_event',
]);

const DISCLAIMER = 'Storyline does not create speed.';
const SCHEMA_VERSION = 'nascar_storyline_modifier_v1';
const TRUE_WIN_CAP = 0.04;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d = 0) => (Number.isFinite(v) ? v : d);

export function classifyDuration(storyline_type) {
  return SHORT_TYPES.has(storyline_type) ? 'short' : 'long';
}

function timingDecay(duration_class, timing_proximity_days) {
  const days = Math.max(0, num(timing_proximity_days, 0));
  if (duration_class === 'short') {
    return clamp(100 - days * 14, 0, 100);
  }
  return clamp(100 - days * 1.5, 0, 100);
}

// Composite Storyline Score (0-100).
// SHORT weights:
//   emotional_strength      * 0.20
//   direct_connection       * 0.18
//   timing_decay            * 0.15
//   track_relevance         * 0.08
//   team_car_relevance      * 0.10
//   broadcast_public_attn   * 0.14
//   equipment_quality       * 0.08
//   driver_ability_convert  * 0.07
//   - overpricing_penalty   * 0.10
//   - distraction_pressure  * 0.05
// LONG weights: timing_decay drops to 0.05, track_relevance and
// team_car_relevance each gain +0.05, broadcast drops to 0.10.
export function scoreStoryline(storyline, baseFundamentals) {
  const s = storyline || {};
  const b = baseFundamentals || {};
  const duration_class = classifyDuration(s.storyline_type);
  const decay = timingDecay(duration_class, s.timing_proximity_days);

  const emo = num(s.emotional_strength);
  const dc = num(s.direct_connection);
  const tr = num(s.track_relevance);
  const tcr = num(s.team_car_relevance);
  const bpa = num(s.broadcast_public_attention);
  const eq = num(b.equipment_quality);
  const dac = num(b.driver_ability_to_convert);
  const op = num(b.overpricing_penalty);
  const dpr = num(s.distraction_pressure_risk);

  let w;
  if (duration_class === 'short') {
    w = {
      emo: 0.20, dc: 0.18, decay: 0.15, tr: 0.08, tcr: 0.10,
      bpa: 0.14, eq: 0.08, dac: 0.07, op: 0.10, dpr: 0.05,
    };
  } else {
    w = {
      emo: 0.20, dc: 0.18, decay: 0.05, tr: 0.13, tcr: 0.15,
      bpa: 0.10, eq: 0.08, dac: 0.07, op: 0.10, dpr: 0.05,
    };
  }

  const raw =
    emo * w.emo +
    dc * w.dc +
    decay * w.decay +
    tr * w.tr +
    tcr * w.tcr +
    bpa * w.bpa +
    eq * w.eq +
    dac * w.dac -
    op * w.op -
    dpr * w.dpr;

  return { score: clamp(raw, 0, 100), duration_class, timing_decay: decay };
}

export function computeTrueWinModifier(storyline_score, baseFundamentals) {
  const b = baseFundamentals || {};
  const eq = num(b.equipment_quality);
  const dac = num(b.driver_ability_to_convert);
  const gateEq = eq >= 60;
  const gateDac = dac >= 55;
  const gateScore = storyline_score >= 60;

  if (!(gateEq && gateDac && gateScore)) {
    const reasons = [];
    if (!gateEq) reasons.push('equipment_quality<60');
    if (!gateDac) reasons.push('driver_ability_to_convert<55');
    if (!gateScore) reasons.push('storyline_score<60');
    return {
      delta_probability: 0,
      applied: false,
      reason: `gates_failed: ${reasons.join(',')}`,
      capped_at: TRUE_WIN_CAP,
    };
  }

  const scaled = ((storyline_score - 60) / 40) * TRUE_WIN_CAP * (eq / 100);
  const delta = Math.min(TRUE_WIN_CAP, Math.max(0, scaled));
  return {
    delta_probability: Number(delta.toFixed(6)),
    applied: delta > 0,
    reason:
      'gates_passed: scaled by (storyline_score-60)/40 * equipment_quality/100, capped at +0.04',
    capped_at: TRUE_WIN_CAP,
  };
}

export function computeMarketRepricingScore(storyline) {
  const s = storyline || {};
  const raw =
    0.55 * num(s.broadcast_public_attention) +
    0.25 * num(s.emotional_strength) +
    0.20 * num(s.direct_connection) -
    0.20 * num(s.overpricing_penalty ?? 0);
  return clamp(raw, 0, 100);
}

// Pure beneficiary detection. teamGraph is a small fixture object, e.g.
// { teams: { 'RCR': { drivers: ['Austin Hill', ...], cars: [3, 8] } },
//   manufacturers: { 'Chevrolet': ['RCR', 'Hendrick'] },
//   honoree: { name, team, car_number, manufacturer } }
export function detectBeneficiary(storyline, driver, teamGraph) {
  const evidence = [];
  const s = storyline || {};
  const d = driver || {};
  const g = teamGraph || {};
  const honoree = g.honoree || {};
  const summary = (s.summary || '').toLowerCase();
  const driverName = (d.driver_name || '').toLowerCase();
  const driverTeam = d.team || null;
  const driverCar = d.car_number;
  const driverMfr = d.manufacturer || null;

  // direct replacement: driver explicitly stepping into honoree's seat
  if (
    (g.replacement_for && driverName &&
      g.replacement_for.toLowerCase() === driverName) ||
    (summary.includes('replac') && honoree.car_number &&
      Number(driverCar) === Number(honoree.car_number) &&
      driverTeam && honoree.team && driverTeam === honoree.team)
  ) {
    evidence.push(
      `driver ${d.driver_name} fills seat of ${honoree.name || 'honoree'}`,
    );
    if (honoree.car_number) evidence.push(`car #${honoree.car_number}`);
    return { connection_type: 'direct_replacement', evidence };
  }

  // family / ownership
  if (
    g.family_link &&
    driverName &&
    g.family_link.toLowerCase() === driverName
  ) {
    evidence.push(`family/ownership link: ${g.family_link}`);
    return { connection_type: 'family_ownership', evidence };
  }

  // current teammate / team
  if (driverTeam && honoree.team && driverTeam === honoree.team) {
    evidence.push(`shared team: ${driverTeam}`);
    return { connection_type: 'current_team', evidence };
  }

  // former teammate
  if (
    Array.isArray(g.former_teammates) &&
    g.former_teammates.map((x) => x.toLowerCase()).includes(driverName)
  ) {
    evidence.push(`former teammate of ${honoree.name || 'honoree'}`);
    return { connection_type: 'former_teammate', evidence };
  }

  // same car number tribute (e.g., #8 decals)
  if (
    honoree.car_number &&
    driverCar != null &&
    Number(driverCar) === Number(honoree.car_number)
  ) {
    evidence.push(`same car number #${driverCar} as tribute subject`);
    return { connection_type: 'same_car_number', evidence };
  }

  // manufacturer / team-circle
  if (
    driverMfr && honoree.manufacturer && driverMfr === honoree.manufacturer
  ) {
    evidence.push(`shared manufacturer: ${driverMfr}`);
    return { connection_type: 'manufacturer_team_circle', evidence };
  }

  // track legacy
  if (
    s.storyline_type === 'track_dominance' &&
    num(s.track_relevance) >= 70
  ) {
    evidence.push('track_dominance storyline with high track relevance');
    return { connection_type: 'track_legacy', evidence };
  }

  return { connection_type: 'none', evidence };
}

function buildPerformancePath(storyline, base, score, twm) {
  if (!twm.applied) {
    return (
      `Storyline (${storyline.storyline_type}) does not unlock a performance ` +
      `upgrade for ${base.driver_name || 'driver'}: ${twm.reason}. ` +
      `Speed must come from fundamentals.`
    );
  }
  return (
    `${base.driver_name || 'Driver'} (#${base.car_number ?? '?'}) carries ` +
    `composite storyline score ${score.toFixed(1)} with adequate equipment ` +
    `(${base.equipment_quality}) and conversion ability ` +
    `(${base.driver_ability_to_convert}); a modest +` +
    `${(twm.delta_probability * 100).toFixed(2)}pp win nudge is plausible, ` +
    `capped at +${(TRUE_WIN_CAP * 100).toFixed(0)}pp.`
  );
}

function buildMarketPath(storyline, mrs) {
  return (
    `Broadcast/public attention ${storyline.broadcast_public_attention}, ` +
    `emotional strength ${storyline.emotional_strength}, direct connection ` +
    `${storyline.direct_connection} -> market repricing score ` +
    `${mrs.toFixed(1)}. Watch for live in-race odds compression even if ` +
    `true win probability is unchanged.`
  );
}

function pressureNote(distraction_pressure_risk) {
  const v = num(distraction_pressure_risk);
  if (v >= 70) return 'High distraction/pressure risk -- emotion can cut both ways.';
  if (v >= 40) return 'Moderate distraction/pressure risk.';
  return 'Low distraction/pressure risk.';
}

function pickPosture(score, mrs, base) {
  const eq = num(base.equipment_quality);
  const dac = num(base.driver_ability_to_convert);
  const strongBase = eq >= 60 && dac >= 55;
  const guardrails = [];

  let posture;
  if (score >= 80 && strongBase) {
    posture = 'MODEST_WIN_BOOST';
    guardrails.push('LIVE_VARIANCE_ALERT');
  } else if (score >= 80) {
    posture = mrs >= 60 ? 'MARKET_REPRICING_ALERT' : 'WATCH';
  } else if (score >= 50) {
    posture = 'TIEBREAKER_ONLY';
  } else {
    posture = mrs >= 50 ? 'TRACK_ONLY' : 'NO_UPGRADE';
  }
  return { posture, guardrails };
}

export function composeStorylineModifier({
  storyline,
  baseFundamentals,
  eventContext,
}) {
  const s = storyline || {};
  const base = baseFundamentals || {};
  const ev = eventContext || {};

  const { score, duration_class } = scoreStoryline(s, base);
  const twm = computeTrueWinModifier(score, base);
  const mrs = computeMarketRepricingScore(s);
  const { posture, guardrails } = pickPosture(score, mrs, base);

  const guardrails_applied = [
    'storyline_does_not_create_speed',
    `true_win_modifier_capped_at_${TRUE_WIN_CAP}`,
    'no_pick_or_evidence_lean_emitted',
    ...guardrails,
  ];

  return {
    schema_version: SCHEMA_VERSION,
    storyline_id: s.storyline_id,
    storyline_type: s.storyline_type,
    duration_class,
    storyline_score: Number(score.toFixed(2)),
    true_win_modifier: twm,
    market_repricing_score: Number(mrs.toFixed(2)),
    performance_path: buildPerformancePath(s, base, score, twm),
    market_path: buildMarketPath(s, mrs),
    pressure_distraction_risk: {
      score: clamp(num(s.distraction_pressure_risk), 0, 100),
      note: pressureNote(s.distraction_pressure_risk),
    },
    posture_hint: posture,
    guardrails_applied,
    disclaimer: DISCLAIMER,
    inputs_echo: {
      storyline: s,
      baseFundamentals: base,
      eventContext: ev,
    },
  };
}

export default composeStorylineModifier;
