import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureBaseballSavantDistributionEnvelope } from '../scripts/mlb/source-adapters/baseball-savant-distributions.mjs';
import { buildPowerProfile } from '../scripts/mlb/hr-engine/power-profile.mjs';
import { buildRegularGameScenario } from '../scripts/mlb/hr-engine/regular-game-scenario.mjs';
import { buildDerbyScenario } from '../scripts/mlb/hr-engine/derby-scenario.mjs';
import { simulatePaOutcomes } from '../scripts/mlb/hr-engine/monte-carlo.mjs';
import { assessDataQuality } from '../scripts/mlb/hr-engine/data-quality.mjs';
import { validateHrFeatureProfile } from '../scripts/mlb/hr-engine/contracts.mjs';
import { FORBIDDEN_PRICE_KEYS } from '../scripts/mlb/lib/projection-contracts.mjs';

function profile() {
  return buildPowerProfile({ distribution: fixtureBaseballSavantDistributionEnvelope().records[0], as_of: '2026-05-15T14:00:00Z' });
}

test('fixed seed is deterministic and different seed changes simulation', () => {
  const input = { seed: 'cpc-hr-phase1', plate_appearances: 40, hr_probability: 0.08, simulations: 100 };
  assert.deepEqual(simulatePaOutcomes(input), simulatePaOutcomes(input));
  assert.notDeepEqual(simulatePaOutcomes(input), simulatePaOutcomes({ ...input, seed: 'other-seed' }));
});

test('zero HR probability never produces a hit and simulation rejects unknown fields', () => {
  const zeroProbability = simulatePaOutcomes({ seed: 'zero-probability', plate_appearances: 40, hr_probability: 0, simulations: 100 });
  assert.equal(zeroProbability.mean_hr, 0);
  assert.equal(zeroProbability.probability_at_least_one_hr, 0);
  assert.throws(() => simulatePaOutcomes({ seed: 'zero-probability', plate_appearances: 40, hr_probability: 0, stray: true }), /unknown/);
});

test('custom per-window thresholds retain the default stale gate', () => {
  const windows = {
    '7d': { pa: 1 },
    '30d': { pa: 1 },
    season: { pa: 1 },
  };
  const quality = assessDataQuality({
    windows,
    latest_event_date: '2025-01-13',
    as_of: '2026-07-13',
    thresholds: { '7d': 1, '30d': 1, season: 1 },
  });
  assert.equal(quality.status, 'blocked');
  assert.ok(quality.blocked_reasons.includes('data_stale'));
  assert.equal(quality.coverage.stale, true);
});

test('data quality rejects unknown input fields and invalid stale thresholds', () => {
  assert.throws(() => assessDataQuality({ windows: {}, stray: true }), /unknown/);
  const quality = assessDataQuality({
    windows: { '7d': { pa: 10 }, '30d': { pa: 10 }, season: { pa: 10 } },
    latest_event_date: '2026-07-13',
    as_of: '2026-07-13',
    thresholds: { stale_after_days: 'invalid' },
  });
  assert.equal(quality.status, 'blocked');
  assert.ok(quality.blocked_reasons.includes('stale_threshold_invalid'));
});

test('regular and Derby adapters retain the exact same shared profile object', () => {
  const shared = profile();
  const regular = buildRegularGameScenario({ power_profile: shared, expected_pa: 4, park: { id: 'P' }, weather: { status: 'complete' }, starter_handedness: 'R' });
  const derby = buildDerbyScenario({ power_profile: shared, rounds: 3, swing_limits: { round_1: 20, round_2: 15, finals: 15 }, fatigue: 0.1 });
  assert.equal(regular.power_profile, shared);
  assert.equal(derby.power_profile, shared);
  assert.equal(regular.status, 'ready');
  assert.equal(derby.status, 'ready');
});

test('scenario adapters reject the other scenario input family', () => {
  const shared = profile();
  assert.throws(() => buildRegularGameScenario({ power_profile: shared, expected_pa: 4, park: {}, weather: {}, starter_handedness: 'R', rounds: 3 }));
  assert.throws(() => buildDerbyScenario({ power_profile: shared, rounds: 3, swing_limits: { round_1: 20, round_2: 15, finals: 15 }, expected_pa: 4 }));
});

test('missing required inputs produce blocked envelopes without fabricated numbers', () => {
  const blocked = buildPowerProfile({});
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.features, null);
  assert.ok(blocked.blocked_reasons.length > 0);
  const regular = buildRegularGameScenario({ power_profile: blocked, expected_pa: 4, park: {}, weather: {}, starter_handedness: 'R' });
  assert.equal(regular.status, 'blocked');
  assert.equal(regular.simulation, null);
});

test('null required distributions block without throwing', () => {
  const source = { ...fixtureBaseballSavantDistributionEnvelope().records[0], ev_distribution: null };
  assert.doesNotThrow(() => buildPowerProfile({ distribution: source, as_of: '2026-05-15T14:00:00Z' }));
  const blocked = buildPowerProfile({ distribution: source, as_of: '2026-05-15T14:00:00Z' });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.features, null);
  assert.ok(blocked.blocked_reasons.includes('field_missing:ev_distribution'));
});

test('distance-tail count preserves explicit null and optional tracking is copied', () => {
  const optional = { bat_speed: 75, swing_length: 7, attack_angle: 10, attack_direction: 2, time_to_contact: 0.15, squared_up_rate: 0.4, coverage: 0.8 };
  const source = {
    ...fixtureBaseballSavantDistributionEnvelope().records[0],
    distance_tail: { max: null, count_ge_400ft: null },
    optional_bat_tracking: optional,
  };
  const built = buildPowerProfile({ distribution: source, as_of: '2026-05-15T14:00:00Z' });
  assert.equal(built.status, 'ready');
  assert.equal(built.features.distance_tail.count_ge_400ft, null);
  assert.notEqual(built.features.distance_tail.count_ge_400ft, 0);
  assert.notEqual(built.features.optional_bat_tracking, optional);
  assert.equal(Object.isFrozen(optional), false);
});

test('schema rejects unknown fields and every forbidden price field', () => {
  const valid = profile();
  assert.throws(() => validateHrFeatureProfile({ ...valid, unknown_field: 1 }), /unknown/);
  for (const key of FORBIDDEN_PRICE_KEYS) assert.throws(() => validateHrFeatureProfile({ ...valid, [key]: 1 }), /price-isolation/);
});

test('market-field injection is fail-closed and cannot alter baseline output', () => {
  const before = profile();
  assert.throws(() => buildPowerProfile({ distribution: { ...fixtureBaseballSavantDistributionEnvelope().records[0], price: 0.99 }, as_of: '2026-05-15T14:00:00Z' }), /price-isolation/);
  assert.deepEqual(profile(), before);
  const sim = simulatePaOutcomes({ seed: 'same', plate_appearances: 20, hr_probability: 0.1, simulations: 30 });
  assert.throws(() => simulatePaOutcomes({ seed: 'same', plate_appearances: 20, hr_probability: 0.1, simulations: 30, odds: 1 }), /price-isolation/);
  assert.deepEqual(simulatePaOutcomes({ seed: 'same', plate_appearances: 20, hr_probability: 0.1, simulations: 30 }), sim);
});

test('ready profiles always carry explicit uncertainty and coverage', () => {
  const built = profile();
  assert.ok(built.uncertainty);
  assert.ok(built.coverage);
  assert.deepEqual(built.coverage.required_windows, ['7d', '30d', 'season']);
});
