import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNeutral } from '../../../scripts/worldcup/backtest/lib/neutral.mjs';

test('home venue is not neutral', () => {
  assert.equal(isNeutral({ homeCode: 'FR', awayCode: 'SE', venueCode: 'FR' }), false);
});
test('third-country venue is neutral', () => {
  assert.equal(isNeutral({ homeCode: 'AR', awayCode: 'FR', venueCode: 'QA' }), true);
});
test('null venue defaults to not neutral', () => {
  assert.equal(isNeutral({ homeCode: 'AR', awayCode: 'FR', venueCode: null }), false);
});
