// Settled-history store for mention markets.
//
// Persists settled (closed/resolved) Kalshi mention markets as price-free
// history records, and builds hit/miss match summaries by route/entity/horizon
// for the historical_tendency layer.
//
// HARD RULE: prices/volume/liquidity NEVER persist and NEVER feed scoring.
// Settled YES/NO outcomes are fine — that is the whole point of this store.
// Defense in depth: sanitize on ingest, then re-scan the merged store
// (JSON.stringify against HISTORY_FORBIDDEN_PATTERN) and throw on any hit.

import { promises as fs } from 'node:fs';
import path from 'node:path';

export const HISTORY_FORBIDDEN_FIELDS = Object.freeze([
  'price', 'yes_bid', 'yes_ask', 'no_bid', 'no_ask',
  'last_price', 'last_trade_price_cents',
  'volume', 'volume_24h', 'open_interest',
  'liquidity', 'spread', 'spread_cents',
  'dollar_volume', 'notional_value',
]);

// Any key matching this pattern is stripped at sanitize time, even if it is
// not in the explicit list above.
export const HISTORY_FORBIDDEN_PATTERN = /price|bid|ask|volume|liquidity|interest|spread|notional/i;

function isForbiddenKey(key) {
  return HISTORY_FORBIDDEN_FIELDS.includes(key) || HISTORY_FORBIDDEN_PATTERN.test(key);
}

function normalizeResult(raw) {
  const r = raw?.result ?? raw?.settlement ?? null;
  if (typeof r === 'string') {
    const v = r.toLowerCase();
    if (v === 'yes' || v === 'no') return v;
  }
  return null;
}

// Framework-grade settlement taxonomy. `result` (yes/no/null) is kept for
// backward compatibility; settlement_result is the richer, comparable label.
export const SETTLEMENT_RESULTS = Object.freeze([
  'resolved_yes', 'resolved_no', 'ednq', 'ambiguous', 'unresolved',
]);

// Optional, price-free fields copied through when present. Pulled from
// eventMeta first, then the raw market. Values are deep-sanitized so no
// forbidden key can ride in via a nested object/array.
const OPTIONAL_PRICE_FREE_FIELDS = Object.freeze([
  'market_url',
  'source_url',
  'proof_url',
  'proof_source_named',
  'eligible_speaker_set',
  'source_scope',
  'event_window_start',
  'event_window_end',
  'speaker',
  'rules_snapshot_hash',
]);

function normalizeSettlementResult(rawMarket, eventMeta) {
  const explicit = eventMeta?.settlement_result;
  if (typeof explicit === 'string' && SETTLEMENT_RESULTS.includes(explicit)) {
    return explicit;
  }
  const r = normalizeResult(rawMarket);
  if (r === 'yes') return 'resolved_yes';
  if (r === 'no') return 'resolved_no';
  const raw = String(rawMarket?.result ?? rawMarket?.settlement ?? '').toLowerCase().trim();
  if (raw === 'void' || raw === 'voided' || raw === 'cancelled' || raw === 'canceled') return 'ednq';
  if (raw === 'ednq' || raw === 'no_contest') return 'ednq';
  if (raw === 'ambiguous' || raw === 'disputed') return 'ambiguous';
  return 'unresolved';
}

// Recursively strip any forbidden key (price/bid/ask/volume/liquidity/etc.)
// from a value, walking objects and arrays. Non-container values pass through.
function deepSanitize(value) {
  if (Array.isArray(value)) return value.map(deepSanitize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isForbiddenKey(k)) continue;
      out[k] = deepSanitize(v);
    }
    return out;
  }
  return value;
}

/**
 * sanitizeSettledRecord — pure.
 *
 * Builds a price-free history record from a raw Kalshi market object plus
 * optional event metadata. Only whitelisted, non-pricing fields are copied;
 * forbidden fields are never read into the output. Throws if the caller
 * explicitly asks (via eventMeta) for a forbidden field to be included.
 */
