#!/usr/bin/env node
import { fixtureBaseballSavantDistributionEnvelope } from '../source-adapters/baseball-savant-distributions.mjs';
import { buildPowerProfile } from './power-profile.mjs';
import { buildRegularGameScenario } from './regular-game-scenario.mjs';
import { buildDerbyScenario } from './derby-scenario.mjs';

const source = fixtureBaseballSavantDistributionEnvelope({ runDate: '2026-05-15', checkedAtUtc: '2026-05-15T14:00:00.000Z' });
const distribution = source.records[0];
const sharedProfile = buildPowerProfile({
  distribution,
  as_of: '2026-05-15T14:00:00.000Z',
  environment: { park: 'fixture-park', weather: 'fixture-weather', roof: 'open', altitude: 20, wall_direction: 'standard' },
});
const regular = buildRegularGameScenario({
  power_profile: sharedProfile,
  expected_pa: 4,
  park: { id: 'fixture-park' },
  weather: { status: 'complete' },
  starter_handedness: 'R',
  seed: 'cpc-hr-phase1',
  simulations: 64,
});
const derby = buildDerbyScenario({
  power_profile: sharedProfile,
  rounds: 3,
  timer_seconds: 180,
  swing_count: 45,
  fatigue: 0.1,
  seed: 'cpc-hr-phase1',
  simulations: 64,
});

console.log(JSON.stringify({
  shared_profile_reused: regular.power_profile === sharedProfile && derby.power_profile === sharedProfile,
  shared_profile_schema: sharedProfile.schema_version,
  shared_profile_status: sharedProfile.status,
  regular_game: regular,
  derby,
}, null, 2));
