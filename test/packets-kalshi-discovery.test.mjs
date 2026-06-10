// Tests for shared Kalshi event/market discovery helper.
// Uses an injected fake fetcher — no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fetchKalshiEvents,
  filterByCloseDateUtc,
  filterByEventDate,
  filterNascarCupOnly,
  persistEventArtifacts,
  summarizeEvent,
  normalizeMarket,
  buildStrikeDisplay,
  renderMarketBlocks,
  looksLikeTickerShorthand,
  extractDateFromTicker,
  deriveEventDate,
  KALSHI_SOURCES,
} from '../scripts/packets/lib/kalshi-discovery.mjs';

test('KALSHI_SOURCES covers all four packet types with calendar/category page URLs', () => {
  for (const key of ['mentions', 'mlb', 'ufc', 'nascar']) {
    assert.ok(KALSHI_SOURCES[key].page_url, `${key} page_url`);
    assert.ok(KALSHI_SOURCES[key].api_url.startsWith('https://api.elections.kalshi.com'), `${key} api_url`);
  }
  assert.equal(KALSHI_SOURCES.mentions.page_url, 'https://kalshi.com/calendar/mentions');
  assert.equal(KALSHI_SOURCES.mlb.page_url, 'https://kalshi.com/calendar/sports/baseball');
  assert.equal(KALSHI_SOURCES.ufc.page_url, 'https://kalshi.com/calendar/sports/mma/ufc');
  assert.equal(KALSHI_SOURCES.nascar.page_url, 'https://kalshi.com/category/sports/motorsport/nascar-cup-series');
});

test('mentions API URL now includes with_nested_markets=true (markets are contracts, not opaque event ids)', () => {
  assert.match(KALSHI_SOURCES.mentions.api_url, /with_nested_markets=true/);
});

test('fetchKalshiEvents uses injected fetcher and aggregates pages via cursor', async () => {
  const calls = [];
  const pages = {
    '': { events: [{ event_ticker: 'A' }, { event_ticker: 'B' }], cursor: 'next' },
    'next': { events: [{ event_ticker: 'C' }], cursor: '' },
  };
  const fetcher = async (url) => {
    calls.push(url);
    const cursorMatch = url.match(/cursor=([^&]+)/);
    const cursor = cursorMatch ? decodeURIComponent(cursorMatch[1]) : '';
    return { ok: true, status: 200, json: pages[cursor], error: null };
  };
  const res = await fetchKalshiEvents('mlb', { fetcher });
  assert.equal(res.ok, true);
  assert.equal(res.events.length, 3);
  assert.deepEqual(res.events.map(e => e.event_ticker), ['A', 'B', 'C']);
  assert.equal(calls.length, 2);
});

test('fetchKalshiEvents returns empty + error when fetch fails', async () => {
  const fetcher = async () => ({ ok: false, status: 503, json: null, error: 'HTTP 503' });
  const res = await fetchKalshiEvents('ufc', { fetcher });
  assert.equal(res.ok, false);
  assert.equal(res.events.length, 0);
  assert.match(res.error, /503/);
});

test('fetchKalshiEvents rejects unknown source key', async () => {
  const res = await fetchKalshiEvents('not-a-sport');
  assert.equal(res.ok, false);
  assert.match(res.error, /unknown source key/);
});

test('filterByCloseDateUtc keeps events inside [date, date+windowDays+1) UTC (legacy)', () => {
  const f = filterByCloseDateUtc('2026-05-18', 0);
  assert.equal(f({ close_time: '2026-05-18T20:00:00Z' }), true);
  assert.equal(f({ close_time: '2026-05-19T00:00:00Z' }), false);
  assert.equal(f({ close_time: '2026-05-17T23:59:59Z' }), false);
  assert.equal(f({}), true);
});

test('filterNascarCupOnly keeps Cup, drops Truck/Xfinity/Auto Parts', () => {
  assert.equal(filterNascarCupOnly({ product_metadata: { competition: 'NASCAR Cup Series' } }), true);
  assert.equal(filterNascarCupOnly({ product_metadata: { competition: 'NASCAR Truck Series' } }), false);
  assert.equal(filterNascarCupOnly({ product_metadata: { competition: "NASCAR O'Reilly Auto Parts Series" } }), false);
  assert.equal(filterNascarCupOnly({}), false);
});

