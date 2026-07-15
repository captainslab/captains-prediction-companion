import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildKalshiEventPacket,
  gatherMentionEvents,
  mergeResearchIntoEvent,
  resolveOnlyMentionEvents,
  writeKalshiEventPackets,
} from '../scripts/packets/generate-mentions-daily.mjs';
import { persistEventArtifacts } from '../scripts/packets/lib/kalshi-discovery.mjs';
import { buildCanonicalMentionIdentity } from '../scripts/mentions/event-integrity.mjs';
import { renderMentionPacket } from '../scripts/mentions/render-mention-packet.mjs';

const REPO = resolve(import.meta.dirname, '..');

function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function makeEvent(ticker) {
  return {
    event_ticker: ticker,
    series_ticker: ticker.replace(/-[^-]+$/, ''),
    title: `Will ${ticker} be mentioned?`,
    event_url: `https://kalshi.com/events/${ticker}`,
    event_time_utc: '2099-01-01T18:00:00Z',
    settlement_source_link: 'https://example.com/official-event',
    research_timestamp: '2098-12-31T18:00:00Z',
    markets: [{ ticker: `${ticker}-A`, title: 'Yes' }],
  };
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
    event_url: `https://kalshi.com/events/${ticker}`,
    event_time_utc: '2099-01-06T18:00:00Z',
    settlement_source_link: 'https://example.com/local-official-event',
    research_timestamp: '2099-01-06T12:00:00Z',
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
  const builtItem = built.items.find((item) => item.name === ticker);
  const previewText = builtItem?.previewText ?? '';
  assert.match(previewText, /2\. TOP YES CASE[\s\S]*5\. SOURCE GAPS[\s\S]*8\. FULL STRIKE INVENTORY/, 'preview uses the stacked card / sectioned packet format');
  assert.doesNotMatch(previewText, /RANKED BOARD|TOP RESEARCHED TERMS|CPC COMPOSITE BOARD/i);
  assert.equal(builtItem?.attachmentContract?.entity_count, 1);
  assert.equal(builtItem?.attachmentContract?.attached_count, 0);
  assert.deepEqual(builtItem?.attachmentContract?.missing_entity_ids, [`${ticker}-TEST`]);
});

test('on-disk discovery artifacts round-trip through generation and rendering for earnings and World Cup announcer fixtures', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mentions-contract-roundtrip-'));
  const date = '2099-01-09';
  const generatedAt = new Date().toISOString();
  const earningsTicker = 'KXEARNINGSMENTIONNVDA-99JAN09';
  const sportsTicker = 'KXWORLDCUPMENTION-99JAN09';
  const fixtures = [
    {
      event_ticker: earningsTicker,
      series_ticker: 'KXEARNINGSMENTIONNVDA',
      title: 'What will NVIDIA say during their next earnings call?',
      event_url: `https://kalshi.com/events/${earningsTicker}`,
      event_time_utc: '2099-01-09T18:00:00Z',
      close_time: '2099-01-10T18:00:00Z',
      settlement_sources: [
        { name: 'generic fallback', url: 'https://example.com/fallback' },
        { name: 'SEC', url: 'https://www.sec.gov/Archives/edgar/data/1045810/fixture.htm' },
      ],
      declared_source_url: 'https://ir.nvidia.com/fixture',
      research_timestamp: generatedAt,
      markets: [
        {
          ticker: `${earningsTicker}-BLACK`,
          event_ticker: earningsTicker,
          title: 'What will NVIDIA say during their next earnings call?',
          yes_sub_title: 'Blackwell',
          custom_strike: { Word: 'Blackwell' },
          close_time: '2099-01-10T18:00:00Z',
          rules_primary: 'If NVIDIA says Blackwell during the earnings call, resolves Yes.',
          mention_profile: 'earnings_mentions',
        },
        {
          ticker: `${earningsTicker}-NQE`,
          event_ticker: earningsTicker,
          title: 'What will NVIDIA say during their next earnings call?',
          yes_sub_title: 'Event does not qualify',
          custom_strike: { Word: 'Event does not qualify' },
          close_time: '2099-01-10T18:00:00Z',
          rules_primary: 'If the earnings call does not occur, resolves Yes.',
          mention_profile: 'earnings_mentions',
        },
      ],
    },
    {
      event_ticker: sportsTicker,
      series_ticker: 'KXWORLDCUPMENTION',
      title: 'What will the soccer announcer say during the World Cup match?',
      event_url: `https://kalshi.com/events/${sportsTicker}`,
      close_time: '2099-01-10T20:00:00Z',
      settlement_sources: [{ name: 'broadcast fallback', url: 'https://example.com/world-cup' }],
      declared_source_url: null,
      research_timestamp: generatedAt,
      markets: [
        {
          ticker: `${sportsTicker}-GOAL`,
          event_ticker: sportsTicker,
          title: 'What will the soccer announcer say during the World Cup match?',
          yes_sub_title: 'goal',
          custom_strike: { Word: 'goal' },
          close_time: '2099-01-10T20:00:00Z',
          rules_primary: 'If the announcer says goal during the match, resolves Yes.',
          mention_profile: 'sports_announcer_mentions',
        },
        {
          ticker: `${sportsTicker}-NQE`,
          event_ticker: sportsTicker,
          title: 'What will the soccer announcer say during the World Cup match?',
          yes_sub_title: 'Event does not qualify',
          custom_strike: { Word: 'Event does not qualify' },
          close_time: '2099-01-10T20:00:00Z',
          rules_primary: 'If the match does not occur, resolves Yes.',
          mention_profile: 'sports_announcer_mentions',
        },
      ],
    },
  ];

  const persisted = persistEventArtifacts({ stateRoot, sport: 'mentions', date, events: fixtures });
  assert.equal(persisted.written.length, 2);
  for (const event of fixtures) {
    writeJson(join(stateRoot, 'mentions', date, 'research', `${event.event_ticker}.json`), {
      event_ticker: event.event_ticker,
      produced_at: generatedAt,
      declared_source_url: event.declared_source_url,
      source_status: 'SOURCE_FETCHED',
      markets: event.markets.map((market) => ({
        market_ticker: market.ticker,
        research_quality: 'source_backed',
        layer_records: {
          direct_mention_pathway: { present: true, score: 80, source_basis: 'fixture transcript' },
        },
      })),
    });
  }

  const resolved = await resolveOnlyMentionEvents({
    stateRoot,
    date,
    tickers: fixtures.map((event) => event.event_ticker),
    runStartedAtUtc: generatedAt,
  });
  assert.equal(resolved.mode, 'fast-path');

  const renderedByTicker = new Map();
  for (const event of resolved.allEvents) {
    const eventPath = join(stateRoot, 'mentions', date, 'kalshi-events', `${event.event_ticker}.json`);
    const research = JSON.parse(readFileSync(join(stateRoot, 'mentions', date, 'research', `${event.event_ticker}.json`), 'utf8'));
    const merged = mergeResearchIntoEvent(JSON.parse(readFileSync(eventPath, 'utf8')), research);
    const built = buildKalshiEventPacket({ date, event: merged, sourceUrl: eventPath, generatedUtc: generatedAt });
    const rendered = renderMentionPacket(built.synthesisInput, { generatedAtUtc: generatedAt });
    renderedByTicker.set(event.event_ticker, { built, rendered });
  }

  const earnings = renderedByTicker.get(earningsTicker);
  assert.match(earnings.rendered, /declared_source_url: https:\/\/ir\.nvidia\.com\/fixture/);
  assert.match(earnings.rendered, /settlement_source: https:\/\/www\.sec\.gov\//);
  assert.doesNotMatch(earnings.rendered, /settlement_source: https:\/\/example\.com\/fallback/);
  assert.match(earnings.rendered, /event_time_central: Jan 09, 2099/);
  assert.match(earnings.rendered, /Event does not qualify/);

  const sports = renderedByTicker.get(sportsTicker);
  assert.match(sports.rendered, /declared_source_url: UNAVAILABLE/);
  assert.match(sports.rendered, /event_time_central: UNCONFIRMED/);
  assert.equal(sports.built.synthesisInput.presentation.event_time_iso, null);
  assert.match(sports.rendered, /Event does not qualify/);
  assert.doesNotMatch(sports.rendered, /Event does not qualify[\s\S]{0,160}CPC YES SCORE:/);
});

