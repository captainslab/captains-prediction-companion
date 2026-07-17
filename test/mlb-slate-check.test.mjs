// Unit tests for MLB slate-check primitives. No network.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { summarizeMarketCoverage, buildPerGameWindows, mergeOfficialGames } from '../scripts/mlb/slate-check.mjs';
import { selectDueWindows } from '../scripts/mlb/run-due-windows.mjs';
import { buildMorningSlatePlan, isMorningSummaryEligible, renderMorningSummary } from '../scripts/mlb/morning-slate-summary.mjs';
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

test('parseGameKey decodes doubleheader suffixes without changing the game key', () => {
  const p = parseGameKey('26JUL171910TBBOSG2');
  assert.equal(p.away, 'TB');
  assert.equal(p.home, 'BOS');
  assert.equal(p.startUtc, '2026-07-17T23:10:00.000Z');
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

test('mergeOfficialGames matches both doubleheader legs and drops an unresolvable ghost', () => {
  const discovered = joinGames({
    ml: { events: [
      { event_ticker: 'KXMLBGAME-26JUL171910TBBOSG2', markets: [] },
      { event_ticker: 'KXMLBGAME-26JUL171335TBBOSG1', markets: [] },
    ] },
  });
  discovered.push({ game_key: '26JUL171999????', away: null, home: null, away_full: null, home_full: null, start_utc: null, series: {} });
  const official = [
    { game_pk: 824766, away_team: 'Tampa Bay Rays', home_team: 'Boston Red Sox', start_time_utc: '2026-07-17T17:35:00Z' },
    { game_pk: 824737, away_team: 'Tampa Bay Rays', home_team: 'Boston Red Sox', start_time_utc: '2026-07-17T23:10:00Z' },
  ];
  const merged = mergeOfficialGames(discovered, official);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((game) => game.game_key), ['26JUL171335TBBOSG1', '26JUL171910TBBOSG2']);
  assert.ok(merged.every((game) => game.away === 'TB' && game.home === 'BOS'));
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
  assert.deepEqual(windows.map((w) => w.report_at_ct), ['2026-07-16 17:15 CT', '2026-07-16 18:15 CT']);
  assert.deepEqual(windows.map((w) => w.game_keys), [['A'], ['B']]);
  assert.ok(windows.every((w) => w.event_start_authority === 'official_mlb_schedule'));
  assert.deepEqual(windows.map((w) => ({
    status: w.status,
    retry_at_utc: w.retry_at_utc,
    retry_index: w.retry_index,
    idempotency_key: w.idempotency_key,
  })), [
    {
      status: 'pending',
      retry_at_utc: ['2026-07-16T22:20:00.000Z', '2026-07-16T22:25:00.000Z'],
      retry_index: 0,
      idempotency_key: 'mlb:823440:2026-07-16T22:15:00.000Z',
    },
    {
      status: 'pending',
      retry_at_utc: ['2026-07-16T23:20:00.000Z', '2026-07-16T23:25:00.000Z'],
      retry_index: 0,
      idempotency_key: 'mlb:823441:2026-07-16T23:15:00.000Z',
    },
  ]);
});

test('buildPerGameWindows returns no windows for an empty slate', () => {
  assert.deepEqual(buildPerGameWindows([], []), []);
});

test('buildPerGameWindows filters postponed/canceled games and missing official starts', () => {
  const games = [
    { game_key: 'POSTPONED', away_full: 'New York Mets', home_full: 'Philadelphia Phillies', start_utc: '2026-07-16T23:10:00Z' },
    { game_key: 'CANCELED', away_full: 'Atlanta Braves', home_full: 'Boston Red Sox', start_utc: '2026-07-17T00:10:00Z' },
    { game_key: 'MISSING', away_full: 'Chicago Cubs', home_full: 'St. Louis Cardinals', start_utc: '2026-07-17T01:10:00Z' },
  ];
  const official = [
    { game_pk: 1, away_team: 'New York Mets', home_team: 'Philadelphia Phillies', start_time_utc: '2026-07-16T23:10:00Z', mlb_status: 'Postponed' },
    { game_pk: 2, away_team: 'Atlanta Braves', home_team: 'Boston Red Sox', start_time_utc: '2026-07-17T00:10:00Z', mlb_status: 'Canceled' },
    { game_pk: 3, away_team: 'Chicago Cubs', home_team: 'St. Louis Cardinals', start_time_utc: null, mlb_status: 'Preview' },
  ];
  assert.deepEqual(buildPerGameWindows(games, official), []);
});

test('buildPerGameWindows uses official UTC across the Central midnight boundary', () => {
  const windows = buildPerGameWindows([
    { game_key: 'LATE', away_full: 'Chicago Cubs', home_full: 'St. Louis Cardinals' },
  ], [{
    game_pk: 823442,
    away_team: 'Chicago Cubs',
    home_team: 'St. Louis Cardinals',
    start_time_utc: '2026-07-17T00:10:00Z',
    mlb_status: 'Preview',
  }]);
  assert.equal(windows[0].lead_first_pitch_utc, '2026-07-17T00:10:00.000Z');
  assert.equal(windows[0].lead_first_pitch_ct, '2026-07-16 19:10 CT');
  assert.equal(windows[0].report_at_utc, '2026-07-16T23:15:00.000Z');
});

test('duplicate slate-check window builds are stable and do not duplicate idempotency keys', () => {
  const games = [{ game_key: 'A', away_full: 'New York Mets', home_full: 'Philadelphia Phillies' }];
  const official = [{ game_pk: 823440, away_team: 'New York Mets', home_team: 'Philadelphia Phillies', start_time_utc: '2026-07-16T23:10:00Z' }];
  const first = buildPerGameWindows(games, official);
  const second = buildPerGameWindows(games, official);
  assert.deepEqual(second, first);
  assert.equal(new Set(first.map((w) => w.idempotency_key)).size, first.length);
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

test('per-game report window is eligible only at report time within the runner grace window', () => {
  const [window] = buildPerGameWindows([
    { game_key: 'A', away_full: 'New York Mets', home_full: 'Philadelphia Phillies' },
  ], [{
    game_pk: 823440,
    away_team: 'New York Mets',
    home_team: 'Philadelphia Phillies',
    start_time_utc: '2026-07-16T23:10:00Z',
  }]);
  const reportMs = Date.parse(window.report_at_utc);
  assert.equal(selectDueWindows({ report_windows: [window] }, { nowMs: reportMs - 1 }).length, 0);
  assert.equal(selectDueWindows({ report_windows: [window] }, { nowMs: reportMs + 1 }).length, 1);
});

test('morning summary is single-run eligible until its sent marker exists', () => {
  assert.equal(isMorningSummaryEligible({ morning_summary_sent_utc: null }), true);
  assert.equal(isMorningSummaryEligible({ morning_summary_sent_utc: '2026-07-17T12:00:00Z' }), false);
  assert.equal(isMorningSummaryEligible({ morning_summary_sent_utc: '2026-07-17T12:00:00Z' }, { force: true }), true);
});

test('morning summary falls back to known full team names and report time', () => {
  const summary = renderMorningSummary({
    date: '2026-07-17',
    generated_utc: '2026-07-17T14:00:00.000Z',
    game_count: 1,
    games: [{ away: null, home: null, away_full: 'Tampa Bay Rays', home_full: 'Boston Red Sox', first_pitch_ct: '2026-07-17 18:10 CT' }],
    report_windows: [{ cluster_id: 'G01', report_at_ct: '2026-07-17 17:15 CT', lead_first_pitch_ct: '2026-07-17 18:10 CT', game_keys: ['MLB-1'] }],
  });
  assert.ok(summary.includes('Tampa Bay Rays @ Boston Red Sox'));
  assert.ok(summary.includes('fire 2026-07-17 17:15 CT'));
  assert.ok(!summary.includes('? @ ?'));
  assert.ok(!summary.includes('fire ?'));
});

test('morning plan path fetches official records and passes them into the plan builder', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'cpc-morning-'));
  const officialRecord = {
    game_pk: 823440,
    game_date: '2026-07-17',
    start_time_utc: '2026-07-17T23:10:00Z',
    away_team: 'New York Mets',
    home_team: 'Philadelphia Phillies',
    mlb_status: 'Preview',
  };
  let received;
  const plan = await buildMorningSlatePlan({
    date: '2026-07-17',
    stateRoot,
    fetchImpl: async () => ({
      ok: true,
      async json() { return { dates: [{ games: [
        {
          gamePk: officialRecord.game_pk,
          officialDate: officialRecord.game_date,
          gameDate: officialRecord.start_time_utc,
          teams: {
            away: { team: { name: officialRecord.away_team } },
            home: { team: { name: officialRecord.home_team } },
          },
          status: { detailedState: officialRecord.mlb_status },
        },
      ] }] }; },
    }),
    now: '2026-07-17T14:00:00Z',
    buildPlan: async ({ officialRecords }) => {
      received = officialRecords;
      return {
        date: '2026-07-17',
        game_count: officialRecords.length,
        report_windows: buildPerGameWindows([
          {
            game_key: '26JUL171810NYMPHI',
            away_full: officialRecord.away_team,
            home_full: officialRecord.home_team,
          },
        ], officialRecords, 60),
      };
    },
  });

  assert.equal(plan.report_windows.length, 1);
  assert.equal(received[0].game_pk, officialRecord.game_pk);
  assert.equal(received[0].checked_at_utc, '2026-07-17T14:00:00.000Z');
  const saved = JSON.parse(readFileSync(join(stateRoot, 'mlb', '2026-07-17', 'discovery', 'mlb_official_adapter.json'), 'utf8'));
  assert.equal(saved.records.length, 1);
});

test('morning plan path fails closed when official records are unavailable', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'cpc-morning-empty-'));
  let buildCalled = false;
  await assert.rejects(
    buildMorningSlatePlan({
      date: '2026-07-17',
      stateRoot,
      fetchImpl: async () => ({
        ok: true,
        async json() { return { dates: [] }; },
      }),
      buildPlan: async () => {
        buildCalled = true;
        return { report_windows: [{ unexpected: true }] };
      },
    }),
    /official MLB schedule unavailable: degraded/,
  );
  assert.equal(buildCalled, false, 'no report windows are built after the official gate fails');
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
