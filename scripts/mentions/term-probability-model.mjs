// Term-level Pd x Ph x Pe scoring model, blended with a Bayesian-smoothed
// historical prior. Pure ESM, no I/O, no market pricing.
//
// P(YES) = Pd (door) x Ph (phrase, count-aware) x Pe (eligibility),
// then blended with the Kalshi same-series settled-history prior. Evidence
// strength controls the blend: thin/uncited evidence shrinks toward history,
// strong cited evidence can move the score away from history.
//
// Market price, odds, bid, ask, volume, open interest, and price movement
// must never appear in any input or output of this module.

export const SCORING_VERSION = 'term_pd_ph_pe_v1';

const NEUTRAL_PRIOR = 0.5;
const PSEUDO_COUNT = 4;
const HISTORICAL_WEIGHT_MIN = 0.05;
const HISTORICAL_WEIGHT_MAX = 0.95;
const CONFIDENCE_SATURATION_CITATIONS = 4;

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function round6(v) {
  return v === null ? null : Math.round(v * 1e6) / 1e6;
}

// Shared shape for both Pd and Ph: only cited evidence counts. The
// deterministic rule is "max cited value" (a single strong, sourced claim
// establishes the probability; uncited claims never move it), and confidence
// scales with the number of independent cited sources, saturating so no
// single-source finding can claim full certainty.
function scoreCitedEvidence(evidenceItems = []) {
  const cited = evidenceItems.filter((e) => e && e.cited === true && Number.isFinite(Number(e.value)));
  if (cited.length === 0) {
    return { value: null, confidence: 0, citations: [] };
  }
  const value = clamp01(Math.max(...cited.map((e) => Number(e.value))));
  const confidence = clamp01(cited.length / CONFIDENCE_SATURATION_CITATIONS);
  const citations = cited.map((e) => e.source_url).filter(Boolean);
  return { value, confidence, citations };
}

/**
 * Door probability: probability the event reaches the underlying topic.
 * @param {object} opts
 * @param {Array} opts.evidenceItems - [{kind, value(0-1), cited, source_url}]
 */
export function computeDoorProbability({ evidenceItems = [] } = {}) {
  const { value, confidence, citations } = scoreCitedEvidence(evidenceItems);
  return { value, confidence, evidence: evidenceItems, citations };
}

/**
 * Phrase probability: P(exact qualifying term used | topic opens).
 * For count-threshold markets, required uses are treated as independent
 * per-opportunity events (no corpus data to model correlation), so
 * P(N >= required_count) = p ** required_count. This is a documented
 * simplifying assumption, not a fabricated correlation model.
 * @param {object} opts
 * @param {Array} opts.evidenceItems - [{value(0-1 per-use probability), cited, source_url}]
 * @param {number} [opts.requiredCount=1]
 */
export function computePhraseProbability({ evidenceItems = [], requiredCount = 1 } = {}) {
  const { value: perUse, confidence, citations } = scoreCitedEvidence(evidenceItems);
  const k = Math.max(1, Number(requiredCount) || 1);
  const value = perUse === null ? null : clamp01(perUse ** k);
  return { value, confidence, per_use_value: perUse, required_count: k, evidence: evidenceItems, citations };
}

/**
 * Eligibility probability: probability the observed use qualifies under
 * settlement rules. Deterministic product of independent rule factors.
 * With no rules supplied, defaults to fully eligible (1) — this reflects
 * "no known disqualifying settlement risk," not a fabricated research value.
 * @param {object} opts
 * @param {Array} opts.rules - [{factor, passProbability(0-1)}]
 */
export function computeEligibilityProbability({ rules = [] } = {}) {
  if (!Array.isArray(rules) || rules.length === 0) {
    return { value: 1, evidence: [] };
  }
  const value = clamp01(rules.reduce((acc, r) => acc * clamp01(Number(r.passProbability)), 1));
  return { value, evidence: rules };
}

/**
 * Bayesian-smoothed historical prior from Kalshi same-series settled history.
 * status: 'observed' | 'verified_zero' | 'lookup_failed' | 'missing'
 * 'lookup_failed' and 'missing' both resolve to unavailable — the caller
 * could not observe history, so it must never be fabricated as a prior.
 */
export function resolveHistoricalPrior({ status, successes = 0, samples = 0 } = {}) {
  if (status !== 'observed' && status !== 'verified_zero') {
    return { available: false, prior: null, status: status ?? 'missing', samples: null, successes: null };
  }
  const prior = clamp01((successes + PSEUDO_COUNT * NEUTRAL_PRIOR) / (samples + PSEUDO_COUNT));
  return { available: true, prior, status, samples, successes };
}

/**
 * Builds the canonical term probability record: Pd x Ph x Pe modeled
 * probability, blended with the historical prior by current-evidence
 * strength.
 */
export function buildTermProbabilityRecord({
  displayLabel,
  acceptedForms = [],
  requiredCount = 1,
  pdEvidence = {},
  phEvidence = {},
  peRules = {},
  historical = {},
} = {}) {
  const pd = computeDoorProbability(pdEvidence);
  const ph = computePhraseProbability({ ...phEvidence, requiredCount });
  const pe = computeEligibilityProbability(peRules);
  const hist = resolveHistoricalPrior(historical);

  const modeled = pd.value === null || ph.value === null
    ? null
    : round6(clamp01(pd.value * ph.value * pe.value));

  let historicalWeight;
  let final;
  if (modeled === null && !hist.available) {
    historicalWeight = null;
    final = null;
  } else if (modeled === null) {
    historicalWeight = 1;
    final = hist.prior;
  } else if (!hist.available) {
    historicalWeight = 0;
    final = modeled;
  } else {
    const evidenceStrength = clamp01(((pd.confidence ?? 0) + (ph.confidence ?? 0)) / 2);
    historicalWeight = Math.max(HISTORICAL_WEIGHT_MIN, Math.min(HISTORICAL_WEIGHT_MAX, 1 - evidenceStrength));
    final = round6(historicalWeight * hist.prior + (1 - historicalWeight) * modeled);
  }

  const score = final === null ? null : Math.round(final * 100);

  return {
    display_label: displayLabel,
    accepted_forms: acceptedForms,
    required_count: requiredCount,
    pd,
    ph,
    pe,
    modeled_probability: modeled,
    historical_prior: hist.available ? hist.prior : null,
    historical_status: hist.status,
    historical_weight: historicalWeight,
    final_probability: final,
    score,
    scoring_version: SCORING_VERSION,
  };
}
