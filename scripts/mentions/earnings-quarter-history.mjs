// Earnings quarter history for earnings_call-routed mention markets.
//
// Loads the last 4 COMPLETED quarterly earnings mention events for a company
// family from a local file store (state/mentions/earnings-history/<ticker>.json)
// and computes per-term quarter-by-quarter hit/miss tendencies for the
// historical_tendency layer.
//
// HARD RULE (same as settled-history.mjs): prices/volume/liquidity NEVER
// persist and NEVER feed scoring. Defense in depth: whitelist construction at
// ingest, then regex re-scan of every serialized payload and output layer.
// File/fixture-based only — NO crawling, NO network in this module.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  HISTORY_FORBIDDEN_PATTERN,
  assertNoForbiddenFields,
} from './settled-history.mjs';
import { canonicalEventTime } from './event-integrity.mjs';

export const MAX_QUARTERS = 4;

// Known company-name -> ticker map for Kalshi-style earnings mention events.
// Resolver is pure/offline: title + ticker text only, never price fields.
export const EARNINGS_COMPANY_TICKERS = Object.freeze({
  nvidia: 'NVDA',
  tesla: 'TSLA',
  apple: 'AAPL',
  microsoft: 'MSFT',
  amazon: 'AMZN',
  meta: 'META',
  facebook: 'META',
  alphabet: 'GOOGL',
  google: 'GOOGL',
  netflix: 'NFLX',
  amd: 'AMD',
  intel: 'INTC',
  palantir: 'PLTR',
  coinbase: 'COIN',
  disney: 'DIS',
  boeing: 'BA',
  jpmorgan: 'JPM',
  'jpmorgan chase': 'JPM',
  'jpmorgan chase & co.': 'JPM',
  'jp morgan': 'JPM',
  goldman: 'GS',
  'goldman sachs': 'GS',
  'wells fargo': 'WFC',
  citi: 'C',
  citigroup: 'C',
  'bank of america': 'BAC',
  'morgan stanley': 'MS',
});

const TICKER_TO_COMPANY = Object.freeze(Object.fromEntries(
  Object.entries(EARNINGS_COMPANY_TICKERS).map(([name, t]) => [t, name])
));

function asText(v) {
  return v == null ? '' : String(v).trim();
}

/**
 * resolveEarningsFamily — pure. Identifies company/ticker/event family from a
 * Kalshi-style earnings mention event (title / sub_title / series_ticker /
 * event_ticker). Returns { company, ticker, family } or null when no known
 * company can be identified.
 */
export function resolveEarningsFamily(event) {
  if (!event || typeof event !== 'object') return null;
  const titleText = [event.title, event.sub_title].map(asText).join(' ').toLowerCase();
  const tickerText = [event.series_ticker, event.event_ticker].map(asText).join(' ').toUpperCase();

  let ticker = null;
  let company = null;

  // 1) Company name in title text (word boundary; longest names first so
  //    "meta" never shadows a longer match).
  const names = Object.keys(EARNINGS_COMPANY_TICKERS).sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (new RegExp(`\\b${name}\\b`, 'i').test(titleText)) {
      company = name;
      ticker = EARNINGS_COMPANY_TICKERS[name];
      break;
    }
  }

  // 2) Stock ticker embedded in the series/event ticker (e.g. KXNVDAMENTION,
  //    KXEARNINGSNVDA-26Q1). Longest tickers first ("GOOGL" before any
  //    shorter substring win).
  if (!ticker && tickerText) {
    const tickers = [...new Set(Object.values(EARNINGS_COMPANY_TICKERS))]
      .sort((a, b) => b.length - a.length);
    for (const t of tickers) {
      if (tickerText.includes(t)) {
        ticker = t;
        company = TICKER_TO_COMPANY[t] ?? null;
        break;
      }
    }
  }

  if (!ticker) return null;
  return {
    company,
    ticker,
    family: `${ticker.toLowerCase()}_earnings_call`,
  };
}

export function earningsHistoryStorePath(stateRoot = 'state') {
  return path.join(stateRoot, 'mentions', 'earnings-history');
}

function storeFileFor(stateRoot, ticker) {
  const safe = String(ticker ?? 'unknown').replace(/[^A-Z0-9_-]/gi, '_').slice(0, 80) || 'unknown';
  return path.join(earningsHistoryStorePath(stateRoot), `${safe}.json`);
}

function normalizeOutcome(raw) {
  if (typeof raw === 'boolean') return raw ? 'yes' : 'no';
  if (typeof raw === 'string') {
    const v = raw.toLowerCase();
    if (v === 'yes' || v === 'no') return v;
  }
  return null;
}

