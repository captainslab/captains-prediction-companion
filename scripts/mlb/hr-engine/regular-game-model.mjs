// Fitted, market-free per-PA home-run model for regular MLB games.
// Contact quality and opportunity are deliberately separate: this module's
// logistic model estimates P(HR | PA); lineup slot supplies the PA count later.

import { readFileSync } from 'node:fs';
import { assertNoPriceFields } from '../lib/projection-contracts.mjs';
import { NON_BIP_TERMINAL_EVENTS, isTerminalPa } from '../source-adapters/baseball-savant-distributions.mjs';
import { simulatePaOutcomes } from './monte-carlo.mjs';

export const REGULAR_GAME_MODEL_SCHEMA = 'cpc_mlb_hr_pa_logistic_v1';
export const REGULAR_GAME_PROJECTION_SCHEMA = 'cpc_mlb_regular_game_hr_projection_v1';
export const LEAGUE_REFERENCE_HR_PA = 0.03089;
export const OFFICIAL_2025_REFERENCE = Object.freeze({ home_runs: 5_650, plate_appearances: 182_926 });

export const FEATURE_NAMES = Object.freeze([
  'batter_hr_pa_7d', 'batter_hr_pa_30d', 'batter_hr_pa_season',
  'batter_7d_missing', 'batter_30d_missing', 'batter_season_missing',
  'batter_barrel_rate_30d', 'batter_hard_hit_rate_30d',
  'batter_fly_ball_rate_30d', 'batter_pull_air_rate_30d',
  'batter_ev_mean_30d', 'batter_ev_sd_30d', 'batter_contact_missing',
  'pitcher_hr_pa_season', 'pitcher_missing',
  'park_hr_factor', 'park_missing',
  'same_hand_matchup', 'batter_left', 'pitcher_left', 'handedness_missing',
  'roof_closed', 'roof_missing', 'altitude_feet', 'altitude_missing',
  'temperature_f', 'temperature_missing', 'wind_out_mph', 'wind_missing',
  'directional_fit', 'directional_fit_missing',
]);

const DAY_MS = 86_400_000;
const PROFILE_FIELDS = Object.freeze([
  'pa', 'hr', 'bip', 'barrel', 'hard_hit', 'fly_ball', 'pull_air',
  'ev_count', 'ev_sum', 'ev_sum_sq',
]);

function finiteNumberArray(values, expectedLength, { positive = false } = {}) {
  return Array.isArray(values)
    && values.length === expectedLength
    && values.every((value) => Number.isFinite(value) && (!positive || value > 0));
}

