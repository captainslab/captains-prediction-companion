// Tests that the scraper-first mentions watcher cannot hang on a stalled
// discovery source. Each of the three current sources — the calendar board
// scrape+/series scan (discoverMentionEvents), the broad language API scan
// (fetchKalshiEvents 'broad'), and the local Alpha intake — runs under a
// per-source wall-clock deadline with an AbortSignal; a hung or erroring source
// is skipped (degraded) while the other sources' results still flow through, and
// a discovery-status artifact records the degraded outcome. No Telegram send.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { watch, ledgerPath } from '../scripts/mentions/mentions-watch.mjs';

const DATE = '2026-06-11';
// A mention-bearing event: the market title carries explicit "will ... say"
// language so it survives filterMentionEvents inside discovery.
const ev = (ticker) => ({
  event_ticker: ticker,
  title: ticker,
  markets: [{ ticker: `${ticker}-T1`, title: 'Will Powell say inflation?', yes_sub_title: 'inflation' }],
});

// Healthy stubs for the two sources not under test in a given case.
const okScraper = async () => ({ events: [], sources: { scrape: { ok: true }, series: { ok: true } } });
const okBroad = async () => ({ ok: true, events: [] });
const okAlpha = async () => ({ events: [], summary: {} });

test('a hung discovery source is bounded and skipped without hanging; other sources survive', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mentions-watch-timeout-'));

  // The scraper source never resolves (simulates an upstream hang). It must be
  // aborted at the per-source deadline rather than stalling the whole run.
  const hangingScraper = () => new Promise(() => {});

  const started = Date.now();
  const result = await watch({
    date: DATE,
    stateRoot: root,
    dryRun: true,
    env: {},
    discovery: {
      timeoutMs: 80, // tiny per-source budget for a fast test
      partialGraceMs: 50,
      discoverMentionEvents: hangingScraper,
      // broad scan returns a fresh today event — proves survivors flow through
      fetchKalshiEvents: async () => ({ ok: true, events: [ev('KXHEARINGMENTION-26JUN11')] }),
      collectAlphaMentionIntake: okAlpha,
    },
  });
  const elapsed = Date.now() - started;

  // The run must finish well under any cron limit despite the hanging source.
  assert.ok(elapsed < 5000, `run should not hang (took ${elapsed}ms)`);

  // The surviving broad source still yields its fresh today event.
  assert.deepEqual(result.attempted.map((e) => e.event_ticker), ['KXHEARINGMENTION-26JUN11']);

  // Discovery is flagged degraded and a status artifact is written.
  assert.equal(result.discovery.degraded, true);
  const scraper = result.discovery.sources.find((s) => s.label === 'scraper-board');
  assert.equal(scraper.status, 'timeout');
  assert.ok(scraper.ms >= 0 && Number.isFinite(scraper.ms), 'timeout source records elapsed ms');
  assert.match(scraper.error, /timed out/);
  const statusPath = join(root, 'mentions', DATE, 'discovery-status.json');
  assert.ok(existsSync(statusPath), 'degraded discovery-status artifact must exist');
  const status = JSON.parse(readFileSync(statusPath, 'utf8'));
  assert.equal(status.degraded, true);
  const rec = status.sources.find((s) => s.source === 'scraper-board');
  assert.equal(rec.status, 'timeout');
  assert.ok('ms' in rec && 'error' in rec, 'artifact records label, status, ms, error');
});

test('an erroring discovery source is skipped (degraded) while others continue', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mentions-watch-error-'));
  const result = await watch({
    date: DATE,
    stateRoot: root,
    dryRun: true,
    env: {},
    discovery: {
      timeoutMs: 500,
      discoverMentionEvents: okScraper,
      fetchKalshiEvents: async () => { throw new Error('kalshi 503'); },
      // alpha yields the surviving fresh today event
      collectAlphaMentionIntake: async () => ({ events: [ev('KXHEARINGMENTION-26JUN11')], summary: {} }),
    },
  });
  assert.deepEqual(result.attempted.map((e) => e.event_ticker), ['KXHEARINGMENTION-26JUN11']);
  assert.equal(result.discovery.degraded, true);
  const broad = result.discovery.sources.find((s) => s.label === 'kalshi-broad');
  assert.equal(broad.status, 'error');
  assert.match(broad.error, /kalshi 503/);
  // The other two sources stayed healthy.
  assert.equal(result.discovery.sources.find((s) => s.label === 'scraper-board').status, 'ok');
  assert.equal(result.discovery.sources.find((s) => s.label === 'alpha-intake').status, 'ok');
});

