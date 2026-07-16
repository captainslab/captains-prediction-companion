// Unit tests for MLB slate-check primitives. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MLB_SERIES,
  gameKeyFromEventTicker,
  parseGameKey,
  joinGames,
  clusterWindows,
  ctClockFromUtc,
} from '../scripts/mlb/lib/series-discovery.mjs';
import { summarizeMarketCoverage, buildPerGameWindows } from '../scripts/mlb/slate-check.mjs';
import { selectDueWindows } from '../scripts/mlb/run-due-windows.mjs';
import { renderGameSection } from '../scripts/mlb/lib/report-render.mjs';

test('MLB_SERIES covers all six required series', () => {
  assert.deepEqual(
    Object.keys(MLB_SERIES).sort(),
    ['hr', 'ks', 'ml', 'rfi', 'spread', 'total'],
  );
  assert.equal(MLB_SERIES.ml.prefix, 'KXMLBGAME');
  assert.equal(MLB_SERIES.spread.prefix, 'KXMLBSPREAD');
  assert.equal(MLB_SERIES.total.prefix, 'KXMLBTOTAL');
  assert.equal(MLB_SERIES.hr.prefix, 'KXMLBHR');
  assert.equal(MLB_SERIES.ks.prefix, 'KXMLBKS');
  assert.equal(MLB_SERIES.rfi.prefix, 'KXMLBRFI');
});

test('gameKeyFromEventTicker strips series prefix only', () => {
  assert.equal(gameKeyFromEventTicker('KXMLBGAME-26MAY211605NYMWSH'), '26MAY211605NYMWSH');
  assert.equal(gameKeyFromEventTicker('KXMLBSPREAD-26MAY192140SFAZ'), '26MAY192140SFAZ');
  assert.equal(gameKeyFromEventTicker('KXMLBHR-26MAY182140SFAZ'), '26MAY182140SFAZ');
  assert.equal(gameKeyFromEventTicker(null), null);
  assert.equal(gameKeyFromEventTicker('BAD'), null);
});

test('parseGameKey decodes time + teams + UTC start (EDT)', () => {
  const p = parseGameKey('26MAY192140SFAZ');
  assert.equal(p.away, 'SF');
  assert.equal(p.home, 'AZ');
  assert.equal(p.month, 5);
  assert.equal(p.day, 19);
  // 21:40 ET on 2026-05-19 (EDT, -04:00) -> 01:40 UTC on 2026-05-20
  assert.equal(p.startUtc, '2026-05-20T01:40:00.000Z');
});

test('parseGameKey honors EST (Jan) vs EDT (May)', () => {
  const jan = parseGameKey('26JAN201900NYMWSH');
  // 19:00 EST = 00:00 UTC next day
  assert.equal(jan.startUtc, '2026-01-21T00:00:00.000Z');
  const jul = parseGameKey('26JUL201900NYMWSH');
  // 19:00 EDT = 23:00 UTC same day
  assert.equal(jul.startUtc, '2026-07-20T23:00:00.000Z');
});

test('ctClockFromUtc renders America/Chicago', () => {
  // 2026-05-20T01:40Z is 2026-05-19 20:40 CDT
  const s = ctClockFromUtc('2026-05-20T01:40:00.000Z');
  assert.equal(s, '2026-05-19 20:40 CT');
});

test('joinGames merges series by game key', () => {
  const fake = {
    ml: { events: [{ event_ticker: 'KXMLBGAME-26MAY192140SFAZ', markets: [{ ticker: 'X', yes_ask_dollars: 0.55 }] }] },
    spread: { events: [{ event_ticker: 'KXMLBSPREAD-26MAY192140SFAZ', markets: [{ ticker: 'Y', yes_ask_dollars: 0.30 }] }] },
    total: { events: [] },
    hr: { events: [] },
    ks: { events: [] },
    rfi: { events: [] },
  };
  const games = joinGames(fake);
  assert.equal(games.length, 1);
  assert.equal(games[0].game_key, '26MAY192140SFAZ');
  assert.ok(games[0].series.ml);
  assert.ok(games[0].series.spread);
  assert.equal(games[0].series.total, undefined);
});

test('clusterWindows groups games within 10 minutes and computes report_at', () => {
  const games = [
    { game_key: 'A', start_utc: '2026-05-20T18:05:00.000Z' },
    { game_key: 'B', start_utc: '2026-05-20T18:10:00.000Z' },
    { game_key: 'C', start_utc: '2026-05-20T23:40:00.000Z' },
  ];
  const c = clusterWindows(games, { withinMinutes: 10, prelockMinutes: 60 });
  assert.equal(c.length, 2);
  assert.deepEqual(c[0].game_keys, ['A', 'B']);
  assert.deepEqual(c[1].game_keys, ['C']);
  assert.equal(c[0].report_at_utc, '2026-05-20T17:05:00.000Z');
  assert.equal(c[1].report_at_utc, '2026-05-20T22:40:00.000Z');
});

