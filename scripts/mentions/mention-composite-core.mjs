// Unified mention-composite scoring core.
//
// Scores mention likelihood across political, earnings, and sports-announcer events.
// Pure ESM. No I/O. No live network. No market pricing in scoring.
//
// Market pricing (bid/ask/volume/open interest/line movement) must NEVER enter
// the composite score. Quotes are attached only by the post-score renderer.
// Enforcement: any layer record containing a forbidden pricing field throws.
//
// Coverage cap (mirrors MLB evidence-ledger):
//   0 layers → NO_CLEAR_PICK
//   event_proximity only → NO_CLEAR_PICK (gate only, never a score input)
//   otherwise the score comes from research-backed layers or an explicit
//   blended research probability.
//
// Canonical term-probability path (SCORING_VERSION term_pd_ph_pe_v1):
// composeMentionLedgerFromTermRecord() is the single authoritative score path.
// It consumes one buildTermProbabilityRecord() output (Pd x Ph x Pe, blended
// with the settled-history prior) and is the only function that may set
// composite_score/posture on a term going forward. mapLayerRecordsToTermEvidence()
// deterministically maps the existing research layer records (already real,
// route-agnostic evidence with source_basis/source_path) into Pd/Ph/Pe
// evidence items so no duplicate final-score logic runs in parallel.

import { buildTermProbabilityRecord, SCORING_VERSION } from './term-probability-model.mjs';

export const MENTION_PROFILES = Object.freeze([
  'political_mentions',
  'earnings_mentions',
  'sports_announcer_mentions',
]);

export const POSTURES = Object.freeze([
  'PICK', 'EVIDENCE_LEAN', 'LEAN', 'WATCH', 'NO_CLEAR_PICK',
]);

const FORBIDDEN_SCORING_FIELDS = Object.freeze([
  'yes_bid', 'yes_ask', 'no_bid', 'no_ask',
  'bid', 'ask', 'odds', 'price',
  'volume', 'open_interest', 'line_movement',
  'kalshi_ask', 'kalshi_bid',
  'yes_bid_cents', 'yes_ask_cents',
  'last_price', 'last_trade_price', 'last_trade_price_cents',
  'price_cents', 'implied_probability', 'implied_prob',
  'bid_ask_spread', 'spread_cents', 'movement',
]);

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function gradeLabel(s) {
  if (s === null || s === undefined) return 'n/a';
  if (s >= 80) return 'A';
  if (s >= 70) return 'B';
  if (s >= 60) return 'C';
  if (s >= 45) return 'D';
  return 'F';
}

function scoreToPosture(score, layersPresent) {
  if (layersPresent === 0 || score === null) return 'NO_CLEAR_PICK';
  if (layersPresent === 1) return score >= 65 ? 'LEAN' : 'WATCH';
  if (layersPresent === 2) return score >= 70 ? 'EVIDENCE_LEAN' : score >= 55 ? 'LEAN' : 'WATCH';
  // 3+ layers
  if (score >= 80) return 'PICK';
  if (score >= 68) return 'EVIDENCE_LEAN';
  if (score >= 55) return 'LEAN';
  if (score >= 40) return 'WATCH';
  return 'NO_CLEAR_PICK';
}

function assertNoPricingInLayer(key, rec, trail = []) {
  if (!rec || typeof rec !== 'object') return;
  for (const [field, value] of Object.entries(rec)) {
    for (const f of FORBIDDEN_SCORING_FIELDS) {
      if (field === f && value !== null && value !== undefined) {
        const where = trail.length ? `${trail.join('.')}.` : '';
        throw new Error(
          `Layer "${key}" contains forbidden pricing field "${where}${field}". ` +
          `Market data must never enter scoring. Attach quotes only after model rows are frozen.`
        );
      }
    }
    if (value && typeof value === 'object') {
      assertNoPricingInLayer(key, value, [...trail, field]);
    }
  }
}

function isScoreableLayer(key) {
  return key !== 'event_proximity';
}

