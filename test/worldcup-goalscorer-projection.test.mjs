// World Cup anytime-goalscorer projection tests.
//
// Pins the player-level contract:
//   - team goals are allocated to player projections
//   - minutes and start probability move exposure
//   - xG, shot share, and bounded role boosts influence scoring
//   - anytime probability is derived from the player goal mean
//   - missing data blocks cleanly
//   - price / board / liquidity fields are ignored
//   - output is deterministic and price-free

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LISTED_PLAYER_ALLOCATION_SHARE,
  PROJECTION_STATUS,
  LINEUP_STATUS,
  projectAnytimeGoalscorer,
  projectAnytimeGoalscorers,
} from '../scripts/worldcup/lib/goalscorer-projection.mjs';

function player(overrides = {}) {
  return {
    player_id: 'p-1',
    player_name: 'Player One',
    team_side: 'home',
    position: 'forward',
    lineup_status: LINEUP_STATUS.CONFIRMED_XI,
    start_probability: 0.82,
    expected_minutes: 78,
    xg_per_90: 0.45,
    shot_share: 0.28,
    penalty_role: false,
    set_piece_role: false,
    ...overrides,
  };
}

function pool(overrides = {}) {
  return {
    match: { match_id: 'wc-1', home_team: 'A', away_team: 'B' },
    team_side: 'home',
    projected_team_goals: 2.4,
    lineup_status: LINEUP_STATUS.CONFIRMED_XI,
    player_candidates: [
      player({ player_id: 'starter', player_name: 'Starter', start_probability: 0.9, expected_minutes: 84, xg_per_90: 0.52, shot_share: 0.34 }),
      player({ player_id: 'runner', player_name: 'Runner', start_probability: 0.55, expected_minutes: 46, xg_per_90: 0.22, shot_share: 0.12 }),
    ],
    ...overrides,
  };
}

function single(overrides = {}) {
  return {
    projected_team_goals: 2.4,
    player: player(overrides),
  };
}

test('team projected goals allocate into player expected goals', () => {
  const out = projectAnytimeGoalscorers(pool());
  const total = out.players.reduce((sum, p) => sum + (p.projected_player_goals ?? 0), 0);
  assert.ok(total > 0, 'players should receive goal allocation');
  assert.ok(total <= out.projected_team_goals * out.allocation_share + 1e-9,
    'listed-player allocation must stay within the documented share');
});

test('higher expected minutes increases projected player goals', () => {
  const out = projectAnytimeGoalscorers(pool({
    player_candidates: [
      player({ player_id: 'low-min', expected_minutes: 32, start_probability: 0.68, xg_per_90: 0.32 }),
      player({ player_id: 'high-min', expected_minutes: 82, start_probability: 0.68, xg_per_90: 0.32 }),
    ],
  }));
  const low = out.players.find((p) => p.player_id === 'low-min');
  const high = out.players.find((p) => p.player_id === 'high-min');
  assert.ok(high.projected_player_goals > low.projected_player_goals,
    `${high.projected_player_goals} should exceed ${low.projected_player_goals}`);
});

test('higher start probability increases projected player goals', () => {
  const out = projectAnytimeGoalscorers(pool({
    player_candidates: [
      player({ player_id: 'low-start', start_probability: 0.25, expected_minutes: 60, xg_per_90: 0.32 }),
      player({ player_id: 'high-start', start_probability: 0.92, expected_minutes: 60, xg_per_90: 0.32 }),
    ],
  }));
  const low = out.players.find((p) => p.player_id === 'low-start');
  const high = out.players.find((p) => p.player_id === 'high-start');
  assert.ok(high.projected_player_goals > low.projected_player_goals,
    `${high.projected_player_goals} should exceed ${low.projected_player_goals}`);
});

test('player xG per 90 increases projected player goals', () => {
  const out = projectAnytimeGoalscorers(pool({
    player_candidates: [
      player({ player_id: 'low-xg', xg_per_90: 0.12 }),
      player({ player_id: 'high-xg', xg_per_90: 0.48 }),
    ],
  }));
  const low = out.players.find((p) => p.player_id === 'low-xg');
  const high = out.players.find((p) => p.player_id === 'high-xg');
  assert.ok(high.projected_player_goals > low.projected_player_goals,
    `${high.projected_player_goals} should exceed ${low.projected_player_goals}`);
});

test('penalty-taker role increases projected player goals within a bounded cap', () => {
  const out = projectAnytimeGoalscorers(pool({
    player_candidates: [
      player({ player_id: 'base', penalty_role: false, xg_per_90: 0.34 }),
      player({ player_id: 'penalty', penalty_role: true, xg_per_90: 0.34 }),
    ],
  }));
  const base = out.players.find((p) => p.player_id === 'base');
  const boosted = out.players.find((p) => p.player_id === 'penalty');
  assert.ok(boosted.projected_player_goals > base.projected_player_goals, 'penalty role should help');
  assert.ok(boosted.projected_player_goals <= base.projected_player_goals * 1.20 + 1e-9,
    'penalty boost must remain bounded');
});

test('anytime probability equals 1 - exp(-projected_player_goals)', () => {
  const out = projectAnytimeGoalscorer(single());
  const expected = 1 - Math.exp(-out.projected_player_goals);
  assert.ok(Math.abs(out.anytime_goal_probability - expected) < 5e-5,
    `${out.anytime_goal_probability} should equal ${expected}`);
});

