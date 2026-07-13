// Proves the projection ENGINE computes real, price-free outputs from public
// baseball inputs and routes them through the price-isolated contracts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  poissonPmf,
  poissonDistribution,
  leagueRunsPerGame,
  projectRunMeans,
  buildGameProjections,
  matchStatsRecord,
} from '../scripts/mlb/lib/projection-engine.mjs';
import { distributionFloorMean } from '../scripts/mlb/lib/projection-contracts.mjs';

// A realistic record shaped like state/mlb/<date>/discovery/stats_adapter.json.
function sampleRecord(overrides = {}) {
  return {
    game_pk: 824178,
    game_date: '2026-06-17',
    label: 'DET@HOU',
    game: 'Detroit Tigers at Houston Astros',
    away_team: 'Detroit Tigers',
    home_team: 'Houston Astros',
    away_team_abbrev: 'DET',
    home_team_abbrev: 'HOU',
    venue: 'Daikin Park',
    away_pitcher: { mlb_id: 663554, era: 2.58, k_pct: 0.27, batters_faced: 380, games_started: 15 },
    home_pitcher: { mlb_id: 663567, era: 3.23, k_pct: 0.24, batters_faced: 360, games_started: 15 },
    away_team_stats: { runs_scored: 305, runs_allowed: 280, gamesPlayed: 75 },
    home_team_stats: { runs_scored: 340, runs_allowed: 300, gamesPlayed: 75 },
    away_bullpen: { era: 4.05 },
    home_bullpen: { era: 4.72 },
    ...overrides,
  };
}

const LEAGUE = 4.4;

test('poisson pmf and distribution are well-formed', () => {
  assert.ok(Math.abs(poissonPmf(4, 4) - 0.1953) < 0.01);
  const d = poissonDistribution(4.5, 12);
  const sum = Object.values(d).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `distribution sums to 1, got ${sum}`);
  assert.ok(Math.abs(distributionFloorMean(d) - 4.5) < 0.3, 'mean ≈ lambda');
});

test('league runs/game is the mean team scoring rate', () => {
  const lg = leagueRunsPerGame([sampleRecord()]);
  // (305/75 + 340/75)/2 ≈ 4.30
  assert.ok(Math.abs(lg - 4.30) < 0.05, `got ${lg}`);
});

test('run means scale with opponent run prevention and home boost', () => {
  const means = projectRunMeans(sampleRecord(), LEAGUE);
  assert.ok(means.lambdaHome > 1 && means.lambdaHome < 9);
  assert.ok(means.lambdaAway > 1 && means.lambdaAway < 9);
  // Both starters are better than league average, so each team is projected
  // BELOW its own raw scoring rate — the opponent-pitching adjustment bites.
  assert.ok(means.lambdaHome < 340 / 75, 'home suppressed vs raw offense');
  assert.ok(means.lambdaAway < 305 / 75, 'away suppressed vs raw offense');
});

test('empty-sample starter ERA does not poison run prevention or flip the home side into a heavy underdog', () => {
  const record = sampleRecord({
    away_pitcher: {
      mlb_id: 700001,
      era: 0,
      k_pct: 0.18,
      batters_faced: 12,
      games_started: 0,
      innings_pitched: '3.0',
    },
    home_pitcher: {
      mlb_id: 700002,
      era: 2.95,
      k_pct: 0.24,
      batters_faced: 420,
      games_started: 18,
      innings_pitched: '116.1',
    },
    away_team_stats: { runs_scored: 295, runs_allowed: 315, gamesPlayed: 75 },
    home_team_stats: { runs_scored: 365, runs_allowed: 285, gamesPlayed: 75 },
    away_bullpen: { era: 4.25 },
    home_bullpen: { era: 3.45 },
  });

  const means = projectRunMeans(record, LEAGUE);
  assert.ok(means.lambdaHome > LEAGUE, `expected home lambda above league average, got ${means.lambdaHome}`);

  const p = buildGameProjections({ record, leagueRPG: LEAGUE, lineup_status: 'confirmed', weather_status: 'complete' });
  assert.ok(p.score.outputs.moneyline_home > 0.5, `expected home win prob > 0.5, got ${p.score.outputs.moneyline_home}`);
});

test('confirmed lineup yields real numeric projections for ML/total/team/YRFI/Ks', () => {
  const p = buildGameProjections({ record: sampleRecord(), leagueRPG: LEAGUE, as_of: '2026-06-17T00:00:00Z', lineup_status: 'confirmed', weather_status: 'complete' });

  // Score engine: official, real probabilities + distributions.
  assert.equal(p.score.status, 'official');
  const ph = p.score.outputs.moneyline_home;
  assert.ok(ph > 0.3 && ph < 0.8, `moneyline_home a real prob, got ${ph}`);
  assert.ok(p.score.outputs.runline_home_minus_1_5 > 0 && p.score.outputs.runline_home_minus_1_5 < ph);
  assert.ok(distributionFloorMean(p.score.outputs.total_runs_distribution) > 5, 'projected total runs');
  assert.ok(distributionFloorMean(p.score.outputs.team_runs_distribution.home) > 2);

  // YRFI: real first-inning probability, complement consistent.
  const y = p.yrfi.outputs.yrfi_prob;
  assert.ok(y > 0.2 && y < 0.95, `yrfi prob real, got ${y}`);
  assert.ok(Math.abs(p.yrfi.outputs.nrfi_prob - (1 - y)) < 1e-9);

  // Ks: official with a count distribution + survival rungs.
  assert.equal(p.ks_away.status, 'official');
  assert.ok(distributionFloorMean(p.ks_away.outputs.distribution) > 4, 'projected Ks');
  assert.ok(p.ks_away.outputs.derived_probs.over_5_5 > 0 && p.ks_away.outputs.derived_probs.over_5_5 < 1);

  // HR is wired and fails closed until batter-level lineup evidence arrives.
  assert.equal(p.hr.status, 'blocked');
  assert.equal(p.hr.model_status, 'MODEL_INSUFFICIENT');
  assert.ok(p.hr.blocked_reasons.length > 0);
});

test('unconfirmed lineup: ML/total/YRFI render provisionally, Ks/HR block', () => {
  const p = buildGameProjections({ record: sampleRecord(), leagueRPG: LEAGUE, lineup_status: 'unconfirmed' });
  assert.equal(p.score.status, 'provisional');
  assert.ok(typeof p.score.outputs.moneyline_home === 'number');
  assert.equal(p.yrfi.status, 'provisional');
  assert.ok(typeof p.yrfi.outputs.yrfi_prob === 'number');
  // Ks blocked: opponent lineup unconfirmed.
  assert.equal(p.ks_away.status, 'blocked');
  assert.equal(p.hr.status, 'blocked');
  assert.equal(p.hr.model_status, 'MODEL_INSUFFICIENT');
});

test('missing team stats → no fabricated outputs (score blocked/empty, not invented)', () => {
  const r = sampleRecord({ away_team_stats: {}, home_team_stats: {} });
  const p = buildGameProjections({ record: r, leagueRPG: LEAGUE, lineup_status: 'confirmed' });
  // No run means → outputs null; status falls to provisional with no numbers,
  // never an invented probability.
  assert.equal(p.score.outputs, null);
});

test('matchStatsRecord finds the record by ticker abbrev code', () => {
  const recs = [sampleRecord()];
  const hit = matchStatsRecord(recs, { eventTicker: 'KXMLBGAME-26JUN171410DETHOU' });
  assert.equal(hit.game_pk, 824178);
  assert.equal(matchStatsRecord(recs, { eventTicker: 'KXMLBGAME-26JUN171410NYMCIN' }), null);
});
