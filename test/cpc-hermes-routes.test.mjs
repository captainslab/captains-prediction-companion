import test from 'node:test';
import assert from 'node:assert/strict';

import { buildHermesArgs, resolveRoute } from '../scripts/hermes/cpc-role-route.mjs';

test('alpha-hunter resolves to openai-codex:gpt-5.4-mini', () => {
  const route = resolveRoute('alpha-hunter');
  assert.equal(route.role_key, 'alpha_hunter');
  assert.equal(route.alias, 'alpha-hunter');
  assert.equal(route.provider, 'openai-codex');
  assert.equal(route.model, 'gpt-5.4-mini');
});

test('market-hunter resolves to kimi-coding:kimi-k2.6', () => {
  const route = resolveRoute('market-hunter');
  assert.equal(route.role_key, 'market_hunter');
  assert.equal(route.alias, 'market-hunter');
  assert.equal(route.provider, 'kimi-coding');
  assert.equal(route.model, 'kimi-k2.6');
});

test('buildHermesArgs accepts aliases and emits the Hermes alias', () => {
  const alphaArgs = buildHermesArgs('alpha-hunter', { query: 'research topic', maxTurns: 8 });
  const marketArgs = buildHermesArgs('market-hunter', { query: 'market topic', maxTurns: 4 });

  assert.deepEqual(alphaArgs.slice(0, 4), ['chat', '-Q', '--max-turns', '8']);
  assert.equal(alphaArgs[alphaArgs.indexOf('-m') + 1], 'alpha-hunter');
  assert.equal(alphaArgs[alphaArgs.indexOf('-q') + 1], 'research topic');

  assert.deepEqual(marketArgs.slice(0, 4), ['chat', '-Q', '--max-turns', '4']);
  assert.equal(marketArgs[marketArgs.indexOf('-m') + 1], 'market-hunter');
  assert.equal(marketArgs[marketArgs.indexOf('-q') + 1], 'market topic');
});
