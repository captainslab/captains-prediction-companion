import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCpcCustomerPacket } from '../scripts/packets/lib/cpc-packet-validator.mjs';
import {
  DERBY_MODEL_ASSUMPTIONS,
  DERBY_RULES,
  DERBY_SENSITIVITY_SCENARIOS,
  buildDerbyParticipantModels,
  buildDerbyProjection,
  compareDerbyRoundResults,
  extractRobustDerbyConclusions,
  fixtureDerbyParticipants,
  simulateDerbyTournament,
} from '../scripts/mlb/hr-engine/derby-simulator.mjs';
import {
  buildFixtureHomeRunDerbyPacket,
  buildHomeRunDerbyPacket,
  buildDerbyPublicView,
  renderDerbyPacket,
} from '../scripts/mlb/hr-engine/derby-packet.mjs';
import { generateDerbyArtifacts } from '../scripts/mlb/hr-engine/generate-derby.mjs';

const GENERATED_UTC = '2026-07-13T00:00:00.000Z';

function directModels(hrProbability) {
  return fixtureDerbyParticipants().map((participant, index) => ({
    name: participant.name,
    team: participant.team,
    status: 'ready',
    hr_probability: hrProbability,
    distance_mean_ft: 410 + index,
    exit_velocity_mean_mph: 101 + index / 10,
  }));
}

function participantsAtQuality(quality) {
  return fixtureDerbyParticipants().map((participant) => ({
    ...participant,
    source_kind: `TEST_SUPPLIED_${quality}`,
    data_quality: quality,
  }));
}

function assumptionSupportAt(quality) {
  return Object.fromEntries([
    'bp_power_transform',
    'fatigue_curve',
    'distance_transform',
    'rule_coverage',
  ].map((domain) => [domain, {
    source_quality: quality,
    status: 'PROJECTED',
    support_kind: 'SYNTHETIC_TEST_FIXTURE',
    basis: `Synthetic quality-${quality} ${domain} support for publication-policy tests; not historical Derby calibration evidence.`,
    source: 'Deterministic test/mlb-hr-derby.test.mjs fixture',
  }]));
}

let cachedQualityD = null;
let cachedQualityB = null;

function qualityDPacket() {
  cachedQualityD ??= buildHomeRunDerbyPacket({
    participants: participantsAtQuality('D'),
    seed: 'derby-quality-d-proof',
    simulations: 240,
    generated_utc: GENERATED_UTC,
  });
  return cachedQualityD;
}

function qualityBPacket() {
  cachedQualityB ??= buildHomeRunDerbyPacket({
    participants: participantsAtQuality('B'),
    assumption_support: assumptionSupportAt('B'),
    seed: 'derby-quality-b-proof',
    simulations: 240,
    generated_utc: GENERATED_UTC,
  });
  return cachedQualityB;
}

function probabilities(values) {
  return Object.fromEntries(Object.entries(values).map(([candidate, probability]) => [candidate, { probability }]));
}

function robustScenario(values) {
  const figures = probabilities(values);
  return {
    winner: { probabilities: figures },
    qualifiers: figures,
    round_1_leader: { probabilities: figures },
    longest_home_run: { player: figures },
    highest_exit_velocity: { player: figures },
    finals_matchup: { probabilities: figures },
  };
}

test('2026 Derby format is exactly 20/15/15 with no clock, outs, or bonus time', () => {
  assert.deepEqual(
    [DERBY_RULES.round_1_swings, DERBY_RULES.round_2_swings, DERBY_RULES.finals_swings],
    [20, 15, 15],
  );
  assert.equal(DERBY_RULES.clock, false);
  assert.equal(DERBY_RULES.outs, false);
  assert.equal(DERBY_RULES.bonus_time, false);
  assert.equal(DERBY_RULES.hot_hand, true);
});

