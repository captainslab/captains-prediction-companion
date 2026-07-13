// Deterministic 2026 Home Run Derby tournament model.
//
// This module is deliberately market-free. It consumes Statcast-shaped contact
// distributions, builds the shared CPC power profile, and then simulates the
// new open-round -> emergent-seeding -> bracket format with the repository's
// only PRNG.
import { assertNoPriceFields } from '../lib/projection-contracts.mjs';
import { buildPowerProfile } from './power-profile.mjs';
import { createSeededRng, seededNormal } from './monte-carlo.mjs';

export const DERBY_EVENT = Object.freeze({
  name: '2026 T-Mobile Home Run Derby',
  date: '2026-07-13',
  start_local: '2026-07-13T20:00:00-04:00',
  venue: 'Citizens Bank Park',
  city: 'Philadelphia',
});

export const DERBY_RULES = Object.freeze({
  participants: 8,
  rounds: 3,
  round_1_swings: 20,
  round_2_swings: 15,
  finals_swings: 15,
  clock: false,
  outs: false,
  bonus_time: false,
  hot_hand: true,
  round_1_qualifiers: 4,
  round_2_bracket: '1v4 / 2v3',
  round_2_tiebreak: 'successive 3-swing swing-offs',
});

// These are assumptions, not measurements. Keep them centralized and expose
// them in the assumptions ledger and customer packet.
export const DERBY_MODEL_ASSUMPTIONS = Object.freeze({
  bp_hr_probability_multiplier: 1.18,
  bp_contact_floor: 0.55,
  bp_exit_velocity_lift_mph: 2.5,
  distance_max_to_hr_mean_ft: 24,
  distance_pull_air_bonus_ft: 8,
  distance_ev_slope_ft_per_mph: 1.25,
  distance_standard_deviation_ft: 9,
  exit_velocity_standard_deviation_mph: 2.8,
  fatigue_hr_probability_decay_per_round: 0.045,
  fatigue_distance_decay_ft_per_round: 2,
  max_hot_hand_swings: 128,
  max_swingoff_rounds: 64,
  round_1_exact_distance_tie_fallback: 'alphabetical participant name',
  swingoff_hot_hand: 'not applied; rule is unverified for swing-offs',
});

const PARTICIPANT_NAMES = Object.freeze([
  ['Jac Caglianone', 'Kansas City Royals'],
  ['Junior Caminero', 'Tampa Bay Rays'],
  ['Willson Contreras', 'Boston Red Sox'],
  ['Bryce Harper', 'Philadelphia Phillies'],
  ['Munetaka Murakami', 'Chicago White Sox'],
  ['Ben Rice', 'New York Yankees'],
  ['Kyle Schwarber', 'Philadelphia Phillies'],
  ['Jordan Walker', 'St. Louis Cardinals'],
]);

const QUALITY_SET = new Set(['A', 'B', 'C', 'D', 'F']);
const PRICE_KEYS = new Set([
  'price', 'odds', 'bid', 'ask', 'vig', 'edge', 'kelly', 'stake', 'oi',
  'open_interest', 'volume', 'liquidity', 'yes_ask', 'no_ask', 'yes_bid',
  'no_bid', 'kalshi_ask', 'kalshi_bid', 'moneyline_odds', 'implied_prob',
  'market_prob', 'fair_value', 'line_movement', 'price_movement',
  'board_shape', 'spread_shape', 'last_price',
]);

function isPriceKey(key) {
  const lower = String(key).toLowerCase();
  return PRICE_KEYS.has(lower)
    || lower.includes('kalshi')
    || lower.includes('implied_prob')
    || lower.includes('market_prob')
    || lower.includes('fair_value')
    || lower.includes('price_movement')
    || lower.includes('line_movement')
    || lower.includes('board_shape')
    || lower.includes('spread_shape');
}

function withoutPriceFields(value) {
  if (Array.isArray(value)) return value.map(withoutPriceFields);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isPriceKey(key))
      .map(([key, child]) => [key, withoutPriceFields(child)]),
  );
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function qualityFor(participant) {
  if (participant.source_kind === 'FIXTURE') return 'F';
  return QUALITY_SET.has(participant.data_quality) ? participant.data_quality : 'F';
}

function participantLabel(participant) {
  return String(participant.name ?? participant.distribution?.player_name ?? '').trim();
}

