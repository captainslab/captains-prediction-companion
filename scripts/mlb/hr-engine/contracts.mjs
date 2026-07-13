// Shared, market-free HR feature contracts. This module is intentionally pure.
import { assertNoPriceFields, FORBIDDEN_PRICE_KEYS } from '../lib/projection-contracts.mjs';

export const HR_FEATURE_PROFILE_SCHEMA = 'mlb_hr_feature_profile_v1';

const WINDOWS = Object.freeze(['7d', '30d', 'season']);
const WINDOW_FIELDS = Object.freeze(['pa', 'bip', 'hr', 'hr_per_pa', 'hr_per_bip']);
const RATE_FIELDS = Object.freeze([
  'barrel_rate', 'hard_hit_rate', 'sweet_spot_rate', 'fly_ball_rate', 'pull_air_rate',
]);
const EV_FIELDS = Object.freeze(['mean', 'p50', 'p90', 'max']);
const UNCERTAINTY_FIELDS = Object.freeze([
  'status', 'reasons', 'interval', 'confidence_band', 'data_completeness',
]);
const COVERAGE_FIELDS = Object.freeze([
  'windows_present', 'required_windows', 'sample_sizes', 'data_completeness',
  'latest_event_date', 'as_of', 'stale', 'missing_fields',
]);

// The registry is exported so downstream adapters can introspect the immutable
// schema without maintaining a second allowlist. Values are frozen arrays.
export const HR_FEATURE_FIELD_REGISTRY = Object.freeze({
  schema_version: HR_FEATURE_PROFILE_SCHEMA,
  profile: Object.freeze(['schema_version', 'status', 'blocked_reasons', 'batter', 'features', 'uncertainty', 'coverage']),
  batter: Object.freeze(['batter_id', 'player_name', 'team_name', 'stand']),
  features: Object.freeze([
    'hr_pa_by_window', 'hr_bip_by_window', 'ev_distribution',
    'barrel_rate', 'hard_hit_rate', 'sweet_spot_rate', 'fly_ball_rate', 'pull_air_rate',
    'launch_angle_distribution', 'spray_distribution', 'distance_tail',
    'handedness_splits', 'pitch_family_splits', 'environment', 'opportunity',
    'optional_bat_tracking',
  ]),
  window: WINDOW_FIELDS,
  rates: RATE_FIELDS,
  ev_distribution: EV_FIELDS,
  coverage: COVERAGE_FIELDS,
  uncertainty: UNCERTAINTY_FIELDS,
  forbidden_price_keys: FORBIDDEN_PRICE_KEYS,
});

export const HR_FEATURE_FIELDS = HR_FEATURE_FIELD_REGISTRY;

const PROFILE_FIELDS = new Set(HR_FEATURE_FIELD_REGISTRY.profile);
const BATTER_FIELDS = new Set(HR_FEATURE_FIELD_REGISTRY.batter);
const FEATURE_FIELDS = new Set(HR_FEATURE_FIELD_REGISTRY.features);
const WINDOW_FIELD_SET = new Set(WINDOW_FIELDS);
const EV_FIELD_SET = new Set(EV_FIELDS);
const RATE_FIELD_SET = new Set(RATE_FIELDS);
const UNCERTAINTY_FIELD_SET = new Set(UNCERTAINTY_FIELDS);
const COVERAGE_FIELD_SET = new Set(COVERAGE_FIELDS);

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`unknown ${label} field: ${key}`);
  }
}

function finiteOrNull(value, label) {
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error(`${label} must be a finite number or null`);
  }
}

function rateOrNull(value, label) {
  finiteOrNull(value, label);
  if (value !== null && (value < 0 || value > 1)) throw new Error(`${label} must be in [0,1]`);
}

function validateWindowMap(value, label) {
  object(value, label);
  for (const window of WINDOWS) {
    if (!(window in value)) throw new Error(`${label} missing required window ${window}`);
    const row = object(value[window], `${label}.${window}`);
    exactKeys(row, WINDOW_FIELD_SET, `${label}.${window}`);
    for (const field of WINDOW_FIELDS) {
      finiteOrNull(row[field], `${label}.${window}.${field}`);
      if (field.startsWith('hr_per_')) rateOrNull(row[field], `${label}.${window}.${field}`);
    }
  }
}

