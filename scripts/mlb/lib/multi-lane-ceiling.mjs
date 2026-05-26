// MLB multi-lane ceiling board.
//
// Takes the output of evidence-ledger.mjs and produces per-lane status
// grids for a game. Mirrors scripts/nascar/lib/multi-lane-ceiling.mjs.
//
// Supported lanes:
//   moneyline_away | moneyline_home
//   run_line_away  | run_line_home   (-1.5 / +1.5)
//   total_over     | total_under
//   yrfi           | nrfi
//
// Lane status enum (same vocab as NASCAR):
//   PICK | EVIDENCE_LEAN | LEAN | WATCH | NO CLEAR PICK | MARKET_ONLY
//
// Hard rules (mirror NASCAR):
//   - Market prices NEVER create PICK or EVIDENCE_LEAN. When fundamentals
//     are unavailable and only market data exists, lane is MARKET_ONLY.
//   - Fundamentals data_quality caps status:
//       degraded    → max WATCH
//       partial     → max EVIDENCE_LEAN
//       ok          → PICK eligible
//   - Coverage caps (per side):
//       0 layers → NO CLEAR PICK
//       1 layer  → max LEAN
//       2 layers → max EVIDENCE_LEAN
//       3+ layers → PICK eligible (subject to data_quality cap)
//   - No trade / order / stake / fair_value / edge / kelly / execution fields.

const STATUSES = Object.freeze([
  'PICK', 'EVIDENCE_LEAN', 'LEAN', 'WATCH', 'NO CLEAR PICK', 'MARKET_ONLY',
]);

const STATUS_RANK = Object.freeze({
  'NO CLEAR PICK': 0,
  WATCH:           1,
  LEAN:            2,
  EVIDENCE_LEAN:   3,
  PICK:            4,
});

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// --- Moneyline thresholds ---------------------------------------------------
// Score differential between stronger and weaker side.
//   PICK          differential >= 25
//   EVIDENCE_LEAN differential >= 15
//   LEAN          differential >= 8
//   WATCH         differential <  8

const ML_THRESHOLDS = Object.freeze({ PICK: 25, EVIDENCE_LEAN: 15, LEAN: 8 });

// --- Run-line thresholds (need higher differential to justify -1.5) --------
const RL_THRESHOLDS = Object.freeze({ PICK: 32, EVIDENCE_LEAN: 22, LEAN: 15 });

// --- Total (over / under) thresholds ---------------------------------------
// over_signal / under_signal are 0-100 derived from evidence-ledger
const TOTAL_THRESHOLDS = Object.freeze({ PICK: 76, EVIDENCE_LEAN: 66, LEAN: 56 });

// --- YRFI / NRFI thresholds ------------------------------------------------
const YRFI_THRESHOLDS = Object.freeze({ PICK: 74, EVIDENCE_LEAN: 64, LEAN: 54 });

// ---------------------------------------------------------------------------

function rawStatusFromDifferential(diff, thresholds) {
  if (diff === null) return 'NO CLEAR PICK';
  if (diff >= thresholds.PICK)          return 'PICK';
  if (diff >= thresholds.EVIDENCE_LEAN) return 'EVIDENCE_LEAN';
  if (diff >= thresholds.LEAN)          return 'LEAN';
  return 'WATCH';
}

function rawStatusFromSignal(signal, thresholds) {
  if (signal === null) return 'NO CLEAR PICK';
  if (signal >= thresholds.PICK)          return 'PICK';
  if (signal >= thresholds.EVIDENCE_LEAN) return 'EVIDENCE_LEAN';
  if (signal >= thresholds.LEAN)          return 'LEAN';
  return 'WATCH';
}

function applyCoverageCap(status, layersPresent) {
  if (layersPresent <= 0) return { status: 'NO CLEAR PICK', reason: 'coverage_zero_layers' };
  if (layersPresent === 1 && STATUS_RANK[status] > STATUS_RANK.LEAN) {
    return { status: 'LEAN', reason: 'coverage_one_layer_cap_lean' };
  }
  if (layersPresent === 2 && STATUS_RANK[status] > STATUS_RANK.EVIDENCE_LEAN) {
    return { status: 'EVIDENCE_LEAN', reason: 'coverage_two_layer_cap_evidence_lean' };
  }
  return { status, reason: null };
}