function deriveParticipantModel(rawParticipant, asOf) {
  const participant = withoutPriceFields(rawParticipant ?? {});
  const name = participantLabel(participant);
  const team = String(participant.team ?? participant.distribution?.team_name ?? '').trim();
  if (!name) return { name: null, team: team || null, status: 'blocked', blocked_reasons: ['participant_name_missing'], profile: null };

  const profile = buildPowerProfile({
    distribution: participant.distribution ?? null,
    batter: {
      batter_id: participant.distribution?.batter_id ?? name,
      player_name: name,
      team_name: team || (participant.distribution?.team_name ?? null),
      stand: participant.distribution?.stand ?? participant.distribution?.hand ?? null,
    },
    as_of: asOf,
  });
  if (profile.status !== 'ready') {
    return {
      name,
      team: team || profile.batter.team_name || null,
      status: 'blocked',
      blocked_reasons: [...profile.blocked_reasons],
      profile,
    };
  }

  const season = profile.features.hr_bip_by_window.season;
  const ev = profile.features.ev_distribution;
  const distance = profile.features.distance_tail;
  const missing = [];
  if (!finite(season.hr_per_bip)) missing.push('season.hr_per_bip');
  if (!finite(profile.features.hard_hit_rate)) missing.push('hard_hit_rate');
  if (!finite(ev.mean)) missing.push('ev_distribution.mean');
  if (!finite(ev.p90)) missing.push('ev_distribution.p90');
  if (!finite(distance.max)) missing.push('distance_tail.max');
  if (!finite(profile.features.pull_air_rate)) missing.push('pull_air_rate');
  if (missing.length) {
    return {
      name,
      team: team || profile.batter.team_name || null,
      status: 'blocked',
      blocked_reasons: ['derby_required_profile_fields_missing', ...missing],
      profile,
    };
  }

  const hrProbability = clamp(
    season.hr_per_bip
      * DERBY_MODEL_ASSUMPTIONS.bp_hr_probability_multiplier
      * (DERBY_MODEL_ASSUMPTIONS.bp_contact_floor
        + ((1 - DERBY_MODEL_ASSUMPTIONS.bp_contact_floor) * profile.features.hard_hit_rate)),
    0,
    1,
  );
  const distanceMean = distance.max
    - DERBY_MODEL_ASSUMPTIONS.distance_max_to_hr_mean_ft
    + profile.features.pull_air_rate * DERBY_MODEL_ASSUMPTIONS.distance_pull_air_bonus_ft;
  return {
    name,
    team: team || profile.batter.team_name || null,
    status: 'ready',
    blocked_reasons: [],
    profile,
    source_kind: participant.source_kind ?? 'LIVE_STATCAST_SHAPED',
    data_quality: qualityFor(participant),
    hr_probability: hrProbability,
    distance_mean_ft: distanceMean,
    exit_velocity_mean_mph: ev.mean + DERBY_MODEL_ASSUMPTIONS.bp_exit_velocity_lift_mph,
    uncertainty: profile.uncertainty,
  };
}

function emptyCounter() {
  return Object.create(null);
}

function increment(counter, key, amount = 1) {
  const normalized = String(key);
  counter[normalized] = (counter[normalized] ?? 0) + amount;
}

function sortedEntries(counter) {
  return Object.fromEntries(Object.entries(counter).sort(([left], [right]) => {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) return leftNumber - rightNumber;
    return compareText(left, right);
  }));
}

function compareText(left, right) {
  return String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
}

function percentile95(count, total) {
  if (!total) return { low: 0, high: 0 };
  const p = count / total;
  const z = 1.96;
  const denominator = 1 + ((z * z) / total);
  const centre = (p + ((z * z) / (2 * total))) / denominator;
  const spread = (z / denominator) * Math.sqrt((p * (1 - p) / total) + (z * z / (4 * total * total)));
  return { low: clamp(centre - spread, 0, 1), high: clamp(centre + spread, 0, 1) };
}

function figure(probability, hits, simulations, dataQuality) {
  return {
    probability,
    uncertainty: {
      kind: 'simulation_sampling_95pct_wilson',
      interval: percentile95(hits, simulations),
    },
    data_quality: dataQuality,
  };
}