function validateEv(value) {
  const ev = object(value, 'features.ev_distribution');
  exactKeys(ev, EV_FIELD_SET, 'features.ev_distribution');
  for (const field of EV_FIELDS) {
    finiteOrNull(ev[field], `features.ev_distribution.${field}`);
    if (ev[field] !== null && ev[field] < 0) throw new Error(`features.ev_distribution.${field} must be non-negative`);
  }
}

function validateRates(features) {
  for (const field of RATE_FIELDS) rateOrNull(features[field], `features.${field}`);
}

function validateDistribution(value, label, keys) {
  const dist = object(value, label);
  exactKeys(dist, new Set(keys), label);
  for (const key of keys) rateOrNull(dist[key], `${label}.${key}`);
}

function validateSplits(value, label) {
  const splits = object(value, label);
  for (const [key, split] of Object.entries(splits)) {
    if (!key.trim()) throw new Error(`${label} contains an empty split key`);
    const row = object(split, `${label}.${key}`);
    const allowed = new Set(['pa', 'bip', 'hr', 'hr_per_pa', 'hr_per_bip', 'ev_mean', 'hard_hit_rate']);
    exactKeys(row, allowed, `${label}.${key}`);
    for (const field of allowed) {
      if (field in row) {
        finiteOrNull(row[field], `${label}.${key}.${field}`);
        if (field.endsWith('rate') || field.startsWith('hr_per_')) rateOrNull(row[field], `${label}.${key}.${field}`);
      }
    }
  }
}

function validateUncertainty(value) {
  const uncertainty = object(value, 'uncertainty');
  exactKeys(uncertainty, UNCERTAINTY_FIELD_SET, 'uncertainty');
  if (typeof uncertainty.status !== 'string') throw new Error('uncertainty.status is required');
  if (!Array.isArray(uncertainty.reasons)) throw new Error('uncertainty.reasons must be an array');
  if (uncertainty.interval !== null) {
    const interval = object(uncertainty.interval, 'uncertainty.interval');
    exactKeys(interval, new Set(['low', 'high']), 'uncertainty.interval');
    finiteOrNull(interval.low, 'uncertainty.interval.low');
    finiteOrNull(interval.high, 'uncertainty.interval.high');
  }
  if (uncertainty.confidence_band !== null && typeof uncertainty.confidence_band !== 'string') {
    throw new Error('uncertainty.confidence_band must be a string or null');
  }
  rateOrNull(uncertainty.data_completeness, 'uncertainty.data_completeness');
}

function validateCoverage(value) {
  const coverage = object(value, 'coverage');
  exactKeys(coverage, COVERAGE_FIELD_SET, 'coverage');
  if (!Array.isArray(coverage.windows_present) || !coverage.windows_present.every((x) => WINDOWS.includes(x))) {
    throw new Error('coverage.windows_present must contain only known windows');
  }
  if (!Array.isArray(coverage.required_windows) || !coverage.required_windows.every((x) => WINDOWS.includes(x))) {
    throw new Error('coverage.required_windows must contain only known windows');
  }
  object(coverage.sample_sizes, 'coverage.sample_sizes');
  for (const window of WINDOWS) {
    if (!(window in coverage.sample_sizes)) throw new Error(`coverage.sample_sizes missing ${window}`);
    const n = coverage.sample_sizes[window];
    if (!Number.isInteger(n) || n < 0) throw new Error(`coverage.sample_sizes.${window} must be a non-negative integer`);
  }
  rateOrNull(coverage.data_completeness, 'coverage.data_completeness');
  if (coverage.latest_event_date !== null && typeof coverage.latest_event_date !== 'string') throw new Error('coverage.latest_event_date must be a string or null');
  if (coverage.as_of !== null && typeof coverage.as_of !== 'string') throw new Error('coverage.as_of must be a string or null');
  if (typeof coverage.stale !== 'boolean') throw new Error('coverage.stale must be boolean');
  if (!Array.isArray(coverage.missing_fields)) throw new Error('coverage.missing_fields must be an array');
}

