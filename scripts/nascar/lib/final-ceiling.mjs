// Final-ceiling composer for the NASCAR Coca-Cola 600 ceiling board.
//
// Collapses the four-lane status grid into ONE final ceiling per driver:
//   WIN | TOP 5 | TOP 10 | TOP 20 | WATCH | NO CLEAR PICK
//
// Composite score = weighted average of 6 sourceable layers, re-normalized
// over PRESENT layers. Missing layers are surfaced — never fabricated.
//
//   Layer                             Weight  Source
//   1. baseline_fundamentals          0.15    base-fundamentals.mjs composite (driver_skill + team + pit + strategy)
//   2. season_form_2026               0.20    Wikipedia 2026 NCS race-by-race (All-Star excluded)
//   3. season_speed_signal_2026       0.10    Wikipedia 2026 stage points + "most laps led" race count
//   4. charlotte_oval_history         0.20    Wikipedia 2022-2025 Coca-Cola 600s (oval only; Roval excluded)
//   5. intermediate_15mi_oval         0.20    Wikipedia 2022-2025 1.5-mi-oval Cup races (Atlanta excluded)
//   6. practice_qualifying            0.15    Public 2026 Coca-Cola 600 grid + practice snapshots
//   7. long_run_race_type_fit         0.00    UNAVAILABLE — no free static source (kept for transparency)
//
// Ceiling assignment on composite score, then capped by data coverage:
//   composite >= 80 and ≥4 layers present AND at least one of (charlotte_oval, intermediate_15mi) present
//     -> WIN
//   composite >= 70 and ≥3 layers present -> TOP 5
//   composite >= 60 and ≥2 layers present -> TOP 10
//   composite >= 45 and ≥1 layer  present -> TOP 20
//   composite < 45  with usable layers     -> WATCH
//   0 usable layers                        -> NO CLEAR PICK
//
// Storyline beneficiary and market context CANNOT upgrade the final ceiling.
//
// Read-only. No fabricated layer values.

export const FINAL_CEILINGS = Object.freeze([
  'WIN', 'TOP 5', 'TOP 10', 'TOP 20', 'WATCH', 'NO CLEAR PICK',
]);

