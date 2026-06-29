// World Cup market parser + market-family packet tests.
//
// Pins: 1X2 (incl. Draw), spread/handicap, totals, BTTS, 1st-half variants,
// settlement-scope normalization (90'+stoppage default), ambiguity → unknown
// (never guessed), and packet routing of every family.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMarketContract } from '../scripts/worldcup/lib/market-parser.mjs';
import { normalizeMarketContext } from '../scripts/worldcup/source-adapters/market-context.mjs';
import { composeEvidenceLedgerForGame } from '../scripts/worldcup/lib/evidence-ledger.mjs';
import { composeMultiLaneCeilingBoard, LANES } from '../scripts/worldcup/lib/multi-lane-ceiling.mjs';
import { renderWorldCupPacket } from '../scripts/worldcup/lib/packet-renderer.mjs';

const TEAMS = { homeTeam: 'Mexico', awayTeam: 'South Africa' };

// ---------------------------------------------------------------------------
// 1X2
// ---------------------------------------------------------------------------

test('parses 1X2: Team A win, Team B win, Draw', () => {
  const home = parseMarketContract({ title: 'Will Mexico win the match?', ...TEAMS });
  assert.equal(home.market_family, '1x2');
  assert.equal(home.side, 'home');
  assert.equal(home.market_type, 'match_winner');

  const away = parseMarketContract({ title: 'South Africa beats Mexico', ...TEAMS });
  assert.equal(away.market_family, '1x2');
  assert.equal(away.side, 'away', 'team named as winner anchors the side even when both teams appear');

  const draw = parseMarketContract({ title: 'Match ends in a draw', ...TEAMS });
  assert.equal(draw.market_family, '1x2');
  assert.equal(draw.side, 'draw');
});

// ---------------------------------------------------------------------------
// Spread / handicap
// ---------------------------------------------------------------------------

test('parses full-game spread/handicap with team and line', () => {
  const p = parseMarketContract({ title: 'Mexico wins by over 1.5 goals', ...TEAMS });
  assert.equal(p.market_family, 'spread');
  assert.equal(p.period, 'full');
  assert.equal(p.side, 'home');
  assert.equal(p.line, 1.5);
  assert.equal(p.market_type, 'spread_full_game');
});

test('parses 1st-half spread/handicap', () => {
  const p = parseMarketContract({ title: '1st half: South Africa covers the 0.5 goal line', ...TEAMS });
  assert.equal(p.market_family, 'spread');
  assert.equal(p.period, 'first_half');
  assert.equal(p.side, 'away');
  assert.equal(p.line, 0.5);
  assert.equal(p.market_type, 'spread_first_half');
});

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

test('parses full-game total over/under', () => {
  const over = parseMarketContract({ title: 'Total goals over 2.5', ...TEAMS });
  assert.equal(over.market_family, 'total');
  assert.equal(over.side, 'over');
  assert.equal(over.line, 2.5);
  assert.equal(over.market_type, 'total_goals');

  const under = parseMarketContract({ title: 'Combined goals under 1.5', ...TEAMS });
  assert.equal(under.side, 'under');
  assert.equal(under.line, 1.5);
});

test('parses 1st-half total', () => {
  const p = parseMarketContract({ title: 'First half total goals over 0.5', ...TEAMS });
  assert.equal(p.market_family, 'total');
  assert.equal(p.period, 'first_half');
  assert.equal(p.line, 0.5);
  assert.equal(p.market_type, 'total_goals_first_half');
});

// ---------------------------------------------------------------------------
// BTTS
// ---------------------------------------------------------------------------

test('parses full-game and 1st-half BTTS', () => {
  const full = parseMarketContract({ title: 'Both teams to score', ...TEAMS });
  assert.equal(full.market_family, 'btts');
  assert.equal(full.period, 'full');
  assert.equal(full.market_type, 'both_teams_to_score');

  const half = parseMarketContract({ title: 'Both teams to score in the 1st half', ...TEAMS });
  assert.equal(half.market_family, 'btts');
  assert.equal(half.period, 'first_half');
  assert.equal(half.market_type, 'btts_first_half');
});

// ---------------------------------------------------------------------------
// Settlement scope
// ---------------------------------------------------------------------------

test('settlement defaults to regulation 90 + stoppage when contract is silent', () => {
  const p = parseMarketContract({ title: 'Will Mexico win the match?', ...TEAMS });
  assert.equal(p.settlement.scope, 'regulation_90_plus_stoppage');
  assert.equal(p.settlement.explicit, false, 'silent contract → default, marked non-explicit');
});

