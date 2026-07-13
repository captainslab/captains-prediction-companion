import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchMentionEventsBySeries,
  resolveDiscoveryConcurrency,
} from '../scripts/packets/lib/kalshi-discovery.mjs';

function makeSeries(count) {
  return Array.from({ length: count }, (_, index) => ({
    ticker: `KXFAKESERIES${index}MENTION`,
    title: `Fake mention series ${index}`,
    category: 'Mentions',
  }));
}

function makeFetcher({ count = 20, latencyMs = 0, onStart = () => {}, onFinish = () => {} } = {}) {
  const series = makeSeries(count);
  return async (url) => {
    if (url.includes('/series?')) {
      return { ok: true, status: 200, json: { series } };
    }
    const ticker = new URL(url).searchParams.get('series_ticker');
    onStart(ticker);
    try {
      if (latencyMs) await new Promise((resolve) => setTimeout(resolve, latencyMs));
      return {
        ok: true,
        status: 200,
        json: { events: [{ event_ticker: `${ticker}-EVENT` }] },
      };
    } finally {
      onFinish(ticker);
    }
  };
}

async function runScan({ count = 20, latencyMs = 0, concurrency } = {}) {
  let inFlight = 0;
  let peak = 0;
  const fetcher = makeFetcher({
    count,
    latencyMs,
    onStart: () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
    },
    onFinish: () => { inFlight -= 1; },
  });
  const started = Date.now();
  const options = { fetcher, maxEventPagesPerSeries: 1 };
  if (concurrency !== undefined) options.concurrency = concurrency;
  const result = await fetchMentionEventsBySeries(options);
  return { result, peak, elapsedMs: Date.now() - started };
}

test('series scan never exceeds the configured concurrency and removes the sequential bottleneck', async () => {
  const sequential = await runScan({ count: 20, latencyMs: 25, concurrency: 1 });
  const concurrent = await runScan({ count: 20, latencyMs: 25, concurrency: 3 });

  assert.equal(sequential.peak, 1, 'explicit options.concurrency: 1 must remain sequential');
  assert.ok(concurrent.peak <= 3, `peak in-flight fetches ${concurrent.peak} exceeded limit 3`);
  assert.equal(concurrent.peak, 3, 'the worker pool should use the configured parallelism');
  assert.ok(
    concurrent.elapsedMs < sequential.elapsedMs / 2,
    `concurrent scan ${concurrent.elapsedMs}ms was not less than half of sequential ${sequential.elapsedMs}ms`,
  );
  console.log(`[timing] fake-latency series scan sequential=${sequential.elapsedMs}ms concurrent=${concurrent.elapsedMs}ms (20 series x 25ms, limit=3)`);
});

test('resolveDiscoveryConcurrency falls back safely and clamps excessive values', () => {
  const cases = [
    ['', 6],
    ['   ', 6],
    [undefined, 6],
    [null, 6],
    ['abc', 6],
    [0, 6],
    ['0', 6],
    [-3, 6],
    ['4', 4],
    [500, 12],
    [6, 6],
  ];
  for (const [provided, expected] of cases) {
    assert.equal(resolveDiscoveryConcurrency(provided), expected, `provided=${String(provided)}`);
  }
  console.log(`[concurrency-resolution] ${cases.map(([provided, expected]) => `${String(provided)}=>${expected}`).join(', ')}`);
});

test('an empty concurrency environment value still uses the concurrent default', async () => {
  const previous = process.env.KALSHI_DISCOVERY_CONCURRENCY;
  process.env.KALSHI_DISCOVERY_CONCURRENCY = '';
  try {
    const { peak } = await runScan({ count: 20, latencyMs: 25 });
    assert.ok(peak > 1, `empty environment value must not collapse the scan to sequential (peak=${peak})`);
    assert.ok(peak <= 6, `default concurrency must remain bounded (peak=${peak})`);
  } finally {
    if (previous === undefined) delete process.env.KALSHI_DISCOVERY_CONCURRENCY;
    else process.env.KALSHI_DISCOVERY_CONCURRENCY = previous;
  }
});

test('concurrent series results preserve sequential series and page order without duplicates', async () => {
  const sequential = await runScan({ count: 20, concurrency: 1 });
  const concurrent = await runScan({ count: 20, concurrency: 6 });
  const sequentialTickers = sequential.result.events.map((event) => event.event_ticker);
  const concurrentTickers = concurrent.result.events.map((event) => event.event_ticker);

  assert.deepEqual(concurrentTickers, sequentialTickers);
  assert.equal(new Set(concurrentTickers).size, concurrentTickers.length);
  assert.ok(concurrent.result.events.every((event) => event._discoveredVia === 'series_scan'));
});

test('aborting during a series scan returns events collected before workers stop', async () => {
  const controller = new AbortController();
  const fetcher = makeFetcher({ count: 10, latencyMs: 30 });
  const scan = fetchMentionEventsBySeries({
    fetcher,
    signal: controller.signal,
    concurrency: 2,
    maxEventPagesPerSeries: 1,
  });
  setTimeout(() => controller.abort(), 45);
  const result = await scan;

  assert.ok(result.events.length > 0, 'partial events should survive an abort');
  assert.ok(result.events.length < 10, 'workers should stop pulling new series after abort');
});

test('aborting before discovery starts returns an explicit empty result without throwing', async () => {
  const controller = new AbortController();
  controller.abort();
  let fetchCalls = 0;
  const result = await fetchMentionEventsBySeries({
    signal: controller.signal,
    fetcher: async () => {
      fetchCalls += 1;
      throw new Error('fetch must not run after an early abort');
    },
  });

  assert.equal(fetchCalls, 0);
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.attempts, []);
  assert.equal(result.ok, false);
});
