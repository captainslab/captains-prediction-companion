import test from 'node:test';
import assert from 'node:assert/strict';

import {
  composeStorylineModifier,
  scoreStoryline,
  computeTrueWinModifier,
  computeMarketRepricingScore,
  classifyDuration,
  detectBeneficiary,
} from '../scripts/nascar/lib/storyline-modifier.mjs';

const eventContext = {
  race_name: 'Test 400',
  track: 'Test Speedway',
  track_type: 'intermediate',
  event_format: 'points',
};

function acuteTributeStoryline(overrides = {}) {
  return {
    storyline_id: 'sl_test_001',
    storyline_type: 'tragedy_tribute',
    summary: 'Tribute weekend honoring fallen team member',
    emotional_strength: 100,
    direct_connection: 100,
    timing_proximity_days: 0,
    track_relevance: 70,
    team_car_relevance: 80,
    broadcast_public_attention: 90,
    distraction_pressure_risk: 20,
    sources: ['fixture://news/1'],
    ...overrides,
  };
}

function strongBase(overrides = {}) {
  return {
    driver_id: 'd1',
    driver_name: 'Strong Driver',
    car_number: 8,
    equipment_quality: 85,
    driver_ability_to_convert: 80,
    base_win_probability: 0.07,
    overpricing_penalty: 10,
    ...overrides,
  };
}

function weakBase(overrides = {}) {
  return {
    driver_id: 'd2',
    driver_name: 'Backmarker',
    car_number: 77,
    equipment_quality: 40,
    driver_ability_to_convert: 40,
    base_win_probability: 0.005,
    overpricing_penalty: 15,
    ...overrides,
  };
}

test('acute direct tribute yields high storyline score', () => {
  const out = composeStorylineModifier({
    storyline: acuteTributeStoryline(),
    baseFundamentals: strongBase(),
    eventContext,
  });
  assert.equal(out.schema_version, 'nascar_storyline_modifier_v1');
  assert.equal(out.duration_class, 'short');
  assert.ok(
    out.storyline_score >= 75,
    `expected >=75, got ${out.storyline_score}`,
  );
});

test('storyline alone with weak base yields no true_win_modifier and only WATCH/MARKET_REPRICING_ALERT hint', () => {
  const out = composeStorylineModifier({
    storyline: acuteTributeStoryline(),
    baseFundamentals: weakBase(),
    eventContext,
  });
  assert.equal(out.true_win_modifier.applied, false);
  assert.equal(out.true_win_modifier.delta_probability, 0);
  assert.ok(
    ['WATCH', 'MARKET_REPRICING_ALERT'].includes(out.posture_hint),
    `expected WATCH or MARKET_REPRICING_ALERT, got ${out.posture_hint}`,
  );
});

test('strong base + high storyline yields modest positive delta_probability capped at 0.04', () => {
  const out = composeStorylineModifier({
    storyline: acuteTributeStoryline(),
    baseFundamentals: strongBase(),
    eventContext,
  });
  assert.equal(out.true_win_modifier.applied, true);
  assert.ok(out.true_win_modifier.delta_probability > 0);
  assert.ok(
    out.true_win_modifier.delta_probability <= 0.04,
    `expected delta <= 0.04, got ${out.true_win_modifier.delta_probability}`,
  );
  assert.equal(out.true_win_modifier.capped_at, 0.04);
});

test('market_repricing_score can be high while true_win_modifier delta is 0', () => {
  const out = composeStorylineModifier({
    storyline: acuteTributeStoryline({ broadcast_public_attention: 95 }),
    baseFundamentals: weakBase(),
    eventContext,
  });
  assert.equal(out.true_win_modifier.delta_probability, 0);
  assert.ok(
    out.market_repricing_score >= 60,
    `expected mrs>=60, got ${out.market_repricing_score}`,
  );
});

test('long storyline (track_dominance) decays slower than short storyline at 30 days out', () => {
  const common = {
    storyline_id: 'sl_decay',
    summary: 'decay test',
    emotional_strength: 70,
    direct_connection: 70,
    timing_proximity_days: 30,
    track_relevance: 80,
    team_car_relevance: 80,
    broadcast_public_attention: 60,
    distraction_pressure_risk: 10,
    sources: [],
  };
  const longS = { ...common, storyline_type: 'track_dominance' };
  const shortS = { ...common, storyline_type: 'tragedy_tribute' };
  const longScored = scoreStoryline(longS, strongBase());
  const shortScored = scoreStoryline(shortS, strongBase());
  assert.equal(longScored.duration_class, 'long');
  assert.equal(shortScored.duration_class, 'short');
  assert.ok(
    longScored.timing_decay > shortScored.timing_decay,
    `long decay ${longScored.timing_decay} should exceed short ${shortScored.timing_decay}`,
  );
  assert.ok(
    longScored.score > shortScored.score,
    `long score ${longScored.score} should exceed short ${shortScored.score} at 30d`,
  );
});