test('buildPerGameWindows uses official starts and creates T-60/T-55 windows independently', () => {
  const games = [
    { game_key: 'A', away_full: 'New York Mets', home_full: 'Philadelphia Phillies', start_ct: '18:10 CT' },
    { game_key: 'B', away_full: 'Atlanta Braves', home_full: 'Boston Red Sox', start_ct: '19:10 CT' },
  ];
  const official = [
    { game_pk: 823440, away_team: 'New York Mets', home_team: 'Philadelphia Phillies', start_time_utc: '2026-07-16T23:10:00Z', checked_at_utc: '2026-07-16T14:00:00Z' },
    { game_pk: 823441, away_team: 'Atlanta Braves', home_team: 'Boston Red Sox', start_time_utc: '2026-07-17T00:10:00Z', checked_at_utc: '2026-07-16T14:00:00Z' },
  ];
  const windows = buildPerGameWindows(games, official, 55);
  assert.deepEqual(windows.map((w) => [w.game_pk, w.prepare_at_utc, w.report_at_utc]), [
    [823440, '2026-07-16T22:10:00.000Z', '2026-07-16T22:15:00.000Z'],
    [823441, '2026-07-16T23:10:00.000Z', '2026-07-16T23:15:00.000Z'],
  ]);
  assert.deepEqual(windows.map((w) => w.game_keys), [['A'], ['B']]);
  assert.ok(windows.every((w) => w.event_start_authority === 'official_mlb_schedule'));
});

test('selectDueWindows chooses exactly one due game and leaves later games pending', () => {
  const plan = { report_windows: [
    { cluster_id: 'G01', game_pk: 823440, report_at_utc: '2026-07-16T22:15:00Z', status: 'pending', idempotency_key: 'a' },
    { cluster_id: 'G02', game_pk: 823441, report_at_utc: '2026-07-16T23:15:00Z', status: 'pending', idempotency_key: 'b' },
  ] };
  const due = selectDueWindows(plan, { nowMs: Date.parse('2026-07-16T22:16:00Z'), graceMinutes: 5 });
  assert.deepEqual(due.map((w) => w.game_pk), [823440]);
  assert.equal(plan.report_windows[1].status, 'pending');
  assert.equal(selectDueWindows({ report_windows: [{ ...plan.report_windows[0], status: 'rendered' }] }, { nowMs: Date.parse('2026-07-16T22:16:00Z') }).length, 0);
});

test('selectDueWindows honors T-50/T-45 retry slots only for retry-pending games', () => {
  const plan = { report_windows: [{
    cluster_id: 'G01', game_pk: 823440, report_at_utc: '2026-07-16T22:15:00Z',
    retry_at_utc: ['2026-07-16T22:20:00Z', '2026-07-16T22:25:00Z'], retry_index: 0,
    status: 'retry_pending', idempotency_key: 'retry',
  }] };
  assert.equal(selectDueWindows(plan, { nowMs: Date.parse('2026-07-16T22:20:00Z'), graceMinutes: 5 }).length, 1);
  assert.equal(selectDueWindows(plan, { nowMs: Date.parse('2026-07-16T22:19:00Z'), graceMinutes: 5 }).length, 0);
});

test('summarizeMarketCoverage flags MISSING / UNQUOTED / OK', () => {
  const cov = summarizeMarketCoverage({
    series: {
      ml: { event_ticker: 'E1', market_count: 2, priced: true },
      spread: { event_ticker: 'E2', market_count: 0, priced: false },
      // hr/ks/total/rfi missing
    },
  });
  assert.equal(cov.ml.status, 'OK');
  assert.equal(cov.spread.status, 'UNQUOTED');
  assert.equal(cov.hr.status, 'MISSING');
  assert.equal(cov.ks.status, 'MISSING');
  assert.equal(cov.total.status, 'MISSING');
  assert.equal(cov.rfi.status, 'MISSING');
});

test('renderGameSection emits matchup, time, and composite-pending status', () => {
  const game = {
    game_key: '26MAY192140SFAZ',
    away: 'SF', home: 'AZ', away_full: 'San Francisco Giants', home_full: 'Arizona Diamondbacks',
    start_utc: '2026-05-20T01:40:00.000Z', start_ct: '2026-05-19 20:40 CT',
    series: {},
  };
  const out = renderGameSection(game);
  const txt = out.text;
  assert.ok(txt.includes('SF @ AZ'), 'missing matchup');
  assert.ok(txt.includes('20:40 CT'), 'missing game time');
  assert.ok(txt.includes('pending'), 'missing composite-pending status');
  assert.equal(out.analysis.final.decision_status, 'NO CLEAR PICK');
  assert.ok(!txt.includes('YES '), 'must not include market prices');
  assert.ok(!txt.includes('¢'), 'must not include cent prices');
});
