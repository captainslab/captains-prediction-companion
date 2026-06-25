// Shared decision-packet row schema + compact board renderer + audit split.
// Pure helpers only: no I/O, no network, no credentials, no trading.
//
// PURPOSE
//   Cron packet output across all market types (MLB, NASCAR, mentions/politics)
//   must show the MODEL view and the MARKET board side by side so a human can
//   spot edge in under 60 seconds. This module is the single shared builder for
//   that "decision row" plus the compact board renderer.
//
// HARD RULE — MARKET PRICE NEUTRALITY
//   Market price/bid/ask/volume/OI is carried ONLY in the `market` half of a
//   row and is NEVER read back into composite scoring. The composite half is
//   supplied already-scored by the caller (mention_composite, MLB scoring-core,
//   NASCAR ceiling, etc.). buildDecisionRow does not mutate or feed market price
//   into any composite field. Edge is computed by COMPARING the two halves.
//
// EDGE = fair(model) vs implied(market). Never market-vs-market.

import {
  PRICE_CONTEXT_DISPLAY_ONLY,
  buildCpcCardSummary,
  evidenceStatusFrom,
  formatBaseRate,
  describeCpcRead,
  normalizeCpcRead,
} from './cpc-card-summary.mjs';

export const EDGE_STATUS = Object.freeze({
  PICK: 'PICK',
  LEAN: 'LEAN',
  WATCH: 'WATCH',
  FADE: 'FADE',
  PASS: 'PASS',
  BLOCKED: 'BLOCKED',
});

export const CONFIDENCE = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
});

// Edge thresholds in percentage points (model fair prob vs market implied prob).
export const EDGE_THRESHOLDS = Object.freeze({
  STRONG_PP: 7,   // PICK / FADE candidate
  LEAN_PP: 3,     // LEAN candidate
  NOISE_PP: 1.5,  // inside this band the market is efficient -> PASS
});

// Maps a free-form composite posture string to a rank + a fallback edge status
// used ONLY when a numeric fair probability is not available. This keeps a board
// of strong composite postures from collapsing to all-WATCH.
const POSTURE_TABLE = Object.freeze({
  'STRONG EVIDENCE LEAN': { rank: 5, fallback: EDGE_STATUS.PICK },
  STRONG_EVIDENCE_LEAN: { rank: 5, fallback: EDGE_STATUS.PICK },
  PICK: { rank: 5, fallback: EDGE_STATUS.PICK },
  'EVIDENCE LEAN': { rank: 4, fallback: EDGE_STATUS.LEAN },
  EVIDENCE_LEAN: { rank: 4, fallback: EDGE_STATUS.LEAN },
  LEAN: { rank: 3, fallback: EDGE_STATUS.LEAN },
  'MARKET-ONLY LEAN': { rank: 2, fallback: EDGE_STATUS.WATCH },
  MARKET_ONLY_LEAN: { rank: 2, fallback: EDGE_STATUS.WATCH },
  WATCH: { rank: 1, fallback: EDGE_STATUS.WATCH },
  'NO CLEAR PICK': { rank: 0, fallback: EDGE_STATUS.PASS },
  NO_CLEAR_PICK: { rank: 0, fallback: EDGE_STATUS.PASS },
});

