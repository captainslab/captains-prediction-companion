// NASCAR Stage 3 discovery composer.
// Fixture-first dry-run only. No runtime integration, credentials, picks, fair values, or trades.

import { runSourceAdapterDryRun } from '../source-adapter-dry-run.mjs';

export const RACE_MARKET_LANES = Object.freeze([
  'win',
  'top3',
  'top5',
  'top10',
  'top20',
  'fastest_lap',
]);

export const ALLOWED_OVERRIDE_REASONS = Object.freeze([
  'pole_winner',
  'top5_starting_position',
  'top5_practice_speed',
  'strong_multi_lap_average',
  'elite_track_history',
  'kalshi_price_or_liquidity',
  'special_format_rule',
]);

export const SPECIAL_EVENT_FORMATS = Object.freeze([
  'all_star',
  'clash',
  'exhibition',
  'heat',
  'transfer',
  'qualifying_transfer',
  'cutdown',
]);

export const FORBIDDEN_DISCOVERY_FIELDS = Object.freeze([
  'trade',
  'order',
  'stake',
  'pick',
  'recommendation',
  'fair_value',
  'edge',
  'kelly',
  'execution',
]);

const LANE_DESCRIPTIONS = Object.freeze({
  win: ['finish_position', 'Driver wins the race outright.'],
  top3: ['finish_position', 'Driver finishes in the top 3.'],
  top5: ['finish_position', 'Driver finishes in the top 5.'],
  top10: ['finish_position', 'Driver finishes in the top 10.'],
  top20: ['finish_position', 'Driver finishes in the top 20; this is a race market lane, not the current-points pool rule.'],
  fastest_lap: ['special_prop', 'Driver records the fastest single lap; special prop lane, not a finish-position ceiling.'],
});

function normalizeEventFormat(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : 'points';
  if (raw === 'all-star' || raw === 'all star') return 'all_star';
  if (raw === 'transfer' || raw === 'qualifying-transfer') return raw.replace('-', '_');
  return raw || 'points';
}

function firstRecord(envelope) {
  return Array.isArray(envelope?.records) ? envelope.records[0] ?? null : null;
}

function stableNumber(value, fallback = null) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function stableDriverId(record) {
  const name = String(record.driver_name ?? 'unknown-driver')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const car = record.car_number === null || record.car_number === undefined ? 'na' : String(record.car_number);
  return `${name}-${car}`;
}

function allowedOverrideReasons(record) {
  const explicit = Array.isArray(record.override_reasons) ? record.override_reasons : [];
  const inferred = [];

  if (stableNumber(record.starting_position, 999) === 1) inferred.push('pole_winner');
  if (stableNumber(record.starting_position, 999) <= 5) inferred.push('top5_starting_position');
  if (stableNumber(record.practice_rank, 999) <= 5) inferred.push('top5_practice_speed');
  if (stableNumber(record.multi_lap_rank, 999) <= 5) inferred.push('strong_multi_lap_average');
  if (record.track_history_signal === 'elite') inferred.push('elite_track_history');
  if (record.liquidity_signal === 'strong_market_attention') inferred.push('kalshi_price_or_liquidity');
  if (record.special_format_signal === true) inferred.push('special_format_rule');

  return [...new Set([...explicit, ...inferred].filter(reason => ALLOWED_OVERRIDE_REASONS.includes(reason)))];
}

function normalizeDriver(record, eventFormat) {
  const currentPointsRank = stableNumber(record.current_points_rank);
  const overrideReasons = allowedOverrideReasons(record);
  const specialEvent = SPECIAL_EVENT_FORMATS.includes(eventFormat);
  const isTop20Points = currentPointsRank !== null && currentPointsRank <= 20;
  const overridePromoted = !isTop20Points && overrideReasons.length > 0;

  let poolStatus = 'field';
  let poolEntryReason = 'field_longshot';
  if (specialEvent && overrideReasons.includes('special_format_rule')) {
    poolStatus = 'active';
    poolEntryReason = 'special_format_rule';
  } else if (isTop20Points) {
    poolStatus = 'active';
    poolEntryReason = 'current_points_top_20';
  } else if (overridePromoted) {
    poolStatus = 'active';
    poolEntryReason = 'override_promoted';
  }

  return {
    driver_id: stableDriverId(record),
    driver_name: record.driver_name ?? null,
    car_number: record.car_number ?? null,
    current_points_rank: currentPointsRank,
    starting_position: stableNumber(record.starting_position),
    practice_rank: stableNumber(record.practice_rank),
    multi_lap_rank: stableNumber(record.multi_lap_rank),
    track_history_signal: record.track_history_signal ?? 'unknown',
    liquidity_signal: record.liquidity_signal ?? 'unknown',
    override_reasons: overrideReasons,
    pool_status: poolStatus,
    pool_entry_reason: poolEntryReason,
  };
}

function sortDrivers(a, b) {
  const rankA = a.current_points_rank ?? 9999;
  const rankB = b.current_points_rank ?? 9999;
  if (rankA !== rankB) return rankA - rankB;
  return String(a.driver_name ?? '').localeCompare(String(b.driver_name ?? ''));
}

function laneRecords(kalshiEnvelope) {
  const present = new Set(
    (kalshiEnvelope?.records ?? [])
      .map(record => record.market_lane)
      .filter(lane => RACE_MARKET_LANES.includes(lane)),
  );

  return RACE_MARKET_LANES.map(lane => {
    const [laneType, description] = LANE_DESCRIPTIONS[lane];
    return {
      market_lane: lane,
      lane_type: laneType,
      source_available: present.has(lane),
      description,
    };
  });
}

