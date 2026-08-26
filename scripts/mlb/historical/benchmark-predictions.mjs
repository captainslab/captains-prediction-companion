#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { assertNoPriceFields } from '../lib/projection-contracts.mjs';

const DEFAULT_MARKET_LEDGER = 'artifacts/mlb-historical-market-ledger.json';
const DEFAULT_PREDICTIONS = 'artifacts/mlb-historical-predictions.jsonl';
const DEFAULT_OUT = 'artifacts/mlb-historical-model-benchmark.json';
const DEFAULT_OUT_JSONL = 'artifacts/mlb-historical-model-benchmark.jsonl';
const DEFAULT_OUTCOME_CACHE = 'artifacts/cache/mlb-historical-outcomes-bc.json';
const DEFAULT_MAX_TRAINED_THROUGH = '2023-12-31';
const PREDICTION_SCHEMA = 'cpc_mlb_historical_prediction_v1';
const EPS = 1e-12;

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round6(value) {
  return Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : null;
}

function isProbability(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function parseDate(value, label) {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new TypeError(`${label} must be YYYY-MM-DD; received ${value}`);
  }
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new TypeError(`${label} is invalid: ${value}`);
  }
  return text;
}

function parseTimestamp(value, label) {
  const text = String(value ?? '').trim();
  const ms = Date.parse(text);
  if (!text || !Number.isFinite(ms)) throw new TypeError(`${label} must be an ISO timestamp; received ${value}`);
  return { text, ms };
}

function partitionForDate(date) {
  if (date >= '2024-03-20' && date <= '2024-06-30') return 'B';
  if (date >= '2024-07-01' && date <= '2024-09-29') return 'C';
  if (date >= '2025-03-18' && date <= '2025-09-28') return 'D';
  return 'OUTSIDE';
}

function parseDistributionBucket(key) {
  const text = String(key ?? '').trim().toLowerCase();
  const match = text.match(/^(\d+)(?:_plus|\+)?$/);
  if (!match) return null;
  return {
    floor: Number(match[1]),
    open: /(?:_plus|\+)$/.test(text),
  };
}

export function normalizeCountDistribution(distribution) {
  if (!distribution || typeof distribution !== 'object' || Array.isArray(distribution)) return null;
  const buckets = [];
  let total = 0;
  for (const [key, raw] of Object.entries(distribution)) {
    const bucket = parseDistributionBucket(key);
    const probability = finite(raw);
    if (!bucket || !isProbability(probability)) return null;
    buckets.push({ ...bucket, probability });
    total += probability;
  }
  if (!buckets.length || Math.abs(total - 1) > 1e-3) return null;
  buckets.sort((a, b) => a.floor - b.floor || Number(a.open) - Number(b.open));
  return buckets;
}

export function totalSideProbability(distribution, lineValue, side) {
  const line = finite(lineValue);
  const buckets = normalizeCountDistribution(distribution);
  if (line === null || !buckets || !['over', 'under'].includes(side)) return null;

  let pOver = 0;
  let pUnder = 0;
  let pPush = 0;

  for (const bucket of buckets) {
    if (bucket.open) {
      // An open bucket K+ is safe only when the market line is below K. If the
      // line reaches or exceeds K, the exact split inside the bucket is unknown.
      if (line >= bucket.floor) return null;
      pOver += bucket.probability;
      continue;
    }
    if (bucket.floor > line) pOver += bucket.probability;
    else if (bucket.floor < line) pUnder += bucket.probability;
    else pPush += bucket.probability;
  }

  const decisionMass = pOver + pUnder;
  if (!(decisionMass > 0)) return null;
  const overConditional = pOver / decisionMass;
  const underConditional = pUnder / decisionMass;
  const probability = side === 'over' ? overConditional : underConditional;
  return {
    probability: round6(probability),
    p_over_unconditional: round6(pOver),
    p_under_unconditional: round6(pUnder),
    p_push: round6(pPush),
    conditioned_on_non_push: pPush > 0,
  };
}

function predictionOutputs(row) {
  return row?.outputs ?? row?.score_projection?.outputs ?? row?.score?.outputs ?? null;
}

function requiredText(row, key) {
  const text = String(row?.[key] ?? '').trim();
  if (!text) throw new TypeError(`prediction requires non-empty ${key}`);
  return text;
}