test('participant evidence is transformed through the shared power-profile contract', () => {
  const models = buildDerbyParticipantModels({ participants: fixtureDerbyParticipants() });
  assert.equal(models.length, 8);
  for (const model of models) {
    assert.equal(model.status, 'ready');
    assert.equal(model.profile.schema_version, 'mlb_hr_feature_profile_v1');
    assert.equal(model.profile.status, 'ready');
    assert.ok(Number.isFinite(model.hr_probability));
  }
});

test('Round 1 derives top-four seeds, builds 1v4 and 2v3, and lower-ranked seeds hit first', () => {
  const tournament = simulateDerbyTournament({
    models: directModels(0),
    seed: 'derby-bracket-proof',
  });
  assert.equal(tournament.seeds.length, 4);
  assert.deepEqual(
    tournament.seeds.map(({ name }) => name),
    tournament.sorted_round1.slice(0, 4).map(({ name }) => name),
  );
  assert.deepEqual(tournament.bracket.map(({ seeds }) => seeds), [[1, 4], [2, 3]]);
  assert.deepEqual(tournament.bracket.map(({ hit_order_seeds }) => hit_order_seeds), [[4, 1], [3, 2]]);
  assert.deepEqual(tournament.round2.map(({ hit_order_seeds }) => hit_order_seeds), [[4, 1], [3, 2]]);
  assert.ok(tournament.finals.hit_order_seeds[0] > tournament.finals.hit_order_seeds[1]);
  assert.ok(tournament.round1.every((result) => result.base_swings === 20 && result.swings === 20));
  assert.ok(tournament.round2.flatMap((match) => match.results).every((result) => result.base_swings === 15 && result.swings === 15));
  assert.ok(tournament.finals.results.every((result) => result.base_swings === 15 && result.swings === 15));
});

test('Round-1 ties use longest home run, then deterministic name fallback', () => {
  const rows = [
    { name: 'Bravo', hr_count: 7, longest_distance_ft: 440 },
    { name: 'Charlie', hr_count: 8, longest_distance_ft: 420 },
    { name: 'Alpha', hr_count: 7, longest_distance_ft: 440 },
    { name: 'Delta', hr_count: 7, longest_distance_ft: 450 },
  ];
  assert.deepEqual(
    rows.sort(compareDerbyRoundResults).map(({ name }) => name),
    ['Charlie', 'Delta', 'Alpha', 'Bravo'],
  );
});

test('a home run on the final allowed swing triggers the explicit hot-hand tail', () => {
  const tournament = simulateDerbyTournament({
    models: directModels(1),
    seed: 'derby-hot-hand-proof',
  });
  assert.ok(tournament.round1.every((result) => result.swings === DERBY_MODEL_ASSUMPTIONS.max_hot_hand_swings));
  assert.ok(tournament.round1.every((result) => result.hot_hand_extensions === DERBY_MODEL_ASSUMPTIONS.max_hot_hand_swings - 20));
  assert.ok(tournament.round1.every((result) => result.cap_applied));
  assert.ok(tournament.state.hot_hand_cap_events >= 8);
});

test('missing participant evidence blocks the event without imputed probabilities', () => {
  const participants = fixtureDerbyParticipants();
  participants[3] = { ...participants[3], distribution: null };
  const projection = buildDerbyProjection({
    participants,
    seed: 'derby-block-proof',
    simulations: 25,
    generated_utc: GENERATED_UTC,
  });
  assert.equal(projection.status, 'blocked');
  assert.equal(projection.simulation, null);
  assert.equal('winner' in projection, false);
  assert.equal(projection.blocked_participants.some(({ name }) => name === 'Bryce Harper'), true);
  const packet = buildHomeRunDerbyPacket({
    participants,
    seed: 'derby-block-proof',
    simulations: 25,
    generated_utc: GENERATED_UTC,
  });
  assert.match(packet.packetText, /BLOCKED — NO IMPUTED PROBABILITIES/);
  assert.equal(validateCpcCustomerPacket(packet.packetText).valid, true);
});