/**
 * composeMentionLedger
 *
 * @param {object} opts
 * @param {string}  opts.event          - Human-readable event name (e.g. "Dell Earnings Call Q1 FY2027")
 * @param {string}  opts.targetMention  - Keyword being scored (e.g. "PowerEdge")
 * @param {string}  opts.profile        - One of MENTION_PROFILES
 * @param {Array}   opts.layerDefs      - Array of {key, weight, label} from the profile config
 * @param {object}  opts.layerRecords   - Map of layerKey → {present, score, source_basis, source_path, detail, missing_note}
 * @returns {object} Composite result with evidence ledger and provenance
 */
export function composeMentionLedger({
  event,
  targetMention,
  profile,
  layerDefs,
  layerRecords,
  researchScore = null,
  researchScoreCited = false,
} = {}) {
  if (!MENTION_PROFILES.includes(profile)) {
    throw new Error(`Unknown mention profile: "${profile}". Must be one of: ${MENTION_PROFILES.join(', ')}`);
  }
  if (!Array.isArray(layerDefs) || layerDefs.length === 0) {
    throw new Error('layerDefs must be a non-empty array of {key, weight, label}.');
  }

  let num = 0;
  let den = 0;
  let researchNum = 0;
  let researchDen = 0;
  const ledger = [];
  const sourceNotes = [];

  for (const def of layerDefs) {
    const rec = layerRecords?.[def.key] ?? null;

    // Pricing guard — throws if any forbidden field is present and non-null
    assertNoPricingInLayer(def.key, rec);

    const rawScore = rec?.score ?? null;
    const numScore = rawScore !== null ? Number(rawScore) : null;
    const present = rec?.present === true && numScore !== null && Number.isFinite(numScore);
    const score = present ? Math.round(clamp(numScore, 0, 100)) : null;

    if (present) {
      den += def.weight;
      if (isScoreableLayer(def.key)) {
        num += score * def.weight;
        researchNum += score * def.weight;
        researchDen += def.weight;
      }
      if (rec.source_basis) {
        sourceNotes.push(`[${def.key}] ${rec.source_basis}`);
      }
    }

    ledger.push({
      category:         def.key,
      label:            def.label,
      raw_weight:       def.weight,
      normalized_weight: null,
      contribution:     null,
      source_basis:     rec?.source_basis ?? null,
      source_path:      rec?.source_path ?? null,
      value:            score,
      grade:            gradeLabel(score),
      detail:           rec?.detail ?? null,
      present,
      missing_note:     present ? null : (rec?.missing_note ?? `no ${def.key} data supplied`),
    });
  }

  // Re-normalize weights over present layers only
  for (const row of ledger) {
    if (row.present && row.value !== null && den > 0) {
      row.normalized_weight = +(row.raw_weight / den).toFixed(4);
      row.contribution = isScoreableLayer(row.category) && researchDen > 0
        ? +(row.value * (row.raw_weight / researchDen)).toFixed(2)
        : 0;
    }
  }

  const overrideScore = researchScore !== null && researchScore !== undefined && Number.isFinite(Number(researchScore))
    ? Number(researchScore)
    : null;
  // Guard the researchScore override channel. assertNoPricingInLayer only
  // inspects layerRecords; the researchScore/blended_pct path bypasses the
  // layer ledger entirely and can mint a composite_score from thin air. Reject
  // any non-finite or price-shaped input here so a stray market price can
  // never sneak in as an override "research" score.
  if (researchScore !== null && researchScore !== undefined) {
    const n = Number(researchScore);
    if (!Number.isFinite(n)) {
      throw new Error(
        'researchScore override must be a finite number. ' +
        'A price-shaped or non-numeric value must never enter scoring.'
      );
    }
    if (n < 0 || n > 100) {
      throw new Error(
        `researchScore override ${n} is outside [0,100]. ` +
        'A probability expressed as a fraction (0-1) or a raw price must never enter scoring.'
      );
    }
  }
  // layerComposite is the pure weighted-layer score (identical to the legacy
  // no-override composite). A researchScore override must never simply
  // replace credible layer evidence — that let opinion-driven research
  // silently contradict real settled history (e.g. a 0/6 history layer
  // overridden to a LEAN-tier 66). Instead:
  //  - no layers present: the override is the only signal — use it as-is
  //    (this is what lets Perplexity fill genuinely thin/absent evidence).
  //  - layers present + override uncited: an uncited opinion cannot move a
  //    score that already has real evidence behind it ("overrides require
  //    stronger cited current evidence").
  //  - layers present + override cited: blend evenly. This is monotonic in
  //    layerComposite, so stronger history can only pull the blend up and
  //    weaker/0 history can only pull it down — never inverted — while still
  //    letting a genuinely cited, stronger current-event finding move the
  //    score.
  const layerComposite = researchDen === 0 ? null : clamp(researchNum / researchDen, 0, 100);
  let composite;
  let overrideApplied = false;
  if (overrideScore === null) {
    composite = layerComposite === null ? null : Math.round(layerComposite);
  } else if (layerComposite === null) {
    composite = Math.round(clamp(overrideScore, 0, 100));
    overrideApplied = true;
  } else if (researchScoreCited) {
    composite = Math.round(clamp((layerComposite + overrideScore) / 2, 0, 100));
    overrideApplied = true;
  } else {
    composite = Math.round(layerComposite);
  }
  const layersPresent = ledger.filter(r => r.present).length;
  // Posture/tier must be driven ONLY by scoreable evidence layers. event_proximity
  // is an event-level gate/context scaffold (isScoreableLayer === false): it is
  // already excluded from the score numerator, and it must ALSO be excluded from
  // the layer count that selects posture bands — otherwise a present proximity
  // scaffold silently upgrades tier (e.g. LEAN -> EVIDENCE_LEAN) on identical
  // P(YES), making it per-strike score evidence. The full `layersPresent` (which
  // still counts proximity) is preserved for _meta and the downstream
  // proximity-only / fail-closed coverage gate, which intentionally keys on it.
  const scoreableLayersPresent = ledger.filter(r => r.present && isScoreableLayer(r.category)).length;
  const posture       = scoreToPosture(composite, scoreableLayersPresent);

  const topSupportingLayers = ledger
    .filter(r => r.present && r.contribution !== null)
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 3)
    .map(({ category, label, value, contribution }) => ({ category, label, value, contribution }));

  const missingLayers = ledger
    .filter(r => !r.present)
    .map(({ category, label, missing_note }) => ({ category, label, missing_note }));

  const missingTxt = missingLayers.map(r => r.category).join(', ') || 'none';
  const contribsTxt = ledger
    .filter(r => r.present && r.contribution !== null)
    .map(r => `${r.category}=${r.value}×${r.normalized_weight}=${r.contribution}`)
    .join(' + ');
  const reasoning_summary = composite === null
    ? `NO_CLEAR_PICK — no usable research layers (missing: ${missingTxt}).`
    : `research_score=${composite} [${posture}] from ${layersPresent} layer(s): ${contribsTxt}. Missing: ${missingTxt}.`;

  return {
    event,
    target_mention:        targetMention,
    profile,
    composite_score:       composite,
    confidence:            composite,
    posture,
    top_supporting_layers: topSupportingLayers,
    missing_layers:        missingLayers,
    source_notes:          sourceNotes,
    evidence_ledger:       ledger,
    reasoning_summary,
    _meta: {
      schema_version:   'mention_composite_v1',
      layers_present:   layersPresent,
      layers_total:     layerDefs.length,
      pricing_excluded: true,
      research_score:   composite,
      // Exposes the two independent contributions that fed the composite
      // above, and whether/why the override actually moved the score.
      layer_composite:      layerComposite === null ? null : Math.round(layerComposite),
      override_score:       overrideScore,
      override_cited:       overrideScore !== null ? Boolean(researchScoreCited) : null,
      override_applied:     overrideApplied,
    },
  };
}

