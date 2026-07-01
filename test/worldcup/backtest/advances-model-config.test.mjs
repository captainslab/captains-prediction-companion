import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eloToLambdas, DEFAULT_ADVANCES_CONFIG } from '../../../scripts/worldcup/lib/advances-model.mjs';

test('default config is exported with the current constants', () => {
  // Recalibrated 600 -> 250 out-of-sample on 2018-2024 neutral results.
  assert.equal(DEFAULT_ADVANCES_CONFIG.eloGoalSupremacyDivisor, 250);
  assert.equal(DEFAULT_ADVANCES_CONFIG.baselineTotalGoals, 2.4);
});

test('omitting config reproduces the legacy lambdas exactly', () => {
  const legacy = eloToLambdas(1900, 1700);
  const explicit = eloToLambdas(1900, 1700, { config: DEFAULT_ADVANCES_CONFIG });
  assert.deepEqual(explicit, legacy);
});

test('a smaller divisor widens the favourite lambda', () => {
  const wide = eloToLambdas(1900, 1700, { config: { ...DEFAULT_ADVANCES_CONFIG, eloGoalSupremacyDivisor: 150 } });
  const base = eloToLambdas(1900, 1700);
  assert.ok(wide.lambdaTeam > base.lambdaTeam);
});