test('fixed seed and injected clock make projection, packet, and audit byte-deterministic', () => {
  const options = {
    seed: 'derby-determinism-proof',
    simulations: 240,
    generated_utc: GENERATED_UTC,
  };
  const first = buildFixtureHomeRunDerbyPacket(options);
  const second = buildFixtureHomeRunDerbyPacket(options);
  assert.deepEqual(second, first);
  assert.equal(second.packetText, first.packetText);
  assert.equal(renderDerbyPacket(first.projection), first.packetText);
  assert.equal(validateCpcCustomerPacket(first.packetText).valid, true);
  assert.equal(first.projection.status, 'ready');
  assert.equal(Object.keys(first.projection.winner.probabilities).length, 8);
  assert.ok(first.projection.round_1_leader);
  assert.ok(first.projection.round_1_hr_totals);
  assert.ok(first.projection.qualifiers);
  assert.ok(first.projection.finals_matchup);
  assert.ok(first.projection.finals_result);
  assert.ok(first.projection.total_home_runs);
  assert.ok(first.projection.longest_home_run);
  assert.ok(first.projection.highest_exit_velocity);
  assert.ok(first.projection.home_runs_500_plus);
});

test('quality D publishes scenario-stable relative rankings and broad tiers', () => {
  const packet = qualityDPacket();
  assert.equal(packet.projection.model_data_quality, 'D');
  assert.equal(packet.projection.publication_eligibility.fields.relative_rankings.status, 'eligible');
  assert.equal(packet.projection.publication_eligibility.fields.broad_tiers.status, 'eligible');
  assert.equal(packet.projection.publication_eligibility.fields.exact_winner_probabilities.status, 'experimental_only');
  assert.equal(packet.publicView.exact_outcomes.winner, null);
  assert.ok(packet.publicView.robust_conclusions);
  assert.match(packet.packetText, /ROBUST CONCLUSIONS — STABLE ACROSS/);
  assert.match(packet.packetText, /EXPERIMENTAL scenario band|NO STABLE TOP TIER/);
  for (const conclusion of Object.values(packet.publicView.robust_conclusions.conclusions)) {
    assert.ok(conclusion.stable_top_tier.every((entry) => entry.stable_across_all_scenarios));
  }
  for (const name of ['Munetaka Murakami', 'Kyle Schwarber']) {
    const published = Object.values(packet.publicView.robust_conclusions.conclusions)
      .flatMap((conclusion) => conclusion.stable_top_tier)
      .find((entry) => entry.candidate === name);
    if (published) assert.equal(published.stable_across_all_scenarios, true);
  }
});

test('quality D suppresses exact Round 1 and tournament HR-total distributions', () => {
  const packet = qualityDPacket();
  assert.equal(packet.publicView.exact_distributions.round_1_hr_totals, null);
  assert.equal(packet.publicView.exact_distributions.tournament_total_home_runs, null);
  assert.equal(packet.publicView.exact_distributions.home_runs_500_plus, null);
  assert.doesNotMatch(packet.packetText, /^round_1_hr_totals:/m);
  assert.doesNotMatch(packet.packetText, /^total HRs distribution:/m);
  assert.doesNotMatch(packet.packetText, /^500\+ ft HR count distribution:/m);
  assert.match(packet.packetText, /Exact tournament HR totals: UNCALIBRATED/);
  assert.match(packet.packetText, /500\+ foot probabilities: UNCALIBRATED/);
});

test('quality D suppresses per-foot distance distributions', () => {
  const packet = qualityDPacket();
  assert.equal(packet.publicView.exact_distributions.longest_hr_distance_ft, null);
  assert.equal(packet.publicView.exact_distributions.longest_hr_player_distance, null);
  assert.doesNotMatch(packet.packetText, /^distance_ft:/m);
  assert.doesNotMatch(packet.packetText, /^player_distance:/m);
  assert.match(packet.packetText, /Per-foot distance distributions: UNCALIBRATED/);
});

