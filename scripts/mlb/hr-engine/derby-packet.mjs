// Customer packet and artifact builder for the deterministic 2026 Derby model.
// The TXT is rendered only from the projection JSON so parity is testable.
import { createHash } from 'node:crypto';
import { assertCpcPacketValid } from '../../packets/lib/cpc-packet-validator.mjs';
import { buildInventoryArtifact } from '../../shared/decision-packet.mjs';
import { buildScopedLedger } from '../lib/assumptions-ledger.mjs';
import {
  DERBY_EVENT,
  DERBY_MODEL_ASSUMPTIONS,
  DERBY_RULES,
  buildDerbyProjection,
  fixtureDerbyParticipants,
} from './derby-simulator.mjs';

const FORMAT_SOURCE = 'Wikipedia 2026 Home Run Derby article, reporting Harrigan/MLB.com (June 18, 2026); MLB.com was unavailable from this environment';

function number(value) {
  return Number.isFinite(Number(value)) ? String(value) : 'null';
}

function renderFigure(label, value) {
  const interval = value?.uncertainty?.interval ?? { low: null, high: null };
  return `${label}: probability=${number(value?.probability)} uncertainty_low=${number(interval.low)} uncertainty_high=${number(interval.high)} data_quality=${value?.data_quality ?? 'F'}`;
}

function renderFigureMap(title, values) {
  const lines = [`${title}:`];
  for (const [key, value] of Object.entries(values ?? {})) lines.push(`  - ${renderFigure(key, value)}`);
  if (lines.length === 1) lines.push('  - BLOCKED: no simulation figure available');
  return lines;
}

function assumptionsItems(generatedUtc) {
  const common = { scope: 'FULL_DAY_PREVIEW', checked_utc: generatedUtc };
  return [
    {
      ...common, type: 'derby_format', status: 'LOCKED', source_quality: 'B',
      basis: '2026 format is reported in the supplied event source.', source: FORMAT_SOURCE,
      value: DERBY_RULES,
    },
    {
      ...common, type: 'bp_power_transform', status: 'ASSUMED', source_quality: 'F',
      basis: 'No public Derby batting-practice/max-effort measurement exists; in-game Statcast is only a proxy.',
      source: 'Unmeasured model assumption; no fabricated BP source',
      value: {
        hr_probability_multiplier: DERBY_MODEL_ASSUMPTIONS.bp_hr_probability_multiplier,
        contact_floor: DERBY_MODEL_ASSUMPTIONS.bp_contact_floor,
        exit_velocity_lift_mph: DERBY_MODEL_ASSUMPTIONS.bp_exit_velocity_lift_mph,
      },
    },
    {
      ...common, type: 'fatigue_curve', status: 'ASSUMED', source_quality: 'F',
      basis: 'No public per-round Derby fatigue data exists.', source: 'Unmeasured model assumption; no fabricated fatigue source',
      value: {
        hr_probability_decay_per_round: DERBY_MODEL_ASSUMPTIONS.fatigue_hr_probability_decay_per_round,
        distance_decay_ft_per_round: DERBY_MODEL_ASSUMPTIONS.fatigue_distance_decay_ft_per_round,
      },
    },
    {
      ...common, type: 'distance_transform', status: 'ASSUMED', source_quality: 'F',
      basis: 'In-game distance/exit velocity are proxies for Derby ball flight.', source: 'Unmeasured model assumption; no fabricated BP source',
      value: {
        max_to_hr_mean_ft: DERBY_MODEL_ASSUMPTIONS.distance_max_to_hr_mean_ft,
        pull_air_bonus_ft: DERBY_MODEL_ASSUMPTIONS.distance_pull_air_bonus_ft,
        ev_slope_ft_per_mph: DERBY_MODEL_ASSUMPTIONS.distance_ev_slope_ft_per_mph,
        standard_deviation_ft: DERBY_MODEL_ASSUMPTIONS.distance_standard_deviation_ft,
        exit_velocity_standard_deviation_mph: DERBY_MODEL_ASSUMPTIONS.exit_velocity_standard_deviation_mph,
      },
    },
    {
      ...common, type: 'round_1_exact_distance_tie', status: 'ASSUMED', source_quality: 'F',
      basis: 'The supplied 2026 rules do not specify a fallback when longest-HR distances are also equal.',
      source: 'Unverified rule gap; deterministic alphabetical fallback', value: DERBY_MODEL_ASSUMPTIONS.round_1_exact_distance_tie_fallback,
    },
    {
      ...common, type: 'round_1_swingoff_fallback', status: 'ASSUMED', source_quality: 'F',
      basis: 'The supplied 2026 rules do not specify a Round-1 fallback beyond longest-HR distance.',
      source: 'Unverified rule gap; alphabetical fallback if still tied', value: 'alphabetical participant name',
    },
    {
      ...common, type: 'swingoff_hot_hand', status: 'ASSUMED', source_quality: 'F',
      basis: 'The supplied 2026 rules do not say whether hot-hand applies during a 3-swing swing-off.',
      source: 'Unverified rule gap; hot-hand not applied in swing-offs', value: DERBY_MODEL_ASSUMPTIONS.swingoff_hot_hand,
    },
    {
      ...common, type: 'timeout_survival', status: 'UNKNOWN', source_quality: 'F',
      basis: 'The supplied rules do not specify whether any timeout survives.', source: 'Unverified rule gap', value: 'UNKNOWN',
    },
    {
      ...common, type: 'hot_hand_numerical_cap', status: 'ASSUMED', source_quality: 'F',
      basis: 'The hot-hand tail is unbounded; a numerical safety cap is required and every cap event is logged.',
      source: 'Model safety assumption; not an event rule', value: DERBY_MODEL_ASSUMPTIONS.max_hot_hand_swings,
    },
    {
      ...common, type: 'swingoff_output_accounting', status: 'ASSUMED', source_quality: 'F',
      basis: 'The supplied rules do not define market-specific accounting for swing-off home runs.',
      source: 'Model output convention; swing-off swings included in tournament aggregates',
      value: 'include swing-off HR, distance, exit velocity, and 500+ ft results',
    },
  ];
}

