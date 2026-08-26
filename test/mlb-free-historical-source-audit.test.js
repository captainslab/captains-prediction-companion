import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dateRangeInclusive,
  matchHistoricalEvents,
  summarizeCoverage,
} from '../scripts/mlb/historical/free-source-audit.mjs';

const MLB_GAMES = [
  {
    game_pk: 745001,
    game_date: '2024-04-01',
    start_time_utc: '2024-04-01T23:05:00Z',
    away_team: 'New York Yankees',
    home_team: 'Arizona Diamondbacks',
    mlb_status: 'Final',
  },
  {
    game_pk: 745002,
    game_date: '2024-04-01',
    start_time_utc: '2024-04-01T23:10:00Z',
    away_team: 'Boston Red Sox',
    home_team: 'Oakland Athletics',
    mlb_status: 'Final',
  },
];

const SPORTSBOOK_ROWS = [
  {
    away_team: 'New York Yankees',
    home_team: 'Arizona Diamondbacks',
    provider: 'ESPN BET',
    details: 'NYY -125',
    away_moneyline: '-125',
    home_moneyline: '+105',
    away_no_vig_fair: 0.542,
    home_no_vig_fair: 0.458,
    over_under: 8.5,
    total_over_odds: '-110',
    total_under_odds: '-110',
  },
  {
    away_team: 'Boston Red Sox',
    home_team: 'Oakland Athletics',
    provider: 'ESPN BET',
    details: 'BOS -130',
    away_moneyline: '-130',
    home_moneyline: '+110',
    away_no_vig_fair: 0.551,
    home_no_vig_fair: 0.449,
    over_under: 8,
    total_over_odds: null,
    total_under_odds: null,
  },
];

test('dateRangeInclusive returns exact frozen date span endpoints', () => {
  assert.deepEqual(dateRangeInclusive('2024-06-29', '2024-07-02'), [
    '2024-06-29',
    '2024-06-30',
    '2024-07-01',
    '2024-07-02',
  ]);
  assert.throws(() => dateRangeInclusive('2024-07-02', '2024-07-01'), /after/);
});

test('historical audit matches ESPN rows to MLB gamePk and emits canonical Wikipedia URLs', () => {
  const rows = matchHistoricalEvents(MLB_GAMES, SPORTSBOOK_ROWS);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].game_pk, 745001);
  assert.equal(rows[0].mapping_status, 'MATCHED');
  assert.equal(rows[0].moneyline_two_sided, true);
  assert.equal(rows[0].moneyline_no_vig, true);
  assert.equal(rows[0].game_total_line, true);
  assert.equal(rows[0].game_total_two_sided, true);
  assert.match(rows[0].wikipedia_source_url, /2024_Arizona_Diamondbacks_season/);
  assert.match(rows[1].wikipedia_source_url, /2024_Oakland_Athletics_season/);
  assert.match(rows[0].wikipedia_source_key, /^wikipedia_mlb_[a-f0-9]{20}$/);
});

test('coverage summary distinguishes a total line from a two-sided total price', () => {
  const rows = matchHistoricalEvents(MLB_GAMES, SPORTSBOOK_ROWS);
  assert.deepEqual(summarizeCoverage(rows), {
    games: 2,
    mapped_games: 2,
    mapped_pct: 100,
    moneyline_two_sided_games: 2,
    moneyline_two_sided_pct: 100,
    moneyline_no_vig_games: 2,
    moneyline_no_vig_pct: 100,
    game_total_line_games: 2,
    game_total_line_pct: 100,
    game_total_two_sided_games: 1,
    game_total_two_sided_pct: 50,
    sportsbook_providers: { 'ESPN BET': 2 },
  });
});

test('unmatched MLB games fail closed instead of inheriting a sportsbook row', () => {
  const rows = matchHistoricalEvents(MLB_GAMES, SPORTSBOOK_ROWS.slice(0, 1));
  assert.equal(rows[1].mapping_status, 'NO_SPORTSBOOK_MATCH');
  assert.equal(rows[1].moneyline_two_sided, false);
  assert.equal(rows[1].game_total_line, false);
  assert.equal(rows[1].provider, null);
});
