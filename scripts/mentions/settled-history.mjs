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
import { canonicalEventTime } from './event-integrity.mjs';

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
  const eventTime = canonicalEventTime({ ...m, ...e });

  const record = {
    event_ticker:  e.event_ticker ?? m.event_ticker ?? null,
    market_ticker: m.ticker ?? m.market_ticker ?? null,
    event_date:    eventTime.status === 'CONFIRMED' ? eventTime.iso : null,
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
 * loadHistoryWithStatus — status-carrying loader.
 *
 * Distinguishes a genuinely-empty/absent settled-history store from a lookup
 * failure, so downstream callers can never flatten "store never ingested" into
 * "zero comparables found" (a healthy empty result). Returns:
 *   { status: 'ok' | 'store_missing' | 'read_error', records: [], errors: [] }
 *
 *   ok            — store dir readable; zero or more records loaded (records
 *                   may be [] when the dir exists but holds no *.json files, or
 *                   when files parse but carry no `records` array).
 *   store_missing — ENOENT on the store dir (the settled-history store has
 *                   never been ingested on this worktree).
 *   read_error    — any other fs/parse failure (permissions, corrupt JSON, …);
 *                   per-file failures are collected in `errors`.
 */
export async function loadHistoryWithStatus({ stateRoot = 'state', seriesTicker = null } = {}) {
  const dir = historyStorePath(stateRoot);
  let files;
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { status: 'store_missing', records: [], errors: [] };
    }
    return { status: 'read_error', records: [], errors: [err?.code ? `${err.code}: ${err.message}` : String(err?.message ?? err)] };
  }
  const safeSeries = seriesTicker ? String(seriesTicker).replace(/[^A-Z0-9_-]/gi, '_').slice(0, 80) : null;
  const wanted = safeSeries
    ? files.filter((f) => f === `${safeSeries}.json`)
    : files.filter((f) => f.endsWith('.json'));

  const out = [];
  const errors = [];
  for (const f of wanted) {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
      if (Array.isArray(parsed?.records)) out.push(...parsed.records);
    } catch (err) {
      errors.push(`${f}: ${err?.code ? `${err.code} ` : ''}${err?.message ?? err}`);
    }
  }
  // A per-file read/parse failure is a read_error of the whole lookup — we
  // cannot truthfully claim `ok` when store files were unreadable, even if
  // some records loaded. `store_missing` is reserved for the dir-level ENOENT.
  const status = errors.length > 0 ? 'read_error' : 'ok';
  return { status, records: out, errors };
}

/**
 * loadHistory — back-compat delegate. Missing/unreadable store → []. Existing
 * callers and tests keep working; use `loadHistoryWithStatus` when the
 * distinction between "store absent" and "store empty" matters.
 */
export async function loadHistory({ stateRoot = 'state', seriesTicker = null } = {}) {
  const { records } = await loadHistoryWithStatus({ stateRoot, seriesTicker });
  return records;
}

const TIER_PENALTIES = Object.freeze({
  exact_horizon: 0,
  same_family: 0.15,
  broader_fallback: 0.30,
});

/**
 * selectHistoryTier — pure. Route-aware tier selection over settled history.
 *
 * Returns { tier, matched } where matched is the full record pool (including
 * soft/unsettled outcomes) selected at the winning tier. Shared by both
 * buildHistoryMatch (aggregate hit/miss) and buildSettledHistoryArtifact
 * (full settlement-class breakdown), so the priority ordering lives in one
 * place. NEVER reads price/bid/ask/volume/etc. — only route/entity/horizon/
 * series identity fields.
 *
 *   exact_horizon    — same entity AND same horizon, or same series ticker (penalty 0)
 *   same_family      — same entity OR same route, horizon differs (penalty 0.15)
 *   broader_fallback — same route only, or same entity at any context (penalty 0.30)
 */
