import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluatePenaltyPrior } from '../../../scripts/worldcup/backtest/lib/penalty-test.mjs';

test('evaluatePenaltyPrior computes higher-Elo win rate', () => {
  const rows = JSON.parse(readFileSync(new URL('./fixtures/shootouts-sample.json', import.meta.url), 'utf8'));
  const out = evaluatePenaltyPrior(rows);
  assert.equal(out.n, 4);
  assert.ok(out.higherEloWinRate >= 0 && out.higherEloWinRate <= 1);
});
