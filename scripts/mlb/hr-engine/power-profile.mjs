// Shared power/contact/ball-flight profile. It is the only profile consumed by
// both regular-game and Derby scenario adapters.
import { assertNoPriceFields } from '../lib/projection-contracts.mjs';
import { assessDataQuality } from './data-quality.mjs';
import { HR_FEATURE_PROFILE_SCHEMA, assertKnownFields, validateHrFeatureProfile } from './contracts.mjs';

const REQUIRED_DISTRIBUTION_KEYS = new Set([
  'windows', 'ev_distribution', 'launch_angle_distribution', 'spray_distribution',
  'distance_tail', 'rates', 'handedness_splits', 'pitch_family_splits',
  'optional_bat_tracking',
]);
const REQUIRED_NON_NULL_DISTRIBUTION_KEYS = Object.freeze([...REQUIRED_DISTRIBUTION_KEYS].filter((key) => key !== 'optional_bat_tracking'));

function finiteOrNull(value) {
  return value === null || value === undefined ? null : (Number.isFinite(Number(value)) ? Number(value) : null);
}

function windowRow(row = {}) {
  const pa = finiteOrNull(row.pa);
  const bip = finiteOrNull(row.bip);
  const hr = finiteOrNull(row.hr ?? row.hr_events);
  return {
    pa, bip, hr,
    hr_per_pa: finiteOrNull(row.hr_per_pa ?? row.hr_rate ?? (pa > 0 && hr != null ? hr / pa : null)),
    hr_per_bip: finiteOrNull(row.hr_per_bip ?? (bip > 0 && hr != null ? hr / bip : null)),
  };
}

function splitRows(splits = {}) {
  const output = {};
  for (const [key, row] of Object.entries(splits ?? {})) {
    const pa = finiteOrNull(row.pa);
    const bip = finiteOrNull(row.bip);
    const hr = finiteOrNull(row.hr ?? row.hr_events);
    output[key] = {
      pa, bip, hr,
      hr_per_pa: finiteOrNull(row.hr_per_pa ?? (pa > 0 && hr != null ? hr / pa : null)),
      hr_per_bip: finiteOrNull(row.hr_per_bip ?? (bip > 0 && hr != null ? hr / bip : null)),
      ev_mean: finiteOrNull(row.ev_mean),
      hard_hit_rate: finiteOrNull(row.hard_hit_rate),
    };
  }
  return output;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function buildPowerProfile(input = {}) {
  assertNoPriceFields(input, 'HR power profile input');
  const {
    distribution = null,
    distributions = null,
    batter = null,
    as_of = null,
    environment = {},
    opportunity = {},
  } = input;
  const source = distribution ?? distributions;
  const safeBatter = batter ?? source?.batter ?? {
    batter_id: source?.batter_id ?? null,
    player_name: source?.player_name ?? null,
    team_name: source?.team_name ?? null,
    stand: source?.stand ?? source?.hand ?? null,
  };
  const base = {
    schema_version: HR_FEATURE_PROFILE_SCHEMA,
    status: 'blocked',
    blocked_reasons: [],
    batter: {
      batter_id: safeBatter?.batter_id ?? null,
      player_name: safeBatter?.player_name ?? null,
      team_name: safeBatter?.team_name ?? null,
      stand: safeBatter?.stand ?? safeBatter?.hand ?? null,
    },
    features: null,
    uncertainty: {
      status: 'blocked', reasons: ['distribution_missing'], interval: null,
      confidence_band: 'unavailable', data_completeness: 0,
    },
    coverage: {
      windows_present: [], required_windows: ['7d', '30d', 'season'],
      sample_sizes: { '7d': 0, '30d': 0, season: 0 }, data_completeness: 0,
      latest_event_date: null, as_of: as_of ?? null, stale: true, missing_fields: [],
    },
  };

  if (!source) {
    base.blocked_reasons = ['distribution_missing'];
    validateHrFeatureProfile(base);
    return deepFreeze(base);
  }
  assertKnownFields(source, [...REQUIRED_DISTRIBUTION_KEYS, 'batter_id', 'player_name', 'team_name', 'stand', 'hand', 'latest_event_date', 'coverage'], 'HR distribution');
  const missing = [];
  for (const key of REQUIRED_NON_NULL_DISTRIBUTION_KEYS) {
    if (!(key in source) || source[key] == null) missing.push(key);
  }
  const quality = assessDataQuality({
    windows: source.windows,
    latest_event_date: source.latest_event_date ?? source.coverage?.latest_event_date ?? null,
    as_of,
    missing_fields: [...new Set([...missing, ...(source.coverage?.missing_fields ?? [])])],
  });
  base.uncertainty = quality.uncertainty;
  base.coverage = quality.coverage;
  base.blocked_reasons = [...quality.blocked_reasons];
  if (quality.status === 'blocked') {
    base.status = 'blocked';
    validateHrFeatureProfile(base);
    return deepFreeze(base);
  }

  base.status = 'ready';
  base.features = {
    hr_pa_by_window: Object.fromEntries(['7d', '30d', 'season'].map((window) => [window, windowRow(source.windows[window])])),
    hr_bip_by_window: Object.fromEntries(['7d', '30d', 'season'].map((window) => [window, windowRow(source.windows[window])])),
    ev_distribution: {
      mean: finiteOrNull(source.ev_distribution.mean),
      p50: finiteOrNull(source.ev_distribution.p50),
      p90: finiteOrNull(source.ev_distribution.p90),
      max: finiteOrNull(source.ev_distribution.max),
    },
    ...Object.fromEntries(['barrel_rate', 'hard_hit_rate', 'sweet_spot_rate', 'fly_ball_rate', 'pull_air_rate'].map((field) => [field, finiteOrNull(source.rates[field])])),
    launch_angle_distribution: { ...source.launch_angle_distribution },
    spray_distribution: { ...source.spray_distribution },
    distance_tail: {
      max: finiteOrNull(source.distance_tail.max),
      count_ge_400ft: source.distance_tail.count_ge_400ft == null ? null : (Number.isInteger(source.distance_tail.count_ge_400ft) ? source.distance_tail.count_ge_400ft : null),
    },
    handedness_splits: splitRows(source.handedness_splits),
    pitch_family_splits: splitRows(source.pitch_family_splits),
    environment: {
      park: environment.park ?? null,
      weather: environment.weather ?? null,
      roof: environment.roof ?? null,
      altitude: environment.altitude ?? null,
      wall_direction: environment.wall_direction ?? null,
    },
    opportunity: {
      expected_pa: opportunity.expected_pa ?? null,
      lineup_slot: opportunity.lineup_slot ?? null,
      lineup_status: opportunity.lineup_status ?? null,
      opportunity_status: opportunity.opportunity_status ?? null,
    },
    optional_bat_tracking: source.optional_bat_tracking == null ? null : structuredClone(source.optional_bat_tracking),
  };
  validateHrFeatureProfile(base);
  return deepFreeze(base);
}

export const buildSharedPowerProfile = buildPowerProfile;
