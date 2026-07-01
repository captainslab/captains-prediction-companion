import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spotCheckAdvance } from '../../../scripts/worldcup/backtest/lib/composite-spotcheck.mjs';

test('spotCheckAdvance scores Brier of p_advance vs actual advancer', () => {
  const ties = [
    { homeElo: 2100, awayElo: 1700, neutral: true, advanced: 'home' },
    { homeElo: 1700, awayElo: 2100, neutral: true, advanced: 'away' },
  ];
  const out = spotCheckAdvance(ties);
  assert.equal(out.n, 2);
  assert.ok(out.brier >= 0 && out.brier <= 1);
});
