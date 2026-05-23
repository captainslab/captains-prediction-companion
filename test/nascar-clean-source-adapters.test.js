// Tests for NASCAR Phase-1 clean-source adapters.
// All adapters are snapshot-first, no live network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { wikipediaTeamEquipmentEnvelope } from '../scripts/nascar/lib/source-adapters/wikipedia-team-equipment.mjs';
import { nascardataStrategyRiskEnvelope } from '../scripts/nascar/lib/source-adapters/nascardata-strategy.mjs';
import { derivedDriverSkillEnvelope } from '../scripts/nascar/lib/source-adapters/derived-driver-skill.mjs';
import { composeBaseFundamentals } from '../scripts/nascar/lib/base-fundamentals.mjs';
import { fixtureFundamentalsEnvelope } from '../scripts/nascar/lib/source-adapters/fundamentals-fixture.mjs';

test('Wikipedia team_equipment adapter loads snapshot and rates HMS at top', () => {
  const env = wikipediaTeamEquipmentEnvelope({ checked_at_utc: '2026-05-25T00:00:00.000Z' });
  assert.equal(env.layer, 'team_equipment');
  assert.ok(['ok', 'degraded'].includes(env.source_status));
  assert.ok(env.records.length >= 4);
  const hmsCar5 = env.records.find(r => r.car_number === 5);
  assert.ok(hmsCar5, 'expected HMS car #5 record');
  assert.ok(hmsCar5.team_equipment_quality >= 70, `HMS rating ${hmsCar5.team_equipment_quality} should be >= 70`);
  assert.equal(hmsCar5.manufacturer, 'Chevrolet');
  assert.equal(env.snapshot_license, 'CC-BY-SA-4.0');
});

test('nascaR.data strategy adapter rates Larson better (lower-risk) than Cody Ware', () => {
  const env = nascardataStrategyRiskEnvelope({ checked_at_utc: '2026-05-25T00:00:00.000Z' });
  assert.equal(env.layer, 'strategy_risk');
  // Always degraded — it's a 2024 proxy.
  assert.equal(env.source_status, 'degraded');
  const larson = env.records.find(r => r.driver_name === 'Kyle Larson');
  const ware = env.records.find(r => r.driver_name === 'Cody Ware');
  assert.ok(larson && ware);
  assert.ok(larson.strategy_risk_rating > ware.strategy_risk_rating,
    `Larson(${larson.strategy_risk_rating}) should beat Ware(${ware.strategy_risk_rating})`);
});

test('derived driver_skill is degraded and rates top drivers above tail', () => {
  const env = derivedDriverSkillEnvelope({ checked_at_utc: '2026-05-25T00:00:00.000Z' });
  assert.equal(env.layer, 'driver_skill');
  assert.equal(env.source_status, 'degraded');
  const larson = env.records.find(r => r.driver_name === 'Kyle Larson');
  const ware = env.records.find(r => r.driver_name === 'Cody Ware');
  assert.ok(larson.driver_skill_rating > ware.driver_skill_rating);
  assert.ok(larson.driver_ability_to_convert > ware.driver_ability_to_convert);
  // pit_crew sources are blocked — adapter must declare degraded reasons.
  assert.ok(env.degraded_reasons.includes('live_driver_skill_sources_blocked_by_anti_bot'));
});

test('clean adapters compose with pit_crew=unavailable → overall_data_quality=degraded, posture=WATCH', () => {
  const checked_at_utc = '2026-05-25T00:00:00.000Z';
  const strat = nascardataStrategyRiskEnvelope({ checked_at_utc });
  const team = wikipediaTeamEquipmentEnvelope({ checked_at_utc });
  const skill = derivedDriverSkillEnvelope({ checked_at_utc, strategyEnvelope: strat, teamEnvelope: team });
  const pit = fixtureFundamentalsEnvelope({ layer: 'pit_crew', status: 'unavailable', checked_at_utc });
  const fundamentals = composeBaseFundamentals({
    envelopes: { driver_skill: skill, team_equipment: team, pit_crew: pit, strategy_risk: strat },
  });
  assert.equal(fundamentals.overall_data_quality, 'partial',
    'pit_crew is non-critical; alone-unavailable yields partial, not degraded');
  assert.equal(fundamentals.allowed_max_posture, 'EVIDENCE_LEAN');
  // Real driver records should now flow through with non-null skill/equipment.
  const larson = fundamentals.by_driver.find(d => d.driver_name === 'Kyle Larson');
  assert.ok(larson, 'Larson should appear in by_driver');
  assert.equal(typeof larson.driver_skill_rating, 'number');
  assert.equal(typeof larson.team_equipment_quality, 'number');
  assert.equal(larson.pit_crew_crew_chief_grade, null);
});
