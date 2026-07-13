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

// These are deliberately wide, configurable stress cases for model-assumption
// sensitivity. They are not fitted to, or represented as, historical Derby
// calibration. The base case preserves the original Phase 3 assumptions.
export const DERBY_SENSITIVITY_SCENARIOS = Object.freeze([
  Object.freeze({
    id: 'conservative',
    label: 'Conservative conversion',
    calibration_status: 'UNCALIBRATED_STRESS_CASE',
    description: 'Lower BP conversion and power lift with stronger fatigue and shorter assumed flight.',
    parameters: Object.freeze({
      bp_hr_probability_multiplier: 0.90,
      bp_contact_floor: 0.45,
      bp_exit_velocity_lift_mph: 0,
      distance_max_to_hr_mean_ft: 38,
      distance_pull_air_bonus_ft: 4,
      distance_ev_slope_ft_per_mph: 1,
      distance_standard_deviation_ft: 12,
      exit_velocity_standard_deviation_mph: 2,
      fatigue_hr_probability_decay_per_round: 0.08,
      fatigue_distance_decay_ft_per_round: 4,
    }),
  }),
  Object.freeze({
    id: 'base',
    label: 'Base conversion',
    calibration_status: 'UNCALIBRATED_STRESS_CASE',
    description: 'Original Phase 3 conversion assumptions; retained as a reference case, not a calibrated estimate.',
    parameters: Object.freeze({
      bp_hr_probability_multiplier: DERBY_MODEL_ASSUMPTIONS.bp_hr_probability_multiplier,
      bp_contact_floor: DERBY_MODEL_ASSUMPTIONS.bp_contact_floor,
      bp_exit_velocity_lift_mph: DERBY_MODEL_ASSUMPTIONS.bp_exit_velocity_lift_mph,
      distance_max_to_hr_mean_ft: DERBY_MODEL_ASSUMPTIONS.distance_max_to_hr_mean_ft,
      distance_pull_air_bonus_ft: DERBY_MODEL_ASSUMPTIONS.distance_pull_air_bonus_ft,
      distance_ev_slope_ft_per_mph: DERBY_MODEL_ASSUMPTIONS.distance_ev_slope_ft_per_mph,
      distance_standard_deviation_ft: DERBY_MODEL_ASSUMPTIONS.distance_standard_deviation_ft,
      exit_velocity_standard_deviation_mph: DERBY_MODEL_ASSUMPTIONS.exit_velocity_standard_deviation_mph,
      fatigue_hr_probability_decay_per_round: DERBY_MODEL_ASSUMPTIONS.fatigue_hr_probability_decay_per_round,
      fatigue_distance_decay_ft_per_round: DERBY_MODEL_ASSUMPTIONS.fatigue_distance_decay_ft_per_round,
    }),
  }),
  Object.freeze({
    id: 'aggressive',
    label: 'Aggressive conversion',
    calibration_status: 'UNCALIBRATED_STRESS_CASE',
    description: 'Higher BP conversion and power lift with lighter fatigue and a wider, longer assumed flight tail.',
    parameters: Object.freeze({
      bp_hr_probability_multiplier: 1.48,
      bp_contact_floor: 0.65,
      bp_exit_velocity_lift_mph: 6,
      distance_max_to_hr_mean_ft: 10,
      distance_pull_air_bonus_ft: 14,
      distance_ev_slope_ft_per_mph: 1.75,
      distance_standard_deviation_ft: 18,
      exit_velocity_standard_deviation_mph: 4.2,
      fatigue_hr_probability_decay_per_round: 0.01,
      fatigue_distance_decay_ft_per_round: 0,
    }),
  }),
]);

export const DERBY_PUBLICATION_RULES = Object.freeze({
  relative_rankings: Object.freeze({ minimum_quality: 'D', below_threshold: 'suppressed' }),
  broad_tiers: Object.freeze({ minimum_quality: 'D', below_threshold: 'suppressed' }),
  exact_winner_probabilities: Object.freeze({ minimum_quality: 'C', below_threshold: 'experimental_only' }),
  exact_outcome_probabilities: Object.freeze({ minimum_quality: 'C', below_threshold: 'suppressed' }),
  exact_round_hr_distributions: Object.freeze({ minimum_quality: 'B', below_threshold: 'suppressed' }),
  exact_tournament_totals: Object.freeze({ minimum_quality: 'B', below_threshold: 'suppressed' }),
  per_foot_distance_distributions: Object.freeze({ minimum_quality: 'B', below_threshold: 'suppressed' }),
  five_hundred_plus_probabilities: Object.freeze({ minimum_quality: 'B', below_threshold: 'suppressed' }),
  exact_ev_distributions: Object.freeze({ minimum_quality: 'B', below_threshold: 'suppressed' }),
});

export const DERBY_ASSUMPTION_QUALITY_DEFAULTS = Object.freeze({
  bp_power_transform: 'F',
  fatigue_curve: 'F',
  distance_transform: 'F',
  rule_coverage: 'F',
});