function isForbiddenKey(key) {
  return HISTORY_FORBIDDEN_PATTERN.test(key);
}

/**
 * sanitizeQuarterRecord — pure. Whitelist-builds a price-free completed-
 * quarter record from a raw quarter object. Forbidden keys (price/volume/
 * liquidity etc., per HISTORY_FORBIDDEN_PATTERN) are never copied; outcomes
 * keep only yes/no per strike term. Misses ('no') are recorded, not skipped.
 */
export function sanitizeQuarterRecord(rawQuarter) {
  if (!rawQuarter || typeof rawQuarter !== 'object') {
    throw new Error('sanitizeQuarterRecord requires a raw quarter object');
  }
  const q = rawQuarter;
  const outcomes = {};
  const rawOutcomes = q.outcomes ?? q.term_outcomes ?? {};
  for (const [term, raw] of Object.entries(rawOutcomes)) {
    if (isForbiddenKey(term)) continue; // never key history on pricing terms
    const result = normalizeOutcome(typeof raw === 'object' && raw !== null ? raw.result : raw);
    if (result !== null) outcomes[term] = result; // 'no' (miss) is kept
  }

  const eventTime = canonicalEventTime(q);
  const record = {
    quarter: asText(q.quarter ?? q.fiscal_quarter) || null,
    event_ticker: asText(q.event_ticker) || null,
    event_date: eventTime.status === 'CONFIRMED' ? eventTime.iso : null,
    completed: q.completed !== false && Object.keys(outcomes).length > 0,
    outcomes,
  };

  assertNoForbiddenFields(record, 'sanitizeQuarterRecord output');
  return record;
}

/**
 * ingestEarningsQuarters — fs-based, no network. Sanitizes each raw quarter,
 * dedupes by quarter id (newest write wins), merges into the per-ticker store
 * file, and re-verifies the merged payload is price-free before writing.
 */
export async function ingestEarningsQuarters({
  ticker,
  rawQuarters,
  stateRoot = 'state',
} = {}) {
  if (!ticker) throw new Error('ingestEarningsQuarters requires a ticker');
  if (!Array.isArray(rawQuarters) || rawQuarters.length === 0) {
    return { stored: 0, path: null, quarters: [] };
  }

  const sanitized = rawQuarters.map((q) => sanitizeQuarterRecord(q));
  const filePath = storeFileFor(stateRoot, ticker);
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  let existing = [];
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    if (Array.isArray(parsed?.quarters)) existing = parsed.quarters;
  } catch {
    // missing or corrupt store — start fresh
  }

  const byQuarter = new Map();
  for (const rec of [...existing, ...sanitized]) {
    const key = rec?.quarter ?? rec?.event_ticker;
    if (key) byQuarter.set(key, rec);
  }
  const quarters = [...byQuarter.values()]
    .sort((a, b) => String(b.event_date ?? '').localeCompare(String(a.event_date ?? '')));

  const payload = { ticker: String(ticker).toUpperCase(), updated_utc: new Date().toISOString(), quarters };

  // Defense in depth: scan the full serialized payload before writing.
  const serialized = assertNoForbiddenFields(payload, `earnings history store ${filePath}`);
  if (HISTORY_FORBIDDEN_PATTERN.test(
    quarters.flatMap((r) => [...Object.keys(r), ...Object.keys(r.outcomes ?? {})]).join('\n')
  )) {
    throw new Error(`earnings history store ${filePath}: forbidden key survived merge`);
  }

  await fs.writeFile(filePath, serialized + '\n', 'utf8');
  return { stored: sanitized.length, path: filePath, quarters };
}

/**
 * loadEarningsHistory — load the per-ticker store. Missing file → [].
 * Returns completed quarters only, newest first.
 */
export async function loadEarningsHistory({ ticker, stateRoot = 'state' } = {}) {
  if (!ticker) return [];
  try {
    const parsed = JSON.parse(await fs.readFile(storeFileFor(stateRoot, ticker), 'utf8'));
    const quarters = Array.isArray(parsed?.quarters) ? parsed.quarters : [];
    return quarters
      .filter((q) => q?.completed === true)
      .sort((a, b) => String(b.event_date ?? '').localeCompare(String(a.event_date ?? '')));
  } catch {
    return [];
  }
}