test('quality D suppresses exact exit-velocity distributions', () => {
  const packet = qualityDPacket();
  assert.equal(packet.publicView.exact_distributions.highest_ev_mph, null);
  assert.equal(packet.publicView.exact_distributions.highest_ev_player_mph, null);
  assert.doesNotMatch(packet.packetText, /^mph:/m);
  assert.doesNotMatch(packet.packetText, /^player_mph:/m);
  assert.match(packet.packetText, /Exact exit-velocity distributions: UNCALIBRATED/);
});

test('quality C permits exact outcome probabilities but retains B-only suppression', () => {
  const packet = buildHomeRunDerbyPacket({
    participants: participantsAtQuality('C'),
    assumption_support: assumptionSupportAt('C'),
    seed: 'derby-quality-c-proof',
    simulations: 120,
    generated_utc: GENERATED_UTC,
  });
  assert.equal(packet.projection.model_data_quality, 'C');
  assert.ok(packet.publicView.exact_outcomes.winner);
  assert.match(packet.packetText, /^winner probabilities:/m);
  assert.equal(packet.publicView.exact_distributions.round_1_hr_totals, null);
  assert.doesNotMatch(packet.packetText, /^round_1_hr_totals:/m);
});

test('quality B permits exact HR, distance, 500+, and exit-velocity outputs', () => {
  const packet = qualityBPacket();
  assert.equal(packet.projection.model_data_quality, 'B');
  for (const field of [
    'exact_winner_probabilities',
    'exact_outcome_probabilities',
    'exact_round_hr_distributions',
    'exact_tournament_totals',
    'per_foot_distance_distributions',
    'five_hundred_plus_probabilities',
    'exact_ev_distributions',
  ]) {
    assert.equal(packet.projection.publication_eligibility.fields[field].status, 'eligible');
  }
  assert.match(packet.packetText, /^winner probabilities:/m);
  assert.match(packet.packetText, /^round_1_hr_totals:/m);
  assert.match(packet.packetText, /^total HRs distribution:/m);
  assert.match(packet.packetText, /^500\+ ft HR count distribution:/m);
  assert.match(packet.packetText, /^distance_ft:/m);
  assert.match(packet.packetText, /^mph:/m);
  assert.match(packet.packetText, /BP power transform quality=B; fatigue curve quality=B; distance transform quality=B; rule coverage quality=B/);
  const ledgerByType = Object.fromEntries(packet.assumptionsLedger.items.map((item) => [item.type, item]));
  assert.equal(ledgerByType.bp_power_transform.source_quality, 'B');
  assert.equal(ledgerByType.fatigue_curve.source_quality, 'B');
  assert.equal(ledgerByType.distance_transform.source_quality, 'B');
  assert.equal(ledgerByType.round_1_exact_distance_tie.source_quality, 'B');
  assert.equal(ledgerByType.timeout_survival.source_quality, 'B');
  assert.equal(ledgerByType.timeout_survival.status, 'PROJECTED');
  assert.equal(ledgerByType.bp_power_transform.supports_evidence, true);
  assert.match(ledgerByType.bp_power_transform.basis, /Synthetic quality-B/);
  assert.match(packet.packetText, /bp_power_transform:SYNTHETIC_TEST_FIXTURE/);
  assert.ok(packet.packetText.split('\n').length <= 250, 'quality-B public packet should use compact display rows');
  assert.match(packet.packetText, /additional eligible bins retained in public-view\.json/);
  assert.equal(validateCpcCustomerPacket(packet.packetText).valid, true);
});

test('participant quality alone cannot promote F-quality assumptions to exact publication', () => {
  const packet = buildHomeRunDerbyPacket({
    participants: participantsAtQuality('B'),
    seed: 'derby-participant-only-quality-proof',
    simulations: 120,
    generated_utc: GENERATED_UTC,
  });
  assert.equal(packet.projection.model_data_quality, 'B');
  assert.equal(packet.projection.quality_metadata.overall_assumption_support_quality, 'F');
  for (const field of [
    'exact_winner_probabilities',
    'exact_round_hr_distributions',
    'exact_tournament_totals',
    'per_foot_distance_distributions',
    'five_hundred_plus_probabilities',
    'exact_ev_distributions',
  ]) assert.notEqual(packet.projection.publication_eligibility.fields[field].status, 'eligible');
  assert.match(packet.packetText, /BP power transform quality=F/);
  assert.doesNotMatch(packet.packetText, /^winner probabilities:/m);
  assert.doesNotMatch(packet.packetText, /^round_1_hr_totals:/m);
});

