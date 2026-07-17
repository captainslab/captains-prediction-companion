import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCORING_VERSION,
  computeDoorProbability,
  computePhraseProbability,
  computeEligibilityProbability,
  resolveHistoricalPrior,
  buildTermProbabilityRecord,
} from '../scripts/mentions/term-probability-model.mjs';

// ─── Component bounds ──────────────────────────────────────────────────────

test('door probability clamps out-of-range cited evidence into 0-1', () => {
  const pd = computeDoorProbability({
    evidenceItems: [{ kind: 'confirmed_agenda', value: 1.5, cited: true, source_url: 'https://example.com/agenda' }],
  });
  assert.ok(pd.value <= 1 && pd.value >= 0, 'pd.value must stay within 0-1');
});

test('eligibility probability cannot exceed 1 even if a rule pass-probability is >1', () => {
  const pe = computeEligibilityProbability({
    rules: [{ factor: 'qualifying_speaker', passProbability: 1.4 }],
  });
  assert.ok(pe.value <= 1, 'Pe must never exceed 1');
  assert.ok(pe.value >= 0, 'Pe must never go below 0');
});

test('phrase probability with count threshold stays within 0-1', () => {
  const ph = computePhraseProbability({
    evidenceItems: [{ value: 0.9, cited: true, source_url: 'https://example.com/t1' }],
    requiredCount: 3,
    opportunities: 5,
  });
  assert.ok(ph.value >= 0 && ph.value <= 1);
});

// ─── Uncited evidence has zero effect ─────────────────────────────────────

test('uncited research evidence does not affect Pd', () => {
  const withUncited = computeDoorProbability({
    evidenceItems: [{ kind: 'rumor', value: 0.95, cited: false }],
  });
  assert.equal(withUncited.value, null, 'uncited-only evidence must not produce a Pd value');

  const withCitedLow = computeDoorProbability({
    evidenceItems: [
      { kind: 'rumor', value: 0.95, cited: false },
      { kind: 'event_family_context', value: 0.3, cited: true, source_url: 'https://example.com/a' },
    ],
  });
  assert.equal(withCitedLow.value, 0.3, 'uncited high-value evidence must not leak into the cited max');
});

// ─── Count-aware Ph ────────────────────────────────────────────────────────

test('count-threshold Ph is lower than single-use Ph for the same per-use probability', () => {
  const single = computePhraseProbability({
    evidenceItems: [{ value: 0.6, cited: true, source_url: 'https://example.com/t' }],
    requiredCount: 1,
    opportunities: 1,
  });
  const threshold = computePhraseProbability({
    evidenceItems: [{ value: 0.6, cited: true, source_url: 'https://example.com/t' }],
    requiredCount: 3,
    opportunities: 5,
  });
  assert.ok(threshold.value < single.value, 'requiring >=3 of 5 uses must be less likely than a single use');
});

// ─── Historical prior smoothing / fallback matrix ─────────────────────────

test('missing history resolves to unavailable, not a fabricated prior', () => {
  const hist = resolveHistoricalPrior({ status: 'missing' });
  assert.equal(hist.available, false);
  assert.equal(hist.prior, null);
});

test('lookup_failed resolves to unavailable, distinct from verified_zero', () => {
  const failed = resolveHistoricalPrior({ status: 'lookup_failed' });
  const verifiedZero = resolveHistoricalPrior({ status: 'verified_zero', successes: 0, samples: 6 });
  assert.equal(failed.available, false);
  assert.equal(verifiedZero.available, true);
  assert.ok(verifiedZero.prior > 0, 'verified zero-history must shrink toward neutral, not report exactly 0');
  assert.ok(verifiedZero.prior < 0.5, 'verified zero-history must stay below neutral');
});

