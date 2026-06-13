// Earnings context-delta builder (earnings_call mention route).
//
// Pure, deterministic, offline. Compares the most recent PRIOR quarter's call
// context against CURRENT-quarter declared sources for each strike term and
// emits code-owned evidence fields plus posture-adjustment HINTS (never final
// posture). Inputs are DECLARED sources/fixtures only — objects passed in by
// the caller (which may include model-extracted strict JSON). This module
// never touches the network, never crawls, and never reads prices: any
// price/volume/liquidity-like keys are stripped defensively on entry.

export const DELTA_CLASSES = Object.freeze([
  'continuing',
  'strengthening',
  'fading',
  'new_catalyst',
  'absent',
]);

export const ADJUSTMENT_DIRECTIONS = Object.freeze([
  'upgrade',
  'downgrade',
  'upgrade_capped',
  'none',
]);

// Posture ceiling applied to the low-hit-rate + new-catalyst hint.
export const CAPPED_MAX_POSTURE = 'WATCH+/LEAN';

const HIGH_HIT_RATE = 0.75;
const LOW_HIT_RATE = 0.5;
const MIN_SAMPLE_SIZE = 2;

// Declared source keys (prior quarter vs current quarter).
const PRIOR_SOURCE_KEYS = Object.freeze([
  'prior_call_themes',        // string[] — themes from the most recent prior call
  'prepared_remarks_summary', // string   — prior prepared remarks summary
  'analyst_qa_topics',        // string[] — prior analyst Q&A topics
]);
const CURRENT_SOURCE_KEYS = Object.freeze([
  'current_press_release', // string
  'current_guidance',      // string
  'current_preview',       // string
  'known_issues',          // string[]
  'current_catalysts',     // string[]
]);
export const DECLARED_SOURCE_KEYS = Object.freeze([...PRIOR_SOURCE_KEYS, ...CURRENT_SOURCE_KEYS]);

const PRICE_LIKE_RE = /price|volume|liquidity|\bbid\b|\bask\b|yes_bid|no_bid|yes_ask|no_ask|odds|notional|open_interest|bid_ask_spread|spread_cents|last_trade_price|implied_prob/i;

function isPriceLikeKey(key) {
  return PRICE_LIKE_RE.test(String(key));
}

/**
 * Deep-copy `input`, dropping any object key that looks price/volume/
 * liquidity-like. Pure; never mutates the input.
 */
export function stripPriceLikeFields(input) {
  if (Array.isArray(input)) return input.map(stripPriceLikeFields);
  if (input !== null && typeof input === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(input)) {
      if (isPriceLikeKey(key)) continue;
      out[key] = stripPriceLikeFields(value);
    }
    return out;
  }
  return input;
}

function asText(value) {
  return value == null ? '' : String(value).trim();
}

