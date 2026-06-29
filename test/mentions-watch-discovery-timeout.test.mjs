// Tests that the mentions watcher cannot hang on a stalled discovery source.
// Each discovery source (broad Kalshi, series scan, alpha intake) runs under a
// per-source wall-clock deadline with an AbortSignal; a hung source is skipped
// (degraded) while the other sources' results still flow through, and a
// discovery-status artifact records the degraded outcome. No Telegram send.

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

test('a hung discovery source is bounded and skipped without hanging; other sources survive', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mentions-watch-timeout-'));

  // broad source never resolves (simulates an upstream hang). It must be
  // aborted at the per-source deadline rather than stalling the whole run.
  const hangingBroad = () => new Promise(() => {});

  const started = Date.now();
  const result = await watch({
    date: DATE,
    stateRoot: root,
    dryRun: true,
    env: {},
    discovery: {
      timeoutMs: 80, // tiny per-source budget for a fast test
      fetchKalshiEvents: hangingBroad,
      // series scan returns a fresh today event — proves survivors flow through
      fetchMentionEventsBySeries: async () => ({ ok: true, events: [ev('KXHEARINGMENTION-26JUN11')] }),
      collectAlphaMentionIntake: async () => ({ events: [], summary: {} }),
    },
  });
  const elapsed = Date.now() - started;

  // The run must finish well under any cron limit despite the hanging source.
  assert.ok(elapsed < 5000, `run should not hang (took ${elapsed}ms)`);

  // The surviving series source still yields its fresh today event.
  assert.deepEqual(result.attempted.map((e) => e.event_ticker), ['KXHEARINGMENTION-26JUN11']);

  // Discovery is flagged degraded and a status artifact is written.
  assert.equal(result.discovery.degraded, true);
  const broad = result.discovery.sources.find((s) => s.label === 'kalshi-broad');
  assert.equal(broad.status, 'timeout');
  const statusPath = join(root, 'mentions', DATE, 'discovery-status.json');
  assert.ok(existsSync(statusPath), 'degraded discovery-status artifact must exist');
  const status = JSON.parse(readFileSync(statusPath, 'utf8'));
  assert.equal(status.degraded, true);
  assert.equal(status.sources.find((s) => s.source === 'kalshi-broad').status, 'timeout');
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
      fetchKalshiEvents: async () => { throw new Error('kalshi 503'); },
      fetchMentionEventsBySeries: async () => ({ ok: true, events: [ev('KXHEARINGMENTION-26JUN11')] }),
      collectAlphaMentionIntake: async () => ({ events: [], summary: {} }),
    },
  });
  assert.deepEqual(result.attempted.map((e) => e.event_ticker), ['KXHEARINGMENTION-26JUN11']);
  assert.equal(result.discovery.degraded, true);
  const broad = result.discovery.sources.find((s) => s.label === 'kalshi-broad');
  assert.equal(broad.status, 'error');
  assert.match(broad.error, /kalshi 503/);
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
      fetchKalshiEvents: async () => ({ ok: true, events: [] }),
      fetchMentionEventsBySeries: async () => ({ ok: true, events: [] }),
      collectAlphaMentionIntake: async () => ({ events: [], summary: {} }),
    },
  });
  assert.equal(result.discovery.degraded, false);
  assert.ok(!existsSync(join(root, 'mentions', DATE, 'discovery-status.json')));
  assert.ok(!existsSync(ledgerPath(root, DATE)), 'no-event healthy run stays quiet');
});