function renderReadyPacket(projection) {
  const lines = [
    `CPC Packet: ${projection.event.name}${projection.model_data_quality === 'F' ? ' — FIXTURE MODE' : ''}`,
    `date: ${projection.event.date}`,
    `venue: ${projection.event.venue}, ${projection.event.city}`,
    `generated_utc: ${projection.generated_utc}`,
    `seed: ${projection.seed}`,
    `simulations: ${projection.simulations}`,
    `data_quality: ${projection.model_data_quality}`,
    `sources: ${FORMAT_SOURCE}`,
    '',
    'EVENT FORMAT',
    `  participants=${projection.format.participants} rounds=${projection.format.rounds} clock=NONE outs=NONE bonus_time=NONE`,
    `  round_1=${projection.format.round_1_swings} swings open round; top ${projection.format.round_1_qualifiers} advance by HR total then longest-HR distance`,
    `  round_2=${projection.format.round_2_swings} swings seeded ${projection.format.round_2_bracket}; finals=${projection.format.finals_swings} swings`,
    '  hot-hand: a home run on the final swing continues the contestant until a miss.',
    '',
    'DATA AND MODEL HONESTY',
    '  Derby power is proxied from in-game Statcast contact-quality distributions.',
    '  Batting-practice/max-effort power, per-round fatigue, and BP-pitcher quality are assumptions, not measurements.',
    `  This packet is ${projection.model_data_quality === 'F' ? 'FIXTURE MODE: participant inputs are clearly labeled fixtures, not live 2026 Statcast data.' : 'based on supplied participant inputs; verify current source freshness before publication.'}`,
    '',
    'MARKET CONTEXT — NOT IN SCORE',
    '  No market price, odds, bid, ask, volume, open interest, or price movement entered the model.',
    '',
    'WINNER',
    ...renderFigureMap('winner probabilities', projection.winner.probabilities),
    '',
    'ROUND 1',
    ...renderFigureMap('round_1_leader probabilities', projection.round_1_leader.probabilities),
  ];
  lines.push('round_1_hr_totals:');
  for (const [name, result] of Object.entries(projection.round_1_hr_totals)) {
    lines.push(`  ${name}:`);
    lines.push(...renderFigureMap('distribution', result.distribution).map((line) => `    ${line}`));
  }
  lines.push('qualifiers:');
  for (const [name, value] of Object.entries(projection.qualifiers)) lines.push(`  - ${renderFigure(name, value)}`);
  lines.push('', 'EMERGENT SEEDING AND BRACKET', '  Seeds are derived independently from each simulated Round 1; no seeds were preassigned.');
  lines.push('  bracket: seed 1 vs seed 4; seed 2 vs seed 3; lower-ranked seed (higher seed number) hits first.');
  lines.push(...renderFigureMap('finals matchup probabilities', projection.finals_matchup.probabilities));
  lines.push(...renderFigureMap('finals result probabilities', projection.finals_result.probabilities));
  lines.push('', 'TOURNAMENT TOTALS');
  lines.push(...renderFigureMap('total HRs distribution', projection.total_home_runs.distribution));
  lines.push(...renderFigureMap('500+ ft HR count distribution', projection.home_runs_500_plus.distribution));
  lines.push('', 'LONGEST HOME RUN');
  lines.push(...renderFigureMap('player', projection.longest_home_run.player));
  lines.push(...renderFigureMap('distance_ft', projection.longest_home_run.distance_ft));
  lines.push(...renderFigureMap('player_distance', projection.longest_home_run.player_distance));
  lines.push('', 'HIGHEST EXIT VELOCITY');
  lines.push(...renderFigureMap('player', projection.highest_exit_velocity.player));
  lines.push(...renderFigureMap('mph', projection.highest_exit_velocity.mph));
  lines.push(...renderFigureMap('player_mph', projection.highest_exit_velocity.player_mph));
  lines.push('', 'DEAD HEATS AND SAFETY DISCLOSURES');
  for (const [key, value] of Object.entries(projection.dead_heats)) lines.push(`  ${key}: ${value}`);
  lines.push(`  hot_hand_cap_events: ${projection.hot_hand.cap_events}`);
  lines.push(`  hot_hand_cap: ${projection.hot_hand.explicit_cap} total swings per contestant; cap events are logged and disclosed.`);
  lines.push(`  total_accounting: ${projection.total_accounting.disclosure}`);
  lines.push('', 'ASSUMPTIONS / UNVERIFIED RULE GAPS');
  for (const item of projection.assumptions) lines.push(`  - ${item.type}: status=${item.status} quality=${item.source_quality}; ${item.basis}`);
  lines.push('', '---', 'No trades placed by this workflow.', 'No bankroll advice. No order placement. Research only.');
  return lines.join('\n');
}