function figureMap(counter, simulations, dataQuality) {
  return Object.fromEntries(Object.entries(sortedEntries(counter)).map(([key, hits]) => [
    key,
    figure(hits / simulations, hits, simulations, dataQuality),
  ]));
}

export function compareDerbyRoundResults(left, right) {
  if (left.hr_count !== right.hr_count) return right.hr_count - left.hr_count;
  if (left.longest_distance_ft !== right.longest_distance_ft) return right.longest_distance_ft - left.longest_distance_ft;
  return compareText(left.name, right.name);
}

function simulateSwing(model, rng, state, roundIndex) {
  const exitVelocity = Math.max(0, seededNormal(
    rng,
    model.exit_velocity_mean_mph,
    DERBY_MODEL_ASSUMPTIONS.exit_velocity_standard_deviation_mph,
  ));
  if (exitVelocity > state.highest_exit_velocity_mph) {
    state.highest_exit_velocity_mph = exitVelocity;
    state.highest_exit_velocity_player = model.name;
  }
  const probability = clamp(
    model.hr_probability * (1 - (roundIndex * DERBY_MODEL_ASSUMPTIONS.fatigue_hr_probability_decay_per_round)),
    0,
    1,
  );
  const isHomeRun = rng() < probability;
  if (!isHomeRun) return { is_home_run: false, exit_velocity_mph: exitVelocity, distance_ft: null };
  const distanceMean = model.distance_mean_ft - (roundIndex * DERBY_MODEL_ASSUMPTIONS.fatigue_distance_decay_ft_per_round);
  const distance = Math.max(0, seededNormal(
    rng,
    distanceMean + ((exitVelocity - model.exit_velocity_mean_mph) * DERBY_MODEL_ASSUMPTIONS.distance_ev_slope_ft_per_mph),
    DERBY_MODEL_ASSUMPTIONS.distance_standard_deviation_ft,
  ));
  return { is_home_run: true, exit_velocity_mph: exitVelocity, distance_ft: distance };
}

function recordHomeRun(model, swing, state, { swingoff = false } = {}) {
  state.total_home_runs += 1;
  if (swingoff) state.swingoff_home_runs += 1;
  if (swing.distance_ft > state.longest_home_run_ft) {
    state.longest_home_run_ft = swing.distance_ft;
    state.longest_home_run_player = model.name;
  } else if (swing.distance_ft === state.longest_home_run_ft
    && compareText(model.name, state.longest_home_run_player) < 0) {
    state.longest_home_run_player = model.name;
  }
  if (swing.distance_ft >= 500) state.home_runs_500_plus += 1;
}

function simulateContestantRound(model, baseSwingLimit, rng, state, roundIndex, roundName) {
  const result = {
    name: model.name,
    hr_count: 0,
    longest_distance_ft: -Infinity,
    swings: 0,
    base_swings: baseSwingLimit,
    hot_hand_extensions: 0,
    cap_applied: false,
    round: roundName,
  };
  let lastWasHomeRun = false;
  while (result.swings < baseSwingLimit || (lastWasHomeRun && result.swings < DERBY_MODEL_ASSUMPTIONS.max_hot_hand_swings)) {
    const swing = simulateSwing(model, rng, state, roundIndex);
    result.swings += 1;
    if (result.swings > baseSwingLimit) result.hot_hand_extensions += 1;
    lastWasHomeRun = swing.is_home_run;
    if (swing.is_home_run) {
      result.hr_count += 1;
      result.longest_distance_ft = Math.max(result.longest_distance_ft, swing.distance_ft);
      recordHomeRun(model, swing, state);
    }
    if (result.swings >= DERBY_MODEL_ASSUMPTIONS.max_hot_hand_swings && lastWasHomeRun) {
      result.cap_applied = true;
      state.hot_hand_cap_events += 1;
      break;
    }
  }
  if (result.longest_distance_ft === -Infinity) result.longest_distance_ft = -1;
  return result;
}

