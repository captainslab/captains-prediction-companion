// Shared Kalshi event/market discovery for packet generators.
// Read-only. No auth. No order placement. No trades.
//
// Source-of-truth mapping (calendar/category pages -> public REST API):
//   - https://kalshi.com/calendar/mentions             -> category=Mentions
//   - https://kalshi.com/calendar/sports/baseball      -> series_ticker=KXMLBGAME
//   - https://kalshi.com/calendar/sports/mma/ufc       -> series_ticker=KXUFCFIGHT
//   - https://kalshi.com/category/sports/motorsport/nascar-cup-series
//                                                      -> series_ticker=KXNASCARRACE
//                                                         filtered to product_metadata.competition === 'NASCAR Cup Series'
//
// Returns plain JS objects. The generator decides what to persist and how to
// shape each event packet. Helper never invents fields and never derives
// display strike text from ticker shorthand.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
export const DEFAULT_DISCOVERY_CONCURRENCY = 6;
export const MAX_DISCOVERY_CONCURRENCY = 12;

export const KALSHI_SOURCES = Object.freeze({
  mentions: {
    label: 'kalshi-calendar-mentions',
    // The human-facing mentions board. It is a pure client-rendered SPA: the
    // static HTML carries no event tickers, so discovery is scraper-FIRST
    // (parse any tickers/anchors the page exposes) and API-FALLBACK.
    page_url: 'https://kalshi.com/calendar/mentions',
    // BROKEN as an events filter: /events?category=Mentions returns HTTP 200
    // but ignores the category and yields ~200 mixed-category events (World,
    // Elections, Climate, ...) that do NOT include real mention events such as
    // KXOBAMAMENTION. Kept only as a last-ditch backstop; never trust alone.
    api_url: `${KALSHI_API_BASE}/events?category=Mentions&status=open&limit=200&with_nested_markets=true`,
    // FAITHFUL page-equivalent: the /series listing DOES carry a reliable
    // `category` field. Series where category === 'Mentions' is the exact set
    // the calendar/mentions board renders (category-driven), so it is the
    // canonical API fallback behind the page scrape. See selectMentionSeries.
    series_url: `${KALSHI_API_BASE}/series?limit=1000`,
    category: 'Mentions',
  },
  broad: {
    label: 'kalshi-broad-discovery',
    page_url: 'https://kalshi.com/calendar',
    api_url: `${KALSHI_API_BASE}/events?status=open&limit=200&with_nested_markets=true`,
  },
  mlb: {
    label: 'kalshi-calendar-baseball',
    page_url: 'https://kalshi.com/calendar/sports/baseball',
    api_url: `${KALSHI_API_BASE}/events?series_ticker=KXMLBGAME&status=open&limit=200&with_nested_markets=true`,
  },
  mlb_spread: {
    label: 'kalshi-mlb-spread',
    page_url: 'https://kalshi.com/calendar/sports/baseball',
    api_url: `${KALSHI_API_BASE}/events?series_ticker=KXMLBSPREAD&status=open&limit=200&with_nested_markets=true`,
  },
  mlb_total: {
    label: 'kalshi-mlb-total',
    page_url: 'https://kalshi.com/calendar/sports/baseball',
    api_url: `${KALSHI_API_BASE}/events?series_ticker=KXMLBTOTAL&status=open&limit=200&with_nested_markets=true`,
  },
  mlb_hr: {
    label: 'kalshi-mlb-hr',
    page_url: 'https://kalshi.com/calendar/sports/baseball',
    api_url: `${KALSHI_API_BASE}/events?series_ticker=KXMLBHR&status=open&limit=200&with_nested_markets=true`,
  },
  mlb_ks: {
    label: 'kalshi-mlb-ks',
    page_url: 'https://kalshi.com/calendar/sports/baseball',
    api_url: `${KALSHI_API_BASE}/events?series_ticker=KXMLBKS&status=open&limit=200&with_nested_markets=true`,
  },
  mlb_rfi: {
    label: 'kalshi-mlb-rfi',
    page_url: 'https://kalshi.com/calendar/sports/baseball',
    api_url: `${KALSHI_API_BASE}/events?series_ticker=KXMLBRFI&status=open&limit=200&with_nested_markets=true`,
  },
  ufc: {
    label: 'kalshi-calendar-ufc',
    page_url: 'https://kalshi.com/calendar/sports/mma/ufc',
    api_url: `${KALSHI_API_BASE}/events?series_ticker=KXUFCFIGHT&limit=200&with_nested_markets=true`,
  },
  nascar: {
    label: 'kalshi-category-nascar-cup',
    page_url: 'https://kalshi.com/category/sports/motorsport/nascar-cup-series',
    api_url: `${KALSHI_API_BASE}/events?series_ticker=KXNASCARRACE&limit=200&with_nested_markets=true`,
  },
});

/**
 * Live fetch wrapper with retry/backoff for transient failures (404, 429, 5xx, network errors).
 * Node 20+ ships global fetch.
 * Returns { ok, status, json, error } - never throws.
 */
