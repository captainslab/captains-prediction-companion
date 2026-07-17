import test from 'node:test';
import assert from 'node:assert/strict';

import {
  composeMentionLedgerFromTermRecord,
  mapLayerRecordsToTermEvidence,
  historicalInputFromCanonicalHistory,
  LAYER_COMPONENT_MAP,
} from '../scripts/mentions/mention-composite-core.mjs';
import { SCORING_VERSION } from '../scripts/mentions/term-probability-model.mjs';

function layerDef(key, weight = 0.1, label = key) {
  return { key, weight, label };
}

// ─── Real research mapping: uncited layers have zero scoring effect ───────

test('a present-but-unsourced layer record has zero effect on Pd/Ph/Pe', () => {
  const layerDefs = [layerDef('baseline_relevance'), layerDef('direct_mention_pathway')];
  const cited = mapLayerRecordsToTermEvidence({
    baseline_relevance: { present: true, score: 90, source_basis: 'confirmed agenda item', source_path: 'https://example.com/agenda' },
    direct_mention_pathway: { present: true, score: 90 }, // no source_basis / source_path => uncited
  }, layerDefs);
  assert.equal(cited.pdEvidence.evidenceItems.length, 1);
  assert.equal(cited.pdEvidence.evidenceItems[0].cited, true);
  assert.equal(cited.phEvidence.evidenceItems.length, 1);
  assert.equal(cited.phEvidence.evidenceItems[0].cited, false, 'unsourced layer must still be tagged uncited');

  const rec = composeMentionLedgerFromTermRecord({
    event: 'Test Event',
    targetMention: 'Widget',
    profile: 'earnings_mentions',
    layerDefs,
    layerRecords: {
      baseline_relevance: { present: true, score: 90, source_basis: 'confirmed agenda item', source_path: 'https://example.com/agenda' },
      direct_mention_pathway: { present: true, score: 90 },
    },
  });
  // Only baseline_relevance (cited, pd) counts; direct_mention_pathway (uncited, ph)
  // must not move Ph, so Ph stays null and the modeled probability stays null.
  assert.equal(rec.canonical_term_record.ph.value, null, 'uncited phrase evidence must not produce a Ph value');
  assert.equal(rec.canonical_term_record.modeled_probability, null, 'Pd without Ph cannot produce a modeled probability');
});

// ─── Canonical record drives ranking/score/Why/Evidence together ──────────

test('canonical term record is the single source for composite_score, posture, and evidence ledger', () => {
  const layerDefs = [layerDef('baseline_relevance', 0.5), layerDef('direct_mention_pathway', 0.5)];
  const layerRecords = {
    baseline_relevance: { present: true, score: 90, source_basis: 'confirmed agenda', source_path: 'https://example.com/a' },
    direct_mention_pathway: { present: true, score: 85, source_basis: 'prepared remarks', source_path: 'https://example.com/b' },
  };
  const rec = composeMentionLedgerFromTermRecord({
    event: 'Dell Q1 FY27',
    targetMention: 'PowerEdge',
    profile: 'earnings_mentions',
    layerDefs,
    layerRecords,
    canonicalHistory: { status: 'present', hits: 4, sample_size: 6 },
  });
  assert.equal(rec.composite_score, rec.canonical_term_record.score, 'composite_score must equal the canonical record score, not a parallel computation');
  assert.equal(rec._meta.scoring_version, SCORING_VERSION);
  assert.ok(rec.reasoning_summary.includes(String(rec.composite_score)));
  assert.equal(rec.evidence_ledger.length, 2);
  assert.ok(rec.evidence_ledger.every((row) => 'component' in row));
});

// ─── Old final-score logic cannot override the new model ──────────────────

test('a stray researchScore-shaped field on a layer record cannot move the canonical score', () => {
  const layerDefs = [layerDef('baseline_relevance')];
  const layerRecords = {
    baseline_relevance: { present: true, score: 20, source_basis: 'weak signal', source_path: 'https://example.com/a', researchScore: 99 },
  };
  const rec = composeMentionLedgerFromTermRecord({
    event: 'E', targetMention: 'X', profile: 'political_mentions', layerDefs, layerRecords,
  });
  // Only Pd is present (score 20/100 = 0.2); Ph is absent, so modeled stays
  // null and, with no history, the final score is null — a bogus researchScore
  // field on the record has no path into buildTermProbabilityRecord at all.
  assert.equal(rec.composite_score, null);
});

// ─── Count-aware Ph via requiredCount ──────────────────────────────────────

test('requiredCount lowers the composite score for the same per-use evidence', () => {
  const layerDefs = [layerDef('direct_mention_pathway')];
  const layerRecords = {
    direct_mention_pathway: { present: true, score: 80, source_basis: 'transcript match', source_path: 'https://example.com/t' },
  };
  const single = composeMentionLedgerFromTermRecord({
    event: 'E', targetMention: 'Iran', profile: 'political_mentions', layerDefs, layerRecords, requiredCount: 1,
  });
  const threshold = composeMentionLedgerFromTermRecord({
    event: 'E', targetMention: 'Iran', profile: 'political_mentions', layerDefs, layerRecords, requiredCount: 3,
  });
  assert.ok(threshold.canonical_term_record.ph.value < single.canonical_term_record.ph.value);
});

