'use strict';

const assert = require('node:assert/strict');
const { before, test } = require('node:test');

let composeEvidenceLedgerForGame;
let composeMultiLaneCeilingBoard;
let renderWorldCupPacket;

before(async () => {
  const evidence = await import('../../scripts/worldcup/lib/evidence-ledger.mjs');
  const ceiling = await import('../../scripts/worldcup/lib/multi-lane-ceiling.mjs');
  const renderer = await import('../../scripts/worldcup/lib/packet-renderer.mjs');
  composeEvidenceLedgerForGame = evidence.composeEvidenceLedgerForGame;
  composeMultiLaneCeilingBoard = ceiling.composeMultiLaneCeilingBoard;
  renderWorldCupPacket = renderer.renderWorldCupPacket;
});

function r(score) {
  return { present: true, score };
}

function fullSide(score) {
  return {
    team_quality_baseline: r(score),
    recent_form: r(score),
    attacking_strength: r(score),
    defensive_strength: r(score),
    opponent_adjusted_attack: r(score),
    opponent_adjusted_defense: r(score),
    opponent_style_fit: r(score),
    set_piece_matchup: r(score),
    goalkeeper_edge: r(score),
    squad_availability: r(score),
    lineup_strength_delta: r(score),
    rest_travel_venue_climate: r(score),
    tournament_incentive_state: r(score),
    knockout_extra_time_penalty: r(score),
  };
}

function makeFixture({ modelConsumesLineup }) {
  const match = {
    match_id: 'wc-gate-001',
    home_team: 'Mexico',
    away_team: 'South Africa',
    group: 'A',
    stage: 'group',
    kickoff_utc: '2026-06-11T19:00:00Z',
    lineup_status: 'lineup_confirmed',
    model_consumes_lineup: modelConsumesLineup,
  };
  const ledger = composeEvidenceLedgerForGame(fullSide(85), fullSide(55));
  const board = composeMultiLaneCeilingBoard({
    homeLedger: ledger.home,
    awayLedger: ledger.away,
    marketContexts: [{ ticker: 'KXWC-MEX', market_type: 'match_winner', implied_probability: 0.58 }],
    isKnockout: false,
    lineupConfirmed: true,
  });
  return { match, board };
}

test('stale confirmed-lineup packet holds the forecast and moves prior composites into audit only', () => {
  const { match, board } = makeFixture({ modelConsumesLineup: false });
  const rendered = renderWorldCupPacket({
    matches: [match],
    boards: [board],
    meta: { date: '2026-06-11', packet_stage: 'lineup_locked' },
  });

  const homeGoals = String(board.goal_projection.projected_home_goals);
  const awayGoals = String(board.goal_projection.projected_away_goals);
  const totalGoals = String(board.goal_projection.projected_total_goals);
  const bttsPct = `${Math.round((board.lanes.find((entry) => entry.lane === 'both_teams_to_score')?.p_btts_yes ?? 0) * 100)}%`;

  assert.match(rendered, /FORECAST HELD/);
  assert.ok(!rendered.includes(homeGoals), `stale render leaked home goals ${homeGoals}`);
  assert.ok(!rendered.includes(awayGoals), `stale render leaked away goals ${awayGoals}`);
  assert.ok(!rendered.includes(totalGoals), `stale render leaked total goals ${totalGoals}`);
  assert.ok(!rendered.includes(bttsPct), `stale render leaked BTTS ${bttsPct}`);
  assert.ok(match._audit_suppressed_forecast?.prior_composite, 'audit artifact should keep suppressed composite data');
  assert.match(match._audit_suppressed_forecast.prior_composite.goalForecastLine, /Projected goals/);
  assert.match(match._audit_suppressed_forecast.prior_composite.totalGoalsForecastLine, /Projected total/);
});

test('active confirmed-lineup packet keeps the projections public and omits the hold banner', () => {
  const { match, board } = makeFixture({ modelConsumesLineup: true });
  const rendered = renderWorldCupPacket({
    matches: [match],
    boards: [board],
    meta: { date: '2026-06-11', packet_stage: 'lineup_locked' },
  });

  const homeGoals = String(board.goal_projection.projected_home_goals);
  const awayGoals = String(board.goal_projection.projected_away_goals);
  const totalGoals = String(board.goal_projection.projected_total_goals);
  const bttsPct = `${Math.round((board.lanes.find((entry) => entry.lane === 'both_teams_to_score')?.p_btts_yes ?? 0) * 100)}%`;

  assert.ok(!rendered.includes('FORECAST HELD'));
  assert.ok(rendered.includes(homeGoals), `active render should include home goals ${homeGoals}`);
  assert.ok(rendered.includes(awayGoals), `active render should include away goals ${awayGoals}`);
  assert.ok(rendered.includes(totalGoals), `active render should include total goals ${totalGoals}`);
  assert.ok(rendered.includes(bttsPct), `active render should include BTTS ${bttsPct}`);
  assert.equal(match._audit_suppressed_forecast, undefined);
});

test('confirmed lineup without model_consumes_lineup stays held', () => {
  const { match, board } = makeFixture({ modelConsumesLineup: undefined });
  const rendered = renderWorldCupPacket({
    matches: [match],
    boards: [board],
    meta: { date: '2026-06-11', packet_stage: 'lineup_locked' },
  });

  assert.match(rendered, /FORECAST HELD/);
  assert.ok(!rendered.includes('Goal forecast: Projected goals:'), 'missing model consumption must not publish forecast lines');
  assert.ok(match._audit_suppressed_forecast?.prior_composite, 'suppressed forecast should be preserved for audit only');
});
