import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SCRIPT = 'scripts/mlb/historical/build-static-a-score-baseline.py';

test('static-A score baseline self-test passes with stdlib Python only', () => {
  const output = execFileSync('python3', [SCRIPT, '--self-test'], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), { status: 'PASS' });
});

test('static-A baseline hard-codes A cutoff, rejects D/future input, and emits model-only schema', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  assert.match(source, /TRAIN_END="2023-12-31"/);
  assert.match(source, /D_OR_FUTURE_RETROSHEET_FORBIDDEN/);
  assert.match(source, /D_PARTITION_FORBIDDEN/);
  assert.match(source, /PRIOR_CALENDAR_DATE_ONLY/);
  assert.match(source, /STATIC_A_BASELINE_COMPARATOR_NOT_PRODUCTION_REPRODUCTION/);
  assert.match(source, /cpc_mlb_historical_prediction_v1/);
  assert.doesNotMatch(source, /yes_ask|no_ask|kalshi_ask|market_reference_prob|sportsbook.*odds/i);
});