export async function defaultFetcher(url, options = {}) {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? Number(process.env.KALSHI_FETCH_TIMEOUT_MS || '15000');
  let lastError = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // A caller-supplied signal (e.g. a per-source discovery deadline) owns
    // cancellation; once it aborts, stop immediately rather than burning retry
    // backoff on a request that can never succeed.
    if (options.signal?.aborted) { lastError = lastError || 'aborted'; break; }
    const controller = options.signal ? null : new AbortController();
    const timeout = controller && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: options.signal ?? controller?.signal,
      });
      const text = await res.text();
      if (timeout) clearTimeout(timeout);
      let json = null;
      try { json = JSON.parse(text); } catch {}
      // Retry on transient errors: 404, 429, 5xx
      if (!res.ok && (res.status === 404 || res.status === 429 || res.status >= 500)) {
        lastError = `HTTP ${res.status}`;
        if (attempt < maxRetries - 1) {
          const delay = baseDelayMs * (2 ** attempt);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }
      return { ok: res.ok, status: res.status, json, error: res.ok ? null : `HTTP ${res.status}` };
    } catch (err) {
      if (timeout) clearTimeout(timeout);
      lastError = err.message || String(err);
      // Caller aborted (deadline hit) -> bail without further retries/backoff.
      if (options.signal?.aborted) break;
      if (attempt < maxRetries - 1) {
        const delay = baseDelayMs * (2 ** attempt);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  return { ok: false, status: 0, json: null, error: lastError };
}

/**
 * Fetch events for a known source key with optional pagination.
 * Returns { ok, events, raw, attempts, source } - always defined arrays.
 */
export async function fetchKalshiEvents(sourceKey, options = {}) {
  const source = KALSHI_SOURCES[sourceKey];
  if (!source) {
    return { ok: false, events: [], raw: [], attempts: [], source: null, error: `unknown source key: ${sourceKey}` };
  }
  const fetcher = options.fetcher ?? defaultFetcher;
  const attempts = [];
  const events = [];
  let cursor = '';
  let pageCount = 0;
  const maxPages = options.maxPages ?? 5;
  let lastError = null;
  while (pageCount < maxPages) {
    if (options.signal?.aborted) { lastError = lastError || 'aborted'; break; }
    const url = cursor ? `${source.api_url}&cursor=${encodeURIComponent(cursor)}` : source.api_url;
    const res = await fetcher(url, { signal: options.signal });
    attempts.push({ url, ok: res.ok, status: res.status, error: res.error });
    if (!res.ok || !res.json) { lastError = res.error || 'no JSON body'; break; }
    const pageEvents = Array.isArray(res.json.events) ? res.json.events : [];
    for (const ev of pageEvents) events.push(ev);
    cursor = res.json.cursor || '';
    pageCount += 1;
    if (!cursor) break;
  }
  return {
    ok: attempts.length > 0 && attempts[0].ok,
    events,
    raw: attempts,
    attempts,
    source,
    error: lastError,
  };
}

/**
 * Fetch mention-style events by scanning series tickers.
 * Kalshi mention markets (earnings-call mentions, speech mentions) are organized
 * under series tickers like KXEARNINGSMENTION*, KX*MENTION*, etc. The event
 * containers often have empty status fields, so they are invisible to general
 * category+status queries. This function discovers them via series scan.
 *
 * Returns { ok, events, raw, attempts, error }.
 */

// Mention-series classification, shared by every discovery path so the page
// scrape, the category API, and the legacy regex scan all agree on what a
// "mention series" is.
//
// The /series listing carries a RELIABLE `category` field (unlike the broken
// /events?category= filter). Series where category === 'Mentions' is exactly
// the set the calendar/mentions board renders. We use that as the primary
// signal and keep the historical ticker/title regex as an augment so we never
// regress on series Kalshi has not (yet) tagged.
export const MENTION_SERIES_PATTERNS = Object.freeze([
  /mention/i,
  /\bearnings\b.*\bmention\b/i,
  /\bmention\b.*\bearnings\b/i,
]);

export function resolveDiscoveryConcurrency(value, {
  fallback = DEFAULT_DISCOVERY_CONCURRENCY,
  onInvalid,
} = {}) {
  const parsedFallback = Number(fallback);
  const safeFallback = Number.isFinite(parsedFallback) && parsedFallback >= 1
    ? Math.min(MAX_DISCOVERY_CONCURRENCY, Math.floor(parsedFallback))
    : DEFAULT_DISCOVERY_CONCURRENCY;
  const warn = (used) => onInvalid?.({ provided: value, used });

  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    warn(safeFallback);
    return safeFallback;
  }

  const parsed = (typeof value === 'number' || typeof value === 'string') ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < 1) {
    warn(safeFallback);
    return safeFallback;
  }
  if (parsed > MAX_DISCOVERY_CONCURRENCY) {
    warn(MAX_DISCOVERY_CONCURRENCY);
    return MAX_DISCOVERY_CONCURRENCY;
  }
  return Math.floor(parsed);
}

/**
 * Select mention series from a raw /series listing. Category-first, regex
 * augmented. Pure — no I/O. Returns the matching series records unchanged.
 */
