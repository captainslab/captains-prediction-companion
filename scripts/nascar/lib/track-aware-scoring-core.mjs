// NASCAR track-aware composite scoring core.
//
// PURPOSE
//   The single reusable, market-neutral NASCAR scoring engine. Replaces the thin
//   generic ceiling board (driver_skill / team_equipment / pit_crew /
//   strategy_risk) with an explicit, track-FIRST layer schema. Track identity,
//   track type, track history, similar-track history and package fit are scored
//   BEFORE driver/team form. Market price is compared only AFTER scoring.
//
// HARD RULE — MARKET NEUTRALITY (mirrors AGENTS.md + decision-packet.mjs)
//   Market price, Kalshi bid/ask/last/volume/open interest, and market-implied
//   probability NEVER enter any field of a composite candidate. This module
//   takes ONLY fundamentals inputs and emits ONLY model fields. Edge is computed
//   downstream by COMPARING fair_win_probability (here) against market implied
//   (in the packet generator). A neutrality test greps the candidate objects for
//   price tokens; keep this module price-free.
//
// EVIDENCE DISCIPLINE
//   A layer with no real data is NOT fabricated. It is emitted as MISSING (no
//   input at all) or LOW_EVIDENCE (thin sample, e.g. < MIN_SAMPLE track-history
//   races) and its weight is dropped from the renormalized composite. Missing /
//   low-evidence layers downgrade the candidate's confidence; they never invent
//   a neutral 50 that silently props up the rating.
//
// OUTPUT (per candidate) — names chosen so packets stop showing bare score=168.3:
//   driver_name, car_number, team, manufacturer,
//   model_rating_0_100         (0..100 weighted composite over PRESENT layers)
//   fair_win_probability       (0..1, field-normalized from model_rating; model-only)
//   composite_score            (alias of model_rating_0_100, explicitly named)
//   ranking_score              (internal sort key = model_rating_0_100)
//   layer_breakdown            ([{layer, group, value, evidence, weight,
//                                 normalized_weight, contribution, note}])
//   track_specific_inputs      (raw track identity/type/history bundle, passthrough)
//   similar_track_inputs       (raw similar-track bundle, passthrough)
//   starting_position_context  ({start, percentile, note})
//   practice_context           ({long_run, single_lap, evidence})
//   risk_adjustments           ({incident_dnf_risk, applied_penalty, note})
//   missing_or_low_evidence_flags ([layer names])
//   confidence                 ('high'|'medium'|'low')

const SCHEMA_VERSION = 'nascar_track_aware_composite_v1';

// ---------------------------------------------------------------------------
// LAYER SCHEMA — 15 explicit layers. Weights sum to 1.00. Track-type and
// track-history layers carry the most weight: NASCAR is track-first.
// `group` buckets layers for the packet's track-specific explanation block.
// `critical` layers, when MISSING/LOW_EVIDENCE, pull confidence down hardest.
// ---------------------------------------------------------------------------
export const NASCAR_LAYER_SCHEMA = Object.freeze([
  // --- TRACK-FIRST block (0.46) ---
  { key: 'track_identity_fit',     label: 'Track Identity Fit',          group: 'track',   weight: 0.10, critical: true },
  { key: 'track_type_fit',         label: 'Track Type Fit',              group: 'track',   weight: 0.12, critical: true },
  { key: 'track_history',          label: 'This-Track History',          group: 'track',   weight: 0.12, critical: true },
  { key: 'similar_track_history',  label: 'Similar-Track History',       group: 'track',   weight: 0.08, critical: false },
  { key: 'package_fit',            label: 'Aero/Package Fit',            group: 'track',   weight: 0.04, critical: false },
  // --- SPEED block (0.20) ---
  { key: 'long_run_speed',         label: 'Long-Run Speed',              group: 'speed',   weight: 0.11, critical: true },
  { key: 'single_lap_speed',       label: 'Single-Lap Speed',            group: 'speed',   weight: 0.09, critical: false },
  // --- TRACK-POSITION block (0.13) ---
  { key: 'starting_position_context', label: 'Starting Position Context', group: 'position', weight: 0.06, critical: false },
  { key: 'passing_difficulty_context', label: 'Passing Difficulty Context', group: 'position', weight: 0.07, critical: false },
  // --- EXECUTION block (0.10) ---
  { key: 'pit_crew_and_pit_road',  label: 'Pit Crew / Pit Road',         group: 'execution', weight: 0.04, critical: false },
  { key: 'crew_chief_strategy',    label: 'Crew Chief Strategy',         group: 'execution', weight: 0.03, critical: false },
  { key: 'restart_overtime_skill', label: 'Restart / Overtime Skill',    group: 'execution', weight: 0.03, critical: false },
  // --- FORM + TEAM block (0.11) ---
  { key: 'team_equipment_strength', label: 'Team Equipment Strength',    group: 'team',    weight: 0.06, critical: true },
  { key: 'recent_form_weighted_by_track_type', label: 'Recent Form (track-type weighted)', group: 'form', weight: 0.05, critical: false },
  // --- RISK block (negative-only; see incident handling) ---
  { key: 'incident_dnf_risk',      label: 'Incident / DNF Risk',         group: 'risk',    weight: 0.00, critical: false },
]);