test('settlement includes ET/penalties ONLY when contract says so', () => {
  const et = parseMarketContract({ title: 'Mexico wins including extra time', ...TEAMS });
  assert.equal(et.settlement.scope, 'includes_extra_time');
  assert.equal(et.settlement.explicit, true);

  const pens = parseMarketContract({ title: 'Mexico to advance', ...TEAMS });
  assert.equal(pens.settlement.scope, 'includes_penalties');
  assert.equal(pens.market_family, 'to_advance');

  const reg = parseMarketContract({ title: 'Mexico wins in regulation', ...TEAMS });
  assert.equal(reg.settlement.scope, 'regulation_90_plus_stoppage');
  assert.equal(reg.settlement.explicit, true);
});

// ---------------------------------------------------------------------------
// Ambiguity → unknown, never guessed
// ---------------------------------------------------------------------------

test('ambiguous contracts return unknown with low confidence instead of a guess', () => {
  const noTeam = parseMarketContract({ title: 'Winner of the big game', ...TEAMS });
  assert.equal(noTeam.market_family, 'unknown');
  assert.equal(noTeam.parse_confidence, 'low');

  const noLine = parseMarketContract({ title: 'Mexico covers the spread', ...TEAMS });
  assert.equal(noLine.market_family, 'unknown');
});

// ---------------------------------------------------------------------------
// normalizeMarketContext integration — prices stripped, parse attached
// ---------------------------------------------------------------------------

test('normalizeMarketContext attaches parse and strips raw price fields', () => {
  const ctx = normalizeMarketContext(
    { ticker: 'KXWC-TOT', title: 'Total goals over 2.5', yes_bid: 0.44, yes_ask: 0.5, volume: 8000, open_interest: 300 },
    TEAMS,
  );
  assert.equal(ctx.market_family, 'total');
  assert.equal(ctx.line, 2.5);
  assert.equal(ctx.settlement.scope, 'regulation_90_plus_stoppage');
  assert.ok(Math.abs(ctx.implied_probability - 0.47) < 1e-9);
  const json = JSON.stringify(ctx);
  for (const k of ['"yes_bid"', '"yes_ask"', '"volume"', '"open_interest"', '"last_price"']) {
    assert.ok(!json.includes(k), `raw price field ${k} must be stripped`);
  }
});

// ---------------------------------------------------------------------------
// Packet routing — every family appears on the sectioned board
// ---------------------------------------------------------------------------

const r = (score) => ({ present: true, score });
function side(base, atk = base, def = base) {
  return {
    team_quality_baseline: r(base), recent_form: r(base),
    attacking_strength: r(atk), defensive_strength: r(def),
    opponent_adjusted_attack: r(base), opponent_adjusted_defense: r(base),
    opponent_style_fit: r(base), set_piece_matchup: r(base), goalkeeper_edge: r(base),
    squad_availability: r(base), lineup_strength_delta: r(base),
    rest_travel_venue_climate: r(base), tournament_incentive_state: r(base),
    knockout_extra_time_penalty: r(base),
  };
}

function boardWithMarkets(markets) {
  const ledger = composeEvidenceLedgerForGame(side(75), side(60));
  return composeMultiLaneCeilingBoard({
    homeLedger: ledger.home,
    awayLedger: ledger.away,
    marketContexts: markets.map(m => normalizeMarketContext(m, TEAMS)).filter(Boolean),
    isKnockout: false,
    lineupConfirmed: true,
  });
}

const CONTRACT_SET = [
  { ticker: 'K1X2H', title: 'Will Mexico win the match?', yes_bid: 0.5, yes_ask: 0.56 },
  { ticker: 'K1X2D', title: 'Match ends in a draw', yes_bid: 0.26, yes_ask: 0.3 },
  { ticker: 'KSPR', title: 'Mexico wins by over 1.5 goals', yes_bid: 0.2, yes_ask: 0.26 },
  { ticker: 'KTOT', title: 'Total goals over 2.5', yes_bid: 0.44, yes_ask: 0.5 },
  { ticker: 'KTOT1H', title: 'First half total goals over 0.5', yes_bid: 0.6, yes_ask: 0.66 },
  { ticker: 'KBTTS', title: 'Both teams to score', yes_bid: 0.4, yes_ask: 0.46 },
  { ticker: 'KBTTS1H', title: 'Both teams to score in the 1st half', yes_bid: 0.1, yes_ask: 0.16 },
];

