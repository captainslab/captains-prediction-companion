import test from 'node:test';
import assert from 'node:assert/strict';

import { getEventStartTime, _test } from '../scripts/mentions/event-start-time.mjs';

test('extracts the rendered Kalshi display time and preserves the event page source', async () => {
  const calls = [];
  const firecrawl = {
    async scrape(url, options) {
      calls.push({ url, options });
      return { markdown: 'Donald Trump - Speech to the Nation\nToday @ 8:00pm CDT' };
    },
  };

  const result = await getEventStartTime('KXTRUMPMENTION-26JUL16', { firecrawl });

  assert.equal(result.event_family, 'mentions');
  assert.equal(result.event_ticker, 'KXTRUMPMENTION-26JUL16');
  assert.equal(result.event_start_utc, '2026-07-17T01:00:00.000Z');
  assert.equal(result.prepare_at_utc, null);
  assert.equal(result.report_at_utc, null);
  assert.equal(result.authority, 'firecrawl_kalshi_web');
  assert.equal(result.source_url, 'https://kalshi.com/events/KXTRUMPMENTION-26JUL16');
  assert.equal(result.status, 'fresh');
  assert.equal(result.idempotency_key, 'mentions:KXTRUMPMENTION-26JUL16:2026-07-17T01:00:00.000Z');
  assert.equal(result.value, '2026-07-16 20:00 CDT');
  assert.equal(result.format, 'central');
  assert.equal(result.field, 'Today @ 8:00pm CDT');
  assert.deepEqual(calls, [{
    url: 'https://kalshi.com/events/KXTRUMPMENTION-26JUL16',
    options: { formats: ['markdown', 'html', 'rawHtml'], waitFor: 3000 },
  }]);
});

test('extracts an ISO timing field from hydration HTML', async () => {
  const firecrawl = {
    async scrape() {
      return { rawHtml: '<script>window.__NEXT_DATA__={"event_start_time":"2026-07-17T01:00:00Z"}</script>' };
    },
  };

  const result = await getEventStartTime('KXTRUMPMENTION-26JUL16', { firecrawl });
  assert.equal(result.event_start_utc, '2026-07-17T01:00:00.000Z');
  assert.equal(result.source_url, 'https://kalshi.com/events/KXTRUMPMENTION-26JUL16');
  assert.equal(result.value, '2026-07-16 20:00 CDT');
});

test('extracts start_date from the Next.js milestone hydration object', async () => {
  const firecrawl = {
    async scrape() {
      return {
        rawHtml: '<script>self.__next_f.push([1,"{\\"start_date\\":\\"2026-07-17T01:00:00Z\\",\\"related_event_tickers\\":[\\"KXTRUMPMENTION-26JUL16\\"]}"])</script>',
      };
    },
  };

  const result = await getEventStartTime('KXTRUMPMENTION-26JUL16', { firecrawl });
  assert.equal(result.event_start_utc, '2026-07-17T01:00:00.000Z');
  assert.equal(result.field, '2026-07-17T01:00:00Z');
});

test('accepts non-mentions Kalshi event families', async () => {
  const firecrawl = {
    async scrape() {
      return { rawHtml: '<script>{"start_date":"2026-08-06T00:00:00Z","related_event_tickers":["KXNFLGAME-26AUG06CARARI"]}</script>' };
    },
  };

  const result = await getEventStartTime('KXNFLGAME-26AUG06CARARI', { firecrawl });
  assert.equal(result.event_family, 'mentions');
  assert.equal(result.event_start_utc, '2026-08-06T00:00:00.000Z');
  assert.equal(result.source_url, 'https://kalshi.com/events/KXNFLGAME-26AUG06CARARI');
});

test('does not associate an unrelated hydrated milestone with the requested event', () => {
  const content = [
    '{"id":"one","related_event_tickers":["KXOTHERGAME-26AUG06ABCDEF"],"start_date":"2026-08-06T00:00:00Z"}',
    '{"id":"two","related_event_tickers":["KXNFLGAME-26AUG06CARARI"],"start_date":"2026-08-06T01:00:00Z"}',
  ].join('');

  const result = _test.findEventTime('KXNFLGAME-26AUG06CARARI', content);
  assert.equal(result.startTimeUtc, '2026-08-06T01:00:00Z');
});

test('extracts the rendered Begins-in timestamp and converts it to Central', async () => {
  const firecrawl = {
    async scrape() {
      return { markdown: 'Begins in 5h · Jul 16, 9:00pm EDT' };
    },
  };

  const result = await getEventStartTime('KXTRUMPMENTION-26JUL16', { firecrawl });
  assert.equal(result.value, '2026-07-16 20:00 CDT');
  assert.equal(result.field, 'Begins in 5h · Jul 16, 9:00pm EDT');
});

test('returns null for invalid tickers and missing timing', async () => {
  assert.equal(await getEventStartTime('NOT-A-KALSHI-TICKER', { firecrawl: {} }), null);
  assert.equal(_test.findEventTime('KXTRUMPMENTION-26JUL16', 'no timing here'), null);
});
