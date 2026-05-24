// NASCAR multi-lane ceiling board.
//
// Builds a top-20 candidate pool and emits four ceiling lanes per driver:
//   win, top_5, top_10, top_20
//
// Lane status enum:
//   PICK | EVIDENCE_LEAN | LEAN | WATCH | NO CLEAR PICK | MARKET_ONLY
//
// Hard rules (mirrored from AGENTS.md + runbooks/nascar-implementation-plan.md):
//   - Edge Basis uses fundamentals + source-backed data only.
//   - Market context (price/OI/volume/line movement) NEVER creates PICK or
//     EVIDENCE_LEAN. When fundamentals are unavailable and only market data
//     exists for a lane, the lane is MARKET_ONLY (informational).
//   - Storyline alone NEVER creates PICK or EVIDENCE_LEAN. The storyline
//     beneficiary may be flagged WATCH or get a `market_repricing_alert`,
//     but cannot upgrade past WATCH on storyline alone.
//   - If fundamentals.overall_data_quality !== 'ok', no lane may be PICK or
//     EVIDENCE_LEAN regardless of per-driver score.
//   - If a market lane is not present in supported_market_lanes
//     (source_available=false), the lane is downgraded to NO CLEAR PICK
//     with reason 'missing_market'.
//   - candidate_pool_size is EXACTLY 20 (or fewer with explicit
//     pool_short_reason if the universe has < 20 drivers).
//   - No trade/order/stake/pick/fair_value/edge/kelly/execution fields.

const LANES = Object.freeze(['win', 'top_5', 'top_10', 'top_20']);
const LANE_LABELS = Object.freeze({
  win: 'Win',
  top_5: 'Top 5',
  top_10: 'Top 10',
  top_20: 'Top 20',
});
const LANE_KALSHI_KEY = Object.freeze({
  win: 'win',
  top_5: 'top5',
  top_10: 'top10',
  top_20: 'top20',
});

const STATUSES = Object.freeze([
  'PICK',
  'EVIDENCE_LEAN',
  'LEAN',
  'WATCH',
  'NO CLEAR PICK',
  'MARKET_ONLY',
]);

const FORBIDDEN = Object.freeze([
  'trade', 'order', 'stake', 'pick', 'recommendation',
  'fair_value', 'edge', 'kelly', 'execution',
]);

function assertNoForbidden(value) {
  const walk = (node, path = []) => {
    if (Array.isArray(node)) { node.forEach((n, i) => walk(n, [...path, String(i)])); return; }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (FORBIDDEN.includes(k)) {
          throw new Error(`Multi-lane ceiling board contains forbidden field ${[...path, k].join('.')}`);
        }
        walk(v, [...path, k]);
      }
    }
  };
  walk(value);
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Composite driver-strength score (0-100). Uses ONLY base fundamentals.
// Missing layers contribute neutral 50 weighted by available-mass.
//
// Layer composition (weights are re-normalized over PRESENT inputs only so a
// missing layer doesn't drag the score; missingness is surfaced separately in
// fundamentals_layer_coverage and downgrade_reasons):
//
//   driver_skill_rating       0.30  (driver_skill layer)
//   driver_ability_to_convert 0.20  (driver_skill layer)
//   team_equipment_quality    0.30  (team_equipment layer)
//   pit_crew_crew_chief_grade 0.10  (pit_crew layer)
//   strategy_risk_rating      0.10  (strategy_risk layer)
const SCORE_PARTS = Object.freeze([
  { field: 'driver_skill_rating',       weight: 0.30, layer: 'driver_skill' },
  { field: 'driver_ability_to_convert', weight: 0.20, layer: 'driver_skill' },
  { field: 'team_equipment_quality',    weight: 0.30, layer: 'team_equipment' },
  { field: 'pit_crew_crew_chief_grade', weight: 0.10, layer: 'pit_crew' },
  { field: 'strategy_risk_rating',      weight: 0.10, layer: 'strategy_risk' },
]);