test('bare assumption quality labels cannot promote unsupported exact outputs', () => {
  assert.throws(() => buildDerbyProjection({
    participants: participantsAtQuality('B'),
    assumption_quality: {
      bp_power_transform: 'B',
      fatigue_curve: 'B',
      distance_transform: 'B',
      rule_coverage: 'B',
    },
    seed: 'derby-bare-assumption-quality',
    simulations: 10,
    generated_utc: GENERATED_UTC,
  }), /cannot unlock Derby publication/);
});

test('Monte Carlo sampling uncertainty and model-assumption uncertainty remain distinct', () => {
  const packet = qualityDPacket();
  const figure = Object.values(packet.projection.winner.probabilities)[0];
  assert.equal(figure.sampling_uncertainty.kind, 'monte_carlo_sampling_95pct_wilson');
  assert.equal(figure.sampling_uncertainty.scope, 'finite simulation sampling error only');
  assert.equal(figure.model_uncertainty.kind, 'cross_scenario_assumption_range');
  assert.equal(figure.model_uncertainty.calibration_status, 'UNCALIBRATED');
  assert.equal(figure.model_uncertainty.is_confidence_interval, false);
  assert.notDeepEqual(figure.sampling_uncertainty.interval, figure.model_uncertainty.interval);
  assert.equal(packet.projection.uncertainty.model_assumption.is_confidence_interval, false);
  assert.match(packet.packetText, /Monte Carlo sampling uncertainty/);
  assert.match(packet.packetText, /Model\/assumption uncertainty/);
  assert.match(packet.packetText, /not confidence intervals or total calibrated uncertainty/);
});

test('all three sensitivity scenarios run deterministically from one fixed seed', () => {
  assert.deepEqual(DERBY_SENSITIVITY_SCENARIOS.map(({ id }) => id), ['conservative', 'base', 'aggressive']);
  assert.ok(DERBY_SENSITIVITY_SCENARIOS.every((scenario) => scenario.calibration_status === 'UNCALIBRATED_STRESS_CASE'));
  const options = {
    participants: participantsAtQuality('D'),
    seed: 'derby-sensitivity-determinism',
    simulations: 160,
    generated_utc: GENERATED_UTC,
  };
  const first = buildDerbyProjection(options);
  const second = buildDerbyProjection(options);
  assert.deepEqual(second.sensitivity, first.sensitivity);
  assert.deepEqual(second.robust_conclusions, first.robust_conclusions);
  assert.deepEqual(Object.keys(first.sensitivity.outputs), ['conservative', 'base', 'aggressive']);
  assert.equal(first.sensitivity.shared_seed_across_scenarios, true);
  assert.equal(first.sensitivity.common_random_numbers, false);
  for (const output of Object.values(first.sensitivity.outputs)) {
    assert.equal(output.seed, options.seed);
    assert.equal(output.simulations, options.simulations);
  }
  assert.notDeepEqual(
    first.sensitivity.outputs.conservative.participant_models,
    first.sensitivity.outputs.aggressive.participant_models,
  );
  assert.notDeepEqual(
    first.sensitivity.outputs.conservative.total_home_runs,
    first.sensitivity.outputs.aggressive.total_home_runs,
  );
  assert.match(first.sensitivity.documentation, /not historical calibration estimates/);
});