function simulateSwingOff(left, right, rng, state, roundIndex, diagnostics) {
  for (let swingoffRound = 1; swingoffRound <= DERBY_MODEL_ASSUMPTIONS.max_swingoff_rounds; swingoffRound += 1) {
    let leftHrs = 0;
    let rightHrs = 0;
    for (let swing = 0; swing < 3; swing += 1) {
      const leftSwing = simulateSwing(left, rng, state, roundIndex);
      if (leftSwing.is_home_run) {
        leftHrs += 1;
        recordHomeRun(left, leftSwing, state, { swingoff: true });
      }
      const rightSwing = simulateSwing(right, rng, state, roundIndex);
      if (rightSwing.is_home_run) {
        rightHrs += 1;
        recordHomeRun(right, rightSwing, state, { swingoff: true });
      }
    }
    diagnostics.swingoff_rounds += 1;
    if (leftHrs !== rightHrs) return leftHrs > rightHrs ? left : right;
  }
  diagnostics.swingoff_cap_events += 1;
  return compareText(left.name, right.name) <= 0 ? left : right;
}

function simulateMatch(leftEntry, rightEntry, rng, state, roundIndex, roundName, swingLimit, diagnostics) {
  // "Lower seed" means the lower-ranked contestant (the higher seed number)
  // hits first. Seed identity always comes from the simulated Round 1.
  const hitOrder = leftEntry.seed > rightEntry.seed
    ? [leftEntry, rightEntry]
    : [rightEntry, leftEntry];
  const results = hitOrder.map(({ model }) => simulateContestantRound(
    model,
    swingLimit,
    rng,
    state,
    roundIndex,
    roundName,
  ));
  let winnerResult = results[0];
  let loserResult = results[1];
  if (results[1].hr_count > results[0].hr_count) {
    winnerResult = results[1];
    loserResult = results[0];
  } else if (results[1].hr_count === results[0].hr_count) {
    diagnostics[`${roundName}_pre_swingoff_ties`] += 1;
    const winnerModel = simulateSwingOff(hitOrder[0].model, hitOrder[1].model, rng, state, roundIndex, diagnostics);
    winnerResult = results.find((result) => result.name === winnerModel.name);
    loserResult = results.find((result) => result.name !== winnerModel.name);
  }
  return {
    matchup: [leftEntry.model.name, rightEntry.model.name],
    seeds: [leftEntry.seed, rightEntry.seed],
    hit_order: hitOrder.map(({ model }) => model.name),
    hit_order_seeds: hitOrder.map(({ seed }) => seed),
    winner: winnerResult.name,
    loser: loserResult.name,
    results,
  };
}

function createState() {
  return {
    total_home_runs: 0,
    longest_home_run_ft: -Infinity,
    longest_home_run_player: null,
    highest_exit_velocity_mph: -Infinity,
    highest_exit_velocity_player: null,
    home_runs_500_plus: 0,
    swingoff_home_runs: 0,
    hot_hand_cap_events: 0,
  };
}

function ensureParticipantCount(participants) {
  if (!Array.isArray(participants) || participants.length !== DERBY_RULES.participants) {
    throw new Error(`2026 Derby requires exactly ${DERBY_RULES.participants} participants`);
  }
  const names = participants.map((participant) => String(participant?.name ?? '').trim());
  if (names.some((name) => !name) || new Set(names).size !== DERBY_RULES.participants) {
    throw new Error('2026 Derby requires eight uniquely named participants');
  }
}