function driverStrengthScore(d) {
  const breakdown = scoreBreakdown(d);
  return breakdown.composite_score;
}

// Returns a full attribution record:
//   {
//     composite_score: int|null,
//     present_weight_sum: number,
//     inputs_used:   [ {layer, field, value, weight, normalized_weight, contribution} ],
//     missing_inputs:[ {layer, field, weight, reason} ],
//     layers_present: [layer, ...],
//     layers_missing: [layer, ...],
//   }
function scoreBreakdown(d) {
  const inputs_used = [];
  const missing_inputs = [];
  const present_layers = new Set();
  const missing_layers_set = new Set();
  let num = 0, den = 0;
  for (const p of SCORE_PARTS) {
    const raw = d ? d[p.field] : null;
    const n = (raw === null || raw === undefined || raw === '') ? null : Number(raw);
    if (n !== null && Number.isFinite(n)) {
      num += n * p.weight;
      den += p.weight;
      inputs_used.push({
        layer: p.layer,
        field: p.field,
        value: n,
        weight: p.weight,
        // normalized_weight + contribution are filled in after the second pass
        normalized_weight: null,
        contribution: null,
      });
      present_layers.add(p.layer);
    } else {
      missing_inputs.push({
        layer: p.layer,
        field: p.field,
        weight: p.weight,
        reason: 'no_numeric_value',
      });
    }
  }
  // Determine missing layers (a layer is missing only when NO field in it is present).
  const allLayers = new Set(SCORE_PARTS.map(p => p.layer));
  for (const layer of allLayers) {
    if (!present_layers.has(layer)) missing_layers_set.add(layer);
  }
  // Fill in contributions now that den is known.
  if (den > 0) {
    for (const u of inputs_used) {
      u.normalized_weight = +(u.weight / den).toFixed(4);
      u.contribution = +(u.value * (u.weight / den)).toFixed(2);
    }
  }
  const composite = den === 0 ? null : Math.round(clamp(num / den, 0, 100));
  return {
    composite_score: composite,
    present_weight_sum: +den.toFixed(4),
    inputs_used,
    missing_inputs,
    layers_present: [...present_layers].sort(),
    layers_missing: [...missing_layers_set].sort(),
  };
}

// Lane status from per-driver score, overall data quality, lane availability.
// THRESHOLDS BY LANE (score):
//   win:    PICK >= 85, EVIDENCE_LEAN >= 75, LEAN >= 65
//   top_5:  PICK >= 80, EVIDENCE_LEAN >= 70, LEAN >= 60
//   top_10: PICK >= 72, EVIDENCE_LEAN >= 62, LEAN >= 52
//   top_20: PICK >= 60, EVIDENCE_LEAN >= 50, LEAN >= 40
const LANE_THRESHOLDS = Object.freeze({
  win:    { PICK: 85, EVIDENCE_LEAN: 75, LEAN: 65 },
  top_5:  { PICK: 80, EVIDENCE_LEAN: 70, LEAN: 60 },
  top_10: { PICK: 72, EVIDENCE_LEAN: 62, LEAN: 52 },
  top_20: { PICK: 60, EVIDENCE_LEAN: 50, LEAN: 40 },
});

function rawStatusFor(lane, score) {
  if (score === null) return 'NO CLEAR PICK';
  const t = LANE_THRESHOLDS[lane];
  if (score >= t.PICK) return 'PICK';
  if (score >= t.EVIDENCE_LEAN) return 'EVIDENCE_LEAN';
  if (score >= t.LEAN) return 'LEAN';
  return 'WATCH';
}

