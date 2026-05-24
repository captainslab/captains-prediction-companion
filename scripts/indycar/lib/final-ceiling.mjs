// Final-ceiling composer for the 2026 Indianapolis 500.
//
// Assigns ONE final ceiling per driver across the full 33-car field:
//   WIN | TOP 5 | TOP 10 | TOP 20 | WATCH | NO CLEAR PICK
//
// Composite score = weighted average of 6 source-backed layers,
// re-normalized over PRESENT layers. Missing layers are surfaced — never fabricated.
//
//   Layer                              Weight  Source
//   1. baseline_fundamentals           0.10    driver skill + team equipment + strategy risk
//   2. season_form_2026                0.20    2026 IndyCar NTT Series (pre-Indy 500)
//   3. ims_500_history                 0.30    Indy 500 / IMS oval: 2021-2025 (aero era)
//   4. oval_superspeedway_history      0.15    Other IndyCar oval/superspeedway history (2021-2025)
//   5. qualifying_starting_position    0.20    2026 Indy 500 qualifying + starting grid
//   6. carb_day_long_run               0.05    Carb Day / final practice speeds (often partial)
//
// Ceiling assignment on composite score, capped by data coverage:
//   composite >= 78 AND ≥4 layers present AND ims_500_history present
//     -> WIN
//   composite >= 68 AND ≥3 layers present AND (ims_500 OR oval) present
//     -> TOP 5
//   composite >= 58 AND ≥2 layers present
//     -> TOP 10
//   composite >= 43 AND ≥1 layer present
//     -> TOP 20
//   composite < 43 with usable layers
//     -> WATCH
//   0 usable layers
//     -> NO CLEAR PICK
//
// Storyline context and market prices CANNOT upgrade the final ceiling.
//
// Read-only. No fabricated layer values. No trading.

export const FINAL_CEILINGS = Object.freeze([
  'WIN', 'TOP 5', 'TOP 10', 'TOP 20', 'WATCH', 'NO CLEAR PICK',
]);