export function validateHrFeatureProfile(profile) {
  assertNoPriceFields(profile, 'HR feature profile');
  const value = object(profile, 'HR feature profile');
  exactKeys(value, PROFILE_FIELDS, 'HR feature profile');
  if (value.schema_version !== HR_FEATURE_PROFILE_SCHEMA) throw new Error(`unsupported HR feature schema: ${value.schema_version}`);
  if (!['ready', 'blocked'].includes(value.status)) throw new Error('HR feature profile status must be ready or blocked');
  if (!Array.isArray(value.blocked_reasons)) throw new Error('blocked_reasons must be an array');
  const batter = object(value.batter, 'batter');
  exactKeys(batter, BATTER_FIELDS, 'batter');
  if (value.status === 'ready' && batter.batter_id == null && !String(batter.player_name ?? '').trim()) throw new Error('batter requires batter_id or player_name');
  if (batter.batter_id !== null && batter.batter_id !== undefined && (typeof batter.batter_id !== 'number' && typeof batter.batter_id !== 'string')) throw new Error('batter.batter_id must be a number or string');
  for (const field of ['player_name', 'team_name', 'stand']) {
    if (batter[field] !== null && batter[field] !== undefined && typeof batter[field] !== 'string') throw new Error(`batter.${field} must be a string or null`);
  }
  if (value.status === 'ready') {
    const features = object(value.features, 'features');
    exactKeys(features, FEATURE_FIELDS, 'features');
    validateWindowMap(features.hr_pa_by_window, 'features.hr_pa_by_window');
    validateWindowMap(features.hr_bip_by_window, 'features.hr_bip_by_window');
    validateEv(features.ev_distribution);
    validateRates(features);
    validateDistribution(features.spray_distribution, 'features.spray_distribution', ['pull', 'center', 'oppo']);
    validateDistribution(features.launch_angle_distribution, 'features.launch_angle_distribution', ['below_0', '0_9', '10_19', '20_29', '30_plus']);
    const distance = object(features.distance_tail, 'features.distance_tail');
    exactKeys(distance, new Set(['max', 'count_ge_400ft']), 'features.distance_tail');
    finiteOrNull(distance.max, 'features.distance_tail.max');
    if (distance.count_ge_400ft !== null && (!Number.isInteger(distance.count_ge_400ft) || distance.count_ge_400ft < 0)) throw new Error('features.distance_tail.count_ge_400ft must be a non-negative integer or null');
    validateSplits(features.handedness_splits, 'features.handedness_splits');
    validateSplits(features.pitch_family_splits, 'features.pitch_family_splits');
    const environment = object(features.environment, 'features.environment');
    exactKeys(environment, new Set(['park', 'weather', 'roof', 'altitude', 'wall_direction']), 'features.environment');
    for (const field of Object.keys(environment)) if (environment[field] !== null && typeof environment[field] !== 'string' && typeof environment[field] !== 'number') throw new Error(`features.environment.${field} must be scalar or null`);
    const opportunity = object(features.opportunity, 'features.opportunity');
    exactKeys(opportunity, new Set(['expected_pa', 'lineup_slot', 'lineup_status', 'opportunity_status']), 'features.opportunity');
    finiteOrNull(opportunity.expected_pa, 'features.opportunity.expected_pa');
    if (opportunity.lineup_slot !== null && (!Number.isInteger(opportunity.lineup_slot) || opportunity.lineup_slot < 1 || opportunity.lineup_slot > 9)) throw new Error('features.opportunity.lineup_slot must be 1-9 or null');
    for (const field of ['lineup_status', 'opportunity_status']) if (opportunity[field] !== null && typeof opportunity[field] !== 'string') throw new Error(`features.opportunity.${field} must be string or null`);
    if (features.optional_bat_tracking !== null) {
      const batTracking = object(features.optional_bat_tracking, 'features.optional_bat_tracking');
      exactKeys(batTracking, new Set(['bat_speed', 'swing_length', 'attack_angle', 'attack_direction', 'time_to_contact', 'squared_up_rate', 'coverage']), 'features.optional_bat_tracking');
    }
  } else if (value.features !== null) {
    throw new Error('blocked HR feature profile must have features=null');
  }
  if (!('uncertainty' in value) || !('coverage' in value)) throw new Error('HR profile requires explicit uncertainty and coverage');
  validateUncertainty(value.uncertainty);
  validateCoverage(value.coverage);
  return value;
}

export function assertKnownFields(value, allowed, label) {
  assertNoPriceFields(value, label);
  const objectValue = object(value, label);
  exactKeys(objectValue, new Set(allowed), label);
  return objectValue;
}

export { WINDOWS, WINDOW_FIELDS, RATE_FIELDS, EV_FIELDS };
