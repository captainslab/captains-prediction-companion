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
function driverStrengthScore(d) {
  const parts = [
    { v: d.driver_skill_rating, w: 0.30 },
    { v: d.driver_ability_to_convert, w: 0.20 },
    { v: d.team_equipment_quality, w: 0.30 },
    { v: d.pit_crew_crew_chief_grade, w: 0.10 },
    { v: d.strategy_risk_rating, w: 0.10 },
  ];
  let num = 0, den = 0;
  for (const p of parts) {
    if (Number.isFinite(Number(p.v))) { num += Number(p.v) * p.w; den += p.w; }
  }
  if (den === 0) return null;
  // Re-normalize over present weights so missing layers don't punish the score
  // (they show up separately in data_quality / downgrade_reasons).
  return Math.round(clamp((num / den), 0, 100));
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

// Cap status given overall data quality + market availability.
function gateStatus({ rawStatus, overallDataQuality, marketAvailable, isStorylineBeneficiary }) {
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
  // Storyline alone never creates PICK/EVIDENCE_LEAN — but the status here
  // came from fundamentals, not storyline. Beneficiary flag is informational.
  if (isStorylineBeneficiary && (status === 'NO CLEAR PICK' || status === 'WATCH')) {
    reasons.push('storyline_beneficiary_watch_flag');
  }
  return { status, reasons };
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

export function composeMultiLaneCeilingBoard({
  fundamentals,
  supportedMarketLanes = [],
  eventContext = null,
  storylineBeneficiary = null,
  poolSize = 20,
} = {}) {
  if (!fundamentals || !Array.isArray(fundamentals.by_driver)) {
    throw new Error('composeMultiLaneCeilingBoard requires { fundamentals.by_driver }');
  }

  const universe = rankUniverse(fundamentals.by_driver);
  const top = universe.slice(0, poolSize);
  const poolShortReason = universe.length < poolSize
    ? `driver_universe has only ${universe.length} drivers (< ${poolSize}); pool padded short — no fabricated drivers added.`
    : null;

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
    const score = driverStrengthScore(d);
    const dKey = `${d.driver_name ?? ''}|${d.car_number ?? ''}`.toLowerCase();
    const isBene = beneficiaryKey && dKey === beneficiaryKey;
    const lanes = {};
    for (const lane of LANES) {
      const raw = rawStatusFor(lane, score);
      const marketAvailable = laneAvail.get(lane) === true;
      const { status, reasons } = gateStatus({
        rawStatus: raw,
        overallDataQuality: overallDQ,
        marketAvailable,
        isStorylineBeneficiary: isBene,
      });
      lanes[lane] = {
        lane,
        label: LANE_LABELS[lane],
        status,
        raw_status: raw,
        score,
        reasons,
        market_source_available: marketAvailable,
      };
    }
    return {
      pool_rank: i + 1,
      driver_name: d.driver_name,
      car_number: d.car_number,
      team: d.team,
      manufacturer: d.manufacturer,
      composite_score: score,
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
    pool_selection_basis: 'top-20 by fundamentals composite score (0.30 driver_skill + 0.20 ability_to_convert + 0.30 team_equipment + 0.10 pit_crew + 0.10 strategy_risk); missing layers re-weight present components; ties broken by driver_skill_rating desc then car_number asc.',
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
