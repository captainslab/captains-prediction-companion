import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mlbPickToDecisionRow,
  buildMlbSlatePacket,
} from '../scripts/packets/generate-mlb-daily.mjs';

// A realistic pre-lineup MLB pick: strong model edge, market price separate,
// lineup confirmation still pending.
function prelineupPick(overrides = {}) {
  return {
    market_ticker: 'KXMLBTOTAL-26MAY291905TORBAL-6',
    contract_title: 'Over 5.5 runs scored',
    game: 'Toronto Blue Jays at Baltimore Orioles',
    market_lane: 'total',
    classification: 'PRE_LINEUP_PICK',
    edge_pp: 8.04,
    fair_value: 0.8504,
    kalshi_ask: 0.77,
    primary_pick: true,
    missing_confirmations: ['lineup_pending', 'weather_data_pending'],
    gates_passed: ['g1:a', 'g2:b', 'g3:c', 'g4:d', 'g5:e', 'g6:f'],
    ...overrides,
  };
}

test('MLB pick -> decision row keeps model and market in separate halves', () => {
  const row = mlbPickToDecisionRow(prelineupPick());
  // model half carries fair_value, NOT the market price
  assert.equal(row.fair_probability_or_range, '85%');
  assert.equal(row.composite_score, 85);
  // market half carries the price
  assert.equal(row.market_yes_ask, 0.77);
  // edge is derived (fair - implied), positive, status PICK from scorer override
  assert.equal(row.edge_status, 'PICK');
  assert.ok(row.edge_cents_or_pp > 0, 'positive edge expected');
  // composite score must not equal the market price
  assert.notEqual(row.composite_score, row.market_yes_ask * 100);
});

test('pending lineup downgrades confidence but does NOT collapse to WATCH', () => {
  const row = mlbPickToDecisionRow(prelineupPick());
  assert.equal(row.edge_status, 'PICK', 'strong pre-lineup edge still surfaces as PICK');
  assert.notEqual(row.confidence, 'high', 'lineup pending should downgrade from high');
  assert.match(row.analysis, /pre-lineup/i);
  assert.match(row.trigger_event, /lineup/i);
});

test('missing MLB model score blocks ranked PICK/LEAN/WATCH rows before render', () => {
  const row = mlbPickToDecisionRow(prelineupPick({
    classification: 'LEAN',
    fair_value: null,
    market_reference_prob: 0.7438,
    kalshi_ask: 0.70,
    edge_pp: 4.382,
  }));
  assert.equal(row.edge_status, 'BLOCKED', 'ranked row without a model score must be blocked');
  assert.match(row.blocker_if_any, /model score missing/i);
  assert.match(row.analysis, /book-ref \(not composite\)/, 'book reference remains honest in analysis');
  assert.equal(row.composite_score, null);
});

