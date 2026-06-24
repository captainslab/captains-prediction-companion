import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gatherMentionEvents, resolveOnlyMentionEvents, writeKalshiEventPackets } from '../scripts/packets/generate-mentions-daily.mjs';

const REPO = resolve(import.meta.dirname, '..');

function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function makeEvent(ticker) {
  return { event_ticker: ticker, title: `Will ${ticker} be mentioned?`, markets: [{ ticker: `${ticker}-A`, title: 'Yes' }] };
}

function writeOnlyArtifacts(stateRoot, date, event) {
  const eventDir = join(stateRoot, 'mentions', date, 'kalshi-events');
  const researchDir = join(stateRoot, 'mentions', date, 'research');
  mkdirSync(eventDir, { recursive: true });
  mkdirSync(researchDir, { recursive: true });
  writeFileSync(join(eventDir, `${event.event_ticker}.json`), `${JSON.stringify(event, null, 2)}\n`);
  writeFileSync(join(researchDir, `${event.event_ticker}.json`), `${JSON.stringify({
    event_ticker: event.event_ticker,
    markets: event.markets.map((market) => ({
      market_ticker: market.ticker,
      layer_records: market.layer_records ?? {},
    })),
  }, null, 2)}\n`);
}

const passThroughFilter = (events) => ({
  mentionEvents: events,
  rejectedEvents: [],
  stats: {
    totalEvents: events.length,
    mentionEvents: events.length,
    rejectedEvents: 0,
    totalMarkets: events.reduce((s, e) => s + (Array.isArray(e.markets) ? e.markets.length : 0), 0),
    mentionMarkets: events.reduce((s, e) => s + (Array.isArray(e.markets) ? e.markets.length : 0), 0),
  },
});

const noopPrime = () => [];

const stubDiscovery = (tickers) => ({
  ok: true,
  events: tickers.map((t) => makeEvent(t)),
});

const stubSeriesDiscovery = (tickers) => ({
  ok: true,
  events: tickers.map((t) => makeEvent(t)),
});

test('explicit alpha intake runs before broad discovery', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mentions-gen-order-'));
  const date = '2099-01-01';
  const manualTicker = 'KXMANUAL-99JAN01';
  const discoveryTicker = 'KXDISCOVERY-99JAN01';

  const calls = [];
  const deps = {
    fetchKalshiEvents: async () => { calls.push('discovery'); return stubDiscovery([discoveryTicker]); },
    fetchMentionEventsBySeries: async () => { calls.push('series'); return stubSeriesDiscovery([]); },
    filterMentionEvents: passThroughFilter,
    collectAlphaMentionIntake: async () => {
      calls.push('alpha-intake');
      return { events: [makeEvent(manualTicker)], summary: { accepted: 1, manual_queue_offered: 1, manual_queue_consumed: 1, env_seeds_offered: 0, env_seeds_consumed: 0, fallback_used: false } };
    },
    primeMentionResearch: noopPrime,
    primeMentionSourceResearch: noopPrime,
    persistEventArtifacts: () => ({ written: [] }),
    consoleLog: () => {},
  };

  const result = await gatherMentionEvents({ stateRoot, date, deps });
  assert.equal(calls[0], 'alpha-intake', 'alpha intake must run before discovery');
  assert.equal(calls[1], 'discovery', 'discovery runs after alpha intake');
  assert.equal(result.allEvents.length, 2);
  const tickers = result.allEvents.map(e => e.event_ticker);
  assert.ok(tickers.includes(manualTicker));
  assert.ok(tickers.includes(discoveryTicker));
});

