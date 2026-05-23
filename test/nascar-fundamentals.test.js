// Tests for NASCAR base fundamentals adapters + composer + storyline gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fixtureFundamentalsEnvelope,
  FUNDAMENTAL_LAYERS,
} from '../scripts/nascar/lib/source-adapters/fundamentals-fixture.mjs';
import {
  composeBaseFundamentals,
  fundamentalsForStoryline,
} from '../scripts/nascar/lib/base-fundamentals.mjs';
import { composeStorylineModifier } from '../scripts/nascar/lib/storyline-modifier.mjs';
import { cocaCola600StorylineFixture } from '../scripts/nascar/lib/storyline-fixtures.mjs';

function envelopesAll(status) {
  const out = {};
  for (const layer of FUNDAMENTAL_LAYERS) {
    out[layer] = fixtureFundamentalsEnvelope({ layer, status });
  }
  return out;
}

test('all 4 fundamentals layers normalize correctly when ok', () => {
  const envelopes = envelopesAll('ok');
  for (const layer of FUNDAMENTAL_LAYERS) {
    const env = envelopes[layer];
    assert.equal(env.source_status, 'ok');
    assert.ok(env.records.length > 0, `${layer} should have records`);
    assert.ok(Array.isArray(env.source_urls) && env.source_urls.length > 0);
    assert.ok(Array.isArray(env.source_notes));
  }
  const fundamentals = composeBaseFundamentals({ envelopes });
  assert.equal(fundamentals.overall_data_quality, 'ok');
  assert.equal(fundamentals.allowed_max_posture, 'EVIDENCE_LEAN');
  assert.ok(fundamentals.by_driver.length > 0);
  for (const d of fundamentals.by_driver) {
    assert.equal(typeof d.driver_skill_rating, 'number');
    assert.equal(typeof d.team_equipment_quality, 'number');
    assert.equal(typeof d.pit_crew_crew_chief_grade, 'number');
    assert.equal(typeof d.strategy_risk_rating, 'number');
  }
});

test('missing layers downgrade rather than fake data', () => {
  const envelopes = {
    driver_skill: fixtureFundamentalsEnvelope({ layer: 'driver_skill', status: 'ok' }),
    team_equipment: fixtureFundamentalsEnvelope({ layer: 'team_equipment', status: 'degraded' }),
    pit_crew: fixtureFundamentalsEnvelope({ layer: 'pit_crew', status: 'unavailable' }),
    strategy_risk: fixtureFundamentalsEnvelope({ layer: 'strategy_risk', status: 'unavailable' }),
  };
  assert.equal(envelopes.pit_crew.records.length, 0, 'unavailable layer must emit zero records');
  assert.ok(envelopes.pit_crew.unavailable_reasons.length > 0);
  const fundamentals = composeBaseFundamentals({ envelopes });
  assert.equal(fundamentals.overall_data_quality, 'degraded');
  assert.equal(fundamentals.allowed_max_posture, 'WATCH');
  assert.ok(
    fundamentals.downgrade_reasons.some(r => r.startsWith('pit_crew')),
    'downgrade reasons must mention pit_crew',
  );
  // No driver record should claim a pit-crew or strategy-risk grade since
  // the layers are unavailable.
  for (const d of fundamentals.by_driver) {
    assert.equal(d.pit_crew_crew_chief_grade, null);
    assert.equal(d.strategy_risk_rating, null);
  }
});

test('storyline alone cannot create PICK / EVIDENCE_LEAN', () => {
  const storyline = cocaCola600StorylineFixture();
  const modifier = composeStorylineModifier({
    storyline,
    baseFundamentals: {
      equipment_quality: 30,
      driver_ability_to_convert: 30,
      overpricing_penalty: 0,
    },
    eventContext: { race_name: 'Coca-Cola 600' },
  });
  assert.notEqual(modifier.posture_hint, 'PICK');
  assert.notEqual(modifier.posture_hint, 'EVIDENCE_LEAN');
  assert.equal(modifier.true_win_modifier.applied, false);
  assert.equal(modifier.true_win_modifier.delta_probability, 0);
});

test('positive true_win_modifier requires equipment_quality>=60, driver_ability>=55, storyline_score>=60', () => {
  const storyline = cocaCola600StorylineFixture();

  // Weak equipment fails.
  const weakEq = composeStorylineModifier({
    storyline,
    baseFundamentals: { equipment_quality: 55, driver_ability_to_convert: 70, overpricing_penalty: 0 },
    eventContext: {},
  });
  assert.equal(weakEq.true_win_modifier.applied, false);

  // Weak driver fails.
  const weakDac = composeStorylineModifier({
    storyline,
    baseFundamentals: { equipment_quality: 80, driver_ability_to_convert: 50, overpricing_penalty: 0 },
    eventContext: {},
  });
  assert.equal(weakDac.true_win_modifier.applied, false);

  // All gates pass — should produce a positive (but capped) delta.
  const strong = composeStorylineModifier({
    storyline,
    baseFundamentals: { equipment_quality: 85, driver_ability_to_convert: 80, overpricing_penalty: 0 },
    eventContext: {},
  });
  assert.ok(strong.storyline_score >= 60, `storyline_score ${strong.storyline_score} < 60`);
  assert.equal(strong.true_win_modifier.applied, true);
  assert.ok(strong.true_win_modifier.delta_probability > 0);
  assert.ok(strong.true_win_modifier.delta_probability <= 0.04 + 1e-9);
});

test('market_repricing_score can be high while true_win_modifier remains 0', () => {
  const storyline = cocaCola600StorylineFixture();
  const modifier = composeStorylineModifier({
    storyline,
    baseFundamentals: { equipment_quality: 20, driver_ability_to_convert: 20, overpricing_penalty: 0 },
    eventContext: {},
  });
  assert.equal(modifier.true_win_modifier.delta_probability, 0);
  assert.ok(
    modifier.market_repricing_score >= 60,
    `expected high market_repricing_score, got ${modifier.market_repricing_score}`,
  );
});

test('fundamentalsForStoryline caps placeholder data so gate cannot pass on degraded layers', () => {
  const envelopes = envelopesAll('degraded');
  const fundamentals = composeBaseFundamentals({ envelopes });
  const driverEntry = fundamentals.by_driver[0];
  const forGate = fundamentalsForStoryline(driverEntry);
  // Even if a placeholder rating happened to be 70 it should be capped
  // below the gate when overall data quality < ok.
  assert.ok(forGate.equipment_quality <= 55);
  assert.ok(forGate.driver_ability_to_convert <= 50);
});