export function selectMentionSeries(allSeries = [], options = {}) {
  const category = options.category ?? 'Mentions';
  const patterns = options.patterns ?? MENTION_SERIES_PATTERNS;
  const seen = new Set();
  const picked = [];
  for (const s of allSeries) {
    if (!s || typeof s !== 'object') continue;
    const byCategory = typeof s.category === 'string'
      && s.category.toLowerCase() === String(category).toLowerCase();
    const text = `${s.ticker || ''} ${s.title || ''}`;
    const byRegex = patterns.some((p) => p.test(text));
    if (!byCategory && !byRegex) continue;
    const key = s.ticker || s.title;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    picked.push({ ...s, _matchedVia: byCategory ? 'category' : 'regex' });
  }
  return picked;
}

export async function fetchMentionEventsBySeries(options = {}) {
  const fetcher = options.fetcher ?? defaultFetcher;
  const attempts = [];
  const events = [];

  // Step 1: Fetch all series (paginated)
  let cursor = '';
  let pageCount = 0;
  const maxSeriesPages = options.maxSeriesPages ?? 10;
  const allSeries = [];

  while (pageCount < maxSeriesPages) {
    if (options.signal?.aborted) break;
    const url = `${KALSHI_API_BASE}/series?limit=1000${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`;
    const res = await fetcher(url, { signal: options.signal });
    attempts.push({ url, ok: res.ok, status: res.status, error: res.error });
    if (!res.ok || !res.json) break;
    const series = Array.isArray(res.json.series) ? res.json.series : [];
    allSeries.push(...series);
    cursor = res.json.cursor || '';
    pageCount++;
    if (!cursor) break;
  }

  // Step 2: Filter to mention-related series (category-first, regex-augmented).
  const mentionSeries = selectMentionSeries(allSeries);

  // Step 3: Fetch events for each mention series (no status filter — events have empty status).
  // Series are independent, so keep pagination serial within each series while
  // using a conservative worker pool across series. Results stay in indexed
  // slots so concurrency cannot change the sequential output order.
  const maxEventPagesPerSeries = options.maxEventPagesPerSeries ?? 2;
  const warnConcurrency = ({ provided, used }) => {
    console.warn(`[kalshi-discovery] invalid or excessive concurrency ${String(provided)}; using ${used}`);
  };
  const explicitConcurrency = options.concurrency;
  const hasValidExplicitConcurrency = typeof explicitConcurrency === 'number'
    && Number.isFinite(explicitConcurrency)
    && explicitConcurrency >= 1;
  let concurrency;
  if (hasValidExplicitConcurrency) {
    concurrency = resolveDiscoveryConcurrency(explicitConcurrency, { onInvalid: warnConcurrency });
  } else {
    const configuredConcurrency = process.env.KALSHI_DISCOVERY_CONCURRENCY;
    concurrency = configuredConcurrency === undefined
      ? DEFAULT_DISCOVERY_CONCURRENCY
      : resolveDiscoveryConcurrency(configuredConcurrency, { onInvalid: warnConcurrency });
    if (explicitConcurrency !== undefined) {
      warnConcurrency({ provided: explicitConcurrency, used: concurrency });
    }
  }
  const seriesEventSlots = new Array(mentionSeries.length);
  let nextSeriesIndex = 0;

  async function scanSeriesAtIndex(index) {
    const s = mentionSeries[index];
    const seriesEvents = [];
    let eCursor = '';
    let ePageCount = 0;
    while (ePageCount < maxEventPagesPerSeries) {
      if (options.signal?.aborted) break;
      const eUrl = `${KALSHI_API_BASE}/events?series_ticker=${encodeURIComponent(s.ticker)}&limit=200&with_nested_markets=true${eCursor ? '&cursor=' + encodeURIComponent(eCursor) : ''}`;
      const eRes = await fetcher(eUrl, { signal: options.signal });
      attempts.push({ url: eUrl, ok: eRes.ok, status: eRes.status, error: eRes.error });
      if (!eRes.ok || !eRes.json) break;
      const pageEvents = Array.isArray(eRes.json.events) ? eRes.json.events : [];
      for (const ev of pageEvents) {
        // Enrich with series metadata for downstream filtering
        ev._discoveredVia = 'series_scan';
        ev._seriesTitle = s.title || '';
        seriesEvents.push(ev);
      }
      eCursor = eRes.json.cursor || '';
      ePageCount++;
      if (!eCursor) break;
    }
    return seriesEvents;
  }

  async function worker() {
    while (!options.signal?.aborted) {
      const index = nextSeriesIndex++;
      if (index >= mentionSeries.length) break;
      if (options.signal?.aborted) break;
      seriesEventSlots[index] = await scanSeriesAtIndex(index);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, mentionSeries.length) },
    () => worker(),
  );
  await Promise.all(workers);
  for (const seriesEvents of seriesEventSlots) {
    if (seriesEvents) events.push(...seriesEvents);
  }

  return {
    ok: attempts.length > 0 && attempts.some(a => a.ok),
    events,
    raw: attempts,
    attempts,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Scraper-first calendar/mentions discovery
// ---------------------------------------------------------------------------
//
// The board at https://kalshi.com/calendar/mentions is a pure client-rendered
// SPA. A plain HTTP fetch returns a ~34 KB stub with NO event data, so true
// page scraping requires a JS-rendering fetch (e.g. firecrawl/browser) injected
// as options.pageFetcher. When that yields rendered HTML, we extract the event
// tickers the human sees. When it does not (no browser dep, scrape failure), we
// fall back to the free, deterministic /series?category=Mentions API, which is
// server-side filtered and reproduces the exact board list. Discovery never
// depends on any single layer being up.

const EVENT_TICKER_RE = /KX[A-Z0-9]*MENTION[A-Z0-9]*-[0-9]{2}[A-Z]{3}[0-9]{2}[A-Z0-9]*/gi;
const MARKET_ANCHOR_RE = /\/markets\/[a-z0-9]+\/[a-z0-9-]+\/(kx[a-z0-9]*mention[a-z0-9-]*)/gi;

/**
 * Extract distinct mention EVENT tickers from rendered calendar/mentions HTML.
 * Pure — no I/O. Reads both bare ticker tokens and /markets/.../<ticker> anchor
 * hrefs (including any "show markets" / closed-history sections the render
 * exposes), upper-cases them, and de-dupes. Returns [] for the empty SPA stub.
 */
export function scrapeMentionsCalendar(html = '') {
  if (typeof html !== 'string' || !html) return { tickers: [], anchors: [] };
  const tickers = new Set();
  const anchors = new Set();
  let m;
  EVENT_TICKER_RE.lastIndex = 0;
  while ((m = EVENT_TICKER_RE.exec(html)) !== null) tickers.add(m[0].toUpperCase());
  MARKET_ANCHOR_RE.lastIndex = 0;
  while ((m = MARKET_ANCHOR_RE.exec(html)) !== null) {
    anchors.add(m[0]);
    tickers.add(m[1].toUpperCase());
  }
  return { tickers: [...tickers], anchors: [...anchors] };
}

/**
 * Fetch + scrape the calendar/mentions board. options.pageFetcher(url) must
 * resolve { ok, status, text } with JS-rendered HTML (a browser/firecrawl
 * adapter); without one we use defaultFetcher, which gets the inert SPA stub
 * and therefore returns zero tickers (caller then uses the API fallback).
 * Returns { ok, tickers, anchors, status, error }.
 */
export async function fetchMentionsCalendarTickers(options = {}) {
  const url = options.pageUrl ?? KALSHI_SOURCES.mentions.page_url;
  const pageFetcher = options.pageFetcher ?? (async (u) => {
    const res = await defaultFetcher(u, { ...options });
    return { ok: res.ok, status: res.status, text: null, error: res.error };
  });
  let res;
  try {
    res = await pageFetcher(url);
  } catch (err) {
    return { ok: false, tickers: [], anchors: [], status: 0, error: err?.message || String(err) };
  }
  const html = res?.text ?? res?.html ?? '';
  const { tickers, anchors } = scrapeMentionsCalendar(html);
  return {
    ok: !!res?.ok && tickers.length > 0,
    tickers,
    anchors,
    status: res?.status ?? 0,
    error: res?.error ?? null,
  };
}

/**
 * Hydrate full event records (with nested markets) for a list of event tickers
 * via the public events API. Read-only. Returns { ok, events, attempts }.
 */
export async function hydrateEventsByTicker(tickers = [], options = {}) {
  const fetcher = options.fetcher ?? defaultFetcher;
  const attempts = [];
  const events = [];
  for (const ticker of tickers) {
    if (!ticker) continue;
    if (options.signal?.aborted) break;
    const url = `${KALSHI_API_BASE}/events/${encodeURIComponent(ticker)}?with_nested_markets=true`;
    const res = await fetcher(url, { signal: options.signal });
    attempts.push({ url, ok: res.ok, status: res.status, error: res.error });
    const ev = res?.json?.event;
    if (res.ok && ev) {
      ev._discoveredVia = 'page_scrape';
      events.push(ev);
    }
  }
  return { ok: attempts.some((a) => a.ok), events, attempts };
}

/**
 * Scraper-FIRST mention discovery with deterministic API fallback.
 *   1. Scrape the rendered calendar/mentions board (options.pageFetcher).
 *      Any tickers found are hydrated via the events API.
 *   2. ALWAYS also run the free /series category scan (fetchMentionEventsBySeries)
 *      so a scrape miss never drops coverage; results are unioned by ticker.
 * Returns { events, sources: { scrape, series }, scrapedTickers }.
 */
export async function discoverMentionEvents(options = {}) {
  const sources = {};
  const byTicker = new Map();

  // Layer 1: scraper-first.
  let scrapedTickers = [];
  try {
    const scan = await fetchMentionsCalendarTickers(options);
    scrapedTickers = scan.tickers;
    sources.scrape = { ok: scan.ok, status: scan.status, count: scan.tickers.length, error: scan.error };
    if (scan.tickers.length) {
      const hydrated = await hydrateEventsByTicker(scan.tickers, options);
      sources.scrape.hydrated = hydrated.events.length;
      for (const ev of hydrated.events) {
        if (ev?.event_ticker) byTicker.set(ev.event_ticker, ev);
      }
    }
  } catch (err) {
    sources.scrape = { ok: false, error: err?.message || String(err), count: 0 };
  }

  // Layer 2: free deterministic series-category fallback (always runs).
  try {
    const series = await fetchMentionEventsBySeries(options);
    sources.series = { ok: series.ok, count: series.events.length };
    for (const ev of series.events) {
      if (ev?.event_ticker && !byTicker.has(ev.event_ticker)) byTicker.set(ev.event_ticker, ev);
    }
  } catch (err) {
    sources.series = { ok: false, error: err?.message || String(err), count: 0 };
  }

  return { events: [...byTicker.values()], sources, scrapedTickers };
}

// ---------------------------------------------------------------------------
// Market normalization
// ---------------------------------------------------------------------------

const TICKER_DATE_PATTERNS = [
  // e.g. KXMLBGAME-26MAY202138ATHLAA   -> 26 MAY 20
  // e.g. KXUFCFIGHT-26MAY16WELDAL      -> 26 MAY 16
  /-(\d{2})([A-Z]{3})(\d{2})/,
];
const MONTH_INDEX = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };

/**
 * Extract a YYYY-MM-DD date encoded directly in the event ticker, when present.
 * Returns null if no recognizable pattern. Uses the ticker only for date
 * routing — never for display strike text.
 */
export function extractDateFromTicker(ticker) {
  if (typeof ticker !== 'string') return null;
  for (const re of TICKER_DATE_PATTERNS) {
    const m = ticker.match(re);
    if (m) {
      const yy = Number(m[1]);
      const mon = MONTH_INDEX[m[2]];
      const dd = Number(m[3]);
      if (mon == null || Number.isNaN(yy) || Number.isNaN(dd)) continue;
      const year = 2000 + yy;
      return `${year.toString().padStart(4,'0')}-${(mon+1).toString().padStart(2,'0')}-${dd.toString().padStart(2,'0')}`;
    }
  }
  return null;
}

/**
 * Convert an ISO timestamp to America/New_York YYYY-MM-DD.
 * Used so MLB/UFC/NASCAR end-of-event timestamps near midnight UTC don't
 * land on the wrong calendar date. Returns null on bad input.
 */
export function toEtDate(isoLike) {
  if (!isoLike) return null;
  const d = new Date(isoLike);
  if (Number.isNaN(d.getTime())) return null;
  // en-CA gives YYYY-MM-DD ordering.
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * Derive the primary "event date" used for daily/weekly window filtering.
 * Priority:
 *   1. Date encoded in event ticker (date-routing only, not strike text).
 *   2. markets[0].expected_expiration_time (in ET).
 *   3. markets[0].close_time (in ET).
 *   4. event.close_time / expected_expiration_time / strike_date (in ET).
 * Returns YYYY-MM-DD string or null when undated.
 */
export function deriveEventDate(event) {
  const tickerDate = extractDateFromTicker(event?.event_ticker);
  if (tickerDate) return tickerDate;
  const m0 = Array.isArray(event?.markets) && event.markets[0] ? event.markets[0] : null;
  const candidates = [
    m0?.expected_expiration_time,
    m0?.close_time,
    event?.expected_expiration_time,
    event?.close_time,
    event?.strike_date,
  ];
  for (const c of candidates) {
    const et = toEtDate(c);
    if (et) return et;
  }
  return null;
}

/**
 * Returns a function (event) -> boolean keeping events whose deriveEventDate
 * falls inside [targetDate, targetDate + windowDays] inclusive (ET).
 * Undated events are DROPPED unless options.allowUndated === true.
 */
export function filterByEventDate(targetDate, options = {}) {
  const windowDays = Number.isFinite(options.windowDays) ? options.windowDays : 0;
  const allowUndated = options.allowUndated === true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) return () => true;
  const startMs = Date.UTC(
    Number(targetDate.slice(0, 4)),
    Number(targetDate.slice(5, 7)) - 1,
    Number(targetDate.slice(8, 10)),
  );
  return (event) => {
    const ev = deriveEventDate(event);
    if (!ev) return allowUndated;
    const evMs = Date.UTC(
      Number(ev.slice(0, 4)),
      Number(ev.slice(5, 7)) - 1,
      Number(ev.slice(8, 10)),
    );
    const diffDays = Math.round((evMs - startMs) / 86400000);
    return diffDays >= 0 && diffDays <= windowDays;
  };
}