function applyDataQualityCap(status, dataQuality) {
  if (dataQuality === 'unavailable') return { status: 'NO CLEAR PICK', reason: 'data_quality_unavailable' };
  if (dataQuality === 'degraded' && STATUS_RANK[status] > STATUS_RANK.WATCH) {
    return { status: 'WATCH', reason: 'data_quality_degraded_cap_watch' };
  }
  if (dataQuality === 'partial' && status === 'PICK') {
    return { status: 'EVIDENCE_LEAN', reason: 'data_quality_partial_cap_evidence_lean' };
  }
  return { status, reason: null };
}

function gateStatus({ rawStatus, dataQuality, layersPresent, marketAvailable = true }) {
  const reasons = [];
  if (!marketAvailable) {
    return { status: 'NO CLEAR PICK', reasons: ['missing_market'] };
  }
  let status = rawStatus;
  const dqCap = applyDataQualityCap(status, dataQuality);
  if (dqCap.reason) { status = dqCap.status; reasons.push(dqCap.reason); }
  const covCap = applyCoverageCap(status, layersPresent);
  if (covCap.reason) { status = covCap.status; reasons.push(covCap.reason); }
  return { status, reasons };
}

const REASON_LABELS = Object.freeze({
  missing_market:                          'Market lane not source-available.',
  data_quality_unavailable:                'Fundamentals unavailable — forced NO CLEAR PICK.',
  data_quality_degraded_cap_watch:         'Fundamentals degraded — capped at WATCH.',
  data_quality_partial_cap_evidence_lean:  'Fundamentals partial — PICK capped at EVIDENCE_LEAN.',
  coverage_zero_layers:                    'No usable evidence layers — NO CLEAR PICK.',
  coverage_one_layer_cap_lean:             'Single-layer coverage — ceiling is LEAN.',
  coverage_two_layer_cap_evidence_lean:    'Two-layer coverage — ceiling is EVIDENCE_LEAN.',
});

function explainReasons(reasons) {
  return reasons.map(r => REASON_LABELS[r] ?? r);
}

// --- Build one lane entry ---------------------------------------------------

function buildLane({
  lane, label, direction,
  rawStatus, score, diff,
  dataQuality, layersPresent, marketAvailable,
}) {
  const { status, reasons } = gateStatus({ rawStatus, dataQuality, layersPresent, marketAvailable });
  const downgraded = STATUS_RANK[status] < STATUS_RANK[rawStatus];
  const narrative = !marketAvailable
    ? `${label}: NO CLEAR PICK — market not available.`
    : score === null
      ? `${label}: NO CLEAR PICK — no evidence score available.`
      : downgraded
        ? `${label}: ${status} (capped from raw ${rawStatus}, score ${score}${diff != null ? `, diff ${diff}` : ''}) — ${explainReasons(reasons).join(' ')}`
        : `${label}: ${status} — score ${score}${diff != null ? `, differential ${diff}` : ''}.${reasons.length ? ' ' + explainReasons(reasons).join(' ') : ''}`;
  return {
    lane, label, direction,
    status, raw_status: rawStatus,
    score, differential: diff,
    layers_present: layersPresent,
    data_quality: dataQuality,
    reasons,
    reason_explanations: explainReasons(reasons),
    narrative,
    market_source_available: marketAvailable,
    downgraded,
  };
}

// --- Public composer --------------------------------------------------------

// --- CLV tracking metadata builder -----------------------------------------
// Tracks market price movement for validation purposes only.
// CLV data NEVER contributes to composite score or pick status.
// Use for post-game CLV analysis / model calibration only.
export function buildClvTrackingMetadata({ lanes = [] } = {}) {
  const entries = [];
  for (const l of lanes) {
    if (!l.lane || l.open_price == null) continue;
    const current = l.current_price ?? l.open_price;
    const delta = +(current - l.open_price).toFixed(4);
    const deltaPct = l.open_price > 0
      ? +(delta / l.open_price * 100).toFixed(2) : null;
    entries.push({
      lane:          l.lane,
      direction:     l.direction ?? null,
      open_price:    l.open_price,
      current_price: current,
      delta,
      delta_pct:     deltaPct,
      note:          'CLV metadata only — never used as composite score input',
    });
  }
  return { schema: 'mlb_clv_tracking_v1', entries, safety: 'market_price_not_in_score' };
}