function eventContextFrom(envelopes) {
  const official = firstRecord(envelopes.nascar_official) ?? {};
  const eventFormat = normalizeEventFormat(official.event_format);
  return {
    race_name: official.race_name ?? null,
    series: official.series ?? null,
    track: official.track ?? null,
    track_type: official.track_type ?? null,
    scheduled_start_utc: official.scheduled_start_utc ?? null,
    race_type: official.race_type ?? null,
    event_format: eventFormat,
    stage_lengths: official.stage_lengths ?? null,
  };
}

function specialEventMetadata(eventContext) {
  const active = SPECIAL_EVENT_FORMATS.includes(eventContext.event_format);
  return {
    active,
    format_type: active ? eventContext.event_format : null,
    reason: active
      ? `${eventContext.event_format} event format requires separate special_event_override handling.`
      : null,
    default_points_pool_disabled: active,
    metadata_only: true,
  };
}

function assertNoForbiddenFields(value) {
  const walk = (node, path = []) => {
    if (Array.isArray(node)) {
      node.forEach((item, idx) => walk(item, [...path, String(idx)]));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        if (FORBIDDEN_DISCOVERY_FIELDS.includes(key)) {
          throw new Error(`Discovery output contains forbidden field ${[...path, key].join('.')}`);
        }
        walk(child, [...path, key]);
      }
    }
  };
  walk(value);
}

export function composeRaceDiscovery({ envelopes, runDate = null, checkedAtUtc = null } = {}) {
  if (!envelopes || typeof envelopes !== 'object') {
    throw new Error('composeRaceDiscovery requires Stage 2 fixture envelopes');
  }

  const event_context = eventContextFrom(envelopes);
  const eventFormat = event_context.event_format;
  const driverRecords = envelopes.practice_qualifying?.records ?? [];
  const driver_universe = driverRecords.map(record => normalizeDriver(record, eventFormat)).sort(sortDrivers);
  const active_candidate_pool = driver_universe.filter(driver => driver.pool_status === 'active').sort(sortDrivers);
  const fieldDrivers = driver_universe.filter(driver => driver.pool_status === 'field').sort(sortDrivers);
  const override_promoted_drivers = active_candidate_pool
    .filter(driver => driver.pool_entry_reason === 'override_promoted' || driver.pool_entry_reason === 'special_format_rule')
    .map(driver => ({
      driver_id: driver.driver_id,
      driver_name: driver.driver_name,
      current_points_rank: driver.current_points_rank,
      override_reasons: driver.override_reasons,
      pool_entry_reason: driver.pool_entry_reason,
    }));

  const discovery = {
    schema_version: 'nascar_discovery_v1',
    mode: 'fixtures-only',
    run_date: runDate,
    checked_at_utc: checkedAtUtc,
    event_context,
    supported_market_lanes: laneRecords(envelopes.kalshi_race),
    pool_rules: {
      default_active_rule: 'current_points_rank <= 20',
      field_rule: 'current_points_rank > 20 without allowed override reasons stays in FIELD',
      top20_lane_separation: 'top20 market lane is a race finish-position market, not the current-points pool filter',
      fastest_lap_lane_note: 'fastest_lap is a special prop lane, not a finish-position ceiling',
      allowed_override_reasons: [...ALLOWED_OVERRIDE_REASONS],
    },
    driver_universe,
    active_candidate_pool,
    field_bucket: {
      bucket_id: 'FIELD',
      longshot_driver_count: fieldDrivers.length,
      driver_names: fieldDrivers.map(driver => driver.driver_name),
      summary: `${fieldDrivers.length} non-active driver(s) collapsed into FIELD longshot bucket; no individual modeling output emitted.`,
    },
    override_promoted_drivers,
    special_event_override: specialEventMetadata(event_context),
    source_envelopes_used: Object.fromEntries(
      Object.entries(envelopes).map(([id, envelope]) => [
        id,
        {
          source_id: envelope.source_id,
          status: envelope.status,
          record_count: Array.isArray(envelope.records) ? envelope.records.length : 0,
          checked_at_utc: envelope.checked_at_utc,
        },
      ]),
    ),
    safety_notes: [
      'Dry-run discovery composer only.',
      'No individual FIELD outputs.',
      'No fair-value, sizing, or execution fields are emitted.',
    ],
  };

  assertNoForbiddenFields(discovery);
  return discovery;
}

function applyRequestedEventFormat(envelopes, eventFormat) {
  const normalized = normalizeEventFormat(eventFormat);
  if (normalized === 'points') return envelopes;

  const official = envelopes.nascar_official;
  if (!official || !Array.isArray(official.records) || official.records.length === 0) {
    return envelopes;
  }

  return {
    ...envelopes,
    nascar_official: {
      ...official,
      records: official.records.map((record, index) =>
        index === 0
          ? {
              ...record,
              race_type: normalized,
              event_format: normalized,
              is_special_event: true,
              notes: 'Special event: downstream discovery must mark special_event_override metadata; do not use as default points-race model.',
            }
          : record,
      ),
    },
  };
}

export async function runDiscoveryDryRun({ date = null, eventFormat = 'points', series = 'cup' } = {}) {
  const { runDate, envelopes, summary } = await runSourceAdapterDryRun({
    date,
    source: 'all',
    eventFormat,
    series,
  });
  const discoveryEnvelopes = applyRequestedEventFormat(envelopes, eventFormat);
  return composeRaceDiscovery({
    envelopes: discoveryEnvelopes,
    runDate,
    checkedAtUtc: summary.checked_at_utc,
  });
}