// Back-compat wrapper for older isolation tests and callers that still supply
// a `layers` bag instead of explicit layerDefs/layerRecords. The pricing guard
// still runs on every layer record before any composite work happens.
export function computeMentionComposite(input = {}) {
  const layers = input?.layers;
  if (layers && typeof layers === 'object' && !Array.isArray(layers)) {
    for (const [key, rec] of Object.entries(layers)) {
      assertNoPricingInLayer(key, rec);
    }
    if ((!input.layerDefs || !input.layerRecords) && Object.keys(layers).length > 0) {
      const keys = Object.keys(layers);
      const layerDefs = keys.map((key) => ({ key, weight: 1 / keys.length, label: key }));
      const layerRecords = Object.fromEntries(keys.map((key) => [key, layers[key]]));
      return composeMentionLedger({ ...input, layerDefs, layerRecords });
    }
  }
  return composeMentionLedger(input);
}

// ─── Canonical Pd x Ph x Pe term-probability path ──────────────────────────
//
// Deterministic classification of every layer key across the three route
// profiles into the component it feeds. This is the ONE mapping rule from
// real research fields to Pd/Ph/Pe (goal requirement: every numeric input
// must have a deterministic mapping rule and provenance):
//
//   pd (door — event/topic reaches this keyword):
//     baseline_relevance, source_velocity, news_cycle_pressure,
//     opponent_topic_relevance, storyline_relevance, injury_milestone_trigger,
//     current_game_context, game_context_trigger, analyst_qa_pathway,
//     evidence_quality
//   ph (phrase — exact qualifying language used):
//     direct_mention_pathway, prepared_remarks_likelihood, sec_filing_language,
//     sport_phrase_frequency, venue_team_phrase_relevance, sport_phrase_likelihood
//   pe (eligibility — settlement-qualifying risk, as a passProbability rule):
//     suppression_signal, mention_type_likelihood
//   historical (feeds the settled-history prior directly, not Pd/Ph/Pe):
//     historical_tendency, settled_mentions_history
//   ignored (gate-only scaffold, never a score input — matches isScoreableLayer):
//     event_proximity
export const LAYER_COMPONENT_MAP = Object.freeze({
  baseline_relevance:          'pd',
  source_velocity:             'pd',
  news_cycle_pressure:         'pd',
  opponent_topic_relevance:    'pd',
  storyline_relevance:         'pd',
  injury_milestone_trigger:    'pd',
  current_game_context:        'pd',
  game_context_trigger:        'pd',
  analyst_qa_pathway:          'pd',
  evidence_quality:            'pd',
  direct_mention_pathway:      'ph',
  prepared_remarks_likelihood: 'ph',
  sec_filing_language:         'ph',
  sport_phrase_frequency:      'ph',
  venue_team_phrase_relevance: 'ph',
  sport_phrase_likelihood:     'ph',
  suppression_signal:          'pe',
  mention_type_likelihood:     'pe',
  historical_tendency:         'historical',
  settled_mentions_history:    'historical',
  event_proximity:             'ignored',
});