// Backwards-compat wrapper retained for the existing test surface.
export function filterByCloseDateUtc(targetDate, windowDays = 0) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) return () => true;
  const start = Date.UTC(
    Number(targetDate.slice(0, 4)),
    Number(targetDate.slice(5, 7)) - 1,
    Number(targetDate.slice(8, 10)),
  );
  const end = start + (windowDays + 1) * 86400 * 1000;
  return (event) => {
    const t =
      event?.close_time ||
      event?.expected_expiration_time ||
      event?.strike_date ||
      (Array.isArray(event?.markets) && event.markets[0]?.close_time) ||
      null;
    if (!t) return true;
    const ts = Date.parse(t);
    if (Number.isNaN(ts)) return true;
    return ts >= start && ts < end;
  };
}

export function filterNascarCupOnly(event) {
  const comp = event?.product_metadata?.competition || '';
  return /NASCAR Cup Series/i.test(comp);
}

/**
 * Heuristic: does the text look like a bare ticker fragment / all-caps code?
 * Used to reject e.g. "ATH", "HEG", "DON", "ATHLAA" as strike labels when no
 * supporting field exists.
 */
export function looksLikeTickerShorthand(text, ticker = '') {
  if (text == null) return true;
  const s = String(text).trim();
  if (!s) return true;
  // Has any lowercase letter -> not shorthand.
  if (/[a-z]/.test(s)) return false;
  // Has whitespace + multiple uppercase tokens -> probably "RYAN PREECE" style.
  if (/\s/.test(s) && s.length > 8) return false;
  // Short all-caps no-space token -> shorthand.
  if (!/\s/.test(s) && s.length <= 8) return true;
  // Matches a suffix/segment of the ticker -> shorthand.
  if (ticker && typeof ticker === 'string') {
    const segments = ticker.split(/[-_]/);
    if (segments.some((seg) => seg && seg === s)) return true;
  }
  return false;
}

