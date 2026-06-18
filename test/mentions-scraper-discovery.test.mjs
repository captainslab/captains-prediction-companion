import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  scrapeMentionsCalendar,
  fetchMentionsCalendarTickers,
  selectMentionSeries,
  hydrateEventsByTicker,
  discoverMentionEvents,
} from '../scripts/packets/lib/kalshi-discovery.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures', 'mentions');
const OBAMA_TICKER = 'KXOBAMAMENTION-26JUN19';

const calendarHtml = readFileSync(join(FIX, 'kalshi-calendar-mentions.html'), 'utf8');
const seriesSample = JSON.parse(readFileSync(join(FIX, 'series-sample.json'), 'utf8')).series;
const obamaEvent = JSON.parse(readFileSync(join(FIX, 'obama-event.json'), 'utf8'));

// ── scraper: captures event ticker + visible + expanded + closed markets ──────
test('scrapeMentionsCalendar captures the Obama event ticker from rendered board', () => {
  const { tickers } = scrapeMentionsCalendar(calendarHtml);
  assert.ok(tickers.includes(OBAMA_TICKER), 'Obama event ticker scraped from board');
});

test('scrapeMentionsCalendar captures visible board markets', () => {
  const { tickers } = scrapeMentionsCalendar(calendarHtml);
  for (const t of ['KXBERNIEMENTION-26JUN18', 'KXMAMDANIMENTION-26JUN18', 'KXLASTWORDMENTION-26JUN18']) {
    assert.ok(tickers.includes(t), `visible market ${t} scraped`);
  }
});

test('scrapeMentionsCalendar captures expanded "show markets" sub-rows', () => {
  const { tickers } = scrapeMentionsCalendar(calendarHtml);
  for (const t of ['KXOBAMAMENTION-26JUN19-CHIC', 'KXOBAMAMENTION-26JUN19-IRAN', 'KXOBAMAMENTION-26JUN19-TRUM']) {
    assert.ok(tickers.includes(t), `expanded market ${t} scraped`);
  }
});

test('scrapeMentionsCalendar captures closed/history section markets', () => {
  const { tickers } = scrapeMentionsCalendar(calendarHtml);
  assert.ok(tickers.includes('KXBERNIEMENTION-26MAY03'), 'closed/settled market scraped from history section');
});

test('scrapeMentionsCalendar returns no tickers for the inert SPA stub', () => {
  const stub = '<html><body><div id="__next"></div></body></html>';
  assert.deepEqual(scrapeMentionsCalendar(stub).tickers, []);
  assert.deepEqual(scrapeMentionsCalendar('').tickers, []);
});

// ── pageFetcher injection (scraper-first) ─────────────────────────────────────
test('fetchMentionsCalendarTickers uses an injected JS-render pageFetcher', async () => {
  const res = await fetchMentionsCalendarTickers({
    pageFetcher: async () => ({ ok: true, status: 200, text: calendarHtml }),
  });
  assert.equal(res.ok, true);
  assert.ok(res.tickers.includes(OBAMA_TICKER));
});

test('fetchMentionsCalendarTickers reports not-ok when the render yields no tickers', async () => {
  const res = await fetchMentionsCalendarTickers({
    pageFetcher: async () => ({ ok: true, status: 200, text: '<html></html>' }),
  });
  assert.equal(res.ok, false);
  assert.deepEqual(res.tickers, []);
});

// ── series selection: category-first beats the legacy regex ───────────────────
test('selectMentionSeries captures category=Mentions series the regex misses', () => {
  const picked = selectMentionSeries(seriesSample);
  const tickers = new Set(picked.map((s) => s.ticker));
  assert.ok(tickers.has('KXOBAMAMENTION'), 'Obama series selected');
  // These have NO "mention" substring in ticker/title but are category Mentions.
  for (const t of ['KXTRUMPSAYEP', 'KXLASTWORDCOUNT', 'KXDJTHANNITY']) {
    assert.ok(tickers.has(t), `category-only mention series ${t} selected`);
  }
  const viaCategory = picked.filter((s) => s._matchedVia === 'category').length;
  assert.ok(viaCategory > 0, 'at least some series matched via category');
});

test('selectMentionSeries category-first finds strictly more than the bare regex', () => {
  const regexOnly = seriesSample.filter((s) =>
    /mention/i.test(`${s.ticker || ''} ${s.title || ''}`));
  const picked = selectMentionSeries(seriesSample);
  assert.ok(picked.length > regexOnly.length,
    `category+regex (${picked.length}) > regex-only (${regexOnly.length})`);
});

// ── hydrate + full orchestrator with fallback ─────────────────────────────────
test('hydrateEventsByTicker pulls full nested markets for a scraped ticker', async () => {
  const fetcher = async (url) => {
    assert.ok(url.includes(encodeURIComponent(OBAMA_TICKER)));
    return { ok: true, status: 200, json: { event: obamaEvent } };
  };
  const res = await hydrateEventsByTicker([OBAMA_TICKER], { fetcher });
  assert.equal(res.events.length, 1);
  assert.equal(res.events[0].event_ticker, OBAMA_TICKER);
  assert.equal(res.events[0]._discoveredVia, 'page_scrape');
  assert.equal(res.events[0].markets.length, 14, 'all 14 Obama markets hydrated');
});

test('discoverMentionEvents is scraper-first and unions the Obama event', async () => {
  const pageFetcher = async () => ({ ok: true, status: 200, text: calendarHtml });
  const fetcher = async (url) => {
    if (url.includes('/events/')) return { ok: true, status: 200, json: { event: obamaEvent } };
    return { ok: true, status: 200, json: { series: [], events: [] } };
  };
  const out = await discoverMentionEvents({ pageFetcher, fetcher });
  assert.ok(out.scrapedTickers.includes(OBAMA_TICKER), 'scrape ran first and saw Obama');
  assert.ok(out.events.some((e) => e.event_ticker === OBAMA_TICKER), 'Obama present in union');
  assert.equal(out.sources.scrape.ok, true);
});

test('discoverMentionEvents falls back to series scan when the scrape is empty', async () => {
  const pageFetcher = async () => ({ ok: true, status: 200, text: '<html></html>' });
  const fetcher = async (url) => {
    if (url.includes('/series')) {
      return { ok: true, status: 200, json: { series: [{ ticker: 'KXOBAMAMENTION', title: 'Obama mention', category: 'Mentions' }] } };
    }
    if (url.includes('/events?series_ticker=KXOBAMAMENTION')) {
      return { ok: true, status: 200, json: { events: [obamaEvent] } };
    }
    return { ok: true, status: 200, json: { events: [] } };
  };
  const out = await discoverMentionEvents({ pageFetcher, fetcher });
  assert.deepEqual(out.scrapedTickers, [], 'scrape produced nothing');
  assert.ok(out.events.some((e) => e.event_ticker === OBAMA_TICKER), 'series fallback recovered Obama');
  assert.ok(out.sources.series.count >= 1);
});