function layerIsCited(rec) {
  const hasSourcePath = typeof rec?.source_path === 'string' && rec.source_path.trim().length > 0;
  const hasSourceBasis = typeof rec?.source_basis === 'string' && rec.source_basis.trim().length > 0;
  return hasSourcePath || hasSourceBasis;
}

/**
 * Deterministically maps existing layerRecords (real research evidence —
 * {present, score 0-100, source_basis, source_path, detail}) into Pd/Ph/Pe
 * evidence for buildTermProbabilityRecord(). Every item carries provenance
 * (kind = layer key, source_url = source_path when available) and is only
 * "cited" — and thus scoreable — when the layer carries a real source_basis
 * or source_path; a present-but-unsourced layer has zero effect on Pd/Ph/Pe,
 * matching the "uncited research has zero effect" requirement.
 */
export function mapLayerRecordsToTermEvidence(layerRecords = {}, layerDefs = []) {
  const pdEvidence = [];
  const phEvidence = [];
  const peRules = [];
  for (const def of layerDefs) {
    const key = def.key;
    const component = LAYER_COMPONENT_MAP[key];
    if (!component || component === 'ignored' || component === 'historical') continue;
    const rec = layerRecords?.[key];
    if (!rec || rec.present !== true || !Number.isFinite(Number(rec.score))) continue;
    const value = clamp(Number(rec.score) / 100, 0, 1);
    const cited = layerIsCited(rec);
    const source_url = typeof rec.source_path === 'string' && rec.source_path.trim() ? rec.source_path : null;
    if (component === 'pd') {
      pdEvidence.push({ kind: key, value, cited, source_url });
    } else if (component === 'ph') {
      phEvidence.push({ kind: key, value, cited, source_url });
    } else if (component === 'pe') {
      // Uncited suppression/eligibility signals default to fully eligible
      // (1) rather than guessing at settlement risk from an unsourced score.
      peRules.push({ factor: key, passProbability: cited ? value : 1, source_url });
    }
  }
  return {
    pdEvidence: { evidenceItems: pdEvidence },
    phEvidence: { evidenceItems: phEvidence },
    peRules: { rules: peRules },
  };
}

