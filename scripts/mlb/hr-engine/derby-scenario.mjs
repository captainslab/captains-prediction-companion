// Foundation-only Home Run Derby adapter. It deliberately has no router lane.
import { assertNoPriceFields } from '../lib/projection-contracts.mjs';
import { assertKnownFields } from './contracts.mjs';
import { simulatePaOutcomes } from './monte-carlo.mjs';

const DERBY_FIELDS = Object.freeze([
  'power_profile', 'rounds', 'timer_seconds', 'swing_count', 'fatigue',
  'seed', 'simulations',
]);

function blocked(profile, reasons, inputs = {}) {
  return {
    schema_version: 'mlb_hr_derby_foundation_v1', status: 'blocked', foundation_only: true,
    blocked_reasons: reasons, power_profile: profile ?? null, inputs, simulation: null,
    uncertainty: profile?.uncertainty ?? null, coverage: profile?.coverage ?? null,
  };
}

export function buildDerbyScenario(input = {}) {
  assertKnownFields(input, DERBY_FIELDS, 'Derby scenario input');
  const { power_profile: profile, rounds, timer_seconds, swing_count, fatigue = 0, seed = 'cpc-hr-phase1', simulations = 400 } = input;
  assertNoPriceFields({ profile, rounds, timer_seconds, swing_count, fatigue, seed, simulations }, 'Derby scenario input');
  const reasons = [];
  if (!profile || profile.status !== 'ready') reasons.push('shared_power_profile_blocked');
  if (!Number.isInteger(rounds) || rounds <= 0) reasons.push('rounds_missing_or_invalid');
  if (!Number.isInteger(swing_count) || swing_count <= 0) reasons.push('swing_count_missing_or_invalid');
  if (!Number.isFinite(timer_seconds) || timer_seconds <= 0) reasons.push('timer_seconds_missing_or_invalid');
  if (!Number.isFinite(fatigue) || fatigue < 0 || fatigue > 1) reasons.push('fatigue_missing_or_invalid');
  const normalizedInputs = { rounds: rounds ?? null, timer_seconds: timer_seconds ?? null, swing_count: swing_count ?? null, fatigue };
  if (reasons.length) return blocked(profile, reasons, normalizedInputs);
  const season = profile.features.hr_bip_by_window.season.hr_per_bip;
  if (!Number.isFinite(season)) return blocked(profile, ['shared_profile_season_hr_contact_rate_missing'], normalizedInputs);
  const fatigueAdjustedProbability = Math.max(0, Math.min(1, season * (1 - fatigue)));
  return {
    schema_version: 'mlb_hr_derby_foundation_v1', status: 'ready', foundation_only: true,
    blocked_reasons: [], power_profile: profile, inputs: normalizedInputs,
    simulation: simulatePaOutcomes({ seed, plate_appearances: swing_count, hr_probability: fatigueAdjustedProbability, simulations, contact_probability: 1 }),
    uncertainty: profile.uncertainty, coverage: profile.coverage,
  };
}

export const buildHomeRunDerbyScenario = buildDerbyScenario;
