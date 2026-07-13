// Foundation-only regular-game anytime-HR adapter. Not wired to a router.
import { assertNoPriceFields } from '../lib/projection-contracts.mjs';
import { assertKnownFields } from './contracts.mjs';
import { simulatePaOutcomes } from './monte-carlo.mjs';
import { buildRegularGamePrediction } from './regular-game-model.mjs';

const REGULAR_FIELDS = Object.freeze([
  'power_profile', 'expected_pa', 'park', 'weather', 'starter_handedness',
  'starter_hand', 'seed', 'simulations', 'lineup_status',
  'model', 'player', 'candidates', 'pitcher', 'as_of',
]);

function blocked(profile, reasons, inputs = {}) {
  return {
    schema_version: 'mlb_hr_regular_game_foundation_v1',
    status: 'blocked', foundation_only: true, blocked_reasons: reasons,
    power_profile: profile ?? null, inputs, simulation: null,
    uncertainty: profile?.uncertainty ?? null, coverage: profile?.coverage ?? null,
  };
}

export function buildRegularGameScenario(input = {}) {
  assertKnownFields(input, REGULAR_FIELDS, 'regular-game scenario input');
  if (input.model) {
    return buildRegularGamePrediction({
      model: input.model,
      player: input.player,
      candidates: input.candidates,
      pitcher: input.pitcher,
      park: input.park,
      weather: input.weather,
      lineup_status: input.lineup_status,
      seed: input.seed,
      simulations: input.simulations,
      as_of: input.as_of,
    });
  }
  const { power_profile: profile, expected_pa, park, weather, starter_handedness, starter_hand, seed = 'cpc-hr-phase1', simulations = 400, lineup_status = 'confirmed' } = input;
  assertNoPriceFields({ profile, expected_pa, park, weather, starter_handedness, starter_hand, seed, simulations, lineup_status }, 'regular-game scenario input');
  const reasons = [];
  if (!profile || profile.status !== 'ready') reasons.push('shared_power_profile_blocked');
  if (!Number.isInteger(expected_pa) || expected_pa <= 0) reasons.push('expected_pa_missing_or_invalid');
  if (!park || typeof park !== 'object') reasons.push('park_missing');
  if (!weather || typeof weather !== 'object') reasons.push('weather_missing');
  if (!starter_handedness && !starter_hand) reasons.push('starter_handedness_missing');
  if (lineup_status !== 'confirmed') reasons.push('lineup_unconfirmed');
  const normalizedInputs = { expected_pa: expected_pa ?? null, park: park ?? null, weather: weather ?? null, starter_handedness: starter_handedness ?? starter_hand ?? null, lineup_status };
  if (reasons.length) return blocked(profile, reasons, normalizedInputs);
  const season = profile.features.hr_pa_by_window.season.hr_per_pa;
  if (!Number.isFinite(season)) return blocked(profile, ['shared_profile_season_hr_rate_missing'], normalizedInputs);
  return {
    schema_version: 'mlb_hr_regular_game_foundation_v1', status: 'ready', foundation_only: true,
    blocked_reasons: [], power_profile: profile, inputs: normalizedInputs,
    simulation: simulatePaOutcomes({ seed, plate_appearances: expected_pa, hr_probability: season, simulations }),
    uncertainty: profile.uncertainty, coverage: profile.coverage,
  };
}

export const buildRegularGameHrScenario = buildRegularGameScenario;