export function sanitizeSettledRecord(rawMarket, eventMeta = {}) {
  if (!rawMarket || typeof rawMarket !== 'object') {
    throw new Error('sanitizeSettledRecord requires a raw market object');
  }
  for (const k of Object.keys(eventMeta ?? {})) {
    if (isForbiddenKey(k)) {
      throw new Error(
        `sanitizeSettledRecord: forbidden field "${k}" requested explicitly. ` +
        'Pricing/volume/liquidity must never enter settled history.'
      );
    }
  }

  const m = rawMarket;
  const e = eventMeta ?? {};

  const record = {
    event_ticker:  e.event_ticker ?? m.event_ticker ?? null,
    market_ticker: m.ticker ?? m.market_ticker ?? null,
    event_date:    e.event_date ?? m.close_time ?? m.expiration_time ?? m.event_date ?? null,
    series_ticker: e.series_ticker ?? m.series_ticker ?? null,
    category:      e.category ?? m.category ?? null,
    strike_term:   m.yes_sub_title ?? m.subtitle ?? m.custom_strike ?? m.title ?? null,
    result:        normalizeResult(m),
    settlement_result: normalizeSettlementResult(m, e),
    route:         e.route ?? null,
    entity:        e.entity ?? null,
    horizon:       e.horizon ?? null,
    context:       [e.event_title ?? null, m.title ?? null].filter(Boolean).join(' — ') || null,
  };

  // Optional, price-free enrichment fields: copied through only when present
  // (eventMeta wins over the raw market). Deep-sanitized so a forbidden key
  // nested inside an accepted value (e.g. eligible_speaker_set entries) can
  // never survive.
  for (const field of OPTIONAL_PRICE_FREE_FIELDS) {
    let v = e[field];
    if (v === undefined) v = m[field];
    if (v === undefined || v === null) continue;
    record[field] = deepSanitize(v);
  }

  // Recursive defense: nothing forbidden may survive (whitelist construction
  // above means this should never trip, but verify anyway).
  assertNoForbiddenFields(record, 'sanitizeSettledRecord output');
  return record;
}

export function assertNoForbiddenFields(value, label = 'history record') {
  const json = JSON.stringify(value, (key, v) => {
    if (key && isForbiddenKey(key)) {
      throw new Error(`${label} contains forbidden field "${key}". Pricing data must never persist in settled history.`);
    }
    return v;
  });
  return json;
}

export function historyStorePath(stateRoot = 'state') {
  return path.join(stateRoot, 'mentions', 'history');
}

function storeFileFor(stateRoot, record) {
  const series = record.series_ticker
    ?? (record.event_ticker ? String(record.event_ticker).split('-')[0] : null)
    ?? 'unknown';
  // Filename-sanitize like the rest of the codebase: never trust raw tickers
  // (e.g. --from-file input) for path construction.
  const safe = String(series).replace(/[^A-Z0-9_-]/gi, '_').slice(0, 80) || 'unknown';
  return path.join(historyStorePath(stateRoot), `${safe}.json`);
}

/**
 * ingestSettledMarkets — fs-based, no network.
 *
 * Sanitizes each raw market, dedupes by market_ticker, merges into the
 * per-series store file, and re-verifies the merged payload is price-free.
 */
export async function ingestSettledMarkets({
  rawMarkets,
  eventMeta = {},
  route = null,
  entity = null,
  horizon = null,
  stateRoot = 'state',
} = {}) {
  if (!Array.isArray(rawMarkets) || rawMarkets.length === 0) {
    return { stored: 0, path: null, records: [] };
  }

  const meta = { ...eventMeta };
  if (route !== null) meta.route = route;
  if (entity !== null) meta.entity = entity;
  if (horizon !== null) meta.horizon = horizon;

  const sanitized = rawMarkets.map((m) => sanitizeSettledRecord(m, meta));
  const filePath = storeFileFor(stateRoot, sanitized[0]);

  await fs.mkdir(path.dirname(filePath), { recursive: true });

  let existing = [];
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    if (Array.isArray(parsed?.records)) existing = parsed.records;
  } catch {
    // missing or corrupt store — start fresh
  }

  const byTicker = new Map();
  for (const rec of [...existing, ...sanitized]) {
    if (rec?.market_ticker) byTicker.set(rec.market_ticker, rec);
  }
  const records = [...byTicker.values()];

  const payload = { updated_utc: new Date().toISOString(), records };

  // Defense in depth: scan the full serialized payload before writing.
  const serialized = assertNoForbiddenFields(payload, `history store ${filePath}`);
  if (HISTORY_FORBIDDEN_PATTERN.test(
    records.flatMap((r) => Object.keys(r)).join('\n')
  )) {
    throw new Error(`history store ${filePath}: forbidden key survived merge`);
  }

  await fs.writeFile(filePath, serialized + '\n', 'utf8');
  return { stored: sanitized.length, path: filePath, records };
}

/**
 * loadHistory — load all store files (or one series). Missing dir → [].
 */
export async function loadHistory({ stateRoot = 'state', seriesTicker = null } = {}) {
  const dir = historyStorePath(stateRoot);
  let files;
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const safeSeries = seriesTicker ? String(seriesTicker).replace(/[^A-Z0-9_-]/gi, '_').slice(0, 80) : null;
  const wanted = safeSeries
    ? files.filter((f) => f === `${safeSeries}.json`)
    : files.filter((f) => f.endsWith('.json'));

  const out = [];
  for (const f of wanted) {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
      if (Array.isArray(parsed?.records)) out.push(...parsed.records);
    } catch {
      // skip unreadable store files
    }
  }
  return out;
}

