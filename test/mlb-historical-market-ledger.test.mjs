import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_SELECTED_SIDE_LOGIT_RANGE,
  MIN_BOOKS,
  buildBinaryConsensus,
  buildMarketLedgerRows,
  devigPair,
  matchMlbGamesToSbr,
  selectPrimaryTotalLine,
} from '../scripts/mlb/historical/build-market-ledger.mjs';

function quote(book, away, home, total = 8.5, over = -110, under = -110) {
  return {
    sportsbook: book,
    opening_away_odds: away + 5,
    opening_home_odds: home - 5,
    closing_away_odds: away,
    closing_home_odds: home,
    opening_total: total,
    opening_over_odds: over,
    opening_under_odds: under,
    closing_total: total,
    closing_over_odds: over,
    closing_under_odds: under,
  };
}

test('three de-vig methods return complementary binary probabilities', () => {
  const result = devigPair(-120, 110);
  assert.ok(result);
  for (const method of ['multiplicative', 'power', 'shin']) {
    assert.ok(result[method].a > 0 && result[method].a < 1);
    assert.ok(result[method].b > 0 && result[method].b < 1);
    assert.ok(Math.abs(result[method].a + result[method].b - 1) < 2e-6);
  }
});

test('binary consensus passes with three books and bounded method spread', () => {
  const quotes = [
    quote('a', -120, 110),
    quote('b', -118, 108),
    quote('c', -122, 112),
  ];
  const consensus = buildBinaryConsensus(quotes, { kind: 'moneyline', phase: 'closing' });
  assert.equal(consensus.book_count, 3);
  assert.equal(consensus.min_books_required, MIN_BOOKS);
  assert.equal(consensus.max_selected_side_logit_range, MAX_SELECTED_SIDE_LOGIT_RANGE);
  assert.equal(consensus.a.devig_robust, true);
  assert.equal(consensus.b.devig_robust, true);
  assert.ok(consensus.a.selected_side_method_logit_range <= MAX_SELECTED_SIDE_LOGIT_RANGE);
});

test('binary consensus fails closed below the three-book minimum', () => {
  const quotes = [quote('a', -120, 110), quote('b', -118, 108)];
  const consensus = buildBinaryConsensus(quotes, { kind: 'moneyline', phase: 'closing' });
  assert.equal(consensus.book_count, 2);
  assert.equal(consensus.a.devig_robust, false);
  assert.equal(consensus.b.devig_robust, false);
});

test('primary total line prefers most books before proximity tie-breaks', () => {
  const quotes = [
    quote('a', -120, 110, 8.5),
    quote('b', -118, 108, 8.5),
    quote('c', -122, 112, 8.5),
    quote('d', -125, 115, 8.5),
    quote('e', -120, 110, 9),
    quote('f', -120, 110, 9),
  ];
  const selected = selectPrimaryTotalLine(quotes);
  assert.equal(selected.line, 8.5);
  assert.equal(selected.book_count, 4);
});

test('market ledger emits robust winner and game-total rows without claiming T-30 history', () => {
  const quotes = [
    quote('a', -120, 110, 8.5),
    quote('b', -118, 108, 8.5),
    quote('c', -122, 112, 8.5),
    quote('d', -121, 111, 8.5),
  ];
  const game = {
    game_pk: 745001,
    game_date: '2024-04-01',
    start_time_utc: '2024-04-01T23:05:00Z',
    away_team: 'New York Yankees',
    home_team: 'Arizona Diamondbacks',
  };
  const sbr = {
    away_team: game.away_team,
    home_team: game.home_team,
    moneyline_quotes: quotes,
    total_quotes: quotes,
    quote_semantics: 'archived close',
  };

  const rows = buildMarketLedgerRows({ game, sbr, sourceSha: 'abc123' });
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map(row => [row.family, row.side]), [
    ['winner', 'away'],
    ['winner', 'home'],
    ['game_total', 'over'],
    ['game_total', 'under'],
  ]);
  assert.ok(rows.every(row => row.benchmark_eligible));
  assert.ok(rows.every(row => row.devig_status === 'PASS'));
  assert.ok(rows.every(row => row.true_t_minus_30_available === false));
  assert.ok(rows.every(row => row.d_partition_touched === false));
  assert.equal(rows[2].market_line, 8.5);
  assert.equal(rows[2].clv_capability, 'OPEN_TO_CLOSE_SAME_LINE_REFERENCE_ONLY');
});

test('same-team doubleheaders are matched by start time while unresolved mismatches are excluded', () => {
  const games = [
    { game_pk: 1, game_date: '2024-06-01', start_time_utc: '2024-06-01T17:00:00Z', away_team: 'A', home_team: 'B' },
    { game_pk: 2, game_date: '2024-06-01', start_time_utc: '2024-06-01T23:00:00Z', away_team: 'A', home_team: 'B' },
    { game_pk: 3, game_date: '2024-06-01', start_time_utc: '2024-06-01T20:00:00Z', away_team: 'C', home_team: 'D' },
  ];
  const markets = [
    { start_time_utc: '2024-06-01T17:10:00Z', away_team: 'A', home_team: 'B' },
    { start_time_utc: '2024-06-01T23:10:00Z', away_team: 'A', home_team: 'B' },
  ];
  const result = matchMlbGamesToSbr(games, markets);
  assert.equal(result.matched.length, 2);
  assert.equal(result.matched[0].game.game_pk, 1);
  assert.equal(result.matched[1].game.game_pk, 2);
  assert.equal(result.excluded.length, 1);
  assert.equal(result.excluded[0].game_pk, 3);
  assert.equal(result.excluded[0].reason, 'NO_SBR_MATCH');
});
