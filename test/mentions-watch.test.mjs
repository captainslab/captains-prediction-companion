// Tests for the today-only incremental mentions watcher and the generator's
// today-only default / watchlist isolation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  selectNewTodayEvents,
  loadLedger,
  saveLedger,
  ledgerPath,
  watch,
  DEFAULT_MAX_NEW_PER_RUN,
} from '../scripts/mentions/mentions-watch.mjs';
import {
  parseExtraArgs,
  DEFAULT_WINDOW_DAYS,
  WATCHLIST_WINDOW_DAYS,
  WATCHLIST_PACKET_TYPE,
} from '../scripts/packets/generate-mentions-daily.mjs';

const DATE = '2026-06-11';
const ev = (ticker) => ({ event_ticker: ticker, title: ticker, markets: [{ ticker: `${ticker}-T1` }] });

// Simulate the real generator: write the expected packet .txt for the --only ticker.
function fakeGeneratorWrite(root, args) {
  const ticker = args[args.indexOf('--only') + 1];
  const dir = join(root, 'packets', DATE, 'mentions-daily');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${DATE}-${ticker}.txt`), `packet for ${ticker}\n`);
}

function fakeSenderWrite(root, args) {
  const stem = args[args.indexOf('--only') + 1];
  const dir = join(root, 'packets', DATE, 'mentions-daily');
  mkdirSync(dir, { recursive: true });
  const ledgerPath = join(dir, '.delivery-ledger.json');
  const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : { delivered: {} };
  ledger.delivered[stem] = { utc: '2026-06-11T12:00:00Z', message_ids: [1, 2] };
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
}

// ─── today-only filter ───────────────────────────────────────────────────────

test('today-only filter keeps same-day tickers and excludes future/past/undated', () => {
  const ledger = { events: {} };
  const { fresh, deferred } = selectNewTodayEvents([
    ev('KXHEARINGMENTION-26JUN11'),
    ev('KXFOXNEWSMENTION-26JUN12'),
    ev('KXNBAMENTION-26JUN13NYKSAS'),
    ev('KXSTARMERMENTIONB-26JUN10'),
    ev('KXUNDATEDMENTION'),
  ], ledger, DATE);
  assert.deepEqual(fresh.map(e => e.event_ticker), ['KXHEARINGMENTION-26JUN11']);
  assert.deepEqual(
    deferred.map(e => e.event_ticker).sort(),
    ['KXFOXNEWSMENTION-26JUN12', 'KXNBAMENTION-26JUN13NYKSAS', 'KXSTARMERMENTIONB-26JUN10', 'KXUNDATEDMENTION'],
  );
});

test('delivered_at, mark-seen-only, and held entries are seen while blocked entries are retryable', () => {
  const ledger = {
    events: {
      'KXDELIVEREDMENTION-26JUN11': { delivered_at: '2026-06-11T12:00:00Z', status: 'delivered' },
      'KXMARKSEENMENTION-26JUN11': { status: 'mark-seen-only', delivered_at: null },
      'KXHELDMENTION-26JUN11': { status: 'held', delivered_at: null },
      'KXBLOCKEDMENTION-26JUN11': { status: 'blocked', delivered_at: null, attempts: 1 },
    },
  };
  const { fresh, seen } = selectNewTodayEvents([
    ev('KXDELIVEREDMENTION-26JUN11'),
    ev('KXMARKSEENMENTION-26JUN11'),
    ev('KXHELDMENTION-26JUN11'),
    ev('KXBLOCKEDMENTION-26JUN11'),
    ev('KXFRESHMENTION-26JUN11'),
    ev('KXBLOCKEDMENTION-26JUN11'),
  ], ledger, DATE);
  assert.deepEqual(fresh.map(e => e.event_ticker), ['KXFRESHMENTION-26JUN11']);
  assert.deepEqual(seen.map(e => e.event_ticker).sort(), [
    'KXDELIVEREDMENTION-26JUN11',
    'KXHELDMENTION-26JUN11',
    'KXMARKSEENMENTION-26JUN11',
  ]);
  assert.deepEqual(ledger.events['KXBLOCKEDMENTION-26JUN11'].status, 'blocked');
});

test('seen/retryable split keeps duplicates stable for retryable ledger entries', () => {
  const ledger = {
    events: {
      'KXRETRYMENTION-26JUN11': { status: 'pending', delivered_at: null, attempts: 1 },
    },
  };
  const { retryable } = selectNewTodayEvents([
    ev('KXRETRYMENTION-26JUN11'),
    ev('KXRETRYMENTION-26JUN11'),
  ], ledger, DATE);
  assert.deepEqual(retryable.map(e => e.event_ticker), ['KXRETRYMENTION-26JUN11']);
});

// ─── generator defaults / watchlist isolation ────────────────────────────────

test('default cron path is today-only, not a 7-day window', () => {
  assert.equal(DEFAULT_WINDOW_DAYS, 0);
  const { extra } = parseExtraArgs(['--date', DATE]);
  assert.equal(extra.windowDays, 0);
  assert.equal(extra.watchlist, false);
});

test('explicit watchlist mode scans 7 days but routes to the watchlist packet dir', () => {
  const { extra } = parseExtraArgs(['--watchlist']);
  assert.equal(extra.windowDays, WATCHLIST_WINDOW_DAYS);
  assert.equal(extra.watchlist, true);
  // Any forward window is watchlist scope — the cron sender reads only
  // mentions-daily/, so watchlist output can never auto-send.
  const wide = parseExtraArgs(['--window-days', '7']);
  assert.equal(wide.extra.watchlist, true);
  assert.equal(WATCHLIST_PACKET_TYPE, 'mentions-watchlist');
});

test('--only parses ticker list for incremental generation', () => {
  const { extra } = parseExtraArgs(['--only', 'KXA-26JUN11, KXB-26JUN11']);
  assert.deepEqual(extra.only, ['KXA-26JUN11', 'KXB-26JUN11']);
});

// ─── watcher end-to-end via --events-file (no network, no sends) ─────────────

test('no-event run exits 0 quietly with only a local log line', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mentions-watch-test-'));
  const eventsFile = join(root, 'events.json');
  writeFileSync(eventsFile, JSON.stringify([ev('KXFUTUREMENTION-26JUN13')]));
  const result = await watch({
    date: DATE,
    stateRoot: root,
    eventsFile,
    env: {},
  });
  assert.deepEqual(result.fresh, []);
  assert.deepEqual(result.retryable, []);
  assert.deepEqual(result.seen, []);
  assert.deepEqual(result.deferred.map((e) => e.event_ticker), ['KXFUTUREMENTION-26JUN13']);
  assert.ok(!existsSync(ledgerPath(root, DATE)), 'quiet run must not create a ledger');
});

test('new today event is planned once and duplicate run is skipped by ledger', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mentions-watch-test-'));
  const eventsFile = join(root, 'events.json');
  writeFileSync(eventsFile, JSON.stringify([ev('KXHEARINGMENTION-26JUN11'), ev('KXLATERMENTION-26JUN12')]));

  const dry = await watch({
    date: DATE,
    stateRoot: root,
    eventsFile,
    dryRun: true,
    env: {},
  });
  assert.deepEqual(dry.attempted.map((e) => e.event_ticker), ['KXHEARINGMENTION-26JUN11']);
  assert.deepEqual(dry.retryable, []);

  // mark-seen-only records it durably without delivering
  const seed = await watch({
    date: DATE,
    stateRoot: root,
    eventsFile,
    markSeenOnly: true,
    env: {},
  });
  assert.deepEqual(seed.fresh.map((e) => e.event_ticker), ['KXHEARINGMENTION-26JUN11']);
  const ledger = loadLedger(ledgerPath(root, DATE));
  const rec = ledger.events['KXHEARINGMENTION-26JUN11'];
  assert.ok(rec, 'ledger entry written');
  assert.equal(rec.event_date, DATE);
  assert.equal(rec.delivered_at, null);
  assert.equal(rec.idempotency_key, `mentions:${DATE}:KXHEARINGMENTION-26JUN11`);
  assert.ok(!ledger.events['KXLATERMENTION-26JUN12'], 'future event never enters the seen ledger');

  // second run: same event is now seen -> quiet exit, nothing planned
  const again = await watch({
    date: DATE,
    stateRoot: root,
    eventsFile,
    dryRun: true,
    env: {},
  });
  assert.deepEqual(again.fresh, []);
  assert.deepEqual(again.seen.map((e) => e.event_ticker), ['KXHEARINGMENTION-26JUN11']);
});

test('watch hands sender exact packet stems and excludes future tickers from the send path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mentions-watch-command-'));
  const eventsFile = join(root, 'events.json');
  writeFileSync(eventsFile, JSON.stringify([
    ev('KXHEARINGMENTION-26JUN11'),
    ev('KXHEARINGMENTION-26JUN12'),
    ev('KXHEARINGMENTION-26JUN13'),
    ev('KXHEARINGMENTION-26JUN14'),
  ]));

  const calls = [];
  await watch({
    date: DATE,
    stateRoot: root,
    eventsFile,
    runStepImpl: (label, command, args) => {
      calls.push({ label, command, args });
      if (label.startsWith('generator:')) fakeGeneratorWrite(root, args);
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(calls.length, 2, 'watch should invoke generator and sender exactly once each');
  assert.deepEqual(calls[0].args.slice(-2), ['--only', 'KXHEARINGMENTION-26JUN11'], 'generator must receive the fresh today ticker only');
  assert.deepEqual(calls[1].args.slice(-2), ['--only', '2026-06-11-KXHEARINGMENTION-26JUN11'], 'sender must receive the exact packet stem only');
  assert.ok(!calls[1].args.join(' ').includes('26JUN12'));
  assert.ok(!calls[1].args.join(' ').includes('26JUN13'));
  assert.ok(!calls[1].args.join(' ').includes('26JUN14'));
});

test('retry batch respects max retry per run and attempts cap moves exhausted entries to held', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mentions-watch-retry-'));
  const eventsFile = join(root, 'events.json');
  writeFileSync(eventsFile, JSON.stringify([
    ev('KXFRESHMENTION-26JUN11'),
    ev('KXRETRYONCE-26JUN11'),
    ev('KXRETRYWAIT-26JUN11'),
  ]));

  const ledgerDir = join(root, 'mentions', DATE);
  mkdirSync(ledgerDir, { recursive: true });
  writeFileSync(ledgerPath(root, DATE), JSON.stringify({
    events: {
      'KXRETRYONCE-26JUN11': { status: 'blocked', delivered_at: null, attempts: 2, first_seen_utc: '2026-06-11T00:00:00Z' },
      'KXRETRYWAIT-26JUN11': { status: 'blocked', delivered_at: null, attempts: 1, first_seen_utc: '2026-06-11T00:00:00Z' },
    },
  }, null, 2));

  const calls = [];
  const result = await watch({
    date: DATE,
    stateRoot: root,
    eventsFile,
    env: {
      ...process.env,
      MENTIONS_WATCH_MAX_NEW_PER_RUN: '1',
      MENTIONS_WATCH_MAX_RETRY_PER_RUN: '1',
      MENTIONS_WATCH_MAX_RETRY_ATTEMPTS: '3',
    },
    runStepImpl: (label, command, args) => {
      calls.push(label);
      if (label === 'generator:KXFRESHMENTION-26JUN11') fakeGeneratorWrite(root, args);
      if (label === 'sender:KXFRESHMENTION-26JUN11') fakeSenderWrite(root, args);
      if (label === 'generator:KXRETRYONCE-26JUN11') throw new Error('packet synthesis blocked');
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  assert.deepEqual(result.attempted.map(e => e.event_ticker), ['KXFRESHMENTION-26JUN11']);
  assert.deepEqual(result.retried.map(e => e.event_ticker), ['KXRETRYONCE-26JUN11']);
  assert.deepEqual(result.retryQueued.map(e => e.event_ticker), ['KXRETRYWAIT-26JUN11']);
  assert.ok(calls.includes('generator:KXFRESHMENTION-26JUN11'));
  assert.ok(calls.includes('sender:KXFRESHMENTION-26JUN11'));
  assert.ok(calls.includes('generator:KXRETRYONCE-26JUN11'));
  assert.ok(!calls.includes('generator:KXRETRYWAIT-26JUN11'));

  const ledger = loadLedger(ledgerPath(root, DATE));
  assert.equal(ledger.events['KXRETRYONCE-26JUN11'].status, 'held');
  assert.equal(ledger.events['KXRETRYONCE-26JUN11'].attempts, 3);
  assert.match(ledger.events['KXRETRYONCE-26JUN11'].held_reason, /attempts 3 reached max 3/);
  assert.equal(ledger.events['KXRETRYWAIT-26JUN11'].status, 'blocked');
});

test('delivered_at prevents resend and regeneration for ledgered events', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mentions-watch-delivered-'));
  const eventsFile = join(root, 'events.json');
  writeFileSync(eventsFile, JSON.stringify([ev('KXDELIVEREDONCE-26JUN11')]));
  mkdirSync(join(root, 'mentions', DATE), { recursive: true });
  writeFileSync(ledgerPath(root, DATE), JSON.stringify({
    events: {
      'KXDELIVEREDONCE-26JUN11': {
        status: 'blocked',
        delivered_at: '2026-06-11T12:00:00Z',
        attempts: 2,
        first_seen_utc: '2026-06-11T00:00:00Z',
      },
    },
  }, null, 2));

  const calls = [];
  const result = await watch({
    date: DATE,
    stateRoot: root,
    eventsFile,
    runStepImpl: (label, command, args) => {
      calls.push({ label, command, args });
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  assert.deepEqual(result.seen.map(e => e.event_ticker), ['KXDELIVEREDONCE-26JUN11']);
  assert.equal(result.attempted.length, 0);
  assert.equal(result.retried.length, 0);
  assert.equal(calls.length, 0);
});

// ─── per-event isolation, blocker artifacts, throttle ────────────────────────

test('one failed event does not abort remaining events; blocker written; failure not delivered', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mentions-watch-isolation-'));
  const eventsFile = join(root, 'events.json');
  writeFileSync(eventsFile, JSON.stringify([
    ev('KXAMENTION-26JUN11'),
    ev('KXBADMENTION-26JUN11'),
    ev('KXCMENTION-26JUN11'),
  ]));

  const calls = [];
  const result = await watch({
    date: DATE,
    stateRoot: root,
    eventsFile,
    runStepImpl: (label, command, args) => {
      calls.push(label);
      if (label === 'generator:KXBADMENTION-26JUN11') {
        throw new Error('Hermes packet omitted full strike text: What will Hunter Biden say? -- Event does not qualify');
      }
      if (label.startsWith('generator:')) fakeGeneratorWrite(root, args);
      return { status: 0 };
    },
  });

  // run continued past the failure and processed all three events
  assert.deepEqual(result.succeeded.sort(), ['KXAMENTION-26JUN11', 'KXCMENTION-26JUN11']);
  assert.deepEqual(result.failed, ['KXBADMENTION-26JUN11']);
  // sender invoked exactly once per SUCCESSFUL event, never for the failed one
  assert.ok(calls.includes('sender:KXAMENTION-26JUN11'));
  assert.ok(calls.includes('sender:KXCMENTION-26JUN11'));
  assert.ok(!calls.includes('sender:KXBADMENTION-26JUN11'), 'failed event must not be sent');

  const ledger = loadLedger(ledgerPath(root, DATE));
  const bad = ledger.events['KXBADMENTION-26JUN11'];
  assert.equal(bad.status, 'blocked');
  assert.equal(bad.delivered_at, null, 'failed event must not be marked delivered');
  assert.ok(bad.blocker_path && existsSync(bad.blocker_path), 'blocker artifact must exist');
  const blocker = JSON.parse(readFileSync(bad.blocker_path, 'utf8'));
  assert.equal(blocker.delivered, false);
  assert.match(blocker.error, /Event does not qualify/);
  assert.equal(ledger.events['KXAMENTION-26JUN11'].status, 'delivered');
});

test('generator failure with missing packet .txt blocks the event instead of sending', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mentions-watch-nopacket-'));
  const eventsFile = join(root, 'events.json');
  writeFileSync(eventsFile, JSON.stringify([ev('KXNOPKTMENTION-26JUN11')]));

  const calls = [];
  const result = await watch({
    date: DATE,
    stateRoot: root,
    eventsFile,
    // generator "succeeds" (exit 0, per-event isolation inside it) but writes
    // no .txt because synthesis was blocked — watcher must treat as failure.
    runStepImpl: (label) => { calls.push(label); return { status: 0 }; },
  });
  assert.deepEqual(result.failed, ['KXNOPKTMENTION-26JUN11']);
  assert.ok(!calls.some(c => c.startsWith('sender:')), 'no send without a packet .txt');
});

test('max-new-events throttle limits a 14-event batch and leaves the rest unseen for next run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mentions-watch-throttle-'));
  const eventsFile = join(root, 'events.json');
  const tickers = Array.from({ length: 14 }, (_, i) => `KXBATCH${String(i).padStart(2, '0')}MENTION-26JUN11`);
  writeFileSync(eventsFile, JSON.stringify(tickers.map(ev)));

  const run = () => watch({
    date: DATE,
    stateRoot: root,
    eventsFile,
    env: { ...process.env, MENTIONS_WATCH_MAX_NEW_PER_RUN: '3' },
    runStepImpl: (label, command, args) => {
      if (label.startsWith('generator:')) fakeGeneratorWrite(root, args);
      return { status: 0 };
    },
  });

  const first = await run();
  assert.equal(first.attempted.length, 3);
  assert.equal(first.queued.length, 11);
  const ledger1 = loadLedger(ledgerPath(root, DATE));
  assert.equal(Object.keys(ledger1.events).length, 3, 'queued events stay out of the seen ledger');

  // next run picks up the next slice — no event lost, no event doubled
  const second = await run();
  assert.equal(second.attempted.length, 3);
  assert.equal(second.queued.length, 8);
  const ledger2 = loadLedger(ledgerPath(root, DATE));
  assert.equal(Object.keys(ledger2.events).length, 6);
  assert.deepEqual(
    second.attempted.map(e => e.event_ticker).filter(t => first.attempted.some(f => f.event_ticker === t)),
    [], 'second run must not re-attempt first-run events',
  );
});

test('throttle default applies without env override', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mentions-watch-throttle-default-'));
  const eventsFile = join(root, 'events.json');
  const tickers = Array.from({ length: 14 }, (_, i) => `KXDFLT${String(i).padStart(2, '0')}MENTION-26JUN11`);
  writeFileSync(eventsFile, JSON.stringify(tickers.map(ev)));
  const result = await watch({
    date: DATE,
    stateRoot: root,
    eventsFile,
    dryRun: true,
    env: { ...process.env, MENTIONS_WATCH_MAX_NEW_PER_RUN: '' },
  });
  assert.equal(result.attempted.length, DEFAULT_MAX_NEW_PER_RUN);
  assert.equal(result.queued.length, 14 - DEFAULT_MAX_NEW_PER_RUN);
});

test('ledger round-trips the stable keys', () => {
  const root = mkdtempSync(join(tmpdir(), 'mentions-watch-ledger-'));
  const path = ledgerPath(root, DATE);
  saveLedger(path, { events: { X: { event_ticker: 'X', first_seen_utc: 'now', delivered_at: null } } });
  const back = loadLedger(path);
  assert.equal(back.events.X.event_ticker, 'X');
});
