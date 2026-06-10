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

export const KALSHI_SOURCES = Object.freeze({
  mentions: {
    label: 'kalshi-calendar-mentions',
    page_url: 'https://kalshi.com/calendar/mentions',
    // NOTE: /events does NOT honor a category filter — it silently returns all
    // categories. Mentions span hundreds of series, so we resolve the series
    // set from /series?category=Mentions and filter events client-side.
    api_url: `${KALSHI_API_BASE}/events?status=open&limit=200&with_nested_markets=true`,
    series_category: 'Mentions',
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
  let lastError = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: options.signal,
      });
      const text = await res.text();
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
      lastError = err.message || String(err);
      if (attempt < maxRetries - 1) {
        const delay = baseDelayMs * (2 ** attempt);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  return { ok: false, status: 0, json: null, error: lastError };
}

/**
 * Resolve the set of series tickers belonging to a Kalshi category
 * (e.g. 'Mentions'). Used when /events cannot filter server-side.
 * Returns { ok, tickers: Set, error }.
 */
export async function fetchSeriesTickersForCategory(category, options = {}) {
  const fetcher = options.fetcher ?? defaultFetcher;
  const url = `${KALSHI_API_BASE}/series?category=${encodeURIComponent(category)}`;
  const res = await fetcher(url);
  if (!res.ok || !res.json || !Array.isArray(res.json.series)) {
    return { ok: false, tickers: new Set(), error: res.error || 'no series body' };
  }
  return { ok: true, tickers: new Set(res.json.series.map((s) => s.ticker).filter(Boolean)), error: null };
}

/**
 * Fetch events for a known source key with optional pagination.
 * When the source declares `series_category`, all open events are paged and
 * filtered client-side to series in that category (the /events endpoint
 * ignores a category param). Returns { ok, events, raw, attempts, source }.
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
  // Category-filtered sources must walk the full open-event list; the API
  // returns far-future closes first, so a low page cap would miss near-term
  // events entirely.
  const maxPages = options.maxPages ?? (source.series_category ? 80 : 5);
  let lastError = null;

  let seriesFilter = null;
  if (source.series_category) {
    const seriesRes = await fetchSeriesTickersForCategory(source.series_category, { fetcher });
    attempts.push({
      url: `${KALSHI_API_BASE}/series?category=${encodeURIComponent(source.series_category)}`,
      ok: seriesRes.ok,
      status: seriesRes.ok ? 200 : 0,
      error: seriesRes.error,
    });
    if (!seriesRes.ok) {
      return { ok: false, events: [], raw: attempts, attempts, source, error: seriesRes.error };
    }
    seriesFilter = seriesRes.tickers;
  }

  while (pageCount < maxPages) {
    const url = cursor ? `${source.api_url}&cursor=${encodeURIComponent(cursor)}` : source.api_url;
    const res = await fetcher(url);
    attempts.push({ url, ok: res.ok, status: res.status, error: res.error });
    if (!res.ok || !res.json) { lastError = res.error || 'no JSON body'; break; }
    const pageEvents = Array.isArray(res.json.events) ? res.json.events : [];
    for (const ev of pageEvents) {
      if (seriesFilter && !seriesFilter.has(ev?.series_ticker)) continue;
      events.push(ev);
    }
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
  } else if (market.custom_strike && typeof market.custom_strike === 'object' && !Array.isArray(market.custom_strike)) {
    // Mention-style markets carry the contract phrase as an object, e.g.
    // { Word: 'Stargate' }. Only display-text keys are used — other series
    // put opaque identifiers here (e.g. { baseball_team: '<uuid>' }), which
    // must not become labels. This keeps each mention contract rendering its
    // own phrase instead of falling through to the shared event title.
    const DISPLAY_KEYS = /^(word|phrase|text|label|name|title)$/i;
    const text = Object.entries(market.custom_strike)
      .filter(([k, v]) => DISPLAY_KEYS.test(k) && typeof v === 'string' && v.trim())
      .map(([, v]) => v.trim())
      .join(' ');
    // Display-key custom strikes are the literal contract phrase (e.g.
    // { Word: 'MVP' }) — exempt from the ticker-shorthand heuristic, which
    // would otherwise reject legitimate short all-caps phrases.
    if (text) tries.push({ source: 'custom_strike', text, trusted: true });
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
    if (candidate.trusted || !looksLikeTickerShorthand(candidate.text, ticker)) {
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
    writeFileSync(path, JSON.stringify(ev, null, 2), 'utf8');
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
  return { ticker, title, sub_title, series, close, marketCount };
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