test('all market families route to lanes and render on the sectioned board', () => {
  const board = boardWithMarkets(CONTRACT_SET);
  const byLane = Object.fromEntries(board.lanes.map(l => [l.lane, l]));

  assert.ok(byLane.match_winner.market_context, '1X2 market attached');
  assert.ok(byLane.spread_full_game.market_context, 'spread market attached');
  assert.equal(byLane.spread_full_game.market_context.line, 1.5);
  assert.ok(byLane.total_goals.market_context, 'total market attached');
  assert.ok(byLane.both_teams_to_score.market_context, 'BTTS market attached');
  assert.ok(byLane.total_goals_first_half.market_context, '1H total attached as reference');
  assert.ok(byLane.btts_first_half.market_context, '1H BTTS attached as reference');

  const match = { match_id: 'm1', home_team: 'Mexico', away_team: 'South Africa', stage: 'group', kickoff_utc: '2026-06-11T19:00:00Z', lineup_status: 'lineup_confirmed', lineup_locked_verified: false, model_consumes_lineup: true };
  const text = renderWorldCupPacket({ matches: [match], boards: [board], meta: { date: '2026-06-11' } });

  // Forecast-language match breakdown (new soccer-handicapping renderer).
  assert.ok(text.includes('Match forecast: Mexico rates higher'), 'match-result forecast rendered');
  assert.ok(text.includes('Model-rated side (forecast only)'), 'forecast summary rendered');
  assert.ok(/Goal forecast: Projected goals: Mexico [\d.]+, South Africa [\d.]+/.test(text),
    'goal forecast rendered in soccer language');
  assert.ok(/Total goals forecast: Projected total [\d.]+/.test(text), 'total goals forecast rendered');
  assert.ok(/Both-score forecast: \d+%/.test(text), 'BTTS forecast rendered');
  assert.ok(/Goal-spread forecast: Mexico \+[\d.]+ goals/.test(text), 'goal-spread forecast rendered');
  // Markets are shown as display-only context, not scored.
  assert.ok(text.includes('3. Market Comparison') && text.includes('NOT IN SCORE'),
    'market comparison rendered as display-only');
  // First-half lanes stay unmodeled, surfaced in Model Limits — no fake 1H modeling.
  assert.ok(text.includes('First-half markets are unavailable because no half-split model layer is sourced.'),
    '1H lanes disclosed as model-unavailable, not modeled');
});

test('1st-half lanes are BLOCKED_MODEL_LAYER_MISSING — no fake 1H modeling, no edge', () => {
  const board = boardWithMarkets(CONTRACT_SET);
  for (const key of ['match_winner_first_half', 'spread_first_half', 'total_goals_first_half', 'btts_first_half']) {
    const lane = board.lanes.find(l => l.lane === key);
    assert.equal(lane.recommendation, 'BLOCKED_MODEL_LAYER_MISSING', `${key} must be blocked`);
    assert.equal(lane.edge_home_pp, null);
    assert.equal(lane.edge_away_pp, null);
    assert.equal(lane.edge_draw_pp, null);
  }
});

test('totals/BTTS with missing attack/defense layers block instead of defaulting to 50', () => {
  const thin = {
    team_quality_baseline: r(70), recent_form: r(70), opponent_adjusted_attack: r(70),
    opponent_adjusted_defense: r(70), squad_availability: r(70),
  };
  const ledger = composeEvidenceLedgerForGame(thin, thin);
  const board = composeMultiLaneCeilingBoard({ homeLedger: ledger.home, awayLedger: ledger.away });
  assert.equal(board.lanes.find(l => l.lane === 'total_goals').recommendation, 'BLOCKED_MODEL_LAYER_MISSING');
  assert.equal(board.lanes.find(l => l.lane === 'both_teams_to_score').recommendation, 'BLOCKED_MODEL_LAYER_MISSING');
  assert.equal(board.lanes.find(l => l.lane === 'spread_full_game').recommendation, 'BLOCKED_MODEL_LAYER_MISSING');
});

test('raw market inventory stays audit-only with the full contract set attached', () => {
  const board = boardWithMarkets(CONTRACT_SET);
  const match = { match_id: 'm1', home_team: 'Mexico', away_team: 'South Africa', stage: 'group', kickoff_utc: '2026-06-11T19:00:00Z', lineup_status: 'lineup_confirmed', lineup_locked_verified: false, model_consumes_lineup: true };
  const text = renderWorldCupPacket({ matches: [match], boards: [board], meta: { date: '2026-06-11' } });
  for (const forbidden of ['yes_bid', 'yes_ask', 'no_bid', 'no_ask', 'open_interest', 'last_price', 'volume', 'orderbook']) {
    assert.ok(!text.includes(forbidden), `raw market field "${forbidden}" leaked into main packet`);
  }
});

test('LANES cover all required market families', () => {
  const keys = LANES.map(l => l.key);
  for (const k of ['match_winner', 'spread_full_game', 'total_goals', 'both_teams_to_score',
    'match_winner_first_half', 'spread_first_half', 'total_goals_first_half', 'btts_first_half']) {
    assert.ok(keys.includes(k), `lane ${k} missing`);
  }
});