/**
 * Normalize a Kalshi market record into a stable shape preserving every
 * useful field for downstream packet rendering. Does not invent values.
 */
export function normalizeMarket(market = {}) {
  const ticker = market.ticker ?? null;
  const out = {
    ticker,
    event_ticker: market.event_ticker ?? null,
    title: market.title ?? null,
    subtitle: market.subtitle ?? null,
    yes_sub_title: market.yes_sub_title ?? null,
    no_sub_title: market.no_sub_title ?? null,
    functional_strike: market.functional_strike ?? null,
    custom_strike: market.custom_strike ?? null,
    floor_strike: market.floor_strike ?? null,
    cap_strike: market.cap_strike ?? null,
    strike_type: market.strike_type ?? null,
    yes_bid_dollars: market.yes_bid_dollars ?? null,
    yes_ask_dollars: market.yes_ask_dollars ?? null,
    no_bid_dollars: market.no_bid_dollars ?? null,
    no_ask_dollars: market.no_ask_dollars ?? null,
    last_price_dollars: market.last_price_dollars ?? null,
    volume_fp: market.volume_fp ?? null,
    liquidity_dollars: market.liquidity_dollars ?? null,
    open_interest_fp: market.open_interest_fp ?? null,
    close_time: market.close_time ?? null,
    expected_expiration_time: market.expected_expiration_time ?? null,
    expiration_time: market.expiration_time ?? null,
    declared_source_url: market.declared_source_url ?? market.declared_source_urls?.[0] ?? null,
    rules_primary: market.rules_primary ?? null,
    rules_secondary: market.rules_secondary ?? null,
    status: market.status ?? null,
  };
  const strike = buildStrikeDisplay(out);
  out.strike_source_used = strike.source;
  out.full_strike_display = strike.text;
  out.missing_strike_text = strike.missing;
  return out;
}

/**
 * Pick best display strike text for a market. Source priority:
 *   functional_strike, custom_strike(string), floor_strike+cap_strike,
 *   yes_sub_title, subtitle, title.
 * Returns { source, text, missing } where missing=true means no usable label
 * was found AND the only candidates were ticker shorthand.
 */
export function buildStrikeDisplay(market = {}) {
  const ticker = market.ticker || '';
  const tries = [];
  if (market.functional_strike != null && String(market.functional_strike).trim()) {
    tries.push({ source: 'functional_strike', text: String(market.functional_strike).trim() });
  }
  if (typeof market.custom_strike === 'string' && market.custom_strike.trim()) {
    tries.push({ source: 'custom_strike', text: market.custom_strike.trim() });
  }
  if (market.floor_strike != null || market.cap_strike != null) {
    const f = market.floor_strike ?? '−∞';
    const c = market.cap_strike ?? '+∞';
    tries.push({ source: 'floor_cap_strike', text: `[${f}, ${c}]` });
  }
  const yesT = typeof market.yes_sub_title === 'string' ? market.yes_sub_title.trim() : '';
  const noT  = typeof market.no_sub_title  === 'string' ? market.no_sub_title.trim()  : '';
  // Only treat yes_sub_title as a meaningful per-side label when it actually
  // differentiates from no_sub_title; otherwise it's an uninformative repeat
  // (e.g. MLB markets that put the same team string on both YES and NO).
  const yesIsInformative = yesT && yesT !== noT;
  if (typeof market.title === 'string' && market.title.trim() && !yesIsInformative) {
    tries.push({ source: 'title', text: market.title.trim() });
  }
  if (yesIsInformative) {
    tries.push({ source: 'yes_sub_title', text: yesT });
  }
  if (typeof market.subtitle === 'string' && market.subtitle.trim()) {
    tries.push({ source: 'subtitle', text: market.subtitle.trim() });
  }
  if (typeof market.title === 'string' && market.title.trim()) {
    tries.push({ source: 'title', text: market.title.trim() });
  }
  if (yesT && !yesIsInformative) {
    tries.push({ source: 'yes_sub_title', text: yesT });
  }
  for (const candidate of tries) {
    if (!looksLikeTickerShorthand(candidate.text, ticker)) {
      return { source: candidate.source, text: candidate.text, missing: false };
    }
  }
  return { source: null, text: null, missing: true };
}