export function composeMultiLaneCeilingBoard({
  gameLedger,
  supportedMarketLanes = [],
  eventContext = null,
  clvInputs = [],          // optional CLV price points — metadata only, never scored
} = {}) {
  if (!gameLedger) throw new Error('composeMultiLaneCeilingBoard requires gameLedger from evidence-ledger');

  const { away, home, total_signal } = gameLedger;

  const awayScore = away?.composite_score ?? null;
  const homeScore = home?.composite_score ?? null;
  const awayLP    = away?.layers_present  ?? 0;
  const homeLP    = home?.layers_present  ?? 0;

  // Determine the stronger side (for moneyline / run-line direction)
  const diff = (awayScore !== null && homeScore !== null)
    ? Math.abs(awayScore - homeScore) : null;
  const strongerSide = diff !== null
    ? (awayScore >= homeScore ? 'away' : 'home') : null;

  // Data quality: use the weaker of the two sides for ML/RL (conservative)
  const DQ_RANK = { ok: 3, partial: 2, degraded: 1, unavailable: 0 };
  const awayDQ = away?.evidence_ledger?.[0]
    ? (gameLedger.away_data_quality ?? 'unavailable') : 'unavailable';
  const homeDQ = home?.evidence_ledger?.[0]
    ? (gameLedger.home_data_quality ?? 'unavailable') : 'unavailable';

  // More accurate DQ: scan the fundamentals layer in the ledger
  const getDQ = (ledger) => {
    if (!ledger?.evidence_ledger) return 'unavailable';
    const baseLayer = ledger.evidence_ledger.find(r => r.category === 'baseline_fundamentals');
    if (!baseLayer?.present) return 'degraded';
    if (baseLayer.value === null) return 'unavailable';
    if (baseLayer.value < 30) return 'degraded';
    return ledger.layers_present >= 3 ? 'ok' : ledger.layers_present >= 2 ? 'partial' : 'degraded';
  };

  const awayDataQuality = getDQ(away);
  const homeDataQuality = getDQ(home);
  const combinedDQ = [awayDataQuality, homeDataQuality].sort((a, b) => DQ_RANK[a] - DQ_RANK[b])[0];

  const isLaneAvailable = (key) => {
    const rec = supportedMarketLanes.find(l => l.lane === key || l.market_lane === key);
    return rec ? rec.source_available !== false : true; // default available if not specified
  };

  // --- Moneyline lanes -------------------------------------------------------
  const mlAwayRaw = strongerSide === 'away'
    ? rawStatusFromDifferential(diff, ML_THRESHOLDS) : 'WATCH';
  const mlHomeRaw = strongerSide === 'home'
    ? rawStatusFromDifferential(diff, ML_THRESHOLDS) : 'WATCH';

  const moneylineAway = buildLane({
    lane: 'moneyline_away', label: `${away?.team_name ?? 'Away'} ML`,
    direction: 'away', rawStatus: mlAwayRaw,
    score: awayScore, diff: strongerSide === 'away' ? diff : (diff !== null ? -diff : null),
    dataQuality: awayDataQuality, layersPresent: awayLP,
    marketAvailable: isLaneAvailable('moneyline'),
  });

  const moneylineHome = buildLane({
    lane: 'moneyline_home', label: `${home?.team_name ?? 'Home'} ML`,
    direction: 'home', rawStatus: mlHomeRaw,
    score: homeScore, diff: strongerSide === 'home' ? diff : (diff !== null ? -diff : null),
    dataQuality: homeDataQuality, layersPresent: homeLP,
    marketAvailable: isLaneAvailable('moneyline'),
  });

  // --- Run-line lanes --------------------------------------------------------
  const rlAwayRaw = strongerSide === 'away'
    ? rawStatusFromDifferential(diff, RL_THRESHOLDS) : 'WATCH';
  const rlHomeRaw = strongerSide === 'home'
    ? rawStatusFromDifferential(diff, RL_THRESHOLDS) : 'WATCH';

  const runLineAway = buildLane({
    lane: 'run_line_away', label: `${away?.team_name ?? 'Away'} -1.5`,
    direction: 'away', rawStatus: rlAwayRaw,
    score: awayScore, diff: strongerSide === 'away' ? diff : (diff !== null ? -diff : null),
    dataQuality: awayDataQuality, layersPresent: awayLP,
    marketAvailable: isLaneAvailable('run_line'),
  });

  const runLineHome = buildLane({
    lane: 'run_line_home', label: `${home?.team_name ?? 'Home'} -1.5`,
    direction: 'home', rawStatus: rlHomeRaw,
    score: homeScore, diff: strongerSide === 'home' ? diff : (diff !== null ? -diff : null),
    dataQuality: homeDataQuality, layersPresent: homeLP,
    marketAvailable: isLaneAvailable('run_line'),
  });

  // --- Total lanes -----------------------------------------------------------
  const totalOver = buildLane({
    lane: 'total_over', label: 'Total OVER',
    direction: 'over',
    rawStatus: rawStatusFromSignal(total_signal?.over_signal, TOTAL_THRESHOLDS),
    score: total_signal?.over_signal ?? null, diff: null,
    dataQuality: combinedDQ,
    layersPresent: total_signal?.layers_present ?? 0,
    marketAvailable: isLaneAvailable('game_total'),
  });

  const totalUnder = buildLane({
    lane: 'total_under', label: 'Total UNDER',
    direction: 'under',
    rawStatus: rawStatusFromSignal(total_signal?.under_signal, TOTAL_THRESHOLDS),
    score: total_signal?.under_signal ?? null, diff: null,
    dataQuality: combinedDQ,
    layersPresent: total_signal?.layers_present ?? 0,
    marketAvailable: isLaneAvailable('game_total'),
  });

  // --- YRFI / NRFI lanes ----------------------------------------------------
  // YRFI: first-inning scoring signal. Reuse over_signal as proxy unless
  // a dedicated first-inning record is available.
  // First-inning is generally dominated by starter quality in innings 1-2.
  const yrfiSignal = total_signal?.over_signal != null
    ? Math.round(clamp(total_signal.over_signal * 0.85, 0, 100)) : null;
  const nrfiSignal = yrfiSignal != null ? 100 - yrfiSignal : null;

  const yrfi = buildLane({
    lane: 'yrfi', label: 'YRFI (runs score in 1st)',
    direction: 'yrfi',
    rawStatus: rawStatusFromSignal(yrfiSignal, YRFI_THRESHOLDS),
    score: yrfiSignal, diff: null,
    dataQuality: combinedDQ,
    layersPresent: total_signal?.layers_present ?? 0,
    marketAvailable: isLaneAvailable('yrfi_nrfi'),
  });

  const nrfi = buildLane({
    lane: 'nrfi', label: 'NRFI (no runs in 1st)',
    direction: 'nrfi',
    rawStatus: rawStatusFromSignal(nrfiSignal, YRFI_THRESHOLDS),
    score: nrfiSignal, diff: null,
    dataQuality: combinedDQ,
    layersPresent: total_signal?.layers_present ?? 0,
    marketAvailable: isLaneAvailable('yrfi_nrfi'),
  });

  // --- Collect all actionable lanes (LEAN or better) ------------------------
  const lanes = [moneylineAway, moneylineHome, runLineAway, runLineHome, totalOver, totalUnder, yrfi, nrfi];
  const actionable = lanes
    .filter(l => STATUS_RANK[l.status] >= STATUS_RANK.LEAN)
    .sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status]);

  // Deduplicate moneyline (don't emit BOTH away and home unless both have LEAN+)
  const mlActionable = actionable.filter(l => l.lane.startsWith('moneyline'));
  const rlActionable = actionable.filter(l => l.lane.startsWith('run_line'));
  const totalActionable = actionable.filter(l => l.lane.startsWith('total'));
  const yrfiActionable  = actionable.filter(l => l.lane === 'yrfi' || l.lane === 'nrfi');

  // Summary: highest-confidence picks only
  const topPick = actionable[0] ?? null;

  return {
    schema_version: 'mlb_multi_lane_ceiling_board_v1',
    game_pk:    gameLedger.game_pk,
    away_team:  gameLedger.away_team,
    home_team:  gameLedger.home_team,
    event_context: eventContext,
    away_composite_score: awayScore,
    home_composite_score: homeScore,
    score_differential:   diff,
    stronger_side:        strongerSide,
    combined_data_quality: combinedDQ,
    lanes: {
      moneyline_away: moneylineAway,
      moneyline_home: moneylineHome,
      run_line_away:  runLineAway,
      run_line_home:  runLineHome,
      total_over:     totalOver,
      total_under:    totalUnder,
      yrfi,
      nrfi,
    },
    actionable_lanes: {
      moneyline: mlActionable,
      run_line:  rlActionable,
      total:     totalActionable,
      yrfi_nrfi: yrfiActionable,
    },
    top_pick: topPick,
    total_signal,
    safety_notes: [
      'Market prices do not create PICK or EVIDENCE_LEAN; missing lanes → NO CLEAR PICK.',
      'Fundamentals data_quality caps: degraded → WATCH max, partial → EVIDENCE_LEAN max.',
      'Coverage caps: 0 layers → NO CLEAR PICK, 1 → LEAN max, 2 → EVIDENCE_LEAN max, 3+ → PICK eligible.',
      'No trade, order, stake, fair_value, edge, kelly, or execution fields emitted.',
    ],
    clv_tracking: buildClvTrackingMetadata({ lanes: clvInputs }),
    statuses: [...STATUSES],
  };
}