test('manual queue is consumed even if broad discovery throws', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mentions-gen-fail-'));
  const date = '2099-01-01';
  const manualTicker = 'KXMANUAL-99JAN02';

  const deps = {
    fetchKalshiEvents: async () => { throw new Error('discovery hang'); },
    fetchMentionEventsBySeries: async () => stubSeriesDiscovery([]),
    filterMentionEvents: passThroughFilter,
    collectAlphaMentionIntake: async () => ({
      events: [makeEvent(manualTicker)],
      summary: { accepted: 1, manual_queue_offered: 1, manual_queue_consumed: 1, env_seeds_offered: 0, env_seeds_consumed: 0, fallback_used: false },
    }),
    primeMentionResearch: noopPrime,
    primeMentionSourceResearch: noopPrime,
    persistEventArtifacts: () => ({ written: [] }),
    consoleLog: () => {},
  };

  await assert.rejects(
    async () => gatherMentionEvents({ stateRoot, date, deps }),
    /discovery hang/,
  );
});

test('fallback does not replace normal discovery', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mentions-gen-fallback-'));
  const date = '2099-01-01';
  const discoveryTicker = 'KXDISCOVERY-99JAN03';

  const deps = {
    fetchKalshiEvents: async () => stubDiscovery([discoveryTicker]),
    fetchMentionEventsBySeries: async () => stubSeriesDiscovery([]),
    filterMentionEvents: passThroughFilter,
    collectAlphaMentionIntake: async ({ fallbackEvents }) => {
      if (fallbackEvents?.length) {
        return { events: fallbackEvents.slice(0, 1), summary: { accepted: 1, manual_queue_offered: 0, manual_queue_consumed: 0, env_seeds_offered: 0, env_seeds_consumed: 0, fallback_used: true } };
      }
      return { events: [], summary: { accepted: 0, manual_queue_offered: 0, manual_queue_consumed: 0, env_seeds_offered: 0, env_seeds_consumed: 0, fallback_used: false } };
    },
    primeMentionResearch: noopPrime,
    primeMentionSourceResearch: noopPrime,
    persistEventArtifacts: () => ({ written: [] }),
    consoleLog: () => {},
  };

  const result = await gatherMentionEvents({ stateRoot, date, deps });
  assert.equal(result.allEvents.length, 1);
  assert.equal(result.allEvents[0].event_ticker, discoveryTicker);
});

test('events are deduped by event_ticker across intake and discovery', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mentions-gen-dedup-'));
  const date = '2099-01-01';
  const sharedTicker = 'KXSHARED-99JAN04';

  const deps = {
    fetchKalshiEvents: async () => stubDiscovery([sharedTicker]),
    fetchMentionEventsBySeries: async () => stubSeriesDiscovery([]),
    filterMentionEvents: passThroughFilter,
    collectAlphaMentionIntake: async () => ({
      events: [makeEvent(sharedTicker)],
      summary: { accepted: 1, manual_queue_offered: 1, manual_queue_consumed: 1, env_seeds_offered: 0, env_seeds_consumed: 0, fallback_used: false },
    }),
    primeMentionResearch: noopPrime,
    primeMentionSourceResearch: noopPrime,
    persistEventArtifacts: () => ({ written: [] }),
    consoleLog: () => {},
  };

  const result = await gatherMentionEvents({ stateRoot, date, deps });
  assert.equal(result.allEvents.length, 1);
  assert.equal(result.allEvents[0].event_ticker, sharedTicker);
});

test('research prime runs after persistence', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mentions-gen-prime-'));
  const date = '2099-01-01';

  const calls = [];
  const deps = {
    fetchKalshiEvents: async () => stubDiscovery(['KXDISCOVERY-99JAN05']),
    fetchMentionEventsBySeries: async () => stubSeriesDiscovery([]),
    filterMentionEvents: passThroughFilter,
    collectAlphaMentionIntake: async () => ({ events: [], summary: { accepted: 0, manual_queue_offered: 0, manual_queue_consumed: 0, env_seeds_offered: 0, env_seeds_consumed: 0, fallback_used: false } }),
    primeMentionResearch: () => { calls.push('prime-research'); return []; },
    primeMentionSourceResearch: () => { calls.push('source-research'); return []; },
    persistEventArtifacts: () => { calls.push('persist'); return { written: ['a.json'] }; },
    consoleLog: () => {},
  };

  const result = await gatherMentionEvents({ stateRoot, date, deps });
  assert.equal(result.persistedCount, 1);
  const persistIdx = calls.indexOf('persist');
  const sourceResearchIdx = calls.indexOf('source-research');
  assert.ok(persistIdx >= 0, 'persistence happened');
  assert.ok(sourceResearchIdx >= 0, 'source research happened');
  assert.ok(sourceResearchIdx > persistIdx, 'source research runs after persistence');
});