function runOneTournament(models, seed, simulationIndex) {
  const rng = createSeededRng(`${seed}:simulation:${simulationIndex}`);
  const state = createState();
  const diagnostics = {
    r1_exact_count_ties: 0,
    r1_exact_distance_ties: 0,
    round_2_pre_swingoff_ties: 0,
    finals_pre_swingoff_ties: 0,
    swingoff_rounds: 0,
    swingoff_cap_events: 0,
  };
  const round1 = models.map((model) => simulateContestantRound(model, DERBY_RULES.round_1_swings, rng, state, 0, 'round_1'));
  const countGroups = new Map();
  for (const result of round1) {
    const key = String(result.hr_count);
    countGroups.set(key, [...(countGroups.get(key) ?? []), result]);
  }
  for (const group of countGroups.values()) if (group.length > 1) diagnostics.r1_exact_count_ties += 1;
  const sortedRound1 = [...round1].sort(compareDerbyRoundResults);
  for (let i = 1; i < sortedRound1.length; i += 1) {
    const left = sortedRound1[i - 1];
    const right = sortedRound1[i];
    if (left.hr_count === right.hr_count && left.longest_distance_ft === right.longest_distance_ft) diagnostics.r1_exact_distance_ties += 1;
  }
  const qualifiers = sortedRound1.slice(0, DERBY_RULES.round_1_qualifiers);
  const seeds = qualifiers.map((result, index) => ({ seed: index + 1, name: result.name }));
  const seedModels = new Map(models.map((model) => [model.name, model]));
  const seededEntries = new Map(seeds.map(({ seed, name }) => [name, { seed, model: seedModels.get(name) }]));
  const bracket = [
    [seededEntries.get(seeds[0].name), seededEntries.get(seeds[3].name)],
    [seededEntries.get(seeds[1].name), seededEntries.get(seeds[2].name)],
  ];
  const round2 = bracket.map(([left, right]) => simulateMatch(
    left,
    right,
    rng,
    state,
    1,
    'round_2',
    DERBY_RULES.round_2_swings,
    diagnostics,
  ));
  const finalistEntries = [seededEntries.get(round2[0].winner), seededEntries.get(round2[1].winner)];
  const finals = simulateMatch(
    finalistEntries[0],
    finalistEntries[1],
    rng,
    state,
    2,
    'finals',
    DERBY_RULES.finals_swings,
    diagnostics,
  );
  return {
    round1,
    sorted_round1: sortedRound1,
    seeds,
    bracket: bracket.map(([left, right]) => ({
      matchup: [left.model.name, right.model.name],
      seeds: [left.seed, right.seed],
      hit_order: [right.model.name, left.model.name],
      hit_order_seeds: [right.seed, left.seed],
    })),
    round2,
    finalists: finalistEntries.map(({ model }) => model.name),
    finalist_seeds: finalistEntries.map(({ seed }) => seed),
    finals,
    winner: finals.winner,
    state,
    diagnostics,
  };
}

export function simulateDerbyTournament({ models, seed = 'cpc-hr-derby-phase3', simulation_index = 0 } = {}) {
  ensureParticipantCount(models);
  if (!Number.isInteger(simulation_index) || simulation_index < 0) throw new Error('simulation_index must be a non-negative integer');
  if (models.some((model) => model?.status !== 'ready')) throw new Error('all Derby participant models must be ready');
  return runOneTournament(models, String(seed), simulation_index);
}