const LAYER_DEFS = Object.freeze([
  { key: 'baseline_fundamentals',    weight: 0.15, label: 'Baseline driver/team fundamentals' },
  { key: 'season_form_2026',         weight: 0.20, label: '2026 season form so far' },
  { key: 'season_speed_signal_2026', weight: 0.10, label: '2026 in-race speed signal (stage points + led-most-laps)' },
  { key: 'charlotte_oval_history',   weight: 0.20, label: 'Charlotte Motor Speedway OVAL history (Gen 7)' },
  { key: 'intermediate_15mi_oval',   weight: 0.20, label: '1.5-mile intermediate OVAL form (Gen 7)' },
  { key: 'practice_qualifying',      weight: 0.15, label: 'Coca-Cola 600 practice + qualifying' },
  { key: 'long_run_race_type_fit',   weight: 0.00, label: 'Long-run / race-type fit (UNAVAILABLE — no free static source)' },
]);

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function normKey(name) {
  return String(name ?? '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\./g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// --- Per-layer evaluators -------------------------------------------------

// 1) baseline_fundamentals: re-use the existing composite from base-fundamentals.
//    We expect d.driver_skill_rating/team_equipment_quality/etc on the entry.
function evalBaselineFundamentals(d) {
  const parts = [
    { field: 'driver_skill_rating',       w: 0.30, layer: 'driver_skill' },
    { field: 'driver_ability_to_convert', w: 0.20, layer: 'driver_skill' },
    { field: 'team_equipment_quality',    w: 0.30, layer: 'team_equipment' },
    { field: 'pit_crew_crew_chief_grade', w: 0.10, layer: 'pit_crew' },
    { field: 'strategy_risk_rating',      w: 0.10, layer: 'strategy_risk' },
  ];
  let num = 0, den = 0;
  const used = [];
  const missing = [];
  for (const p of parts) {
    const raw = d?.[p.field];
    const n = (raw === null || raw === undefined || raw === '') ? null : Number(raw);
    if (n !== null && Number.isFinite(n)) {
      num += n * p.w; den += p.w;
      used.push({ field: p.field, value: n });
    } else {
      missing.push(p.field);
    }
  }
  if (den === 0) {
    return {
      present: false,
      score: null,
      grade: 'n/a',
      basis: 'base-fundamentals composite (driver_skill + ability_to_convert + team_equipment + pit_crew + strategy_risk)',
      missing_note: `no fundamentals fields available for this driver (missing: ${missing.join(', ')})`,
      used_fields: [],
    };
  }
  const score = Math.round(clamp(num / den, 0, 100));
  return {
    present: true,
    score,
    grade: gradeLabel(score),
    basis: 'base-fundamentals composite (re-weighted over present sub-layers)',
    missing_note: missing.length > 0 ? `partial: missing ${missing.join(', ')}` : null,
    used_fields: used,
  };
}

// 2b) season_speed_signal_2026 from adapter records
function evalSeasonSpeedSignal(rec) {
  if (!rec || rec.present !== true || rec.score === null) {
    return { present: false, score: null, grade: 'n/a',
      basis: 'Wikipedia 2026 NCS — season stage points + most-laps-led race count',
      missing_note: rec?.missing_reason ?? 'no 2026 stage-points/most-laps-led row for this driver',
      detail: null };
  }
  return {
    present: true,
    score: rec.score,
    grade: gradeLabel(rec.score),
    basis: rec.source_basis,
    sample_quality: rec.sample_quality,
    detail: `${rec.stage_points} stage pts, MLL in ${rec.most_laps_led_races} of ${rec.races_counted} races`,
    missing_note: rec.sample_quality === 'thin' ? `thin sample (${rec.races_counted} races)` : null,
  };
}

// 2) season_form_2026 from adapter records
function evalSeasonForm(rec) {
  if (!rec || rec.present !== true || rec.score === null) {
    return { present: false, score: null, grade: 'n/a',
      basis: 'Wikipedia 2026 NCS race results matrix',
      missing_note: rec?.missing_reason ?? 'no 2026 race-by-race rows for this driver',
      detail: null };
  }
  return {
    present: true,
    score: rec.score,
    grade: gradeLabel(rec.score),
    basis: rec.source_basis,
    sample_quality: rec.sample_quality,
    detail: `${rec.races_run} races (${rec.wins}W/${rec.top_5s}T5/${rec.top_10s}T10/${rec.dnfs}DNF; avg ${rec.average_finish_excluding_dnf})`,
    missing_note: rec.sample_quality === 'thin' ? `thin sample (${rec.races_run} races)` : null,
  };
}

// 3) Charlotte oval history (Gen 7 only; Roval excluded)
function evalCharlotteOval(rec) {
  if (!rec || rec.present !== true || rec.score === null) {
    return { present: false, score: null, grade: 'n/a',
      basis: 'Wikipedia 2022-2025 Coca-Cola 600s (Charlotte oval only; Roval excluded)',
      missing_note: rec?.missing_reason ?? 'no Gen-7 Charlotte oval starts for this driver',
      detail: null };
  }
  return {
    present: true,
    score: rec.score,
    grade: gradeLabel(rec.score),
    basis: rec.source_basis,
    sample_quality: rec.sample_quality,
    detail: `${rec.races_run} starts (${rec.wins}W/${rec.top_5s}T5/${rec.top_10s}T10; avg ${rec.average_finish})`,
    missing_note: rec.sample_quality === 'thin' ? `thin sample (${rec.races_run} starts)` : null,
  };
}

// 4) 1.5-mi intermediate oval form (Gen 7 only; Atlanta + Roval excluded)
function evalIntermediate(rec) {
  if (!rec || rec.present !== true || rec.score === null) {
    return { present: false, score: null, grade: 'n/a',
      basis: 'Wikipedia 2022-2025 1.5-mi-oval Cup races (Atlanta + Roval excluded)',
      missing_note: rec?.missing_reason ?? 'no Gen-7 1.5-mi-oval starts for this driver',
      detail: null };
  }
  return {
    present: true,
    score: rec.score,
    grade: gradeLabel(rec.score),
    basis: rec.source_basis,
    sample_quality: rec.sample_quality,
    detail: `${rec.races_run} starts (${rec.wins}W/${rec.top_5s}T5/${rec.top_10s}T10/${rec.dnfs}DNF; avg ${rec.average_finish})`,
    missing_note: rec.sample_quality === 'thin' ? `thin sample (${rec.races_run} starts)` : null,
  };
}

// 5) Practice + qualifying for THIS race (public 2026 Coca-Cola 600 snapshots)
//    gridBasis === 'rules_set' (qualifying cancelled, grid by competition
//    formula) attaches a confidence note. Effective layer weight is reduced
//    by the caller via PRACTICE_QUALIFYING_RULES_SET_WEIGHT_FACTOR.
function evalPracticeQualifying(rec, pqStatus, gridBasis) {
  if (!rec) {
    return { present: false, score: null, grade: 'n/a',
      basis: 'Public 2026 Coca-Cola 600 grid + practice snapshot',
      missing_note: `no practice/qualifying row for this driver (envelope=${pqStatus ?? 'unknown'})`,
      detail: null };
  }
  const toNumericOrNull = value => {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const grid = toNumericOrNull(rec.starting_position);
  const prac = toNumericOrNull(rec.practice_rank);
  if (grid === null && prac === null) {
    return { present: false, score: null, grade: 'n/a',
      basis: 'Public 2026 Coca-Cola 600 grid + practice snapshot',
      missing_note: 'driver row present but no starting_position or practice_rank published',
      detail: null };
  }
  const gridScore = grid !== null ? clamp(Math.round(100 - (grid - 1) * 2.5), 0, 100) : null;
  const pracScore = prac !== null ? clamp(Math.round(100 - (prac - 1) * 3), 0, 100) : null;
  const parts = [gridScore, pracScore].filter(s => s !== null);
  const score = parts.length === 0 ? null : Math.round(parts.reduce((a,b)=>a+b,0) / parts.length);
  const detailBits = [];
  if (grid !== null) {
    detailBits.push(gridBasis === 'rules_set'
      ? `grid P${grid} (rules-set, qualifying cancelled)`
      : `grid P${grid}`);
  }
  if (prac !== null) detailBits.push(`practice P${prac}`);
  const notes = [];
  if (prac === null) notes.push('practice rank not published for this driver (top-N only)');
  if (gridBasis === 'rules_set') notes.push('grid set by competition-based formula (no timed qualifying); layer weight reduced 50%');
  return {
    present: true,
    score,
    grade: gradeLabel(score),
    basis: gridBasis === 'rules_set'
      ? 'Public 2026 Coca-Cola 600 snapshot — competition-formula starting grid (rules-set) + practice results'
      : 'Public 2026 Coca-Cola 600 snapshot — official starting grid + practice results',
    detail: detailBits.join(', '),
    missing_note: notes.length > 0 ? notes.join('; ') : null,
    grid_basis: gridBasis ?? 'qualifying_session',
  };
}

// 6) long-run / race-type fit — no clean public source; always MISSING.
function evalLongRunFit() {
  return { present: false, score: null, grade: 'n/a',
    basis: 'no clean public long-run telemetry source (e.g., Racing Reference long-run reports require scraping)',
    missing_note: 'long-run/race-type-fit layer is intentionally MISSING — closest proxy already captured by intermediate_15mi_oval layer',
    detail: null };
}

function gradeLabel(s) {
  if (s === null || s === undefined) return 'n/a';
  if (s >= 80) return 'A';
  if (s >= 70) return 'B';
  if (s >= 60) return 'C';
  if (s >= 45) return 'D';
  return 'F';
}

// --- Ceiling assignment ---------------------------------------------------

function assignCeiling({ composite, layersPresent, hasOval, hasIntermediate, dataQuality, oneOffDataLimits }) {
  if (layersPresent === 0 || composite === null) {
    return { ceiling: 'NO CLEAR PICK', reason: 'no usable source-backed layers for this driver' };
  }
  // Hard cap: if neither Charlotte oval nor intermediate is present we cannot
  // justify TOP 5 or WIN (no track-type evidence).
  const trackTypeEvidence = hasOval || hasIntermediate;

  if (composite >= 80 && layersPresent >= 4 && trackTypeEvidence) {
    return { ceiling: 'WIN', reason: `composite ${composite} with ${layersPresent} layers including track-type evidence` };
  }
  if (composite >= 70 && layersPresent >= 3 && trackTypeEvidence) {
    return { ceiling: 'TOP 5', reason: `composite ${composite} with ${layersPresent} layers including track-type evidence` };
  }
  if (composite >= 70 && !trackTypeEvidence) {
    return { ceiling: 'TOP 10', reason: `composite ${composite} but no Charlotte-oval or intermediate-oval evidence — capped at TOP 10` };
  }
  if (composite >= 60 && layersPresent >= 2) {
    return { ceiling: 'TOP 10', reason: `composite ${composite} with ${layersPresent} layers` };
  }
  if (composite >= 45) {
    return { ceiling: 'TOP 20', reason: `composite ${composite}` };
  }
  return { ceiling: 'WATCH', reason: `composite ${composite} below TOP 20 threshold; on the board only as a monitor` };
}

// --- Invalidators ---------------------------------------------------------

function buildInvalidators(layerOutputs, rec2026, recOval, recInter, recPQ) {
  const out = [];
  const oval = layerOutputs.charlotte_oval_history;
  const inter = layerOutputs.intermediate_15mi_oval;
  const season = layerOutputs.season_form_2026;
  const pq = layerOutputs.practice_qualifying;
  const base = layerOutputs.baseline_fundamentals;

  if (rec2026?.dnfs > 0 && rec2026?.races_run > 0) {
    const rate = rec2026.dnfs / rec2026.races_run;
    if (rate >= 0.25) out.push(`2026 DNF rate ${Math.round(rate*100)}% (${rec2026.dnfs}/${rec2026.races_run}) — attrition risk in a 600-mile race`);
  }
  if (recInter?.dnfs > 0 && recInter?.races_run > 0) {
    const rate = recInter.dnfs / recInter.races_run;
    if (rate >= 0.20) out.push(`Gen-7 1.5-mi DNF rate ${Math.round(rate*100)}% (${recInter.dnfs}/${recInter.races_run})`);
  }
  if (oval.present && Number(recOval?.average_finish) > 20) {
    out.push(`weak Charlotte oval avg finish (${recOval.average_finish}) over ${recOval.races_run} Gen-7 starts`);
  }
  if (inter.present && Number(recInter?.average_finish) > 18) {
    out.push(`mediocre Gen-7 1.5-mi avg finish (${recInter.average_finish}) over ${recInter.races_run} starts`);
  }
  if (pq.present && recPQ?.starting_position && recPQ.starting_position >= 25) {
    out.push(`deep starting position P${recPQ.starting_position} — extra traffic exposure`);
  }
  if (!oval.present) out.push('no Gen-7 Charlotte oval sample (Roval-only or pre-Gen-7 starts do not count)');
  if (!inter.present) out.push('no Gen-7 1.5-mi-oval sample');
  if (!season.present) out.push('no 2026 race-by-race form available');
  if (!base.present) out.push('no baseline fundamentals available');
  return out;
}

// --- Public composer ------------------------------------------------------

// When the grid is set by a competition-based formula instead of timed
// qualifying, the practice_qualifying layer cannot claim raw speed.
// Keep the layer present (the starting position is still a real race
// position) but reduce its effective weight by half.
const PRACTICE_QUALIFYING_RULES_SET_WEIGHT_FACTOR = 0.5;

// Cup-history lockout reasons (e.g. Austin Hill #33 has zero Cup starts at
// Charlotte oval or 1.5-mi ovals). When set, the named Cup-history layers
// are forced to MISSING with the lockout reason as the missing_note, so we
// do not borrow Tyler Reddick's or Kyle Busch's history under the #8/#33
// storyline. Hill's national-series readiness is documented separately in
// the packet renderer as a labeled lower-confidence context note, NOT a
// composite layer.
const CUP_HISTORY_LAYERS = Object.freeze([
  'season_form_2026',
  'season_speed_signal_2026',
  'charlotte_oval_history',
  'intermediate_15mi_oval',
]);

export function composeFinalCeilingForDriver({
  driver,                  // pool entry with fundamentals-merged fields
  seasonFormRecord = null,
  seasonSpeedSignalRecord = null,
  charlotteOvalRecord = null,
  intermediateRecord = null,
  practiceQualifyingRecord = null,
  practiceQualifyingStatus = null,
  gridBasis = null,
  cupHistoryLockoutReason = null,
} = {}) {
  const lock = cupHistoryLockoutReason
    ? { present: false, score: null, grade: 'n/a',
        basis: 'Cup-history lockout: this active entry has no transferable Cup record under the storyline rules',
        missing_note: cupHistoryLockoutReason, detail: null }
    : null;

  const layers = {
    baseline_fundamentals:    evalBaselineFundamentals(driver),
    season_form_2026:         lock ?? evalSeasonForm(seasonFormRecord),
    season_speed_signal_2026: lock ?? evalSeasonSpeedSignal(seasonSpeedSignalRecord),
    charlotte_oval_history:   lock ?? evalCharlotteOval(charlotteOvalRecord),
    intermediate_15mi_oval:   lock ?? evalIntermediate(intermediateRecord),
    practice_qualifying:      evalPracticeQualifying(practiceQualifyingRecord, practiceQualifyingStatus, gridBasis),
    long_run_race_type_fit:   evalLongRunFit(),
  };

  // Composite over present layers (re-normalized). Effective weight may
  // be reduced for practice_qualifying when the grid is rules_set.
  let num = 0, den = 0;
  const ledger = [];
  for (const def of LAYER_DEFS) {
    const lo = layers[def.key];
    let effWeight = def.weight;
    if (def.key === 'practice_qualifying' && lo.present && gridBasis === 'rules_set') {
      effWeight = +(def.weight * PRACTICE_QUALIFYING_RULES_SET_WEIGHT_FACTOR).toFixed(4);
    }
    if (lo.present && lo.score !== null) {
      num += lo.score * effWeight;
      den += effWeight;
    }
    ledger.push({
      category: def.key,
      label: def.label,
      raw_weight: def.weight,
      effective_weight: effWeight,
      source_basis: lo.basis,
      value: lo.score,
      grade: lo.grade,
      detail: lo.detail ?? null,
      used_fields: lo.used_fields ?? undefined,
      present: lo.present,
      missing_note: lo.missing_note,
      // normalized_weight + contribution filled after pass
      normalized_weight: null,
      contribution: null,
    });
  }
  for (const row of ledger) {
    if (row.present && row.value !== null && den > 0) {
      row.normalized_weight = +(row.effective_weight / den).toFixed(4);
      row.contribution = +(row.value * (row.effective_weight / den)).toFixed(2);
    }
  }
  const composite = den === 0 ? null : Math.round(clamp(num / den, 0, 100));
  const layersPresent = ledger.filter(r => r.present).length;
  const hasOval = layers.charlotte_oval_history.present;
  const hasInter = layers.intermediate_15mi_oval.present;

  let { ceiling, reason } = assignCeiling({
    composite,
    layersPresent,
    hasOval,
    hasIntermediate: hasInter,
  });

  // Cup-history lockout cap: if Cup-history layers are locked MISSING for this
  // active entry (e.g. Austin Hill #33), a single P/Q row cannot lift the
  // ceiling above WATCH. Storyline-attached entries must show direct Cup
  // evidence — they get a real ceiling, not borrowed equity.
  if (cupHistoryLockoutReason) {
    ceiling = 'WATCH';
    reason = `Cup-history lockout: ${cupHistoryLockoutReason} No transferable Cup evidence exists; ceiling capped at WATCH regardless of practice/qualifying or fundamentals.`;
  }

  const invalidators = buildInvalidators(
    layers, seasonFormRecord, charlotteOvalRecord, intermediateRecord, practiceQualifyingRecord,
  );

  // One-line reasoning summary suitable for a board row.
  const contribsTxt = ledger
    .filter(r => r.present && r.contribution !== null)
    .map(r => `${r.category}=${r.value}×${r.normalized_weight}=${r.contribution}`)
    .join(' + ');
  const missingTxt = ledger.filter(r => !r.present).map(r => r.category).join(', ') || 'none';
  const reasoning_summary =
    composite === null
      ? `NO CLEAR PICK — no usable layers (missing: ${missingTxt}).`
      : `composite=${composite} from ${layersPresent} layer(s): ${contribsTxt}. Missing: ${missingTxt}. Ceiling=${ceiling} (${reason}).`;

  return {
    composite_score: composite,
    layers_present: layersPresent,
    final_ceiling: ceiling,
    final_ceiling_reason: reason,
    evidence_ledger: ledger,
    invalidators,
    reasoning_summary,
  };
}

export function composeFinalCeilingBoardOverlay({
  candidates,                        // list of driver records (post-merge)
  seasonFormEnvelope = null,
  seasonSpeedSignalEnvelope = null,
  charlotteOvalEnvelope = null,
  intermediateEnvelope = null,
  practiceQualifyingEnvelope = null,
  gridBasis = null,
  cupHistoryLockouts = null,         // Map<carNumber, reasonString>
} = {}) {
  function indexByName(envelope) {
    const m = new Map();
    if (!envelope || !Array.isArray(envelope.records)) return m;
    for (const r of envelope.records) m.set(normKey(r.driver_name), r);
    return m;
  }
  const seasonIdx = indexByName(seasonFormEnvelope);
  const speedIdx = indexByName(seasonSpeedSignalEnvelope);
  const ovalIdx = indexByName(charlotteOvalEnvelope);
  const interIdx = indexByName(intermediateEnvelope);
  const pqRecords = practiceQualifyingEnvelope?.records ?? [];
  const pqByName = new Map();
  for (const r of pqRecords) pqByName.set(normKey(r.driver_name), r);
  const pqStatus = practiceQualifyingEnvelope?.status ?? null;

  const effectiveGridBasis = gridBasis
    ?? practiceQualifyingEnvelope?.snapshot?.grid_basis
    ?? null;

  return candidates.map(c => {
    const key = normKey(c.driver_name);
    const lockoutReason = cupHistoryLockouts?.get?.(c.car_number) ?? null;
    const r = composeFinalCeilingForDriver({
      driver: c,
      seasonFormRecord: seasonIdx.get(key) ?? null,
      seasonSpeedSignalRecord: speedIdx.get(key) ?? null,
      charlotteOvalRecord: ovalIdx.get(key) ?? null,
      intermediateRecord: interIdx.get(key) ?? null,
      practiceQualifyingRecord: pqByName.get(key) ?? null,
      practiceQualifyingStatus: pqStatus,
      gridBasis: effectiveGridBasis,
      cupHistoryLockoutReason: lockoutReason,
    });
    return { driver_name: c.driver_name, car_number: c.car_number, ...r };
  });
}