test('detectBeneficiary identifies direct_replacement for Austin Hill into RCR No. 8', () => {
  const storyline = {
    storyline_id: 'sl_rcr8',
    storyline_type: 'replacement_driver',
    summary: 'Austin Hill replaces injured driver in RCR No. 8 this weekend',
  };
  const driver = {
    driver_id: 'ah',
    driver_name: 'Austin Hill',
    team: 'RCR',
    car_number: 8,
    manufacturer: 'Chevrolet',
  };
  const teamGraph = {
    replacement_for: 'Kyle Busch',
    honoree: {
      name: 'Kyle Busch',
      team: 'RCR',
      car_number: 8,
      manufacturer: 'Chevrolet',
    },
  };
  const r = detectBeneficiary(storyline, driver, teamGraph);
  assert.equal(r.connection_type, 'direct_replacement');
  assert.ok(r.evidence.length > 0);
});

test('detectBeneficiary identifies same_car_number link for #8 tribute decals', () => {
  const storyline = {
    storyline_id: 'sl_decals',
    storyline_type: 'tragedy_tribute',
    summary: 'Tribute decals on #8 honoring late mechanic',
  };
  const driver = {
    driver_id: 'kb',
    driver_name: 'Some Driver',
    team: 'OtherTeam',
    car_number: 8,
    manufacturer: 'Ford',
  };
  const teamGraph = {
    honoree: {
      name: 'Late Mechanic',
      team: 'RCR',
      car_number: 8,
      manufacturer: 'Chevrolet',
    },
  };
  const r = detectBeneficiary(storyline, driver, teamGraph);
  assert.equal(r.connection_type, 'same_car_number');
  assert.ok(r.evidence.some((e) => e.includes('#8')));
});

test('guardrails_applied contains storyline_does_not_create_speed disclaimer reference and posture never PICK/EVIDENCE_LEAN', () => {
  const forbidden = new Set([
    'PICK',
    'EVIDENCE_LEAN',
    'STRONG_EVIDENCE_LEAN',
  ]);
  const cases = [
    { s: acuteTributeStoryline(), b: strongBase() },
    { s: acuteTributeStoryline(), b: weakBase() },
    {
      s: acuteTributeStoryline({
        emotional_strength: 10,
        direct_connection: 10,
        broadcast_public_attention: 10,
        timing_proximity_days: 90,
      }),
      b: weakBase(),
    },
    {
      s: { ...acuteTributeStoryline(), storyline_type: 'track_dominance' },
      b: strongBase(),
    },
  ];
  for (const c of cases) {
    const out = composeStorylineModifier({
      storyline: c.s,
      baseFundamentals: c.b,
      eventContext,
    });
    assert.ok(
      out.guardrails_applied.includes('storyline_does_not_create_speed'),
      'missing guardrail reference',
    );
    assert.equal(out.disclaimer, 'Storyline does not create speed.');
    assert.ok(
      !forbidden.has(out.posture_hint),
      `posture_hint must not be PICK/EVIDENCE_LEAN, got ${out.posture_hint}`,
    );
  }
});

test('module is pure: same inputs => same outputs (deterministic)', () => {
  const s = acuteTributeStoryline();
  const b = strongBase();
  const a = composeStorylineModifier({
    storyline: s,
    baseFundamentals: b,
    eventContext,
  });
  const c = composeStorylineModifier({
    storyline: s,
    baseFundamentals: b,
    eventContext,
  });
  assert.deepEqual(a, c);
});

test('helpers: classifyDuration, computeMarketRepricingScore, computeTrueWinModifier sanity', () => {
  assert.equal(classifyDuration('tragedy_tribute'), 'short');
  assert.equal(classifyDuration('track_dominance'), 'long');
  const mrs = computeMarketRepricingScore({
    broadcast_public_attention: 100,
    emotional_strength: 100,
    direct_connection: 100,
    overpricing_penalty: 0,
  });
  assert.ok(mrs >= 99);
  const twm = computeTrueWinModifier(50, {
    equipment_quality: 90,
    driver_ability_to_convert: 80,
  });
  assert.equal(twm.applied, false);
  assert.equal(twm.delta_probability, 0);
});
