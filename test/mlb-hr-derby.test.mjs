import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateCpcCustomerPacket } from '../scripts/packets/lib/cpc-packet-validator.mjs';
import {
  DERBY_MODEL_ASSUMPTIONS,
  DERBY_RULES,
  buildDerbyParticipantModels,
  buildDerbyProjection,
  compareDerbyRoundResults,
  fixtureDerbyParticipants,
  simulateDerbyTournament,
} from '../scripts/mlb/hr-engine/derby-simulator.mjs';
import {
  buildFixtureHomeRunDerbyPacket,
  buildHomeRunDerbyPacket,
  renderDerbyPacket,
} from '../scripts/mlb/hr-engine/derby-packet.mjs';

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
      distribution: { ...participant.distribution, bid: 0.75, ask: 0.79, open_interest: 9000 },
    })),
    market: { title: 'fixture market', price: 0.77, odds: -125, volume: 50000 },
    seed: 'derby-neutrality-proof',
    simulations: 180,
    generated_utc: GENERATED_UTC,
  });
  assert.deepEqual(mutated, clean);
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