test('persistEventArtifacts writes one JSON file per event under state/<sport>/<date>/kalshi-events/', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'kalshi-disc-'));
  try {
    const res = persistEventArtifacts({
      stateRoot: tmp,
      sport: 'mlb',
      date: '2026-05-18',
      events: [
        { event_ticker: 'KXMLBGAME-26MAY18-A', title: 'A' },
        { event_ticker: 'KXMLBGAME-26MAY18-B', title: 'B' },
        { title: 'no ticker' },
      ],
    });
    assert.equal(res.written.length, 2);
    const files = readdirSync(res.dir);
    assert.ok(files.includes('KXMLBGAME-26MAY18-A.json'));
    assert.ok(files.includes('KXMLBGAME-26MAY18-B.json'));
    const parsed = JSON.parse(readFileSync(join(res.dir, 'KXMLBGAME-26MAY18-A.json'), 'utf8'));
    assert.equal(parsed.event_ticker, 'KXMLBGAME-26MAY18-A');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('summarizeEvent extracts event-level fields and never reuses market title', () => {
  const s = summarizeEvent({
    event_ticker: 'KXMLBGAME-X',
    title: 'A vs B',
    sub_title: 'ATH vs LAA (May 20)',
    series_ticker: 'KXMLBGAME',
    markets: [{ title: 'ATH', close_time: '2026-05-21T04:38:00Z' }, {}, {}],
  });
  assert.equal(s.ticker, 'KXMLBGAME-X');
  assert.equal(s.title, 'A vs B');
  assert.equal(s.sub_title, 'ATH vs LAA (May 20)');
  assert.equal(s.marketCount, 3);
  // close falls back to markets[0].close_time when event has none.
  assert.equal(s.close, '2026-05-21T04:38:00Z');
  const empty = summarizeEvent({});
  assert.equal(empty.ticker, 'MISSING');
});

// ---------------------------------------------------------------------------
// Market normalization + strike display
// ---------------------------------------------------------------------------

test('looksLikeTickerShorthand: short all-caps no-space => shorthand; mixed-case sentence => not', () => {
  assert.equal(looksLikeTickerShorthand('ATH'), true);
  assert.equal(looksLikeTickerShorthand('HEG'), true);
  assert.equal(looksLikeTickerShorthand('ATHLAA'), true);
  assert.equal(looksLikeTickerShorthand('DON', 'KX-FOO-DON'), true);
  assert.equal(looksLikeTickerShorthand("A's"), false);
  assert.equal(looksLikeTickerShorthand('Ryan Preece'), false);
  assert.equal(looksLikeTickerShorthand('Will Elon Musk visit Mars before Aug 1, 2099?'), false);
});

test('buildStrikeDisplay prefers functional_strike, falls back through subtitle hierarchy', () => {
  // functional_strike wins
  assert.deepEqual(buildStrikeDisplay({ functional_strike: 'Over 8.5 runs', title: 'X' }), {
    source: 'functional_strike', text: 'Over 8.5 runs', missing: false,
  });
  // floor/cap range
  assert.deepEqual(buildStrikeDisplay({ floor_strike: 0, cap_strike: 50 }), {
    source: 'floor_cap_strike', text: '[0, 50]', missing: false,
  });
  // yes_sub_title with real name
  assert.equal(buildStrikeDisplay({ yes_sub_title: 'Ryan Preece' }).source, 'yes_sub_title');
  // title fallback
  assert.equal(
    buildStrikeDisplay({ title: 'A\'s vs Los Angeles A Winner?' }).source,
    'title',
  );
});

test('buildStrikeDisplay marks missing when only ticker-shorthand candidates exist', () => {
  const r = buildStrikeDisplay({
    ticker: 'KXMLBGAME-26MAY202138ATHLAA-ATH',
    yes_sub_title: 'ATH',
    no_sub_title: 'ATH',
    title: 'ATHLAA',
  });
  assert.equal(r.missing, true);
  assert.equal(r.text, null);
  assert.equal(r.source, null);
});

test('normalizeMarket preserves all required market fields incl. prices', () => {
  const raw = {
    ticker: 'KXMLBGAME-X-ATH',
    event_ticker: 'KXMLBGAME-X',
    title: "A's vs Los Angeles A Winner?",
    subtitle: null,
    yes_sub_title: "A's",
    no_sub_title: "A's",
    functional_strike: null,
    custom_strike: { baseball_team: 'uuid' },
    floor_strike: null,
    cap_strike: null,
    strike_type: 'custom',
    yes_bid_dollars: '0.55',
    yes_ask_dollars: '0.57',
    no_bid_dollars: '0.43',
    no_ask_dollars: '0.45',
    last_price_dollars: '0.56',
    volume_fp: '1234.5',
    liquidity_dollars: '500.00',
    open_interest_fp: '99.9',
    close_time: '2026-05-21T04:38:00Z',
    expected_expiration_time: '2026-05-21T04:38:00Z',
    expiration_time: '2026-05-28T04:38:00Z',
    rules_primary: 'primary rules',
    rules_secondary: 'secondary',
  };
  const m = normalizeMarket(raw);
  assert.equal(m.ticker, 'KXMLBGAME-X-ATH');
  assert.equal(m.yes_bid_dollars, '0.55');
  assert.equal(m.yes_ask_dollars, '0.57');
  assert.equal(m.no_bid_dollars, '0.43');
  assert.equal(m.no_ask_dollars, '0.45');
  assert.equal(m.last_price_dollars, '0.56');
  assert.equal(m.liquidity_dollars, '500.00');
  assert.equal(m.volume_fp, '1234.5');
  assert.equal(m.rules_primary, 'primary rules');
  // Strike must come from title (mixed-case, not shorthand).
  assert.equal(m.strike_source_used, 'title');
  assert.equal(m.full_strike_display, "A's vs Los Angeles A Winner?");
  assert.equal(m.missing_strike_text, false);
});

test('renderMarketBlocks: one event with three markets produces three blocks', () => {
  const event = {
    event_ticker: 'KXFOO',
    title: 'Foo Event',
    markets: [
      { ticker: 'KXFOO-A', title: 'Will A?', yes_sub_title: 'Alice Smith', yes_bid_dollars: '0.10', yes_ask_dollars: '0.12' },
      { ticker: 'KXFOO-B', title: 'Will B?', yes_sub_title: 'Bob Jones',   yes_bid_dollars: '0.40', yes_ask_dollars: '0.42' },
      { ticker: 'KXFOO-C', title: 'Will C?', yes_sub_title: 'Cara Lee',    yes_bid_dollars: '0.20', yes_ask_dollars: '0.22' },
    ],
  };
  const { lines, marketCount, missingStrikeCount, missingMarkets } = renderMarketBlocks(event);
  assert.equal(marketCount, 3);
  assert.equal(missingStrikeCount, 0);
  assert.equal(missingMarkets, false);
  const text = lines.join('\n');
  assert.match(text, /market_ticker: KXFOO-A/);
  assert.match(text, /market_ticker: KXFOO-B/);
  assert.match(text, /market_ticker: KXFOO-C/);
  // Per-market prices preserved
  assert.match(text, /yes_bid: 0.10/);
  assert.match(text, /yes_bid: 0.40/);
  assert.match(text, /yes_bid: 0.20/);
  // Strike text came from yes_sub_title (real names), not ticker fragments
  assert.match(text, /strike_source_used: yes_sub_title/);
  assert.match(text, /full_strike_display: Alice Smith/);
});

test('renderMarketBlocks: event-level title is not reused as every market title', () => {
  const event = {
    event_ticker: 'KXFOO',
    title: 'EVENT-LEVEL TITLE SHOULD NOT LEAK',
    markets: [
      { ticker: 'KXFOO-A', title: "A's vs Los Angeles A Winner?", yes_sub_title: "A's" },
      { ticker: 'KXFOO-B', title: "A's vs Los Angeles A Winner?", yes_sub_title: 'Los Angeles A' },
    ],
  };
  const { lines } = renderMarketBlocks(event);
  const text = lines.join('\n');
  assert.equal(text.includes('EVENT-LEVEL TITLE SHOULD NOT LEAK'), false);
});

test('renderMarketBlocks marks MISSING_MARKETS when event has no markets[]', () => {
  const { lines, marketCount, missingMarkets } = renderMarketBlocks({ event_ticker: 'X' });
  assert.equal(marketCount, 0);
  assert.equal(missingMarkets, true);
  assert.ok(lines.join('\n').includes('MISSING_MARKETS'));
});

test('renderMarketBlocks marks MISSING_STRIKE_TEXT when only ticker-shorthand labels exist', () => {
  const event = {
    event_ticker: 'KXBAD',
    markets: [
      { ticker: 'KXBAD-HEG', title: 'HEG', yes_sub_title: 'HEG', no_sub_title: 'HEG' },
    ],
  };
  const { missingStrikeCount, lines } = renderMarketBlocks(event);
  assert.equal(missingStrikeCount, 1);
  assert.match(lines.join('\n'), /MISSING_STRIKE_TEXT/);
});

// ---------------------------------------------------------------------------
// Date routing
// ---------------------------------------------------------------------------

test('extractDateFromTicker decodes Kalshi date-coded tickers (MLB/UFC style)', () => {
  assert.equal(extractDateFromTicker('KXMLBGAME-26MAY202138ATHLAA'), '2026-05-20');
  assert.equal(extractDateFromTicker('KXUFCFIGHT-26JUL11MCGHOL'), '2026-07-11');
  assert.equal(extractDateFromTicker('KXUFCFIGHT-26MAY16WELDAL'), '2026-05-16');
  assert.equal(extractDateFromTicker('KXELONMARS-99'), null);
  assert.equal(extractDateFromTicker(null), null);
});

test('deriveEventDate uses ticker-date first, then market.expected_expiration_time (in ET)', () => {
  // Ticker-encoded MLB date wins, even if market.close_time is days later.
  assert.equal(
    deriveEventDate({
      event_ticker: 'KXMLBGAME-26MAY202138ATHLAA',
      markets: [{ close_time: '2026-05-24T01:38:00Z', expected_expiration_time: '2026-05-21T04:38:00Z' }],
    }),
    '2026-05-20',
  );
  // UFC: ticker date wins
  assert.equal(
    deriveEventDate({
      event_ticker: 'KXUFCFIGHT-26MAY16WELDAL',
      markets: [{ close_time: '2026-05-13T15:10:05Z' }],
    }),
    '2026-05-16',
  );
  // Pure undated event -> null
  assert.equal(deriveEventDate({ event_ticker: 'KXELONMARS-99' }), null);
});

test('filterByEventDate DROPS undated long-horizon events by default (no flood)', () => {
  const f = filterByEventDate('2026-05-20', { windowDays: 7 });
  // Date-coded MLB on May 20 -> kept.
  assert.equal(f({ event_ticker: 'KXMLBGAME-26MAY202138ATHLAA' }), true);
  // Undated 2099 mention -> dropped by default.
  assert.equal(
    f({
      event_ticker: 'KXELONMARS-99',
      markets: [{ close_time: '2099-08-01T04:59:00Z' }],
    }),
    false,
  );
});

test('filterByEventDate keeps undated events when allowUndated=true', () => {
  const f = filterByEventDate('2026-05-20', { windowDays: 7, allowUndated: true });
  assert.equal(f({ event_ticker: 'KXELONMARS-99' }), true);
});

test('filterByEventDate respects windowDays for forward range', () => {
  const f = filterByEventDate('2026-05-15', { windowDays: 7 });
  // 5 days later -> kept.
  assert.equal(f({ event_ticker: 'KXUFCFIGHT-26MAY20FOO' }), true);
  // 8 days later -> dropped.
  assert.equal(f({ event_ticker: 'KXUFCFIGHT-26MAY23FOO' }), false);
});

test('NASCAR Cup filter + filterByEventDate together: keep Cup race in window, drop Truck and Xfinity', () => {
  const cupInWindow  = { event_ticker: 'KXNASCARRACE-NASA26', product_metadata: { competition: 'NASCAR Cup Series' }, markets: [{ expected_expiration_time: '2026-05-17T23:00:00Z' }] };
  const truck        = { event_ticker: 'KXNASCARRACE-ECO26',  product_metadata: { competition: 'NASCAR Truck Series' }, markets: [{ expected_expiration_time: '2026-05-16T03:00:00Z' }] };
  const xfinity     = { event_ticker: 'KXNASCARRACE-BET26',  product_metadata: { competition: "NASCAR O'Reilly Auto Parts Series" }, markets: [{ expected_expiration_time: '2026-05-17T02:00:00Z' }] };
  const date = '2026-05-17';
  const dateFilter = filterByEventDate(date, { windowDays: 1 });
  const passed = [cupInWindow, truck, xfinity].filter(filterNascarCupOnly).filter(dateFilter);
  assert.equal(passed.length, 1);
  assert.equal(passed[0].event_ticker, 'KXNASCARRACE-NASA26');
});

// ---------------------------------------------------------------------------
// Mention-market label + category-filtered discovery regressions (2026-06-10)
// ---------------------------------------------------------------------------

test('buildStrikeDisplay uses object custom_strike Word for mention contracts (yes==no sub_title)', () => {
  // Real mention-market shape: phrase only in custom_strike.Word; yes/no
  // sub_titles identical; title repeats the event question on every row.
  const r = buildStrikeDisplay({
    ticker: 'KXEARNINGSMENTIONORCL-26JUN10-STAR',
    title: 'What will Oracle Corporation say during their next earnings call?',
    yes_sub_title: 'Stargate',
    no_sub_title: 'Stargate',
    custom_strike: { Word: 'Stargate' },
  });
  assert.equal(r.source, 'custom_strike');
  assert.equal(r.text, 'Stargate');
  assert.equal(r.missing, false);
});

test('buildStrikeDisplay ignores opaque-identifier custom_strike objects', () => {
  const r = buildStrikeDisplay({
    ticker: 'KXMLBGAME-X-ATH',
    title: "A's vs Los Angeles A Winner?",
    yes_sub_title: "A's",
    no_sub_title: "A's",
    custom_strike: { baseball_team: '0b2f50f4-2b22-4a9f-bf3e-000000000000' },
  });
  assert.equal(r.source, 'title');
});

test('fetchKalshiEvents filters by series category client-side when source declares series_category', async () => {
  const pages = {
    'series?category=Mentions': { series: [{ ticker: 'KXTRUMPMENTION' }, { ticker: 'KXHEARINGMENTION' }] },
    'page1': {
      events: [
        { event_ticker: 'KXTRUMPMENTION-26JUN10', series_ticker: 'KXTRUMPMENTION' },
        { event_ticker: 'KXELONMARS-99', series_ticker: 'KXELONMARS' },
      ],
      cursor: 'c2',
    },
    'page2': {
      events: [{ event_ticker: 'KXHEARINGMENTION-26JUN10', series_ticker: 'KXHEARINGMENTION' }],
      cursor: '',
    },
  };
  const fetcher = async (url) => {
    let key;
    if (url.includes('/series?category=')) key = 'series?category=Mentions';
    else if (url.includes('cursor=')) key = 'page2';
    else key = 'page1';
    return { ok: true, status: 200, json: pages[key], error: null };
  };
  const res = await fetchKalshiEvents('mentions', { fetcher });
  assert.equal(res.ok, true);
  assert.deepEqual(
    res.events.map((e) => e.event_ticker).sort(),
    ['KXHEARINGMENTION-26JUN10', 'KXTRUMPMENTION-26JUN10'],
  );
});

test('buildStrikeDisplay trusts short all-caps phrases from custom_strike display keys (MVP/GOAT)', () => {
  const r = buildStrikeDisplay({
    ticker: 'KXNBAMENTION-26JUN10SASNYK-MVP',
    title: 'What will the announcers say during Spurs vs Knicks Professional Basketball Game?',
    yes_sub_title: 'MVP',
    no_sub_title: 'MVP',
    custom_strike: { Word: 'MVP' },
  });
  assert.equal(r.source, 'custom_strike');
  assert.equal(r.text, 'MVP');
});