// Count distinct fundamentals LAYERS (not fields) with a usable numeric
// value for this driver. driver_skill_rating and driver_ability_to_convert
// both live in the driver_skill layer, so they count as ONE layer of
// coverage. This drives the per-driver coverage cap.
function fundamentalsLayerCoverage(d) {
  if (!d) return 0;
  const has = (v) => {
    if (v === null || v === undefined || v === '') return false;
    const n = Number(v);
    return Number.isFinite(n);
  };
  const layers = {
    driver_skill: has(d.driver_skill_rating) || has(d.driver_ability_to_convert),
    team_equipment: has(d.team_equipment_quality),
    pit_crew: has(d.pit_crew_crew_chief_grade),
    strategy_risk: has(d.strategy_risk_rating),
  };
  return Object.values(layers).filter(Boolean).length;
}

// Per-driver coverage cap. No driver may reach EVIDENCE_LEAN or PICK from
// a single fundamentals layer alone.
//   0 layers -> NO CLEAR PICK
//   1 layer  -> max LEAN
//   2 layers -> max EVIDENCE_LEAN
//   3+ layers -> PICK eligible (still subject to data_quality + market caps)
const STATUS_RANK = Object.freeze({
  'NO CLEAR PICK': 0,
  WATCH: 1,
  LEAN: 2,
  EVIDENCE_LEAN: 3,
  PICK: 4,
});
function coverageLabel(coverage) {
  if (coverage <= 0) return 'zero-layer (NO CLEAR PICK)';
  if (coverage === 1) return 'single-layer (LEAN max)';
  if (coverage === 2) return 'two-layer (EVIDENCE_LEAN max)';
  return `${coverage}-layer (PICK eligible)`;
}

function coveragePenaltyLabel(coverage) {
  if (coverage <= 0) return '0 layers -> NO CLEAR PICK (coverage cap forces this)';
  if (coverage === 1) return '1 layer -> max LEAN (single-layer cap: LEAN max)';
  if (coverage === 2) return '2 layers -> max EVIDENCE_LEAN (two-layer cap)';
  return `${coverage} layers -> PICK eligible subject to global data-quality cap`;
}

function applyCoverageCap(status, coverage) {
  if (coverage <= 0) return { status: 'NO CLEAR PICK', reason: 'fundamentals_coverage_zero_layers' };
  if (coverage === 1) {
    if (STATUS_RANK[status] > STATUS_RANK.LEAN) {
      return { status: 'LEAN', reason: 'fundamentals_coverage_one_layer_cap_lean' };
    }
    return { status, reason: null };
  }
  if (coverage === 2) {
    if (STATUS_RANK[status] > STATUS_RANK.EVIDENCE_LEAN) {
      return { status: 'EVIDENCE_LEAN', reason: 'fundamentals_coverage_two_layers_cap_evidence_lean' };
    }
    return { status, reason: null };
  }
  return { status, reason: null };
}

// Cap status given overall data quality + market availability.
function gateStatus({ rawStatus, overallDataQuality, marketAvailable, isStorylineBeneficiary, coverage = 0 }) {
  const reasons = [];
  let status = rawStatus;
  if (!marketAvailable) {
    status = 'NO CLEAR PICK';
    reasons.push('missing_market');
    return { status, reasons };
  }
  if (overallDataQuality === 'unavailable') {
    status = 'NO CLEAR PICK';
    reasons.push('fundamentals_unavailable');
  } else if (overallDataQuality === 'degraded') {
    // Cap at WATCH — no PICK/EVIDENCE_LEAN/LEAN allowed on degraded fundamentals.
    if (status === 'PICK' || status === 'EVIDENCE_LEAN' || status === 'LEAN') {
      status = 'WATCH';
      reasons.push('fundamentals_degraded_cap_watch');
    }
  } else if (overallDataQuality === 'partial') {
    // Cap at EVIDENCE_LEAN — no PICK allowed on partial fundamentals.
    if (status === 'PICK') { status = 'EVIDENCE_LEAN'; reasons.push('fundamentals_partial_cap_evidence_lean'); }
  }
  // Per-driver coverage cap: 1 layer -> max LEAN, 2 -> max EVIDENCE_LEAN, 3+ -> PICK eligible.
  if (status !== 'NO CLEAR PICK') {
    const capped = applyCoverageCap(status, coverage);
    if (capped.status !== status) {
      status = capped.status;
      if (capped.reason) reasons.push(capped.reason);
    }
  }
  // Storyline alone never creates PICK/EVIDENCE_LEAN — but the status here
  // came from fundamentals, not storyline. Beneficiary flag is informational.
  if (isStorylineBeneficiary && (status === 'NO CLEAR PICK' || status === 'WATCH')) {
    reasons.push('storyline_beneficiary_watch_flag');
  }
  return { status, reasons };
}