test('--only fast path uses existing artifacts and never gathers', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mentions-gen-only-fast-'));
  const date = '2099-01-06';
  const ticker = 'KXFASTONLY-99JAN06';
  const event = makeEvent(ticker);
  event.markets[0].layer_records = {
    event_proximity: { present: true, score: 80, source_basis: 'local fixture schedule' },
    historical_tendency: { present: true, score: 70, source_basis: 'local fixture research' },
  };
  writeOnlyArtifacts(stateRoot, date, event);

  let gatherCalls = 0;
  const result = await resolveOnlyMentionEvents({
    stateRoot,
    date,
    tickers: [ticker],
    deps: {
      gatherMentionEvents: async () => {
        gatherCalls += 1;
        throw new Error('gather should not run for the fast path');
      },
    },
  });

  assert.equal(gatherCalls, 0);
  assert.equal(result.mode, 'fast-path');
  assert.deepEqual(result.allEvents.map((e) => e.event_ticker), [ticker]);
  assert.equal(result.missingAfterGather.length, 0);
  assert.equal(result.discovery.source.label, 'local-only-artifact-fast-path');
});

test('--only missing local artifacts triggers gather and reloads the requested ticker', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mentions-gen-only-heal-'));
  const date = '2099-01-07';
  const ticker = 'KXHEALONLY-99JAN07';
  const event = makeEvent(ticker);
  event.markets[0].layer_records = {
    event_proximity: { present: true, score: 85, source_basis: 'discovery stub' },
    historical_tendency: { present: true, score: 90, source_basis: 'research stub' },
  };

  let gatherCalls = 0;
  const result = await resolveOnlyMentionEvents({
    stateRoot,
    date,
    tickers: [ticker],
    deps: {
      gatherMentionEvents: async ({ stateRoot: gatherRoot, date: gatherDate }) => {
        gatherCalls += 1;
        writeOnlyArtifacts(gatherRoot, gatherDate, event);
        return {
          combinedStats: { totalEvents: 1, mentionEvents: 1, rejectedEvents: 0, totalMarkets: 1, mentionMarkets: 1, broadEvents: 1, seriesEvents: 0 },
          discovery: {
            ok: true,
            events: [event],
            source: { label: 'stub-discovery', api_url: 'stub://api', page_url: 'stub://page' },
            error: null,
          },
          dateFilteredEvents: [event],
          persistedCount: 1,
          allPrimeAttempts: [{ ok: true, skipped: false, label: 'stub-prime', status: 0, stderr: '', error: null }],
        };
      },
    },
  });

  assert.equal(gatherCalls, 1);
  assert.equal(result.mode, 'self-heal');
  assert.deepEqual(result.allEvents.map((e) => e.event_ticker), [ticker]);
  assert.deepEqual(result.loadedAfterGather.map((x) => x.ticker), [ticker]);
  assert.deepEqual(result.missingAfterGather, []);
  assert.equal(result.discovery.source.label, 'stub-discovery');
});