export function selectHistoryTier({
  records = [],
  route = null,
  entity = null,
  horizon = null,
  seriesTicker = null,
} = {}) {
  if (!Array.isArray(records) || records.length === 0) return { tier: 'none', matched: [] };

  const sameEntity = (r) => entity !== null && r.entity === entity;
  const sameRoute = (r) => route !== null && r.route === route;
  const sameHorizon = (r) => horizon !== null && r.horizon === horizon;
  const sameSeries = (r) => seriesTicker !== null && r.series_ticker === seriesTicker;
  // Same series only counts as exact when horizons do not conflict — a series
  // hosting both weekly and monthly markets must not match cross-horizon at
  // penalty 0.
  const horizonCompatible = (r) => horizon === null || r.horizon == null || sameHorizon(r);

  const isExact = (r) => (sameSeries(r) && horizonCompatible(r)) || (sameEntity(r) && sameHorizon(r));

  let matched = records.filter(isExact);
  if (matched.length > 0) return { tier: 'exact_horizon', matched };

  // same_family: same entity OR same route, horizon differs
  matched = records.filter((r) => (sameEntity(r) || sameRoute(r)) && !sameHorizon(r));
  if (matched.length > 0) return { tier: 'same_family', matched };

  // broader_fallback: same route only, or same entity at any context
  matched = records.filter((r) => sameRoute(r) || sameEntity(r));
  if (matched.length > 0) return { tier: 'broader_fallback', matched };

  return { tier: 'none', matched: [] };
}

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

  const { tier, matched } = selectHistoryTier({ records, route, entity, horizon, seriesTicker });
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
 * normalizeStrikeKey — pure, deterministic, route-neutral.
 *
 * Collapse any strike phrase / settlement strike_term to a comparable key:
 * lowercase, non-alphanumeric runs → single space, trimmed. Never reads or
 * emits price/bid/ask/volume/etc. — it only sees the term text.
 *
 *   "SNAP / Food Stamp" -> "snap   food stamp" pieces; see strikeMatchKeys
 *   "GLP-1"             -> "glp 1"
 *   "tariff"           -> "tariff"
 */