export function validateHistoricalPrediction(row, {
  maxTrainedThrough = DEFAULT_MAX_TRAINED_THROUGH,
} = {}) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new TypeError('prediction row must be an object');
  }

  // Predictions are the model-only side of the wall. Any market/price field in
  // this payload is a hard failure, not a warning.
  assertNoPriceFields(row, 'historical prediction row');

  if (row.schema_version !== PREDICTION_SCHEMA) {
    throw new TypeError(`prediction schema_version must be ${PREDICTION_SCHEMA}`);
  }
  const gamePk = Number(row.game_pk);
  if (!Number.isInteger(gamePk) || gamePk <= 0) throw new TypeError(`invalid game_pk: ${row.game_pk}`);
  const gameDate = parseDate(row.game_date, 'game_date');
  const partition = String(row.partition ?? partitionForDate(gameDate)).toUpperCase();
  if (!['B', 'C'].includes(partition)) {
    if (partition === 'D' || partitionForDate(gameDate) === 'D') throw new Error('D_PARTITION_FORBIDDEN');
    throw new Error(`prediction outside frozen B/C construction windows: ${gameDate}`);
  }
  if (partition !== partitionForDate(gameDate)) {
    throw new Error(`partition/date mismatch for game ${gamePk}: ${partition} vs ${partitionForDate(gameDate)}`);
  }

  const asOf = parseTimestamp(row.prediction_as_of_utc ?? row.as_of, 'prediction_as_of_utc');
  const start = parseTimestamp(row.start_time_utc, 'start_time_utc');
  if (!(asOf.ms < start.ms)) throw new Error(`PREDICTION_NOT_PREGAME:${gamePk}`);

  const trainedThrough = parseDate(row.trained_through, 'trained_through');
  const maxTrain = parseDate(maxTrainedThrough, 'max_trained_through');
  if (trainedThrough > maxTrain) {
    throw new Error(`TRAINING_CUTOFF_VIOLATION:${gamePk}:${trainedThrough}>${maxTrain}`);
  }

  const distributionId = requiredText(row, 'distribution_id');
  const modelId = requiredText(row, 'model_id');
  const modelVersion = requiredText(row, 'model_version');
  const configSha = requiredText(row, 'model_config_sha256');
  const outputs = predictionOutputs(row);
  if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) {
    throw new TypeError(`prediction outputs missing for game ${gamePk}`);
  }
  const moneylineHome = finite(outputs.moneyline_home ?? outputs.home_win_probability);
  if (!isProbability(moneylineHome)) {
    throw new TypeError(`outputs.moneyline_home must be a probability for game ${gamePk}`);
  }
  const totalDistribution = outputs.total_runs_distribution ?? null;
  if (totalDistribution != null && !normalizeCountDistribution(totalDistribution)) {
    throw new TypeError(`outputs.total_runs_distribution is invalid for game ${gamePk}`);
  }

  return {
    ...row,
    schema_version: PREDICTION_SCHEMA,
    game_pk: gamePk,
    game_date: gameDate,
    partition,
    prediction_as_of_utc: asOf.text,
    start_time_utc: start.text,
    trained_through: trainedThrough,
    distribution_id: distributionId,
    model_id: modelId,
    model_version: modelVersion,
    model_config_sha256: configSha,
    outputs: {
      ...outputs,
      moneyline_home: moneylineHome,
      total_runs_distribution: totalDistribution,
    },
  };
}

