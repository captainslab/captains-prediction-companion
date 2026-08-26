import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWikipediaGameSourceRecord,
  buildWikipediaParseApiUrl,
  buildWikipediaSeasonPageTitle,
  buildWikipediaSeasonUrl,
  extractWikipediaGameLogRows,
  matchWikipediaGameLogRow,
  wikipediaGameTruthFromRow,
  wikipediaTeamNameForSeason,
} from '../scripts/mlb/source-adapters/wikipedia-historical-readonly.mjs';

test('Wikipedia team naming follows historical franchise page titles', () => {
  assert.equal(wikipediaTeamNameForSeason('ATH', 2025), 'Athletics');
  assert.equal(wikipediaTeamNameForSeason('OAK', 2024), 'Oakland Athletics');
  assert.equal(wikipediaTeamNameForSeason('Cleveland Guardians', 2021), 'Cleveland Indians');
  assert.equal(wikipediaTeamNameForSeason('CLE', 2025), 'Cleveland Guardians');
});

test('Wikipedia season page URLs are canonical and stable', () => {
  assert.equal(
    buildWikipediaSeasonPageTitle({ team: 'NYY', season: 2025 }),
    '2025 New York Yankees season',
  );
  assert.equal(
    buildWikipediaSeasonUrl({ team: 'NYY', season: 2025 }),
    'https://en.wikipedia.org/wiki/2025_New_York_Yankees_season',
  );

  const api = new URL(buildWikipediaParseApiUrl({ team: 'NYY', season: 2025 }));
  assert.equal(api.origin + api.pathname, 'https://en.wikipedia.org/w/api.php');
  assert.equal(api.searchParams.get('action'), 'parse');
  assert.equal(api.searchParams.get('page'), '2025 New York Yankees season');
  assert.equal(api.searchParams.get('prop'), 'wikitext');
  assert.equal(api.searchParams.get('redirects'), '1');
});

test('game source record keeps gamePk canonical and stores both team pages', () => {
  const record = buildWikipediaGameSourceRecord({
    game_pk: 777001,
    game_date: '2025-04-03',
    away_team: 'Arizona Diamondbacks',
    home_team: 'New York Yankees',
  });

  assert.equal(record.game_pk, 777001);
  assert.equal(record.canonical_url, 'https://en.wikipedia.org/wiki/2025_New_York_Yankees_season');
  assert.equal(record.alternate_url, 'https://en.wikipedia.org/wiki/2025_Arizona_Diamondbacks_season');
  assert.equal(record.source_urls.length, 2);
  assert.match(record.source_key, /^wikipedia_mlb_[a-f0-9]{20}$/);
  assert.equal(record.line_score_available, false);
  assert.equal(record.first_inning_truth_available, false);
});

test('game-log parser extracts schedule/final-score rows without inventing inning truth', () => {
  const wikitext = `
{| class="wikitable"
! Game !! Date !! Opponent !! Score !! Record
|-
| 6 || April 3 || [[Arizona Diamondbacks|Diamondbacks]] || W 9-7 || 4-2
|-
| 7 || April 4 || @ [[Pittsburgh Pirates|Pirates]] || L 4-5 (11) || 4-3
|}
`;

  const rows = extractWikipediaGameLogRows(wikitext, {
    season: 2025,
    sourceTeam: 'New York Yankees',
  });

  assert.equal(rows.length, 2);
  assert.deepEqual(
    {
      date: rows[0].game_date,
      opponent: rows[0].opponent,
      away: rows[0].is_away,
      runs: rows[0].team_runs,
      oppRuns: rows[0].opponent_runs,
      innings: rows[0].innings,
    },
    {
      date: '2025-04-03',
      opponent: 'Diamondbacks',
      away: false,
      runs: 9,
      oppRuns: 7,
      innings: 9,
    },
  );
  assert.equal(rows[1].is_away, true);
  assert.equal(rows[1].innings, 11);
});

test('matched Wikipedia row resolves final score orientation only', () => {
  const rows = [{
    source_team: 'New York Yankees',
    game_date: '2025-04-03',
    game_number: null,
    opponent: 'Diamondbacks',
    is_away: false,
    team_runs: 9,
    opponent_runs: 7,
    innings: 9,
  }];
  const game = {
    game_pk: 777001,
    game_date: '2025-04-03',
    away_team: 'Arizona Diamondbacks',
    home_team: 'New York Yankees',
  };

  const row = matchWikipediaGameLogRow({ rows, game, sourceTeam: 'New York Yankees' });
  assert.ok(row);
  const truth = wikipediaGameTruthFromRow({ row, game, sourceTeam: 'New York Yankees' });

  assert.equal(truth.away_runs, 7);
  assert.equal(truth.home_runs, 9);
  assert.equal(truth.winner, 'home');
  assert.equal(truth.yrfi, null);
  assert.equal(truth.nrfi, null);
  assert.equal(truth.first_inning_truth_available, false);
});