function summarize(simulations, models, seed, generatedUtc, assumptions, blockedParticipants) {
  const total = simulations.length;
  const participantNames = models.map((model) => model.name);
  const winner = emptyCounter();
  const r1Leader = emptyCounter();
  const qualifiers = Object.fromEntries(participantNames.map((name) => [name, 0]));
  const r1Totals = Object.fromEntries(participantNames.map((name) => [name, emptyCounter()]));
  const finalMatchups = emptyCounter();
  const finalResults = emptyCounter();
  const totalHrs = emptyCounter();
  const longestPlayers = emptyCounter();
  const longestDistances = emptyCounter();
  const longestJoint = emptyCounter();
  const highestEvPlayers = emptyCounter();
  const highestEvs = emptyCounter();
  const highestEvJoint = emptyCounter();
  const fiveHundredPlus = emptyCounter();
  const deadHeats = {
    round_1_count_ties: 0,
    round_1_exact_distance_ties: 0,
    round_2_pre_swingoff_ties: 0,
    finals_pre_swingoff_ties: 0,
    swingoff_rounds: 0,
    swingoff_cap_events: 0,
    hot_hand_cap_events: 0,
  };
  for (const tournament of simulations) {
    increment(winner, tournament.winner);
    increment(r1Leader, tournament.sorted_round1[0].name);
    for (const result of tournament.round1) increment(r1Totals[result.name], result.hr_count);
    for (const qualifier of tournament.seeds) qualifiers[qualifier.name] += 1;
    const finalMatchup = [...tournament.finalists].sort(compareText).join(' vs ');
    increment(finalMatchups, finalMatchup);
    increment(finalResults, tournament.winner);
    increment(totalHrs, tournament.state.total_home_runs);
    increment(fiveHundredPlus, tournament.state.home_runs_500_plus);
    if (tournament.state.longest_home_run_player) {
      increment(longestPlayers, tournament.state.longest_home_run_player);
      increment(longestDistances, Math.round(tournament.state.longest_home_run_ft));
      increment(longestJoint, `${tournament.state.longest_home_run_player}|${Math.round(tournament.state.longest_home_run_ft)}`);
    } else {
      increment(longestPlayers, 'NO_HOME_RUN');
    }
    increment(highestEvPlayers, tournament.state.highest_exit_velocity_player ?? 'NO_CONTACT');
    increment(highestEvs, Math.round(tournament.state.highest_exit_velocity_mph));
    increment(highestEvJoint, `${tournament.state.highest_exit_velocity_player}|${Math.round(tournament.state.highest_exit_velocity_mph)}`);
    deadHeats.round_1_count_ties += tournament.diagnostics.r1_exact_count_ties;
    deadHeats.round_1_exact_distance_ties += tournament.diagnostics.r1_exact_distance_ties;
    deadHeats.round_2_pre_swingoff_ties += tournament.diagnostics.round_2_pre_swingoff_ties;
    deadHeats.finals_pre_swingoff_ties += tournament.diagnostics.finals_pre_swingoff_ties;
    deadHeats.swingoff_rounds += tournament.diagnostics.swingoff_rounds;
    deadHeats.swingoff_cap_events += tournament.diagnostics.swingoff_cap_events;
    deadHeats.hot_hand_cap_events += tournament.state.hot_hand_cap_events;
  }
  const quality = models.every((model) => model.data_quality === 'A') ? 'A' : models.some((model) => model.data_quality === 'F') ? 'F' : 'D';
  const out = {
    schema_version: 'mlb_hr_derby_projection_v1',
    event: DERBY_EVENT,
    format: DERBY_RULES,
    generated_utc: generatedUtc,
    seed,
    simulations: total,
    model_data_quality: quality,
    blocked_participants: blockedParticipants,
    participant_models: Object.fromEntries(models.map((model) => [model.name, {
      team: model.team,
      source_kind: model.source_kind,
      data_quality: model.data_quality,
      per_swing_hr_probability: model.hr_probability,
      distance_mean_ft: model.distance_mean_ft,
      exit_velocity_mean_mph: model.exit_velocity_mean_mph,
      uncertainty: model.uncertainty,
    }])),
    participant_profiles: Object.fromEntries(models.map((model) => [model.name, model.profile])),
    winner: { probabilities: figureMap(winner, total, quality) },
    round_1_leader: { probabilities: figureMap(r1Leader, total, quality) },
    round_1_hr_totals: Object.fromEntries(Object.entries(r1Totals).map(([name, counter]) => [name, { distribution: figureMap(counter, total, quality) }])),
    qualifiers: Object.fromEntries(Object.entries(qualifiers).map(([name, hits]) => [name, figure(hits / total, hits, total, quality)])),
    finals_matchup: { probabilities: figureMap(finalMatchups, total, quality) },
    finals_result: { probabilities: figureMap(finalResults, total, quality) },
    total_home_runs: { distribution: figureMap(totalHrs, total, quality) },
    longest_home_run: {
      player: figureMap(longestPlayers, total, quality),
      distance_ft: figureMap(longestDistances, total, quality),
      player_distance: figureMap(longestJoint, total, quality),
    },
    highest_exit_velocity: {
      player: figureMap(highestEvPlayers, total, quality),
      mph: figureMap(highestEvs, total, quality),
      player_mph: figureMap(highestEvJoint, total, quality),
    },
    home_runs_500_plus: { distribution: figureMap(fiveHundredPlus, total, quality) },
    dead_heats: deadHeats,
    hot_hand: {
      applied: true,
      explicit_cap: DERBY_MODEL_ASSUMPTIONS.max_hot_hand_swings,
      cap_events: deadHeats.hot_hand_cap_events,
      disclosure: 'The hot-hand continuation has an unbounded geometric tail; numerical safety caps at 128 total swings per contestant and logs every cap event.',
    },
    total_accounting: {
      includes_swingoff_home_runs: true,
      disclosure: 'Tournament total, longest-distance, highest-EV, and 500+ ft outputs include swing-off swings.',
    },
    assumptions: assumptions,
  };
  assertNoPriceFields(out, 'Derby projection output');
  return out;
}

export function buildDerbyParticipantModels({ participants, as_of = DERBY_EVENT.date } = {}) {
  ensureParticipantCount(participants);
  const models = participants.map((participant) => deriveParticipantModel(participant, as_of));
  return models;
}