function postureInfo(posture) {
  const key = posture == null ? '' : String(posture).trim();
  return POSTURE_TABLE[key] ?? POSTURE_TABLE[key.toUpperCase()] ?? { rank: 1, fallback: EDGE_STATUS.WATCH };
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Coerce a price-ish input to a probability in [0,1].
 * Accepts dollars (0..1), cents (1..100), or an already-normalized fraction.
 */
function toProbability(value, units = null) {
  const n = num(value);
  if (n === null) return null;
  if (units === 'cents') return Math.max(0, Math.min(1, n / 100));
  if (units === 'dollars') return Math.max(0, Math.min(1, n));
  if (n > 1.5) return Math.max(0, Math.min(1, n / 100)); // cents
  return Math.max(0, Math.min(1, n));                    // dollars / fraction
}

function round1(n) {
  return n === null ? null : Math.round(n * 10) / 10;
}

/**
 * Implied probability from the market half. Mid of yes bid/ask when both are
 * present; else last price; else single-sided bid/ask. Pure read of market data
 * — this value is for EDGE comparison only and never re-enters composite math.
 */
export function impliedProbabilityFromMarket(market = {}) {
  const units = market.price_units === 'cents' || market.priceUnits === 'cents'
    ? 'cents'
    : market.price_units === 'dollars' || market.priceUnits === 'dollars'
      ? 'dollars'
      : null;
  const yesBid = toProbability(market.yes_bid ?? market.yes_bid_dollars ?? market.yesBid, units);
  const yesAsk = toProbability(market.yes_ask ?? market.yes_ask_dollars ?? market.yesAsk, units);
  const last = toProbability(market.last_price ?? market.last_price_dollars ?? market.lastPrice, units);
  if (yesBid !== null && yesAsk !== null) return (yesBid + yesAsk) / 2;
  if (last !== null) return last;
  if (yesAsk !== null) return yesAsk;
  if (yesBid !== null) return yesBid;
  return null;
}

/**
 * Resolve a model fair probability and a human-facing fair display.
 * Priority: explicit fairProbability -> fairRange midpoint -> composite.modelProbability.
 * Returns { prob, display } where prob may be null (no numeric model anchor).
 */
function resolveFair(fair = {}, composite = {}) {
  const explicit = toProbability(fair.probability ?? fair.fairProbability);
  if (explicit !== null) {
    return { prob: explicit, display: `${Math.round(explicit * 100)}%` };
  }
  const lo = toProbability(fair.low ?? fair.rangeLow);
  const hi = toProbability(fair.high ?? fair.rangeHigh);
  if (lo !== null && hi !== null) {
    return { prob: (lo + hi) / 2, display: `${Math.round(lo * 100)}-${Math.round(hi * 100)}%` };
  }
  const model = toProbability(composite.modelProbability ?? composite.model_probability);
  if (model !== null) {
    return { prob: model, display: `${Math.round(model * 100)}%` };
  }
  return { prob: null, display: 'model_fair_estimate_pending' };
}

/**
 * Confidence from composite coverage unless explicitly supplied.
 * Missing evidence DOWNGRADES confidence; it does not auto-kill the row.
 */
function resolveConfidence(explicit, composite = {}) {
  if (explicit && Object.values(CONFIDENCE).includes(explicit)) return explicit;
  const present = num(composite.layersPresent ?? composite.layers_present);
  const total = num(composite.layersTotal ?? composite.layers_total);
  if (present !== null && total && total > 0) {
    const ratio = present / total;
    if (ratio >= 0.7) return CONFIDENCE.HIGH;
    if (ratio >= 0.4) return CONFIDENCE.MEDIUM;
    return CONFIDENCE.LOW;
  }
  return CONFIDENCE.LOW;
}

/**
 * Decide edge status from the model/market comparison.
 *   - blocker present                -> BLOCKED (settlement- or model-critical gap)
 *   - numeric edge available         -> PICK / LEAN / PASS / FADE / WATCH by threshold
 *   - no numeric fair, posture known -> posture fallback (prevents all-WATCH boards)
 */
function decideEdgeStatus({ blocker, edgePp, confidence, posture }) {
  if (blocker) return EDGE_STATUS.BLOCKED;
  if (edgePp !== null) {
    const mag = Math.abs(edgePp);
    if (mag <= EDGE_THRESHOLDS.NOISE_PP) return EDGE_STATUS.PASS;
    if (edgePp >= EDGE_THRESHOLDS.STRONG_PP) {
      return confidence === CONFIDENCE.LOW ? EDGE_STATUS.LEAN : EDGE_STATUS.PICK;
    }
    if (edgePp >= EDGE_THRESHOLDS.LEAN_PP) return EDGE_STATUS.LEAN;
    if (edgePp <= -EDGE_THRESHOLDS.STRONG_PP) return EDGE_STATUS.FADE;
    if (edgePp <= -EDGE_THRESHOLDS.LEAN_PP) return EDGE_STATUS.FADE;
    return EDGE_STATUS.WATCH;
  }
  // No numeric fair: fall back to composite posture so strong model views still
  // surface as PICK/LEAN rather than collapsing to evidence-incomplete WATCH.
  return postureInfo(posture).fallback;
}

// Positive edge statuses a domain override can assert. These are the ones that
// can mislead a reader if they contradict the numeric edge (e.g. a LEAN sitting
// on top of a −70pp edge would be promoted into Top Edge by its magnitude).
const POSITIVE_OVERRIDE_STATUSES = Object.freeze(
  new Set([EDGE_STATUS.PICK, EDGE_STATUS.LEAN]),
);

const RANKED_EDGE_STATUSES = Object.freeze(
  new Set([EDGE_STATUS.PICK, EDGE_STATUS.LEAN, EDGE_STATUS.WATCH]),
);

/**
 * Reconcile a domain scorer's authoritative statusOverride against the numeric
 * edge so an override can never assert a misleading positive verdict.
 *
 * Rules (blocker is handled earlier and always wins):
 *   - No override                       -> use the generic threshold verdict.
 *   - Override is NOT positive (FADE/    -> trust the domain scorer as-is. WATCH,
 *     WATCH/PASS/BLOCKED)                   PASS, FADE never overstate edge.
 *   - Override IS positive (PICK/LEAN):
 *       * numeric edge unavailable      -> trust the override (model-only lane).
 *       * edge clearly negative         -> a positive override is contradictory;
 *         (<= -LEAN_PP)                     surface the threshold verdict instead
 *                                           (FADE for a real negative edge).
 *       * edge inside the noise band     -> downgrade PICK/LEAN to the threshold
 *         (|edge| <= NOISE_PP)              verdict (PASS): no real edge to claim.
 *       * edge positive / mild           -> honor the override (valid positive).
 *
 * This guarantees: BLOCKED overrides everything; numeric edge direction prevents
 * misleading positive statuses; a clear negative edge surfaces as FADE; a valid
 * positive edge can still surface as PICK/LEAN. Market price never enters here —
 * edgePp is already the model-fair-vs-implied comparison computed by the caller.
 */
function reconcileOverrideWithEdge(override, thresholdStatus, edgePp) {
  if (!override) return thresholdStatus;
  if (!POSITIVE_OVERRIDE_STATUSES.has(override)) return override;
  // Positive override but no numeric edge to check against: model-only lane.
  if (edgePp === null) return override;
  // Clear negative edge: a positive override is contradictory -> threshold wins
  // (yields FADE for a genuinely negative edge).
  if (edgePp <= -EDGE_THRESHOLDS.LEAN_PP) return thresholdStatus;
  // Noise band: no real edge to claim -> downgrade to the threshold verdict.
  if (Math.abs(edgePp) <= EDGE_THRESHOLDS.NOISE_PP) return thresholdStatus;
  // Valid positive (or mildly positive) edge: honor the domain override.
  return override;
}

/**
 * Build one decision-packet row. The single shared row schema for all cron
 * packet types. Composite (model) fields and market (board) fields are kept in
 * separate halves; edge is the comparison between them.
 *
 * @param {object} input
 * @param {string} input.marketTicker
 * @param {string} input.sideTarget          - side / target / driver / mention
 * @param {string} input.marketType
 * @param {string} input.settlementSummary
 * @param {object} input.composite            - { score, posture, layersPresent, layersTotal,
 *                                                topEvidenceLayers[], missingLayers[],
 *                                                modelProbability? }
 * @param {object} input.market               - { yes_bid, yes_ask, last_price, volume,
 *                                                open_interest } (dollars or cents)
 * @param {object} [input.fair]               - { probability } or { low, high }
 * @param {string} [input.confidence]         - low|medium|high (else derived)
 * @param {string} [input.analysis]
 * @param {object} [input.trigger]            - { price, event }
 * @param {string} [input.blocker]            - non-empty => BLOCKED
 * @param {string} [input.statusOverride]     - domain scorer's authoritative edge_status
 *                                              (one of EDGE_STATUS). When supplied it wins over
 *                                              the generic threshold verdict, EXCEPT: (1) a blocker
 *                                              still forces BLOCKED, and (2) a POSITIVE override
 *                                              (PICK/LEAN) is reconciled against the numeric edge so
 *                                              it can never assert a misleading verdict — a clear
 *                                              negative edge surfaces as FADE and a noise-band edge
 *                                              downgrades to PASS (see reconcileOverrideWithEdge).
 *                                              This is how the manual scoring layer (e.g. MLB
 *                                              scoreMarkets) and the cron path converge on one
 *                                              decision vocabulary without overstating edge.
 * @param {number} [input.edgeOverridePp]     - domain-computed edge in pp (e.g. MLB edge_pp);
 *                                              used when no model fair probability is available.
 * @param {boolean} [input.requireModelScore]  - when true, ranked PICK/LEAN/WATCH rows are
 *                                              forced to BLOCKED if composite.score is missing.
 */
export function buildDecisionRow(input = {}) {
  const composite = input.composite ?? {};
  const market = input.market ?? {};
  const fair = input.fair ?? {};

  const implied = impliedProbabilityFromMarket(market);
  const { prob: fairProb, display: fairDisplay } = resolveFair(fair, composite);
  const confidence = resolveConfidence(input.confidence, composite);

  // Edge in pp: prefer model fair vs market implied; fall back to a domain edge.
  let edgePp = (fairProb !== null && implied !== null)
    ? round1((fairProb - implied) * 100)
    : null;
  if (edgePp === null && Number.isFinite(input.edgeOverridePp)) {
    edgePp = round1(Number(input.edgeOverridePp));
  }
  const edgeCents = edgePp === null ? null : Math.round(edgePp); // 1pp == 1 cent on Kalshi

  let blocker = input.blocker && String(input.blocker).trim() ? String(input.blocker).trim() : null;
  const override = (input.statusOverride && Object.values(EDGE_STATUS).includes(input.statusOverride))
    ? input.statusOverride
    : null;
  let edgeStatus = blocker
    ? EDGE_STATUS.BLOCKED
    : reconcileOverrideWithEdge(
        override,
        decideEdgeStatus({ blocker, edgePp, confidence, posture: composite.posture }),
        edgePp,
      );
  const compositeScore = composite.score ?? null;
  if (input.requireModelScore && compositeScore === null && RANKED_EDGE_STATUSES.has(edgeStatus)) {
    edgeStatus = EDGE_STATUS.BLOCKED;
    blocker = blocker ?? 'model score missing for ranked row';
  }

  const layersPresent = num(composite.layersPresent ?? composite.layers_present);
  const layersTotal = num(composite.layersTotal ?? composite.layers_total);
  const cpcRead = normalizeCpcRead(edgeStatus);
  const evidenceStatus = evidenceStatusFrom({
    explicit: input.evidenceStatus ?? input.evidence_status,
    status: input.status ?? edgeStatus,
    blocker,
    layersPresent,
    layersTotal,
  });
  const card = buildCpcCardSummary({
    title: titleFromRow(input),
    subtitle: input.subtitle ?? input.marketType ?? input.market_type ?? 'CPC stack row',
    plainEnglish: input.plainEnglish ?? input.plain_english ?? input.analysis ?? input.settlementSummary,
    settlement: input.settlement ?? input.settlementSummary,
    route: routeFromRow(input),
    cpcRead,
    cpcReadText: input.cpcReadText ?? input.cpc_read_text ?? null,
    evidenceStatus,
    baseRate: input.baseRate ?? input.base_rate ?? null,
    priceContext: input.priceContext ?? input.price_context ?? PRICE_CONTEXT_DISPLAY_ONLY,
    ticker: input.marketTicker ?? input.market_ticker ?? null,
    marketId: input.marketId ?? input.market_id ?? input.marketTicker ?? input.market_ticker ?? null,
    eventId: input.eventId ?? input.event_id ?? null,
    reason: input.reason ?? input.analysis ?? null,
  });

  return {
    market_ticker: input.marketTicker ?? 'MISSING',
    side_target: input.sideTarget ?? 'MISSING',
    market_type: input.marketType ?? 'MISSING',
    settlement_summary: input.settlementSummary ?? 'MISSING',
    human_title: card.title,
    subtitle: card.subtitle,
    plain_english: card.plain_english,
    settlement: card.settlement,
    route: card.route,
    cpc_read: card.cpc_read,
    cpc_read_text: card.cpc_read_text,
    evidence_status: card.evidence_status,
    base_rate: card.base_rate,
    price_context: card.price_context,
    ticker_or_market_id: card.ticker_or_market_id,
    // --- composite / model half (no market price inside) ---
    composite_score: compositeScore,
    composite_posture: composite.posture ?? 'NO_CLEAR_PICK',
    layers_present: (layersPresent !== null && layersTotal !== null)
      ? `${layersPresent}/${layersTotal}`
      : (layersPresent !== null ? String(layersPresent) : 'MISSING'),
    top_evidence_layers: Array.isArray(composite.topEvidenceLayers) ? composite.topEvidenceLayers : [],
    missing_layers: Array.isArray(composite.missingLayers) ? composite.missingLayers : [],
    // --- market / board half (NOT IN composite score) ---
    market_yes_bid: market.yes_bid ?? market.yes_bid_dollars ?? null,
    market_yes_ask: market.yes_ask ?? market.yes_ask_dollars ?? null,
    last_price: market.last_price ?? market.last_price_dollars ?? null,
    volume: market.volume ?? market.volume_fp ?? null,
    open_interest: market.open_interest ?? market.open_interest_fp ?? null,
    implied_probability: implied === null ? null : round1(implied * 100) / 100,
    // --- edge (model vs market) ---
    fair_probability_or_range: fairDisplay,
    edge_cents_or_pp: edgeCents === null ? null : edgeCents,
    edge_status: edgeStatus,
    confidence,
    analysis: input.analysis ?? 'MISSING',
    trigger_price: input.trigger?.price ?? null,
    trigger_event: input.trigger?.event ?? 'MISSING',
    blocker_if_any: blocker ?? 'none',
    // internal sort key (model conviction); not rendered
    _rank: postureInfo(composite.posture).rank,
    _edge_abs: edgePp === null ? -1 : Math.abs(edgePp),
  };
}

const STATUS_ORDER = Object.freeze({
  PICK: 5, LEAN: 4, FADE: 3, WATCH: 2, BLOCKED: 1, PASS: 0,
});

/** Sort rows: edge status > absolute edge > composite rank > composite score. */
export function rankDecisionRows(rows = []) {
  return rows.slice().sort((a, b) => {
    const s = (STATUS_ORDER[b.edge_status] ?? 0) - (STATUS_ORDER[a.edge_status] ?? 0);
    if (s !== 0) return s;
    if (b._edge_abs !== a._edge_abs) return b._edge_abs - a._edge_abs;
    if ((b._rank ?? 0) !== (a._rank ?? 0)) return (b._rank ?? 0) - (a._rank ?? 0);
    return (num(b.composite_score) ?? -1) - (num(a.composite_score) ?? -1);
  });
}

function fmt(v) {
  return v === null || v === undefined || v === '' ? 'MISSING' : String(v);
}

function fmtList(arr, max = 3) {
  if (!Array.isArray(arr) || !arr.length) return 'none';
  const items = arr.slice(0, max).map((x) => {
    if (x && typeof x === 'object') return x.category ?? x.label ?? x.id ?? JSON.stringify(x);
    return String(x);
  });
  const extra = arr.length > max ? ` (+${arr.length - max})` : '';
  return items.join(', ') + extra;
}

function titleFromRow(input = {}) {
  const explicit = input.title ?? input.humanTitle ?? input.bigTitle;
  if (explicit) return String(explicit);
  const side = input.sideTarget ?? input.side_target;
  const marketType = input.marketType ?? input.market_type;
  if (side && marketType) return `${side} — ${marketType}`;
  return input.marketTicker ?? input.market_ticker ?? 'CPC card';
}

function routeFromRow(input = {}) {
  return input.route ?? input.marketType ?? input.market_type ?? 'cpc/general';
}

function renderCpcReadValue(row) {
  return fmt(
    row.cpc_read_text
    ?? describeCpcRead(row.cpc_read ?? row.edge_status),
  );
}

/**
 * Compact, <60-second board renderer. One block per ranked row, model and
 * market shown together with the edge verdict. Raw inventory does NOT belong
 * here — see buildInventoryArtifact for the audit-only dump.
 */
export function renderDecisionBoard(rows = [], options = {}) {
  const heading = options.heading ?? 'CPC READ BOARD';
  const limit = options.limit ?? 12;
  const ranked = rankDecisionRows(rows);
  const shown = ranked.slice(0, limit);
  const lines = [];
  lines.push(`=== ${heading} (model read + display-only price context) ===`);
  lines.push(`rows: ${ranked.length}${ranked.length > shown.length ? ` (showing top ${shown.length})` : ''}`);
  lines.push(`legend: top-rated > higher-rated > lower-rated > monitor only > blocked > no rated view. ${PRICE_CONTEXT_DISPLAY_ONLY}`);
  lines.push('');
  if (!shown.length) {
    lines.push('  (no rows)');
    return lines.join('\n');
  }
  let i = 0;
  for (const r of shown) {
    i += 1;
    const baseRate = formatBaseRate(r.base_rate);
    lines.push(`#${i} [CPC Read: ${renderCpcReadValue(r)}] ${fmt(r.human_title)}`);
    lines.push(`    Plain English: ${fmt(r.plain_english)}`);
    lines.push(`    Settlement: ${fmt(r.settlement)}`);
    lines.push(`    Route: ${fmt(r.route)} | Evidence status: ${fmt(r.evidence_status)} | Base rate: ${baseRate.summary}`);
    lines.push(`    Model Read: fair=${fmt(r.fair_probability_or_range)} score=${fmt(r.composite_score)} layers=${fmt(r.layers_present)} confidence=${fmt(r.confidence)}`);
    lines.push(`    Price context: ${fmt(r.price_context)} implied=${fmt(r.implied_probability)} yes_bid=${fmt(r.market_yes_bid)} yes_ask=${fmt(r.market_yes_ask)} last=${fmt(r.last_price)} volume=${fmt(r.volume)} open_interest=${fmt(r.open_interest)}`);
    lines.push(`    Ticker/market ID: ${fmt(r.ticker_or_market_id ?? r.market_ticker)}`);
    lines.push(`    Why it matters: ${fmt(r.analysis)}`);
    lines.push(`    trigger: price=${fmt(r.trigger_price)} event=${fmt(r.trigger_event)}`);
    if (r.blocker_if_any && r.blocker_if_any !== 'none') {
      lines.push(`    blocker: ${r.blocker_if_any}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/**
 * Group ranked rows into the five enjoyable packet sections and a one-line
 * TLDR. Returns { tldr, sections } so a generator can render a compact,
 * <60-second board with clear buckets rather than a wall of YAML.
 */
export function bucketDecisionRows(rows = []) {
  const ranked = rankDecisionRows(rows);
  const buckets = {
    topEdge: [],     // PICK / strong LEAN
    watchlist: [],   // LEAN / WATCH (trigger board)
    fades: [],       // FADE (overpriced)
    blocked: [],     // BLOCKED (needs source)
    passes: [],      // PASS (efficient / no edge)
  };
  for (const r of ranked) {
    switch (r.edge_status) {
      case EDGE_STATUS.PICK: buckets.topEdge.push(r); break;
      case EDGE_STATUS.LEAN:
        if (r._edge_abs >= EDGE_THRESHOLDS.STRONG_PP) buckets.topEdge.push(r);
        else buckets.watchlist.push(r);
        break;
      case EDGE_STATUS.WATCH: buckets.watchlist.push(r); break;
      case EDGE_STATUS.FADE: buckets.fades.push(r); break;
      case EDGE_STATUS.BLOCKED: buckets.blocked.push(r); break;
      default: buckets.passes.push(r); break;
    }
  }
  return buckets;
}

function compactRowLines(r, idx) {
  const gap = r.edge_cents_or_pp === null
    ? 'model/price gap=MISSING'
    : `model/price gap=${r.edge_cents_or_pp >= 0 ? '+' : ''}${r.edge_cents_or_pp}pp`;
  const baseRate = formatBaseRate(r.base_rate);
  const out = [];
  out.push(`#${idx} [CPC Read: ${renderCpcReadValue(r)}] ${fmt(r.human_title)}`);
  out.push(`    Plain English: ${fmt(r.plain_english)}`);
  out.push(`    Settlement: ${fmt(r.settlement)}`);
  out.push(`    Route: ${fmt(r.route)} | Evidence status: ${fmt(r.evidence_status)} | Base rate: ${baseRate.summary}`);
  out.push(`    Model Read: fair=${fmt(r.fair_probability_or_range)} score=${fmt(r.composite_score)} layers=${fmt(r.layers_present)} conf=${fmt(r.confidence)}`);
  out.push(`    Price context: ${fmt(r.price_context)} implied=${fmt(r.implied_probability)} yes_bid=${fmt(r.market_yes_bid)} yes_ask=${fmt(r.market_yes_ask)} last=${fmt(r.last_price)} | ${gap}`);
  out.push(`    Ticker/market ID: ${fmt(r.ticker_or_market_id ?? r.market_ticker)}`);
  out.push(`    Why it matters: ${fmt(r.analysis)}`);
  if (r.trigger_price != null || (r.trigger_event && r.trigger_event !== 'MISSING')) {
    out.push(`    trigger: price=${fmt(r.trigger_price)} when=${fmt(r.trigger_event)}`);
  }
  if (r.blocker_if_any && r.blocker_if_any !== 'none') out.push(`    blocker: ${r.blocker_if_any}`);
  return out;
}

function compactBlockedNotes(rows = [], limit = 8) {
  if (!rows.length) return ['  (none)'];
  const grouped = new Map();
  for (const row of rows) {
    const key = String(row.side_target ?? row.market_ticker ?? 'MISSING').trim() || 'MISSING';
    const bucket = grouped.get(key) ?? {
      count: 0,
      reasons: new Set(),
    };
    bucket.count += 1;
    if (row.blocker_if_any && row.blocker_if_any !== 'none') {
      bucket.reasons.add(String(row.blocker_if_any));
    }
    const missingLayers = Array.isArray(row.missing_layers) ? row.missing_layers : [];
    if (missingLayers.length) {
      bucket.reasons.add(`missing: ${fmtList(missingLayers, 3)}`);
    }
    if (row.analysis && /missing|source|blocked/i.test(String(row.analysis))) {
      bucket.reasons.add(String(row.analysis).replace(/\s+/g, ' ').slice(0, 160));
    }
    grouped.set(key, bucket);
  }

  const entries = [...grouped.entries()].sort((a, b) => {
    if (b[1].count !== a[1].count) return b[1].count - a[1].count;
    return a[0].localeCompare(b[0]);
  });

  const lines = [];
  for (const [eventLabel, bucket] of entries.slice(0, limit)) {
    const reasons = [...bucket.reasons].slice(0, 2).join(' | ') || 'source gap';
    lines.push(`  - ${eventLabel}: ${bucket.count} blocked row(s); ${reasons}`);
  }
  if (entries.length > limit) {
    lines.push(`  ... ${entries.length - limit} more blocked event(s) compacted`);
  }
  return lines;
}

/**
 * Render the full sectioned, mobile-friendly decision packet body. This is the
 * shared customer stack layout used by every cron packet type:
 *   CPC Stack -> Primary Reads -> Watchlist -> Model Below Price ->
 *   Blocked/Needs Source -> Audit Artifacts.
 * Raw inventory NEVER appears here — only the audit artifact paths do.
 */
export function renderSectionedPacket(rows = [], options = {}) {
  const buckets = bucketDecisionRows(rows);
  const auditPaths = Array.isArray(options.auditArtifacts) ? options.auditArtifacts : [];
  const limit = options.perSectionLimit ?? 12;
  const lines = [];

  const total = rows.length;
  const tldr = [
    `top_rated=${buckets.topEdge.length}`,
    `monitor_only=${buckets.watchlist.length}`,
    `lower_rated=${buckets.fades.length}`,
    `blocked=${buckets.blocked.length}`,
    `no_rated_view=${buckets.passes.length}`,
  ].join(' | ');
  lines.push('CPC Stack:');
  if (options.tldrNote) lines.push(`  ${options.tldrNote}`);
  lines.push(`  rows=${total} :: ${tldr}`);
  const headline = buckets.topEdge[0] ?? buckets.watchlist[0] ?? null;
  if (headline) {
    lines.push(`  headline: [CPC Read: ${renderCpcReadValue(headline)}] ${fmt(headline.human_title)} (${headline.edge_cents_or_pp === null ? 'model/price gap MISSING' : `${headline.edge_cents_or_pp >= 0 ? '+' : ''}${headline.edge_cents_or_pp}pp`})`);
  }
  lines.push(`  legend: top-rated > higher-rated > lower-rated > monitor only > blocked > no rated view. ${PRICE_CONTEXT_DISPLAY_ONLY}`);
  lines.push('');

  const section = (title, arr, { showEmpty = true, note = null } = {}) => {
    if (!arr.length && !showEmpty) return;
    lines.push(`=== ${title} (${arr.length}) ===`);
    if (note) lines.push(`  ${note}`);
    if (!arr.length) {
      lines.push('  (none)');
      lines.push('');
      return;
    }
    let i = 0;
    for (const r of arr.slice(0, limit)) {
      i += 1;
      for (const l of compactRowLines(r, i)) lines.push(l);
    }
    if (arr.length > limit) lines.push(`  ... ${arr.length - limit} more (see audit artifact)`);
    lines.push('');
  };

  section('1. TOP-RATED READS', buckets.topEdge, { note: 'The source-backed model clears the current threshold. Confirm the trigger before using the row.' });
  section('2. MONITOR ONLY', buckets.watchlist, { note: 'The model view is thin or evidence is incomplete; each row lists what would change the view.' });
  section('3. PRICE RICH / LOWER-RATED', buckets.fades, { showEmpty: true, note: 'Displayed price sits above the current model view.' });
  lines.push(`=== 4. BLOCKED / NEEDS SOURCE (${buckets.blocked.length}) ===`);
  lines.push('  Settlement- or model-critical input missing. Compact event-level notes only.');
  lines.push(...compactBlockedNotes(buckets.blocked, limit));
  lines.push('');

  lines.push('=== 5. NO RATED VIEW ===');
  lines.push(`  no_rated_view_rows_not_shown: ${buckets.passes.length} (full list lives in the separate audit artifact)`);
  lines.push('');

  lines.push('=== 6. AUDIT ARTIFACTS ===');
  if (auditPaths.length) {
    for (const p of auditPaths) lines.push(`  - ${p}`);
  } else {
    lines.push('  - companion audit artifact written alongside this packet (see *.audit.txt)');
  }
  return lines.join('\n').trimEnd();
}

/**
 * Build the raw-inventory audit artifact text. This is the giant per-contract
 * dump that must stay OUT of the main user-facing packet and live only in the
 * audit file. Caller writes it via writeAudit under a *.inventory base name.
 */
export function buildInventoryArtifact({ marketType, date, eventTicker, inventoryLines = [], meta = {} }) {
  const head = [
    '=== RAW CONTRACT INVENTORY (AUDIT ONLY — NOT IN MAIN PACKET) ===',
    `market_type: ${fmt(marketType)}`,
    `date: ${fmt(date)}`,
    `event_ticker: ${fmt(eventTicker)}`,
    `contract_lines: ${inventoryLines.length}`,
    'note: full board metadata + pricing for audit/routing. Pricing here is NOT a composite scoring input.',
    '',
  ];
  const metaLines = Object.keys(meta).length
    ? ['meta:', ...Object.entries(meta).map(([k, v]) => `  ${k}: ${fmt(v)}`), '']
    : [];
  return head.concat(metaLines, inventoryLines).join('\n');
}

/** True if `text` looks like a raw inventory dump (used by guard tests). */
export function looksLikeRawInventoryDump(text = '') {
  return /RAW CONTRACT INVENTORY/.test(text);
}
