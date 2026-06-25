import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeJsonAtomic, writeTextAtomic } from './file-io.mjs';
import { scoreMarkets } from './scoring-core.mjs';

export const KALSHI_BASEBALL_CALENDAR_URL = 'https://kalshi.com/calendar/sports/baseball';
const SCHEMA_VERSION = '1.0';
const OPERATOR = 'sports-pre-game';
const MARKET_LANES = Object.freeze([
  'moneyline',
  'run_line',
  'game_total',
  'yrfi_nrfi',
  'home_run_hitter',
  'pitcher_strikeouts',
]);
const SAME_GAME_COMBO_VISIBLE_STATUSES = new Set([
  'CLEAR_PICK',
  'PRE_LINEUP_PICK',
  'LEAN',
  'WATCH_FOR_PRICE',
]);
const SAME_GAME_COMBO_SURFACE_STATUSES = new Set([
  ...SAME_GAME_COMBO_VISIBLE_STATUSES,
  'PASS',
]);
const SAME_GAME_COMBO_LANE_PRIORITY = new Map([
  ['moneyline', 0],
  ['run_line', 1],
  ['game_total', 2],
  ['yrfi_nrfi', 3],
  ['home_run_hitter', 4],
  ['pitcher_strikeouts', 5],
]);
const SAME_GAME_COMBO_CLASSIFICATION_PRIORITY = new Map([
  ['CLEAR_PICK', 0],
  ['PRE_LINEUP_PICK', 1],
  ['LEAN', 2],
  ['WATCH_FOR_PRICE', 3],
]);
const SAME_GAME_EXPOSURE_NOTE =
  'Informational only: review same-game markets together before sizing.';

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function missingAdapterEnvelope({ sourceId, cachePath, warning }) {
  return {
    source_id: sourceId,
    status: 'blocked',
    checked_at_utc: null,
    cache_key: `${sourceId}_missing`,
    cache_path: cachePath,
    required: true,
    records: [],
    warnings: [warning],
    errors: [],
    source_urls: [],
  };
}