export const DERBY_ASSUMPTION_SUPPORT_DEFAULTS = Object.freeze({
  bp_power_transform: Object.freeze({
    source_quality: 'F',
    status: 'ASSUMED',
    support_kind: 'UNCALIBRATED_ASSUMPTION',
    basis: 'In-game Statcast is only a proxy for unmeasured Derby batting-practice power.',
    source: 'Unmeasured model assumption; no fabricated BP source',
  }),
  fatigue_curve: Object.freeze({
    source_quality: 'F',
    status: 'ASSUMED',
    support_kind: 'UNCALIBRATED_ASSUMPTION',
    basis: 'No public per-round Derby fatigue calibration supports the configured decay curve.',
    source: 'Unmeasured model assumption; no fabricated fatigue source',
  }),
  distance_transform: Object.freeze({
    source_quality: 'F',
    status: 'ASSUMED',
    support_kind: 'UNCALIBRATED_ASSUMPTION',
    basis: 'In-game distance and exit velocity are proxies for unmeasured Derby ball flight.',
    source: 'Unmeasured model assumption; no fabricated Derby distance source',
  }),
  rule_coverage: Object.freeze({
    source_quality: 'F',
    status: 'UNKNOWN',
    support_kind: 'UNVERIFIED_RULE_GAPS',
    basis: 'Several event-rule and output-accounting details remain unverified.',
    source: 'Unverified 2026 Derby rule gaps',
  }),
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
const QUALITY_ORDER = Object.freeze({ F: 0, D: 1, C: 2, B: 3, A: 4 });
const ASSUMPTION_SUPPORT_STATUSES = new Set(['LOCKED', 'PROJECTED', 'ASSUMED', 'UNKNOWN']);
const PROMOTABLE_ASSUMPTION_SUPPORT_KINDS = new Set(['DOCUMENTED_EVIDENCE', 'SYNTHETIC_TEST_FIXTURE']);
const ASSUMPTION_SUPPORT_KEYS = new Set(['source_quality', 'status', 'support_kind', 'basis', 'source']);
const PRICE_KEYS = new Set([
  'price', 'odds', 'bid', 'ask', 'vig', 'edge', 'kelly', 'stake', 'oi',
  'open_interest', 'volume', 'liquidity', 'yes_ask', 'no_ask', 'yes_bid',
  'no_bid', 'kalshi_ask', 'kalshi_bid', 'moneyline_odds', 'implied_prob',
  'market_prob', 'fair_value', 'line_movement', 'price_movement',
  'market_price', 'market_movement', 'movement', 'board_shape', 'spread_shape',
  'last_price',
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

function lowestQuality(...qualities) {
  return qualities.reduce((worst, quality) => (
    QUALITY_ORDER[quality] < QUALITY_ORDER[worst] ? quality : worst
  ), 'A');
}

function normalizeAssumptionSupport(value) {
  const supplied = value ?? {};
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) {
    throw new Error('assumption_support must be an object');
  }
  const normalized = {};
  for (const domain of Object.keys(DERBY_ASSUMPTION_SUPPORT_DEFAULTS)) {
    const raw = supplied[domain];
    if (raw == null) {
      normalized[domain] = DERBY_ASSUMPTION_SUPPORT_DEFAULTS[domain];
      continue;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Derby assumption support ${domain} must be an object`);
    }
    for (const key of Object.keys(raw)) {
      if (!ASSUMPTION_SUPPORT_KEYS.has(key)) throw new Error(`unknown Derby assumption support field: ${domain}.${key}`);
    }
    const support = { ...DERBY_ASSUMPTION_SUPPORT_DEFAULTS[domain], ...raw };
    if (!QUALITY_SET.has(support.source_quality)) {
      throw new Error(`invalid Derby assumption support quality: ${domain}=${support.source_quality}`);
    }
    if (!ASSUMPTION_SUPPORT_STATUSES.has(support.status)) {
      throw new Error(`invalid Derby assumption support status: ${domain}=${support.status}`);
    }
    if (typeof support.basis !== 'string' || !support.basis.trim()
      || typeof support.source !== 'string' || !support.source.trim()) {
      throw new Error(`Derby assumption support ${domain} requires non-empty basis and source`);
    }
    if (support.source_quality !== 'F') {
      for (const required of ['status', 'support_kind', 'basis', 'source']) {
        if (!Object.hasOwn(raw, required)) {
          throw new Error(`Derby assumption support ${domain} must explicitly provide ${required} to exceed F`);
        }
      }
      if (support.status === 'UNKNOWN') {
        throw new Error(`Derby assumption support ${domain} cannot be non-F with UNKNOWN status`);
      }
      if (!PROMOTABLE_ASSUMPTION_SUPPORT_KINDS.has(support.support_kind)) {
        throw new Error(`Derby assumption support ${domain} requires DOCUMENTED_EVIDENCE or SYNTHETIC_TEST_FIXTURE to exceed F`);
      }
    }
    normalized[domain] = Object.freeze(support);
  }
  for (const domain of Object.keys(supplied)) {
    if (!(domain in DERBY_ASSUMPTION_SUPPORT_DEFAULTS)) throw new Error(`unknown Derby assumption support domain: ${domain}`);
  }
  return Object.freeze(normalized);
}

function assumptionQualityFromSupport(support) {
  return Object.freeze(Object.fromEntries(
    Object.entries(support).map(([domain, metadata]) => [domain, metadata.source_quality]),
  ));
}

function publicationFieldQuality(dataQuality, assumptionQuality) {
  const bp = assumptionQuality.bp_power_transform;
  const fatigue = assumptionQuality.fatigue_curve;
  const distance = assumptionQuality.distance_transform;
  const rules = assumptionQuality.rule_coverage;
  return {
    relative_rankings: dataQuality,
    broad_tiers: dataQuality,
    exact_winner_probabilities: lowestQuality(dataQuality, bp, fatigue, distance, rules),
    exact_outcome_probabilities: lowestQuality(dataQuality, bp, fatigue, distance, rules),
    exact_round_hr_distributions: lowestQuality(dataQuality, bp, rules),
    exact_tournament_totals: lowestQuality(dataQuality, bp, fatigue, distance, rules),
    per_foot_distance_distributions: lowestQuality(dataQuality, bp, fatigue, distance, rules),
    five_hundred_plus_probabilities: lowestQuality(dataQuality, bp, fatigue, distance, rules),
    exact_ev_distributions: lowestQuality(dataQuality, bp, fatigue, distance, rules),
  };
}

export function buildDerbyPublicationEligibility(dataQuality, assumptionSupportInput = undefined) {
  const quality = QUALITY_SET.has(dataQuality) ? dataQuality : 'F';
  const assumptionSupport = normalizeAssumptionSupport(assumptionSupportInput);
  const assumptionQuality = assumptionQualityFromSupport(assumptionSupport);
  const fieldQuality = publicationFieldQuality(quality, assumptionQuality);
  return {
    data_quality: quality,
    assumption_quality: assumptionQuality,
    assumption_support: assumptionSupport,
    policy_version: 'mlb_hr_derby_publication_v1',
    fields: Object.fromEntries(Object.entries(DERBY_PUBLICATION_RULES).map(([field, rule]) => [field, {
      minimum_quality: rule.minimum_quality,
      effective_quality: fieldQuality[field],
      status: QUALITY_ORDER[fieldQuality[field]] >= QUALITY_ORDER[rule.minimum_quality]
        ? 'eligible'
        : rule.below_threshold,
    }])),
  };
}

const SENSITIVITY_PARAMETER_KEYS = new Set(Object.keys(DERBY_SENSITIVITY_SCENARIOS[0].parameters));
const REQUIRED_SENSITIVITY_IDS = Object.freeze(['conservative', 'base', 'aggressive']);

function normalizeSensitivityScenarios(value) {
  const supplied = value == null ? DERBY_SENSITIVITY_SCENARIOS : value;
  if (!Array.isArray(supplied) || supplied.length !== REQUIRED_SENSITIVITY_IDS.length) {
    throw new Error('sensitivity_scenarios must contain conservative, base, and aggressive');
  }
  const byId = new Map();
  for (const raw of supplied) {
    const id = String(raw?.id ?? '').trim();
    if (!REQUIRED_SENSITIVITY_IDS.includes(id) || byId.has(id)) {
      throw new Error('sensitivity_scenarios must contain each required id exactly once');
    }
    const overrides = raw?.parameters ?? {};
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
      throw new Error(`sensitivity scenario ${id} parameters must be an object`);
    }
    for (const [key, parameter] of Object.entries(overrides)) {
      if (!SENSITIVITY_PARAMETER_KEYS.has(key)) throw new Error(`unknown Derby sensitivity parameter: ${key}`);
      if (!finite(parameter) || parameter < 0) throw new Error(`invalid Derby sensitivity parameter: ${id}.${key}`);
    }
    const defaults = DERBY_SENSITIVITY_SCENARIOS.find((scenario) => scenario.id === id);
    const parameters = { ...defaults.parameters, ...overrides };
    if (parameters.bp_contact_floor > 1
      || parameters.fatigue_hr_probability_decay_per_round > 1
      || parameters.distance_standard_deviation_ft <= 0
      || parameters.exit_velocity_standard_deviation_mph <= 0) {
      throw new Error(`invalid Derby sensitivity parameter bounds for ${id}`);
    }
    byId.set(id, Object.freeze({
      id,
      label: String(raw?.label ?? defaults.label),
      calibration_status: 'UNCALIBRATED_STRESS_CASE',
      description: String(raw?.description ?? defaults.description),
      parameters: Object.freeze(parameters),
    }));
  }
  return REQUIRED_SENSITIVITY_IDS.map((id) => byId.get(id));
}

function assumptionsForScenario(scenario) {
  return Object.freeze({ ...DERBY_MODEL_ASSUMPTIONS, ...scenario.parameters });
}

function aggregateQuality(models) {
  return models.reduce((worst, model) => (
    QUALITY_ORDER[model.data_quality] < QUALITY_ORDER[worst] ? model.data_quality : worst
  ), 'A');
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

function deriveParticipantModel(rawParticipant, asOf, assumptions = DERBY_MODEL_ASSUMPTIONS) {
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
      * assumptions.bp_hr_probability_multiplier
      * (assumptions.bp_contact_floor
        + ((1 - assumptions.bp_contact_floor) * profile.features.hard_hit_rate)),
    0,
    1,
  );
  const distanceMean = distance.max
    - assumptions.distance_max_to_hr_mean_ft
    + profile.features.pull_air_rate * assumptions.distance_pull_air_bonus_ft;
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
    exit_velocity_mean_mph: ev.mean + assumptions.bp_exit_velocity_lift_mph,
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
  const samplingUncertainty = {
    kind: 'monte_carlo_sampling_95pct_wilson',
    interval: percentile95(hits, simulations),
    scope: 'finite simulation sampling error only',
  };
  return {
    probability,
    hits,
    simulations,
    sampling_uncertainty: samplingUncertainty,
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

function simulateSwing(model, rng, state, roundIndex, assumptions) {
  const exitVelocity = Math.max(0, seededNormal(
    rng,
    model.exit_velocity_mean_mph,
    assumptions.exit_velocity_standard_deviation_mph,
  ));
  if (exitVelocity > state.highest_exit_velocity_mph) {
    state.highest_exit_velocity_mph = exitVelocity;
    state.highest_exit_velocity_player = model.name;
  }
  const probability = clamp(
    model.hr_probability * (1 - (roundIndex * assumptions.fatigue_hr_probability_decay_per_round)),
    0,
    1,
  );
  const isHomeRun = rng() < probability;
  if (!isHomeRun) return { is_home_run: false, exit_velocity_mph: exitVelocity, distance_ft: null };
  const distanceMean = model.distance_mean_ft - (roundIndex * assumptions.fatigue_distance_decay_ft_per_round);
  const distance = Math.max(0, seededNormal(
    rng,
    distanceMean + ((exitVelocity - model.exit_velocity_mean_mph) * assumptions.distance_ev_slope_ft_per_mph),
    assumptions.distance_standard_deviation_ft,
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

function simulateContestantRound(model, baseSwingLimit, rng, state, roundIndex, roundName, assumptions) {
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
  while (result.swings < baseSwingLimit || (lastWasHomeRun && result.swings < assumptions.max_hot_hand_swings)) {
    const swing = simulateSwing(model, rng, state, roundIndex, assumptions);
    result.swings += 1;
    if (result.swings > baseSwingLimit) result.hot_hand_extensions += 1;
    lastWasHomeRun = swing.is_home_run;
    if (swing.is_home_run) {
      result.hr_count += 1;
      result.longest_distance_ft = Math.max(result.longest_distance_ft, swing.distance_ft);
      recordHomeRun(model, swing, state);
    }
    if (result.swings >= assumptions.max_hot_hand_swings && lastWasHomeRun) {
      result.cap_applied = true;
      state.hot_hand_cap_events += 1;
      break;
    }
  }
  if (result.longest_distance_ft === -Infinity) result.longest_distance_ft = -1;
  return result;
}

function simulateSwingOff(left, right, rng, state, roundIndex, diagnostics, assumptions) {
  for (let swingoffRound = 1; swingoffRound <= assumptions.max_swingoff_rounds; swingoffRound += 1) {
    let leftHrs = 0;
    let rightHrs = 0;
    for (let swing = 0; swing < 3; swing += 1) {
      const leftSwing = simulateSwing(left, rng, state, roundIndex, assumptions);
      if (leftSwing.is_home_run) {
        leftHrs += 1;
        recordHomeRun(left, leftSwing, state, { swingoff: true });
      }
      const rightSwing = simulateSwing(right, rng, state, roundIndex, assumptions);
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

function simulateMatch(leftEntry, rightEntry, rng, state, roundIndex, roundName, swingLimit, diagnostics, assumptions) {
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
    assumptions,
  ));
  let winnerResult = results[0];
  let loserResult = results[1];
  if (results[1].hr_count > results[0].hr_count) {
    winnerResult = results[1];
    loserResult = results[0];
  } else if (results[1].hr_count === results[0].hr_count) {
    diagnostics[`${roundName}_pre_swingoff_ties`] += 1;
    const winnerModel = simulateSwingOff(hitOrder[0].model, hitOrder[1].model, rng, state, roundIndex, diagnostics, assumptions);
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

function runOneTournament(models, seed, simulationIndex, assumptions) {
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
  const round1 = models.map((model) => simulateContestantRound(
    model,
    DERBY_RULES.round_1_swings,
    rng,
    state,
    0,
    'round_1',
    assumptions,
  ));
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
    assumptions,
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
    assumptions,
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

export function simulateDerbyTournament({
  models,
  seed = 'cpc-hr-derby-phase3',
  simulation_index = 0,
  assumptions = DERBY_MODEL_ASSUMPTIONS,
} = {}) {
  ensureParticipantCount(models);
  if (!Number.isInteger(simulation_index) || simulation_index < 0) throw new Error('simulation_index must be a non-negative integer');
  if (models.some((model) => model?.status !== 'ready')) throw new Error('all Derby participant models must be ready');
  return runOneTournament(models, String(seed), simulation_index, assumptions);
}

function summarize(simulations, models, seed, generatedUtc, assumptions, blockedParticipants, assumptionSupport) {
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
  const capEventLogs = {
    hot_hand: [],
    swingoff: [],
  };
  for (const [simulationIndex, tournament] of simulations.entries()) {
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
    if (tournament.state.hot_hand_cap_events > 0) {
      capEventLogs.hot_hand.push({
        simulation_index: simulationIndex,
        event_count: tournament.state.hot_hand_cap_events,
      });
    }
    if (tournament.diagnostics.swingoff_cap_events > 0) {
      capEventLogs.swingoff.push({
        simulation_index: simulationIndex,
        event_count: tournament.diagnostics.swingoff_cap_events,
      });
    }
  }
  const quality = aggregateQuality(models);
  const assumptionQuality = assumptionQualityFromSupport(assumptionSupport);
  const assumptionSupportQuality = lowestQuality(...Object.values(assumptionQuality));
  const out = {
    schema_version: 'mlb_hr_derby_projection_v1',
    event: DERBY_EVENT,
    format: DERBY_RULES,
    generated_utc: generatedUtc,
    seed,
    simulations: total,
    model_data_quality: quality,
    quality_metadata: {
      participant_data_quality: quality,
      assumption_quality: assumptionQuality,
      assumption_support: assumptionSupport,
      overall_assumption_support_quality: assumptionSupportQuality,
    },
    publication_eligibility: buildDerbyPublicationEligibility(quality, assumptionSupport),
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
    cap_event_logs: capEventLogs,
    hot_hand: {
      applied: true,
      explicit_cap: assumptions.max_hot_hand_swings,
      cap_events: deadHeats.hot_hand_cap_events,
      disclosure: `The hot-hand continuation has an unbounded geometric tail; numerical safety caps at ${assumptions.max_hot_hand_swings} total swings per contestant and logs every cap event.`,
    },
    total_accounting: {
      includes_swingoff_home_runs: true,
      disclosure: 'Tournament total, longest-distance, highest-EV, and 500+ ft outputs include swing-off swings.',
    },
    assumptions: assumptions,
    uncertainty: {
      monte_carlo_sampling: {
        kind: 'monte_carlo_sampling_95pct_wilson',
        simulations: total,
        scope: 'finite simulation sampling error only; not total forecast uncertainty',
      },
      model_assumption: {
        kind: 'cross_scenario_assumption_range',
        calibration_status: 'UNCALIBRATED',
        qualitative_confidence: QUALITY_ORDER[assumptionSupportQuality] >= QUALITY_ORDER.B ? 'LOW' : 'VERY_LOW',
        scope: 'BP conversion, fatigue, distance, and exit-velocity assumptions',
        is_confidence_interval: false,
      },
    },
  };
  assertNoPriceFields(out, 'Derby projection output');
  return out;
}

export function buildDerbyParticipantModels({
  participants,
  as_of = DERBY_EVENT.date,
  assumptions = DERBY_MODEL_ASSUMPTIONS,
} = {}) {
  ensureParticipantCount(participants);
  const models = participants.map((participant) => deriveParticipantModel(participant, as_of, assumptions));
  return models;
}

const ROBUST_CONCLUSION_TARGETS = Object.freeze([
  Object.freeze({ id: 'winner_tier', label: 'Winner tier', path: ['winner', 'probabilities'], top_rank: 2, contender_rank: 4 }),
  Object.freeze({ id: 'advancement_tier', label: 'Advancement tier', path: ['qualifiers'], top_rank: 4, contender_rank: 6 }),
  Object.freeze({ id: 'round_1_leader_tier', label: 'Round 1 leader tier', path: ['round_1_leader', 'probabilities'], top_rank: 2, contender_rank: 4 }),
  Object.freeze({ id: 'longest_hr_player_tier', label: 'Longest-HR player tier', path: ['longest_home_run', 'player'], top_rank: 2, contender_rank: 4 }),
  Object.freeze({ id: 'highest_ev_player_tier', label: 'Highest-EV player tier', path: ['highest_exit_velocity', 'player'], top_rank: 2, contender_rank: 4 }),
  Object.freeze({ id: 'likely_finals_matchup_tier', label: 'Likely finals matchup tier', path: ['finals_matchup', 'probabilities'], top_rank: 3, contender_rank: 6 }),
]);

function valueAtPath(value, path) {
  return path.reduce((current, key) => current?.[key], value);
}

function tierForRank(rank, target) {
  if (rank <= target.top_rank) return 'top';
  if (rank <= target.contender_rank) return 'contender';
  return 'field';
}

function roundedScenarioBand(low, high, quality) {
  const step = QUALITY_ORDER[quality] <= QUALITY_ORDER.D ? 0.10
    : QUALITY_ORDER[quality] === QUALITY_ORDER.C ? 0.05
      : 0.025;
  let roundedLow = clamp(Math.floor((low + Number.EPSILON) / step) * step, 0, 1);
  let roundedHigh = clamp(Math.ceil((high - Number.EPSILON) / step) * step, 0, 1);
  if (roundedLow === roundedHigh && roundedHigh < 1) roundedHigh = clamp(roundedHigh + step, 0, 1);
  else if (roundedLow === roundedHigh && roundedLow > 0) roundedLow = clamp(roundedLow - step, 0, 1);
  return { low: roundedLow, high: roundedHigh, step };
}

function samplingBounds(figure) {
  const interval = figure?.sampling_uncertainty?.interval;
  if (finite(interval?.low) && finite(interval?.high)) {
    return { low: interval.low, high: interval.high, available: true };
  }
  const probability = finite(figure?.probability) ? figure.probability : 0;
  return { low: probability, high: probability, available: false };
}

function rankScenarioCandidates(candidates, figureMapForScenario, target) {
  const ordered = candidates.map((candidate) => {
    const figure = figureMapForScenario[candidate] ?? { probability: 0 };
    return {
      candidate,
      probability: finite(figure.probability) ? figure.probability : 0,
      sampling_interval: samplingBounds(figure),
    };
  }).sort((left, right) => right.probability - left.probability || compareText(left.candidate, right.candidate));

  let previousProbability = null;
  let competitionRank = 0;
  const ranked = ordered.map((row, index) => {
    if (previousProbability == null || Math.abs(row.probability - previousProbability) > 1e-12) {
      competitionRank = index + 1;
      previousProbability = row.probability;
    }
    return { ...row, rank: competitionRank, tier: tierForRank(competitionRank, target) };
  });
  const top = ranked.filter((row) => row.tier === 'top');
  const rest = ranked.filter((row) => row.tier !== 'top');
  const topCardinalityValid = top.length > 0 && top.length <= target.top_rank && rest.length > 0;
  const topTierSamplingSeparated = topCardinalityValid
    && Math.min(...top.map((row) => row.sampling_interval.low))
      > Math.max(...rest.map((row) => row.sampling_interval.high));
  return {
    rows: ranked,
    evidence: {
      top_tier_sampling_separated: topTierSamplingSeparated,
      top_tier_cardinality: top.length,
      maximum_top_tier_size: target.top_rank,
      sampling_intervals_available: ranked.every((row) => row.sampling_interval.available),
      rule: 'The entire top tier must fit within the configured tier size and its lowest sampling bound must exceed every non-top upper bound.',
    },
  };
}

function robustConclusionForTarget(scenarioProjections, target, quality) {
  const scenarioIds = REQUIRED_SENSITIVITY_IDS;
  const candidateSet = new Set();
  for (const scenarioId of scenarioIds) {
    for (const candidate of Object.keys(valueAtPath(scenarioProjections[scenarioId], target.path) ?? {})) {
      candidateSet.add(candidate);
    }
  }
  const candidates = [...candidateSet].sort(compareText);
  const rankedScenarios = Object.fromEntries(scenarioIds.map((scenarioId) => {
    const figureMapForScenario = valueAtPath(scenarioProjections[scenarioId], target.path) ?? {};
    return [scenarioId, rankScenarioCandidates(candidates, figureMapForScenario, target)];
  }));
  const rankings = Object.fromEntries(scenarioIds.map((scenarioId) => [
    scenarioId,
    Object.fromEntries(rankedScenarios[scenarioId].rows.map((row) => [row.candidate, {
      rank: row.rank,
      probability: row.probability,
      tier: row.tier,
      sampling_interval: row.sampling_interval,
    }])),
  ]));
  const entries = candidates.map((candidate) => {
    const scenarios = Object.fromEntries(scenarioIds.map((scenarioId) => [scenarioId, rankings[scenarioId][candidate]]));
    const rows = Object.values(scenarios);
    const tiers = new Set(rows.map((row) => row.tier));
    const probabilities = rows.map((row) => row.probability);
    const ranks = rows.map((row) => row.rank);
    const probabilityRange = { low: Math.min(...probabilities), high: Math.max(...probabilities) };
    const tierStableAcrossScenarios = tiers.size === 1 && probabilities.every((probability) => probability > 0);
    const stableTier = tierStableAcrossScenarios ? rows[0].tier : null;
    const samplingSeparatedAcrossScenarios = stableTier !== 'top' || scenarioIds.every(
      (scenarioId) => rankedScenarios[scenarioId].evidence.top_tier_sampling_separated,
    );
    const stableAcrossScenarios = tierStableAcrossScenarios && samplingSeparatedAcrossScenarios;
    return {
      candidate,
      tier_stable_across_all_scenarios: tierStableAcrossScenarios,
      sampling_separated_across_all_scenarios: samplingSeparatedAcrossScenarios,
      stable_across_all_scenarios: stableAcrossScenarios,
      stable_tier: stableAcrossScenarios ? stableTier : null,
      scenario_rank_range: { best: Math.min(...ranks), worst: Math.max(...ranks) },
      scenario_probability_range: {
        ...probabilityRange,
        kind: 'model_assumption_scenario_range',
        is_confidence_interval: false,
      },
      rounded_scenario_band: {
        ...roundedScenarioBand(probabilityRange.low, probabilityRange.high, quality),
        label: 'EXPERIMENTAL_ROUNDED_SCENARIO_BAND',
      },
      scenarios,
    };
  });
  return {
    label: target.label,
    stability_rule: `same broad tier in all ${scenarioIds.length} configured scenarios; a public top tier must also be sampling-separated from the rest in every scenario`,
    tier_definition: {
      top: `rank 1-${target.top_rank}`,
      contender: `rank ${target.top_rank + 1}-${target.contender_rank}`,
      field: `rank ${target.contender_rank + 1}+`,
    },
    scenario_top_tier_evidence: Object.fromEntries(scenarioIds.map((scenarioId) => [
      scenarioId,
      rankedScenarios[scenarioId].evidence,
    ])),
    stable_top_tier: entries.filter((entry) => entry.stable_tier === 'top'),
    stable_entries: entries.filter((entry) => entry.stable_across_all_scenarios),
    unstable_entries: entries.filter((entry) => !entry.stable_across_all_scenarios),
  };
}

export function extractRobustDerbyConclusions(scenarioProjections, quality) {
  for (const id of REQUIRED_SENSITIVITY_IDS) {
    if (!scenarioProjections?.[id]) throw new Error(`missing sensitivity output: ${id}`);
  }
  return {
    schema_version: 'mlb_hr_derby_robust_conclusions_v1',
    required_scenarios: [...REQUIRED_SENSITIVITY_IDS],
    publication_rule: 'Only candidates that remain in the same broad tier across every sensitivity scenario are robust; top tiers must also be separated at the Monte Carlo sampling bounds.',
    conclusions: Object.fromEntries(ROBUST_CONCLUSION_TARGETS.map((target) => [
      target.id,
      robustConclusionForTarget(scenarioProjections, target, quality),
    ])),
  };
}

function attachModelRangeToFigureMap(baseMap, scenarioMaps, quality) {
  for (const [key, value] of Object.entries(baseMap ?? {})) {
    const probabilities = scenarioMaps.map((map) => map?.[key]?.probability ?? 0);
    const low = Math.min(...probabilities);
    const high = Math.max(...probabilities);
    value.model_uncertainty = {
      kind: 'cross_scenario_assumption_range',
      interval: { low, high },
      rounded_display_band: roundedScenarioBand(low, high, quality),
      scenarios: [...REQUIRED_SENSITIVITY_IDS],
      calibration_status: 'UNCALIBRATED',
      is_confidence_interval: false,
    };
  }
}

function attachModelUncertainty(baseProjection, scenarioProjections, quality) {
  const outputs = REQUIRED_SENSITIVITY_IDS.map((id) => scenarioProjections[id]);
  const paths = [
    ['winner', 'probabilities'],
    ['round_1_leader', 'probabilities'],
    ['qualifiers'],
    ['finals_matchup', 'probabilities'],
    ['finals_result', 'probabilities'],
    ['total_home_runs', 'distribution'],
    ['longest_home_run', 'player'],
    ['longest_home_run', 'distance_ft'],
    ['longest_home_run', 'player_distance'],
    ['highest_exit_velocity', 'player'],
    ['highest_exit_velocity', 'mph'],
    ['highest_exit_velocity', 'player_mph'],
    ['home_runs_500_plus', 'distribution'],
  ];
  for (const path of paths) {
    attachModelRangeToFigureMap(
      valueAtPath(baseProjection, path),
      outputs.map((projection) => valueAtPath(projection, path)),
      quality,
    );
  }
  for (const name of Object.keys(baseProjection.round_1_hr_totals ?? {})) {
    attachModelRangeToFigureMap(
      baseProjection.round_1_hr_totals[name].distribution,
      outputs.map((projection) => projection.round_1_hr_totals?.[name]?.distribution),
      quality,
    );
  }
}

function simulationTrace(simulations, simulationsCount, seed) {
  return {
    tournament_count: simulationsCount,
    seed,
    trace_scope: 'first three tournaments; aggregate diagnostics and all cap events are retained separately',
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
      diagnostics: simulation.diagnostics,
    })),
  };
}

export function buildDerbyProjection(input = {}) {
  const safeInput = withoutPriceFields(input);
  assertNoPriceFields(safeInput, 'Derby projection input');
  if ('assumption_quality' in safeInput) {
    throw new Error('assumption_quality cannot unlock Derby publication; provide explicit assumption_support evidence metadata');
  }
  const participants = safeInput.participants;
  ensureParticipantCount(participants);
  const seed = String(safeInput.seed ?? 'cpc-hr-derby-phase3');
  const simulationsCount = safeInput.simulations ?? 4000;
  if (!Number.isInteger(simulationsCount) || simulationsCount <= 0) throw new Error('simulations must be a positive integer');
  const generatedUtc = safeInput.generated_utc ?? new Date().toISOString();
  const asOf = safeInput.as_of ?? DERBY_EVENT.date;
  const assumptionSupport = normalizeAssumptionSupport(safeInput.assumption_support);
  const assumptionQuality = assumptionQualityFromSupport(assumptionSupport);
  const sensitivityScenarios = normalizeSensitivityScenarios(safeInput.sensitivity_scenarios);
  const baseScenario = sensitivityScenarios.find((scenario) => scenario.id === 'base');
  const baseAssumptions = assumptionsForScenario(baseScenario);
  const models = buildDerbyParticipantModels({ participants, as_of: asOf, assumptions: baseAssumptions });
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
      model_data_quality: 'F',
      quality_metadata: {
        participant_data_quality: 'F',
        assumption_quality: assumptionQuality,
        assumption_support: assumptionSupport,
        overall_assumption_support_quality: lowestQuality(...Object.values(assumptionQuality)),
      },
      publication_eligibility: buildDerbyPublicationEligibility('F', assumptionSupport),
      blocked_participants: blockedParticipants,
      participant_models: Object.fromEntries(models.map((model) => [model.name, {
        team: model.team,
        status: model.status,
        blocked_reasons: model.blocked_reasons,
        data_quality: model.data_quality ?? 'F',
      }])),
      participant_profiles: Object.fromEntries(models.map((model) => [model.name, model.profile])),
      simulation: null,
      assumptions: baseAssumptions,
      sensitivity: {
        schema_version: 'mlb_hr_derby_sensitivity_v1',
        calibration_status: 'UNCALIBRATED',
        documentation: 'Configured stress cases only; no historical Derby calibration is claimed.',
        scenarios: sensitivityScenarios,
        outputs: null,
      },
    };
  }
  const scenarioProjections = {};
  for (const scenario of sensitivityScenarios) {
    const assumptions = assumptionsForScenario(scenario);
    const scenarioModels = scenario.id === 'base'
      ? models
      : buildDerbyParticipantModels({ participants, as_of: asOf, assumptions });
    const simulations = Array.from({ length: simulationsCount }, (_, index) => simulateDerbyTournament({
      models: scenarioModels,
      seed,
      simulation_index: index,
      assumptions,
    }));
    const scenarioProjection = summarize(
      simulations,
      scenarioModels,
      seed,
      generatedUtc,
      assumptions,
      [],
      assumptionSupport,
    );
    scenarioProjection.status = 'ready';
    scenarioProjection.scenario = {
      id: scenario.id,
      label: scenario.label,
      calibration_status: scenario.calibration_status,
      description: scenario.description,
    };
    scenarioProjection.simulation = simulationTrace(simulations, simulationsCount, seed);
    scenarioProjections[scenario.id] = scenarioProjection;
  }

  const projection = scenarioProjections.base;
  attachModelUncertainty(projection, scenarioProjections, projection.model_data_quality);
  const sensitivityOutputs = Object.fromEntries(sensitivityScenarios.map((scenario) => [
    scenario.id,
    scenario.id === 'base' ? { ...scenarioProjections.base } : scenarioProjections[scenario.id],
  ]));
  projection.robust_conclusions = extractRobustDerbyConclusions(
    scenarioProjections,
    projection.model_data_quality,
  );
  projection.sensitivity = {
    schema_version: 'mlb_hr_derby_sensitivity_v1',
    calibration_status: 'UNCALIBRATED',
    documentation: 'Conservative, base, and aggressive settings are configurable assumption stress cases, not historical calibration estimates.',
    shared_seed_across_scenarios: true,
    common_random_numbers: false,
    seed,
    simulations_per_scenario: simulationsCount,
    scenario_order: [...REQUIRED_SENSITIVITY_IDS],
    scenarios: sensitivityScenarios,
    outputs: sensitivityOutputs,
  };
  projection.uncertainty.model_assumption.scenarios = [...REQUIRED_SENSITIVITY_IDS];
  projection.uncertainty.model_assumption.disclosure = 'Scenario ranges are assumption envelopes, not confidence intervals or total calibrated uncertainty.';
  assertNoPriceFields(projection, 'Derby projection output with sensitivities');
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
