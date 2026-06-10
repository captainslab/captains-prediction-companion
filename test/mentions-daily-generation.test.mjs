import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatherMentionEvents } from '../scripts/packets/generate-mentions-daily.mjs';

function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function makeEvent(ticker) {
  return { event_ticker: ticker, title: `Will ${ticker} be mentioned?`, markets: [{ ticker: `${ticker}-A`, title: 'Yes' }] };
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