/**
 * Persist one JSON file per event to state/<sport>/<date>/kalshi-events/.
 * Returns array of { event_ticker, path } records.
 */
export function persistEventArtifacts({ stateRoot, sport, date, events }) {
  const dir = resolve(stateRoot, sport, date, 'kalshi-events');
  mkdirSync(dir, { recursive: true });
  const written = [];
  for (const ev of events) {
    const ticker = ev?.event_ticker || ev?.ticker;
    if (!ticker) continue;
    const safe = ticker.replace(/[^A-Z0-9_-]/gi, '_').slice(0, 80);
    const path = join(dir, `${safe}.json`);
    writeFileSync(path, JSON.stringify({
      ...ev,
      declared_source_url: ev.declared_source_url ?? ev.declared_source_urls?.[0] ?? null,
    }, null, 2), 'utf8');
    written.push({ event_ticker: ticker, path });
  }
  return { dir, written };
}

/**
 * Compact summary of event-level fields. Treats event as a container; does
 * not pull market data into event identity.
 */
export function summarizeEvent(ev) {
  const ticker = ev?.event_ticker || 'MISSING';
  const title = ev?.title || 'MISSING';
  const sub_title = ev?.sub_title || null;
  const series = ev?.series_ticker || 'MISSING';
  const m0 = Array.isArray(ev?.markets) && ev.markets[0] ? ev.markets[0] : null;
  const close =
    ev?.close_time ||
    ev?.expected_expiration_time ||
    m0?.close_time ||
    m0?.expected_expiration_time ||
    'MISSING';
  const marketCount = Array.isArray(ev?.markets) ? ev.markets.length : 0;
  return {
    ticker,
    title,
    sub_title,
    series,
    close,
    marketCount,
    declared_source_url: ev?.declared_source_url ?? null,
  };
}

/**
 * Render per-market blocks for a packet. Returns { lines, marketCount,
 * missingStrikeCount, missingMarkets } so callers can include counts in audit
 * meta. Pure text - no I/O.
 */
export function renderMarketBlocks(event, options = {}) {
  const limit = options.limit ?? 60;
  const markets = Array.isArray(event?.markets) ? event.markets : [];
  const lines = [];
  let missingStrikeCount = 0;
  if (!markets.length) {
    lines.push('  MISSING_MARKETS: event has no markets[]');
    return { lines, marketCount: 0, missingStrikeCount: 0, missingMarkets: true };
  }
  const shown = markets.slice(0, limit);
  for (const raw of shown) {
    const m = normalizeMarket(raw);
    if (m.missing_strike_text) missingStrikeCount += 1;
    lines.push(`  - market_ticker: ${m.ticker || 'MISSING'}`);
    lines.push(`    market_title: ${m.title || 'MISSING'}`);
    lines.push(`    market_subtitle: ${m.subtitle || 'MISSING'}`);
    lines.push(`    yes_sub_title: ${m.yes_sub_title || 'MISSING'}`);
    lines.push(`    no_sub_title: ${m.no_sub_title || 'MISSING'}`);
    lines.push(`    strike_source_used: ${m.strike_source_used || 'MISSING_STRIKE_TEXT'}`);
    lines.push(`    full_strike_display: ${m.full_strike_display || 'MISSING_STRIKE_TEXT'}`);
    lines.push(`    yes_bid: ${m.yes_bid_dollars ?? 'MISSING'}`);
    lines.push(`    yes_ask: ${m.yes_ask_dollars ?? 'MISSING'}`);
    lines.push(`    no_bid: ${m.no_bid_dollars ?? 'MISSING'}`);
    lines.push(`    no_ask: ${m.no_ask_dollars ?? 'MISSING'}`);
    lines.push(`    last_price: ${m.last_price_dollars ?? 'MISSING'}`);
    lines.push(`    liquidity: ${m.liquidity_dollars ?? 'MISSING'}`);
    lines.push(`    volume: ${m.volume_fp ?? 'MISSING'}`);
    lines.push(`    open_interest: ${m.open_interest_fp ?? 'MISSING'}`);
    lines.push(`    close_time_utc: ${m.close_time || 'MISSING'}`);
    lines.push(`    expected_expiration_utc: ${m.expected_expiration_time || 'MISSING'}`);
  }
  if (markets.length > shown.length) {
    lines.push(`  ... ${markets.length - shown.length} additional markets truncated`);
  }
  return {
    lines,
    marketCount: markets.length,
    missingStrikeCount,
    missingMarkets: false,
  };
}

// ---------------------------------------------------------------------------
// Mention-style market classifier
// ---------------------------------------------------------------------------

/**
 * Detect whether an event or market is a true "mention" market (will X say Y
 * in a transcript/earnings call/speech) vs a standard binary outcome market
 * (IPO timing, M&A close, production metrics, CEO succession, etc.).
 *
 * A mention market must have language in event title, market title, or rules
 * that explicitly references speech, utterance, or transcript mention.
 *
 * Excluded patterns (non-mention binary outcomes):
 *   - IPO timing, M&A close, acquisition announcements
 *   - Production/delivery/passenger/store metrics
 *   - CEO succession, leadership changes
 *   - Earnings beats (above/below X revenue/EPS)
 *   - Price targets, valuation
 *   - Standard election/political winner markets
 */