function renderBlockedPacket(projection) {
  const lines = [
    `CPC Packet: ${projection.event.name} — BLOCKED`,
    `date: ${projection.event.date}`,
    `venue: ${projection.event.venue}, ${projection.event.city}`,
    `generated_utc: ${projection.generated_utc}`,
    `seed: ${projection.seed}`,
    `simulations_requested: ${projection.simulations}`,
    `sources: ${FORMAT_SOURCE}`,
    '',
    'BLOCKED — NO IMPUTED PROBABILITIES',
    '  Required participant contact-quality data is missing or failed the profile quality gate.',
    ...projection.blocked_participants.map((participant) => `  - ${participant.name ?? 'unknown'}: ${participant.blocked_reasons.join(', ')}`),
    '',
    'DATA AND MODEL HONESTY',
    '  Derby power would be proxied from in-game Statcast; BP/max-effort power and fatigue are assumptions, not measurements.',
    '',
    'MARKET CONTEXT — NOT IN SCORE',
    '  No market data was used.',
    '',
    '---', 'No trades placed by this workflow.', 'No bankroll advice. No order placement. Research only.',
  ];
  return lines.join('\n');
}

export function renderDerbyPacket(projection) {
  const text = projection.status === 'blocked' ? renderBlockedPacket(projection) : renderReadyPacket(projection);
  assertCpcPacketValid(text, '2026 Home Run Derby packet');
  return text;
}

export function buildHomeRunDerbyPacket(input = {}) {
  const projection = buildDerbyProjection(input);
  const generatedUtc = projection.generated_utc;
  const ledger = buildScopedLedger({
    scope: 'FULL_DAY_PREVIEW',
    date: DERBY_EVENT.date,
    items: assumptionsItems(generatedUtc),
    now: () => generatedUtc,
  });
  const projectionWithLedger = {
    ...projection,
    assumptions: ledger.items,
  };
  const packetText = renderDerbyPacket(projectionWithLedger);
  const inventoryText = buildInventoryArtifact({
    marketType: 'mlb_hr_derby',
    date: DERBY_EVENT.date,
    eventTicker: 'NONE',
    inventoryLines: Object.entries(projection.participant_models ?? {}).map(([name, model]) => `  - ${name}: status=${model.status ?? 'ready'} data_quality=${model.data_quality ?? 'F'}`),
    meta: { source_mode: projection.model_data_quality === 'F' ? 'FIXTURE' : 'SUPPLIED_INPUTS', price_isolation: 'true' },
  });
  const audit = {
    schema_version: 'mlb_hr_derby_audit_v1',
    generated_utc: generatedUtc,
    seed: projection.seed,
    simulations: projection.simulations,
    packet_sha256: createHash('sha256').update(packetText).digest('hex'),
    projection_sha256: createHash('sha256').update(JSON.stringify(projectionWithLedger)).digest('hex'),
    price_isolation: 'assertNoPriceFields passed on model input and output',
    json_txt_parity: 'packet rendered exclusively from projections JSON values',
    raw_inventory_location: 'audit-only artifact; not in customer packet',
  };
  return {
    projection: projectionWithLedger,
    packetText,
    participantProfiles: projection.participant_profiles ?? {},
    simulationSummary: projection.simulation,
    assumptionsLedger: ledger,
    inventoryText,
    audit,
  };
}

export function buildFixtureHomeRunDerbyPacket(options = {}) {
  return buildHomeRunDerbyPacket({
    participants: fixtureDerbyParticipants(),
    seed: options.seed ?? 'cpc-hr-derby-phase3-fixture',
    simulations: options.simulations ?? 4000,
    as_of: options.as_of ?? DERBY_EVENT.date,
    generated_utc: options.generated_utc ?? '2026-07-13T00:00:00.000Z',
  });
}