test('missing player id, name, or team side blocks cleanly', () => {
  const missingId = projectAnytimeGoalscorer(single({ player_id: null }));
  const missingName = projectAnytimeGoalscorer(single({ player_name: null }));
  const missingSide = projectAnytimeGoalscorer(single({ team_side: null }));
  for (const out of [missingId, missingName, missingSide]) {
    assert.equal(out.projection_status, PROJECTION_STATUS.BLOCKED_PLAYER_DATA_MISSING);
    assert.equal(out.projected_player_goals, null);
    assert.equal(out.anytime_goal_probability, null);
  }
});

test('missing team goal projection blocks cleanly', () => {
  const out = projectAnytimeGoalscorers({
    ...pool(),
    projected_team_goals: null,
  });
  assert.equal(out.players[0].projection_status, PROJECTION_STATUS.BLOCKED_TEAM_GOALS_MISSING);
  assert.equal(out.players[0].projected_player_goals, null);
  assert.equal(out.players[0].anytime_goal_probability, null);
});

test('pre-lock player is labeled PROVISIONAL_PRE_LOCK or LINEUP_SENSITIVE, not READY', () => {
  const preLock = projectAnytimeGoalscorer(single({
    lineup_status: LINEUP_STATUS.PRE_LOCK_PROJECTED,
    xg_per_90: null,
  }));
  assert.notEqual(preLock.projection_status, PROJECTION_STATUS.READY);
  assert.ok(
    preLock.projection_status === PROJECTION_STATUS.PROVISIONAL_PRE_LOCK
      || preLock.projection_status === PROJECTION_STATUS.LINEUP_SENSITIVE,
    preLock.projection_status,
  );
});

test('confirmed starter can be READY', () => {
  const out = projectAnytimeGoalscorer(single({
    lineup_status: LINEUP_STATUS.CONFIRMED_XI,
    start_probability: 0.92,
    expected_minutes: 86,
  }));
  assert.equal(out.projection_status, PROJECTION_STATUS.READY);
});

test('bench-only player receives lower exposure than starter', () => {
  const out = projectAnytimeGoalscorers(pool({
    player_candidates: [
      player({
        player_id: 'starter',
        start_probability: 0.92,
        expected_minutes: 84,
        xg_per_90: 0.42,
      }),
      player({
        player_id: 'bench',
        start_probability: 0.18,
        expected_minutes: 18,
        bench_entry_probability: 0.72,
        xg_per_90: 0.42,
      }),
    ],
  }));
  const starter = out.players.find((p) => p.player_id === 'starter');
  const bench = out.players.find((p) => p.player_id === 'bench');
  assert.ok(bench.projected_player_goals < starter.projected_player_goals,
    `${bench.projected_player_goals} should be below ${starter.projected_player_goals}`);
});

test('total listed-player allocation is bounded and documented', () => {
  const out = projectAnytimeGoalscorers(pool({ projected_team_goals: 2.8 }));
  const sum = out.players.reduce((acc, p) => acc + (p.projected_player_goals ?? 0), 0);
  assert.equal(out.allocation_share, LISTED_PLAYER_ALLOCATION_SHARE);
  assert.ok(sum <= out.projected_team_goals * out.allocation_share + 1e-9,
    'listed player sum should not exceed the documented share');
});

test('price, board, liquidity, and sportsbook-style fields do not change the projection', () => {
  const clean = projectAnytimeGoalscorers(pool());
  const dirty = projectAnytimeGoalscorers(pool({
    player_candidates: [
      player({
        player_id: 'starter',
        player_name: 'Starter',
        start_probability: 0.9,
        expected_minutes: 84,
        xg_per_90: 0.52,
        shot_share: 0.34,
        yes_bid: 0.41,
        yes_ask: 0.44,
        last_price: 0.42,
        price: 42,
        bid: 41,
        ask: 44,
        volume: 9000,
        open_interest: 1200,
        liquidity: 123,
        orderbook: { yes: [41, 42], no: [58, 59] },
        board: 'ignore-me',
        sportsbook_odds: '+150',
        implied_price: 0.42,
      }),
      player({
        player_id: 'runner',
        player_name: 'Runner',
        start_probability: 0.55,
        expected_minutes: 46,
        xg_per_90: 0.22,
        shot_share: 0.12,
        yes_bid: 0.21,
        yes_ask: 0.24,
        last_price: 0.22,
        price: 22,
        bid: 21,
        ask: 24,
        volume: 1000,
        open_interest: 200,
      }),
    ],
  }));
  assert.deepEqual(dirty.players.map((p) => ({
    id: p.player_id,
    g: p.projected_player_goals,
    p: p.anytime_goal_probability,
    s: p.projection_status,
  })), clean.players.map((p) => ({
    id: p.player_id,
    g: p.projected_player_goals,
    p: p.anytime_goal_probability,
    s: p.projection_status,
  })));
});

test('output is deterministic for the same inputs', () => {
  const a = projectAnytimeGoalscorers(pool());
  const b = projectAnytimeGoalscorers(pool());
  assert.deepEqual(a, b);
});

test('no local filesystem paths or raw market-price fields appear in output', () => {
  const out = projectAnytimeGoalscorers(pool());
  const json = JSON.stringify(out);
  for (const forbidden of [
    '/home/',
    '/Users/',
    '"yes_bid"',
    '"yes_ask"',
    '"last_price"',
    '"open_interest"',
    '"orderbook"',
    '"volume"',
    '"bid"',
    '"ask"',
    '"sportsbook_odds"',
  ]) {
    assert.ok(!json.includes(forbidden), `forbidden token ${forbidden} leaked into output`);
  }
});
