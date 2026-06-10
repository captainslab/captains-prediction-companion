import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectAlphaMentionIntake,
  formatAlphaIntakeSummary,
  getIntakePaths,
  loadManualQueue,
  loadRecentUrls,
  parseAlphaSeedUrls,
} from '../scripts/mentions/alpha-intake.mjs';

function makeEvent(eventTicker, title = `Will ${eventTicker} be mentioned?`) {
  return {
    event_ticker: eventTicker,
    title,
    series_ticker: eventTicker.split('-')[0],
    markets: [
      {
        ticker: `${eventTicker}-A`,
        title: `Will ${eventTicker} be mentioned?`,
        yes_sub_title: eventTicker,
        rules_primary: `If ${eventTicker} is mentioned, resolves Yes.`,
      },
    ],
  };
}

function makeFetch(eventsByTicker, calls) {
  return async (url) => {
    calls.push(url);
    const eventTicker = new URL(url).searchParams.get('event_ticker');
    const event = eventsByTicker[eventTicker];
    if (!event) {
      return {
        ok: false,
        status: 404,
        json: async () => ({ events: [] }),
        text: async () => '',
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ cursor: '', events: [event] }),
      text: async () => JSON.stringify({ cursor: '', events: [event] }),
    };
  };
}

function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

test('manual_queue entries are processed once, removed, and recorded as recent', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mentions-alpha-manual-'));
  const paths = getIntakePaths(stateRoot);
  const eventTicker = 'KXMANUAL-26JUN01';
  const event = makeEvent(eventTicker);
  writeJson(paths.manualQueuePath, {
    version: 1,
    items: [{ url: `https://kalshi.com/markets/${eventTicker}`, note: 'manual seed' }],
  });

  const calls = [];
  const fetchImpl = makeFetch({ [eventTicker]: event }, calls);

  const result = await collectAlphaMentionIntake({ stateRoot, env: {}, fetchImpl });
  assert.equal(result.events.length, 1);
  assert.equal(result.summary.manual_queue_offered, 1);
  assert.equal(result.summary.manual_queue_consumed, 1);
  assert.equal(result.summary.accepted, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /event_ticker=KXMANUAL-26JUN01/);

  assert.equal(loadManualQueue(stateRoot).length, 0, 'manual queue item was removed');
  const recent = loadRecentUrls(stateRoot);
  assert.equal(recent.length, 1, 'recent_urls captured the processed URL');
  assert.equal(recent[0].key, eventTicker);
  assert.equal(recent[0].status, 'processed');

  const secondPass = await collectAlphaMentionIntake({ stateRoot, env: {}, fetchImpl });
  assert.equal(secondPass.events.length, 0, 'processed URL is not reprocessed');
  assert.equal(calls.length, 1, 'dedupe prevented a second fetch');
});

test('recent_urls dedupe skips repeat manual intake and still clears the queue', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mentions-alpha-recent-'));
  const paths = getIntakePaths(stateRoot);
  const eventTicker = 'KXRECENT-26JUN02';
  writeJson(paths.manualQueuePath, {
    version: 1,
    items: [{ url: `https://kalshi.com/markets/${eventTicker}` }],
  });
  writeJson(paths.recentUrlsPath, {
    version: 1,
    items: [{ key: eventTicker, url: `https://kalshi.com/markets/${eventTicker}`, event_ticker: eventTicker, source: 'manual_queue', status: 'processed', seen_at: '2026-05-10T00:00:00.000Z' }],
  });

  const calls = [];
  const fetchImpl = makeFetch({ [eventTicker]: makeEvent(eventTicker) }, calls);
  const result = await collectAlphaMentionIntake({ stateRoot, env: {}, fetchImpl });

  assert.equal(result.events.length, 0, 'duplicate URL should not be fetched again');
  assert.equal(result.summary.skipped_recent, 1);
  assert.equal(result.summary.manual_queue_consumed, 1, 'duplicate manual queue entry still gets consumed');
  assert.equal(calls.length, 0, 'recent dedupe prevented the fetch');
  assert.equal(loadManualQueue(stateRoot).length, 0, 'duplicate entry removed from manual queue');
});

test('env seed parsing normalizes URLs and summary stays redacted', () => {
  const env = {
    CPC_MENTIONS_SEED_URLS: ' https://kalshi.com/markets/KXSEED-26JUN03?token=supersecret ,\nhttps://kalshi.com/events/KXSEED2-26JUN04#frag ',
  };
  const parsed = parseAlphaSeedUrls(env);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].event_ticker, 'KXSEED-26JUN03');
  assert.equal(parsed[0].resource_kind, 'market');
  assert.equal(parsed[0].canonical_url, 'https://kalshi.com/markets/KXSEED-26JUN03');
  assert.equal(parsed[1].event_ticker, 'KXSEED2-26JUN04');
  assert.equal(parsed[1].resource_kind, 'event');
  assert.equal(parsed[1].canonical_url, 'https://kalshi.com/events/KXSEED2-26JUN04');

  const summary = formatAlphaIntakeSummary({ env_seeds_offered: 2, env_seeds_consumed: 2, recent_cache_size: 0 });
  assert.match(summary, /env_seeds_offered=2/);
  assert.match(summary, /env_seeds_consumed=2/);
  assert.equal(summary.includes('supersecret'), false, 'secret query value is not printed');
  assert.equal(summary.includes('KXSEED-26JUN03?token=supersecret'), false, 'raw env seed URL is not printed');
});

test('fallback is only used when no manual queue or env seeds exist', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mentions-alpha-fallback-'));
  const fallbackEvent = makeEvent('KXFALLBACK-26JUN05');

  const seedCalls = [];
  const envSeedResult = await collectAlphaMentionIntake({
    stateRoot,
    env: { CPC_MENTIONS_SEED_URLS: 'https://kalshi.com/markets/KXENV-26JUN06' },
    fetchImpl: makeFetch({ 'KXENV-26JUN06': makeEvent('KXENV-26JUN06') }, seedCalls),
    fallbackEvents: [fallbackEvent],
  });
  assert.equal(envSeedResult.summary.fallback_used, false, 'explicit env intake blocks fallback');
  assert.equal(envSeedResult.events.length, 1);
  assert.equal(envSeedResult.events[0].event_ticker, 'KXENV-26JUN06');
  assert.equal(seedCalls.length, 1);

  const fallbackCalls = [];
  const fallbackResult = await collectAlphaMentionIntake({
    stateRoot,
    env: {},
    fetchImpl: makeFetch({}, fallbackCalls),
    fallbackEvents: [fallbackEvent],
  });
  assert.equal(fallbackResult.summary.fallback_used, true, 'fallback is used only when explicit intake is absent');
  assert.equal(fallbackResult.summary.fallback_emitted, 1);
  assert.equal(fallbackResult.events.length, 1);
  assert.equal(fallbackResult.events[0].event_ticker, 'KXFALLBACK-26JUN05');
  assert.equal(fallbackCalls.length, 0, 'fallback reuses the provided event instead of hitting the network');
});
