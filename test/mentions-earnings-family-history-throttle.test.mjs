// Earnings family-history scan must survive Kalshi 429 rate-limiting: it spaces
// requests and retries throttled pages with backoff instead of failing closed on
// the first 429. Uses a fake fetch + injected sleep so the test is instant.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { fetchEarningsFamilyHistory } from '../scripts/mentions/earnings-family-history.mjs';

function res(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('429 on first attempt is retried with backoff, then succeeds', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'efh-'));
  const sleeps = [];
  const sleepImpl = async (ms) => { sleeps.push(ms); };
  let seriesCalls = 0;
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('/series')) {
      seriesCalls += 1;
      if (seriesCalls === 1) return res(429, {}); // throttled once
      return res(200, { series: [{ ticker: 'KXEARNINGSMENTIONJNJ' }], cursor: '' });
    }
    if (u.includes('/events')) {
      return res(200, {
        events: [{ markets: [{ result: 'yes', yes_sub_title: 'China' }, { result: 'no', yes_sub_title: 'China' }] }],
        cursor: '',
      });
    }
    return res(200, {});
  };

  const r = await fetchEarningsFamilyHistory({
    fetchImpl, stateRoot, spacingMs: 0, backoffMs: 10, maxRetries: 4, sleepImpl, now: () => 0,
  });

  assert.equal(r.scan_ok, true, `scan should recover from 429; error=${r.error}`);
  assert.equal(seriesCalls, 2, 'the throttled /series page is retried exactly once');
  assert.ok(sleeps.includes(10), 'backoff sleep was applied on the 429');
  assert.equal(r.by_word.china.n, 2);
  assert.equal(r.by_word.china.hits, 1);
  await fs.rm(stateRoot, { recursive: true, force: true });
});

test('persistent 429 beyond retry budget fails closed (scan_ok=false), never throws', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'efh-'));
  const fetchImpl = async () => res(429, {});
  const r = await fetchEarningsFamilyHistory({
    fetchImpl, stateRoot, spacingMs: 0, backoffMs: 1, maxRetries: 2, sleepImpl: async () => {}, now: () => 0,
  });
  assert.equal(r.scan_ok, false);
  assert.match(String(r.error), /429/);
  await fs.rm(stateRoot, { recursive: true, force: true });
});