const LAYER_DEFS = Object.freeze([
  { key: 'baseline_fundamentals',       weight: 0.10, label: 'Baseline driver/team fundamentals' },
  { key: 'season_form_2026',            weight: 0.20, label: '2026 IndyCar season form (pre-Indy 500)' },
  { key: 'ims_500_history',             weight: 0.30, label: 'IMS / Indy 500 history (2021-2025 aero era)' },
  { key: 'oval_superspeedway_history',  weight: 0.15, label: 'IndyCar oval / superspeedway history (2021-2025)' },
  { key: 'qualifying_starting_position',weight: 0.20, label: '2026 Indy 500 qualifying + starting position' },
  { key: 'carb_day_long_run',           weight: 0.05, label: 'Carb Day / final practice speeds' },
]);

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function normKey(name) {
  return String(name ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\./g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// --- Per-layer evaluators -------------------------------------------------

// 1) baseline_fundamentals: driver skill, team equipment, strategy risk.
function evalBaselineFundamentals(d) {
  const parts = [
    { field: 'driver_skill_rating',       w: 0.35 },
    { field: 'driver_ability_to_convert', w: 0.25 },
    { field: 'team_equipment_quality',    w: 0.30 },
    { field: 'strategy_risk_rating',      w: 0.10 },
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
      present: false, score: null, grade: 'n/a',
      basis: 'base fundamentals (driver_skill + team_equipment + strategy_risk)',
      missing_note: `no fundamentals fields for this driver (missing: ${missing.join(', ')})`,
      used_fields: [],
    };
  }
  const score = Math.round(clamp(num / den, 0, 100));
  return {
    present: true, score, grade: gradeLabel(score),
    basis: 'base fundamentals composite (re-weighted over present sub-layers)',
    missing_note: missing.length > 0 ? `partial: missing ${missing.join(', ')}` : null,
    used_fields: used,
  };
}

// 2) season_form_2026 from IndyCar 2026 season results adapter.
function evalSeasonForm(rec) {
  if (!rec || rec.present !== true || rec.score === null) {
    return {
      present: false, score: null, grade: 'n/a',
      basis: 'IndyCar 2026 NTT Series race results (pre-Indy 500)',
      missing_note: rec?.missing_reason ?? 'no 2026 race-by-race rows for this driver',
      detail: null,
    };
  }
  return {
    present: true, score: rec.score, grade: gradeLabel(rec.score),
    basis: rec.source_basis,
    sample_quality: rec.sample_quality,
    detail: `${rec.races_run} races (${rec.wins}W/${rec.top_5s}T5/${rec.top_10s}T10/${rec.dnfs}DNF; avg ${rec.average_finish_excluding_dnf})`,
    missing_note: rec.sample_quality === 'thin' ? `thin sample (${rec.races_run} races)` : null,
  };
}

// 3) IMS / Indy 500 history (aero era 2021-2025; oval only).
function evalIMS500History(rec) {
  if (!rec || rec.present !== true || rec.score === null) {
    return {
      present: false, score: null, grade: 'n/a',
      basis: 'Indy 500 / IMS oval history 2021-2025 (aero era)',
      missing_note: rec?.missing_reason ?? 'no Indy 500 starts in the 2021-2025 window',
      detail: null,
    };
  }
  return {
    present: true, score: rec.score, grade: gradeLabel(rec.score),
    basis: rec.source_basis,
    sample_quality: rec.sample_quality,
    detail: `${rec.races_run} starts (${rec.wins}W/${rec.top_5s}T5/${rec.top_10s}T10/${rec.dnfs}DNF; avg ${rec.average_finish})`,
    missing_note: rec.sample_quality === 'thin' ? `thin sample (${rec.races_run} starts)` : null,
  };
}

// 4) Oval / superspeedway history beyond IMS (2021-2025 aero era).
function evalOvalHistory(rec) {
  if (!rec || rec.present !== true || rec.score === null) {
    return {
      present: false, score: null, grade: 'n/a',
      basis: 'IndyCar oval/superspeedway history 2021-2025 (non-IMS ovals)',
      missing_note: rec?.missing_reason ?? 'no non-IMS oval IndyCar starts in the 2021-2025 window',
      detail: null,
    };
  }
  return {
    present: true, score: rec.score, grade: gradeLabel(rec.score),
    basis: rec.source_basis,
    sample_quality: rec.sample_quality,
    detail: `${rec.races_run} starts (${rec.wins}W/${rec.top_5s}T5/${rec.top_10s}T10/${rec.dnfs}DNF; avg ${rec.average_finish})`,
    missing_note: rec.sample_quality === 'thin' ? `thin sample (${rec.races_run} starts)` : null,
  };
}

// 5) Qualifying / starting position for the 2026 Indy 500.
function evalQualifyingPosition(rec, qStatus) {
  if (!rec) {
    return {
      present: false, score: null, grade: 'n/a',
      basis: '2026 Indy 500 qualifying + starting grid',
      missing_note: `no qualifying row for this driver (envelope=${qStatus ?? 'unknown'})`,
      detail: null,
    };
  }
  const grid = Number.isFinite(Number(rec.starting_position)) ? Number(rec.starting_position) : null;
  const qSpeed = Number.isFinite(Number(rec.qualifying_speed_mph)) ? Number(rec.qualifying_speed_mph) : null;
  if (grid === null) {
    return {
      present: false, score: null, grade: 'n/a',
      basis: '2026 Indy 500 qualifying + starting grid',
      missing_note: 'driver row present but no starting_position published',
      detail: null,
    };
  }
  // P1 = 100, P33 = 0 (linear across 33-car field)
  const gridScore = Math.round(clamp(100 - (grid - 1) * (100 / 32), 0, 100));
  // If qualifying speed is available, blend it in (speed signal confirms pace)
  const score = gridScore;
  const detailBits = [`grid P${grid}`];
  if (qSpeed !== null) detailBits.push(`qual speed ${qSpeed.toFixed(3)} mph`);
  return {
    present: true, score, grade: gradeLabel(score),
    basis: '2026 Indy 500 qualifying — official starting grid and qualifying speed',
    detail: detailBits.join(', '),
    missing_note: null,
  };
}

// 6) Carb Day / final practice — often thin or partial.
function evalCarbDay(rec) {
  if (!rec || rec.present !== true) {
    return {
      present: false, score: null, grade: 'n/a',
      basis: 'Carb Day (May 23, 2026) / final practice speeds',
      missing_note: rec?.missing_reason ?? 'Carb Day long-run speeds not published or not available',
      detail: null,
    };
  }
  return {
    present: true, score: rec.score, grade: gradeLabel(rec.score),
    basis: rec.source_basis ?? 'Carb Day 2026 practice speeds',
    detail: rec.detail ?? null,
    missing_note: rec.sample_quality === 'thin' ? 'Carb Day partial — only short-run or top-N published' : null,
  };
}

function gradeLabel(s) {
  if (s === null || s === undefined) return 'n/a';
  if (s >= 80) return 'A';
  if (s >= 70) return 'B';
  if (s >= 60) return 'C';
  if (s >= 43) return 'D';
  return 'F';
}

// --- Ceiling assignment ---------------------------------------------------

function assignCeiling({ composite, layersPresent, hasIMS, hasOval }) {
  if (layersPresent === 0 || composite === null) {
    return { ceiling: 'NO CLEAR PICK', reason: 'no usable source-backed layers for this driver' };
  }
  const trackEvidence = hasIMS || hasOval;

  if (composite >= 78 && layersPresent >= 4 && hasIMS) {
    return { ceiling: 'WIN', reason: `composite ${composite} with ${layersPresent} layers including IMS history` };
  }
  if (composite >= 68 && layersPresent >= 3 && trackEvidence) {
    return { ceiling: 'TOP 5', reason: `composite ${composite} with ${layersPresent} layers and track-type evidence` };
  }
  if (composite >= 68 && !trackEvidence) {
    return { ceiling: 'TOP 10', reason: `composite ${composite} but no IMS or oval evidence — capped at TOP 10` };
  }
  if (composite >= 58 && layersPresent >= 2) {
    return { ceiling: 'TOP 10', reason: `composite ${composite} with ${layersPresent} layers` };
  }
  if (composite >= 43) {
    return { ceiling: 'TOP 20', reason: `composite ${composite}` };
  }
  return { ceiling: 'WATCH', reason: `composite ${composite} below TOP 20 threshold` };
}

// --- Invalidators ---------------------------------------------------------

function buildInvalidators(layerOutputs, rec2026, recIMS, recOval, recPQ) {
  const out = [];
  const ims = layerOutputs.ims_500_history;
  const oval = layerOutputs.oval_superspeedway_history;
  const season = layerOutputs.season_form_2026;
  const pq = layerOutputs.qualifying_starting_position;

  if (rec2026?.dnfs > 0 && rec2026?.races_run > 0) {
    const rate = rec2026.dnfs / rec2026.races_run;
    if (rate >= 0.25) out.push(`2026 DNF rate ${Math.round(rate*100)}% (${rec2026.dnfs}/${rec2026.races_run}) — attrition risk in a 500-mile race`);
  }
  if (recIMS?.dnfs > 0 && recIMS?.races_run > 0) {
    const rate = recIMS.dnfs / recIMS.races_run;
    if (rate >= 0.30) out.push(`IMS DNF rate ${Math.round(rate*100)}% (${recIMS.dnfs}/${recIMS.races_run}) over ${recIMS.races_run} Indy 500 starts`);
  }
  if (ims.present && Number(recIMS?.average_finish) > 18) {
    out.push(`weak IMS avg finish (${recIMS.average_finish}) over ${recIMS.races_run} Indy 500 starts`);
  }
  if (oval.present && Number(recOval?.average_finish) > 16) {
    out.push(`mediocre IndyCar oval avg finish (${recOval.average_finish}) over ${recOval.races_run} oval starts`);
  }
  if (pq.present && recPQ?.starting_position && recPQ.starting_position >= 25) {
    out.push(`deep starting position P${recPQ.starting_position} — extra traffic and attrition exposure`);
  }
  if (!ims.present) out.push('no Indy 500 / IMS oval history in the 2021-2025 aero era window (rookie or gap)');
  if (!oval.present) out.push('no IndyCar non-IMS oval sample in the 2021-2025 aero era window');
  if (!season.present) out.push('no 2026 IndyCar race-by-race form available');
  return out;
}

// --- Public composer ------------------------------------------------------

export function composeFinalCeilingForDriver({
  driver,
  seasonFormRecord = null,
  ims500Record = null,
  ovalRecord = null,
  qualifyingRecord = null,
  qualifyingStatus = null,
  carbDayRecord = null,
} = {}) {
  const layers = {
    baseline_fundamentals:        evalBaselineFundamentals(driver),
    season_form_2026:             evalSeasonForm(seasonFormRecord),
    ims_500_history:              evalIMS500History(ims500Record),
    oval_superspeedway_history:   evalOvalHistory(ovalRecord),
    qualifying_starting_position: evalQualifyingPosition(qualifyingRecord, qualifyingStatus),
    carb_day_long_run:            evalCarbDay(carbDayRecord),
  };

  let num = 0, den = 0;
  const ledger = [];
  for (const def of LAYER_DEFS) {
    const lo = layers[def.key];
    if (lo.present && lo.score !== null) {
      num += lo.score * def.weight;
      den += def.weight;
    }
    ledger.push({
      category: def.key,
      label: def.label,
      raw_weight: def.weight,
      source_basis: lo.basis,
      value: lo.score,
      grade: lo.grade,
      detail: lo.detail ?? null,
      used_fields: lo.used_fields ?? undefined,
      present: lo.present,
      missing_note: lo.missing_note,
      normalized_weight: null,
      contribution: null,
    });
  }
  for (const row of ledger) {
    if (row.present && row.value !== null && den > 0) {
      row.normalized_weight = +(row.raw_weight / den).toFixed(4);
      row.contribution = +(row.value * (row.raw_weight / den)).toFixed(2);
    }
  }
  const composite = den === 0 ? null : Math.round(clamp(num / den, 0, 100));
  const layersPresent = ledger.filter(r => r.present).length;
  const hasIMS = layers.ims_500_history.present;
  const hasOval = layers.oval_superspeedway_history.present;

  const { ceiling, reason } = assignCeiling({ composite, layersPresent, hasIMS, hasOval });

  const invalidators = buildInvalidators(
    layers, seasonFormRecord, ims500Record, ovalRecord, qualifyingRecord,
  );

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
  candidates,
  seasonFormEnvelope = null,
  ims500Envelope = null,
  ovalEnvelope = null,
  qualifyingEnvelope = null,
  carbDayEnvelope = null,
} = {}) {
  function indexByName(envelope) {
    const m = new Map();
    if (!envelope || !Array.isArray(envelope.records)) return m;
    for (const r of envelope.records) m.set(normKey(r.driver_name), r);
    return m;
  }
  const seasonIdx = indexByName(seasonFormEnvelope);
  const imsIdx = indexByName(ims500Envelope);
  const ovalIdx = indexByName(ovalEnvelope);
  const carbIdx = indexByName(carbDayEnvelope);

  const qRecords = qualifyingEnvelope?.records ?? [];
  const qByName = new Map();
  for (const r of qRecords) qByName.set(normKey(r.driver_name), r);
  const qStatus = qualifyingEnvelope?.status ?? null;

  return candidates.map(c => {
    const key = normKey(c.driver_name);
    const r = composeFinalCeilingForDriver({
      driver: c,
      seasonFormRecord: seasonIdx.get(key) ?? null,
      ims500Record: imsIdx.get(key) ?? null,
      ovalRecord: ovalIdx.get(key) ?? null,
      qualifyingRecord: qByName.get(key) ?? null,
      qualifyingStatus: qStatus,
      carbDayRecord: carbIdx.get(key) ?? null,
    });
    return {
      driver_name: c.driver_name,
      car_number: c.car_number,
      team: c.team,
      engine: c.engine,
      starting_position: c.starting_position ?? qByName.get(key)?.starting_position ?? null,
      ...r,
    };
  });
}