test('--only stays fail-closed when gather still does not persist the requested ticker', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mentions-gen-only-block-'));
  const date = '2099-01-08';
  const ticker = 'KXBLOCKONLY-99JAN08';

  const result = await resolveOnlyMentionEvents({
    stateRoot,
    date,
    tickers: [ticker],
    deps: {
      gatherMentionEvents: async () => ({
        combinedStats: { totalEvents: 0, mentionEvents: 0, rejectedEvents: 0, totalMarkets: 0, mentionMarkets: 0, broadEvents: 0, seriesEvents: 0 },
        discovery: {
          ok: true,
          events: [],
          source: { label: 'stub-discovery', api_url: 'stub://api', page_url: 'stub://page' },
          error: null,
        },
        dateFilteredEvents: [],
        persistedCount: 0,
        allPrimeAttempts: [{ ok: true, skipped: false, label: 'stub-prime', status: 0, stderr: '', error: null }],
      }),
    },
  });

  assert.equal(result.mode, 'self-heal');
  assert.deepEqual(result.allEvents, []);
  assert.deepEqual(result.missingAfterGather, [ticker]);
  assert.equal(result.loadedAfterGather.length, 0);
});

test('CLI --only dry-run uses local artifacts before live discovery and builds a v2 preview', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mentions-cli-only-'));
  const date = '2099-01-06';
  const ticker = 'KXLOCALMENTION-99JAN06';
  const eventDir = join(stateRoot, 'mentions', date, 'kalshi-events');
  mkdirSync(eventDir, { recursive: true });
  writeFileSync(join(eventDir, `${ticker}.json`), `${JSON.stringify({
    event_ticker: ticker,
    title: 'What will Local Speaker say?',
    sub_title: 'Local fixture',
    series_ticker: 'KXLOCALMENTION',
    markets: [{
      ticker: `${ticker}-TEST`,
      title: 'What will Local Speaker say?',
      yes_sub_title: 'Test',
      custom_strike: { Word: 'Test' },
      yes_bid_dollars: '0.00',
      yes_ask_dollars: '1.00',
      rules_primary: 'If Local Speaker says Test, resolves Yes.',
      mention_profile: 'political_mentions',
      layer_records: {
        event_proximity: { present: true, score: 20, source_basis: 'local fixture schedule' },
      },
    }],
  })}\n`);

  const resolved = await resolveOnlyMentionEvents({
    stateRoot,
    date,
    tickers: [ticker],
    runStartedAtUtc: new Date().toISOString(),
  });
  assert.equal(resolved.mode, 'fast-path');
  assert.deepEqual(resolved.allEvents.map((e) => e.event_ticker), [ticker]);
  assert.equal(resolved.discovery.source.label, 'local-only-artifact-fast-path');
  const packetDir = join(stateRoot, 'packets', date, 'mentions-daily');

  const audit = (dir, name, text) => ({
    txtPath: join(dir, `${name}.txt`),
    metaPath: join(dir, `${name}.meta.json`),
    chunkCount: text.length > 0 ? 1 : 0,
  });
  const built = await writeKalshiEventPackets({
    events: resolved.allEvents,
    date,
    stateRoot,
    dir: packetDir,
    audit,
    dryRun: true,
    allPrimeAttempts: resolved.allPrimeAttempts,
    runStartedAtUtc: new Date().toISOString(),
  });

  assert.equal(built.failedTickers.length, 0);
  assert.equal(existsSync(packetDir), false, 'dry-run must not create deliverable packet artifacts');
  assert.ok(existsSync(join(eventDir, `${ticker}.json`)), 'local artifact remains in place for the fast path');
  assert.ok(built.items.some((item) => item.name === ticker && typeof item.previewText === 'string' && item.previewText.length > 0), 'dry-run builds a preview payload for the requested ticker');
  const previewText = built.items.find((item) => item.name === ticker)?.previewText ?? '';
  assert.match(previewText, /2\. TOP YES CASE[\s\S]*5\. SOURCE GAPS[\s\S]*8\. FULL STRIKE INVENTORY/, 'preview uses the stacked card / sectioned packet format');
  assert.doesNotMatch(previewText, /RANKED BOARD|TOP RESEARCHED TERMS|CPC COMPOSITE BOARD/i);
});