function parseJsonLines(text, sourcePath) {
  const rows = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`${sourcePath}:${i + 1} invalid JSONL: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return rows;
}

async function readRows(pathValue) {
  const sourcePath = resolve(pathValue);
  const text = await readFile(sourcePath, 'utf8');
  if (extname(sourcePath).toLowerCase() === '.jsonl') return parseJsonLines(text, sourcePath);
  const payload = JSON.parse(text);
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.rows)) return payload.rows;
  if (Array.isArray(payload?.predictions)) return payload.predictions;
  throw new TypeError(`${sourcePath} must be a JSON array, an object with rows/predictions, or JSONL`);
}

function outcomeUrl(runDate) {
  const url = new URL('https://statsapi.mlb.com/api/v1/schedule');
  url.searchParams.set('sportId', '1');
  url.searchParams.set('date', runDate);
  url.searchParams.set('hydrate', 'linescore,team');
  return url.toString();
}

function normalizeOutcomePayload(payload = {}) {
  const rows = [];
  for (const date of Array.isArray(payload.dates) ? payload.dates : []) {
    for (const game of Array.isArray(date.games) ? date.games : []) {
      rows.push({
        game_pk: game.gamePk ?? null,
        game_date: game.officialDate ?? date.date ?? null,
        status: game.status?.detailedState ?? game.status?.abstractGameState ?? null,
        away_team: game.teams?.away?.team?.name ?? null,
        home_team: game.teams?.home?.team?.name ?? null,
        away_runs: finite(game.teams?.away?.score),
        home_runs: finite(game.teams?.home?.score),
        innings: Array.isArray(game.linescore?.innings) ? game.linescore.innings.length : null,
      });
    }
  }
  return rows;
}

async function mapLimit(values, limit, fn) {
  const output = new Array(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(Number(limit) || 1, values.length || 1)) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      output[index] = await fn(values[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

async function loadOutcomeCache(cachePath) {
  if (!existsSync(cachePath)) return null;
  try {
    const payload = JSON.parse(await readFile(cachePath, 'utf8'));
    if (!Array.isArray(payload?.rows)) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function loadHistoricalOutcomes({
  dates,
  cachePath = DEFAULT_OUTCOME_CACHE,
  fetchImpl = globalThis.fetch,
  concurrency = 4,
  forceRefresh = false,
  now = new Date(),
} = {}) {
  const resolvedCache = resolve(cachePath);
  const wanted = [...new Set(dates)].sort();
  if (!forceRefresh) {
    const cached = await loadOutcomeCache(resolvedCache);
    const cachedDates = new Set(cached?.dates ?? []);
    if (cached && wanted.every(date => cachedDates.has(date))) return cached;
  }
  if (typeof fetchImpl !== 'function') throw new Error('No fetch implementation available for MLB outcome truth.');

  const daily = await mapLimit(wanted, concurrency, async runDate => {
    const url = outcomeUrl(runDate);
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': 'captains-prediction-companion-mlb-historical-benchmark/1.0',
      },
    });
    if (!response.ok) throw new Error(`MLB outcome request ${runDate} returned HTTP ${response.status}`);
    const payload = await response.json();
    return { run_date: runDate, source_url: url, rows: normalizeOutcomePayload(payload) };
  });

  const result = {
    schema_version: 1,
    generated_at_utc: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    source: 'MLB Stats API',
    usage: 'POST_EVENT_SCORING_ONLY',
    dates: wanted,
    source_urls: daily.map(day => day.source_url),
    rows: daily.flatMap(day => day.rows),
  };
  await mkdir(dirname(resolvedCache), { recursive: true });
  await writeFile(resolvedCache, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}

function outcomeForMarket(market, outcome) {
  if (!outcome || outcome.status !== 'Final' || outcome.away_runs === null || outcome.home_runs === null) {
    return { truth: null, result: 'MISSING_FINAL' };
  }
  if (market.family === 'winner') {
    if (outcome.away_runs === outcome.home_runs) return { truth: null, result: 'INVALID_TIE' };
    const homeWon = outcome.home_runs > outcome.away_runs;
    const selectedWon = market.side === 'home' ? homeWon : !homeWon;
    return { truth: selectedWon ? 1 : 0, result: selectedWon ? 'WIN' : 'LOSS' };
  }
  if (market.family === 'game_total') {
    const line = finite(market.market_line);
    if (line === null) return { truth: null, result: 'MISSING_LINE' };
    const actual = outcome.away_runs + outcome.home_runs;
    if (actual === line) return { truth: null, result: 'PUSH' };
    const selectedWon = market.side === 'over' ? actual > line : actual < line;
    return { truth: selectedWon ? 1 : 0, result: selectedWon ? 'WIN' : 'LOSS' };
  }
  return { truth: null, result: 'UNSUPPORTED_FAMILY' };
}

function modelProbabilityForMarket(market, prediction) {
  const outputs = prediction.outputs;
  if (market.family === 'winner') {
    const home = outputs.moneyline_home;
    if (!isProbability(home)) return null;
    return {
      probability: market.side === 'home' ? home : 1 - home,
      push_probability: 0,
      conditioned_on_non_push: false,
    };
  }
  if (market.family === 'game_total') {
    const total = totalSideProbability(outputs.total_runs_distribution, market.market_line, market.side);
    if (!total) return null;
    return {
      probability: total.probability,
      push_probability: total.p_push,
      conditioned_on_non_push: total.conditioned_on_non_push,
    };
  }
  return null;
}

function safeLogit(probability) {
  if (!isProbability(probability) || probability <= 0 || probability >= 1) return null;
  return Math.log(probability / (1 - probability));
}

function brier(probability, truth) {
  return (probability - truth) ** 2;
}

function logLoss(probability, truth) {
  const p = Math.min(1 - EPS, Math.max(EPS, probability));
  return -(truth * Math.log(p) + (1 - truth) * Math.log(1 - p));
}

export function joinPredictionBenchmarkRows({
  marketRows,
  predictionRows,
  outcomeRows,
  maxTrainedThrough = DEFAULT_MAX_TRAINED_THROUGH,
} = {}) {
  const validationErrors = [];
  const predictions = new Map();
  for (const raw of predictionRows) {
    try {
      const row = validateHistoricalPrediction(raw, { maxTrainedThrough });
      if (predictions.has(row.game_pk)) {
        validationErrors.push({ game_pk: row.game_pk, reason: 'DUPLICATE_PREDICTION' });
        predictions.delete(row.game_pk);
        continue;
      }
      predictions.set(row.game_pk, row);
    } catch (error) {
      validationErrors.push({
        game_pk: raw?.game_pk ?? null,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const outcomes = new Map(outcomeRows.map(row => [Number(row.game_pk), row]));
  const joined = [];
  const exclusions = [];

  for (const market of marketRows) {
    if (!market?.benchmark_eligible) continue;
    if (!['winner', 'game_total'].includes(market.family)) continue;
    if (market.partition === 'D' || partitionForDate(market.game_date) === 'D') {
      throw new Error('D_PARTITION_FORBIDDEN');
    }
    const prediction = predictions.get(Number(market.game_pk));
    if (!prediction) {
      exclusions.push({
        game_pk: market.game_pk,
        family: market.family,
        side: market.side,
        reason: 'NO_VALID_PREDICTION',
      });
      continue;
    }
    if (prediction.distribution_id !== market.distribution_id) {
      exclusions.push({
        game_pk: market.game_pk,
        family: market.family,
        side: market.side,
        reason: 'DISTRIBUTION_ID_MISMATCH',
        prediction_distribution_id: prediction.distribution_id,
        market_distribution_id: market.distribution_id,
      });
      continue;
    }
    const model = modelProbabilityForMarket(market, prediction);
    if (!model || !isProbability(model.probability)) {
      exclusions.push({ game_pk: market.game_pk, family: market.family, side: market.side, reason: 'MODEL_PROBABILITY_UNAVAILABLE' });
      continue;
    }
    const marketProbability = finite(market.market_reference_prob);
    if (!isProbability(marketProbability)) {
      exclusions.push({ game_pk: market.game_pk, family: market.family, side: market.side, reason: 'MARKET_REFERENCE_UNAVAILABLE' });
      continue;
    }
    const scored = outcomeForMarket(market, outcomes.get(Number(market.game_pk)) ?? null);
    const modelLogit = safeLogit(model.probability);
    const marketLogit = safeLogit(marketProbability);
    const scoreable = scored.truth === 0 || scored.truth === 1;

    joined.push({
      schema_version: 1,
      game_pk: market.game_pk,
      game_date: market.game_date,
      partition: market.partition,
      start_time_utc: market.start_time_utc,
      family: market.family,
      market_line: market.market_line ?? null,
      side: market.side,
      selection: market.selection,
      distribution_id: market.distribution_id,
      model_id: prediction.model_id,
      model_version: prediction.model_version,
      model_config_sha256: prediction.model_config_sha256,
      trained_through: prediction.trained_through,
      prediction_as_of_utc: prediction.prediction_as_of_utc,
      market_clock: market.quote_clock,
      market_reference_prob: round6(marketProbability),
      model_probability: round6(model.probability),
      model_minus_market_pp: round6((model.probability - marketProbability) * 100),
      model_minus_market_logit: modelLogit !== null && marketLogit !== null ? round6(modelLogit - marketLogit) : null,
      model_push_probability: round6(model.push_probability ?? 0),
      conditioned_on_non_push: Boolean(model.conditioned_on_non_push),
      outcome_status: scored.result,
      truth: scored.truth,
      scoreable,
      model_brier: scoreable ? round6(brier(model.probability, scored.truth)) : null,
      market_brier: scoreable ? round6(brier(marketProbability, scored.truth)) : null,
      model_logloss: scoreable ? round6(logLoss(model.probability, scored.truth)) : null,
      market_logloss: scoreable ? round6(logLoss(marketProbability, scored.truth)) : null,
      true_t_minus_30_available: false,
      d_partition_touched: false,
    });
  }

  return { joined, exclusions, validationErrors };
}

function mean(values) {
  const xs = values.filter(Number.isFinite);
  return xs.length ? xs.reduce((sum, value) => sum + value, 0) / xs.length : null;
}

function calibrationError(rows, field, bins = 10) {
  const usable = rows.filter(row => row.scoreable && isProbability(row[field]));
  if (!usable.length) return null;
  let weighted = 0;
  const detail = [];
  for (let i = 0; i < bins; i += 1) {
    const lo = i / bins;
    const hi = (i + 1) / bins;
    const bucket = usable.filter(row => row[field] >= lo && (i === bins - 1 ? row[field] <= hi : row[field] < hi));
    if (!bucket.length) continue;
    const confidence = mean(bucket.map(row => row[field]));
    const observed = mean(bucket.map(row => row.truth));
    const error = Math.abs(confidence - observed);
    weighted += (bucket.length / usable.length) * error;
    detail.push({
      bin: i + 1,
      n: bucket.length,
      mean_probability: round6(confidence),
      observed_rate: round6(observed),
      abs_error: round6(error),
    });
  }
  return { ece: round6(weighted), bins: detail };
}

export function summarizeBenchmark(rows = []) {
  const scoreable = rows.filter(row => row.scoreable);
  const summaryFor = subset => {
    const modelBrier = mean(subset.map(row => row.model_brier));
    const marketBrier = mean(subset.map(row => row.market_brier));
    const modelLogloss = mean(subset.map(row => row.model_logloss));
    const marketLogloss = mean(subset.map(row => row.market_logloss));
    return {
      n: subset.length,
      model_brier: round6(modelBrier),
      market_brier: round6(marketBrier),
      brier_improvement_vs_market: modelBrier !== null && marketBrier !== null ? round6(marketBrier - modelBrier) : null,
      model_logloss: round6(modelLogloss),
      market_logloss: round6(marketLogloss),
      logloss_improvement_vs_market: modelLogloss !== null && marketLogloss !== null ? round6(marketLogloss - modelLogloss) : null,
      mean_abs_model_market_delta_pp: round6(mean(subset.map(row => Math.abs(row.model_minus_market_pp)))),
      model_calibration: calibrationError(subset, 'model_probability'),
      market_calibration: calibrationError(subset, 'market_reference_prob'),
    };
  };

  const byFamily = {};
  for (const family of [...new Set(scoreable.map(row => row.family))].sort()) {
    byFamily[family] = summaryFor(scoreable.filter(row => row.family === family));
  }
  const byPartition = {};
  for (const partition of ['B', 'C']) {
    byPartition[partition] = summaryFor(scoreable.filter(row => row.partition === partition));
  }
  const byFamilyPartition = {};
  for (const family of Object.keys(byFamily)) {
    byFamilyPartition[family] = {};
    for (const partition of ['B', 'C']) {
      byFamilyPartition[family][partition] = summaryFor(scoreable.filter(row => row.family === family && row.partition === partition));
    }
  }

  return {
    overall: summaryFor(scoreable),
    by_family: byFamily,
    by_partition: byPartition,
    by_family_partition: byFamilyPartition,
  };
}

export async function runHistoricalPredictionBenchmark({
  marketLedgerPath = DEFAULT_MARKET_LEDGER,
  predictionsPath = DEFAULT_PREDICTIONS,
  out = DEFAULT_OUT,
  jsonlOut = DEFAULT_OUT_JSONL,
  outcomeCache = DEFAULT_OUTCOME_CACHE,
  maxTrainedThrough = DEFAULT_MAX_TRAINED_THROUGH,
  fetchImpl = globalThis.fetch,
  concurrency = 4,
  refreshOutcomes = false,
  now = new Date(),
} = {}) {
  const marketPayload = JSON.parse(await readFile(resolve(marketLedgerPath), 'utf8'));
  const marketRows = Array.isArray(marketPayload?.rows) ? marketPayload.rows : [];
  if (!marketRows.length) throw new Error(`Market ledger has no rows: ${marketLedgerPath}`);
  const predictionRows = await readRows(predictionsPath);
  if (!predictionRows.length) throw new Error(`Prediction ledger has no rows: ${predictionsPath}`);

  const dates = [...new Set(marketRows.filter(row => row.benchmark_eligible).map(row => row.game_date).filter(Boolean))].sort();
  if (dates.some(date => partitionForDate(date) === 'D')) throw new Error('D_PARTITION_FORBIDDEN');
  const outcomes = await loadHistoricalOutcomes({
    dates,
    cachePath: outcomeCache,
    fetchImpl,
    concurrency,
    forceRefresh: refreshOutcomes,
    now,
  });
  const { joined, exclusions, validationErrors } = joinPredictionBenchmarkRows({
    marketRows,
    predictionRows,
    outcomeRows: outcomes.rows,
    maxTrainedThrough,
  });
  const summary = summarizeBenchmark(joined);
  const scoreableRows = joined.filter(row => row.scoreable).length;

  const report = {
    schema_version: 1,
    generated_at_utc: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    scope: {
      market_ledger: resolve(marketLedgerPath),
      predictions: resolve(predictionsPath),
      outcome_cache: resolve(outcomeCache),
      prediction_schema: PREDICTION_SCHEMA,
      max_trained_through: maxTrainedThrough,
      partitions: ['B', 'C'],
      d_partition_touched: false,
    },
    methodology: {
      price_isolation: 'Prediction rows are rejected if market/price fields appear anywhere in the payload.',
      pregame_gate: 'prediction_as_of_utc must be strictly earlier than start_time_utc.',
      training_gate: `trained_through must be <= ${maxTrainedThrough}.`,
      market_reference: 'Only benchmark_eligible rows from the frozen historical market ledger are used.',
      totals: 'Model over/under probabilities are conditioned on non-push mass when the archived total is an integer.',
      outcomes: 'MLB Stats API final scores are fetched only after predictions are frozen and are used for scoring only.',
      clv: 'Archived close is a benchmark. True T-30 history is unavailable and is not claimed.',
    },
    counts: {
      market_rows: marketRows.length,
      prediction_rows_input: predictionRows.length,
      prediction_validation_errors: validationErrors.length,
      joined_rows: joined.length,
      scoreable_rows: scoreableRows,
      exclusions: exclusions.length,
    },
    summary,
    prediction_validation_errors: validationErrors,
    exclusions,
    rows: joined,
  };

  const outputPath = resolve(out);
  const jsonlPath = resolve(jsonlOut);
  await mkdir(dirname(outputPath), { recursive: true });
  await mkdir(dirname(jsonlPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(jsonlPath, joined.map(row => JSON.stringify(row)).join('\n') + (joined.length ? '\n' : ''), 'utf8');
  return { outputPath, jsonlPath, report };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--market-ledger') args.marketLedgerPath = argv[++i];
    else if (token === '--predictions') args.predictionsPath = argv[++i];
    else if (token === '--out') args.out = argv[++i];
    else if (token === '--jsonl-out') args.jsonlOut = argv[++i];
    else if (token === '--outcome-cache') args.outcomeCache = argv[++i];
    else if (token === '--max-trained-through') args.maxTrainedThrough = argv[++i];
    else if (token === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (token === '--refresh-outcomes') args.refreshOutcomes = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new TypeError(`Unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/mlb/historical/benchmark-predictions.mjs --predictions PATH',
    '',
    'Required prediction-row contract:',
    `  schema_version: ${PREDICTION_SCHEMA}`,
    '  game_pk, game_date, partition, start_time_utc, prediction_as_of_utc',
    '  trained_through, distribution_id, model_id, model_version, model_config_sha256',
    '  outputs.moneyline_home',
    '  outputs.total_runs_distribution for game-total benchmarking',
    '',
    'Defaults:',
    `  market ledger: ${DEFAULT_MARKET_LEDGER}`,
    `  predictions:   ${DEFAULT_PREDICTIONS}`,
    `  output:        ${DEFAULT_OUT}`,
    `  max training:  ${DEFAULT_MAX_TRAINED_THROUGH}`,
    '',
    'D is rejected. Market fields in prediction payloads are rejected. True T-30 CLV is not claimed.',
  ].join('\n');
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
      process.exit(0);
    }
    if (!existsSync(resolve(args.predictionsPath ?? DEFAULT_PREDICTIONS))) {
      throw new Error(`Prediction ledger not found: ${resolve(args.predictionsPath ?? DEFAULT_PREDICTIONS)}`);
    }
    const { outputPath, jsonlPath, report } = await runHistoricalPredictionBenchmark(args);
    console.log(JSON.stringify({
      status: report.counts.prediction_validation_errors || report.counts.exclusions ? 'DEGRADED' : 'OK',
      output: outputPath,
      jsonl_output: jsonlPath,
      counts: report.counts,
      summary: report.summary,
    }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  }
}