export function regularGameModelValidationErrors(model) {
  const errors = [];
  if (model?.schema_version !== REGULAR_GAME_MODEL_SCHEMA) errors.push('schema_version');
  if (!Number.isFinite(model?.hyperparameters?.prior_strength) || model.hyperparameters.prior_strength < 0) {
    errors.push('hyperparameters.prior_strength');
  }
  if (!Number.isFinite(model?.model?.intercept)) errors.push('model.intercept');
  if (JSON.stringify(model?.model?.feature_names) !== JSON.stringify(FEATURE_NAMES)) {
    errors.push('model.feature_names');
  }
  if (!finiteNumberArray(model?.model?.coefficients, FEATURE_NAMES.length)) {
    errors.push('model.coefficients');
  }
  if (!finiteNumberArray(model?.model?.standardization?.means, FEATURE_NAMES.length)) {
    errors.push('model.standardization.means');
  }
  if (!finiteNumberArray(model?.model?.standardization?.scales, FEATURE_NAMES.length, { positive: true })) {
    errors.push('model.standardization.scales');
  }
  for (let slot = 1; slot <= 9; slot += 1) {
    const opportunity = model?.opportunity_model?.by_lineup_slot?.[String(slot)];
    if (!Number.isFinite(opportunity?.expected_pa)
      || !Number.isInteger(opportunity?.rounded_pa_for_simulation)
      || opportunity.rounded_pa_for_simulation < 1) {
      errors.push(`opportunity_model.by_lineup_slot.${slot}`);
    }
  }
  if (typeof model?.evaluation?.calibration_claim_supported !== 'boolean') {
    errors.push('evaluation.calibration_claim_supported');
  }
  return errors;
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function eventName(row) {
  return String(row?.events ?? row?.event ?? '').trim().toLowerCase();
}

function dateDay(value) {
  const parsed = new Date(`${String(value).slice(0, 10)}T00:00:00.000Z`).getTime();
  return Number.isFinite(parsed) ? Math.floor(parsed / DAY_MS) : null;
}

function normalizedName(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function emptyStats() {
  return {
    pa: 0, hr: 0, bip: 0, barrel: 0, hard_hit: 0, fly_ball: 0,
    pull_air: 0, ev_count: 0, ev_sum: 0, ev_sum_sq: 0,
  };
}

function cloneStats(stats = emptyStats()) {
  return Object.fromEntries(PROFILE_FIELDS.map((field) => [field, Number(stats[field] ?? 0)]));
}

function addStats(target, observation, direction = 1) {
  for (const field of PROFILE_FIELDS) target[field] += direction * Number(observation[field] ?? 0);
}

function sprayIsPull(row) {
  const x = finite(row?.hc_x ?? row?.hit_location_x);
  if (x == null) return false;
  const stand = String(row?.stand ?? '').toUpperCase();
  if (x >= 110 && x <= 140) return false;
  return stand === 'L' ? x > 125 : x < 125;
}

function rowObservation(row) {
  const event = eventName(row);
  const bip = Boolean(event) && !NON_BIP_TERMINAL_EVENTS.has(event);
  const ev = finite(row?.launch_speed ?? row?.launchSpeed);
  const la = finite(row?.launch_angle ?? row?.launchAngle);
  const barrel = String(row?.barrel ?? '').toLowerCase().match(/^(1|true|t|yes|barrel)$/)
    || finite(row?.launch_speed_angle) === 6;
  const flyBall = String(row?.bb_type ?? '').toLowerCase() === 'fly_ball' || (la != null && la >= 25);
  return {
    pa: 1,
    hr: event === 'home_run' ? 1 : 0,
    bip: bip ? 1 : 0,
    barrel: bip && barrel ? 1 : 0,
    hard_hit: bip && ev != null && ev >= 95 ? 1 : 0,
    fly_ball: bip && flyBall ? 1 : 0,
    pull_air: bip && flyBall && sprayIsPull(row) ? 1 : 0,
    ev_count: bip && ev != null ? 1 : 0,
    ev_sum: bip && ev != null ? ev : 0,
    ev_sum_sq: bip && ev != null ? ev * ev : 0,
  };
}

class RollingStats {
  constructor(days) {
    this.days = days;
    this.queue = [];
    this.offset = 0;
    this.total = emptyStats();
  }

  prune(currentDay) {
    while (this.offset < this.queue.length && currentDay - this.queue[this.offset].day >= this.days) {
      addStats(this.total, this.queue[this.offset].observation, -1);
      this.offset += 1;
    }
    if (this.offset > 128 && this.offset * 2 > this.queue.length) {
      this.queue = this.queue.slice(this.offset);
      this.offset = 0;
    }
  }

  snapshot(currentDay) {
    this.prune(currentDay);
    return cloneStats(this.total);
  }

  add(day, observation) {
    this.prune(day);
    this.queue.push({ day, observation });
    addStats(this.total, observation);
  }
}

function newPlayerState() {
  return {
    season: emptyStats(),
    seven: new RollingStats(7),
    thirty: new RollingStats(30),
    latest_date: null,
    player_name: null,
    stand: null,
  };
}

function stateSnapshot(state, day) {
  return {
    '7d': state ? state.seven.snapshot(day) : emptyStats(),
    '30d': state ? state.thirty.snapshot(day) : emptyStats(),
    season: state ? cloneStats(state.season) : emptyStats(),
  };
}

function addPlayerObservation(state, day, observation, row) {
  state.seven.add(day, observation);
  state.thirty.add(day, observation);
  addStats(state.season, observation);
  state.latest_date = String(row.game_date).slice(0, 10);
  state.player_name = row.player_name || state.player_name;
  state.stand = row.stand || state.stand;
}

function battingTeam(row) {
  return String(row?.inning_topbot ?? '').toLowerCase().startsWith('top')
    ? row?.away_team ?? null
    : row?.home_team ?? null;
}

function buildLineupSlots(rows) {
  const groups = new Map();
  for (const row of rows) {
    const game = String(row.game_pk ?? '');
    const team = battingTeam(row);
    const batter = String(row.batter ?? '');
    const atBat = finite(row.at_bat_number);
    if (!game || !team || !batter || atBat == null) continue;
    const key = `${game}|${team}`;
    if (!groups.has(key)) groups.set(key, new Map());
    const first = groups.get(key);
    if (!first.has(batter) || atBat < first.get(batter)) first.set(batter, atBat);
  }
  const slots = new Map();
  for (const [key, first] of groups) {
    const ordered = [...first.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
    for (let i = 0; i < Math.min(9, ordered.length); i += 1) {
      slots.set(`${key}|${ordered[i][0]}`, i + 1);
    }
  }
  return slots;
}

function sortRows(rows) {
  return [...rows]
    .filter(isTerminalPa)
    .sort((a, b) => String(a.game_date).localeCompare(String(b.game_date))
      || Number(a.game_pk ?? 0) - Number(b.game_pk ?? 0)
      || Number(a.at_bat_number ?? 0) - Number(b.at_bat_number ?? 0)
      || Number(a.batter ?? 0) - Number(b.batter ?? 0));
}

export function buildHistoricalFeatureRows(inputRows = [], { leagueReference = LEAGUE_REFERENCE_HR_PA } = {}) {
  assertNoPriceFields(inputRows, 'regular-game historical Statcast rows');
  const rows = sortRows(inputRows);
  const lineupSlots = buildLineupSlots(rows);
  const batters = new Map();
  const pitchers = new Map();
  const parks = new Map();
  const league = newPlayerState();
  const featureRows = [];

  const stateFor = (states, id) => {
    if (!states.has(id)) states.set(id, newPlayerState());
    return states.get(id);
  };
  let offset = 0;
  while (offset < rows.length) {
    const date = String(rows[offset].game_date).slice(0, 10);
    let end = offset + 1;
    while (end < rows.length && String(rows[end].game_date).slice(0, 10) === date) end += 1;
    const dayRows = rows.slice(offset, end);
    const day = dateDay(date);
    if (day != null) {
      // Pregame packets cannot know earlier outcomes from the same slate date.
      // Materialize every row first, then update all rolling profiles only
      // after the date is complete so train and runtime evidence align.
      for (const row of dayRows) {
        const batterId = String(row.batter ?? '');
        const pitcherId = String(row.pitcher ?? '');
        const parkId = String(row.home_team ?? '');
        if (!batterId || !pitcherId || !parkId) continue;
        const batter = stateFor(batters, batterId);
        const pitcher = stateFor(pitchers, pitcherId);
        const park = stateFor(parks, parkId);
        const leagueRate = league.season.pa > 0 ? league.season.hr / league.season.pa : leagueReference;
        const team = battingTeam(row);
        const slotKey = `${String(row.game_pk)}|${team}|${batterId}`;

        featureRows.push({
          date,
          game_pk: String(row.game_pk),
          batter_id: batterId,
          pitcher_id: pitcherId,
          player_name: row.player_name || null,
          team,
          park_id: parkId,
          lineup_slot: lineupSlots.get(slotKey) ?? null,
          stand: row.stand || null,
          p_throws: row.p_throws || null,
          batter: stateSnapshot(batter, day),
          pitcher: stateSnapshot(pitcher, day),
          park: stateSnapshot(park, day),
          league: stateSnapshot(league, day),
          league_rate: leagueRate,
          context: {
            roof: null,
            altitude: null,
            temperature: null,
            wind_out: null,
            directional_fit: null,
          },
          label: eventName(row) === 'home_run' ? 1 : 0,
        });
      }

      for (const row of dayRows) {
        const batterId = String(row.batter ?? '');
        const pitcherId = String(row.pitcher ?? '');
        const parkId = String(row.home_team ?? '');
        if (!batterId || !pitcherId || !parkId) continue;
        const observation = rowObservation(row);
        addPlayerObservation(stateFor(batters, batterId), day, observation, row);
        addPlayerObservation(stateFor(pitchers, pitcherId), day, observation, row);
        addPlayerObservation(stateFor(parks, parkId), day, observation, row);
        addPlayerObservation(league, day, observation, row);
      }
    }
    offset = end;
  }

  const finalDate = rows.at(-1)?.game_date?.slice(0, 10) ?? null;
  const finalDay = finalDate ? dateDay(finalDate) + 1 : null;
  const serializeStates = (states, kind) => Object.fromEntries([...states.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([id, state]) => [id, {
      id,
      kind,
      player_name: state.player_name,
      stand: state.stand,
      latest_event_date: state.latest_date,
      windows: finalDay == null ? null : stateSnapshot(state, finalDay),
    }]));

  return {
    featureRows,
    final_profiles: {
      as_of: finalDate,
      league: finalDay == null ? null : stateSnapshot(league, finalDay),
      batters: serializeStates(batters, 'batter'),
      pitchers: serializeStates(pitchers, 'pitcher'),
      parks: serializeStates(parks, 'park'),
    },
  };
}

function splitIndexByDate(dates, fraction) {
  return Math.max(1, Math.min(dates.length - 2, Math.floor(dates.length * fraction)));
}

export function splitChronologically(rows = [], { trainFraction = 0.70, validationFraction = 0.15 } = {}) {
  const sorted = [...rows].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const dates = [...new Set(sorted.map((row) => row.date))].sort();
  if (dates.length < 3) throw new Error('chronological split requires at least three distinct dates');
  const trainEndIndex = splitIndexByDate(dates, trainFraction);
  const validationEndIndex = Math.max(trainEndIndex + 1,
    Math.min(dates.length - 1, Math.floor(dates.length * (trainFraction + validationFraction))));
  const trainEnd = dates[trainEndIndex - 1];
  const validationEnd = dates[validationEndIndex - 1];
  const train = sorted.filter((row) => row.date <= trainEnd);
  const validation = sorted.filter((row) => row.date > trainEnd && row.date <= validationEnd);
  const test = sorted.filter((row) => row.date > validationEnd);
  if (!train.length || !validation.length || !test.length) throw new Error('chronological split produced an empty block');
  if (train.at(-1).date >= validation[0].date || validation.at(-1).date >= test[0].date) {
    throw new Error('chronological split overlap detected');
  }
  return {
    train, validation, test,
    ranges: {
      train: { start: train[0].date, end: train.at(-1).date, rows: train.length },
      validation: { start: validation[0].date, end: validation.at(-1).date, rows: validation.length },
      test: { start: test[0].date, end: test.at(-1).date, rows: test.length },
    },
  };
}

function ebRate(stats, numerator, denominator, leagueRate, priorStrength) {
  const n = Number(stats?.[denominator] ?? 0);
  const successes = Number(stats?.[numerator] ?? 0);
  return (successes + leagueRate * priorStrength) / (n + priorStrength);
}

function contactRate(stats, field, leagueStats, priorStrength) {
  const leagueRate = Number(leagueStats?.bip) > 0 ? Number(leagueStats[field] ?? 0) / leagueStats.bip : 0;
  return ebRate(stats, field, 'bip', leagueRate, priorStrength);
}

function evMoments(stats) {
  const n = Number(stats?.ev_count ?? 0);
  if (n <= 0) return { mean: 0, sd: 0, missing: 1 };
  const mean = stats.ev_sum / n;
  const variance = Math.max(0, stats.ev_sum_sq / n - mean * mean);
  return { mean, sd: Math.sqrt(variance), missing: 0 };
}

function contextValue(value, transform = (x) => x) {
  const n = finite(value);
  return n == null ? { value: 0, missing: 1 } : { value: transform(n), missing: 0 };
}

export function materializeFeatureVector(raw, { priorStrength }) {
  const leagueRate = Number.isFinite(raw?.league_rate) ? raw.league_rate : LEAGUE_REFERENCE_HR_PA;
  const batter7 = raw?.batter?.['7d'] ?? emptyStats();
  const batter30 = raw?.batter?.['30d'] ?? emptyStats();
  const batterSeason = raw?.batter?.season ?? emptyStats();
  const pitcher = raw?.pitcher?.season ?? emptyStats();
  const park = raw?.park?.season ?? emptyStats();
  const league30 = raw?.league?.['30d'] ?? emptyStats();
  const ev = evMoments(batter30);
  const stand = String(raw?.stand ?? '').toUpperCase();
  const throws = String(raw?.p_throws ?? '').toUpperCase();
  const handMissing = !['L', 'R'].includes(stand) || !['L', 'R'].includes(throws);
  const roof = raw?.context?.roof == null
    ? { value: 0, missing: 1 }
    : { value: /closed|dome|indoor/i.test(String(raw.context.roof)) ? 1 : 0, missing: 0 };
  const altitude = contextValue(raw?.context?.altitude);
  const temperature = contextValue(raw?.context?.temperature);
  const wind = contextValue(raw?.context?.wind_out);
  const direction = contextValue(raw?.context?.directional_fit);
  const pitcherRate = ebRate(pitcher, 'hr', 'pa', leagueRate, priorStrength);
  const parkRate = ebRate(park, 'hr', 'pa', leagueRate, priorStrength);

  const values = {
    batter_hr_pa_7d: ebRate(batter7, 'hr', 'pa', leagueRate, priorStrength),
    batter_hr_pa_30d: ebRate(batter30, 'hr', 'pa', leagueRate, priorStrength),
    batter_hr_pa_season: ebRate(batterSeason, 'hr', 'pa', leagueRate, priorStrength),
    batter_7d_missing: batter7.pa > 0 ? 0 : 1,
    batter_30d_missing: batter30.pa > 0 ? 0 : 1,
    batter_season_missing: batterSeason.pa > 0 ? 0 : 1,
    batter_barrel_rate_30d: contactRate(batter30, 'barrel', league30, priorStrength),
    batter_hard_hit_rate_30d: contactRate(batter30, 'hard_hit', league30, priorStrength),
    batter_fly_ball_rate_30d: contactRate(batter30, 'fly_ball', league30, priorStrength),
    batter_pull_air_rate_30d: contactRate(batter30, 'pull_air', league30, priorStrength),
    batter_ev_mean_30d: ev.mean,
    batter_ev_sd_30d: ev.sd,
    batter_contact_missing: ev.missing,
    pitcher_hr_pa_season: pitcherRate,
    pitcher_missing: pitcher.pa > 0 ? 0 : 1,
    park_hr_factor: leagueRate > 0 ? parkRate / leagueRate : 1,
    park_missing: park.pa > 0 ? 0 : 1,
    same_hand_matchup: handMissing ? 0 : (stand === throws ? 1 : 0),
    batter_left: stand === 'L' ? 1 : 0,
    pitcher_left: throws === 'L' ? 1 : 0,
    handedness_missing: handMissing ? 1 : 0,
    roof_closed: roof.value,
    roof_missing: roof.missing,
    altitude_feet: altitude.value,
    altitude_missing: altitude.missing,
    temperature_f: temperature.value,
    temperature_missing: temperature.missing,
    wind_out_mph: wind.value,
    wind_missing: wind.missing,
    directional_fit: direction.value,
    directional_fit_missing: direction.missing,
  };
  return FEATURE_NAMES.map((name) => values[name]);
}

function materializeExamples(rows, priorStrength) {
  return rows.map((raw) => ({
    x: materializeFeatureVector(raw, { priorStrength }),
    y: Number(raw.label),
    date: raw.date,
    raw,
  }));
}

function sigmoid(z) {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

function clampProbability(p) {
  return Math.min(1 - 1e-12, Math.max(1e-12, p));
}

function standardizer(examples) {
  const count = examples.length;
  const means = FEATURE_NAMES.map((_, j) => examples.reduce((sum, row) => sum + row.x[j], 0) / count);
  const scales = FEATURE_NAMES.map((_, j) => {
    const variance = examples.reduce((sum, row) => sum + (row.x[j] - means[j]) ** 2, 0) / count;
    const sd = Math.sqrt(variance);
    return sd > 1e-12 ? sd : 1;
  });
  return { means, scales };
}

function standardized(x, means, scales) {
  return x.map((value, index) => (value - means[index]) / scales[index]);
}

export function fitLogisticModel(examples, {
  lambda = 0.001,
  epochs = 18,
  learningRate = 0.025,
  batchSize = 512,
} = {}) {
  if (!examples.length) throw new Error('fitLogisticModel requires examples');
  const { means, scales } = standardizer(examples);
  const weights = Array(FEATURE_NAMES.length).fill(0);
  const m = Array(weights.length + 1).fill(0);
  const v = Array(weights.length + 1).fill(0);
  const baseRate = examples.reduce((sum, row) => sum + row.y, 0) / examples.length;
  let intercept = Math.log(clampProbability(baseRate) / (1 - clampProbability(baseRate)));
  let step = 0;

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    for (let start = 0; start < examples.length; start += batchSize) {
      const stop = Math.min(examples.length, start + batchSize);
      const gradient = Array(weights.length).fill(0);
      let interceptGradient = 0;
      for (let i = start; i < stop; i += 1) {
        const row = examples[i];
        const x = standardized(row.x, means, scales);
        let score = intercept;
        for (let j = 0; j < weights.length; j += 1) score += weights[j] * x[j];
        const error = sigmoid(score) - row.y;
        interceptGradient += error;
        for (let j = 0; j < weights.length; j += 1) gradient[j] += error * x[j];
      }
      const n = stop - start;
      step += 1;
      const update = (parameter, gradientValue, index) => {
        const g = gradientValue;
        m[index] = 0.9 * m[index] + 0.1 * g;
        v[index] = 0.999 * v[index] + 0.001 * g * g;
        const mHat = m[index] / (1 - 0.9 ** step);
        const vHat = v[index] / (1 - 0.999 ** step);
        return parameter - learningRate * mHat / (Math.sqrt(vHat) + 1e-8);
      };
      intercept = update(intercept, interceptGradient / n, 0);
      for (let j = 0; j < weights.length; j += 1) {
        weights[j] = update(weights[j], gradient[j] / n + lambda * weights[j], j + 1);
      }
    }
  }
  return {
    feature_names: [...FEATURE_NAMES],
    intercept,
    coefficients: weights,
    standardization: { means, scales },
    training: { lambda, epochs, learning_rate: learningRate, batch_size: batchSize, rows: examples.length },
  };
}

function rawModelProbability(model, x) {
  const { means, scales } = model.standardization;
  const z = standardized(x, means, scales);
  let score = model.intercept;
  for (let i = 0; i < model.coefficients.length; i += 1) score += model.coefficients[i] * z[i];
  return clampProbability(sigmoid(score));
}

function fitPlattCalibrator(predictions, labels) {
  let slope = 1;
  let intercept = 0;
  const x = predictions.map((p) => Math.log(clampProbability(p) / (1 - clampProbability(p))));
  for (let step = 0; step < 800; step += 1) {
    let gi = 0;
    let gs = 0;
    for (let i = 0; i < x.length; i += 1) {
      const error = sigmoid(intercept + slope * x[i]) - labels[i];
      gi += error;
      gs += error * x[i];
    }
    intercept -= 0.02 * gi / x.length;
    slope -= 0.002 * gs / x.length;
  }
  return { method: 'platt_validation', intercept, slope };
}

export function predictLogisticProbability(model, x) {
  const raw = rawModelProbability(model, x);
  const calibrator = model.calibration;
  if (!calibrator) return raw;
  const logit = Math.log(raw / (1 - raw));
  return clampProbability(sigmoid(calibrator.intercept + calibrator.slope * logit));
}

export function evaluateProbabilities(predictions, labels, { buckets = 10 } = {}) {
  if (!predictions.length || predictions.length !== labels.length) throw new Error('prediction/label length mismatch');
  let brier = 0;
  let logLoss = 0;
  for (let i = 0; i < predictions.length; i += 1) {
    const p = clampProbability(predictions[i]);
    const y = labels[i];
    brier += (p - y) ** 2;
    logLoss -= y * Math.log(p) + (1 - y) * Math.log(1 - p);
  }
  const ordered = predictions.map((prediction, index) => ({ prediction, label: labels[index], index }))
    .sort((a, b) => a.prediction - b.prediction || a.index - b.index);
  const calibration = [];
  const effectiveBuckets = Math.abs(ordered.at(-1).prediction - ordered[0].prediction) < 1e-15 ? 1 : buckets;
  for (let bucket = 0; bucket < effectiveBuckets; bucket += 1) {
    const start = Math.floor(bucket * ordered.length / effectiveBuckets);
    const end = Math.floor((bucket + 1) * ordered.length / effectiveBuckets);
    const values = ordered.slice(start, end);
    if (!values.length) continue;
    calibration.push({
      bucket: bucket + 1,
      predicted_mean: values.reduce((sum, row) => sum + row.prediction, 0) / values.length,
      observed_hr_rate: values.reduce((sum, row) => sum + row.label, 0) / values.length,
      n: values.length,
      prediction_min: values[0].prediction,
      prediction_max: values.at(-1).prediction,
    });
  }
  const observedRate = labels.reduce((sum, value) => sum + value, 0) / labels.length;
  const meanPrediction = predictions.reduce((sum, value) => sum + value, 0) / predictions.length;
  const expectedCalibrationError = calibration.reduce((sum, row) =>
    sum + (row.n / labels.length) * Math.abs(row.predicted_mean - row.observed_hr_rate), 0);
  return {
    rows: labels.length,
    home_runs: labels.reduce((sum, value) => sum + value, 0),
    brier_score: brier / labels.length,
    log_loss: logLoss / labels.length,
    observed_hr_pa: observedRate,
    mean_prediction: meanPrediction,
    mean_prediction_gap: meanPrediction - observedRate,
    expected_calibration_error: expectedCalibrationError,
    calibration,
  };
}

function tunePriorStrength(validationRows, candidates) {
  let best = null;
  for (const priorStrength of candidates) {
    const predictions = validationRows.map((row) => ebRate(
      row.batter.season, 'hr', 'pa', row.league_rate, priorStrength,
    ));
    const metrics = evaluateProbabilities(predictions, validationRows.map((row) => row.label));
    const candidate = { prior_strength: priorStrength, validation_log_loss: metrics.log_loss, validation_brier: metrics.brier_score };
    if (!best || candidate.validation_log_loss < best.validation_log_loss) best = candidate;
  }
  return best;
}

function fitOpportunityModel(rows) {
  const playerGames = new Map();
  for (const row of rows) {
    if (!Number.isInteger(row.lineup_slot)) continue;
    const key = `${row.game_pk}|${row.team}|${row.batter_id}`;
    const entry = playerGames.get(key) ?? { slot: row.lineup_slot, pa: 0 };
    entry.pa += 1;
    playerGames.set(key, entry);
  }
  const bySlot = {};
  for (let slot = 1; slot <= 9; slot += 1) {
    const values = [...playerGames.values()].filter((entry) => entry.slot === slot).map((entry) => entry.pa);
    bySlot[String(slot)] = {
      expected_pa: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
      rounded_pa_for_simulation: values.length ? Math.max(1, Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)) : null,
      batter_games: values.length,
    };
  }
  return {
    schema_version: 'cpc_mlb_lineup_slot_opportunity_v1',
    separation_note: 'Opportunity estimates PA count only; no contact-quality feature enters this model.',
    by_lineup_slot: bySlot,
  };
}

export function fitRegularGameModel(rows, {
  generatedUtc = '2026-07-13T00:00:00.000Z',
  priorCandidates = [8, 16, 32, 64, 128, 256],
  lambdaCandidates = [0, 0.0005, 0.005, 0.05],
  tuningEpochs = 10,
  finalEpochs = 22,
} = {}) {
  const historical = buildHistoricalFeatureRows(rows);
  const split = splitChronologically(historical.featureRows);
  const priorTuning = tunePriorStrength(split.validation, priorCandidates);
  const priorStrength = priorTuning.prior_strength;
  const trainExamples = materializeExamples(split.train, priorStrength);
  const validationExamples = materializeExamples(split.validation, priorStrength);
  let best = null;
  const regularizationSearch = [];
  for (const lambda of lambdaCandidates) {
    const candidateModel = fitLogisticModel(trainExamples, { lambda, epochs: tuningEpochs });
    const predictions = validationExamples.map((row) => rawModelProbability(candidateModel, row.x));
    const metrics = evaluateProbabilities(predictions, validationExamples.map((row) => row.y));
    const candidate = { lambda, validation_log_loss: metrics.log_loss, validation_brier: metrics.brier_score };
    regularizationSearch.push(candidate);
    if (!best || candidate.validation_log_loss < best.metrics.validation_log_loss) {
      best = { model: candidateModel, metrics: candidate };
    }
  }

  const finalModel = fitLogisticModel(trainExamples, { lambda: best.metrics.lambda, epochs: finalEpochs });
  const validationRaw = validationExamples.map((row) => rawModelProbability(finalModel, row.x));
  finalModel.calibration = fitPlattCalibrator(validationRaw, validationExamples.map((row) => row.y));

  // The held-out test block is first and only evaluated here, after every
  // shrinkage, regularization, and calibration choice is fixed.
  const testExamples = materializeExamples(split.test, priorStrength);
  const testPredictions = testExamples.map((row) => predictLogisticProbability(finalModel, row.x));
  const testLabels = testExamples.map((row) => row.y);
  const modelMetrics = evaluateProbabilities(testPredictions, testLabels);
  const baselineProbability = LEAGUE_REFERENCE_HR_PA;
  const baselineMetrics = evaluateProbabilities(testLabels.map(() => baselineProbability), testLabels);
  const beatsBaseline = modelMetrics.brier_score < baselineMetrics.brier_score
    && modelMetrics.log_loss < baselineMetrics.log_loss;
  const calibrationSupported = beatsBaseline
    && Math.abs(modelMetrics.mean_prediction_gap) <= 0.005
    && modelMetrics.expected_calibration_error <= 0.01;

  const artifact = {
    schema_version: REGULAR_GAME_MODEL_SCHEMA,
    generated_utc: generatedUtc,
    data: {
      source: 'Baseball Savant Statcast terminal PA rows',
      row_grain: 'one non-empty events row per terminal plate appearance',
      terminal_pa: rows.filter(isTerminalPa).length,
      home_runs: rows.filter((row) => eventName(row) === 'home_run').length,
      statcast_hr_pa: rows.filter((row) => eventName(row) === 'home_run').length / rows.filter(isTerminalPa).length,
      official_reference: {
        ...OFFICIAL_2025_REFERENCE,
        hr_pa: OFFICIAL_2025_REFERENCE.home_runs / OFFICIAL_2025_REFERENCE.plate_appearances,
        terminal_row_delta: rows.filter(isTerminalPa).length - OFFICIAL_2025_REFERENCE.plate_appearances,
        note: 'The supplied official denominator is a cross-check only; training retains every shared-predicate terminal Statcast row.',
      },
      date_range: {
        start: historical.featureRows[0]?.date ?? null,
        end: historical.featureRows.at(-1)?.date ?? null,
      },
      chronological_split: split.ranges,
      league_reference_hr_pa: LEAGUE_REFERENCE_HR_PA,
    },
    hyperparameters: {
      prior_strength: priorStrength,
      prior_candidates: [...priorCandidates],
      prior_validation: priorTuning,
      regularization_lambda: best.metrics.lambda,
      regularization_candidates: [...lambdaCandidates],
      regularization_search: regularizationSearch,
      selection_metric: 'validation_log_loss',
    },
    model: finalModel,
    opportunity_model: fitOpportunityModel(split.train),
    evaluation: {
      test_touched_once: true,
      model: modelMetrics,
      league_base_rate_baseline: {
        probability: baselineProbability,
        ...baselineMetrics,
      },
      beats_baseline_brier_and_log_loss: beatsBaseline,
      calibration_claim_supported: calibrationSupported,
      calibration_support_rule: 'beats baseline on Brier and log loss; absolute mean gap <= 0.005; ECE <= 0.01',
      conclusion: calibrationSupported
        ? 'Held-out evidence supports describing this fitted model as calibrated under the stated rule.'
        : 'Held-out evidence does not support a calibrated claim; outputs must be labeled uncalibrated.',
    },
    profiles: historical.final_profiles,
    provenance: {
      market_inputs_used: false,
      coefficients: 'fitted from chronological training rows; none are hand-authored',
      shrinkage: 'empirical-Bayes prior strength selected on validation rows',
      feature_cutoff: 'all rolling features are frozen at the start of each slate date; same-date outcomes are excluded',
      baseline: `constant official league reference HR/PA (${LEAGUE_REFERENCE_HR_PA})`,
      test_policy: 'latest chronological block evaluated once after model selection',
    },
  };
  assertNoPriceFields(artifact, 'fitted regular-game HR model artifact');
  return artifact;
}

export function loadRegularGameModel(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const errors = regularGameModelValidationErrors(parsed);
  if (errors.length) throw new Error(`invalid regular-game HR model artifact: ${errors.join(', ')}`);
  assertNoPriceFields(parsed, 'regular-game HR model artifact');
  return parsed;
}

function playerId(value) {
  const id = value?.mlb_id ?? value?.player_id ?? value?.batter_id ?? value?.id ?? null;
  return id == null || String(id).trim() === '' ? null : String(id);
}

export function matchBatterEvidence(player, candidates = []) {
  const id = playerId(player);
  if (id) {
    const matches = candidates.filter((candidate) => playerId(candidate) === id);
    if (matches.length === 1) return { status: 'matched', method: 'mlb_id', candidate: matches[0] };
    if (matches.length > 1) return { status: 'blocked', reason: 'AMBIGUOUS_MLB_ID', candidate: null };
    return { status: 'blocked', reason: 'MLB_ID_NOT_FOUND', candidate: null };
  }
  const name = normalizedName(player?.player_name ?? player?.name);
  if (!name) return { status: 'blocked', reason: 'PLAYER_IDENTITY_MISSING', candidate: null };
  const matches = candidates.filter((candidate) => normalizedName(candidate?.player_name ?? candidate?.name) === name);
  if (matches.length === 1) return { status: 'matched', method: 'unique_name_fallback', candidate: matches[0] };
  return {
    status: 'blocked',
    reason: matches.length > 1 ? 'AMBIGUOUS_NAME_MATCH' : 'NAME_NOT_FOUND',
    candidate: null,
  };
}

function sanitizedProfile(candidate, model) {
  const id = playerId(candidate);
  const artifactProfile = id ? model?.profiles?.batters?.[id] : null;
  const source = candidate?.windows ? candidate : artifactProfile;
  if (!source?.windows) return null;
  return {
    batter_id: id ?? source.id ?? null,
    player_name: candidate?.player_name ?? candidate?.name ?? source.player_name ?? null,
    stand: candidate?.stand ?? candidate?.hand ?? source.stand ?? null,
    latest_event_date: candidate?.latest_event_date ?? source.latest_event_date ?? null,
    windows: Object.fromEntries(['7d', '30d', 'season'].map((window) => [window, cloneStats(source.windows?.[window])])),
    lineup_slot: Number.isInteger(candidate?.lineup_slot) ? candidate.lineup_slot : null,
  };
}

function pitcherProfile(pitcher, model) {
  const id = playerId(pitcher);
  const source = pitcher?.windows ? pitcher : (id ? model?.profiles?.pitchers?.[id] : null);
  return {
    id,
    p_throws: pitcher?.p_throws ?? pitcher?.hand ?? null,
    latest_event_date: pitcher?.latest_event_date ?? source?.latest_event_date ?? null,
    season: cloneStats(source?.windows?.season),
  };
}

function parkProfile(park, model) {
  const id = String(park?.id ?? park?.team ?? park?.home_team ?? '');
  const source = park?.windows ? park : (id ? model?.profiles?.parks?.[id] : null);
  return { id, season: cloneStats(source?.windows?.season) };
}

function blockedProjection(reasons, player = null) {
  return {
    schema_version: REGULAR_GAME_PROJECTION_SCHEMA,
    status: 'blocked',
    model_status: 'MODEL_INSUFFICIENT',
    confidence: 'UNAVAILABLE',
    blocked_reasons: [...new Set(reasons)],
    player: player ? {
      mlb_id: playerId(player),
      player_name: player.player_name ?? player.name ?? null,
      lineup_slot: player.lineup_slot ?? null,
    } : null,
    outputs: null,
    assumptions: [],
    audit: { market_inputs_used: false },
  };
}

export function buildRegularGamePrediction(input = {}) {
  // Deliberately select the baseball allowlist before price assertion. Board
  // fields may coexist on an upstream record, but are ignored byte-for-byte.
  const safe = {
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
  };
  const model = safe.model;
  if (regularGameModelValidationErrors(model).length) {
    return blockedProjection(['MODEL_ARTIFACT_MISSING_OR_INVALID'], safe.player);
  }
  const player = safe.player ?? {};
  const match = matchBatterEvidence(player, Array.isArray(safe.candidates) ? safe.candidates : []);
  const reasons = [];
  if (safe.lineup_status !== 'confirmed') reasons.push('LINEUP_UNCONFIRMED');
  if (match.status !== 'matched') reasons.push(match.reason);
  const candidate = match.candidate;
  const profile = candidate ? sanitizedProfile(candidate, model) : null;
  if (!profile) reasons.push('BATTER_PROFILE_MISSING');
  if (profile && profile.windows.season.pa < 8) reasons.push('BATTER_SAMPLE_INSUFFICIENT');
  const asOfDay = safe.as_of ? dateDay(String(safe.as_of).slice(0, 10)) : null;
  if (asOfDay != null) {
    const latestDay = profile?.latest_event_date ? dateDay(profile.latest_event_date) : null;
    if (latestDay == null) reasons.push('BATTER_PROFILE_DATE_MISSING');
    else if (asOfDay - latestDay > 14) reasons.push('BATTER_PROFILE_STALE');
  }
  const lineupSlot = Number.isInteger(player.lineup_slot) ? player.lineup_slot : profile?.lineup_slot;
  if (!Number.isInteger(lineupSlot) || lineupSlot < 1 || lineupSlot > 9) reasons.push('LINEUP_SLOT_MISSING');
  const opportunity = Number.isInteger(lineupSlot)
    ? model.opportunity_model?.by_lineup_slot?.[String(lineupSlot)]
    : null;
  if (!Number.isInteger(opportunity?.rounded_pa_for_simulation)) reasons.push('OPPORTUNITY_MODEL_MISSING');
  const pitcher = pitcherProfile(safe.pitcher, model);
  if (pitcher.season.pa < 1) reasons.push('STARTING_PITCHER_PROFILE_MISSING');
  if (!['L', 'R'].includes(String(pitcher.p_throws).toUpperCase())) reasons.push('STARTER_HANDEDNESS_MISSING');
  if (asOfDay != null) {
    const pitcherLatestDay = pitcher.latest_event_date ? dateDay(pitcher.latest_event_date) : null;
    if (pitcherLatestDay == null) reasons.push('STARTING_PITCHER_PROFILE_DATE_MISSING');
    else if (asOfDay - pitcherLatestDay > 14) reasons.push('STARTING_PITCHER_PROFILE_STALE');
  }
  const park = parkProfile(safe.park, model);
  if (park.season.pa < 1) reasons.push('PARK_PROFILE_MISSING');
  if (reasons.length) return blockedProjection(reasons, { ...player, lineup_slot: lineupSlot });

  const leagueRate = model.data?.league_reference_hr_pa ?? LEAGUE_REFERENCE_HR_PA;
  const context = {
    roof: safe.park?.roof ?? safe.weather?.roof ?? null,
    altitude: safe.park?.altitude ?? null,
    temperature: safe.weather?.temperature_f ?? safe.weather?.temperature ?? null,
    wind_out: safe.weather?.wind_out_mph ?? null,
    directional_fit: safe.weather?.directional_fit ?? null,
  };
  const raw = {
    batter: profile.windows,
    pitcher: { season: pitcher.season },
    park: { season: park.season },
    league: model.profiles?.league ?? { '30d': emptyStats(), season: emptyStats() },
    league_rate: leagueRate,
    stand: profile.stand,
    p_throws: pitcher.p_throws,
    context,
  };
  assertNoPriceFields(raw, 'regular-game HR model input');
  const x = materializeFeatureVector(raw, { priorStrength: model.hyperparameters.prior_strength });
  const perPa = predictLogisticProbability(model.model, x);
  const expectedPa = opportunity.expected_pa;
  const simulationPa = opportunity.rounded_pa_for_simulation;
  const simulation = simulatePaOutcomes({
    seed: safe.seed ?? `cpc-hr-regular-${playerId(player) ?? normalizedName(player.player_name ?? player.name)}`,
    plate_appearances: simulationPa,
    hr_probability: perPa,
    simulations: Number.isInteger(safe.simulations) ? safe.simulations : 10_000,
  });
  const p0 = simulation.hr_count_distribution['0'] ?? 0;
  const p1 = simulation.hr_count_distribution['1'] ?? 0;
  const output = {
    per_pa_probability: perPa,
    expected_pa: expectedPa,
    expected_pa_fitted_mean: opportunity.expected_pa,
    simulation_plate_appearances: simulationPa,
    probability_at_least_one_hr: 1 - (1 - perPa) ** expectedPa,
    expected_home_runs: perPa * expectedPa,
    home_run_distribution: { '0': p0, '1': p1, '2_plus': Math.max(0, 1 - p0 - p1) },
  };
  const projection = {
    schema_version: REGULAR_GAME_PROJECTION_SCHEMA,
    status: 'ready',
    model_status: model.evaluation.calibration_claim_supported ? 'MODEL_READY_CALIBRATED' : 'MODEL_READY_UNCALIBRATED',
    confidence: model.evaluation.calibration_claim_supported ? 'HELD_OUT_SUPPORTED' : 'UNCALIBRATED',
    blocked_reasons: [],
    player: {
      mlb_id: playerId(player),
      player_name: player.player_name ?? player.name ?? profile.player_name,
      lineup_slot: lineupSlot,
      identity_match: match.method,
    },
    outputs: output,
    simulation: {
      seed: simulation.seed,
      simulations: simulation.simulations,
      rounded_plate_appearances: simulation.plate_appearances,
      distribution: output.home_run_distribution,
    },
    assumptions: [
      'Plate appearances are conditionally independent for the analytic any-HR formula.',
      'The fitted lineup-slot mean is rounded to an integer for the shared Monte Carlo engine.',
      'Missing roof, altitude, weather, and directional fields use explicit missingness indicators.',
    ],
    audit: {
      model_schema: model.schema_version,
      model_generated_utc: model.generated_utc,
      market_inputs_used: false,
      calibration_claim_supported: model.evaluation.calibration_claim_supported,
      feature_names: [...FEATURE_NAMES],
    },
  };
  assertNoPriceFields(projection, 'regular-game HR projection');
  return projection;
}

export function buildGameHrProjections({
  model,
  batters = [],
  evidence = [],
  opposing_pitchers = {},
  park = null,
  weather = null,
  lineup_status = null,
  seed = 'cpc-hr-regular-game',
  simulations = 10_000,
  as_of = null,
} = {}) {
  if (!Array.isArray(batters) || batters.length === 0) {
    return {
      schema_version: 'cpc_mlb_regular_game_hr_game_v1',
      status: 'blocked',
      model_status: 'MODEL_INSUFFICIENT',
      blocked_reasons: ['LINEUP_BATTER_EVIDENCE_MISSING'],
      outputs: [],
      audit: { market_inputs_used: false, ordering: 'descending modeled any-HR probability, then MLB ID' },
    };
  }
  const projections = batters.map((player) => {
    const side = player.side ?? player.team_side ?? null;
    if (!['away', 'home'].includes(side)) return blockedProjection(['TEAM_SIDE_MISSING'], player);
    const pitcher = side === 'away' ? opposing_pitchers.home : opposing_pitchers.away;
    return buildRegularGamePrediction({
      model, player, candidates: evidence, pitcher, park, weather, lineup_status,
      seed: `${seed}:${playerId(player) ?? normalizedName(player.player_name ?? player.name)}`,
      simulations, as_of,
    });
  });
  projections.sort((a, b) => {
    const ap = a.outputs?.probability_at_least_one_hr ?? -1;
    const bp = b.outputs?.probability_at_least_one_hr ?? -1;
    return bp - ap || String(a.player?.mlb_id ?? '').localeCompare(String(b.player?.mlb_id ?? ''));
  });
  const gameProjection = {
    schema_version: 'cpc_mlb_regular_game_hr_game_v1',
    status: projections.some((projection) => projection.status === 'ready') ? 'ready' : 'blocked',
    model_status: projections.some((projection) => projection.status === 'ready') ? 'MODEL_READY' : 'MODEL_INSUFFICIENT',
    blocked_reasons: projections.some((projection) => projection.status === 'ready')
      ? []
      : [...new Set(projections.flatMap((projection) => projection.blocked_reasons))],
    outputs: projections,
    audit: { market_inputs_used: false, ordering: 'descending modeled any-HR probability, then MLB ID' },
  };
  assertNoPriceFields(gameProjection, 'regular-game HR game projection');
  return gameProjection;
}