test('MLB slate packet renders the morning wrapper and excludes raw inventory', () => {
  const scoring = {
    picks: [
      prelineupPick(),
      prelineupPick({ market_ticker: 'KXMLBGAME-1', classification: 'PASS', edge_pp: 0.4, fair_value: 0.5, kalshi_ask: 0.5, primary_pick: false }),
      prelineupPick({ market_ticker: 'KXMLBGAME-2', classification: 'FADE', edge_pp: -9.1, fair_value: 0.4, kalshi_ask: 0.49, primary_pick: false }),
    ],
    source: '/tmp/picks.json',
    summaryCounts: { pre_lineup_pick: 1, pass: 1, fade: 1 },
  };
  const slate = buildMlbSlatePacket({ date: '2026-05-29', scoring, inventoryPath: '/tmp/inv.txt' });
  assert.ok(slate, 'slate packet built');

  // 1. main packet does NOT contain audit artifacts; raw inventory lives in
  // its own artifact and stays separate from the customer-facing slate.
  assert.doesNotMatch(slate.text, /AUDIT ARTIFACTS/);
  assert.match(slate.inventoryText, /RAW CONTRACT INVENTORY/);

  // 2. required morning wrapper present; the old trading buckets are gone.
  assert.match(slate.text, /MORNING FULL-SLATE BOARD/);
  assert.match(slate.text, /Generated: .* CT/);
  assert.match(slate.text, /Run type: morning_proxy/);
  assert.match(slate.text, /Games scheduled: 1/);
  assert.match(slate.text, /IMPORTANT/);
  assert.match(slate.text, /This morning report uses each team's most recent confirmed locked batting order as a lineup proxy/);
  assert.match(slate.text, /Today's official starting pitchers are required/);
  assert.match(slate.text, /Every game will be rerun with today's confirmed lineups before first pitch/);
  assert.match(slate.text, /MARKET CONTEXT/);
  assert.match(slate.text, /Missing market prices may disable market comparison, but they must not hide or block valid CPC model projections/);
  assert.match(slate.text, /FAST READ/);
  assert.match(slate.text, /TOP SIDE POSTURES/);
  assert.match(slate.text, /TOP RUN ENVIRONMENTS/);
  assert.match(slate.text, /TOP PITCHER PROP SIGNALS/);
  assert.match(slate.text, /OPERATIONS WATCH/);
  assert.match(slate.text, /FULL SLATE BOARD/);
  assert.match(slate.text, /MODEL AVAILABILITY/);
  assert.match(slate.text, /DELIVERY AND AUDIT/);
  const requiredOrder = ['IMPORTANT', 'MARKET CONTEXT', 'FAST READ', 'OPERATIONS WATCH', 'FULL SLATE BOARD', 'MODEL AVAILABILITY', 'DELIVERY AND AUDIT'];
  let previous = -1;
  for (const heading of requiredOrder) {
    const current = slate.text.indexOf(heading);
    assert.ok(current > previous, `${heading} must follow the required wrapper order`);
    previous = current;
  }
  assert.doesNotMatch(slate.text, /TOP EDGE CANDIDATES|WATCHLIST \/ TRIGGER BOARD|FADES \/ OVERPRICED|BLOCKED \/ NEEDS SOURCE/);
  assert.doesNotMatch(slate.text, /AUDIT ARTIFACTS/);

  // 3. The customer body no longer duplicates per-contract trading buckets.
  assert.doesNotMatch(slate.text, /model: fair=|market: implied=|edge=|pass_rows_not_shown:/);
});

test('MLB slate packet renders a literal full slate board in schedule order', () => {
  const stats = (game_pk, away_team, home_team) => ({
    game_pk,
    away_team,
    home_team,
    venue: `${home_team} Park`,
    lineup_status: 'proxy',
    away_pitcher: { name: `${away_team} Starter`, mlb_id: game_pk * 10 + 1, era: 3.5, games_started: 15, batters_faced: 360, k_pct: 0.28 },
    home_pitcher: { name: `${home_team} Starter`, mlb_id: game_pk * 10 + 2, era: 4.2, games_started: 15, batters_faced: 360, k_pct: 0.25 },
    away_team_stats: { runs_scored: 410, runs_allowed: 360, gamesPlayed: 80 },
    home_team_stats: { runs_scored: 400, runs_allowed: 420, gamesPlayed: 80 },
    away_bullpen: { era: 4.0 },
    home_bullpen: { era: 4.8 },
  });
  const scoring = {
    picks: [
      prelineupPick({ matched_game_pk: 1 }),
      prelineupPick({
        matched_game_pk: undefined,
        game: 'New York Mets at Philadelphia Phillies',
        market_ticker: 'KXMLBTOTAL-2',
      }),
    ],
    source: '/tmp/picks.json',
    summaryCounts: { pre_lineup_pick: 2 },
  };
  const slate = buildMlbSlatePacket({
    date: '2026-05-29',
    scoring,
    slateGames: [
      { officialRecord: { game_pk: 1, start_time_utc: '2026-05-29T20:00:00Z', status: 'Scheduled' }, statsRecord: stats(1, 'Toronto Blue Jays', 'Baltimore Orioles') },
      { officialRecord: { game_pk: 2, start_time_utc: '2026-05-29T23:00:00Z', status: 'Scheduled' }, statsRecord: stats(2, 'New York Mets', 'Philadelphia Phillies') },
    ],
    leagueRPG: 4.4,
  });

  assert.match(slate.text, /FULL SLATE BOARD/);
  assert.match(slate.text, /GAME 1[\s\S]*Toronto Blue Jays AT Baltimore Orioles/);
  assert.match(slate.text, /GAME 2[\s\S]*New York Mets AT Philadelphia Phillies/);
  assert.ok(slate.text.indexOf('GAME 1') < slate.text.indexOf('GAME 2'), 'games stay in schedule order');
  assert.equal((slate.text.match(/LINEUP MODE: LAST_LOCKED_LINEUP_PROXY/g) || []).length, 2);
  assert.match(slate.text, /STARTING PITCHERS:[\s\S]*PROJECTED SCORE:/);
  assert.match(slate.text, /PROJECTED SCORE: Toronto Blue Jays \d+\.\d, Baltimore Orioles \d+\.\d/);
  assert.match(slate.text, /CPC PROJECTED SPREAD:/);
  assert.match(slate.text, /CPC PROJECTED TOTAL:/);
  assert.match(slate.text, /WIN PROBABILITY:/);
  assert.match(slate.text, /YRFI\/NRFI:/);
  assert.match(slate.text, /MODEL POSTURE:/);
});

test('MLB slate uses official mlb_status, labels started games as pregame proxy, and watches detected doubleheaders', () => {
  const stats = (game_pk, away_team, home_team) => ({
    game_pk,
    away_team,
    home_team,
    venue: `${home_team} Park`,
    lineup_status: 'proxy',
    away_pitcher: { name: `${away_team} Starter`, mlb_id: game_pk * 10 + 1, era: 3.5, games_started: 15, batters_faced: 360, k_pct: 0.28 },
    home_pitcher: { name: `${home_team} Starter`, mlb_id: game_pk * 10 + 2, era: 4.2, games_started: 15, batters_faced: 360, k_pct: 0.25 },
    away_team_stats: { runs_scored: 410, runs_allowed: 360, gamesPlayed: 80 },
    home_team_stats: { runs_scored: 400, runs_allowed: 420, gamesPlayed: 80 },
    away_bullpen: { era: 4.0 },
    home_bullpen: { era: 4.8 },
  });
  const scoring = {
    picks: [
      prelineupPick({ matched_game_pk: 1 }),
      prelineupPick({ matched_game_pk: 2, market_ticker: 'KXMLBTOTAL-DOUBLEHEADER-2' }),
    ],
    source: '/tmp/picks.json',
    summaryCounts: { pre_lineup_pick: 2 },
  };
  const slate = buildMlbSlatePacket({
    date: '2026-05-29',
    scoring,
    slateGames: [
      {
        officialRecord: { game_pk: 1, start_time_utc: '2026-05-29T20:00:00Z', mlb_status: 'In Progress' },
        statsRecord: stats(1, 'Toronto Blue Jays', 'Baltimore Orioles'),
      },
      {
        officialRecord: { game_pk: 2, start_time_utc: '2026-05-29T23:00:00Z', mlb_status: 'Scheduled' },
        statsRecord: stats(2, 'Toronto Blue Jays', 'Baltimore Orioles'),
      },
    ],
    leagueRPG: 4.4,
  });

  assert.match(slate.text, /GAME 1[\s\S]*STATUS: In Progress/);
  assert.match(slate.text, /PREGAME PROXY NOTICE: This is a pregame-proxy model context only[\s\S]*does not reflect live in-game state/);
  assert.match(slate.text, /GAME 1[\s\S]*PROJECTED SCORE: Toronto Blue Jays \d+\.\d, Baltimore Orioles \d+\.\d/);
  assert.match(slate.text, /GAME 2[\s\S]*STATUS: Scheduled/);
  assert.equal((slate.text.match(/\[DOUBLEHEADER_GAME\]/g) || []).length, 1);
  assert.match(slate.text, /\[DOUBLEHEADER_GAME\] Toronto Blue Jays AT Baltimore Orioles — status: In Progress \/ Scheduled; required action: Refresh bullpen usage, lineups, starters, and weather before the affected game\./);
});

test('BLOCKED MLB rows compact into event-level notes and never render score=MISSING rows', () => {
  const blockedPick = (market_ticker) => ({
    market_ticker,
    contract_title: 'Blocked HR market',
    game: 'Toronto Blue Jays at Baltimore Orioles',
    market_lane: 'home_run_hitter',
    classification: 'BLOCKED',
    fair_value: null,
    kalshi_ask: null,
    edge_pp: null,
    primary_pick: false,
    missing_confirmations: ['statcast_hr_optional_source_unavailable'],
    gates_passed: [],
  });

  const scoring = {
    picks: [
      blockedPick('KXMLB-HR-1'),
      blockedPick('KXMLB-HR-2'),
    ],
    source: '/tmp/picks.json',
    summaryCounts: { blocked: 2 },
  };
  const slate = buildMlbSlatePacket({ date: '2026-05-29', scoring, inventoryPath: '/tmp/inv.txt' });
  assert.ok(slate, 'slate packet built');
  assert.match(slate.text, /FULL SLATE BOARD/);
  assert.match(slate.text, /MODEL AVAILABILITY/);
  assert.match(slate.text, /MODEL_INPUTS_MISSING/);
  assert.doesNotMatch(slate.text, /BLOCKED \/ NEEDS SOURCE/);
  assert.doesNotMatch(slate.text, /#\d+\s+\[BLOCKED\]/);
  assert.doesNotMatch(slate.text, /score=MISSING/);
});

test('ranked MLB rows with score=MISSING compact into blocked notes instead of ranked rows', () => {
  const missingScorePick = (market_ticker, classification) => ({
    market_ticker,
    contract_title: 'Missing score market',
    game: 'Toronto Blue Jays at Baltimore Orioles',
    market_lane: 'moneyline',
    classification,
    fair_value: null,
    kalshi_ask: 0.51,
    edge_pp: 1.8,
    primary_pick: false,
    missing_confirmations: ['model_fair_missing'],
    gates_passed: ['starters'],
  });

  const scoring = {
    picks: [
      missingScorePick('KXMLB-MISS-1', 'LEAN'),
      missingScorePick('KXMLB-MISS-2', 'WATCH_FOR_LISTING'),
    ],
    source: '/tmp/picks.json',
    summaryCounts: { lean: 1, watch_for_listing: 1 },
  };
  const slate = buildMlbSlatePacket({ date: '2026-05-29', scoring, inventoryPath: '/tmp/inv.txt' });
  assert.ok(slate, 'slate packet built');
  assert.match(slate.text, /FULL SLATE BOARD/);
  assert.match(slate.text, /MODEL AVAILABILITY/);
  assert.match(slate.text, /MODEL_INPUTS_MISSING/);
  assert.doesNotMatch(slate.text, /BLOCKED \/ NEEDS SOURCE/);
  assert.doesNotMatch(slate.text, /\[\s*(LEAN|WATCH)\s*\]/, 'ranked rows must not survive with missing score');
  assert.doesNotMatch(slate.text, /score=MISSING/, 'missing-score rows must stay out of ranked sections');
});

test('market price is never folded into the composite score', () => {
  // Two picks identical except market price; composite_score must be identical.
  const a = mlbPickToDecisionRow(prelineupPick({ kalshi_ask: 0.77 }));
  const b = mlbPickToDecisionRow(prelineupPick({ kalshi_ask: 0.10 }));
  assert.equal(a.composite_score, b.composite_score, 'market price must not move composite score');
  assert.notEqual(a.edge_cents_or_pp, undefined);
});

test('null composite fair_value never renders NaN and is labeled as book-ref, not model fair', () => {
  // Real-world picks.json shape: the market-neutral composite produced no
  // probability (fair_value null) but a book-derived market_reference_prob and
  // edge_pp exist. The row must (a) never print NaN%, and (b) NOT claim the
  // book reference is the composite "model fair".
  const row = mlbPickToDecisionRow(prelineupPick({
    fair_value: null,
    market_reference_prob: 0.7438,
    kalshi_ask: 0.70,
    edge_pp: 4.382,
  }));
  assert.doesNotMatch(row.analysis, /NaN/, 'must never emit NaN in the analysis line');
  assert.match(row.analysis, /book-ref \(not composite\)/, 'book reference must be labeled honestly');
  assert.doesNotMatch(row.analysis, /model fair \d/, 'a null composite must NOT be presented as model fair');
  assert.match(row.analysis, /74% vs market 70% = \+4\.4pp/, 'book-ref edge math still rendered');
  // Composite score stays MISSING because the neutral model gave no probability.
  assert.equal(row.composite_score, null);
});

test('present composite fair_value is labeled as model fair', () => {
  const row = mlbPickToDecisionRow(prelineupPick({ fair_value: 0.8504, kalshi_ask: 0.77, edge_pp: 8.04 }));
  assert.match(row.analysis, /model fair 85% vs market 77%/);
  assert.doesNotMatch(row.analysis, /book-ref/);
});