const LAYER_KEYS = Object.freeze(NASCAR_LAYER_SCHEMA.map((l) => l.key));
const LAYER_BY_KEY = Object.freeze(
  Object.fromEntries(NASCAR_LAYER_SCHEMA.map((l) => [l.key, l])),
);
// Weighted (scoring) layers exclude the risk layer, which is applied as a
// post-composite penalty rather than a positive weighted contribution.
const SCORING_LAYERS = Object.freeze(NASCAR_LAYER_SCHEMA.filter((l) => l.weight > 0));
const CRITICAL_LAYERS = Object.freeze(NASCAR_LAYER_SCHEMA.filter((l) => l.critical).map((l) => l.key));

export const EVIDENCE = Object.freeze({ OK: 'OK', LOW_EVIDENCE: 'LOW_EVIDENCE', MISSING: 'MISSING' });

// Minimum race samples before a history layer is OK (else LOW_EVIDENCE).
const MIN_HISTORY_SAMPLE = 3;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round1(n) { return n === null ? null : Math.round(n * 10) / 10; }
function round2(n) { return n === null ? null : Math.round(n * 100) / 100; }

/**
 * Normalize one raw per-layer input into { value:0-100|null, evidence, note }.
 * Accepts three shapes from the adapter:
 *   - a bare number (0..100)                      -> evidence OK
 *   - null/undefined                              -> MISSING
 *   - { score, evidence?, sample?, note? }        -> explicit; sample < MIN
 *                                                    downgrades OK -> LOW_EVIDENCE
 */
function normalizeLayerInput(raw, layerKey) {
  if (raw === null || raw === undefined) {
    return { value: null, evidence: EVIDENCE.MISSING, note: 'no input supplied' };
  }
  if (typeof raw === 'number') {
    const v = Number.isFinite(raw) ? clamp(raw, 0, 100) : null;
    return v === null
      ? { value: null, evidence: EVIDENCE.MISSING, note: 'non-finite input' }
      : { value: v, evidence: EVIDENCE.OK, note: null };
  }
  if (typeof raw === 'object') {
    const v = num(raw.score);
    if (v === null) {
      return { value: null, evidence: EVIDENCE.MISSING, note: raw.note ?? 'no numeric score' };
    }
    let evidence = raw.evidence && Object.values(EVIDENCE).includes(raw.evidence)
      ? raw.evidence
      : EVIDENCE.OK;
    const sample = num(raw.sample);
    const isHistory = layerKey === 'track_history' || layerKey === 'similar_track_history';
    if (evidence === EVIDENCE.OK && isHistory && sample !== null && sample < MIN_HISTORY_SAMPLE) {
      evidence = EVIDENCE.LOW_EVIDENCE;
    }
    return { value: clamp(v, 0, 100), evidence, note: raw.note ?? null };
  }
  return { value: null, evidence: EVIDENCE.MISSING, note: 'unrecognized input shape' };
}

