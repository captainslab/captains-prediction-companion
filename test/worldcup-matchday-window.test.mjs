// World Cup matchday window tests.
//
// Pins the slate-selection contract: "today's matches" are the matches whose
// kickoff falls on the target calendar date in the operating timezone
// (America/Chicago), NOT the UTC date. A UTC-date filter both drops late
// games that roll past midnight UTC and wrongly includes early games that are
// still "yesterday" locally.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CPC_MATCHDAY_TIMEZONE,
  localDateInTimeZone,
  filterMatchesForLocalDate,
} from '../scripts/worldcup/lib/matchday-window.mjs';

test('operating timezone is America/Chicago', () => {
  assert.equal(CPC_MATCHDAY_TIMEZONE, 'America/Chicago');
});

test('localDateInTimeZone maps a UTC instant to its Chicago calendar date', () => {
  // 17:00Z = 12:00 CDT same day
  assert.equal(localDateInTimeZone('2026-06-22T17:00:00.000Z', 'America/Chicago'), '2026-06-22');
  // 00:00Z (+1 day UTC) = 19:00 CDT previous day → still the 22nd locally
  assert.equal(localDateInTimeZone('2026-06-23T00:00:00.000Z', 'America/Chicago'), '2026-06-22');
  // 03:00Z (+1 day UTC) = 22:00 CDT → still the 22nd locally
  assert.equal(localDateInTimeZone('2026-06-23T03:00:00.000Z', 'America/Chicago'), '2026-06-22');
  // 01:00Z on the 22nd = 20:00 CDT on the 21st → belongs to the 21st locally
  assert.equal(localDateInTimeZone('2026-06-22T01:00:00.000Z', 'America/Chicago'), '2026-06-21');
});

test('filterMatchesForLocalDate returns the full Chicago-local 2026-06-22 slate', () => {
  const matches = [
    { match_id: '400021480', home_team: 'New Zealand', away_team: 'Egypt', kickoff_utc: '2026-06-22T01:00:00.000Z' },
    { match_id: '400021494', home_team: 'Argentina', away_team: 'Austria', kickoff_utc: '2026-06-22T17:00:00.000Z' },
    { match_id: '400021492', home_team: 'France', away_team: 'Iraq', kickoff_utc: '2026-06-22T21:00:00.000Z' },
    { match_id: '400021491', home_team: 'Norway', away_team: 'Senegal', kickoff_utc: '2026-06-23T00:00:00.000Z' },
    { match_id: '400021499', home_team: 'Jordan', away_team: 'Algeria', kickoff_utc: '2026-06-23T03:00:00.000Z' },
  ];

  const slate = filterMatchesForLocalDate(matches, '2026-06-22', 'America/Chicago');
  const ids = slate.map(m => m.match_id);

  assert.deepEqual(
    ids,
    ['400021494', '400021492', '400021491', '400021499'],
    'Chicago 06-22 slate = Argentina/Austria, France/Iraq, Norway/Senegal, Jordan/Algeria',
  );
  assert.ok(!ids.includes('400021480'), 'New Zealand vs Egypt is a 06-21 match in Chicago time');
});

test('matches with no kickoff are excluded', () => {
  const matches = [{ match_id: 'x', home_team: 'A', away_team: 'B', kickoff_utc: null }];
  assert.deepEqual(filterMatchesForLocalDate(matches, '2026-06-22', 'America/Chicago'), []);
});