// Human-readable explanation for a single gating/cap reason code.
const REASON_EXPLANATIONS = Object.freeze({
  missing_market: 'Market lane is not source-available; downgraded to NO CLEAR PICK.',
  fundamentals_unavailable: 'Overall fundamentals data quality is unavailable; lane forced to NO CLEAR PICK.',
  fundamentals_degraded_cap_watch: 'Overall fundamentals data quality is degraded; lane capped at WATCH.',
  fundamentals_partial_cap_evidence_lean: 'Overall fundamentals data quality is partial; PICK not allowed, capped at EVIDENCE_LEAN.',
  fundamentals_coverage_zero_layers: 'No usable fundamentals layers for this driver; NO CLEAR PICK.',
  fundamentals_coverage_one_layer_cap_lean: 'Single-layer cap: only one fundamentals layer present, ceiling is LEAN.',
  fundamentals_coverage_two_layers_cap_evidence_lean: 'Two-layer cap: only two fundamentals layers present, ceiling is EVIDENCE_LEAN.',
  storyline_beneficiary_watch_flag: 'Storyline beneficiary informational flag; storyline alone never upgrades a lane.',
});

function explainReason(code) {
  return REASON_EXPLANATIONS[code] ?? code;
}

// Build one human-readable line per lane explaining where it ended up.
function laneNarrative({ lane, label, status, rawStatus, score, reasons, marketAvailable, coverage }) {
  if (!marketAvailable) {
    return `${label}: NO CLEAR PICK — market lane not source-available (missing_market).`;
  }
  if (score === null) {
    return `${label}: NO CLEAR PICK — composite score unavailable (no fundamentals inputs for this driver).`;
  }
  if (status === rawStatus && reasons.length === 0) {
    return `${label}: ${status} — score ${score} clears the ${status} threshold and no caps applied.`;
  }
  const why = reasons.length > 0
    ? reasons.map(explainReason).join(' ')
    : `Downgraded from raw ${rawStatus} to ${status}.`;
  if (STATUS_RANK[status] < STATUS_RANK[rawStatus]) {
    return `${label}: ${status} (capped down from raw ${rawStatus}, score ${score}) — ${why}`;
  }
  return `${label}: ${status} — ${why}`;
}
function rankUniverse(byDriver) {
  // Sort by composite score desc; tiebreak by driver_skill_rating desc then car_number asc.
  return [...byDriver]
    .map(d => ({ ...d, _score: driverStrengthScore(d) ?? 0 }))
    .sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score;
      const skillA = Number(a.driver_skill_rating) || 0;
      const skillB = Number(b.driver_skill_rating) || 0;
      if (skillB !== skillA) return skillB - skillA;
      return (Number(a.car_number) || 9999) - (Number(b.car_number) || 9999);
    });
}

