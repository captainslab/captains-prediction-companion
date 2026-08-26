import test from 'node:test';
import assert from 'node:assert/strict';

import {
  joinPredictionBenchmarkRows,
  normalizeCountDistribution,
  summarizeBenchmark,
  totalSideProbability,
  validateHistoricalPrediction,
} from '../scripts/mlb/historical/benchmark-predictions.mjs';

function prediction(overrides = {}) {
  return {
    schema_version: 'cpc_mlb_historical_prediction_v1',
    game_pk: 745001,
    game_date: '2024-04-01',
    partition: 'B',
    start_time_utc: '2024-04-01T23:05:00Z',
    prediction_as_of_utc: '2024-04-01T18:00:00Z',
    trained_through: '2023-12-31',
    distribution_id: 'game_runs_745001',
    model_id: 'score-first-static-a',
    model_version: '1.0.0',
    model_config_sha256: 'abc123',
    outputs: {
      moneyline_home: 0.6,
      total_runs_distribution: {
        0: 0.02,
        1: 0.03,
        2: 0.05,
        3: 0.07,
        4: 0.08,
        5: 0.09,
        6: 0.1,
        7: 0.11,
        8: 0.12,
        9: 0.11,
        10: 0.08,
        11: 0.06,
        12: 0.04,
        13: 0.02,
        14: 0.01,
        '15_plus': 0.01,
      },
    },
    ...overrides,
  };
}

function marketRows() {
  return [
    {
      benchmark_eligible: true,
      game_pk: 745001,
      game_date: '2024-04-01',
      partition: 'B',
      start_time_utc: '2024-04-01T23:05:00Z',
      family: 'winner',
      market_line: null,
      side: 'home',
      selection: 'Arizona Diamondbacks',
      distribution_id: 'game_runs_745001',
      quote_clock: 'ARCHIVED_CLOSE',
      market_reference_prob: 0.55,
    },
    {
      benchmark_eligible: true,
      game_pk: 745001,
      game_date: '2024-04-01',
      partition: 'B',
      start_time_utc: '2024-04-01T23:05:00Z',
      family: 'winner',
      market_line: null,
      side: 'away',
      selection: 'New York Yankees',
      distribution_id: 'game_runs_745001',
      quote_clock: 'ARCHIVED_CLOSE',
      market_reference_prob: 0.45,
    },
    {
      benchmark_eligible: true,
      game_pk: 745001,
      game_date: '2024-04-01',
      partition: 'B',
      start_time_utc: '2024-04-01T23:05:00Z',
      family: 'game_total',
      market_line: 8,
      side: 'over',
      selection: 'OVER',
      distribution_id: 'game_runs_745001',
      quote_clock: 'ARCHIVED_CLOSE',
      market_reference_prob: 0.51,
    },
    {
      benchmark_eligible: true,
      game_pk: 745001,
      game_date: '2024-04-01',
      partition: 'B',
      start_time_utc: '2024-04-01T23:05:00Z',
      family: 'game_total',
      market_line: 8,
      side: 'under',
      selection: 'UNDER',
      distribution_id: 'game_runs_745001',
      quote_clock: 'ARCHIVED_CLOSE',
      market_reference_prob: 0.49,
    },
  ];
}

test('count distribution validates normalized integer and open-tail buckets', () => {
  const buckets = normalizeCountDistribution(prediction().outputs.total_runs_distribution);
  assert.ok(Array.isArray(buckets));
  assert.equal(buckets.at(-1).floor, 15);
  assert.equal(buckets.at(-1).open, true);
  assert.equal(normalizeCountDistribution({ 0: 0.7, 1: 0.7 }), null);
  assert.equal(normalizeCountDistribution({ bad: 1 }), null);
});

test('integer total fair probability conditions on non-push mass', () => {
  const dist = prediction().outputs.total_runs_distribution;
  const over = totalSideProbability(dist, 8, 'over');
  const under = totalSideProbability(dist, 8, 'under');
  assert.ok(over);
  assert.ok(under);
  assert.equal(over.conditioned_on_non_push, true);
  assert.equal(over.p_push, 0.12);
  assert.ok(Math.abs(over.probability + under.probability - 1) < 1e-6);
});

test('half-run total has no push conditioning', () => {
  const result = totalSideProbability(prediction().outputs.total_runs_distribution, 8.5, 'over');
  assert.ok(result);
  assert.equal(result.p_push, 0);
  assert.equal(result.conditioned_on_non_push, false);
});

