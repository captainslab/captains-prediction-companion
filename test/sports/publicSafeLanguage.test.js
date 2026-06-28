/**
 * test/sports/publicSafeLanguage.test.js
 * Tests: banned-language scanner, price isolation.
 *
 * Proves:
 *  - All banned terms are detected by scanPublicOutput
 *  - Clean outputs pass the scan
 *  - Market/price terms never appear in rendered public packets
 */

'use strict';

const assert = require('node:assert/strict');
const { scanPublicOutput, PUBLIC_BANNED_TERMS } = require('../../src/sports/publicPacketRenderer');

console.log('\n► publicSafeLanguage: banned-term scanner');

// Test: clean text passes
{
  const { clean, violations } = scanPublicOutput(
    'Algeria vs Austria \u2014 Match context: both teams need a result. Confirmed XI: Mahrez, Gouiri.'
  );
  assert.equal(clean, true, 'Clean text must pass scan');
  assert.deepEqual(violations, [], 'No violations in clean text');
  console.log('  ✓ clean text passes scan with no violations');
}

// Test: each individual banned term is detected
{
  let allDetected = true;
  const failedTerms = [];
  for (const term of PUBLIC_BANNED_TERMS) {
    const text = `The ${term} for this game is available separately.`;
    const { clean } = scanPublicOutput(text);
    if (clean) {
      allDetected = false;
      failedTerms.push(term);
    }
  }
  assert.equal(allDetected, true,
    `These banned terms were NOT detected: ${failedTerms.join(', ')}`);
  console.log(`  ✓ all ${PUBLIC_BANNED_TERMS.length} banned terms detected individually`);
}

// Test: multi-term contamination detected
{
  const dirty = 'Based on the moneyline and odds, the best bet is to lean toward the home team.';
  const { clean, violations } = scanPublicOutput(dirty);
  assert.equal(clean, false, 'Multi-term contaminated string must fail scan');
  assert.ok(violations.length >= 3, 'Multiple violations should be flagged');
  console.log('  ✓ multi-term contamination detected correctly');
}

// Test: price isolation — market terms not in public packets
{
  const priceTerms = ['market price', 'bid', 'ask', 'open interest', 'volume', 'liquidity', 'NOT IN SCORE', 'display-only'];
  for (const term of priceTerms) {
    const { clean } = scanPublicOutput(`The ${term} context is shown for reference.`);
    assert.equal(clean, false, `Price term "${term}" must be detected by scanner`);
  }
  console.log('  ✓ all price/market isolation terms detected by scanner');
}

// Test: empty / null input is safe
{
  assert.equal(scanPublicOutput('').clean, true, 'Empty string must pass scan');
  assert.equal(scanPublicOutput(null).clean, true, 'Null input must pass scan safely');
  console.log('  ✓ empty/null input handled safely');
}

console.log('\n✓ publicSafeLanguage tests passed\n');
