// MLB market-family coverage wiring tests.
//
// Pins the behavior of wiring the market-free projection ENGINE into the
// article's market-family coverage:
//   - spread / total / YRFI promote to a modeled non-market composite the moment
//     the shared score engine produces outputs (provisional pre-lineup counts);
//   - Ks promotes only when its projection is non-blocked (confirmed lineup +
//     leash), else stays board-only/blocked;
//   - HR is never promoted by this wiring (no per-PA rate input → blocked);
//   - market price / OI / volume / board shape CANNOT change any family's
//     readiness, status, or modeled flag (price isolation);
//   - ML/game-side readiness is unchanged by projections (its own path);
//   - the rendered family block shows modeled lines, not board-analyzer lines.
//
// Pure unit tests — no I/O, no network.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMarketFamilyCoverage,
  analyzeGame,
} from '../scripts/mlb/lib/market-engine.mjs';
import {
  buildGameProjections,
  leagueRunsPerGame,
} from '../scripts/mlb/lib/projection-engine.mjs';
import { renderFamilyStatusBlock } from '../scripts/mlb/lib/article-render.mjs';

// A real public-stats record (baseball-only, no price). Good enough run inputs
// that projectRunMeans() returns finite means so the score engine emits outputs.
function baseRecord() {
  return {
    game_pk: 777001,
    game_date: '2026-06-20',
    venue: 'Fenway Park',
    away_team: 'New York Yankees', away_team_abbrev: 'NYY',
    home_team: 'Boston Red Sox', home_team_abbrev: 'BOS',
    away_team_stats: { runs_scored: 320, runs_allowed: 270, gamesPlayed: 70 },
    home_team_stats: { runs_scored: 300, runs_allowed: 285, gamesPlayed: 70 },
    away_pitcher: { mlb_id: 11, name: 'Away Ace', era: 3.2, k_pct: 0.28, games_started: 14, batters_faced: 350 },
    home_pitcher: { mlb_id: 22, name: 'Home Ace', era: 3.6, k_pct: 0.25, games_started: 14, batters_faced: 360 },
    away_bullpen: { era: 3.9 },
    home_bullpen: { era: 4.1 },
  };
}

function projections(lineup_status, weather_status = null) {
  const rec = baseRecord();
  const leagueRPG = leagueRunsPerGame([rec]);
  return buildGameProjections({
    record: rec,
    leagueRPG,
    as_of: '2026-06-20T00:00:00Z',
    lineup_status,
    weather_status,
  });
}

// Game with board markets present for every family (so the board-only fallback
// would resolve to BOARD_ANALYZER_ONLY without projections).
function gameWithMarkets() {
  return {
    event_ticker: 'KXMLBGAME-26JUN20NYYBOS',
    away: 'NYY', home: 'BOS',
    away_full: 'New York Yankees', home_full: 'Boston Red Sox',
    series: {
      ml: { markets: [{ ticker: 'ml1' }] },
      spread: { markets: [{ ticker: 'sp1' }] },
      total: { markets: [{ ticker: 't1' }] },
      rfi: { markets: [{ ticker: 'r1' }] },
      ks: { markets: [{ ticker: 'k1' }] },
      hr: { markets: [{ ticker: 'h1' }] },
    },
  };
}

const cov = (game, projs) =>
  buildMarketFamilyCoverage(game, projs ? { final: { projections: projs } } : null);

test('pre-lineup: spread/total/YRFI promote to modeled; Ks/HR stay board-only', () => {
  const c = cov(gameWithMarkets(), projections('unconfirmed'));
  for (const fam of ['spread', 'total', 'yfri']) {
    assert.equal(c.families[fam].status, 'NON_MARKET_COMPOSITE_READY', `${fam} status`);
    assert.equal(c.families[fam].modeled, true, `${fam} modeled`);
    assert.equal(c.families[fam].board_only, false, `${fam} board_only`);
  }
  // Ks blocks pre-lineup (no confirmed lineup / leash) → board-only fallback.
  assert.equal(c.families.ks.modeled, false);
  assert.equal(c.families.ks.status, 'BOARD_ANALYZER_ONLY');
  // HR is never promoted by this wiring.
  assert.equal(c.families.hr.modeled, false);
  assert.equal(c.families.hr.status, 'BOARD_ANALYZER_ONLY');
});