const TIER_PENALTIES = Object.freeze({
  exact_horizon: 0,
  same_family: 0.15,
  broader_fallback: 0.30,
});

/**
 * buildHistoryMatch — pure. Tiered match over settled history records.
 *
 *   exact_horizon    — same entity AND same horizon, or same series ticker (penalty 0)
 *   same_family      — same entity OR same route, horizon differs (penalty 0.15)
 *   broader_fallback — same route only, or same entity at any context (penalty 0.30)
 */
export function buildHistoryMatch({
  records = [],
  route = null,
  entity = null,
  horizon = null,
  seriesTicker = null,
  maxSamples = 5,
} = {}) {
  const empty = {
    match_tier: 'none',
    match_quality_penalty: null,
    sample_size: 0,
    hits: 0,
    misses: 0,
    hit_rate: null,
    source_tickers: [],
  };
  if (!Array.isArray(records) || records.length === 0) return empty;

  const sameEntity = (r) => entity !== null && r.entity === entity;
  const sameRoute = (r) => route !== null && r.route === route;
  const sameHorizon = (r) => horizon !== null && r.horizon === horizon;
  const sameSeries = (r) => seriesTicker !== null && r.series_ticker === seriesTicker;
  // Same series only counts as exact when horizons do not conflict — a series
  // hosting both weekly and monthly markets must not match cross-horizon at
  // penalty 0.
  const horizonCompatible = (r) => horizon === null || r.horizon == null || sameHorizon(r);

  const isExact = (r) => (sameSeries(r) && horizonCompatible(r)) || (sameEntity(r) && sameHorizon(r));

  let tier = 'none';
  let matched = records.filter(isExact);
  if (matched.length > 0) {
    tier = 'exact_horizon';
  } else {
    // same_family: same entity OR same route, horizon differs
    matched = records.filter((r) => (sameEntity(r) || sameRoute(r)) && !sameHorizon(r));
    if (matched.length > 0) {
      tier = 'same_family';
    } else {
      // broader_fallback: same route only, or same entity at any context
      matched = records.filter((r) => sameRoute(r) || sameEntity(r));
      if (matched.length > 0) tier = 'broader_fallback';
    }
  }
  if (tier === 'none') return empty;

  // Only settled outcomes consume sample slots — null-result records
  // (unsettled/unparsable) must not displace usable hit/miss history.
  const settled = matched.filter((r) => r.result === 'yes' || r.result === 'no');
  if (settled.length === 0) return empty;
  settled.sort((a, b) => String(b.event_date ?? '').localeCompare(String(a.event_date ?? '')));
  const sample = settled.slice(0, maxSamples);

  const hits = sample.filter((r) => r.result === 'yes').length;
  const misses = sample.filter((r) => r.result === 'no').length;
  const denom = hits + misses;

  return {
    match_tier: tier,
    match_quality_penalty: TIER_PENALTIES[tier],
    sample_size: sample.length,
    hits,
    misses,
    hit_rate: denom > 0 ? hits / denom : null,
    source_tickers: sample.map((r) => r.market_ticker).filter(Boolean),
  };
}

/**
 * historyToLayerScore — convert a match into a historical_tendency layer
 * record compatible with composeMentionLedger (mention-composite-core).
 */
export function historyToLayerScore(match) {
  const settledCount = (match?.hits ?? 0) + (match?.misses ?? 0);
  // Wave-1 gate: fewer than 2 settled outcomes is not evidence (runbook:
  // n<2 -> NO_TRADE). One coincidental YES must never score 100.
  if (!match || match.match_tier === 'none' || match.hit_rate === null || settledCount < 2) {
    return {
      present: false,
      score: null,
      source_basis: 'settled-history: no usable match',
      source_path: null,
      detail: null,
      missing_note: settledCount === 1
        ? 'insufficient settled history (n<2 settled outcomes)'
        : 'no settled history available',
    };
  }
  const penalty = match.match_quality_penalty ?? 0;
  const score = Math.max(0, Math.min(100, Math.round(100 * match.hit_rate * (1 - penalty))));
  const note = `settled history ${match.hits}/${match.hits + match.misses} hits, tier=${match.match_tier}`;
  return {
    present: true,
    score,
    source_basis: note,
    source_path: null,
    detail: `${note}; penalty=${penalty}; samples=${match.sample_size}`,
    missing_note: null,
  };
}
