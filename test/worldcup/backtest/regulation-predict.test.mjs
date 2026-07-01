import { test } from 'node:test';
import assert from 'node:assert/strict';
import { predictRegulation } from '../../../scripts/worldcup/backtest/lib/regulation-predict.mjs';

test('probabilities sum to ~1', () => {
  const p = predictRegulation({ homeElo: 1900, awayElo: 1700, neutral: false });
  assert.ok(Math.abs(p.pHome + p.pDraw + p.pAway - 1) < 1e-6);
});
test('stronger team is favoured', () => {
  const p = predictRegulation({ homeElo: 2100, awayElo: 1600, neutral: true });
  assert.ok(p.pHome > p.pAway);
});
