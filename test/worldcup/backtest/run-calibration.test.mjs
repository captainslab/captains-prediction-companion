import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../../../scripts/worldcup/backtest/run-calibration.mjs';
import { DEFAULT_ADVANCES_CONFIG } from '../../../scripts/worldcup/lib/advances-model.mjs';

test('buildReport assembles regulation + penalty sections', () => {
  const records = [
    { date: '2022-12-18', homeElo: 2144, awayElo: 2081, neutral: true, outcome: 'draw' },
    { date: '2022-12-14', homeElo: 2075, awayElo: 1893, neutral: true, outcome: 'home' },
    { date: '2018-07-15', homeElo: 2000, awayElo: 1850, neutral: true, outcome: 'home' },
  ];
  const report = buildReport({ records, grid: [DEFAULT_ADVANCES_CONFIG], shootouts: [{ higherEloWon: true }] });
  assert.ok(report.regulation.test && report.penalty.n === 1);
  assert.equal(report.sample_sizes.regulation, 3);
});