// Maps the generator's canonicalHistory artifact (settled_history /
// earnings_family_history evidence_class; status: present|verified_zero|
// failure|unavailable) into resolveHistoricalPrior()'s status vocabulary
// (observed|verified_zero|lookup_failed|missing). This is the ONLY path a
// historical prior reaches the term-probability model — never a raw score.
export function historicalInputFromCanonicalHistory(canonicalHistory = null) {
  if (!canonicalHistory || typeof canonicalHistory !== 'object') {
    return { status: 'missing' };
  }
  const { status, hits, samples, sample_size } = canonicalHistory;
  const n = Number.isFinite(Number(sample_size)) ? Number(sample_size) : Number(samples ?? 0);
  if (status === 'present') {
    // hits is intentionally null when a match exists but the hit count could
    // not be honestly reconstructed (e.g. exact_series via a Kalshi native
    // percentage with no way to back out an integer count) — that is a
    // lookup gap, not a verified zero. Defaulting it to 0 would fabricate an
    // observation that never happened.
    if (hits === null || hits === undefined || !Number.isFinite(Number(hits))) return { status: 'lookup_failed' };
    return { status: 'observed', successes: Number(hits), samples: n };
  }
  if (status === 'verified_zero') {
    return { status: 'verified_zero', successes: 0, samples: n };
  }
  if (status === 'failure') {
    return { status: 'lookup_failed' };
  }
  return { status: 'missing' };
}

/**
 * composeMentionLedgerFromTermRecord — the single authoritative score path.
 *
 * Builds one canonical buildTermProbabilityRecord() (Pd x Ph x Pe blended
 * with the settled-history prior) from the real layerRecords + canonical
 * history artifact already produced upstream, and drives the same envelope
 * shape composeMentionLedger returns (ranking/score/Why/Evidence/Source Gaps
 * all read from this one object) plus `canonical_term_record` with full
 * provenance. No other function may set composite_score/posture downstream
 * of this call — legacy composeMentionLedger/researchScore override blending
 * stays available only for back-compat tests, never for production scoring.
 */
