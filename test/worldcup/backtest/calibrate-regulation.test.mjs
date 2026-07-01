import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateConfig, tuneRegulation } from '../../../scripts/worldcup/backtest/lib/calibrate-regulation.mjs';
import { DEFAULT_ADVANCES_CONFIG } from '../../../scripts/worldcup/lib/advances-model.mjs';

const recs = [
  { date: '2022-12-18', homeElo: 2144, awayElo: 2081, neutral: true, outcome: 'draw' },
  { date: '2022-12-14', homeElo: 2075, awayElo: 1893, neutral: true, outcome: 'home' },
  { date: '2019-06-10', homeElo: 1700, awayElo: 1640, neutral: false, outcome: 'draw' },
  { date: '2018-07-15', homeElo: 2000, awayElo: 1850, neutral: true, outcome: 'home' },
];

test('evaluateConfig returns finite metrics', () => {
  const m = evaluateConfig(recs, DEFAULT_ADVANCES_CONFIG);
  assert.ok(Number.isFinite(m.brier) && Number.isFinite(m.logLoss) && m.n === 4);
});

test('tuneRegulation reports baseline + best + held-out test metrics', () => {
  const grid = [DEFAULT_ADVANCES_CONFIG, { ...DEFAULT_ADVANCES_CONFIG, eloGoalSupremacyDivisor: 500 }];
  const out = tuneRegulation(recs, grid);
  assert.ok(out.best && out.test && out.baseline);
  assert.ok(Number.isFinite(out.test.logLoss));
});
