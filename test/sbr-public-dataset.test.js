import test from 'node:test';
import assert from 'node:assert/strict';
import {
  americanToProbability,
  normalizeSbrGame,
  pickSbrDatasetAsset,
  sbrRecordsForDate,
} from '../scripts/mlb/source-adapters/sbr-public-dataset-readonly.mjs';

test('release asset selection prefers the largest JSON-like dataset asset', () => {
  const asset = pickSbrDatasetAsset({ assets: [
    { name: 'notes.txt', size: 10, browser_download_url: 'https://example.com/notes' },
    { name: 'sample.json', size: 100, browser_download_url: 'https://example.com/sample' },
    { name: 'mlb_odds.json', size: 76000000, browser_download_url: 'https://example.com/data' },
  ] });
  assert.equal(asset.name, 'mlb_odds.json');
  assert.equal(asset.size, 76000000);
});

test('american odds conversion handles favorites and underdogs', () => {
  assert.equal(Math.round(americanToProbability(-200) * 1000) / 1000, 0.667);
  assert.equal(Math.round(americanToProbability(150) * 1000) / 1000, 0.4);
  assert.equal(americanToProbability(0), null);
});

test('SBR game normalization preserves multi-book close fields and computes no-vig book coverage', () => {
  const record = normalizeSbrGame({
    gameView: {
      startDate: '2024-04-01T23:10:00+00:00',
      awayTeam: { fullName: 'Boston Red Sox', shortName: 'BOS' },
      homeTeam: { fullName: 'Oakland Athletics', shortName: 'OAK' },
      awayTeamScore: 5,
      homeTeamScore: 2,
      gameStatusText: 'Final',
      venueName: 'Oakland Coliseum',
      gameType: 'R',
    },
    odds: {
      moneyline: [
        { sportsbook: 'fanduel', openingLine: { awayOdds: -120, homeOdds: 105 }, currentLine: { awayOdds: -130, homeOdds: 110 } },
        { sportsbook: 'draftkings', openingLine: { awayOdds: -118, homeOdds: 102 }, currentLine: { awayOdds: -128, homeOdds: 108 } },
        { sportsbook: 'betmgm', openingLine: { awayOdds: -122, homeOdds: 106 }, currentLine: { awayOdds: -132, homeOdds: 112 } },
      ],
      totals: [
        { sportsbook: 'fanduel', openingLine: { total: 8.5, overOdds: -110, underOdds: -110 }, currentLine: { total: 8, overOdds: -105, underOdds: -115 } },
        { sportsbook: 'draftkings', openingLine: { total: 8.5, overOdds: -108, underOdds: -112 }, currentLine: { total: 8, overOdds: -110, underOdds: -110 } },
        { sportsbook: 'betmgm', openingLine: { total: 8.5, overOdds: -105, underOdds: -115 }, currentLine: { total: 8, overOdds: -108, underOdds: -112 } },
      ],
    },
  }, '2024-04-01');

  assert.equal(record.moneyline_book_count, 3);
  assert.equal(record.game_total_book_count, 3);
  assert.equal(record.moneyline_two_sided, true);
  assert.equal(record.moneyline_no_vig, true);
  assert.equal(record.game_total_two_sided, true);
  assert.deepEqual(record.providers, ['betmgm', 'draftkings', 'fanduel']);
  assert.ok(record.moneyline_quotes[0].away_no_vig_multiplicative > 0.5);
  assert.equal(record.total_quotes[0].closing_total, 8);
});

test('date extraction returns only the requested archive date', () => {
  const dataset = {
    '2024-04-01': [{
      gameView: {
        startDate: '2024-04-01T23:10:00+00:00',
        awayTeam: { fullName: 'Boston Red Sox' },
        homeTeam: { fullName: 'Oakland Athletics' },
      },
      odds: {},
    }],
    '2024-04-02': [],
  };
  const rows = sbrRecordsForDate(dataset, '2024-04-01');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].game_date, '2024-04-01');
  assert.equal(rows[0].away_team, 'Boston Red Sox');
});
