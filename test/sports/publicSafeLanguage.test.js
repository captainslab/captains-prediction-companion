'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { scanPublicOutput, PUBLIC_BANNED_TERMS } = require('../../src/sports/publicPacketRenderer.js');

test('clean text passes the public scan', () => {
  const result = scanPublicOutput('Algeria vs Austria - confirmed XI and neutral match context.');
  assert.equal(result.clean, true);
  assert.deepEqual(result.violations, []);
});

test('every banned term is detected individually', () => {
  for (const term of PUBLIC_BANNED_TERMS) {
    const result = scanPublicOutput(`The ${term} context is available separately.`);
    assert.equal(result.clean, false, `term "${term}" should be detected`);
  }
});

test('multi-term contamination is rejected', () => {
  const dirty = 'Based on the moneyline and odds, the best bet is to lean toward the home team.';
  const result = scanPublicOutput(dirty);
  assert.equal(result.clean, false);
  assert.ok(result.violations.length >= 3);
});

test('market-style public disclosure terms are also rejected', () => {
  const priceTerms = ['market', 'price', 'odds', 'market price', 'bid', 'ask', 'open interest', 'volume', 'liquidity', 'NOT IN SCORE', 'display-only'];
  for (const term of priceTerms) {
    const result = scanPublicOutput(`The ${term} context is shown for reference.`);
    assert.equal(result.clean, false, `term "${term}" should be detected`);
  }
});

test('empty and null inputs stay safe', () => {
  assert.equal(scanPublicOutput('').clean, true);
  assert.equal(scanPublicOutput(null).clean, true);
});