test('a falsy discovery rejection is recorded as an error and written to the artifact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mentions-watch-falsy-error-'));
  const result = await watch({
    date: DATE,
    stateRoot: root,
    dryRun: true,
    env: {},
    discovery: {
      timeoutMs: 500,
      discoverMentionEvents: okScraper,
      fetchKalshiEvents: async () => { throw null; },
      collectAlphaMentionIntake: okAlpha,
    },
  });

  const broad = result.discovery.sources.find((source) => source.label === 'kalshi-broad');
  assert.equal(broad.status, 'error');
  assert.equal(broad.events.length, 0);
  assert.ok(typeof broad.error === 'string' && broad.error.length > 0);
  assert.equal(result.discovery.degraded, true);

  const statusPath = join(root, 'mentions', DATE, 'discovery-status.json');
  const status = JSON.parse(readFileSync(statusPath, 'utf8'));
  const record = status.sources.find((source) => source.source === 'kalshi-broad');
  assert.equal(record.status, 'error');
  assert.equal(record.error, broad.error);
  assert.equal(status.degraded, true);
});

test('all-healthy discovery is not flagged degraded and writes no degraded artifact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mentions-watch-healthy-'));
  const result = await watch({
    date: DATE,
    stateRoot: root,
    dryRun: true,
    env: {},
    discovery: {
      timeoutMs: 500,
      discoverMentionEvents: okScraper,
      fetchKalshiEvents: okBroad,
      collectAlphaMentionIntake: okAlpha,
    },
  });
  assert.equal(result.discovery.degraded, false);
  assert.equal(result.discovery.sources.length, 3);
  assert.ok(result.discovery.sources.every((s) => s.status === 'ok'));
  assert.ok(!existsSync(join(root, 'mentions', DATE, 'discovery-status.json')));
  assert.ok(!existsSync(ledgerPath(root, DATE)), 'no-event healthy run stays quiet');
});

test('a timed-out source keeps events returned during the partial grace window', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mentions-watch-partial-'));
  const partialEvent = ev('KXHEARINGMENTION-26JUN11');
  const delayedScraper = () => new Promise((resolve) => {
    setTimeout(() => resolve({
      events: [partialEvent],
      sources: { scrape: { ok: true }, series: { ok: true } },
    }), 60);
  });

  const result = await watch({
    date: DATE,
    stateRoot: root,
    dryRun: true,
    env: {},
    discovery: {
      timeoutMs: 20,
      partialGraceMs: 100,
      discoverMentionEvents: delayedScraper,
      fetchKalshiEvents: okBroad,
      collectAlphaMentionIntake: okAlpha,
    },
  });

  assert.deepEqual(result.attempted.map((event) => event.event_ticker), [partialEvent.event_ticker]);
  assert.equal(result.discovery.degraded, true);
  const scraper = result.discovery.sources.find((source) => source.label === 'scraper-board');
  assert.equal(scraper.status, 'partial');
  assert.equal(scraper.events.length, 1);
  assert.equal(scraper.events[0].event_ticker, partialEvent.event_ticker);
  assert.match(scraper.error, /^partial: timed out after /);
  assert.match(scraper.error, /returned 1 events/);

  const statusPath = join(root, 'mentions', DATE, 'discovery-status.json');
  const status = JSON.parse(readFileSync(statusPath, 'utf8'));
  const record = status.sources.find((source) => source.source === 'scraper-board');
  assert.equal(record.status, 'partial');
  assert.equal(record.error, scraper.error);
});
