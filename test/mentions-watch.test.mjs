// Tests for the today-only incremental mentions watcher and the generator's
// today-only default / watchlist isolation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  selectNewTodayEvents,
  loadLedger,
  saveLedger,
  ledgerPath,
  watch,
} from '../scripts/mentions/mentions-watch.mjs';
import {
  parseExtraArgs,
  DEFAULT_WINDOW_DAYS,
  WATCHLIST_WINDOW_DAYS,
  WATCHLIST_PACKET_TYPE,
} from '../scripts/packets/generate-mentions-daily.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WATCH = join(REPO, 'scripts/mentions/mentions-watch.mjs');

const DATE = '2026-06-11';
const ev = (ticker) => ({ event_ticker: ticker, title: ticker, markets: [{ ticker: `${ticker}-T1` }] });

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

test('seen/delivered event is skipped; unseen today event is fresh exactly once', () => {
  const ledger = { events: { 'KXHEARINGMENTION-26JUN11': { delivered_at: '2026-06-11T12:00:00Z' } } };
  const { fresh, seen } = selectNewTodayEvents([
    ev('KXHEARINGMENTION-26JUN11'),
    ev('KXHEARINGMENTION-26JUN11'), // duplicate listing must not double-count
    ev('KXMELANIAMENTION-26JUN11'),
  ], ledger, DATE);
  assert.deepEqual(fresh.map(e => e.event_ticker), ['KXMELANIAMENTION-26JUN11']);
  assert.deepEqual(seen.map(e => e.event_ticker), ['KXHEARINGMENTION-26JUN11']);
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

function runWatch(root, eventsFile, extraArgs = []) {
  return spawnSync(process.execPath, [
    WATCH, '--date', DATE, '--state-root', root, '--events-file', eventsFile, ...extraArgs,
  ], { encoding: 'utf8', cwd: REPO });
}

test('no-event run exits 0 quietly with only a local log line', () => {
  const root = mkdtempSync(join(tmpdir(), 'mentions-watch-test-'));
  const eventsFile = join(root, 'events.json');
  writeFileSync(eventsFile, JSON.stringify([ev('KXFUTUREMENTION-26JUN13')]));
  const r = runWatch(root, eventsFile);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no new today events .* quiet exit/);
  assert.equal(r.stderr.trim(), '');
  assert.ok(!existsSync(ledgerPath(root, DATE)), 'quiet run must not create a ledger');
});

test('new today event is planned once and duplicate run is skipped by ledger', () => {
  const root = mkdtempSync(join(tmpdir(), 'mentions-watch-test-'));
  const eventsFile = join(root, 'events.json');
  writeFileSync(eventsFile, JSON.stringify([ev('KXHEARINGMENTION-26JUN11'), ev('KXLATERMENTION-26JUN12')]));

  // dry-run names exactly the one today event
  const dry = runWatch(root, eventsFile, ['--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /1 new today event\(s\): KXHEARINGMENTION-26JUN11/);
  assert.match(dry.stdout, /would generate \+ send packets for: KXHEARINGMENTION-26JUN11/);
  assert.ok(!dry.stdout.includes('KXLATERMENTION-26JUN12 —'), 'future event must not be planned');

  // mark-seen-only records it durably without delivering
  const seed = runWatch(root, eventsFile, ['--mark-seen-only']);
  assert.equal(seed.status, 0, seed.stderr);
  const ledger = loadLedger(ledgerPath(root, DATE));
  const rec = ledger.events['KXHEARINGMENTION-26JUN11'];
  assert.ok(rec, 'ledger entry written');
  assert.equal(rec.event_date, DATE);
  assert.equal(rec.delivered_at, null);
  assert.equal(rec.idempotency_key, `mentions:${DATE}:KXHEARINGMENTION-26JUN11`);
  assert.ok(!ledger.events['KXLATERMENTION-26JUN12'], 'future event never enters the seen ledger');

  // second run: same event is now seen -> quiet exit, nothing planned
  const again = runWatch(root, eventsFile, ['--dry-run']);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /no new today events \(seen=1/);
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

test('ledger round-trips the stable keys', () => {
  const root = mkdtempSync(join(tmpdir(), 'mentions-watch-ledger-'));
  const path = ledgerPath(root, DATE);
  saveLedger(path, { events: { X: { event_ticker: 'X', first_seen_utc: 'now', delivered_at: null } } });
  const back = loadLedger(path);
  assert.equal(back.events.X.event_ticker, 'X');
});
