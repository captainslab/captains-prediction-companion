import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseResultsRow, parseResultsTsv } from '../../../scripts/worldcup/backtest/lib/results-tsv.mjs';

test('parseResultsRow parses a row and derives PRE-match Elo', () => {
  // Raw cols 10/11 (2144/2081) are POST-match; pre-match = post -/+ eloChange(-6).
  const row = '2022\t12\t18\tAR\tFR\t3\t3\tWC\tQA\t-6\t2144\t2081\t0\t0\t1\t3';
  assert.deepEqual(parseResultsRow(row), {
    date: '2022-12-18', homeCode: 'AR', awayCode: 'FR',
    homeGoals: 3, awayGoals: 3, typeCode: 'WC', venueCode: 'QA',
    eloChange: -6, homeEloPost: 2144, awayEloPost: 2081,
    homeElo: 2150, awayElo: 2075,
  });
});

test('parseResultsRow returns null on malformed/short rows', () => {
  assert.equal(parseResultsRow(''), null);
  assert.equal(parseResultsRow('2022\t12'), null);
});

test('parseResultsTsv skips blank lines and bad rows', () => {
  const text = '2022\t12\t18\tAR\tFR\t3\t3\tWC\tQA\t-6\t2144\t2081\n\nbad\n';
  assert.equal(parseResultsTsv(text).length, 1);
});
