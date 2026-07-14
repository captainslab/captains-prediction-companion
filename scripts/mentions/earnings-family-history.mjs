// Kalshi API family-level settled history for earnings mention series.
// Only normalized strike words and YES/NO outcomes persist; price-shaped fields never do.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { KALSHI_API_BASE } from '../packets/lib/kalshi-discovery.mjs';
import { assertNoForbiddenFields } from './settled-history.mjs';
import { EARNINGS_COMPANY_TICKERS } from './earnings-quarter-history.mjs';

const PREFIX = 'KXEARNINGSMENTION';
const FORBIDDEN = /price|bid|ask|volume|open_interest|liquidity|spread|notional/i;
export const FAMILY_PENALTY_STRONG = 0.30; // n >= 5: real cross-company base rate, meaningfully weaker than same-company
export const FAMILY_PENALTY_THIN = 0.50; // n = 2..4: same question, different company, thin sample
export const FAMILY_STRONG_MIN_N = 5;
export const FAMILY_HISTORY_MAX_PAGES = 50;
export const FAMILY_HISTORY_MAX_REQUESTS = 1000;
export const earningsFamilyHistoryPath = (stateRoot = 'state') => path.join(stateRoot, 'mentions', 'earnings-family-history.json');

// Family history intentionally uses a local key because cross-company
// settlement words are aggregated with a small singular/plural tolerance.
// Kalshi-native exact-series matching has a separate private normalizer and
// must remain byte-for-byte unchanged. Keep this family-local normalizer
// deliberately conservative: only ordinary trailing-s plural forms pool.
function singularizeFamilyWord(word) {
  if (word.length <= 3 || !word.endsWith('s')) return word;
  // These endings are commonly singular words, not ordinary plural -s forms.
  // In particular, this protects congress, crisis, and business.
  if (word.endsWith('ies') || /(?:ss|us|is|ous|ics)$/.test(word)) return word;
  return word.slice(0, -1);
}

export function familyWordKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(singularizeFamilyWord)
    .join(' ');
}