const MENTION_POSITIVE_PATTERNS = [
  /\bwill\s+\w+\s+say\b/i,
  /\bwill\s+\w+\s+mention\b/i,
  /\bsay\s+during\b/i,
  /\bmention\s+during\b/i,
  /\bmentions?\s+of\b/i,
  /\butter\b/i,
  /\btranscript\b/i,
  /\bearnings\s+call\b/i,
  /\bconference\s+call\b/i,
  /\bspeech\b/i,
  /\bremarks\b/i,
  /\bword\s+\w+\s+say\b/i,
  /\bphrase\s+\w+\s+say\b/i,
];

const MENTION_NEGATIVE_PATTERNS = [
  /\bipo\b/i,
  /\bacquisition\b/i,
  /\bmerge\b/i,
  /\bproduction\b/i,
  /\bdeliveries\b/i,
  /\bpassengers?\s+flown\b/i,
  /\btotal\s+global\s+stores\b/i,
  /\bgross\s+merchandise\b/i,
  /\bfunded\s+customers\b/i,
  /\bvehicle\s+sales\b/i,
  /\bcigarette\s+shipments\b/i,
  /\bwho\s+will\s+be\s+the\s+next\s+ceo\b/i,
  /\bwho\s+will\s+replace\b/i,
  /\bwho\s+will\s+succeed\b/i,
  /\babove\s+\d+.*\b(revenue|eps|production|deliveries|stores|passengers)\b/i,
  /\breport\s+above\b/i,
  /\btake-private\b/i,
  /\bsuspend\s+habeas\b/i,
  /\braise\s+corporate\s+taxes\b/i,
  /\btariff\s+revenue\b/i,
  /\bwhen\s+will\b/i,
  /\bwill\s+.*\s+achieve\b/i,
  /\bwill\s+.*\s+announce\b/i,
  /\bwill\s+.*\s+close\b/i,
  /\bwill\s+.*\s+report\b/i,
  /\bwill\s+.*\s+take\s+control\b/i,
];

/**
 * Score an event+market as mention-style. Returns { isMention, confidence, reason }.
 * Confidence: 'high' (explicit mention language), 'medium' (contextual), 'low' (weak signals).
 */
export function classifyMentionMarket(event = {}, market = {}) {
  const hay = [
    event.title ?? '',
    event.sub_title ?? '',
    event.event_ticker ?? '',
    market.title ?? '',
    market.subtitle ?? '',
    market.yes_sub_title ?? '',
    market.no_sub_title ?? '',
    market.rules_primary ?? '',
    market.rules_secondary ?? '',
  ].join(' ');

  const lowerHay = hay.toLowerCase();

  // Strong exclusion: if it matches a negative pattern, it's NOT a mention market
  for (const neg of MENTION_NEGATIVE_PATTERNS) {
    if (neg.test(hay)) {
      return { isMention: false, confidence: 'high', reason: `negative_pattern: ${neg.source}` };
    }
  }

  // Positive detection: must have explicit mention-style language
  for (const pos of MENTION_POSITIVE_PATTERNS) {
    if (pos.test(hay)) {
      return { isMention: true, confidence: 'high', reason: `positive_pattern: ${pos.source}` };
    }
  }

  // Weak contextual signals
  const hasSpeaker = /\bspeaker\b|\bpresident\b|\bceo\b|\bcfo\b|\bannouncer\b/i.test(hay);
  const hasEventContext = /\bearnings\b|\bconference\b|\bspeech\b|\bdebate\b|\bhearing\b/i.test(hay);
  if (hasSpeaker && hasEventContext) {
    return { isMention: true, confidence: 'medium', reason: 'contextual: speaker + event context' };
  }

  return { isMention: false, confidence: 'high', reason: 'no mention-style language detected' };
}

/**
 * Filter a list of Kalshi events to only those containing at least one
 * mention-style market. Returns { mentionEvents, rejectedEvents, stats }.
 */
export function filterMentionEvents(events = []) {
  const mentionEvents = [];
  const rejectedEvents = [];
  let totalMarkets = 0;
  let mentionMarkets = 0;

  for (const event of events) {
    const markets = Array.isArray(event.markets) ? event.markets : [];
    totalMarkets += markets.length;
    const mentionMarketsInEvent = [];

    for (const market of markets) {
      const classification = classifyMentionMarket(event, market);
      if (classification.isMention) {
        mentionMarketsInEvent.push({ ...market, _mentionClassification: classification });
        mentionMarkets++;
      }
    }

    if (mentionMarketsInEvent.length > 0) {
      mentionEvents.push({
        ...event,
        markets: mentionMarketsInEvent,
        _mentionStats: {
          originalMarketCount: markets.length,
          mentionMarketCount: mentionMarketsInEvent.length,
        },
      });
    } else {
      rejectedEvents.push(event);
    }
  }

  return {
    mentionEvents,
    rejectedEvents,
    stats: {
      totalEvents: events.length,
      mentionEvents: mentionEvents.length,
      rejectedEvents: rejectedEvents.length,
      totalMarkets,
      mentionMarkets,
    },
  };
}