test('confirmed lineup: Ks promotes to modeled; HR stays blocked', () => {
  const c = cov(gameWithMarkets(), projections('confirmed', 'complete'));
  assert.equal(c.families.ks.status, 'NON_MARKET_COMPOSITE_READY');
  assert.equal(c.families.ks.modeled, true);
  assert.equal(c.families.ks.board_only, false);
  // HR has no per-PA rate input in this feed → remains a non-modeled board family.
  assert.equal(c.families.hr.modeled, false);
});

test('no projections: every prop/derived family stays board-only (unchanged)', () => {
  const c = cov(gameWithMarkets(), null);
  for (const fam of ['spread', 'total', 'yfri', 'ks', 'hr']) {
    assert.equal(c.families[fam].modeled, false, `${fam} modeled`);
    assert.equal(c.families[fam].status, 'BOARD_ANALYZER_ONLY', `${fam} status`);
  }
});

test('price isolation: market price/OI/volume/board shape cannot change readiness', () => {
  const projs = projections('confirmed', 'complete');
  const clean = cov(gameWithMarkets(), projs);

  const polluted = gameWithMarkets();
  // Smuggle every flavor of market/price data into the board markets.
  polluted.series.spread.markets = [{ ticker: 'sp1', yes_ask: 55, no_bid: 44, volume: 99999, open_interest: 1234, price_movement: 0.37 }];
  polluted.series.total.markets = [{ ticker: 't1', kalshi_ask: 60, kalshi_bid: 40, implied_prob: 0.6, board_shape: 'steep' }];
  polluted.series.ks.markets = [{ ticker: 'k1', moneyline_odds: -150, liquidity: 5000 }];
  polluted.series.hr.markets = [{ ticker: 'h1', fair_value: 0.2, edge: 0.05 }];
  const dirty = cov(polluted, projs);

  for (const fam of ['spread', 'total', 'yfri', 'ks', 'hr']) {
    assert.equal(dirty.families[fam].status, clean.families[fam].status, `${fam} status stable`);
    assert.equal(dirty.families[fam].modeled, clean.families[fam].modeled, `${fam} modeled stable`);
    assert.equal(dirty.families[fam].board_only, clean.families[fam].board_only, `${fam} board_only stable`);
  }
  // And no price/board key leaked into the coverage output itself.
  const json = JSON.stringify(dirty.families);
  for (const k of ['yes_ask', 'no_bid', 'open_interest', 'volume', 'price_movement', 'kalshi_ask', 'kalshi_bid', 'implied_prob', 'board_shape', 'moneyline_odds', 'liquidity', 'fair_value', 'edge']) {
    assert.ok(!json.includes(k), `coverage must not surface ${k}`);
  }
});

test('analyzeGame threads projections; ML readiness unchanged by projections', () => {
  const game = gameWithMarkets();
  const withProj = analyzeGame(game, { projections: projections('confirmed', 'complete') });
  const without = analyzeGame(game);

  assert.equal(withProj.final.coverage.families.total.modeled, true);
  assert.equal(withProj.final.coverage.families.ks.modeled, true);
  assert.ok(withProj.final.projections, 'projections stored on final');

  // ML/game-side family is driven by decision_status, NOT projections → identical.
  assert.equal(
    withProj.final.coverage.families.ml.status,
    without.final.coverage.families.ml.status,
    'ML status must be independent of projection wiring',
  );
});

test('rendered family block shows modeled lines, not board-analyzer lines', () => {
  const game = gameWithMarkets();
  const confirmed = analyzeGame(game, { projections: projections('confirmed', 'complete') });
  const block = renderFamilyStatusBlock(game, confirmed);

  assert.match(block, /Spread: NON_MARKET_COMPOSITE_READY/);
  assert.match(block, /Total: NON_MARKET_COMPOSITE_READY/);
  assert.match(block, /Ks props: NON_MARKET_COMPOSITE_READY/);
  assert.doesNotMatch(block, /Ks props: BOARD_ANALYZER_ONLY/);
  // Modeled detail is model-derived, never a market line.
  assert.match(block, /shared score engine|BF×K% count model|top-of-order/);

  // Pre-lineup: spread/total modeled (provisional), Ks NOT modeled.
  const pre = analyzeGame(game, { projections: projections('unconfirmed') });
  const preBlock = renderFamilyStatusBlock(game, pre);
  assert.match(preBlock, /Spread: NON_MARKET_COMPOSITE_READY/);
  assert.match(preBlock, /provisional/);
  assert.doesNotMatch(preBlock, /Ks props: NON_MARKET_COMPOSITE_READY/);
});
