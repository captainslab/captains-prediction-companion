// Delivery-ordering tests: the watcher must send the most imminent same-day
// mention events FIRST under the per-run throttle, so a packet whose event is
// about to start is not queued behind events with hours of runway.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  watch,
  DEFAULT_MAX_NEW_PER_RUN,
  eventImminenceMs,
  orderByImminence,
} from '../scripts/mentions/mentions-watch.mjs';

const DATE = '2026-06-11';
// Same-day events (ticker carries the date) with distinct market close_times.
const evAt = (ticker, closeIso) => ({
  event_ticker: ticker,
  title: ticker,
  markets: [{ ticker: `${ticker}-T1`, close_time: closeIso }],
});

test('eventImminenceMs returns the earliest close/expiration across event + markets', () => {
  const ms = eventImminenceMs({
    close_time: '2026-06-11T22:00:00Z',
    markets: [
      { close_time: '2026-06-11T20:00:00Z' },
      { expected_expiration_time: '2026-06-11T14:00:00Z' },
    ],
  });
  assert.equal(ms, Date.parse('2026-06-11T14:00:00Z'));
});

test('eventImminenceMs returns Infinity when no timestamp is parseable', () => {
  assert.equal(eventImminenceMs({ markets: [{ ticker: 'X-T1' }] }), Infinity);
  assert.equal(eventImminenceMs({}), Infinity);
});

test('orderByImminence sorts soonest-close first, undated last, stable on ties', () => {
  const a = evAt('KXAAA-26JUN11', '2026-06-11T20:00:00Z');
  const b = evAt('KXBBB-26JUN11', '2026-06-11T14:00:00Z');
  const undated = { event_ticker: 'KXZZZ-26JUN11', markets: [{ ticker: 'Z-T1' }] };
  const tieEarly1 = evAt('KXTIE1-26JUN11', '2026-06-11T14:00:00Z');
  const tieEarly2 = evAt('KXTIE2-26JUN11', '2026-06-11T14:00:00Z');
  const ordered = orderByImminence([a, undated, b, tieEarly1, tieEarly2]);
  assert.deepEqual(
    ordered.map((e) => e.event_ticker),
    ['KXBBB-26JUN11', 'KXTIE1-26JUN11', 'KXTIE2-26JUN11', 'KXAAA-26JUN11', 'KXZZZ-26JUN11'],
  );
});

test('the default per-run throttle is widened beyond the old cap of 3', () => {
  assert.ok(DEFAULT_MAX_NEW_PER_RUN >= 6, `expected widened cap >= 6, got ${DEFAULT_MAX_NEW_PER_RUN}`);
});

test('watch delivers the most imminent same-day events first under the throttle cap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mentions-watch-imminence-'));
  const eventsFile = join(root, 'events.json');
  // Discovery order (Alpha, Beta, Gamma) deliberately differs from imminence
  // order (Beta 14:00 < Alpha 20:00 < Gamma 23:00).
  writeFileSync(eventsFile, JSON.stringify([
    evAt('KXALPHAMENTION-26JUN11', '2026-06-11T20:00:00Z'),
    evAt('KXBETAMENTION-26JUN11', '2026-06-11T14:00:00Z'),
    evAt('KXGAMMAMENTION-26JUN11', '2026-06-11T23:00:00Z'),
  ]));

  const result = await watch({
    date: DATE,
    stateRoot: root,
    eventsFile,
    dryRun: true,
    env: { MENTIONS_WATCH_MAX_NEW_PER_RUN: '2' },
  });

  assert.deepEqual(
    result.attempted.map((e) => e.event_ticker),
    ['KXBETAMENTION-26JUN11', 'KXALPHAMENTION-26JUN11'],
    'the two soonest-closing events are attempted this run, in soonest-first order',
  );
  assert.deepEqual(
    result.queued.map((e) => e.event_ticker),
    ['KXGAMMAMENTION-26JUN11'],
    'the event with the most runway is queued for the next run',
  );
});
