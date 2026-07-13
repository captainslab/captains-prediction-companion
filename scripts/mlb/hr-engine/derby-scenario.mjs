// Foundation-only Home Run Derby adapter. It deliberately has no router lane.
import { assertNoPriceFields } from '../lib/projection-contracts.mjs';
import { assertKnownFields } from './contracts.mjs';
import { simulatePaOutcomes } from './monte-carlo.mjs';

const DERBY_FIELDS = Object.freeze([
  'power_profile', 'rounds', 'swing_limits', 'fatigue', 'seed', 'simulations',
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
  const {
    power_profile: profile,
    rounds,
    swing_limits,
    fatigue = 0,
    seed = 'cpc-hr-phase1',
    simulations = 400,
  } = input;
  assertNoPriceFields({ profile, rounds, swing_limits, fatigue, seed, simulations }, 'Derby scenario input');
  const reasons = [];
  if (!profile || profile.status !== 'ready') reasons.push('shared_power_profile_blocked');
  if (rounds !== 3) reasons.push('rounds_must_be_three_for_2026_format');
  const limits = swing_limits ?? {};
  if (!Number.isInteger(limits.round_1) || limits.round_1 !== 20) reasons.push('round_1_swing_limit_must_be_20');
  if (!Number.isInteger(limits.round_2) || limits.round_2 !== 15) reasons.push('round_2_swing_limit_must_be_15');
  if (!Number.isInteger(limits.finals) || limits.finals !== 15) reasons.push('finals_swing_limit_must_be_15');
  if (!Number.isFinite(fatigue) || fatigue < 0 || fatigue > 1) reasons.push('fatigue_missing_or_invalid');
  const normalizedInputs = {
    rounds: rounds ?? null,
    swing_limits: {
      round_1: limits.round_1 ?? null,
      round_2: limits.round_2 ?? null,
      finals: limits.finals ?? null,
    },
    fatigue,
  };
  if (reasons.length) return blocked(profile, reasons, normalizedInputs);
  const season = profile.features.hr_bip_by_window.season.hr_per_bip;
  if (!Number.isFinite(season)) return blocked(profile, ['shared_profile_season_hr_contact_rate_missing'], normalizedInputs);
  const fatigueAdjustedProbability = Math.max(0, Math.min(1, season * (1 - fatigue)));
  return {
    schema_version: 'mlb_hr_derby_foundation_v1', status: 'ready', foundation_only: true,
    blocked_reasons: [], power_profile: profile, inputs: normalizedInputs,
    simulation: simulatePaOutcomes({ seed, plate_appearances: limits.round_1, hr_probability: fatigueAdjustedProbability, simulations, contact_probability: 1 }),
    uncertainty: profile.uncertainty, coverage: profile.coverage,
  };
}

export const buildHomeRunDerbyScenario = buildDerbyScenario;
