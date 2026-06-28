/**
 * test/sports/perplexityClient.test.js
 * Tests: no-key safe fallback, prompt audit (banned terms), retry behavior.
 */

'use strict';

const assert = require('node:assert/strict');
const { auditPrompt, buildSafeFallback, BANNED_PROMPT_TERMS } = require('../../src/sports/perplexityClient');

// ─── auditPrompt ──────────────────────────────────────────────────────────────

console.log('\n► perplexityClient: auditPrompt');

{
  const result = auditPrompt('Tell me about today\'s game weather and injury reports.');
  assert.equal(result.safe, true, 'Clean prompt should be safe');
  assert.deepEqual(result.violations, [], 'No violations in clean prompt');
  console.log('  ✓ clean prompt passes audit');
}

{
  const result = auditPrompt('What are the betting odds and moneyline for this game?');
  assert.equal(result.safe, false, 'Prompt with banned terms should fail');
  assert.ok(result.violations.includes('betting'), 'Should flag \'betting\'');
  assert.ok(result.violations.includes('moneyline'), 'Should flag \'moneyline\'');
  console.log('  ✓ prompt with banned terms fails audit and lists violations');
}

{
  // Every term in the banned list should trigger individually
  for (const term of BANNED_PROMPT_TERMS) {
    const result = auditPrompt(`Research the ${term} for this match.`);
    assert.equal(result.safe, false, `Term "${term}" should trigger audit failure`);
  }
  console.log(`  ✓ all ${BANNED_PROMPT_TERMS.length} banned terms individually trigger audit failure`);
}

// ─── buildSafeFallback ──────────────────────────────────────────────────────────

console.log('\n► perplexityClient: buildSafeFallback (no-key / API-failure path)');

{
  const fb = buildSafeFallback('mlb', 'no_api_key');
  assert.equal(fb._meta.status, 'unavailable', 'Status must be unavailable');
  assert.equal(fb._meta.reason, 'no_api_key', 'Reason must be no_api_key');
  assert.equal(fb._meta.parse_status, 'fallback', 'Parse status must be fallback');
  assert.deepEqual(fb._meta.missing_fields, ['all'], 'All fields must be listed as missing');
  assert.equal(fb.research, null, 'research must be null in safe fallback');
  assert.equal(fb._meta.cost_usd, null, 'cost_usd must be null in safe fallback');
  console.log('  ✓ safe fallback structure is correct for no_api_key');
}

{
  const fb = buildSafeFallback('worldcup', 'api_failure:ECONNREFUSED');
  assert.equal(fb._meta.status, 'unavailable');
  assert.ok(fb._meta.reason.startsWith('api_failure'));
  assert.equal(fb.research, null);
  console.log('  ✓ safe fallback structure is correct for api_failure');
}

console.log('\n✓ perplexityClient tests passed\n');