function nowMs(value) { const v = typeof value === 'function' ? value() : value; return v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v ?? new Date().toISOString()); }
function priceFree(value) {
  // by_word is an object for cheap lookup, so its keys are data (strike words),
  // not schema fields. Canonicalize those keys to rows for the shared guard;
  // otherwise a valid strike literally named "price" would be rejected.
  const rows = value?.by_word && typeof value.by_word === 'object'
    ? (Array.isArray(value.by_word) ? value.by_word : Object.values(value.by_word))
    : value?.by_word;
  const companyRows = value?.by_company_word && typeof value.by_company_word === 'object'
    ? Object.values(value.by_company_word).flatMap((words) => Object.values(words ?? {}))
    : value?.by_company_word;
  assertNoForbiddenFields({ ...value, by_word: rows, by_company_word: companyRows }, 'earnings family history');
  const walk = (x, path = []) => {
    if (!x || typeof x !== 'object') return;
    for (const [k, v] of Object.entries(x)) {
      const isWordMapKey =
        (path.length === 1 && ['by_word', 'by_company_word'].includes(path[0]))
        || (path.length === 2 && path[0] === 'by_company_word');
      if (!isWordMapKey && FORBIDDEN.test(k)) throw new Error(`forbidden field persisted: ${k}`);
      walk(v, [...path, k]);
    }
  };
  walk(value); return value;
}
async function json(fetchImpl, url) {
  let res; try { res = await fetchImpl(url); } catch (e) { throw new Error(`earnings family history fetch failed: ${e?.message ?? String(e)}`); }
  if (!res?.ok) throw new Error(`earnings family history fetch failed: HTTP ${res?.status ?? 'unknown'}`);
  return res.json();
}
async function pages(fetchImpl, endpoint, params, key, { requestBudget, maxPages }) {
  const out = [];
  let cursor = '';
  let pageCount = 0;
  while (true) {
    if (pageCount >= maxPages) {
      throw new Error(`earnings family history scan exceeded max pages for ${endpoint}`);
    }
    if (requestBudget.remaining <= 0) {
      throw new Error('earnings family history scan exceeded max requests');
    }
    const u = new URL(`${KALSHI_API_BASE}${endpoint}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    if (cursor) u.searchParams.set('cursor', cursor);
    requestBudget.remaining -= 1;
    pageCount += 1;
    const body = await json(fetchImpl, u.toString());
    if (Array.isArray(body?.[key])) out.push(...body[key]);
    cursor = body?.cursor ? String(body.cursor) : '';
    if (!cursor) return out;
  }
}

export async function fetchEarningsFamilyHistory({
  fetchImpl = fetch,
  stateRoot = 'state',
  ttlMs = 86_400_000,
  now = Date.now,
  maxPages = FAMILY_HISTORY_MAX_PAGES,
  maxRequests = FAMILY_HISTORY_MAX_REQUESTS,
} = {}) {
  const stamp = nowMs(now); const file = earningsFamilyHistoryPath(stateRoot);
  try {
    const cached = JSON.parse(await fs.readFile(file, 'utf8'));
    const cachedAt = Date.parse(cached.updated_utc);
    if (
      cached.scan_ok === true
      && cached.by_company_word
      && typeof cached.by_company_word === 'object'
      && Number.isFinite(cachedAt)
      && stamp - cachedAt < ttlMs
    ) return priceFree(cached);
  } catch { /* scan */ }
  const updated = new Date(stamp).toISOString();
  const requestBudget = {
    remaining: Math.min(
      FAMILY_HISTORY_MAX_REQUESTS,
      Number.isInteger(maxRequests) && maxRequests > 0 ? maxRequests : FAMILY_HISTORY_MAX_REQUESTS,
    ),
  };
  const pageLimit = Math.min(
    FAMILY_HISTORY_MAX_PAGES,
    Number.isInteger(maxPages) && maxPages > 0 ? maxPages : FAMILY_HISTORY_MAX_PAGES,
  );
  try {
    const all = await pages(fetchImpl, '/series', { category: 'Mentions', limit: 200 }, 'series', { requestBudget, maxPages: pageLimit });
    const series = all.filter((s) => /^KXEARNINGSMENTION/.test(String(s?.ticker ?? s?.series_ticker)));
    const byWord = {};
    const byCompanyWord = {};
    let withHistory = 0;
    let settled = 0;
    for (const s of series) {
      const ticker = String(s.ticker ?? s.series_ticker);
      const companyTicker = resolveEarningsTicker(
        ticker,
        [s.title, s.sub_title, s.name].filter(Boolean).join(' '),
      ) ?? ticker;
      const events = await pages(fetchImpl, '/events', { series_ticker: ticker, limit: 200, with_nested_markets: true }, 'events', { requestBudget, maxPages: pageLimit });
      let local = 0;
      for (const event of events) for (const market of Array.isArray(event?.markets) ? event.markets : []) {
        if (market?.result !== 'yes' && market?.result !== 'no') continue;
        const word = familyWordKey(market.yes_sub_title || market.subtitle); if (!word) continue;
        const row = byWord[word] ?? { word, n: 0, hits: 0, misses: 0 }; row.n += 1; if (market.result === 'yes') row.hits += 1; else row.misses += 1; byWord[word] = row; settled += 1; local += 1;
        const companyRows = byCompanyWord[companyTicker] ?? {};
        const companyRow = companyRows[word] ?? { word, n: 0, hits: 0, misses: 0 };
        companyRow.n += 1;
        if (market.result === 'yes') companyRow.hits += 1; else companyRow.misses += 1;
        companyRows[word] = companyRow;
        byCompanyWord[companyTicker] = companyRows;
      }
      if (local) withHistory += 1;
    }
    const result = priceFree({ scan_ok: true, series_scanned: series.length, series_with_history: withHistory, settled_markets: settled, by_word: byWord, by_company_word: byCompanyWord, updated_utc: updated, error: null });
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, `${JSON.stringify(result, null, 2)}\n`, 'utf8'); return result;
  } catch (e) { return { scan_ok: false, series_scanned: 0, series_with_history: 0, settled_markets: 0, by_word: {}, by_company_word: {}, updated_utc: updated, error: e?.message ?? String(e) }; }
}

const NAME_MAP = Object.freeze({ ...EARNINGS_COMPANY_TICKERS, jpm: 'JPM', jpmorgan: 'JPM', 'jpmorgan chase': 'JPM', 'jpmorgan chase & co.': 'JPM', 'jp morgan': 'JPM', goldman: 'GS', 'goldman sachs': 'GS', 'wells fargo': 'WFC', citi: 'C', citigroup: 'C', 'bank of america': 'BAC', 'morgan stanley': 'MS' });
export function resolveEarningsTicker(seriesTicker, title = '') {
  const s = String(seriesTicker ?? '').trim().toUpperCase(); if (s.startsWith(PREFIX)) return s.slice(PREFIX.length) || null;
  const t = String(title ?? '').toLowerCase(); for (const name of Object.keys(NAME_MAP).sort((a, b) => b.length - a.length)) if (t.includes(name)) return NAME_MAP[name]; return NAME_MAP[t.replace(/[^a-z0-9]+/g, ' ').trim()] ?? null;
}

export function familyStatsExcludingCompany(history, word, companyTicker) {
  const byCompanyWord = history?.by_company_word;
  if (!byCompanyWord || typeof byCompanyWord !== 'object' || !companyTicker) {
    return { available: false, stats: null };
  }
  const key = familyWordKey(word);
  const aggregate = history?.by_word?.[key] ?? null;
  if (!aggregate) return { available: true, stats: null };
  const sameCompany = byCompanyWord?.[companyTicker]?.[key] ?? null;
  const n = Math.max(0, Number(aggregate.n ?? 0) - Number(sameCompany?.n ?? 0));
  const hits = Math.max(0, Number(aggregate.hits ?? 0) - Number(sameCompany?.hits ?? 0));
  const misses = Math.max(0, Number(aggregate.misses ?? 0) - Number(sameCompany?.misses ?? 0));
  return { available: true, stats: { word: key, n, hits, misses } };
}

// Compatibility helper for direct per-event callers; the family scan above is the source of truth.
export function earningsHistoryToLayerScore(history) {
  const n = Number(history?.n ?? history?.sample_size ?? 0); const hits = Number(history?.hits ?? 0); const tier = history?.tier ?? history?.match_tier ?? 'none';
  if (history?.scan_ok === false || n < 2 || !Number.isFinite(hits / n)) return { present: false, score: null, source_basis: history?.scan_ok === false ? 'earnings family history lookup failed' : 'no usable earnings family history', source_path: null, detail: history?.error ?? history?.scan_error ?? null, missing_note: 'no usable settled earnings history' };
  const penalty = Number(history?.penalty ?? history?.neutral_pull_penalty ?? 0); return { present: true, score: Math.round((hits / n) * 100), source_basis: `earnings history ${hits}/${n} hits, tier=${tier}`, source_path: null, detail: `penalty=${penalty}`, missing_note: null };
}
