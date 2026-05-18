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
import { summarizeMarketCoverage } from '../scripts/mlb/slate-check.mjs';
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

test('renderGameSection emits required structural headings + MISSING markers', () => {
  const game = {
    game_key: '26MAY192140SFAZ',
    away: 'SF', home: 'AZ', away_full: 'San Francisco Giants', home_full: 'Arizona Diamondbacks',
    start_utc: '2026-05-20T01:40:00.000Z', start_ct: '2026-05-19 20:40 CT',
    series: {}, // all missing
  };
  const txt = renderGameSection(game);
  for (const h of [
    'Game:', '- Matchup:', '- First pitch:', '- Venue/weather:',
    '- Probable starters:', '- Market snapshot:',
    'Main pick review:', '- ML:', '- Spread:', '- Total:',
    '- Best side:', '- Decision:', '- Reasoning:',
    'Game total ceiling:', 'Props:', '- Home runs:',
    '- Away starter strikeout ceiling:', '- Home starter strikeout ceiling:',
    'YFRI/NFRI:', 'Game summary and history:',
    'Final game call:', '- Best available angle:',
    '- Confidence:', 'NO CLEAR PICK',
  ]) {
    assert.ok(txt.includes(h), `missing heading/text: ${h}`);
  }
  // Required: K props default to WATCH (or NO CLEAR PICK), never LEAN.
  assert.ok(!/Decision: LEAN/.test(txt), 'K-prop section must not LEAN by default');
});