test('robust conclusions exclude candidates that cross tiers between scenarios', () => {
  const scenarios = {
    conservative: robustScenario({ Alpha: 0.40, Bravo: 0.30, Charlie: 0.20, Delta: 0.10 }),
    base: robustScenario({ Alpha: 0.40, Charlie: 0.30, Bravo: 0.20, Delta: 0.10 }),
    aggressive: robustScenario({ Delta: 0.40, Alpha: 0.30, Bravo: 0.20, Charlie: 0.10 }),
  };
  const robust = extractRobustDerbyConclusions(scenarios, 'D');
  assert.deepEqual(
    robust.conclusions.winner_tier.stable_top_tier.map(({ candidate }) => candidate),
    ['Alpha'],
  );
  assert.equal(
    robust.conclusions.winner_tier.unstable_entries.some(({ candidate }) => candidate === 'Bravo'),
    true,
  );
  assert.match(robust.publication_rule, /every sensitivity scenario/);
});

test('robust conclusion ranking is tie-aware and never creates alphabetical top tiers', () => {
  const equal = robustScenario({ Alpha: 0.25, Bravo: 0.25, Charlie: 0.25, Delta: 0.25 });
  const robust = extractRobustDerbyConclusions({
    conservative: equal,
    base: equal,
    aggressive: equal,
  }, 'D');
  const conclusion = robust.conclusions.winner_tier;
  assert.deepEqual(conclusion.stable_top_tier, []);
  for (const entry of conclusion.unstable_entries) {
    assert.equal(entry.scenarios.conservative.rank, 1);
    assert.equal(entry.tier_stable_across_all_scenarios, true);
    assert.equal(entry.sampling_separated_across_all_scenarios, false);
  }
  assert.equal(conclusion.scenario_top_tier_evidence.base.top_tier_cardinality, 4);
  assert.equal(conclusion.scenario_top_tier_evidence.base.top_tier_sampling_separated, false);
});