export function composeMentionLedgerFromTermRecord({
  event,
  targetMention,
  profile,
  layerDefs,
  layerRecords,
  canonicalHistory = null,
  acceptedForms = null,
  requiredCount = 1,
  researchEvidence = null,
} = {}) {
  if (!MENTION_PROFILES.includes(profile)) {
    throw new Error(`Unknown mention profile: "${profile}". Must be one of: ${MENTION_PROFILES.join(', ')}`);
  }
  if (!Array.isArray(layerDefs) || layerDefs.length === 0) {
    throw new Error('layerDefs must be a non-empty array of {key, weight, label}.');
  }
  for (const def of layerDefs) {
    assertNoPricingInLayer(def.key, layerRecords?.[def.key] ?? null);
  }

  const { pdEvidence, phEvidence, peRules } = mapLayerRecordsToTermEvidence(layerRecords, layerDefs);
  // A live-research finding (e.g. a source-backed Perplexity read on this
  // strike) is holistic current-event context, not a specific accepted-form
  // match, so it feeds Pd (door) evidence rather than Ph (phrase). Only a
  // real citation (researchEvidence.cited === true) can move Pd — matches
  // "uncited research has zero effect".
  if (researchEvidence && Number.isFinite(Number(researchEvidence.value))) {
    pdEvidence.evidenceItems.push({
      kind: researchEvidence.kind ?? 'source_backed_research',
      value: clamp(Number(researchEvidence.value), 0, 1),
      cited: Boolean(researchEvidence.cited),
      source_url: researchEvidence.source_url ?? null,
    });
  }
  const historical = historicalInputFromCanonicalHistory(canonicalHistory);

  const termRecord = buildTermProbabilityRecord({
    displayLabel: targetMention,
    acceptedForms: acceptedForms ?? [targetMention].filter(Boolean),
    requiredCount,
    pdEvidence,
    phEvidence,
    peRules,
    historical,
  });

  const ledger = [];
  const sourceNotes = [];
  for (const def of layerDefs) {
    const rec = layerRecords?.[def.key] ?? null;
    const rawScore = rec?.score ?? null;
    const numScore = rawScore !== null ? Number(rawScore) : null;
    const present = rec?.present === true && numScore !== null && Number.isFinite(numScore);
    const score = present ? Math.round(clamp(numScore, 0, 100)) : null;
    if (present && rec.source_basis) sourceNotes.push(`[${def.key}] ${rec.source_basis}`);
    ledger.push({
      category:      def.key,
      label:         def.label,
      raw_weight:    def.weight,
      value:         score,
      grade:         gradeLabel(score),
      component:     LAYER_COMPONENT_MAP[def.key] ?? null,
      source_basis:  rec?.source_basis ?? null,
      source_path:   rec?.source_path ?? null,
      detail:        rec?.detail ?? null,
      present,
      missing_note:  present ? null : (rec?.missing_note ?? `no ${def.key} data supplied`),
    });
  }

  const scoreableLayersPresent = ledger.filter(r => r.present && LAYER_COMPONENT_MAP[r.category] && LAYER_COMPONENT_MAP[r.category] !== 'ignored').length;
  // Zero scoreable layers AND no cited/uncited research override means there is
  // literally no current-event evidence — the historical-prior fallback inside
  // buildTermProbabilityRecord (e.g. a neutral ~0.5 prior on a verified-zero
  // history with 0 samples) must never surface as a fabricated composite_score
  // here. This mirrors the legacy composeMentionLedger contract: 0 layers with
  // no override -> composite_score stays null -> BLOCKED_SOURCE_LAYER_MISSING.
  const hasResearchEvidenceItem = Boolean(researchEvidence && Number.isFinite(Number(researchEvidence.value)));
  const composite = (scoreableLayersPresent === 0 && !hasResearchEvidenceItem) ? null : termRecord.score;
  const posture = scoreToPosture(composite, scoreableLayersPresent);

  const topSupportingLayers = ledger
    .filter(r => r.present && (r.component === 'pd' || r.component === 'ph'))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    .slice(0, 3)
    .map(({ category, label, value }) => ({ category, label, value }));

  const missingLayers = ledger
    .filter(r => !r.present)
    .map(({ category, label, missing_note }) => ({ category, label, missing_note }));

  const missingTxt = missingLayers.map(r => r.category).join(', ') || 'none';
  const reasoning_summary = composite === null
    ? `NO_CLEAR_PICK — no usable Pd/Ph/Pe evidence or history (missing: ${missingTxt}).`
    : `score=${composite} [${posture}] — pd=${termRecord.pd.value ?? 'n/a'} x ph=${termRecord.ph.value ?? 'n/a'} x pe=${termRecord.pe.value ?? 'n/a'} `
      + `(modeled=${termRecord.modeled_probability ?? 'n/a'}), historical_prior=${termRecord.historical_prior ?? 'n/a'} `
      + `(weight=${termRecord.historical_weight ?? 'n/a'}). Missing: ${missingTxt}.`;

  return {
    event,
    target_mention:        targetMention,
    profile,
    // raw_model_score / raw_model_probability are the unambiguous "before any
    // downstream customer policy" score — the gated canonical_term_record
    // output (null only when there is no valid model result to gate: zero
    // scoreable evidence, or the lexical NO_MATCH suppression applied by
    // buildMentionCompositeForMarket, which also nulls these two fields to
    // keep them true aliases of composite_score/confidence). Downstream
    // customer-facing adjustments (earnings-family penalty, confidence caps —
    // see mentionCompositeToDecisionRow in generate-mentions-daily.mjs) start
    // from this value and must never mutate it.
    raw_model_score:        composite,
    raw_model_probability:  composite === null ? null : termRecord.final_probability,
    composite_score:       composite,
    confidence:            composite,
    posture,
    top_supporting_layers: topSupportingLayers,
    missing_layers:        missingLayers,
    source_notes:          sourceNotes,
    evidence_ledger:       ledger,
    reasoning_summary,
    canonical_term_record: termRecord,
    _meta: {
      schema_version:   'mention_composite_v2_term',
      scoring_version:  SCORING_VERSION,
      layers_present:   ledger.filter(r => r.present).length,
      layers_total:     layerDefs.length,
      pricing_excluded: true,
      research_score:   composite,
    },
  };
}
