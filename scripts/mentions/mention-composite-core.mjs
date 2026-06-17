// Unified mention-composite scoring core.
//
// Scores mention likelihood across political, earnings, and sports-announcer events.
// Pure ESM. No I/O. No live network. No market pricing in scoring.
//
// Market pricing (bid/ask/volume/open interest/line movement) must NEVER enter
// the composite score. It may only be stored separately via market_context for
// post-hoc validation. Enforcement: any layer record containing a forbidden
// pricing field throws before scoring begins.
//
// Coverage cap (mirrors MLB evidence-ledger):
//   0 layers → NO_CLEAR_PICK
//   1 layer  → max LEAN
//   2 layers → max EVIDENCE_LEAN
//   3+ layers → PICK eligible (still subject to score threshold)

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
          `Market data must never enter scoring. Pass pricing via market_context only.`
        );
      }
    }
    if (value && typeof value === 'object') {
      assertNoPricingInLayer(key, value, [...trail, field]);
    }
  }
}

// Strip any pricing keys from the caller-supplied market_context to prevent
// accidental re-promotion into scores downstream.
function sanitizeMarketContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  const safe = {};
  const allowedKeys = [
    'yes_bid_cents', 'yes_ask_cents', 'no_bid_cents', 'no_ask_cents',
    'volume', 'open_interest', 'spread_cents', 'last_trade_price_cents',
  ];
  for (const k of allowedKeys) {
    if (k in ctx) safe[k] = ctx[k];
  }
  safe._note = 'market context stored for validation only; never scoring';
  return safe;
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
 * @param {object?} opts.marketContext  - Pricing snapshot (never scoring). Keys: yes_bid_cents, yes_ask_cents, volume, open_interest
 *
 * @returns {object} Composite result with evidence ledger and provenance
 */
export function composeMentionLedger({
  event,
  targetMention,
  profile,
  layerDefs,
  layerRecords,
  marketContext = null,
} = {}) {
  if (!MENTION_PROFILES.includes(profile)) {
    throw new Error(`Unknown mention profile: "${profile}". Must be one of: ${MENTION_PROFILES.join(', ')}`);
  }
  if (!Array.isArray(layerDefs) || layerDefs.length === 0) {
    throw new Error('layerDefs must be a non-empty array of {key, weight, label}.');
  }

  const safeMarketContext = sanitizeMarketContext(marketContext);

  let num = 0;
  let den = 0;
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
      num += score * def.weight;
      den += def.weight;
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
      row.contribution      = +(row.value * (row.raw_weight / den)).toFixed(2);
    }
  }

  const composite     = den === 0 ? null : Math.round(clamp(num / den, 0, 100));
  const layersPresent = ledger.filter(r => r.present).length;
  const posture       = scoreToPosture(composite, layersPresent);

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
    ? `NO_CLEAR_PICK — no usable layers (missing: ${missingTxt}).`
    : `composite=${composite} [${posture}] from ${layersPresent} layer(s): ${contribsTxt}. Missing: ${missingTxt}.`;

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
    market_context:        safeMarketContext,
    evidence_ledger:       ledger,
    reasoning_summary,
    _meta: {
      schema_version:   'mention_composite_v1',
      layers_present:   layersPresent,
      layers_total:     layerDefs.length,
      pricing_excluded: true,
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