/**
 * Score one driver across the 15-layer schema.
 * Weights are renormalized over PRESENT scoring layers only (MISSING and
 * LOW_EVIDENCE-with-null drop out) so a missing layer neither drags the rating
 * toward 0 nor invents a neutral 50. LOW_EVIDENCE layers that still carry a
 * numeric value DO contribute (thin data is better than none) but flag the
 * candidate's confidence down.
 */
function scoreDriver(driver) {
  const layers = driver.layers ?? {};
  const breakdown = [];
  const missingOrLow = [];
  let weightedSum = 0;
  let presentWeight = 0;
  let presentCount = 0;
  let criticalPresent = 0;

  for (const layer of SCORING_LAYERS) {
    const norm = normalizeLayerInput(layers[layer.key], layer.key);
    const present = norm.value !== null;
    if (present) {
      weightedSum += norm.value * layer.weight;
      presentWeight += layer.weight;
      presentCount += 1;
      if (layer.critical) criticalPresent += 1;
    }
    if (!present || norm.evidence !== EVIDENCE.OK) missingOrLow.push(layer.key);
    breakdown.push({
      layer: layer.key,
      label: layer.label,
      group: layer.group,
      value: norm.value,
      evidence: present ? norm.evidence : EVIDENCE.MISSING,
      weight: layer.weight,
      normalized_weight: null, // filled after presentWeight is known
      contribution: null,
      note: norm.note,
    });
  }

  const modelRatingRaw = presentWeight > 0 ? weightedSum / presentWeight : null;
  // Fill normalized weights / contributions for present layers.
  if (presentWeight > 0) {
    for (const row of breakdown) {
      if (row.value === null) continue;
      row.normalized_weight = round2(row.weight / presentWeight);
      row.contribution = round1(row.value * (row.weight / presentWeight));
    }
  }

  // Risk layer: post-composite penalty (0..100 where 100 = highest risk).
  const riskNorm = normalizeLayerInput(layers.incident_dnf_risk, 'incident_dnf_risk');
  let appliedPenalty = 0;
  if (riskNorm.value !== null && modelRatingRaw !== null) {
    // Up to a 12-point haircut at max risk; scaled linearly.
    appliedPenalty = round1((riskNorm.value / 100) * 12);
  } else if (riskNorm.value === null) {
    missingOrLow.push('incident_dnf_risk');
  }
  const modelRating = modelRatingRaw === null
    ? null
    : round1(clamp(modelRatingRaw - appliedPenalty, 0, 100));

  // Confidence: how much of the CRITICAL track-first/speed/team spine is present
  // AND how clean the evidence is. Critical coverage drives the floor.
  const criticalRatio = CRITICAL_LAYERS.length ? criticalPresent / CRITICAL_LAYERS.length : 0;
  const cleanRatio = SCORING_LAYERS.length
    ? (presentCount - breakdown.filter((b) => b.value !== null && b.evidence === EVIDENCE.LOW_EVIDENCE).length) / SCORING_LAYERS.length
    : 0;
  let confidence;
  if (modelRating === null) confidence = 'low';
  else if (criticalRatio >= 0.8 && cleanRatio >= 0.6) confidence = 'high';
  else if (criticalRatio >= 0.5) confidence = 'medium';
  else confidence = 'low';

  return {
    modelRating,
    breakdown,
    missingOrLow: [...new Set(missingOrLow)],
    presentCount,
    criticalPresent,
    confidence,
    riskValue: riskNorm.value,
    appliedPenalty,
    riskNote: riskNorm.note,
  };
}

/**
 * Convert field model ratings into fair WIN probabilities that sum to ~1.
 * MODEL-ONLY transform: never reads market price. A power transform on the
 * rating concentrates probability on the strongest cars (NASCAR winners come
 * from a small front group) while staying a smooth function of the composite.
 */
function fairWinProbabilities(ratings, gamma = 7) {
  const weights = ratings.map((r) => (r === null ? 0 : Math.pow(clamp(r, 0, 100) / 100, gamma)));
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return ratings.map(() => null);
  return weights.map((w) => round2(w / total));
}