export function normalizeStrikeKey(term) {
  return String(term ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// Candidate match keys for one current strike. Slash-alternatives each become a
// key (so "SNAP / Food Stamp" matches a prior board strike of either "SNAP" or
// "Food Stamp"), plus the whole-phrase key as a fallback.
function strikeMatchKeys(strikePhrase) {
  const phrase = String(strikePhrase ?? '');
  const parts = phrase.includes('/') ? phrase.split('/') : [phrase];
  const keys = new Set();
  for (const p of parts) {
    const k = normalizeStrikeKey(p);
    if (k) keys.add(k);
  }
  const whole = normalizeStrikeKey(phrase);
  if (whole) keys.add(whole);
  return keys;
}

function settlementOf(rec) {
  const s = rec?.settlement_result;
  if (SETTLEMENT_RESULTS.includes(s)) return s;
  const r = rec?.result;
  if (r === 'yes') return 'resolved_yes';
  if (r === 'no') return 'resolved_no';
  return 'unresolved';
}

function toMs(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

const DAY_MS = 86_400_000;

/**
 * joinMentionHistoryCoverage — pure, deterministic, route-neutral primitive.
 *
 * Joins current-board strikes against prior SANITIZED settled-history records
 * (the price-free store produced by sanitizeSettledRecord) and reports, per
 * strike, how the historical Kalshi board actually resolved. This replaces the
 * hardwired "prior_board_seen=false / all-zero / needs_fresh=true" assumption
 * with real hit/miss/ambiguous counts whenever history exists.
 *
 * Matching is term-only and deterministic (normalizeStrikeKey). It NEVER reads
 * price/bid/ask/volume/open-interest — those fields are not consulted and never
 * appear in the output rows. Optional route/entity/horizon metadata acts as an
 * additional filter (lenient: a record passes if it lacks the field), so any
 * submarket — earnings, political, sports, TV — flows through unchanged.
 *
 * @param {object} opts
 * @param {Array<{ticker,strike}>} opts.strikes       current-board strikes
 * @param {Array<object>}          opts.history        prior sanitized records
 * @param {string|null} opts.route                     optional route filter
 * @param {string|null} opts.entity                    optional entity filter
 * @param {string|null} opts.horizon                   optional horizon filter
 * @param {string|number|Date|null} opts.now           reference "now" (default Date.now)
 * @param {number} opts.staleAfterDays                 resolved history older than
 *                                                     this is stale (default 400)
 * @param {number} opts.ambiguousThreshold             soft/total ratio at/above
 *                                                     which a strike is treated as
 *                                                     ambiguous-heavy (default 0.5)
 * @param {boolean} opts.includeMatchedTickers         attach bounded, price-free
 *                                                     matched market_ticker list
 *
 * Per-strike output row keys: ticker, strike, prior_board_seen, resolved_yes,
 * resolved_no, ednq, ambiguous, unresolved, matching_history_count,
 * history_status, history_confidence, needs_fresh_source_fetch, reason.
 */
export function joinMentionHistoryCoverage({
  strikes = [],
  history = [],
  route = null,
  entity = null,
  horizon = null,
  now = null,
  staleAfterDays = 400,
  ambiguousThreshold = 0.5,
  includeMatchedTickers = false,
} = {}) {
  const nowMs = toMs(now) ?? Date.now();
  const metaPass = (rec) => {
    if (route != null && rec.route != null && rec.route !== route) return false;
    if (entity != null && rec.entity != null && rec.entity !== entity) return false;
    if (horizon != null && rec.horizon != null && rec.horizon !== horizon) return false;
    return true;
  };
  const usable = (Array.isArray(history) ? history : []).filter(metaPass);

  const rows = (Array.isArray(strikes) ? strikes : []).map(({ ticker, strike }) => {
    const keys = strikeMatchKeys(strike);
    const matched = usable.filter((rec) => keys.has(normalizeStrikeKey(rec.strike_term)));

    const counts = { resolved_yes: 0, resolved_no: 0, ednq: 0, ambiguous: 0, unresolved: 0 };
    let newestResolvedMs = null;
    for (const rec of matched) {
      const s = settlementOf(rec);
      counts[s] += 1;
      if (s === 'resolved_yes' || s === 'resolved_no') {
        const ms = toMs(rec.event_date);
        if (ms != null && (newestResolvedMs == null || ms > newestResolvedMs)) newestResolvedMs = ms;
      }
    }

    const matchingCount = matched.length;
    const resolvedCount = counts.resolved_yes + counts.resolved_no;
    const softCount = counts.ednq + counts.ambiguous + counts.unresolved;
    const freshResolved =
      resolvedCount > 0 && newestResolvedMs != null && (nowMs - newestResolvedMs) <= staleAfterDays * DAY_MS;
    const ambiguousHeavy = matchingCount > 0 && softCount / matchingCount >= ambiguousThreshold;

    let historyStatus;
    let historyConfidence;
    let needsFresh;
    let reason;
    if (matchingCount === 0) {
      historyStatus = 'no_history';
      historyConfidence = 'none';
      needsFresh = true;
      reason = 'no prior settled board matched this strike; fresh source fetch required';
    } else if (resolvedCount === 0) {
      historyStatus = 'unresolved_only';
      historyConfidence = 'none';
      needsFresh = true;
      reason = `prior board matched ${matchingCount} record(s) but none resolved yes/no (ednq/ambiguous/unresolved); fresh source fetch required`;
    } else if (ambiguousHeavy) {
      historyStatus = 'ambiguous_heavy';
      historyConfidence = 'low';
      needsFresh = true;
      reason = `prior board mostly soft outcomes (${softCount}/${matchingCount} ednq/ambiguous/unresolved); fresh source fetch required`;
    } else if (!freshResolved) {
      historyStatus = 'stale';
      historyConfidence = 'low';
      needsFresh = true;
      reason = `resolved history present (${counts.resolved_yes}Y/${counts.resolved_no}N) but older than ${staleAfterDays}d; fresh source fetch required`;
    } else {
      historyStatus = 'resolved_fresh';
      historyConfidence = 'high';
      needsFresh = false;
      reason = `confident resolved history (${counts.resolved_yes}Y/${counts.resolved_no}N) within ${staleAfterDays}d; no fresh source fetch required`;
    }

    const row = {
      ticker: ticker ?? null,
      strike: strike ?? null,
      prior_board_seen: matchingCount > 0,
      resolved_yes: counts.resolved_yes,
      resolved_no: counts.resolved_no,
      ednq: counts.ednq,
      ambiguous: counts.ambiguous,
      unresolved: counts.unresolved,
      matching_history_count: matchingCount,
      history_status: historyStatus,
      history_confidence: historyConfidence,
      needs_fresh_source_fetch: needsFresh,
      reason,
    };
    if (includeMatchedTickers) {
      row.matched_history_tickers = matched
        .map((r) => r.market_ticker)
        .filter((t) => typeof t === 'string' && t.length > 0)
        .slice(0, 10);
    }
    return row;
  });

  const summary = {
    strike_count: rows.length,
    history_covered_strikes: rows.filter((r) => r.prior_board_seen).length,
    confident_history_strikes: rows.filter((r) => r.history_status === 'resolved_fresh').length,
    needs_fresh_source_fetch_strikes: rows.filter((r) => r.needs_fresh_source_fetch).length,
    total_history_records: usable.length,
  };

  const out = { rows, summary };
  // Defense in depth: nothing price-shaped may ride out of the join.
  assertNoForbiddenFields(out, 'joinMentionHistoryCoverage output');
  return out;
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

function uniqueStrings(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const v = item.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * buildSettledHistoryArtifact — pure. Route-aware, PRICE-FREE settled-history
 * artifact for buildMentionCompositeForMarket to attach as an explicit field.
 *
 * Wraps the tested buildHistoryMatch (tier + aggregate hits/misses/penalty) and
 * adds a full settlement-class breakdown (resolved_yes/resolved_no/ednq/
 * ambiguous/unresolved) computed over the SAME tiered pool via settlementOf, so
 * EDNQ/ambiguous/unresolved are recorded but NEVER counted as confident hit or
 * miss (only resolved YES/NO feed hits/misses/hit_rate, n<2 → not usable).
 *
 * Empty / no-match / insufficient (n<2) history fails safe: usable=false,
 * fail_safe=true, hit_rate=null — no fake conviction.
 *
 * Reads only identity + settlement fields. Output is re-scanned for forbidden
 * price-shaped keys before return (defense in depth).
 *
 * @param {object} opts
 * @param {Array<object>} opts.records        prior SANITIZED settled records
 * @param {string|null} opts.route            research route / rule family
 * @param {string|null} opts.entity           speaker/company/show/sport/format
 * @param {string|null} opts.horizon          weekly/monthly/event horizon
 * @param {string|null} opts.seriesTicker     exact event/series family
 * @param {string[]} opts.acceptedForms       accepted lexical forms (provenance)
 * @param {number} opts.maxSamples            most-recent settled cap (default 5)
 */
export function buildSettledHistoryArtifact({
  records = [],
  route = null,
  entity = null,
  horizon = null,
  seriesTicker = null,
  acceptedForms = [],
  maxSamples = 5,
} = {}) {
  const match = buildHistoryMatch({ records, route, entity, horizon, seriesTicker, maxSamples });
  const { tier, matched } = selectHistoryTier({ records, route, entity, horizon, seriesTicker });

  const settlement_breakdown = {
    resolved_yes: 0, resolved_no: 0, ednq: 0, ambiguous: 0, unresolved: 0,
  };
  for (const rec of matched) {
    const s = settlementOf(rec);
    if (s in settlement_breakdown) settlement_breakdown[s] += 1;
  }

  const usable = match.match_tier !== 'none' && match.hit_rate !== null && match.sample_size >= 2;
  const note = usable
    ? `settled history ${match.hits}/${match.hits + match.misses} resolved hits, tier=${match.match_tier}, penalty=${match.match_quality_penalty}`
    : (match.sample_size === 1
        ? 'insufficient settled history (n<2 settled outcomes); fail-safe (no conviction)'
        : 'no usable settled history; fail-safe (no conviction)');

  const artifact = {
    evidence_class: 'settled_history',
    status: usable ? 'present' : (match.sample_size > 0 ? 'unavailable' : 'verified_zero'),
    route,
    entity,
    horizon,
    series_ticker: seriesTicker,
    match_tier: match.match_tier,
    match_quality_penalty: match.match_quality_penalty,
    sample_size: match.sample_size,
    hits: match.hits,
    misses: match.misses,
    hit_rate: match.hit_rate,
    source_tickers: match.source_tickers,
    settlement_breakdown,
    matched_count: matched.length,
    accepted_forms: uniqueStrings(acceptedForms),
    usable,
    fail_safe: !usable,
    note,
  };

  // Defense in depth: no price-shaped key may ride out of the artifact.
  assertNoForbiddenFields(artifact, 'buildSettledHistoryArtifact output');
  return artifact;
}
