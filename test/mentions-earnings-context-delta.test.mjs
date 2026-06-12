import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DELTA_CLASSES,
  ADJUSTMENT_DIRECTIONS,
  CAPPED_MAX_POSTURE,
  DECLARED_SOURCE_KEYS,
  stripPriceLikeFields,
  termMatchesText,
  classifyTermDelta,
  buildEarningsContextDelta,
  postureAdjustmentHint,
} from '../scripts/mentions/earnings-context-delta.mjs';

function fixtureSources(overrides = {}) {
  return {
    prior_call_themes: ['AI', 'cloud growth', 'share buyback'],
    prepared_remarks_summary: 'We discussed AI adoption and cloud growth across enterprise customers.',
    analyst_qa_topics: ['AI monetization', 'margins'],
    current_press_release: 'Record quarter driven by AI demand and improving margins.',
    current_guidance: 'Guidance raised on AI demand.',
    current_preview: 'Analysts expect questions about tariffs and AI.',
    known_issues: ['supply constraints'],
    current_catalysts: ['AI datacenter ramp', 'tariffs'],
    ...overrides,
  };
}

test('delta classification is deterministic for identical inputs', () => {
  const a = classifyTermDelta('AI', fixtureSources());
  const b = classifyTermDelta('AI', fixtureSources());
  assert.equal(a, b);
  assert.ok(DELTA_CLASSES.includes(a));
  const r1 = buildEarningsContextDelta({ strikeTerms: ['AI', 'tariffs'], declaredSources: fixtureSources() });
  const r2 = buildEarningsContextDelta({ strikeTerms: ['AI', 'tariffs'], declaredSources: fixtureSources() });
  assert.deepEqual(JSON.parse(JSON.stringify(r1)), JSON.parse(JSON.stringify(r2)));
});

test('continuing vs strengthening vs fading vs new_catalyst vs absent', () => {
  // prior + current catalyst -> strengthening
  assert.equal(classifyTermDelta('AI', fixtureSources()), 'strengthening');
  // prior + current text but not a catalyst -> continuing
  assert.equal(classifyTermDelta('margins', fixtureSources()), 'continuing');
  // prior only -> fading
  assert.equal(classifyTermDelta('share buyback', fixtureSources()), 'fading');
  // current catalyst only -> new_catalyst
  assert.equal(classifyTermDelta('tariffs', fixtureSources()), 'new_catalyst');
  // nowhere -> absent
  assert.equal(classifyTermDelta('blockchain', fixtureSources()), 'absent');
});

test('posture hint: upgrade on high hit rate + continuing/strengthening', () => {
  for (const delta of ['continuing', 'strengthening']) {
    const hint = postureAdjustmentHint({ four_quarter_hit_rate: 1.0, sample_size: 4, delta });
    assert.equal(hint.direction, 'upgrade');
    assert.equal(hint.max_posture, null);
  }
});

test('posture hint: downgrade on high hit rate + fading/absent', () => {
  for (const delta of ['fading', 'absent']) {
    const hint = postureAdjustmentHint({ four_quarter_hit_rate: 0.75, sample_size: 4, delta });
    assert.equal(hint.direction, 'downgrade');
  }
});

test('posture hint: low hit rate + new_catalyst is capped at WATCH+/LEAN', () => {
  const hint = postureAdjustmentHint({ four_quarter_hit_rate: 0.25, sample_size: 4, delta: 'new_catalyst' });
  assert.equal(hint.direction, 'upgrade_capped');
  assert.equal(hint.max_posture, CAPPED_MAX_POSTURE);
  assert.equal(CAPPED_MAX_POSTURE, 'WATCH+/LEAN');
  assert.ok(ADJUSTMENT_DIRECTIONS.includes(hint.direction));
});

test('posture hint: sample_size < 2 is a no-op regardless of signal', () => {
  for (const args of [
    { four_quarter_hit_rate: 1.0, sample_size: 1, delta: 'strengthening' },
    { four_quarter_hit_rate: 1.0, sample_size: 0, delta: 'fading' },
    { four_quarter_hit_rate: 0.0, sample_size: null, delta: 'new_catalyst' },
  ]) {
    const hint = postureAdjustmentHint(args);
    assert.equal(hint.direction, 'none');
    assert.equal(hint.max_posture, null);
  }
});