export function buildDerbyProjection(input = {}) {
  const safeInput = withoutPriceFields(input);
  assertNoPriceFields(safeInput, 'Derby projection input');
  const participants = safeInput.participants;
  ensureParticipantCount(participants);
  const seed = String(safeInput.seed ?? 'cpc-hr-derby-phase3');
  const simulationsCount = safeInput.simulations ?? 4000;
  if (!Number.isInteger(simulationsCount) || simulationsCount <= 0) throw new Error('simulations must be a positive integer');
  const generatedUtc = safeInput.generated_utc ?? new Date().toISOString();
  const models = buildDerbyParticipantModels({ participants, as_of: safeInput.as_of ?? DERBY_EVENT.date });
  const blockedParticipants = models.filter((model) => model.status !== 'ready').map((model) => ({
    name: model.name,
    team: model.team,
    blocked_reasons: model.blocked_reasons,
  }));
  if (blockedParticipants.length) {
    return {
      schema_version: 'mlb_hr_derby_projection_v1',
      status: 'blocked',
      event: DERBY_EVENT,
      format: DERBY_RULES,
      generated_utc: generatedUtc,
      seed,
      simulations: simulationsCount,
      blocked_participants: blockedParticipants,
      participant_models: Object.fromEntries(models.map((model) => [model.name, {
        team: model.team,
        status: model.status,
        blocked_reasons: model.blocked_reasons,
        data_quality: model.data_quality ?? 'F',
      }])),
      participant_profiles: Object.fromEntries(models.map((model) => [model.name, model.profile])),
      simulation: null,
      assumptions: DERBY_MODEL_ASSUMPTIONS,
    };
  }
  const simulations = Array.from({ length: simulationsCount }, (_, index) => simulateDerbyTournament({
    models,
    seed,
    simulation_index: index,
  }));
  const projection = summarize(simulations, models, seed, generatedUtc, DERBY_MODEL_ASSUMPTIONS, []);
  projection.status = 'ready';
  projection.simulation = {
    tournament_count: simulationsCount,
    trace: simulations.slice(0, 3).map((simulation) => ({
      winner: simulation.winner,
      seeds: simulation.seeds,
      bracket: simulation.bracket,
      round_1: simulation.round1,
      round_2: simulation.round2,
      finalists: simulation.finalists,
      finalist_seeds: simulation.finalist_seeds,
      finals: simulation.finals,
      total_home_runs: simulation.state.total_home_runs,
      swingoff_home_runs: simulation.state.swingoff_home_runs,
    })),
  };
  return projection;
}

export function fixtureDerbyParticipants() {
  return PARTICIPANT_NAMES.map(([name, team], index) => ({
    name,
    team,
    source_kind: 'FIXTURE',
    data_quality: 'F',
    distribution: {
      // The fixture is intentionally the existing CPC fixture shape with
      // participant identity changed. It is never described as live data.
      batter_id: `fixture-${index + 1}`,
      player_name: name,
      team_name: team,
      stand: index % 2 === 0 ? 'L' : 'R',
      windows: {
        '7d': { pa: 8, bip: 8, hr: 1, hr_per_pa: 0.125, hr_per_bip: 0.125 },
        '30d': { pa: 12, bip: 12, hr: 2, hr_per_pa: 1 / 6, hr_per_bip: 1 / 6 },
        season: { pa: 12, bip: 12, hr: 2, hr_per_pa: 1 / 6, hr_per_bip: 1 / 6 },
      },
      latest_event_date: '2026-07-13',
      ev_distribution: { mean: 100.6666666667, p50: 101, p90: 105.8, max: 108 },
      launch_angle_distribution: { below_0: 0, '0_9': 1 / 6, '10_19': 1 / 3, '20_29': 1 / 3, '30_plus': 1 / 6 },
      spray_distribution: { pull: 5 / 12, center: 1 / 12, oppo: 6 / 12 },
      distance_tail: { max: 425, count_ge_400ft: 1 },
      rates: { barrel_rate: 0.75, hard_hit_rate: 11 / 12, sweet_spot_rate: 5 / 6, fly_ball_rate: 1, pull_air_rate: 0.25 },
      handedness_splits: {},
      pitch_family_splits: {},
      optional_bat_tracking: null,
    },
  }));
}

export { PARTICIPANT_NAMES };
