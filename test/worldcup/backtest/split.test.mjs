import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitTrainTest } from '../../../scripts/worldcup/backtest/lib/split.mjs';

const recs = Array.from({ length: 100 }, (_, i) => ({ date: `2020-01-${(i % 28) + 1}`, homeElo: 1500 + i, awayElo: 1600 }));

test('split is deterministic and partitions fully', () => {
  const a = splitTrainTest(recs, { testFraction: 0.3 });
  const b = splitTrainTest(recs, { testFraction: 0.3 });
  assert.equal(a.train.length + a.test.length, recs.length);
  assert.deepEqual(a.test.map(r => r.homeElo), b.test.map(r => r.homeElo));
  assert.ok(a.test.length > 15 && a.test.length < 45);
});