/**
 * buildEarningsQuarterLayer — pure, deterministic.
 *
 * For each current strike term, computes against the most recent (up to 4)
 * completed quarters:
 *   q_minus_1..q_minus_4   — hit (true) / miss (false) / null (no market that quarter)
 *   four_quarter_hit_rate  — hits / settled quarters in the window
 *   sample_size            — settled quarters used for that term
 *   recency_weighted_hit_rate — linear weights, newest-heavy (n, n-1, ... 1)
 *
 * Misses are recorded, not skipped. 0 usable quarters → returns null (absent
 * layer, no fake conviction). Fewer than 4 → uses all available with
 * sample_size recorded.
 */
export function buildEarningsQuarterLayer({ family = null, ticker = null, terms = [], quarters = [] } = {}) {
  const completed = (Array.isArray(quarters) ? quarters : [])
    .filter((q) => q && q.completed !== false && q.outcomes && Object.keys(q.outcomes).length > 0)
    .sort((a, b) => String(b.event_date ?? '').localeCompare(String(a.event_date ?? '')))
    .slice(0, MAX_QUARTERS);

  if (completed.length === 0) return null;

  const termList = (Array.isArray(terms) ? terms : []).map(asText).filter(Boolean);
  const perTerm = {};
  const provenance = {};

  for (const term of termList) {
    const key = term.toLowerCase();
    const slots = { q_minus_1: null, q_minus_2: null, q_minus_3: null, q_minus_4: null };
    const settled = []; // [{ hit, recencyIndex }] newest first
    const quartersUsed = [];

    completed.forEach((q, i) => {
      const raw = q.outcomes[term] ?? q.outcomes[key]
        ?? q.outcomes[Object.keys(q.outcomes).find((k) => k.toLowerCase() === key) ?? ''];
      const result = normalizeOutcome(raw);
      if (i < MAX_QUARTERS) slots[`q_minus_${i + 1}`] = result === null ? null : result === 'yes';
      if (result !== null) {
        settled.push({ hit: result === 'yes', recencyIndex: i });
        quartersUsed.push(q.quarter ?? q.event_ticker ?? `q_minus_${i + 1}`);
      }
    });

    const n = settled.length;
    if (n === 0) continue; // term never traded in history — no fake conviction

    const hits = settled.filter((s) => s.hit).length;
    // Linear newest-heavy weights over settled quarters: newest gets n, oldest 1.
    let wSum = 0;
    let wHit = 0;
    settled.forEach((s, idx) => {
      const w = n - idx; // settled[] is newest-first
      wSum += w;
      if (s.hit) wHit += w;
    });

    perTerm[key] = {
      ...slots,
      four_quarter_hit_rate: hits / n,
      recency_weighted_hit_rate: wHit / wSum,
      sample_size: n,
      hits,
      misses: n - hits,
      quarters_used: quartersUsed,
    };
    provenance[key] = {
      hit_rate: hits / n,
      sample_size: n,
      quarters: quartersUsed,
    };
  }

  if (Object.keys(perTerm).length === 0) return null;

  const layer = {
    family,
    ticker,
    quarters_considered: completed.map((q) => q.quarter ?? q.event_ticker).filter(Boolean),
    terms: perTerm,
    last_four_quarter_hit_rate: provenance,
  };

  // Defense in depth: nothing price-shaped may ever appear in the output.
  assertNoForbiddenFields(layer, 'earnings quarter layer');
  return layer;
}

/**
 * earningsLayerToHistoricalTendency — convert one term's quarter stats into a
 * historical_tendency layer record compatible with composeMentionLedger.
 * Wave-1 gate: n<2 settled quarters is not evidence (runbook: n<2 → NO_TRADE).
 */
export function earningsLayerToHistoricalTendency(layer, term) {
  const key = asText(term).toLowerCase();
  const stats = layer?.terms?.[key] ?? null;
  if (!stats || stats.sample_size < 2) {
    return {
      present: false,
      score: null,
      source_basis: 'earnings-quarter-history: no usable match',
      source_path: null,
      detail: null,
      missing_note: stats?.sample_size === 1
        ? 'insufficient settled history (n<2 settled quarters)'
        : 'no completed earnings quarters available',
    };
  }
  const score = Math.max(0, Math.min(100, Math.round(100 * stats.recency_weighted_hit_rate)));
  const note = `earnings history ${stats.hits}/${stats.sample_size} hits over last ${stats.sample_size} quarters`;
  return {
    present: true,
    score,
    source_basis: note,
    source_path: null,
    detail: `${note}; recency_weighted=${stats.recency_weighted_hit_rate.toFixed(4)}; quarters=${stats.quarters_used.join(',')}`,
    missing_note: null,
  };
}