test('named players do not publish as robust merely because one scenario ranks them highly', () => {
  const scenarios = {
    conservative: robustScenario({ 'Munetaka Murakami': 0.40, 'Kyle Schwarber': 0.30, Alpha: 0.20, Bravo: 0.10 }),
    base: robustScenario({ Alpha: 0.40, Bravo: 0.30, 'Munetaka Murakami': 0.20, 'Kyle Schwarber': 0.10 }),
    aggressive: robustScenario({ Bravo: 0.40, Alpha: 0.30, 'Kyle Schwarber': 0.20, 'Munetaka Murakami': 0.10 }),
  };
  const robust = extractRobustDerbyConclusions(scenarios, 'D');
  const published = robust.conclusions.winner_tier.stable_top_tier.map(({ candidate }) => candidate);
  assert.doesNotMatch(published.join('\n'), /Murakami|Schwarber/);
  const rendererSource = readFileSync(new URL('../scripts/mlb/hr-engine/derby-packet.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(rendererSource, /Murakami|Schwarber/);
});

test('internal artifact retains raw distributions, diagnostics, assumptions, quality, and sensitivities', () => {
  const packet = qualityDPacket();
  const internal = packet.internalArtifact;
  assert.equal(internal.product, 'INTERNAL_RESEARCH_ARTIFACT');
  assert.equal(internal.reproducibility.seed, 'derby-quality-d-proof');
  assert.equal(internal.reproducibility.simulations_per_scenario, 240);
  assert.deepEqual(internal.reproducibility.sensitivity_scenarios, ['conservative', 'base', 'aggressive']);
  assert.ok(internal.raw_distributions.round_1_hr_totals);
  assert.ok(internal.raw_distributions.total_home_runs);
  assert.ok(internal.raw_distributions.longest_home_run.distance_ft);
  assert.ok(internal.raw_distributions.highest_exit_velocity.mph);
  assert.ok(internal.raw_distributions.home_runs_500_plus);
  assert.ok(Number.isInteger(Object.values(internal.raw_distributions.winner.probabilities)[0].hits));
  assert.ok(internal.assumptions.length > 0);
  assert.ok(internal.rule_gaps.length > 0);
  assert.ok(internal.diagnostics.dead_heats_and_swingoffs);
  assert.ok(Array.isArray(internal.diagnostics.cap_event_logs.hot_hand));
  assert.ok(Array.isArray(internal.diagnostics.cap_event_logs.swingoff));
  assert.deepEqual(Object.keys(internal.sensitivity.outputs), ['conservative', 'base', 'aggressive']);
  assert.ok(internal.sensitivity.outputs.conservative.total_home_runs.distribution);
});

test('quality-D public artifact remains concise, readable, and free of raw exact rows', () => {
  const packet = qualityDPacket();
  const lines = packet.packetText.split('\n');
  const publicJson = JSON.stringify(packet.publicView);
  assert.ok(lines.length <= 90, `quality-D public packet grew to ${lines.length} lines`);
  assert.ok(Math.max(...lines.map((line) => line.length)) <= 260);
  assert.doesNotMatch(packet.packetText, /probability=/);
  assert.doesNotMatch(packet.packetText, /monte_carlo_95pct_low=/);
  assert.doesNotMatch(publicJson, /"(?:probability|hits|sampling_uncertainty|model_uncertainty)":/);
  assert.match(packet.packetText, /In-game Statcast contact quality is a proxy for Derby batting-practice power/);
  assert.match(packet.packetText, /MARKET CONTEXT — NOT IN SCORE/);
  assert.match(packet.packetText, /No trades placed by this workflow/);
  assert.match(packet.packetText, /No bankroll advice/);
  assert.match(packet.packetText, /Research only/);
  assert.equal(renderDerbyPacket(buildDerbyPublicView(packet.projection)), packet.packetText);
});

test('quality-D validator permits only labeled experimental winner probabilities, never B-only sections', () => {
  const packet = qualityDPacket();
  for (const marker of [
    'winner probabilities:',
    'round_1_hr_totals:',
    'total HRs distribution:',
    '500+ ft HR count distribution:',
    'distance_ft:',
    'mph:',
  ]) {
    const rejected = validateCpcCustomerPacket(`${packet.packetText}\n${marker}`);
    assert.equal(rejected.valid, false, `${marker} should fail quality-D validation`);
    assert.ok(rejected.errors.some((error) => /EXPERIMENTAL section label|suppressed below threshold|outside an eligible/i.test(error)));
  }
  const labeledWinner = `${packet.packetText}\nwinner probabilities — EXPERIMENTAL:`;
  assert.equal(validateCpcCustomerPacket(labeledWinner).valid, true);
  const labeledTotal = `${packet.packetText}\ntotal HRs distribution — UNCALIBRATED:`;
  assert.equal(validateCpcCustomerPacket(labeledTotal).valid, false);
});

test('offline generator accepts a supplied quality-D input file and writes both product artifacts', () => {
  const root = mkdtempSync(join(tmpdir(), 'cpc-derby-generator-'));
  const inputFile = join(root, 'input.json');
  const outputDir = join(root, 'artifacts');
  try {
    writeFileSync(inputFile, `${JSON.stringify({ participants: participantsAtQuality('D') })}\n`, 'utf8');
    const result = generateDerbyArtifacts({
      outputDir,
      inputFile,
      seed: 'derby-generator-quality-d',
      simulations: 60,
      generatedUtc: GENERATED_UTC,
    });
    assert.equal(result.inputMode, 'SUPPLIED_INPUT');
    assert.equal(result.packet.projection.model_data_quality, 'D');
    assert.equal(JSON.parse(readFileSync(join(outputDir, 'public-view.json'), 'utf8')).product, 'PUBLIC_CAPTAIN_PACKET');
    const internal = JSON.parse(readFileSync(join(outputDir, 'internal-research.json'), 'utf8'));
    assert.equal(internal.product, 'INTERNAL_RESEARCH_ARTIFACT');
    assert.ok(internal.raw_distributions.total_home_runs);
    assert.doesNotMatch(readFileSync(join(outputDir, 'packet.txt'), 'utf8'), /^total HRs distribution:/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Derby model, renderer, and offline generator have no delivery dependency', () => {
  const source = [
    '../scripts/mlb/hr-engine/derby-simulator.mjs',
    '../scripts/mlb/hr-engine/derby-packet.mjs',
    '../scripts/mlb/hr-engine/generate-derby.mjs',
  ].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(source, /_send-due|send-packets-telegram|telegram|discord|webhook/i);
  assert.doesNotMatch(source, /process\.env|node:child_process|\bfetch\s*\(/);
  assert.equal(qualityDPacket().audit.delivery_invoked, false);
});

test('market mutations cannot change model output, ordering, packet text, or audit hashes', () => {
  const participants = fixtureDerbyParticipants();
  const clean = buildHomeRunDerbyPacket({
    participants,
    seed: 'derby-neutrality-proof',
    simulations: 180,
    generated_utc: GENERATED_UTC,
  });
  const mutated = buildHomeRunDerbyPacket({
    participants: participants.map((participant) => ({
      ...participant,
      market_price: 0.77,
      odds: -125,
      volume: 50000,
      market_movement: 0.08,
      distribution: {
        ...participant.distribution,
        bid: 0.75,
        ask: 0.79,
        open_interest: 9000,
        market_price: 0.77,
        movement: 0.08,
        price_movement: 0.08,
        line_movement: 0.08,
      },
    })),
    market: {
      title: 'fixture market',
      price: 0.77,
      odds: -125,
      bid: 0.75,
      ask: 0.79,
      volume: 50000,
      oi: 9000,
      open_interest: 9000,
      movement: 0.08,
      ranking: 1,
      score: 99,
      posture: 'TRADE_YES',
    },
    seed: 'derby-neutrality-proof',
    simulations: 180,
    generated_utc: GENERATED_UTC,
  });
  assert.deepEqual(mutated, clean);
  assert.deepEqual(mutated.projection.publication_eligibility, clean.projection.publication_eligibility);
  assert.deepEqual(mutated.projection.robust_conclusions, clean.projection.robust_conclusions);
  assert.deepEqual(mutated.internalArtifact.sensitivity, clean.internalArtifact.sensitivity);
  assert.equal('posture' in mutated.projection, false);
});

test('BP, fatigue, distance, tie, and accounting assumptions are ledgered and disclosed', () => {
  const packet = buildFixtureHomeRunDerbyPacket({
    seed: 'derby-ledger-proof',
    simulations: 20,
    generated_utc: GENERATED_UTC,
  });
  const byType = Object.fromEntries(packet.assumptionsLedger.items.map((item) => [item.type, item]));
  for (const type of ['bp_power_transform', 'fatigue_curve', 'distance_transform', 'round_1_exact_distance_tie', 'swingoff_hot_hand', 'hot_hand_numerical_cap', 'swingoff_output_accounting']) {
    assert.equal(byType[type].status, 'ASSUMED');
    assert.equal(byType[type].source_quality, 'F');
  }
  assert.equal(byType.derby_format.status, 'LOCKED');
  assert.equal(byType.derby_format.source_quality, 'A');
  assert.equal(byType.bp_power_transform.value.contact_floor, DERBY_MODEL_ASSUMPTIONS.bp_contact_floor);
  assert.equal(byType.fatigue_curve.value.distance_decay_ft_per_round, DERBY_MODEL_ASSUMPTIONS.fatigue_distance_decay_ft_per_round);
  assert.match(packet.packetText, /BP-pitcher quality are assumptions, not measurements/);
  assert.match(packet.packetText, /FIXTURE MODE/);
  assert.match(packet.packetText, /participant_input_sources: FIXTURE/);
  assert.match(packet.packetText, /MLB\.com: "Changes coming to 2026 Home Run Derby"/);
  assert.doesNotMatch(packet.packetText, /MLB\.com was unavailable/);
});

test('Derby simulator uses only the shared seeded Monte Carlo module and never Math.random', () => {
  const source = readFileSync(new URL('../scripts/mlb/hr-engine/derby-simulator.mjs', import.meta.url), 'utf8');
  assert.match(source, /from '.\/monte-carlo\.mjs'/);
  assert.doesNotMatch(source, /Math\.random/);
});