function normalize(text) {
  return asText(text)
    .toLowerCase()
    .replace(/["'’“”]/g, '')
    .replace(/[^a-z0-9$%.\-\s]/g, ' ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(text) {
  return normalize(text).split(' ').filter(Boolean);
}

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'for', 'we', 'our', 'is', 'are', 'will', 'this', 'that', 'with', 'be', 'as', 'at', 'by', 'it']);

function meaningfulTokens(text) {
  return tokens(text).filter((t) => !STOPWORDS.has(t) && t.length > 1);
}

/**
 * Deterministic term-vs-text match: the normalized term appears as a phrase,
 * or every meaningful token of the term appears in the text's token set.
 */
export function termMatchesText(term, text) {
  const nTerm = normalize(term);
  const nText = normalize(text);
  if (!nTerm || !nText) return false;
  if (` ${nText} `.includes(` ${nTerm} `)) return true;
  const want = meaningfulTokens(term);
  if (want.length === 0) return false;
  const have = new Set(tokens(text));
  return want.every((t) => have.has(t));
}

function matchesAny(term, items) {
  return (Array.isArray(items) ? items : []).some((item) => termMatchesText(term, item) || termMatchesText(item, term));
}

function sourcePresence(term, sources) {
  const supported = [];
  const check = (key, hit) => { if (hit) supported.push(key); return hit; };
  const inPriorThemes = check('prior_call_themes', matchesAny(term, sources.prior_call_themes));
  const inPreparedRemarks = check('prepared_remarks_summary', termMatchesText(term, sources.prepared_remarks_summary));
  const inPriorQA = check('analyst_qa_topics', matchesAny(term, sources.analyst_qa_topics));
  const inPressRelease = check('current_press_release', termMatchesText(term, sources.current_press_release));
  const inGuidance = check('current_guidance', termMatchesText(term, sources.current_guidance));
  const inPreview = check('current_preview', termMatchesText(term, sources.current_preview));
  const inKnownIssues = check('known_issues', matchesAny(term, sources.known_issues));
  const inCatalysts = check('current_catalysts', matchesAny(term, sources.current_catalysts));
  return {
    supported,
    prior: inPriorThemes || inPreparedRemarks || inPriorQA,
    priorQA: inPriorQA,
    current: inPressRelease || inGuidance || inPreview || inKnownIssues || inCatalysts,
    catalyst: inCatalysts,
    settlementText: inPressRelease || inGuidance,
  };
}

/**
 * Classify the prior->current quarter delta for one strike term.
 * Returns one of DELTA_CLASSES. Deterministic for identical inputs.
 */
export function classifyTermDelta(term, declaredSources) {
  const sources = stripPriceLikeFields(declaredSources ?? {});
  const p = sourcePresence(term, sources);
  if (p.prior && p.catalyst) return 'strengthening';
  if (p.prior && p.current) return 'continuing';
  if (p.prior && !p.current) return 'fading';
  if (!p.prior && p.catalyst) return 'new_catalyst';
  return 'absent';
}

function evidenceField(value, provenance) {
  return { value, provenance: Object.freeze([...provenance]) };
}

function continuityFor(delta) {
  if (delta === 'strengthening' || delta === 'continuing') return 'high';
  if (delta === 'fading') return 'low';
  return 'none';
}

function qaLikelihood(p) {
  if (p.priorQA && p.current) return 'high';
  if (p.priorQA || p.catalyst) return 'medium';
  return 'low';
}

/**
 * Build per-term context-delta evidence for an earnings_call mention market.
 *
 * @param {object} args
 * @param {string[]} args.strikeTerms - current-quarter strike terms
 * @param {object} args.declaredSources - declared prior/current sources only
 *   (see DECLARED_SOURCE_KEYS); model-extracted strict JSON allowed as values.
 * @returns {{ route: 'earnings_call', declared_source_keys: string[],
 *   missing_source_keys: string[], terms: Array<object> }}
 */
export function buildEarningsContextDelta({ strikeTerms, declaredSources } = {}) {
  const sources = stripPriceLikeFields(declaredSources ?? {});
  const terms = Array.isArray(strikeTerms) ? strikeTerms.map(asText).filter(Boolean) : [];
  const present = DECLARED_SOURCE_KEYS.filter((k) => {
    const v = sources[k];
    return Array.isArray(v) ? v.length > 0 : asText(v).length > 0;
  });
  const missing = DECLARED_SOURCE_KEYS.filter((k) => !present.includes(k));

  const perTerm = terms.map((term) => {
    const p = sourcePresence(term, sources);
    const delta = classifyTermDelta(term, sources);
    const priorProv = p.supported.filter((k) => PRIOR_SOURCE_KEYS.includes(k));
    const currentProv = p.supported.filter((k) => CURRENT_SOURCE_KEYS.includes(k));
    return {
      term,
      earnings_context_delta: evidenceField(delta, p.supported),
      transcript_theme_continuity: evidenceField(continuityFor(delta), priorProv),
      analyst_question_likelihood: evidenceField(qaLikelihood(p), p.priorQA ? ['analyst_qa_topics'] : []),
      current_quarter_catalyst: evidenceField(p.catalyst, p.catalyst ? ['current_catalysts'] : []),
      settlement_fit: evidenceField(
        p.settlementText ? 'compatible' : 'unknown',
        p.supported.filter((k) => k === 'current_press_release' || k === 'current_guidance'),
      ),
      // Convenience for downstream code-owned scoring; never a posture.
      provenance: Object.freeze([...p.supported]),
    };
  });

  return {
    route: 'earnings_call',
    declared_source_keys: present,
    missing_source_keys: missing,
    terms: perTerm,
  };
}

/**
 * Posture-adjustment HINT (never a final posture). Pure.
 *
 * Rules:
 * - sample_size invalid or < 2          -> 'none' (no adjustment)
 * - hit rate >= 0.75 + continuing/strengthening -> 'upgrade'
 * - hit rate >= 0.75 + fading/absent    -> 'downgrade'
 * - hit rate <  0.5  + new_catalyst     -> 'upgrade_capped' (max WATCH+/LEAN)
 * - otherwise                           -> 'none'
 *
 * @param {{ four_quarter_hit_rate: number, sample_size: number, delta: string }} args
 * @returns {{ direction: string, max_posture: string|null, reason: string }}
 */
export function postureAdjustmentHint({ four_quarter_hit_rate, sample_size, delta } = {}) {
  const n = Number(sample_size);
  const rate = Number(four_quarter_hit_rate);
  if (!Number.isFinite(n) || n < MIN_SAMPLE_SIZE) {
    return { direction: 'none', max_posture: null, reason: `sample_size < ${MIN_SAMPLE_SIZE}: no adjustment` };
  }
  if (!Number.isFinite(rate) || !DELTA_CLASSES.includes(delta)) {
    return { direction: 'none', max_posture: null, reason: 'invalid hit rate or delta: no adjustment' };
  }
  if (rate >= HIGH_HIT_RATE && (delta === 'continuing' || delta === 'strengthening')) {
    return { direction: 'upgrade', max_posture: null, reason: 'high hit rate with continuing/strengthening context' };
  }
  if (rate >= HIGH_HIT_RATE && (delta === 'fading' || delta === 'absent')) {
    return { direction: 'downgrade', max_posture: null, reason: 'high hit rate but context fading/absent this quarter' };
  }
  if (rate < LOW_HIT_RATE && delta === 'new_catalyst') {
    return { direction: 'upgrade_capped', max_posture: CAPPED_MAX_POSTURE, reason: `low hit rate with new catalyst: capped at ${CAPPED_MAX_POSTURE}` };
  }
  return { direction: 'none', max_posture: null, reason: 'no rule matched: no adjustment' };
}