test('posture hint: invalid delta or hit rate -> none', () => {
  assert.equal(postureAdjustmentHint({ four_quarter_hit_rate: NaN, sample_size: 4, delta: 'continuing' }).direction, 'none');
  assert.equal(postureAdjustmentHint({ four_quarter_hit_rate: 0.8, sample_size: 4, delta: 'bogus' }).direction, 'none');
});

test('price-like fields are stripped from inputs and absent from outputs', () => {
  const dirty = fixtureSources({
    yes_bid: 42,
    last_price: 0.61,
    volume: 1000,
    liquidity: 9,
    nested: { yes_ask: 55, note: 'keep' },
  });
  const clean = stripPriceLikeFields(dirty);
  assert.equal(clean.yes_bid, undefined);
  assert.equal(clean.last_price, undefined);
  assert.equal(clean.volume, undefined);
  assert.equal(clean.liquidity, undefined);
  assert.equal(clean.nested.yes_ask, undefined);
  assert.equal(clean.nested.note, 'keep');
  // original not mutated
  assert.equal(dirty.yes_bid, 42);

  const out = buildEarningsContextDelta({ strikeTerms: ['AI'], declaredSources: dirty });
  const json = JSON.stringify(out);
  assert.ok(!/price|volume|liquidity|yes_bid|yes_ask/i.test(json), 'no price-like fields in output');
});

test('empty/missing declared sources -> safe absent output, no fake conviction', () => {
  const out = buildEarningsContextDelta({ strikeTerms: ['AI'], declaredSources: {} });
  assert.deepEqual(out.declared_source_keys, []);
  assert.deepEqual(out.missing_source_keys, [...DECLARED_SOURCE_KEYS]);
  const t = out.terms[0];
  assert.equal(t.earnings_context_delta.value, 'absent');
  assert.deepEqual([...t.earnings_context_delta.provenance], []);
  assert.equal(t.transcript_theme_continuity.value, 'none');
  assert.equal(t.analyst_question_likelihood.value, 'low');
  assert.equal(t.current_quarter_catalyst.value, false);
  assert.equal(t.settlement_fit.value, 'unknown');
  // No conviction from nothing: a hint built on this delta must not upgrade.
  const hint = postureAdjustmentHint({ four_quarter_hit_rate: 1.0, sample_size: 4, delta: t.earnings_context_delta.value });
  assert.notEqual(hint.direction, 'upgrade');

  // Also safe with no args at all.
  const empty = buildEarningsContextDelta();
  assert.deepEqual(empty.terms, []);
});

test('provenance present per evidence field and names declared sources', () => {
  const out = buildEarningsContextDelta({ strikeTerms: ['AI', 'tariffs'], declaredSources: fixtureSources() });
  for (const term of out.terms) {
    for (const field of ['earnings_context_delta', 'transcript_theme_continuity', 'analyst_question_likelihood', 'current_quarter_catalyst', 'settlement_fit']) {
      assert.ok(Array.isArray(term[field].provenance), `${field} has provenance array`);
      for (const src of term[field].provenance) {
        assert.ok(DECLARED_SOURCE_KEYS.includes(src), `${src} is a declared source key`);
      }
    }
  }
  const ai = out.terms.find((t) => t.term === 'AI');
  assert.ok(ai.earnings_context_delta.provenance.includes('prior_call_themes'));
  assert.ok(ai.earnings_context_delta.provenance.includes('current_catalysts'));
  assert.deepEqual([...ai.current_quarter_catalyst.provenance], ['current_catalysts']);
  assert.ok(ai.settlement_fit.provenance.includes('current_press_release'));
  assert.equal(ai.settlement_fit.value, 'compatible');
});

test('termMatchesText handles phrases and token overlap deterministically', () => {
  assert.ok(termMatchesText('AI', 'Strong AI demand'));
  assert.ok(termMatchesText('cloud growth', 'growth of cloud revenue'));
  assert.ok(!termMatchesText('blockchain', 'Strong AI demand'));
  assert.ok(!termMatchesText('', 'anything'));
  assert.ok(!termMatchesText('AI', ''));
});