function startingPositionContext(driver) {
  const start = num(driver.starting_position ?? driver.start);
  if (start === null) return { start: null, percentile: null, note: 'no starting position' };
  // Lower start is better; map P1 -> ~1.0, P40 -> ~0.0 for a quick read.
  const percentile = round2(clamp((40 - start) / 39, 0, 1));
  return { start, percentile, note: `started P${start}` };
}

/**
 * Score an entire NASCAR field for one race.
 *
 * @param {object} input
 * @param {object} input.race      - { track_name, track_id, track_type,
 *                                      restrictor_plate, scheduled_distance }
 * @param {object[]} input.drivers - per-driver fundamentals inputs:
 *     { driver_name, car_number, team, manufacturer, starting_position,
 *       layers: { <layerKey>: number | null | {score,evidence,sample,note} },
 *       track_specific_inputs?, similar_track_inputs?, practice_context? }
 * @param {number} [input.gamma]   - fair-prob concentration exponent (default 7)
 * @returns {object} { schema_version, track, layers_total, candidates, field_notes }
 */
export function scoreNascarField({ race = {}, drivers = [], gamma = 7 } = {}) {
  if (!Array.isArray(drivers)) throw new Error('scoreNascarField requires drivers[]');

  const scored = drivers.map((d) => ({ driver: d, ...scoreDriver(d) }));
  const probs = fairWinProbabilities(scored.map((s) => s.modelRating), gamma);

  const candidates = scored.map((s, i) => {
    const d = s.driver;
    return {
      driver_name: (d.driver_name || '').trim() || 'MISSING',
      car_number: d.car_number ?? null,
      team: d.team ?? null,
      manufacturer: d.manufacturer ?? null,
      // explicitly-named model fields (no bare score=168.3)
      model_rating_0_100: s.modelRating,
      fair_win_probability: probs[i],
      composite_score: s.modelRating,
      ranking_score: s.modelRating ?? -1,
      confidence: s.confidence,
      layer_breakdown: s.breakdown,
      track_specific_inputs: d.track_specific_inputs ?? {
        track_name: race.track_name ?? null,
        track_type: race.track_type ?? null,
        restrictor_plate: race.restrictor_plate ?? null,
      },
      similar_track_inputs: d.similar_track_inputs ?? null,
      starting_position_context: startingPositionContext(d),
      practice_context: d.practice_context ?? {
        long_run: s.breakdown.find((b) => b.layer === 'long_run_speed')?.value ?? null,
        single_lap: s.breakdown.find((b) => b.layer === 'single_lap_speed')?.value ?? null,
        evidence: s.breakdown.find((b) => b.layer === 'long_run_speed')?.evidence ?? EVIDENCE.MISSING,
      },
      risk_adjustments: {
        incident_dnf_risk: s.riskValue,
        applied_penalty: s.appliedPenalty,
        note: s.riskValue === null ? 'no incident/DNF risk input' : s.riskNote ?? 'risk haircut applied to composite',
      },
      missing_or_low_evidence_flags: s.missingOrLow,
    };
  });

  // Rank by model rating desc (nulls last).
  candidates.sort((a, b) => (b.ranking_score ?? -1) - (a.ranking_score ?? -1));

  return {
    schema_version: SCHEMA_VERSION,
    track: {
      track_name: race.track_name ?? null,
      track_id: race.track_id ?? null,
      track_type: race.track_type ?? null,
      restrictor_plate: race.restrictor_plate ?? null,
      scheduled_distance: race.scheduled_distance ?? null,
    },
    layers_total: SCORING_LAYERS.length,
    candidate_count: candidates.length,
    candidates,
    field_notes: [
      `Scored ${candidates.length} drivers over ${SCORING_LAYERS.length} weighted track-aware layers (schema ${SCHEMA_VERSION}).`,
      'Market price never enters the composite; fair_win_probability is field-normalized from model_rating only.',
      'MISSING / LOW_EVIDENCE layers drop from the renormalized composite and downgrade confidence — no fabricated neutral values.',
    ],
  };
}

export const NASCAR_SCORING_SCHEMA_VERSION = SCHEMA_VERSION;
export { LAYER_KEYS as NASCAR_LAYER_KEYS, CRITICAL_LAYERS as NASCAR_CRITICAL_LAYERS };