test('open tail fails closed when the market line enters the unresolved bucket', () => {
  assert.equal(totalSideProbability(prediction().outputs.total_runs_distribution, 15, 'over'), null);
});

test('prediction validation enforces pregame timestamp, static-A cutoff, B/C only, and price isolation', () => {
  const valid = validateHistoricalPrediction(prediction());
  assert.equal(valid.game_pk, 745001);
  assert.equal(valid.partition, 'B');
  assert.equal(valid.outputs.moneyline_home, 0.6);

  assert.throws(
    () => validateHistoricalPrediction(prediction({ prediction_as_of_utc: '2024-04-01T23:05:00Z' })),
    /PREDICTION_NOT_PREGAME/,
  );
  assert.throws(
    () => validateHistoricalPrediction(prediction({ trained_through: '2024-01-01' })),
    /TRAINING_CUTOFF_VIOLATION/,
  );
  assert.throws(
    () => validateHistoricalPrediction(prediction({
      game_date: '2025-04-01',
      partition: 'D',
      start_time_utc: '2025-04-01T23:05:00Z',
      prediction_as_of_utc: '2025-04-01T18:00:00Z',
    })),
    /D_PARTITION_FORBIDDEN/,
  );
  assert.throws(
    () => validateHistoricalPrediction(prediction({ market_prob: 0.55 })),
    /price-isolation violation/,
  );
});

test('benchmark join scores winner and totals against post-event truth without touching D', () => {
  const outcomes = [{
    game_pk: 745001,
    game_date: '2024-04-01',
    status: 'Final',
    away_team: 'New York Yankees',
    home_team: 'Arizona Diamondbacks',
    away_runs: 4,
    home_runs: 6,
  }];
  const result = joinPredictionBenchmarkRows({
    marketRows: marketRows(),
    predictionRows: [prediction()],
    outcomeRows: outcomes,
  });

  assert.equal(result.validationErrors.length, 0);
  assert.equal(result.exclusions.length, 0);
  assert.equal(result.joined.length, 4);
  assert.equal(result.joined.filter(row => row.scoreable).length, 4);

  const home = result.joined.find(row => row.family === 'winner' && row.side === 'home');
  const away = result.joined.find(row => row.family === 'winner' && row.side === 'away');
  const over = result.joined.find(row => row.family === 'game_total' && row.side === 'over');
  const under = result.joined.find(row => row.family === 'game_total' && row.side === 'under');
  assert.equal(home.truth, 1);
  assert.equal(away.truth, 0);
  assert.equal(over.truth, 1);
  assert.equal(under.truth, 0);
  assert.equal(home.d_partition_touched, false);
  assert.equal(over.conditioned_on_non_push, true);
});

test('pushes are retained for audit but excluded from binary scoring', () => {
  const outcomes = [{
    game_pk: 745001,
    game_date: '2024-04-01',
    status: 'Final',
    away_runs: 4,
    home_runs: 4,
  }];
  const totalsOnly = marketRows().filter(row => row.family === 'game_total');
  const result = joinPredictionBenchmarkRows({
    marketRows: totalsOnly,
    predictionRows: [prediction()],
    outcomeRows: outcomes,
  });
  assert.equal(result.joined.length, 2);
  assert.ok(result.joined.every(row => row.outcome_status === 'PUSH'));
  assert.ok(result.joined.every(row => row.scoreable === false));
});

test('benchmark summary reports positive improvement when model Brier/logloss beat market', () => {
  const rows = [
    {
      scoreable: true,
      family: 'winner', partition: 'B', truth: 1,
      model_probability: 0.8, market_reference_prob: 0.6,
      model_brier: 0.04, market_brier: 0.16,
      model_logloss: -Math.log(0.8), market_logloss: -Math.log(0.6),
      model_minus_market_pp: 20,
    },
    {
      scoreable: true,
      family: 'winner', partition: 'B', truth: 0,
      model_probability: 0.2, market_reference_prob: 0.4,
      model_brier: 0.04, market_brier: 0.16,
      model_logloss: -Math.log(0.8), market_logloss: -Math.log(0.6),
      model_minus_market_pp: -20,
    },
  ];
  const summary = summarizeBenchmark(rows);
  assert.equal(summary.overall.n, 2);
  assert.ok(summary.overall.brier_improvement_vs_market > 0);
  assert.ok(summary.overall.logloss_improvement_vs_market > 0);
});