function normalizeJoinName(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Empty fundamentals stub for a pool entry that has no fundamentals join.
// All rating fields are null so driverStrengthScore returns null → status
// becomes 'NO CLEAR PICK' (no fabricated ratings). The driver stays in the
// pool because the pool basis is points, not fundamentals.
function emptyFundamentalsStub(poolEntry, reason) {
  return {
    driver_name: poolEntry.driver_name ?? null,
    car_number: poolEntry.car_number ?? null,
    team: poolEntry.team ?? null,
    manufacturer: poolEntry.manufacturer ?? null,
    driver_skill_rating: null,
    driver_ability_to_convert: null,
    team_equipment_quality: null,
    pit_crew_crew_chief_grade: null,
    strategy_risk_rating: null,
    data_quality: 'unavailable',
    downgrade_reasons: [reason],
  };
}

export function composeMultiLaneCeilingBoard({
  fundamentals,
  supportedMarketLanes = [],
  eventContext = null,
  storylineBeneficiary = null,
  poolSize = 20,
  candidatePool = null,
  candidatePoolBasis = null,
  candidatePoolSourceUrls = [],
} = {}) {
  if (!fundamentals || !Array.isArray(fundamentals.by_driver)) {
    throw new Error('composeMultiLaneCeilingBoard requires { fundamentals.by_driver }');
  }

  // Pool selection:
  //   - If `candidatePool` is provided, the pool order is FIXED by that list
  //     (e.g. cup-points top-20). Drivers stay in the pool even when their
  //     fundamentals are missing — they get a NO CLEAR PICK lane instead of
  //     being silently dropped or replaced. This is the only path that
  //     guarantees the pool basis is what the caller asked for.
  //   - Otherwise, fall back to the legacy fundamentals-composite ranking.
  let top;
  let poolBasisLabel;
  let poolSelectionBasis;
  let poolSourceUrls = candidatePoolSourceUrls;
  let poolShortReason = null;
  const poolJoinWarnings = [];

  if (Array.isArray(candidatePool) && candidatePool.length > 0) {
    poolBasisLabel = candidatePoolBasis ?? 'externally_supplied_pool';
    poolSelectionBasis =
      `Pool order is fixed by the supplied candidatePool (${poolBasisLabel}); ` +
      'drivers without fundamentals stay in the pool with NO CLEAR PICK lanes — they are NOT dropped or replaced. ' +
      'No re-ranking by composite score is applied.';
    const fundByName = new Map();
    const fundByCar = new Map();
    for (const d of fundamentals.by_driver) {
      if (d.driver_name) fundByName.set(normalizeJoinName(d.driver_name), d);
      if (Number.isFinite(Number(d.car_number))) fundByCar.set(Number(d.car_number), d);
    }
    top = candidatePool.slice(0, poolSize).map((entry, i) => {
      const norm = normalizeJoinName(entry.driver_name);
      const carNum = Number.isFinite(Number(entry.car_number)) ? Number(entry.car_number) : null;
      const matched =
        (norm && fundByName.get(norm)) ||
        (carNum !== null && fundByCar.get(carNum)) ||
        null;
      if (!matched) {
        poolJoinWarnings.push(
          `pool_rank=${i + 1} driver="${entry.driver_name ?? 'unknown'}" car=${entry.car_number ?? 'unknown'} has no fundamentals join; lanes will be NO CLEAR PICK.`,
        );
        return emptyFundamentalsStub(entry, 'no_fundamentals_join');
      }
      // Prefer the pool entry's identity fields (canonical) when set,
      // otherwise keep the fundamentals values.
      return {
        ...matched,
        driver_name: entry.driver_name ?? matched.driver_name,
        car_number: entry.car_number ?? matched.car_number,
        team: entry.team ?? matched.team,
        manufacturer: entry.manufacturer ?? matched.manufacturer,
      };
    });
    if (candidatePool.length < poolSize) {
      poolShortReason = `candidatePool has only ${candidatePool.length} entries (< ${poolSize}); pool is short — no fabricated drivers added.`;
    }
  } else {
    poolBasisLabel = 'fundamentals_composite_top_20';
    poolSelectionBasis =
      'top-20 by fundamentals composite score (0.30 driver_skill + 0.20 ability_to_convert + 0.30 team_equipment + 0.10 pit_crew + 0.10 strategy_risk); ' +
      'missing layers re-weight present components; ties broken by driver_skill_rating desc then car_number asc.';
    const universe = rankUniverse(fundamentals.by_driver);
    top = universe.slice(0, poolSize);
    poolShortReason = universe.length < poolSize
      ? `driver_universe has only ${universe.length} drivers (< ${poolSize}); pool padded short — no fabricated drivers added.`
      : null;
  }

  // Map kalshi lane availability.
  const laneAvail = new Map();
  for (const lane of LANES) {
    const kalshiKey = LANE_KALSHI_KEY[lane];
    const rec = supportedMarketLanes.find(l => l.market_lane === kalshiKey);
    laneAvail.set(lane, rec ? rec.source_available !== false : false);
  }

  const overallDQ = fundamentals.overall_data_quality ?? 'unavailable';
  const beneficiaryKey = storylineBeneficiary
    ? `${storylineBeneficiary.driver_name ?? ''}|${storylineBeneficiary.car_number ?? ''}`.toLowerCase()
    : null;

  const candidates = top.map((d, i) => {
    const breakdown = scoreBreakdown(d);
    const score = breakdown.composite_score;
    const coverage = fundamentalsLayerCoverage(d);
    const coverage_label = coverageLabel(coverage);
    const coverage_penalty = coveragePenaltyLabel(coverage);
    const dKey = `${d.driver_name ?? ''}|${d.car_number ?? ''}`.toLowerCase();
    const isBene = beneficiaryKey && dKey === beneficiaryKey;

    // Build a layer-level evidence ledger: one row per fundamentals layer
    // showing whether it contributed, what value, and what its share was.
    const layer_evidence_ledger = SCORE_PARTS
      // collapse multi-field layers (driver_skill has 2 fields) by layer
      .reduce((acc, p) => {
        if (!acc.some(r => r.layer === p.layer)) acc.push({ layer: p.layer, fields: [] });
        acc.find(r => r.layer === p.layer).fields.push(p.field);
        return acc;
      }, [])
      .map(({ layer, fields }) => {
        const used = breakdown.inputs_used.filter(u => u.layer === layer);
        const missing = breakdown.missing_inputs.filter(m => m.layer === layer);
        const present = used.length > 0;
        return {
          layer,
          present,
          fields_used: used.map(u => ({
            field: u.field,
            value: u.value,
            normalized_weight: u.normalized_weight,
            contribution: u.contribution,
          })),
          fields_missing: missing.map(m => ({ field: m.field, reason: m.reason })),
          contribution_total: present
            ? +used.reduce((s, u) => s + (u.contribution ?? 0), 0).toFixed(2)
            : 0,
          reason: present
            ? `present (${fields.filter(f => used.some(u => u.field === f)).join(', ') || 'partial fields'})`
            : 'no source-backed value for this layer; excluded from score',
        };
      });

    const lanes = {};
    for (const lane of LANES) {
      const raw = rawStatusFor(lane, score);
      const marketAvailable = laneAvail.get(lane) === true;
      const { status, reasons } = gateStatus({
        rawStatus: raw,
        overallDataQuality: overallDQ,
        marketAvailable,
        isStorylineBeneficiary: isBene,
        coverage,
      });
      const narrative = laneNarrative({
        lane, label: LANE_LABELS[lane], status, rawStatus: raw, score, reasons, marketAvailable, coverage,
      });
      lanes[lane] = {
        lane,
        label: LANE_LABELS[lane],
        status,
        raw_status: raw,
        score,
        reasons,
        reason_explanations: reasons.map(r => ({ code: r, text: explainReason(r) })),
        narrative,
        market_source_available: marketAvailable,
        threshold_used: LANE_THRESHOLDS[lane],
        downgraded: STATUS_RANK[status] < STATUS_RANK[raw],
      };
    }

    // Per-driver top-level reasoning summary: a single line summarizing what
    // the composite score was built from, the coverage cap, and any global cap.
    let score_reasoning;
    if (coverage === 0) {
      score_reasoning =
        'NO CLEAR PICK: no usable fundamentals layers for this driver. ' +
        'Score is unavailable; all lanes default to NO CLEAR PICK.';
    } else {
      const presentList = breakdown.layers_present.join(', ');
      const missingList = breakdown.layers_missing.length > 0
        ? breakdown.layers_missing.join(', ')
        : 'none';
      const contribs = breakdown.inputs_used
        .map(u => `${u.field}=${u.value}×${u.normalized_weight}=${u.contribution}`)
        .join(' + ');
      score_reasoning =
        `composite_score=${score} from ${coverage} layer(s) [${presentList}]. ` +
        `Contributions: ${contribs}. Missing layers: ${missingList}. ` +
        `Coverage rule: ${coverage_penalty}.`;
    }

    return {
      pool_rank: i + 1,
      driver_name: d.driver_name,
      car_number: d.car_number,
      team: d.team,
      manufacturer: d.manufacturer,
      composite_score: score,
      fundamentals_layer_coverage: coverage,
      fundamentals_layer_coverage_label: coverage_label,
      coverage_cap_rule: coverage_penalty,
      score_reasoning,
      score_breakdown: breakdown,
      layer_evidence_ledger,
      data_quality: d.data_quality,
      driver_skill_rating: d.driver_skill_rating,
      team_equipment_quality: d.team_equipment_quality,
      pit_crew_crew_chief_grade: d.pit_crew_crew_chief_grade,
      strategy_risk_rating: d.strategy_risk_rating,
      driver_ability_to_convert: d.driver_ability_to_convert,
      storyline_beneficiary: !!isBene,
      lanes,
    };
  });

  const board = {
    schema_version: 'nascar_multi_lane_ceiling_board_v1',
    mode: 'fixtures-first',
    event_context: eventContext,
    pool_selection_basis: poolSelectionBasis,
    candidate_pool_basis: poolBasisLabel,
    candidate_pool_source_urls: poolSourceUrls,
    candidate_pool_join_warnings: poolJoinWarnings,
    candidate_pool_size: candidates.length,
    pool_short_reason: poolShortReason,
    lanes: [...LANES],
    lane_labels: { ...LANE_LABELS },
    statuses: [...STATUSES],
    fundamentals_data_quality: overallDQ,
    fundamentals_allowed_max_posture: fundamentals.allowed_max_posture ?? null,
    market_lane_availability: Object.fromEntries(laneAvail),
    storyline_beneficiary: storylineBeneficiary
      ? {
          driver_name: storylineBeneficiary.driver_name ?? null,
          car_number: storylineBeneficiary.car_number ?? null,
          connection_type: storylineBeneficiary.connection_type ?? null,
        }
      : null,
    candidates,
    safety_notes: [
      'Storyline alone cannot create PICK or EVIDENCE_LEAN; storyline beneficiary may be flagged WATCH only.',
      'Market context (price/OI/volume/line movement) cannot create PICK or EVIDENCE_LEAN; missing market lanes downgrade to NO CLEAR PICK with reason "missing_market".',
      'Fundamentals data_quality caps allowed status: degraded -> WATCH ceiling, partial -> EVIDENCE_LEAN ceiling, ok -> full PICK eligibility.',
      'Per-driver fundamentals coverage cap: 0 layers -> NO CLEAR PICK, 1 layer -> max LEAN, 2 layers -> max EVIDENCE_LEAN, 3+ layers -> PICK eligible (still subject to data_quality and market caps).',
      'No trade, order, stake, fair_value, edge, kelly, or execution fields emitted.',
    ],
  };
  assertNoForbidden(board);
  return board;
}

export {
  LANES as MULTI_LANE_LANES,
  STATUSES as MULTI_LANE_STATUSES,
  LANE_THRESHOLDS as MULTI_LANE_THRESHOLDS,
};