test('small historical samples shrink toward the neutral prior', () => {
  const tiny = resolveHistoricalPrior({ status: 'observed', successes: 1, samples: 1 });
  const large = resolveHistoricalPrior({ status: 'observed', successes: 8, samples: 8 });
  assert.ok(tiny.prior < large.prior, 'a single observed success must be shrunk more than 8/8');
  assert.ok(tiny.prior < 1, 'tiny sample must not report a literal 100%');
});

// ─── Blend behavior ────────────────────────────────────────────────────────

function baseTermInput(overrides = {}) {
  return {
    displayLabel: 'PowerEdge',
    acceptedForms: ['PowerEdge'],
    requiredCount: 1,
    opportunities: 1,
    pdEvidence: { evidenceItems: [{ kind: 'confirmed_agenda', value: 0.9, cited: true, source_url: 'https://example.com/agenda' }] },
    phEvidence: { evidenceItems: [{ value: 0.8, cited: true, source_url: 'https://example.com/t' }] },
    peRules: { rules: [{ factor: 'qualifying_speaker', passProbability: 1 }] },
    historical: { status: 'observed', successes: 4, samples: 6 },
    ...overrides,
  };
}

test('final probability equals the documented formula: modeled = Pd*Ph*Pe, then history-blended', () => {
  const rec = buildTermProbabilityRecord(baseTermInput());
  const expectedModeled = rec.pd.value * rec.ph.value * rec.pe.value;
  assert.equal(rec.modeled_probability, Math.round(expectedModeled * 1e6) / 1e6);
  const expectedFinal = rec.historical_weight * rec.historical_prior + (1 - rec.historical_weight) * rec.modeled_probability;
  assert.equal(rec.final_probability, Math.round(expectedFinal * 1e6) / 1e6);
  assert.equal(rec.score, Math.round(rec.final_probability * 100));
});

test('weak/low-confidence current evidence shrinks the final probability toward the historical prior', () => {
  const weak = buildTermProbabilityRecord(baseTermInput({
    pdEvidence: { evidenceItems: [{ kind: 'event_family_context', value: 0.95, cited: true, source_url: 'https://example.com/weak' }] },
    phEvidence: { evidenceItems: [{ value: 0.95, cited: true, source_url: 'https://example.com/weak2' }] },
  }));
  // one thin cited source each => low confidence => historical_weight should dominate
  assert.ok(weak.historical_weight > 0.5, 'thin evidence must push most of the blend weight onto history');
  assert.ok(Math.abs(weak.final_probability - weak.historical_prior) < Math.abs(weak.final_probability - weak.modeled_probability));
});

test('strong verified current evidence can move the final probability away from history', () => {
  const strong = buildTermProbabilityRecord(baseTermInput({
    pdEvidence: { evidenceItems: [
      { kind: 'confirmed_agenda', value: 0.95, cited: true, source_url: 'https://example.com/a1' },
      { kind: 'prepared_remarks_confirmed', value: 0.9, cited: true, source_url: 'https://example.com/a2' },
      { kind: 'expected_analyst_question', value: 0.85, cited: true, source_url: 'https://example.com/a3' },
      { kind: 'source_backed_news', value: 0.92, cited: true, source_url: 'https://example.com/a4' },
    ] },
    phEvidence: { evidenceItems: [
      { value: 0.95, cited: true, source_url: 'https://example.com/p1' },
      { value: 0.93, cited: true, source_url: 'https://example.com/p2' },
      { value: 0.9, cited: true, source_url: 'https://example.com/p3' },
      { value: 0.94, cited: true, source_url: 'https://example.com/p4' },
    ] },
    historical: { status: 'observed', successes: 0, samples: 6 },
  }));
  assert.ok(strong.historical_weight < 0.5, 'four independently cited strong sources must pull weight toward modeled evidence');
  assert.ok(strong.final_probability > strong.historical_prior, 'verified strong evidence must move the score above a weak historical prior');
});