// ─── Aliases score independently ───────────────────────────────────────────

test('alias accepted forms do not change the scoring inputs, only provenance', () => {
  const layerDefs = [layerDef('direct_mention_pathway')];
  const layerRecords = {
    direct_mention_pathway: { present: true, score: 70, source_basis: 'transcript', source_path: 'https://example.com/t' },
  };
  const ai = composeMentionLedgerFromTermRecord({
    event: 'E', targetMention: 'AI', profile: 'earnings_mentions', layerDefs, layerRecords, acceptedForms: ['AI'],
  });
  const full = composeMentionLedgerFromTermRecord({
    event: 'E', targetMention: 'artificial intelligence', profile: 'earnings_mentions', layerDefs, layerRecords, acceptedForms: ['artificial intelligence'],
  });
  assert.deepEqual(ai.canonical_term_record.accepted_forms, ['AI']);
  assert.deepEqual(full.canonical_term_record.accepted_forms, ['artificial intelligence']);
  assert.equal(ai.composite_score, full.composite_score, 'identical evidence scores identically regardless of which accepted form is displayed');
});

// ─── Zero-history term ──────────────────────────────────────────────────────

test('a zero-history term uses the term-probability model verified_zero smoothing, never a fabricated 0', () => {
  const layerDefs = [layerDef('direct_mention_pathway')];
  const layerRecords = {
    direct_mention_pathway: { present: true, score: 60, source_basis: 'transcript', source_path: 'https://example.com/t' },
  };
  const rec = composeMentionLedgerFromTermRecord({
    event: 'E', targetMention: 'Never Said', profile: 'sports_announcer_mentions', layerDefs, layerRecords,
    canonicalHistory: { status: 'verified_zero', hits: 0, sample_size: 6 },
  });
  assert.equal(rec.canonical_term_record.historical_status, 'verified_zero');
  assert.ok(rec.canonical_term_record.historical_prior > 0, 'verified zero-history must shrink toward neutral, not report exactly 0');
});

// ─── canonicalHistory status mapping ───────────────────────────────────────

test('historicalInputFromCanonicalHistory maps generator statuses to the model vocabulary', () => {
  assert.equal(historicalInputFromCanonicalHistory(null).status, 'missing');
  assert.equal(historicalInputFromCanonicalHistory({ status: 'unavailable' }).status, 'missing');
  assert.equal(historicalInputFromCanonicalHistory({ status: 'failure' }).status, 'lookup_failed');
  assert.deepEqual(historicalInputFromCanonicalHistory({ status: 'present', hits: 3, sample_size: 5 }), { status: 'observed', successes: 3, samples: 5 });
  assert.deepEqual(historicalInputFromCanonicalHistory({ status: 'verified_zero', sample_size: 4 }), { status: 'verified_zero', successes: 0, samples: 4 });
});

// ─── Same contract across all three route families ────────────────────────

test('political, earnings, and sports profiles all produce a canonical_term_record with the shared contract', () => {
  const cases = [
    { profile: 'political_mentions', key: 'opponent_topic_relevance' },
    { profile: 'earnings_mentions', key: 'prepared_remarks_likelihood' },
    { profile: 'sports_announcer_mentions', key: 'sport_phrase_frequency' },
  ];
  for (const { profile, key } of cases) {
    assert.ok(LAYER_COMPONENT_MAP[key], `${key} must be classified`);
    const layerDefs = [layerDef(key)];
    const layerRecords = { [key]: { present: true, score: 75, source_basis: 'source', source_path: 'https://example.com/s' } };
    const rec = composeMentionLedgerFromTermRecord({ event: 'E', targetMention: 'X', profile, layerDefs, layerRecords });
    assert.equal(rec._meta.scoring_version, SCORING_VERSION);
    assert.ok('canonical_term_record' in rec);
  }
});

// ─── Price isolation ────────────────────────────────────────────────────────

test('composeMentionLedgerFromTermRecord still throws on a forbidden pricing field in a layer record', () => {
  const layerDefs = [layerDef('baseline_relevance')];
  assert.throws(() => composeMentionLedgerFromTermRecord({
    event: 'E', targetMention: 'X', profile: 'political_mentions', layerDefs,
    layerRecords: { baseline_relevance: { present: true, score: 50, yes_bid: 40 } },
  }), /forbidden pricing field/);
});

test('composeMentionLedgerFromTermRecord output contains no price-shaped fields', () => {
  const layerDefs = [layerDef('baseline_relevance')];
  const rec = composeMentionLedgerFromTermRecord({
    event: 'E', targetMention: 'X', profile: 'political_mentions', layerDefs,
    layerRecords: { baseline_relevance: { present: true, score: 50, source_basis: 's', source_path: 'https://example.com/s' } },
  });
  const json = JSON.stringify(rec);
  for (const forbidden of ['yes_bid', 'yes_ask', 'implied_probability', 'open_interest', 'last_price']) {
    assert.ok(!json.includes(forbidden), `record must never contain ${forbidden}`);
  }
});