function readOptionalAdapter(filePath, sourceId, warning) {
  if (!existsSync(filePath)) {
    return missingAdapterEnvelope({ sourceId, cachePath: filePath, warning });
  }

  return readJson(filePath);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function lanePriority(lane) {
  return SAME_GAME_COMBO_LANE_PRIORITY.get(lane) ?? Number.MAX_SAFE_INTEGER;
}

function classificationPriority(classification) {
  return SAME_GAME_COMBO_CLASSIFICATION_PRIORITY.get(classification) ?? Number.MAX_SAFE_INTEGER;
}

function displayClassification(classification) {
  switch (classification) {
    case 'CLEAR_PICK':
      return 'top-rated';
    case 'PRE_LINEUP_PICK':
      return 'pre-lineup top-rated';
    case 'LEAN':
      return 'higher-rated';
    case 'WATCH_FOR_PRICE':
      return 'monitor only';
    case 'PASS':
      return 'no rated view';
    case 'BLOCKED_SOURCE_GAP':
      return 'blocked';
    case 'CORRELATED_ALTERNATE':
      return 'reference-only';
    default:
      return classification ?? 'unknown';
  }
}

/**
 * Return the weakest actionable status present in a combo group (informational view).
 * Used by buildSameGameCombos for same-game exposure visibility only.
 * For tradeable combo candidate classification use classifyCombo().
 */
export function comboStatusFromMembers(members) {
  const worstMember = [...safeArray(members)].sort(
    (left, right) => classificationPriority(right.classification) - classificationPriority(left.classification),
  )[0];
  return worstMember?.classification ?? null;
}

/**
 * Derive a conservative combo-specific classification from two leg objects.
 * Never returns plain singles labels (CLEAR_PICK, LEAN, etc.).
 * Priority: BLOCKED_SOURCE_GAP > COMBO_PASS > COMBO_WATCH > COMBO_CLEAR > COMBO_LEAN > COMBO_WATCH fallback.
 */
export function classifyCombo(leg1, leg2) {
  const cls1 = leg1?.classification ?? null;
  const cls2 = leg2?.classification ?? null;
  const hasMissing =
    safeArray(leg1?.missing_confirmations).length > 0 ||
    safeArray(leg2?.missing_confirmations).length > 0;

  if (cls1 === 'BLOCKED_SOURCE_GAP' || cls2 === 'BLOCKED_SOURCE_GAP') {
    return 'BLOCKED_SOURCE_GAP';
  }
  if (cls1 === 'PASS' || cls2 === 'PASS') {
    return 'COMBO_PASS';
  }
  if (cls1 === 'WATCH_FOR_PRICE' || cls2 === 'WATCH_FOR_PRICE') {
    return 'COMBO_WATCH';
  }
  if (cls1 === 'CLEAR_PICK' && cls2 === 'CLEAR_PICK') {
    return hasMissing ? 'COMBO_WATCH' : 'COMBO_CLEAR';
  }
  const leanEligible = new Set(['CLEAR_PICK', 'PRE_LINEUP_PICK', 'LEAN']);
  if (
    leanEligible.has(cls1) &&
    leanEligible.has(cls2) &&
    (cls1 === 'PRE_LINEUP_PICK' || cls1 === 'LEAN' || cls2 === 'PRE_LINEUP_PICK' || cls2 === 'LEAN')
  ) {
    return hasMissing ? 'COMBO_WATCH' : 'COMBO_LEAN';
  }
  return 'COMBO_WATCH';
}

function isBetterMoneylineEdgeCandidate(left, right) {
  if (!right) return true;
  const edgeDelta = (left.edge_pp ?? -Infinity) - (right.edge_pp ?? -Infinity);
  if (edgeDelta !== 0) return edgeDelta > 0;
  const classDelta = classificationPriority(left.classification) - classificationPriority(right.classification);
  if (classDelta !== 0) return classDelta < 0;
  const askLeft = left.kalshi_ask ?? Number.POSITIVE_INFINITY;
  const askRight = right.kalshi_ask ?? Number.POSITIVE_INFINITY;
  if (askLeft !== askRight) return askLeft < askRight;
  return String(left.market_ticker ?? '').localeCompare(String(right.market_ticker ?? '')) < 0;
}

export function buildMoneylineEdgeBoard(candidates) {
  const grouped = new Map();

  for (const candidate of safeArray(candidates)) {
    if (candidate.market_lane !== 'moneyline') continue;
    if (candidate.edge_pp === null || candidate.edge_pp === undefined || candidate.edge_pp <= 0) continue;

    const groupKey = candidate.event_ticker ?? candidate.matched_game_pk ?? candidate.game ?? candidate.market_ticker ?? null;
    if (!groupKey) continue;

    const current = grouped.get(groupKey);
    if (!current || isBetterMoneylineEdgeCandidate(candidate, current)) {
      grouped.set(groupKey, candidate);
    }
  }

  return [...grouped.entries()]
    .map(([groupKey, candidate]) => ({
      group_key: groupKey,
      game: candidate.game ?? null,
      side: candidate.contract_title ?? candidate.market_title ?? null,
      market_ticker: candidate.market_ticker ?? null,
      classification: candidate.classification ?? null,
      kalshi_ask: candidate.kalshi_ask ?? null,
      market_reference_prob: candidate.market_reference_prob ?? null,
      edge_pp: candidate.edge_pp ?? null,
      target_entry: candidate.target_entry ?? null,
      missing_confirmations: safeArray(candidate.missing_confirmations),
      why_not: safeArray(candidate.missing_confirmations).join(', ') || 'none',
    }))
    .sort((left, right) => {
      const edgeDelta = (right.edge_pp ?? -Infinity) - (left.edge_pp ?? -Infinity);
      if (edgeDelta !== 0) return edgeDelta;
      const classDelta = classificationPriority(left.classification) - classificationPriority(right.classification);
      if (classDelta !== 0) return classDelta;
      const askLeft = left.kalshi_ask ?? Number.POSITIVE_INFINITY;
      const askRight = right.kalshi_ask ?? Number.POSITIVE_INFINITY;
      if (askLeft !== askRight) return askLeft - askRight;
      return String(left.market_ticker ?? '').localeCompare(String(right.market_ticker ?? ''));
    });
}

function sameGameComboMemberLabel(candidate) {
  const lane = candidate.market_lane ?? 'unknown';
  const ticker = candidate.market_ticker ?? 'unknown';
  const classification = candidate.classification ?? 'unknown';
  const edge = candidate.edge_pp !== null && candidate.edge_pp !== undefined ? `${candidate.edge_pp}pp` : 'n/a';
  return `${lane}: ${ticker} (${classification}, ${edge})`;
}

export function calculateComboEstimates({ leg_1_ask, leg_1_market_ref, leg_2_ask, leg_2_market_ref }) {
  const hasCostInputs = leg_1_ask !== null && leg_1_ask !== undefined && leg_2_ask !== null && leg_2_ask !== undefined;
  const hasMarketRefInputs =
    leg_1_market_ref !== null && leg_1_market_ref !== undefined && leg_2_market_ref !== null && leg_2_market_ref !== undefined;
  const estimatedComboCost = hasCostInputs
    ? Math.round((leg_1_ask * leg_2_ask) * 10000) / 10000
    : null;
  const estimatedComboMarketRef = hasMarketRefInputs
    ? Math.round((leg_1_market_ref * leg_2_market_ref) * 10000) / 10000
    : null;
  const comboEdgePp =
    estimatedComboCost !== null && estimatedComboMarketRef !== null
      ? (estimatedComboMarketRef - estimatedComboCost) * 100
      : null;

  return {
    estimatedComboCost,
    estimatedComboMarketRef,
    comboEdgePp,
  };
}

export function buildSameGameCombos(candidates) {
  const grouped = new Map();

  for (const candidate of safeArray(candidates)) {
    if (!SAME_GAME_COMBO_SURFACE_STATUSES.has(candidate.classification)) continue;
    const groupKey =
      candidate.matched_game_pk ?? candidate.event_ticker ?? candidate.game ?? candidate.market_ticker ?? null;
    if (!groupKey) continue;
    if (!grouped.has(groupKey)) {
      grouped.set(groupKey, []);
    }
    grouped.get(groupKey).push(candidate);
  }

  return [...grouped.entries()]
    .map(([groupKey, members]) => {
      const actionableMembers = members.filter(member => SAME_GAME_COMBO_VISIBLE_STATUSES.has(member.classification));
      const distinctLanes = [...new Set(members.map(member => member.market_lane).filter(Boolean))].sort(
        (left, right) => lanePriority(left) - lanePriority(right) || left.localeCompare(right),
      );

      if (distinctLanes.length < 2 || actionableMembers.length === 0) {
        return null;
      }

      const sortedMembers = [...members].sort((left, right) => {
        const laneDelta = lanePriority(left.market_lane) - lanePriority(right.market_lane);
        if (laneDelta !== 0) return laneDelta;
        const classDelta = classificationPriority(left.classification) - classificationPriority(right.classification);
        if (classDelta !== 0) return classDelta;
        const edgeLeft = left.edge_pp ?? -Infinity;
        const edgeRight = right.edge_pp ?? -Infinity;
        if (edgeRight !== edgeLeft) return edgeRight - edgeLeft;
        return String(left.market_ticker ?? '').localeCompare(String(right.market_ticker ?? ''));
      });

      return {
        group_key: groupKey,
        game_pk: members[0]?.matched_game_pk ?? null,
        event_ticker: members[0]?.event_ticker ?? null,
        game: members[0]?.game ?? null,
        combo_edge_pp: Math.max(
          ...actionableMembers.map(member => member.edge_pp ?? -Infinity),
        ),
        surfaced_lanes: distinctLanes,
        lanes_present: [...new Set(actionableMembers.map(member => member.market_lane).filter(Boolean))].sort(
          (left, right) => lanePriority(left) - lanePriority(right) || left.localeCompare(right),
        ),
        combo_status: comboStatusFromMembers(actionableMembers),
        market_count: members.length,
        visible_market_count: actionableMembers.length,
        same_game_exposure_note: SAME_GAME_EXPOSURE_NOTE,
        members: sortedMembers.map(member => ({
          market_ticker: member.market_ticker ?? null,
          market_lane: member.market_lane ?? null,
          contract_title: member.contract_title ?? member.market_title ?? null,
          classification: member.classification ?? null,
          kalshi_ask: member.kalshi_ask ?? null,
          market_reference_prob: member.market_reference_prob ?? null,
          edge_pp: member.edge_pp ?? null,
          total_strike: member.total_strike ?? null,
          correlation_group: member.correlation_group ?? null,
          primary_pick: member.primary_pick ?? false,
          missing_confirmations: safeArray(member.missing_confirmations),
        })),
        display_markets: sortedMembers.map(sameGameComboMemberLabel).join('; '),
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      const edgeLeft = Math.max(...left.members.map(member => member.edge_pp ?? -Infinity));
      const edgeRight = Math.max(...right.members.map(member => member.edge_pp ?? -Infinity));
      if (edgeRight !== edgeLeft) return edgeRight - edgeLeft;
      return String(left.game ?? left.group_key ?? '').localeCompare(String(right.game ?? right.group_key ?? ''));
    });
}

function buildComboCandidates(candidates) {
  const grouped = new Map();

  for (const candidate of safeArray(candidates)) {
    if (!SAME_GAME_COMBO_VISIBLE_STATUSES.has(candidate.classification)) continue;
    const groupKey =
      candidate.matched_game_pk ?? candidate.event_ticker ?? candidate.game ?? candidate.market_ticker ?? null;
    if (!groupKey) continue;
    if (!grouped.has(groupKey)) {
      grouped.set(groupKey, []);
    }
    grouped.get(groupKey).push(candidate);
  }

  return [...grouped.entries()]
    .map(([groupKey, members]) => {
      const selectBestLaneMember = lane =>
        [...members]
          .filter(member => member.market_lane === lane && SAME_GAME_COMBO_VISIBLE_STATUSES.has(member.classification))
          .sort(
            (left, right) =>
              (right.edge_pp ?? -Infinity) - (left.edge_pp ?? -Infinity) ||
              classificationPriority(left.classification) - classificationPriority(right.classification) ||
              String(left.market_ticker ?? '').localeCompare(String(right.market_ticker ?? '')),
          )[0] ?? null;

      const moneylineMember = selectBestLaneMember('moneyline');
      const totalMember = selectBestLaneMember('game_total');
      if (!moneylineMember || !totalMember) {
        return null;
      }

      const comboMembers = [moneylineMember, totalMember];
      const sortedComboMembers = [...comboMembers].sort(
        (left, right) =>
          (right.edge_pp ?? -Infinity) - (left.edge_pp ?? -Infinity) ||
          classificationPriority(left.classification) - classificationPriority(right.classification) ||
          String(left.market_ticker ?? '').localeCompare(String(right.market_ticker ?? '')),
      );
      const bestMember = sortedComboMembers[0] ?? null;
      const secondMember = sortedComboMembers[1] ?? null;
      const comboClassification = classifyCombo(moneylineMember, totalMember);
      const { estimatedComboCost, estimatedComboMarketRef, comboEdgePp } = calculateComboEstimates(
        {
          leg_1_ask: moneylineMember?.kalshi_ask ?? null,
          leg_1_market_ref: moneylineMember?.market_reference_prob ?? null,
          leg_2_ask: totalMember?.kalshi_ask ?? null,
          leg_2_market_ref: totalMember?.market_reference_prob ?? null,
        },
      );
      const missingConfirmations = [
        ...new Set(comboMembers.flatMap(member => safeArray(member.missing_confirmations))),
      ];

      return {
        group_key: groupKey,
        game_pk: members[0]?.matched_game_pk ?? null,
        event_ticker: members[0]?.event_ticker ?? null,
        game: members[0]?.game ?? null,
        combo_status: comboClassification,
        classification: comboClassification,
        combo_edge_pp: comboEdgePp ?? bestMember?.edge_pp ?? null,
        leg_1_market_ticker: moneylineMember?.market_ticker ?? null,
        leg_1_market_lane: moneylineMember?.market_lane ?? null,
        leg_1_classification: moneylineMember?.classification ?? null,
        leg_1_side: moneylineMember?.contract_title ?? moneylineMember?.market_title ?? null,
        leg_1_strike: moneylineMember?.total_strike ?? null,
        leg_1_ask: moneylineMember?.kalshi_ask ?? null,
        leg_1_market_ref: moneylineMember?.market_reference_prob ?? null,
        leg_2_market_ticker: totalMember?.market_ticker ?? null,
        leg_2_market_lane: totalMember?.market_lane ?? null,
        leg_2_classification: totalMember?.classification ?? null,
        leg_2_side: totalMember?.contract_title ?? totalMember?.market_title ?? null,
        leg_2_strike: totalMember?.total_strike ?? null,
        leg_2_ask: totalMember?.kalshi_ask ?? null,
        leg_2_market_ref: totalMember?.market_reference_prob ?? null,
        estimated_combo_cost: estimatedComboCost,
        estimated_combo_market_ref: estimatedComboMarketRef,
        combo_top_market_ticker: bestMember?.market_ticker ?? null,
        combo_top_market_lane: bestMember?.market_lane ?? null,
        combo_member_count: comboMembers.length,
        lanes_present: [...new Set(comboMembers.map(member => member.market_lane).filter(Boolean))].sort(
          (left, right) => lanePriority(left) - lanePriority(right) || left.localeCompare(right),
        ),
        missing_confirmations: missingConfirmations,
        note: 'No trades placed',
        display_markets: comboMembers.map(sameGameComboMemberLabel).join('; '),
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      const edgeDelta = (right.combo_edge_pp ?? -Infinity) - (left.combo_edge_pp ?? -Infinity);
      if (edgeDelta !== 0) return edgeDelta;
      return String(left.game ?? left.group_key ?? '').localeCompare(String(right.game ?? right.group_key ?? ''));
    });
}

function buildMarketLaneDiagnostics({ candidates, sameGameCombos, comboCandidates }) {
  const totalCounts = new Map(MARKET_LANES.map(lane => [lane, 0]));
  const visibleCounts = new Map(MARKET_LANES.map(lane => [lane, 0]));
  const actionableCounts = new Map(MARKET_LANES.map(lane => [lane, 0]));
  const comboLaneCounts = new Map(MARKET_LANES.map(lane => [lane, 0]));

  for (const candidate of safeArray(candidates)) {
    const lane = candidate.market_lane ?? null;
    if (!totalCounts.has(lane)) continue;
    totalCounts.set(lane, totalCounts.get(lane) + 1);
    if (SAME_GAME_COMBO_VISIBLE_STATUSES.has(candidate.classification)) {
      visibleCounts.set(lane, visibleCounts.get(lane) + 1);
      actionableCounts.set(lane, actionableCounts.get(lane) + 1);
    }
  }

  const unknownOtherCandidateCount = safeArray(candidates).filter(
    candidate => !MARKET_LANES.includes(candidate.market_lane),
  ).length;

  for (const combo of safeArray(comboCandidates)) {
    for (const lane of safeArray(combo.lanes_present)) {
      if (!comboLaneCounts.has(lane)) continue;
      comboLaneCounts.set(lane, comboLaneCounts.get(lane) + 1);
    }
  }

  const actionableComboCandidates = safeArray(comboCandidates);

  return {
    total_candidates: safeArray(candidates).length,
    lane_counts: MARKET_LANES.map(lane => ({
      lane,
      total_candidates: totalCounts.get(lane) ?? 0,
      visible_candidates: visibleCounts.get(lane) ?? 0,
      actionable_candidates: actionableCounts.get(lane) ?? 0,
    })),
    candidate_counts_by_market_lane: MARKET_LANES.map(lane => ({
      market_lane: lane,
      candidate_count: totalCounts.get(lane) ?? 0,
    })),
    moneyline_candidate_count: totalCounts.get('moneyline') ?? 0,
    unknown_other_candidate_count: unknownOtherCandidateCount,
    actionable_counts_by_market_lane: MARKET_LANES.map(lane => ({
      market_lane: lane,
      actionable_candidate_count: actionableCounts.get(lane) ?? 0,
    })),
    combo_summary: {
      combo_candidates: actionableComboCandidates.length,
      combo_clear: actionableComboCandidates.filter(combo => combo.combo_status === 'COMBO_CLEAR').length,
      combo_leans: actionableComboCandidates.filter(combo => combo.combo_status === 'COMBO_LEAN').length,
      combo_watch: actionableComboCandidates.filter(combo => combo.combo_status === 'COMBO_WATCH').length,
      combo_passes: actionableComboCandidates.filter(combo => combo.combo_status === 'COMBO_PASS').length,
      moneyline_visible_combo_groups: comboLaneCounts.get('moneyline') ?? 0,
      combo_lane_counts: MARKET_LANES.map(lane => ({
        lane,
        combo_groups: comboLaneCounts.get(lane) ?? 0,
      })).filter(entry => entry.combo_groups > 0),
    },
  };
}

function sourceStatus(envelope, fallback = 'blocked') {
  const status = envelope?.status;
  return ['ok', 'degraded', 'blocked', 'skipped'].includes(status) ? status : fallback;
}

function pickSourceStatus(status) {
  return status === 'skipped' ? 'blocked' : status;
}

function formatGame(game) {
  return `${game.away_team ?? 'Unknown Away'} at ${game.home_team ?? 'Unknown Home'}`;
}

function marketTickers(record) {
  return safeArray(record.markets)
    .map(market => market.market_ticker)
    .filter(Boolean);
}

function listedLanes(record) {
  return [
    ...new Set(
      safeArray(record.markets)
        .map(market => market.market_lane)
        .filter(lane => MARKET_LANES.includes(lane)),
    ),
  ];
}

function recordsForGame(kalshiRecords, gamePk) {
  return kalshiRecords.filter(record => record.matched_game_pk === gamePk);
}

function buildGames({ runDate, mlbRecords, kalshiRecords, weather }) {
  return mlbRecords.map(game => {
    const records = recordsForGame(kalshiRecords, game.game_pk);
    return {
      game_pk: game.game_pk ?? null,
      game: formatGame(game),
      game_date: game.game_date ?? runDate,
      start_time_utc: game.start_time_utc ?? null,
      teams: {
        away: game.away_team ?? 'Unknown Away',
        home: game.home_team ?? 'Unknown Home',
      },
      mlb_status: game.mlb_status ?? 'unknown',
      probable_pitchers: {
        away: game.probable_pitchers?.away ?? null,
        home: game.probable_pitchers?.home ?? null,
      },
      kalshi_events: records.map(record => ({
        event_ticker: record.event_ticker ?? null,
        event_title: record.event_title ?? 'untitled',
        market_tickers: marketTickers(record),
      })),
      listed_market_lanes: [...new Set(records.flatMap(record => listedLanes(record)))],
      weather_status: sourceStatus(weather),
    };
  });
}

function buildRouterResults({ runDate, kalshiRecords }) {
  return kalshiRecords.flatMap(record =>
    safeArray(record.markets).map(market => ({
      route_status: market.route_status ?? 'BLOCKED',
      market_lane: market.market_lane ?? null,
      candidate_lanes: safeArray(market.candidate_lanes),
      kalshi_url: null,
      event_ticker: record.event_ticker ?? null,
      market_ticker: market.market_ticker ?? null,
      event_title: record.event_title ?? null,
      market_title: market.market_title ?? null,
      contract_title: market.contract_title ?? null,
      game_date: runDate,
      teams: {
        away: null,
        home: null,
      },
      player_name: null,
      threshold: null,
      side_hint: null,
      confidence: market.route_status === 'ROUTED' ? 70 : 0,
      matched_signals: market.market_lane ? [`adapter routed ${market.market_lane}`] : [],
      reject_signals: market.route_status === 'ROUTED' ? [] : ['not routed by discovery adapter'],
      needed_clarification: market.route_status === 'ROUTED' ? [] : ['Need full Kalshi rules/title context'],
      next_workflow: 'runbooks/mlb-prediction-process.md',
      notes: ['Discovery-only router result; no prediction created.'],
    })),
  );
}

function buildExcludedMarkets(kalshi) {
  return safeArray(kalshi.rejected_records).map(record => ({
    market_title: record.event_title ?? 'untitled rejected Kalshi record',
    market_ticker: null,
    route_status: 'OUT_OF_SCOPE',
    reason: record.reason ?? 'Rejected by same-day MLB discovery filter',
    needed_clarification: [],
  }));
}

function buildSlateManifest({ runDate, generatedAtUtc, kalshi, mlb, baseballSavant, weather, liquidity, sportsbook, context }) {
  const kalshiRecords = safeArray(kalshi.records);
  const mlbRecords = safeArray(mlb.records);
  const savantRecords = safeArray(baseballSavant.records);
  const weatherRecords = safeArray(weather.records);
  return {
    schema_version: SCHEMA_VERSION,
    run_date: runDate,
    generated_at_utc: generatedAtUtc,
    operator: OPERATOR,
    kalshi_calendar_url: KALSHI_BASEBALL_CALENDAR_URL,
    source_timestamps: {
      kalshi: kalshi.checked_at_utc ?? null,
      mlb_official: mlb.checked_at_utc ?? null,
      baseball_savant: baseballSavant.checked_at_utc ?? null,
      weather: weather.checked_at_utc ?? null,
      liquidity: liquidity.checked_at_utc ?? null,
      sportsbook_reference: sportsbook?.checked_at_utc ?? null,
      lineup_injury_bullpen: context?.checked_at_utc ?? null,
      optional_price_sanity: null,
    },
    games: buildGames({ runDate, mlbRecords, kalshiRecords, weather }),
    router_results: buildRouterResults({ runDate, kalshiRecords }),
    unmatched_or_excluded_markets: buildExcludedMarkets(kalshi),
    notes: [
      'Dry-run output composed from existing discovery files only.',
      `Kalshi same-day records kept: ${kalshiRecords.length}.`,
      `Kalshi rejected diagnostic records: ${safeArray(kalshi.rejected_records).length}.`,
      `Baseball Savant adapter status: ${sourceStatus(baseballSavant)}; records: ${savantRecords.length}.`,
      `Weather adapter status: ${sourceStatus(weather)}; records: ${weatherRecords.length}.`,
      `Liquidity adapter status: ${sourceStatus(liquidity)}; records: ${safeArray(liquidity.records).length}.`,
      'No live reads were produced. No trades placed.',
    ],
  };
}

function sourceEntry({
  sourceId,
  dataNeed,
  recommendedSource,
  backupSource,
  accessMethod,
  reliabilityGrade,
  dailyRepeatability,
  limitations,
  status,
  lastCheckedUtc,
  required,
  urls = [],
}) {
  return {
    source_id: sourceId,
    data_need: dataNeed,
    recommended_source: recommendedSource,
    backup_source: backupSource,
    access_method: accessMethod,
    reliability_grade: reliabilityGrade,
    daily_repeatability: dailyRepeatability,
    limitations,
    status,
    last_checked_utc: lastCheckedUtc,
    required,
    urls,
  };
}

function combinedLimitations(envelope, fallback) {
  const warnings = safeArray(envelope.warnings);
  const errors = safeArray(envelope.errors);
  return [...warnings, ...errors.map(error => `Error: ${error}`)].join('; ') || fallback;
}

function buildSourceRegistry({ runDate, generatedAtUtc, kalshi, mlb, baseballSavant, weather, liquidity, sportsbook, context }) {
  const kalshiStatus = sourceStatus(kalshi);
  const mlbStatus = sourceStatus(mlb);
  const savantStatus = sourceStatus(baseballSavant);
  const weatherStatus = sourceStatus(weather);
  const kalshiRecords = safeArray(kalshi.records);
  const savantRecords = safeArray(baseballSavant.records);
  const weatherRecords = safeArray(weather.records);
  const rejectedCount = safeArray(kalshi.rejected_records).length;
  const sourceGaps = [];

  const kalshiEffectivelyOk = kalshiStatus === 'ok' || (kalshiStatus === 'degraded' && kalshiRecords.length > 0);
  if (!kalshiEffectivelyOk) {
    sourceGaps.push({
      source_id: 'kalshi',
      gap: `Kalshi same-day game market discovery kept ${kalshiRecords.length} records; rejected diagnostic count ${rejectedCount}.`,
      affected_market_lanes: [...MARKET_LANES],
      handling: 'Do not create rated outputs. Re-run live-readonly discovery or refresh closer to first pitch.',
    });
  }

  if (savantStatus !== 'ok' || savantRecords.length === 0) {
    sourceGaps.push({
      source_id: 'baseball_savant',
      gap: `Baseball Savant adapter status ${savantStatus}; records ${savantRecords.length}.`,
      affected_market_lanes: [...MARKET_LANES],
      handling: 'Do not create rated outputs until usable Statcast evidence records are available.',
    });
  }

  if (weatherStatus !== 'ok' || weatherRecords.length === 0) {
    sourceGaps.push({
      source_id: 'weather',
      gap: `Weather adapter status ${weatherStatus}; records ${weatherRecords.length}.`,
      affected_market_lanes: ['game_total', 'yrfi_nrfi', 'home_run_hitter'],
      handling: 'Do not create weather-sensitive rated outputs until usable weather records are available.',
    });
  }

  if (sourceStatus(liquidity) === 'blocked') {
    sourceGaps.push({
      source_id: 'liquidity',
      gap: `Liquidity adapter status blocked; ${safeArray(liquidity.records).length} records.`,
      affected_market_lanes: ['moneyline', 'run_line', 'game_total', 'yrfi_nrfi', 'home_run_hitter', 'pitcher_strikeouts'],
      handling: 'Market classified NOT_TRADEABLE until liquidity data is available.',
    });
  }

  return {
    schema_version: SCHEMA_VERSION,
    run_date: runDate,
    generated_at_utc: generatedAtUtc,
    operator: OPERATOR,
    sources: [
      sourceEntry({
        sourceId: 'kalshi',
        dataNeed: 'Tradable markets, rules, available contracts, bid/ask, liquidity, and order books',
        recommendedSource: 'Kalshi baseball calendar and public read-only Trade API discovery',
        backupSource: 'Manual Kalshi UI review if public discovery is challenge-gated',
        accessMethod: 'Existing discovery adapter JSON from public/read-only GET attempts',
        reliabilityGrade: 'A',
        dailyRepeatability: 'Daily, subject to UI challenge gates and public endpoint availability',
        limitations: safeArray(kalshi.warnings).join('; ') || 'Kalshi proves tradability only, not baseball truth.',
        status: kalshiStatus,
        lastCheckedUtc: kalshi.checked_at_utc ?? null,
        required: true,
        urls: safeArray(kalshi.source_urls),
      }),
      sourceEntry({
        sourceId: 'mlb_official',
        dataNeed: 'Schedule, official game IDs, teams, status, probable pitchers, venue, and start times',
        recommendedSource: 'Official MLB Stats API / MLB Gameday',
        backupSource: 'MLB.com scoreboard',
        accessMethod: 'Existing MLB official adapter JSON',
        reliabilityGrade: 'A',
        dailyRepeatability: 'Daily public API access',
        limitations: safeArray(mlb.warnings).join('; ') || 'Official schedule source; not a betting or player-prop model.',
        status: mlbStatus,
        lastCheckedUtc: mlb.checked_at_utc ?? null,
        required: true,
        urls: safeArray(mlb.source_urls),
      }),
      sourceEntry({
        sourceId: 'baseball_savant',
        dataNeed: 'Batter/pitcher splits, K%, barrel rate, hard-hit rate, HR profiles, pitch mix, and workload',
        recommendedSource: 'Baseball Savant / Statcast',
        backupSource: 'FanGraphs or MLB Stats API derived stats when explicitly implemented later',
        accessMethod: 'Existing Baseball Savant adapter JSON from discovery folder',
        reliabilityGrade: 'A-',
        dailyRepeatability: 'Daily when adapter discovery file is present; fixture mode is placeholder only',
        limitations: combinedLimitations(
          baseballSavant,
          'Baseball Savant adapter file present; records are discovery/evidence inputs only and do not authorize rated outputs.',
        ),
        status: savantStatus,
        lastCheckedUtc: baseballSavant.checked_at_utc ?? null,
        required: true,
        urls: safeArray(baseballSavant.source_urls),
      }),
      sourceEntry({
        sourceId: 'weather',
        dataNeed: 'Wind, temperature, rain/postponement risk, roof, and weather-sensitive run environment',
        recommendedSource: 'National Weather Service API',
        backupSource: 'Venue roof/status notes and official game status once implemented',
        accessMethod: 'Existing weather adapter JSON from discovery folder',
        reliabilityGrade: 'A-',
        dailyRepeatability: 'Daily when adapter discovery file is present; fixture mode is placeholder only',
        limitations: combinedLimitations(
          weather,
          'Weather adapter file present; records are environment inputs only and do not authorize rated outputs.',
        ),
        status: weatherStatus,
        lastCheckedUtc: weather.checked_at_utc ?? null,
        required: true,
        urls: safeArray(weather.source_urls),
      }),
      sourceEntry({
        sourceId: 'liquidity',
        dataNeed: 'Kalshi market bid/ask, spread, volume, open interest',
        recommendedSource: 'Kalshi public trade API (read-only)',
        backupSource: 'Manual Kalshi UI review',
        accessMethod: 'Existing liquidity adapter JSON from discovery folder',
        reliabilityGrade: 'B+',
        dailyRepeatability: 'Daily when adapter file present; fixture mode is placeholder only',
        limitations: combinedLimitations(liquidity, 'Liquidity adapter present; order book inputs only.'),
        status: sourceStatus(liquidity),
        lastCheckedUtc: liquidity.checked_at_utc ?? null,
        required: false,
        urls: safeArray(liquidity.source_urls),
      }),
      sourceEntry({
        sourceId: 'sportsbook_reference',
        dataNeed: 'No-vig reference fair values from DraftKings/ESPN for edge comparison vs Kalshi ask',
        recommendedSource: 'ESPN scoreboard API (DraftKings odds)',
        backupSource: 'Manual DraftKings check',
        accessMethod: 'Existing sportsbook adapter JSON from discovery folder',
        reliabilityGrade: 'A-',
        dailyRepeatability: 'Daily when adapter discovery file is present',
        limitations: combinedLimitations(sportsbook, 'Reference only; not Kalshi prices; not executable.'),
        status: sourceStatus(sportsbook),
        lastCheckedUtc: sportsbook?.checked_at_utc ?? null,
        required: false,
        urls: safeArray(sportsbook?.source_urls),
      }),
      sourceEntry({
        sourceId: 'lineup_injury_bullpen',
        dataNeed: 'Lineup confirmation, injury list, probable pitcher stats, bullpen workload',
        recommendedSource: 'MLB live feed API + ESPN summary API',
        backupSource: 'Manual lineup check',
        accessMethod: 'Existing context adapter JSON from discovery folder',
        reliabilityGrade: 'B+',
        dailyRepeatability: 'Daily; lineup_pending is a normal pre-game state, not a hard block',
        limitations: combinedLimitations(context, 'Lineup/injury context only; not a trade signal.'),
        status: sourceStatus(context),
        lastCheckedUtc: context?.checked_at_utc ?? null,
        required: false,
        urls: safeArray(context?.source_urls),
      }),
      sourceEntry({
        sourceId: 'optional_price_sanity',
        dataNeed: 'Optional external price sanity check',
        recommendedSource: 'None required',
        backupSource: null,
        accessMethod: 'Not called by Stage 3 dry-run',
        reliabilityGrade: 'unknown',
        dailyRepeatability: 'Optional; never blocks workflow',
        limitations: 'Not required and not used to prove Kalshi availability.',
        status: 'skipped',
        lastCheckedUtc: null,
        required: false,
        urls: [],
      }),
    ],
    source_gaps: sourceGaps,
    notes: ['Source registry composed from existing discovery files only. No live fetches performed.'],
  };
}

function emptySummaryCounts() {
  return {
    total: 0,
    clear_pick: 0,
    watch_for_listing: 0,
    not_tradeable: 0,
    lean: 0,
    pass: 0,
    blocked: 0,
  };
}

function buildPicks({ runDate, generatedAtUtc, kalshi, mlb, baseballSavant, weather, liquidity, sportsbook, context, scoring }) {
  return {
    schema_version: SCHEMA_VERSION,
    run_date: runDate,
    generated_at_utc: generatedAtUtc,
    operator: OPERATOR,
    source_health: {
      kalshi: pickSourceStatus(sourceStatus(kalshi)),
      mlb_official: pickSourceStatus(sourceStatus(mlb)),
      baseball_savant: pickSourceStatus(sourceStatus(baseballSavant)),
      weather: pickSourceStatus(sourceStatus(weather)),
      liquidity: pickSourceStatus(sourceStatus(liquidity)),
      sportsbook_reference: pickSourceStatus(sourceStatus(sportsbook)),
      lineup_injury_bullpen: pickSourceStatus(sourceStatus(context)),
      optional_price_sanity: 'skipped',
    },
    summary_counts: scoring.counts,
    picks: scoring.candidates,
    notes: [
      'Discovery-only output writer dry-run.',
      scoring.fixture_mode
        ? 'Fixture mode: no top-rated read generated. Replace fixture adapters with live evidence before production use.'
        : 'Live-readonly mode: a top-rated read requires all evidence gates to pass.',
      `Scored ${scoring.counts.total} market candidates: ${scoring.counts.clear_pick} top-rated, ${scoring.counts.lean} higher-rated, ${scoring.counts.watch_for_listing} monitor only, ${scoring.counts.blocked} blocked, ${scoring.counts.not_tradeable} not tradeable.`,
      'No live reads were produced. No trades placed.',
    ],
  };
}

function tableEscape(value) {
  return String(value ?? '').replace(/\|/g, '/');
}

function guideSourceStatus({ kalshi, mlb, baseballSavant, weather, liquidity, sportsbook, context }) {
  return [
    '## Source Health',
    '',
    `- Kalshi: ${sourceStatus(kalshi)}`,
    `- MLB official: ${sourceStatus(mlb)}`,
    `- Baseball Savant: ${sourceStatus(baseballSavant)}`,
    `- Weather: ${sourceStatus(weather)}`,
    `- Liquidity: ${sourceStatus(liquidity)}`,
    `- Sportsbook reference: ${sourceStatus(sportsbook)}`,
    `- Lineup/injury/bullpen: ${sourceStatus(context)}`,
    '- Optional price sanity: skipped',
    `- Kalshi records kept: ${safeArray(kalshi.records).length}`,
    `- Kalshi rejected diagnostic records: ${safeArray(kalshi.rejected_records).length}`,
    `- Baseball Savant records: ${safeArray(baseballSavant.records).length}`,
    `- Weather records: ${safeArray(weather.records).length}`,
    `- Liquidity records: ${safeArray(liquidity.records).length}`,
    `- Sportsbook reference records: ${safeArray(sportsbook?.records).length}`,
    `- Context records: ${safeArray(context?.records).length}`,
    `- Kalshi warnings: ${safeArray(kalshi.warnings).join('; ') || 'none'}`,
    `- Baseball Savant warnings: ${safeArray(baseballSavant.warnings).join('; ') || 'none'}`,
    `- Baseball Savant errors: ${safeArray(baseballSavant.errors).join('; ') || 'none'}`,
    `- Weather warnings: ${safeArray(weather.warnings).join('; ') || 'none'}`,
    `- Weather errors: ${safeArray(weather.errors).join('; ') || 'none'}`,
    `- Liquidity warnings: ${safeArray(liquidity.warnings).join('; ') || 'none'}`,
    `- Liquidity errors: ${safeArray(liquidity.errors).join('; ') || 'none'}`,
    `- Sportsbook warnings: ${safeArray(sportsbook?.warnings).join('; ') || 'none'}`,
    `- Context warnings: ${safeArray(context?.warnings).join('; ') || 'none'}`,
    '',
  ];
}

function guideSlateOverview({ games, kalshi, baseballSavant, weather }) {
  const lines = [
    '## Slate Overview',
    '',
    '| Game | Start | Kalshi markets listed | MLB status | Weather note | Source status |',
    '|---|---|---|---|---|---|',
  ];

  for (const game of games) {
    const listed = game.listed_market_lanes.length > 0 ? game.listed_market_lanes.join(', ') : 'none';
    const weatherNote = sourceStatus(weather) === 'ok' ? 'adapter checked' : 'not checked';
    lines.push(
      `| ${tableEscape(game.game)} | ${game.start_time_utc ?? ''} | ${listed} | ${tableEscape(game.mlb_status)} | ${weatherNote} | MLB ok; Kalshi ${sourceStatus(kalshi)}; Savant ${sourceStatus(baseballSavant)}; weather ${sourceStatus(weather)} |`,
    );
  }

  if (games.length === 0) {
    lines.push('| none |  | none | no MLB games found | not checked | blocked |');
  }

  lines.push('');
  return lines;
}

function whyMostlyTotalsSection({ scoring }) {
  const candidates = safeArray(scoring.candidates);
  const moneylineCount = candidates.filter(c => c.market_lane === 'moneyline').length;
  const gameTotalCount = candidates.filter(c => c.market_lane === 'game_total').length;
  const otherCount = candidates.filter(c => !MARKET_LANES.includes(c.market_lane)).length;

  return [
    '## Why mostly totals?',
    '',
    `- Game totals account for ${gameTotalCount} of ${scoring.counts.total} scored candidates.`,
    `- Moneyline is only ${moneylineCount} candidates, and most of those are no rated view or monitor only.`,
    `- Weather, lineup, and bullpen uncertainty push the board toward totals while the slate is still settling.`,
    otherCount > 0 ? `- Other lanes are limited to ${otherCount} candidate(s).` : '- Other lanes are effectively absent on this slate.',
    '',
  ];
}

function missingBeforeFullGuide(baseballSavant, weather, liquidity, sportsbook) {
  const missing = ['morning scan composer'];
  if (sourceStatus(liquidity) !== 'ok' || safeArray(liquidity.records).length === 0) {
    missing.unshift('liquidity/order book');
  }
  if (sourceStatus(baseballSavant) !== 'ok' || safeArray(baseballSavant.records).length === 0) {
    missing.unshift('usable Savant/Statcast evidence');
  }
  if (sourceStatus(weather) !== 'ok' || safeArray(weather.records).length === 0) {
    missing.unshift('usable weather evidence');
  }
  if (sourceStatus(sportsbook) !== 'ok' || safeArray(sportsbook?.records).length === 0) {
    missing.unshift('sportsbook reference prices');
  }
  return missing.join(', ');
}

function buildDailyGuide({
  runDate,
  generatedAtUtc,
  kalshi,
  mlb,
  baseballSavant,
  weather,
  liquidity,
  sportsbook,
  context,
  scoring,
  slateManifest,
  sameGameCombos,
}) {
  const blockedCandidates = safeArray(scoring.candidates).filter(c => c.classification === 'BLOCKED_SOURCE_GAP');
  const leanCandidates = safeArray(scoring.candidates).filter(c => c.classification === 'LEAN');
  const watchForPriceCandidates = safeArray(scoring.candidates).filter(c => c.classification === 'WATCH_FOR_PRICE');
  const clearPickCandidates = safeArray(scoring.candidates).filter(c => c.classification === 'CLEAR_PICK');
  const preLineupPickCandidates = safeArray(scoring.candidates).filter(c => c.classification === 'PRE_LINEUP_PICK');
  const correlatedAlternateCandidates = safeArray(scoring.candidates).filter(c => c.classification === 'CORRELATED_ALTERNATE');
  const actionableCountsByMarketLane = MARKET_LANES.map(lane => ({
    market_lane: lane,
    actionable_candidate_count: safeArray(scoring.candidates).filter(
      c => c.market_lane === lane && SAME_GAME_COMBO_VISIBLE_STATUSES.has(c.classification),
    ).length,
  }));

  // Build start-time lookup keyed on game label for use in the top-rated table
  const startTimeByGame = new Map(
    safeArray(slateManifest.games).map(g => [g.game, g.start_time_utc ?? 'TBD']),
  );

  const buildPickRow = (c, note) => {
    const maxEntry = c.edge_pp !== null ? `$${Math.min(200, Math.round(c.edge_pp * 20))}` : 'n/a';
    const missing = safeArray(c.missing_confirmations).join(', ') || 'none';
    return `| ${tableEscape(c.market_ticker ?? 'unknown')} | ${tableEscape(c.game ?? '')} | ${tableEscape(c.contract_title ?? c.market_title ?? '')} | ${c.total_strike ?? 'n/a'} | ${c.kalshi_ask ?? 'n/a'} | ${c.market_reference_prob ?? 'n/a'} | ${c.edge_pp !== null ? `${c.edge_pp}pp` : 'n/a'} | ${maxEntry} | ${startTimeByGame.get(c.game) ?? 'TBD'} | ${tableEscape(missing)} | ${note} |`;
  };

  const clearPickRows = clearPickCandidates.length > 0
    ? clearPickCandidates.map(c => buildPickRow(c, 'Discovery only — no trade placed.'))
    : ['| none |  |  |  |  |  |  |  |  |  |  |'];

  const preLineupPickRows = preLineupPickCandidates.length > 0
    ? [
        '_All hard source gates passed. Edge >= 3pp. Awaiting lineup confirmation — enter only after starting lineups are posted._',
        '',
        '| Market | Game | Contract | Strike | Ask | Mkt Ref | Edge | Max Entry | Start | Missing | Note |',
        '|---|---|---|---:|---:|---:|---:|---:|---|---|---|',
        ...preLineupPickCandidates.map(c => buildPickRow(c, 'Pre-lineup only — do not enter until lineup confirmed.')),
      ]
    : ['| none |  |  |  |  |  |  |  |  |  |  |'];

  const correlatedAlternateRows = correlatedAlternateCandidates.length > 0
    ? correlatedAlternateCandidates.map(c =>
        `| ${tableEscape(c.market_ticker ?? c.market_title ?? 'unknown')} | ${tableEscape(c.correlation_group ?? '')} | ${c.total_strike ?? 'n/a'} | ${c.kalshi_ask ?? 'n/a'} | ${c.edge_pp !== null ? `${c.edge_pp}pp` : 'n/a'} |`,
      )
    : ['| none |  |  |  |  |'];

  // Deduplicate higher-rated rows to one per correlation group for the guide (full list stays in JSON)
  const leanSeenGroups = new Set();
  const leanDeduped = leanCandidates.filter(c => {
    const g = c.correlation_group ?? c.market_ticker;
    if (leanSeenGroups.has(g)) return false;
    leanSeenGroups.add(g);
    return true;
  });

  const blockedRows = blockedCandidates.length > 0
    ? blockedCandidates.map(c => `| ${tableEscape(c.market_ticker ?? c.market_title ?? 'unknown')} | ${tableEscape(safeArray(c.missing_sources).join(', ') || 'source gap')} | Re-run discovery or wait for source availability |`)
    : [
        '| Full daily prediction guide | Morning scan composer, and usable source evidence when unavailable | Implement remaining composer stages before final reads |',
        '| Kalshi tradable MLB board | Valid same-day Kalshi records | Re-run discovery closer to first pitch or inspect Kalshi UI manually |',
      ];

  const leanRows = leanDeduped.length > 0
    ? [
        ...leanDeduped.slice(0, 10).map(c =>
          `| ${tableEscape(c.market_ticker ?? c.market_title ?? 'unknown')} | ${tableEscape(c.game ?? '')} | ${c.total_strike ?? 'n/a'} | ${c.kalshi_ask ?? 'n/a'} | ${c.market_reference_prob ?? 'n/a'} | ${c.edge_pp !== null ? `${c.edge_pp}pp` : 'n/a'} | ${tableEscape(safeArray(c.missing_confirmations).join(', '))} |`,
        ),
        ...(leanDeduped.length > 10 || leanCandidates.length > leanDeduped.length
          ? [`| _+${leanCandidates.length - Math.min(leanDeduped.length, 10)} more_ | see today-execution-board.json for full list |  |  |  |  |  |`]
          : []),
      ]
    : ['| none |  |  |  |  |  |  |'];

  const watchForPriceRows = watchForPriceCandidates.length > 0
    ? watchForPriceCandidates.map(c => {
        const side = c.market_lane === 'game_total'
          ? `over ${c.total_strike ?? 'n/a'}`
          : (c.contract_title ?? c.market_title ?? 'n/a');
        const reason = safeArray(c.missing_confirmations).join(', ') || 'positive edge below rated threshold';
        const recheck = c.target_entry !== null
          ? `Enter at ${c.target_entry} or below`
          : 'Monitor for price drop';
        return `| ${tableEscape(c.market_ticker ?? 'unknown')} | ${tableEscape(c.game ?? '')} | ${c.market_lane ?? 'n/a'} | ${tableEscape(side)} | ${c.kalshi_ask ?? 'n/a'} | ${c.target_entry ?? 'n/a'} | ${c.edge_pp !== null ? `${c.edge_pp}pp` : 'n/a'} | ${tableEscape(reason)} | ${tableEscape(recheck)} |`;
      })
    : ['| none |  |  |  |  |  |  |  |  |'];

  const sameGameComboRows = sameGameCombos.length > 0
    ? sameGameCombos.map(combo =>
        `| ${tableEscape(combo.game ?? combo.group_key ?? 'unknown')} | ${tableEscape(combo.surfaced_lanes.join(', '))} | ${tableEscape(combo.display_markets)} | ${tableEscape(combo.same_game_exposure_note)} |`,
      )
    : ['| none |  |  |  |'];

  const lines = [
    `# Daily Baseball Guide - ${runDate}`,
    '',
    `- Generated UTC: ${generatedAtUtc}`,
    '- Discovery only.',
    '- No final reads.',
    '- No trades placed.',
    `- Kalshi same-day market discovery found ${safeArray(kalshi.records).length} valid records.`,
    `- Missing before full guide: ${missingBeforeFullGuide(baseballSavant, weather, liquidity, sportsbook)}.`,
    '',
    ...guideSourceStatus({ kalshi, mlb, baseballSavant, weather, liquidity, sportsbook, context }),
    ...guideSlateOverview({ games: slateManifest.games, kalshi, baseballSavant, weather }),
    '## Scoring Summary',
    '',
    `- Total candidates scored: ${scoring.counts.total}`,
    `- top-rated: ${scoring.counts.clear_pick}`,
    `- pre-lineup top-rated: ${scoring.counts.pre_lineup_pick ?? 0}`,
    `- higher-rated: ${scoring.counts.lean}`,
    `- monitor only: ${scoring.counts.watch_for_listing}`,
    `- no rated view: ${scoring.counts.pass}`,
    `- blocked: ${scoring.counts.blocked}`,
    `- not tradeable: ${scoring.counts.not_tradeable}`,
    `- reference-only: ${scoring.counts.correlated_alternate ?? 0}`,
    `- Moneyline candidates: ${safeArray(scoring.candidates).filter(c => c.market_lane === 'moneyline').length}`,
    `- Game total candidates: ${safeArray(scoring.candidates).filter(c => c.market_lane === 'game_total').length}`,
    `- Unknown/other candidates: ${safeArray(scoring.candidates).filter(c => !MARKET_LANES.includes(c.market_lane)).length}`,
    `- Fixture mode: ${scoring.fixture_mode}`,
    '',
    ...whyMostlyTotalsSection({ scoring }),
    '## Top-Rated Reads',
    '',
    '| Market | Game | Contract | Strike | Ask | Mkt Ref | Edge | Max Entry | Start | Missing | Note |',
    '|---|---|---|---:|---:|---:|---:|---:|---|---|---|',
    ...clearPickRows,
    '',
    '## Pre-Lineup Top-Rated Reads (Lineup Pending — Do Not Enter Yet)',
    '',
    ...preLineupPickRows,
    '',
    '## Monitor Only',
    '',
    '| Player/market | Game | Research edge | Missing Kalshi prop | Recheck time | Trigger |',
    '|---|---|---|---|---|---|',
    '',
    '## Not Tradeable',
    '',
    '| Market | Reason | Spread | Depth | Last update | Recheck |',
    '|---|---|---:|---:|---|---|',
    '',
    '## Higher-Rated Reads (Top 10 by Edge)',
    '',
    '| Market | Game | Strike | Ask | Mkt Ref | Edge | Missing |',
    '|---|---|---:|---:|---:|---:|---|',
    ...leanRows,
    '',
    '## Price Watch',
    '',
    '| Market | Game | Lane | Side/Strike | Ask | Target | Edge | Reason | Recheck |',
    '|---|---|---|---|---:|---:|---:|---|---|',
    ...watchForPriceRows,
    '',
    '## Same-Game Combo Visibility',
    '',
    '_Informational only. Same-game markets are shown together so shared exposure is visible before sizing._',
    '',
    '| Game | Lane mix | Surfaced markets | Exposure note |',
    '|---|---|---|---|',
    ...sameGameComboRows,
    '',
    '## Actionable Counts by Market Lane',
    '',
    '| Market lane | Actionable candidate count |',
    '|---|---:|',
    ...actionableCountsByMarketLane.map(row => `| ${row.market_lane} | ${row.actionable_candidate_count} |`),
    '',
    '## Correlated Alternates',
    '',
    '| Market | Group | Strike | Ask | Edge |',
    '|---|---|---:|---:|---:|',
    ...correlatedAlternateRows,
    '',
    '## Passes',
    '',
    '| Market | Primary reason |',
    '|---|---|',
    '',
    '## Blocked',
    '',
    '| Market | Missing source | Next action |',
    '|---|---|---|',
    ...blockedRows,
    '',
    '## Run Notes',
    '',
    '- No live sources were fetched by the output writer.',
    '- No valid same-day Kalshi markets were available in discovery input.',
    '- Candidate file reflects scored outputs from scoring-core.',
    '- No live reads were produced.',
    '- No trades placed.',
  ];

  return lines.join('\n');
}

function buildRunLog({ runDate, generatedAtUtc, kalshi, mlb, baseballSavant, weather, liquidity, sportsbook, context, outDir, outputPaths }) {
  const kalshiRecords = safeArray(kalshi.records);
  const rejectedCount = safeArray(kalshi.rejected_records).length;
  const writes = Object.values(outputPaths).map(filePath => `| ${filePath} | ${generatedAtUtc} | ok |`);

  return [
    `# MLB Run Log - ${runDate}`,
    '',
    '## Run Metadata',
    `- Operator: ${OPERATOR}`,
    `- Started UTC: ${generatedAtUtc}`,
    `- Run date: ${runDate}`,
    `- Run folder: ${outDir}/`,
    `- Schema version: ${SCHEMA_VERSION}`,
    '- Mode: output-writer-dry-run',
    '',
    '## Source Checks',
    '| Source | Status | Checked UTC | Access method | Limitation |',
    '|---|---|---|---|---|',
    `| Kalshi | ${sourceStatus(kalshi)} | ${kalshi.checked_at_utc ?? ''} | Existing discovery JSON | ${tableEscape(safeArray(kalshi.warnings).join('; ') || 'Tradability only')} |`,
    `| MLB official | ${sourceStatus(mlb)} | ${mlb.checked_at_utc ?? ''} | Existing discovery JSON | ${tableEscape(safeArray(mlb.warnings).join('; ') || 'Schedule/status only')} |`,
    `| Baseball Savant | ${sourceStatus(baseballSavant)} | ${baseballSavant.checked_at_utc ?? ''} | Existing discovery JSON | ${tableEscape(combinedLimitations(baseballSavant, 'Discovery/evidence inputs only'))} |`,
    `| Weather | ${sourceStatus(weather)} | ${weather.checked_at_utc ?? ''} | Existing discovery JSON | ${tableEscape(combinedLimitations(weather, 'Environment inputs only'))} |`,
    `| Liquidity | ${sourceStatus(liquidity)} | ${liquidity.checked_at_utc ?? ''} | Existing discovery JSON | ${tableEscape(combinedLimitations(liquidity, 'Order book inputs only'))} |`,
    `| Sportsbook reference | ${sourceStatus(sportsbook)} | ${sportsbook?.checked_at_utc ?? ''} | Existing discovery JSON | ${tableEscape(combinedLimitations(sportsbook, 'Reference only; not executable'))} |`,
    `| Lineup/injury/bullpen | ${sourceStatus(context)} | ${context?.checked_at_utc ?? ''} | Existing discovery JSON | ${tableEscape(combinedLimitations(context, 'Context only; not a trade signal'))} |`,
    '| Optional price sanity | skipped |  | Not called | Optional only |',
    '',
    '## Kalshi Intake',
    '| Event | Market | Ticker | Status | Notes |',
    '|---|---|---|---|---|',
    kalshiRecords.length > 0
      ? kalshiRecords.map(record => `| ${tableEscape(record.event_title)} | captured | ${record.event_ticker ?? ''} | listed | Discovery only |`).join('\n')
      : `| none | none |  | degraded | No valid same-day Kalshi records found; rejected diagnostic count ${rejectedCount} |`,
    '',
    '## Router Results',
    '| Market | Route status | Lane | Candidates | Needed clarification |',
    '|---|---|---|---|---|',
    '| none |  |  |  | No Kalshi same-day markets to route |',
    '',
    '## Prediction Status Changes',
    '| Time UTC | ID | Old status | New status | Reason |',
    '|---|---|---|---|---|',
    '| none |  |  |  | No rated candidates were created |',
    '',
    '## Failure Handling',
    '| Case | Item | Handling | Next action |',
    '|---|---|---|---|',
    '| kalshi_discovery_degraded | Same-day Kalshi MLB board | No final reads | Re-run live-readonly discovery or inspect Kalshi UI closer to first pitch |',
    `| statcast_adapter_status | Baseball Savant/Statcast | Status ${sourceStatus(baseballSavant)} with ${safeArray(baseballSavant.records).length} records; no final reads | Refresh adapter or keep blocked until usable evidence exists |`,
    `| weather_adapter_status | Weather | Status ${sourceStatus(weather)} with ${safeArray(weather.records).length} records; no final reads | Refresh adapter or keep blocked until usable evidence exists |`,
    '| missing_liquidity | Order book/liquidity | Block tradeability gate | Implement liquidity enrichment |',
    '',
    '## Output Writes',
    '| File | Wrote UTC | Status |',
    '|---|---|---|',
    ...writes,
    '',
    '## No-Trade Confirmation',
    '- No live reads were produced.',
    '- No trades placed.',
    '- Output writer read local discovery files only.',
  ].join('\n');
}

function buildExecutionBoard({
  runDate,
  generatedAtUtc,
  scoring,
  slateManifest,
  sportsbook,
  context,
  weather,
  mlb,
  sameGameCombos,
}) {
  const now = new Date(generatedAtUtc);
  const chicagoTime = now.toLocaleString('en-US', { timeZone: 'America/Chicago' });
  const byClass = (cls) => safeArray(scoring.candidates).filter(c => c.classification === cls);
  const comboCandidates = buildComboCandidates(scoring.candidates);
  const marketLaneDiagnostics = buildMarketLaneDiagnostics({
    candidates: scoring.candidates,
    sameGameCombos,
    comboCandidates,
  });
  const moneylineEdgeBoard = buildMoneylineEdgeBoard(scoring.candidates);
  return {
    schema_version: '1.0',
    run_date: runDate,
    generated_at_utc: generatedAtUtc,
    generated_america_chicago: chicagoTime,
    no_trades_placed: true,
    automated_trade_execution_called: false,
    source_health: {
      mlb_official: sourceStatus(mlb),
      kalshi_api: 'ok',
      sportsbook_reference: sourceStatus(sportsbook),
      lineup_injury_bullpen: sourceStatus(context),
      weather: sourceStatus(weather),
      trade_execution: 'not_called',
    },
    summary_counts: scoring.counts,
    games: slateManifest.games ?? [],
    candidates: scoring.candidates,
    clear_picks: byClass('CLEAR_PICK'),
    pre_lineup_picks: byClass('PRE_LINEUP_PICK'),
    leans: byClass('LEAN'),
    watch_for_price: byClass('WATCH_FOR_PRICE'),
    watch_for_listing: byClass('WATCH_FOR_LISTING'),
    passes: byClass('PASS'),
    blocked: byClass('BLOCKED_SOURCE_GAP'),
    correlated_alternates: byClass('CORRELATED_ALTERNATE'),
    combo_candidates: comboCandidates,
    combo_clear: comboCandidates.filter(combo => combo.combo_status === 'COMBO_CLEAR'),
    combo_leans: comboCandidates.filter(combo => combo.combo_status === 'COMBO_LEAN'),
    combo_watch: comboCandidates.filter(combo => combo.combo_status === 'COMBO_WATCH'),
    combo_passes: comboCandidates.filter(combo => combo.combo_status === 'COMBO_PASS'),
    same_game_combos: sameGameCombos,
    candidate_counts_by_market_lane: marketLaneDiagnostics.candidate_counts_by_market_lane,
    moneyline_candidate_count: marketLaneDiagnostics.moneyline_candidate_count,
    game_total_candidate_count:
      marketLaneDiagnostics.candidate_counts_by_market_lane.find(row => row.market_lane === 'game_total')?.candidate_count ?? 0,
    unknown_other_candidate_count: marketLaneDiagnostics.unknown_other_candidate_count,
    moneyline_edge_board_count: moneylineEdgeBoard.length,
    moneyline_edge_board: moneylineEdgeBoard,
    actionable_counts_by_market_lane: marketLaneDiagnostics.actionable_counts_by_market_lane,
    market_lane_diagnostics: marketLaneDiagnostics,
    safety: [
      'No trades placed.',
      'No top-rated read emitted without all evidence gates passing.',
      'Sportsbook prices are reference-only no-vig fair values, not Kalshi prices.',
      'All rated outputs require manual review before any action.',
    ],
  };
}

function buildExecutionBoardMd({
  runDate,
  generatedAtUtc,
  scoring,
  slateManifest,
  sportsbook,
  context,
  weather,
  mlb,
  sameGameCombos,
}) {
  const board = buildExecutionBoard({
    runDate,
    generatedAtUtc,
    scoring,
    slateManifest,
    sportsbook,
    context,
    weather,
    mlb,
    sameGameCombos,
  });
  const counts = board.summary_counts;
  const laneDiagnostics = board.market_lane_diagnostics;
  const moneylineEdgeBoard = board.moneyline_edge_board ?? [];
  const moneylineEdgeRows = moneylineEdgeBoard.length > 0
    ? moneylineEdgeBoard.slice(0, 10).map(c =>
        `| ${tableEscape(c.market_ticker ?? '')} | ${tableEscape(c.game ?? '')} | ${tableEscape(c.side ?? '')} | ${tableEscape(displayClassification(c.classification))} | ${c.kalshi_ask ?? 'n/a'} | ${c.market_reference_prob ?? 'n/a'} | ${c.edge_pp !== null ? `${c.edge_pp}pp` : 'n/a'} | ${c.target_entry ?? 'n/a'} | ${tableEscape(c.why_not)} |`,
      )
    : ['| none |  |  |  |  |  |  |  |  |'];
  const lines = [
    `# Execution Board - ${runDate}`,
    '',
    `- Generated UTC: ${generatedAtUtc}`,
    `- Generated Chicago: ${board.generated_america_chicago}`,
    '- No trades placed.',
    '- Automated trade execution: not called.',
    '',
    '## Source Health',
    '',
    `- MLB official: ${board.source_health.mlb_official}`,
    `- Kalshi API: ${board.source_health.kalshi_api}`,
    `- Sportsbook reference: ${board.source_health.sportsbook_reference}`,
    `- Lineup/injury/bullpen: ${board.source_health.lineup_injury_bullpen}`,
    `- Weather: ${board.source_health.weather}`,
    `- Trade execution: ${board.source_health.trade_execution}`,
    '',
    '## Summary Counts',
    '',
    `- Total: ${counts.total ?? 0}`,
    `- top-rated: ${counts.clear_pick ?? 0}`,
    `- pre-lineup top-rated: ${counts.pre_lineup_pick ?? 0}`,
    `- higher-rated: ${counts.lean ?? 0}`,
    `- monitor only: ${counts.watch_for_listing ?? 0}`,
    `- no rated view: ${counts.pass ?? 0}`,
    `- blocked: ${counts.blocked ?? 0}`,
    `- not tradeable: ${counts.not_tradeable ?? 0}`,
    `- reference-only: ${counts.correlated_alternate ?? 0}`,
    '',
    '## Top-Rated Reads',
    '',
    board.clear_picks.length === 0
      ? '- none'
      : [
          '| Market | Game | Contract | Strike | Ask | Mkt Ref | Edge | Max Entry | Start | Missing | Note |',
          '|---|---|---|---:|---:|---:|---:|---:|---|---|---|',
          ...board.clear_picks.map(c => {
            const maxEntry = c.edge_pp !== null ? `$${Math.min(200, Math.round(c.edge_pp * 20))}` : 'n/a';
            const missing = safeArray(c.missing_confirmations).join(', ') || 'none';
            const startTime = safeArray(board.games).find(g => g.game === c.game)?.start_time_utc ?? 'TBD';
            return `| ${tableEscape(c.market_ticker ?? 'unknown')} | ${tableEscape(c.game ?? '')} | ${tableEscape(c.contract_title ?? c.market_title ?? '')} | ${c.total_strike ?? 'n/a'} | ${c.kalshi_ask ?? 'n/a'} | ${c.market_reference_prob ?? 'n/a'} | ${c.edge_pp !== null ? `${c.edge_pp}pp` : 'n/a'} | ${maxEntry} | ${startTime} | ${tableEscape(missing)} | Discovery only — no trade placed. |`;
          }),
        ].join('\n'),
    '',
    '## Pre-Lineup Top-Rated Reads (Lineup Pending — Do Not Enter Yet)',
    '',
    board.pre_lineup_picks.length === 0
      ? '- none'
      : [
          '_All hard source gates passed. Edge >= 3pp. Awaiting lineup confirmation — enter only after starting lineups are posted._',
          '',
          '| Market | Game | Contract | Strike | Ask | Mkt Ref | Edge | Max Entry | Start | Missing | Note |',
          '|---|---|---|---:|---:|---:|---:|---:|---|---|---|',
          ...board.pre_lineup_picks.map(c => {
            const maxEntry = c.edge_pp !== null ? `$${Math.min(200, Math.round(c.edge_pp * 20))}` : 'n/a';
            const missing = safeArray(c.missing_confirmations).join(', ') || 'none';
            const startTime = safeArray(board.games).find(g => g.game === c.game)?.start_time_utc ?? 'TBD';
            return `| ${tableEscape(c.market_ticker ?? 'unknown')} | ${tableEscape(c.game ?? '')} | ${tableEscape(c.contract_title ?? c.market_title ?? '')} | ${c.total_strike ?? 'n/a'} | ${c.kalshi_ask ?? 'n/a'} | ${c.market_reference_prob ?? 'n/a'} | ${c.edge_pp !== null ? `${c.edge_pp}pp` : 'n/a'} | ${maxEntry} | ${startTime} | ${tableEscape(missing)} | Pre-lineup only — do not enter until lineup confirmed. |`;
          }),
        ].join('\n'),
    '',
    '## Higher-Rated Reads (Top 10 by Edge, one per group)',
    '',
    board.leans.length === 0
      ? '- none'
      : (() => {
          const seen = new Set();
          const deduped = board.leans.filter(c => {
            const g = c.correlation_group ?? c.market_ticker;
            if (seen.has(g)) return false;
            seen.add(g);
            return true;
          });
          const top10 = deduped.slice(0, 10);
          const overflowCount = board.leans.length - top10.length;
          return [
            '| Market | Game | Strike | Ask | Mkt Ref | Edge | Missing |',
            '|---|---|---:|---:|---:|---:|---|',
            ...top10.map(c =>
              `| ${tableEscape(c.market_ticker ?? c.market_title ?? 'unknown')} | ${tableEscape(c.game ?? '')} | ${c.total_strike ?? 'n/a'} | ${c.kalshi_ask ?? 'n/a'} | ${c.market_reference_prob ?? 'n/a'} | ${c.edge_pp !== null ? `${c.edge_pp}pp` : 'n/a'} | ${tableEscape(safeArray(c.missing_confirmations).join(', '))} |`,
            ),
            ...(overflowCount > 0
              ? [`\n_${overflowCount} more higher-rated rows — see today-execution-board.json for full list._`]
              : []),
          ].join('\n');
        })(),
    '',
    '## Price Watch',
    '',
    board.watch_for_price.length === 0
      ? '- none'
      : [
          '| Market | Game | Lane | Side/Strike | Ask | Target | Edge | Reason | Recheck |',
          '|---|---|---|---|---:|---:|---:|---|---|',
          ...board.watch_for_price.map(c => {
            const side = c.market_lane === 'game_total'
              ? `over ${c.total_strike ?? 'n/a'}`
              : (c.contract_title ?? c.market_title ?? 'n/a');
            const reason = safeArray(c.missing_confirmations).join(', ') || 'positive edge below rated threshold';
            const recheck = c.target_entry !== null
              ? `Enter at ${c.target_entry} or below`
              : 'Monitor for price drop';
            return `| ${tableEscape(c.market_ticker ?? 'unknown')} | ${tableEscape(c.game ?? '')} | ${c.market_lane ?? 'n/a'} | ${tableEscape(side)} | ${c.kalshi_ask ?? 'n/a'} | ${c.target_entry ?? 'n/a'} | ${c.edge_pp !== null ? `${c.edge_pp}pp` : 'n/a'} | ${tableEscape(reason)} | ${tableEscape(recheck)} |`;
          }),
        ].join('\n'),
    '',
    ...whyMostlyTotalsSection({ scoring }),
    '## Moneyline Edge Board',
    '',
    '_Discovery view across all classifications. Monitor-only and no-rated-view rows are included for edge visibility, not action._',
    '',
    '| market_ticker | game | Side | Status | Ask | Mkt Ref | Edge | Target | Why not |',
    '|---|---|---|---|---:|---:|---:|---:|---|',
    ...moneylineEdgeRows,
    ...(moneylineEdgeBoard.length > 10
      ? [`\n_${moneylineEdgeBoard.length - 10} more rows — see today-execution-board.json for the full list._`]
      : []),
    '',
    '## Same-Game Combo Visibility',
    '',
    board.same_game_combos.length === 0
      ? '- none'
      : [
           '_Informational only. Same-game markets are shown together so shared exposure is visible before sizing._',
           '',
           '| Game | Lane mix | Surfaced markets | Exposure note |',
           '|---|---|---|---|',
          ...board.same_game_combos.map(combo =>
            `| ${tableEscape(combo.game ?? combo.group_key ?? 'unknown')} | ${tableEscape(combo.surfaced_lanes.join(', '))} | ${tableEscape(combo.display_markets)} | ${tableEscape(combo.same_game_exposure_note)} |`,
          ),
        ].join('\n'),
    '',
    '## Market-Lane Diagnostics',
    '',
    `- Total candidates: ${laneDiagnostics.total_candidates}`,
    `- Actionable same-game combo groups: ${board.combo_candidates.length}`,
    `- Same-game visibility groups: ${board.same_game_combos.length}`,
    `- Clear combo groups: ${board.combo_clear.length}`,
    `- Pre-lineup / higher-rated combo groups: ${board.combo_leans.length}`,
    `- Watch combo groups: ${board.combo_watch.length}`,
    `- Pass combo groups: ${(board.combo_passes ?? []).length}`,
    `- Moneyline candidates: ${board.moneyline_candidate_count}`,
    `- Game total candidates: ${board.game_total_candidate_count}`,
    `- Unknown/other candidates: ${board.unknown_other_candidate_count}`,
    `- Moneyline-visible combo groups: ${laneDiagnostics.combo_summary.moneyline_visible_combo_groups}`,
    '',
    '### Candidate Counts by Market Lane',
    '',
    '| Market lane | Candidate count |',
    '|---|---:|',
    ...board.candidate_counts_by_market_lane.map(row => `| ${row.market_lane} | ${row.candidate_count} |`),
    '',
    '### Actionable Counts by Market Lane',
    '',
    '| Market lane | Actionable candidate count |',
    '|---|---:|',
    ...board.actionable_counts_by_market_lane.map(row => `| ${row.market_lane} | ${row.actionable_candidate_count} |`),
    '',
    '| Lane | Total candidates | Visible candidates | Combo groups |',
    '|---|---:|---:|---:|',
    ...laneDiagnostics.lane_counts.map(row =>
      `| ${row.lane} | ${row.total_candidates} | ${row.visible_candidates} | ${laneDiagnostics.combo_summary.combo_lane_counts.find(comboRow => comboRow.lane === row.lane)?.combo_groups ?? 0} |`,
    ),
    '',
    '## Correlated Alternates',
    board.correlated_alternates.length === 0
      ? '- none'
      : board.correlated_alternates.map(c =>
          `- ${c.market_ticker ?? c.market_title ?? 'unknown'} (strike ${c.total_strike ?? 'n/a'}, ask ${c.kalshi_ask ?? 'n/a'}, edge ${c.edge_pp !== null ? `${c.edge_pp}pp` : 'n/a'})`,
        ).join('\n'),
    '',
    '## Safety',
    ...board.safety.map(s => `- ${s}`),
  ];
  return lines.join('\n');
}

function validateDiscoveryInputs({ kalshiPath, mlbPath }) {
  if (!existsSync(kalshiPath)) {
    throw new Error(`Missing Kalshi discovery file: ${kalshiPath}`);
  }
  if (!existsSync(mlbPath)) {
    throw new Error(`Missing MLB official discovery file: ${mlbPath}`);
  }
}

export function composeMlbDailyOutputs({
  runDate,
  discoveryDir = `state/mlb/${runDate}/discovery`,
  outDir = `state/mlb/${runDate}`,
  now = new Date(),
} = {}) {
  if (!runDate) {
    throw new Error('runDate is required.');
  }

  const generatedAtUtc = now.toISOString();
  const kalshiPath = resolve(discoveryDir, 'kalshi_adapter.json');
  const mlbPath = resolve(discoveryDir, 'mlb_official_adapter.json');
  const baseballSavantPath = resolve(discoveryDir, 'baseball_savant_adapter.json');
  const weatherPath = resolve(discoveryDir, 'weather_adapter.json');
  const liquidityPath = resolve(discoveryDir, 'liquidity_adapter.json');
  const sportsbookPath = resolve(discoveryDir, 'sportsbook_adapter.json');
  const contextPath = resolve(discoveryDir, 'context_adapter.json');
  validateDiscoveryInputs({ kalshiPath, mlbPath });

  const kalshi = readJson(kalshiPath);
  const mlb = readJson(mlbPath);
  const baseballSavant = readOptionalAdapter(
    baseballSavantPath,
    'baseball_savant',
    `Baseball Savant adapter output is missing at ${baseballSavantPath}.`,
  );
  const weather = readOptionalAdapter(
    weatherPath,
    'weather',
    `Weather adapter output is missing at ${weatherPath}.`,
  );
  const liquidity = readOptionalAdapter(
    liquidityPath,
    'liquidity',
    `Liquidity adapter output is missing at ${liquidityPath}.`,
  );
  const sportsbook = readOptionalAdapter(
    sportsbookPath,
    'sportsbook_reference',
    `Sportsbook adapter output missing at ${sportsbookPath}.`,
  );
  const context = readOptionalAdapter(
    contextPath,
    'lineup_injury_bullpen',
    `Context adapter output missing at ${contextPath}.`,
  );

  const scoring = scoreMarkets({ kalshi, mlb, baseballSavant, weather, liquidity, sportsbook, context });
  const sameGameCombos = buildSameGameCombos(scoring.candidates);

  const outputPaths = {
    slate_manifest: `${outDir}/slate_manifest.json`,
    source_registry: `${outDir}/source_registry.json`,
    picks: `${outDir}/picks.json`,
    daily_baseball_guide: `${outDir}/daily-baseball-guide.md`,
    run_log: `${outDir}/run_log.md`,
    today_execution_board: `${outDir}/today-execution-board.json`,
    today_execution_board_md: `${outDir}/today-execution-board.md`,
  };

  const slateManifest = buildSlateManifest({ runDate, generatedAtUtc, kalshi, mlb, baseballSavant, weather, liquidity, sportsbook, context });
  const sourceRegistry = buildSourceRegistry({ runDate, generatedAtUtc, kalshi, mlb, baseballSavant, weather, liquidity, sportsbook, context });
  const picks = buildPicks({ runDate, generatedAtUtc, kalshi, mlb, baseballSavant, weather, liquidity, sportsbook, context, scoring });
  const dailyGuide = buildDailyGuide({
    runDate,
    generatedAtUtc,
    kalshi,
    mlb,
    baseballSavant,
    weather,
    liquidity,
    sportsbook,
    context,
    scoring,
    slateManifest,
    sameGameCombos,
  });
  const runLog = buildRunLog({ runDate, generatedAtUtc, kalshi, mlb, baseballSavant, weather, liquidity, sportsbook, context, outDir, outputPaths });
  const executionBoard = buildExecutionBoard({
    runDate,
    generatedAtUtc,
    scoring,
    slateManifest,
    sportsbook,
    context,
    weather,
    mlb,
    sameGameCombos,
  });
  const executionBoardMd = buildExecutionBoardMd({
    runDate,
    generatedAtUtc,
    scoring,
    slateManifest,
    sportsbook,
    context,
    weather,
    mlb,
    sameGameCombos,
  });

  const written = {
    slate_manifest: writeJsonAtomic(outputPaths.slate_manifest, slateManifest),
    source_registry: writeJsonAtomic(outputPaths.source_registry, sourceRegistry),
    picks: writeJsonAtomic(outputPaths.picks, picks),
    daily_baseball_guide: writeTextAtomic(outputPaths.daily_baseball_guide, dailyGuide),
    run_log: writeTextAtomic(outputPaths.run_log, runLog),
    today_execution_board: writeJsonAtomic(outputPaths.today_execution_board, executionBoard),
    today_execution_board_md: writeTextAtomic(outputPaths.today_execution_board_md, executionBoardMd),
  };

  return {
    run_date: runDate,
    generated_at_utc: generatedAtUtc,
    mode: 'output-writer-dry-run',
    discovery_dir: discoveryDir,
    out_dir: outDir,
    files: written,
    kalshi_status: sourceStatus(kalshi),
    mlb_status: sourceStatus(mlb),
    baseball_savant_status: sourceStatus(baseballSavant),
    weather_status: sourceStatus(weather),
    liquidity_status: sourceStatus(liquidity),
    liquidity_records: safeArray(liquidity.records).length,
    sportsbook_status: sourceStatus(sportsbook),
    context_status: sourceStatus(context),
    sportsbook_records: safeArray(sportsbook?.records).length,
    context_records: safeArray(context?.records).length,
    scoring_counts: scoring.counts,
    fixture_mode: scoring.fixture_mode,
    kalshi_records: safeArray(kalshi.records).length,
    kalshi_rejected_records: safeArray(kalshi.rejected_records).length,
    mlb_games: safeArray(mlb.records).length,
    baseball_savant_records: safeArray(baseballSavant.records).length,
    weather_records: safeArray(weather.records).length,
    picks: scoring.candidates.length,
    message: 'Discovery only. No final reads. No trades placed.',
  };
}
