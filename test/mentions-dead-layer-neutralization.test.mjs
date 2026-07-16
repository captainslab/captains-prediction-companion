// Guard tests: dead / unwired / gate-only evidence layers must never create
// score noise, false coverage, or misleading packet claims.
//
// These lock in the neutralization invariants for the mentions composite core:
//   1. event_proximity is a gate/context scaffold only — never per-strike score
//      or tier evidence (excluded from P(YES) AND from the posture layer count).
//   2. The full layers_present meta still counts event_proximity so the
//      downstream proximity-only / fail-closed coverage gate is preserved.
//   3. Planned-but-unwired layers that are absent never affect P(YES), tier, or
//      coverage count.
//   4. An uncited research P(YES) estimate cannot move a score that already
//      has real layer evidence behind it; a cited one blends with (never
//      fully replaces) that evidence.
//   5. Price/liquidity fields in any layer (even nested) hard-throw before any
//      scoring — price isolation can never leak into score/rank/tier.

import test from 'node:test';
import assert from 'node:assert/strict';

import { composeMentionLedger } from '../scripts/mentions/mention-composite-core.mjs';

const PROFILE = 'political_mentions';
// A scoreable real layer + the event_proximity gate scaffold.
const DEFS = [
  { key: 'historical_tendency', weight: 0.5, label: 'historical tendency' },
  { key: 'event_proximity', weight: 0.5, label: 'event proximity' },
];
const realLayer = (score) => ({ present: true, score, source_basis: `hist ${score}` });
const proximityLayer = { present: true, score: 90, source_basis: 'schedule confirmed' };

function compose(layerRecords, extra = {}) {
  return composeMentionLedger({
    event: 'Some Event',
    targetMention: 'Term',
    profile: PROFILE,
    layerDefs: DEFS,
    layerRecords,
    ...extra,
  });
}

test('event_proximity never contributes to the composite P(YES) score', () => {
  const realOnly = compose({ historical_tendency: realLayer(72) });
  const withProximity = compose({ historical_tendency: realLayer(72), event_proximity: proximityLayer });
  assert.equal(realOnly.composite_score, 72, 'real layer alone scores 72');
  assert.equal(
    withProximity.composite_score,
    realOnly.composite_score,
    'adding a high-scoring event_proximity must NOT move the score',
  );
});

test('event_proximity can never upgrade posture/tier by inflating the layer count', () => {
  // 72 alone is a 1-scoreable-layer LEAN. Before neutralization a present
  // event_proximity pushed the count to 2 and silently upgraded to EVIDENCE_LEAN
  // on the identical score. That is the contamination this guard forbids.
  const realOnly = compose({ historical_tendency: realLayer(72) });
  const withProximity = compose({ historical_tendency: realLayer(72), event_proximity: proximityLayer });
  assert.equal(realOnly.posture, 'LEAN');
  assert.equal(
    withProximity.posture,
    realOnly.posture,
    'event_proximity must not change posture/tier',
  );
});

test('event_proximity is preserved as a gate: still counted in layers_present meta', () => {
  const withProximity = compose({ historical_tendency: realLayer(72), event_proximity: proximityLayer });
  // The full coverage count (used by the downstream proximity-only / fail-closed
  // gate in mentionCompositeToDecisionRow) still includes event_proximity.
  assert.equal(withProximity._meta.layers_present, 2);
  const ledgerProx = withProximity.evidence_ledger.find((r) => r.category === 'event_proximity');
  assert.equal(ledgerProx.present, true, 'event_proximity stays a present gate row');
});

test('proximity-only composite is NO_CLEAR_PICK with no score, gate count intact', () => {
  const proximityOnly = compose({ event_proximity: proximityLayer });
  assert.equal(proximityOnly.composite_score, null, 'no scoreable evidence -> null score');
  assert.equal(proximityOnly.posture, 'NO_CLEAR_PICK');
  // _meta still reports the proximity layer present so the downstream gate can
  // detect "schedule confirmed, nothing else" and fail closed / WATCH-cap it.
  assert.equal(proximityOnly._meta.layers_present, 1);
});

test('an absent planned-but-unwired layer never affects score, tier, or coverage count', () => {
  const defsWithUnwired = [
    ...DEFS,
    { key: 'prepared_remarks_likelihood', weight: 0.3, label: 'unwired planned layer' },
  ];
  const baseline = composeMentionLedger({
    event: 'E', targetMention: 'T', profile: 'earnings_mentions',
    layerDefs: defsWithUnwired,
    layerRecords: { historical_tendency: realLayer(72) },
  });
  // The unwired layer has no record -> stays absent, never present, never scored.
  const row = baseline.evidence_ledger.find((r) => r.category === 'prepared_remarks_likelihood');
  assert.equal(row.present, false);
  assert.equal(row.value, null);
  assert.equal(baseline.composite_score, 72, 'absent unwired layer must not move score');
  assert.equal(baseline._meta.layers_present, 1, 'absent unwired layer must not inflate coverage count');
});

test('an uncited research P(YES) estimate cannot move a score with real layer evidence', () => {
  const layerOnly = compose({ historical_tendency: realLayer(40) });
  const withUncitedResearch = compose({ historical_tendency: realLayer(40) }, { researchScore: 80 });
  assert.equal(layerOnly.composite_score, 40);
  // researchScoreCited defaults to false: an uncited opinion must not
  // override or even blend with credible layer evidence — "overrides
  // require stronger cited current evidence".
  assert.equal(withUncitedResearch.composite_score, 40, 'uncited override is ignored, not authoritative');
  assert.equal(withUncitedResearch._meta.override_applied, false);
});

test('a cited research P(YES) estimate blends with (never fully replaces) real layer evidence', () => {
  const layerOnly = compose({ historical_tendency: realLayer(40) });
  const withCitedResearch = compose(
    { historical_tendency: realLayer(40) },
    { researchScore: 80, researchScoreCited: true },
  );
  assert.equal(layerOnly.composite_score, 40);
  // round((40+80)/2) = 60 — moves toward the cited estimate, but the real
  // layer evidence still pulls it down from the override's raw 80.
  assert.equal(withCitedResearch.composite_score, 60, 'cited override blends with layer evidence');
  assert.equal(withCitedResearch._meta.override_applied, true);
  assert.ok(
    withCitedResearch.composite_score > layerOnly.composite_score,
    'a cited research-backed term can still rank above a layer-only term',
  );
});

test('research P(YES) override is authoritative when no layer evidence exists at all', () => {
  // With nothing to contradict, the override is the only signal — this is
  // what lets Perplexity fill genuinely thin/absent evidence.
  const noEvidence = compose({});
  const withResearchOnly = compose({}, { researchScore: 80 });
  assert.equal(noEvidence.composite_score, null);
  assert.equal(withResearchOnly.composite_score, 80);
});

test('price/liquidity fields in any layer hard-throw before scoring (price isolation)', () => {
  for (const field of ['yes_ask', 'yes_bid', 'last_price', 'volume', 'open_interest', 'implied_probability', 'spread_cents']) {
    assert.throws(
      () => compose({ historical_tendency: { present: true, score: 72, [field]: 55 } }),
      /forbidden pricing field/i,
      `top-level ${field} must throw`,
    );
    assert.throws(
      () => compose({ historical_tendency: { present: true, score: 72, detail: { nested: { [field]: 55 } } } }),
      /forbidden pricing field/i,
      `nested ${field} must throw`,
    );
  }
});