test('history-present research-missing falls back fully to the historical prior', () => {
  const rec = buildTermProbabilityRecord(baseTermInput({
    pdEvidence: { evidenceItems: [] },
    phEvidence: { evidenceItems: [] },
  }));
  assert.equal(rec.modeled_probability, null);
  assert.equal(rec.historical_weight, 1);
  assert.equal(rec.final_probability, rec.historical_prior);
});

test('research-present history-missing falls back fully to modeled probability', () => {
  const rec = buildTermProbabilityRecord(baseTermInput({ historical: { status: 'missing' } }));
  assert.equal(rec.historical_prior, null);
  assert.equal(rec.historical_weight, 0);
  assert.equal(rec.final_probability, rec.modeled_probability);
});

test('both missing yields no score, not a fabricated number', () => {
  const rec = buildTermProbabilityRecord(baseTermInput({
    pdEvidence: { evidenceItems: [] },
    phEvidence: { evidenceItems: [] },
    historical: { status: 'lookup_failed' },
  }));
  assert.equal(rec.final_probability, null);
  assert.equal(rec.score, null);
});

// ─── Aliases evaluated independently ───────────────────────────────────────

test('alias terms are scored independently of one another', () => {
  const termA = buildTermProbabilityRecord(baseTermInput({
    displayLabel: 'AI',
    acceptedForms: ['AI'],
    phEvidence: { evidenceItems: [{ value: 0.9, cited: true, source_url: 'https://example.com/ai' }] },
  }));
  const termB = buildTermProbabilityRecord(baseTermInput({
    displayLabel: 'artificial intelligence',
    acceptedForms: ['artificial intelligence'],
    phEvidence: { evidenceItems: [{ value: 0.2, cited: true, source_url: 'https://example.com/aiterm' }] },
  }));
  assert.notEqual(termA.ph.value, termB.ph.value);
  assert.notEqual(termA.final_probability, termB.final_probability);
});

// ─── Cross-field agreement + provenance ────────────────────────────────────

test('canonical term object cross-references agree: score, final_probability, and provenance', () => {
  const rec = buildTermProbabilityRecord(baseTermInput());
  assert.equal(rec.scoring_version, SCORING_VERSION);
  assert.equal(rec.score, Math.round(rec.final_probability * 100));
  assert.ok(Array.isArray(rec.pd.citations) && rec.pd.citations.length > 0);
  assert.ok(Array.isArray(rec.ph.citations) && rec.ph.citations.length > 0);
  assert.equal(rec.display_label, 'PowerEdge');
  assert.deepEqual(rec.accepted_forms, ['PowerEdge']);
});

// ─── Same contract across all three route families ────────────────────────

test('political, earnings, and sports fixtures use the identical scoring contract', () => {
  const political = buildTermProbabilityRecord(baseTermInput({
    displayLabel: 'tariffs',
    historical: { status: 'observed', successes: 3, samples: 5 },
  }));
  const earnings = buildTermProbabilityRecord(baseTermInput({
    displayLabel: 'PowerEdge',
    historical: { status: 'verified_zero', successes: 0, samples: 4 },
  }));
  const sports = buildTermProbabilityRecord(baseTermInput({
    displayLabel: 'no-hitter',
    historical: { status: 'lookup_failed' },
  }));
  for (const rec of [political, earnings, sports]) {
    assert.equal(rec.scoring_version, SCORING_VERSION);
    assert.ok('modeled_probability' in rec);
    assert.ok('historical_weight' in rec);
    assert.ok('final_probability' in rec);
    assert.ok('score' in rec);
  }
});

// ─── Price isolation ────────────────────────────────────────────────────────

test('term probability record contains no price-shaped fields', () => {
  const rec = buildTermProbabilityRecord(baseTermInput());
  const json = JSON.stringify(rec);
  for (const forbidden of ['yes_bid', 'yes_ask', 'implied_probability', 'open_interest', 'last_price']) {
    assert.ok(!json.includes(forbidden), `record must never contain ${forbidden}`);
  }
});