test('real-shaped Kalshi event artifacts canonicalize event URLs and retain stale research timestamps', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mentions-canonical-boundary-'));
  const date = '2099-01-15';
  const ticker = 'KXEARNINGSMENTIONPGR-99JAN15';
  const canonicalUrl = `https://kalshi.com/events/${ticker}`;
  const rawEvent = {
    event_ticker: ticker,
    title: 'What will P&G say during its next earnings call?',
    sub_title: 'P&G earnings mention',
    series_ticker: 'KXEARNINGSMENTIONPGR',
    settlement_sources: [{ name: 'P&G investor relations', url: 'https://us.pg.com/annual-report/' }],
    event_time_utc: '2099-01-15T18:00:00Z',
    markets: [{ ticker: `${ticker}-INFLATION`, title: 'inflation' }],
  };

  const persisted = persistEventArtifacts({ stateRoot, sport: 'mentions', date, events: [rawEvent] });
  const eventPath = persisted.written[0].path;
  const persistedEvent = JSON.parse(readFileSync(eventPath, 'utf8'));
  assert.equal(persistedEvent.event_url, canonicalUrl);

  // Recreate a pre-fix cache artifact: the loader must backfill at read time.
  delete persistedEvent.event_url;
  writeJson(eventPath, persistedEvent);
  const resolved = await resolveOnlyMentionEvents({
    stateRoot,
    date,
    tickers: [ticker],
  });
  assert.equal(resolved.allEvents[0].event_url, canonicalUrl);
  const identity = buildCanonicalMentionIdentity({
    date,
    event: resolved.allEvents[0],
    generatedUtc: '2099-01-15T19:00:00Z',
    researchTimestamp: '2099-01-15T17:00:00Z',
  });
  assert.equal(identity.kalshi_event_url, canonicalUrl);
  assert.notEqual(identity.kalshi_event_url, identity.settlement_source);

  const producedAt = '2099-01-15T17:30:00Z';
  const staleMerged = mergeResearchIntoEvent(rawEvent, {
    produced_at: producedAt,
    declared_source_url: 'https://us.pg.com/annual-report/',
    markets: [{ market_ticker: `${ticker}-INFLATION` }],
  }, { staleResearch: true });
  assert.equal(staleMerged.research_timestamp, producedAt);
  assert.equal(staleMerged.declared_source_url, 'https://us.pg.com/annual-report/');
});
