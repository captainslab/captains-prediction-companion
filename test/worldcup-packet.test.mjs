// World Cup packet shape tests.
//
// Pins the decision-board contract:
//   - all required sections render
//   - missing lineups → BLOCKED row + pre-lineup PICK downgrade (no fake pick)
//   - market is labeled NOT IN SCORE
//   - no raw market inventory / raw price fields dumped into the main packet

import test from 'node:test';
import assert from 'node:assert/strict';

import { composeEvidenceLedgerForGame } from '../scripts/worldcup/lib/evidence-ledger.mjs';
import { composeMultiLaneCeilingBoard } from '../scripts/worldcup/lib/multi-lane-ceiling.mjs';
import { renderWorldCupPacket } from '../scripts/worldcup/lib/packet-renderer.mjs';

const r = (score) => ({ present: true, score });

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

function makeFixture({ lineupStatus = 'lineup_pending', homeScore = 85, awayScore = 55, lineupConfirmed = lineupStatus === 'lineup_confirmed' } = {}) {
  const match = {
    match_id: '400021443',
    home_team: 'Mexico',
    away_team: 'South Africa',
    group: 'A',
    stage: 'group',
    kickoff_utc: '2026-06-11T19:00:00Z',
    lineup_status: lineupStatus,
  };
  const ledger = composeEvidenceLedgerForGame(fullSide(homeScore), fullSide(awayScore));
  const board = composeMultiLaneCeilingBoard({
    homeLedger: ledger.home,
    awayLedger: ledger.away,
    marketContexts: [{ ticker: 'KXWC-MEX', market_type: 'match_winner', implied_probability: 0.58 }],
    isKnockout: false,
    lineupConfirmed,
  });
  return { match, board };
}

const REQUIRED_SECTIONS = [
  'Daily Slate Preview — Why Today Matters',
  '1. Matchday Forecast',
  '2. Match Breakdowns',
  '3. Market Comparison',
  '4. Model Limits',
  '5. Source Quality',
];

// Betting-tout shorthand that must NEVER appear as user-facing packet text.
// Internal enums may keep these names, but the rendered packet must not.
const BANNED_USER_FACING = [
  /\bPICK\b/, /\bLEAN\b/, /\bWATCH\b/, /\bFADE\b/, /\bOVERPRICED\b/,
  /TOP EDGE CANDIDATES/, /TRIGGER BOARD/, /winner_lean/, /\bno edge\b/i,
  /projection-only/,
];

test('packet renders every required section', () => {
  const { match, board } = makeFixture();
  const text = renderWorldCupPacket({ matches: [match], boards: [board], meta: { date: '2026-06-11' } });
  for (const s of REQUIRED_SECTIONS) {
    assert.ok(text.includes(s), `packet missing section: ${s}`);
  }
  assert.ok(text.includes('No trades placed by this workflow.'));
});

test('missing lineups → match disclosed as pre-lock and no full PICK is emitted', () => {
  const { match, board } = makeFixture({ lineupStatus: 'lineup_pending' });
  const text = renderWorldCupPacket({ matches: [match], boards: [board], meta: { date: '2026-06-11' } });
  // New contract: pre-lineup matches are not held back, but must be clearly
  // disclosed as pre-lock forecast-only output that uses the prior composite.
  assert.ok(text.includes('Status: Pre-lock, lineups not confirmed'),
    'pending lineups must be disclosed as pre-lock');
  assert.ok(text.includes("Model basis: latest prior team composite, not today's confirmed XI"),
    'pre-lock model basis must be stated');
  assert.ok(/Model-projected edges \(forecast only\)/.test(text),
    'edges must be framed as forecast-only');
  assert.ok(!/PICK_HOME|PICK_AWAY/.test(text),
    'no full PICK enum may be emitted while lineups are unconfirmed');
  assert.ok(!text.includes('LINEUP LOCKED'), 'pre-lock packet must not claim a locked lineup');
});

test('confirmed lineups with strong evidence → clear model side, marked lineup-locked', () => {
  const { match, board } = makeFixture({ lineupStatus: 'lineup_confirmed' });
  const text = renderWorldCupPacket({ matches: [match], boards: [board], meta: { date: '2026-06-11', packet_stage: 'lineup_locked' } });
  assert.ok(/Match forecast: Mexico result edge/.test(text), 'strong confirmed-lineup edge should produce a clear model side');
  assert.ok(text.includes('Status: LINEUP LOCKED — official starting XI confirmed'),
    'confirmed lineups must be marked lineup-locked');
  assert.ok(!/\bPICK\b/.test(text), 'no raw PICK enum in user-facing text');
  assert.ok(!text.includes('Status: Pre-lock'), 'locked match must not be flagged pre-lock');
});

test('market context is labeled NOT IN SCORE and shown as display-only', () => {
  const { match, board } = makeFixture();
  const text = renderWorldCupPacket({ matches: [match], boards: [board], meta: { date: '2026-06-11' } });
  assert.ok(text.includes('3. Market Comparison'), 'market comparison section must render');
  assert.ok(text.includes('NOT IN SCORE'), 'market must be labeled NOT IN SCORE');
  assert.ok(text.includes('Market prices are display-only when present and are NOT IN SCORE.'),
    'market prices must be disclosed as display-only and not scored');
});

test('no raw market inventory or raw price fields leak into the main packet', () => {
  const { match, board } = makeFixture();
  const text = renderWorldCupPacket({ matches: [match], boards: [board], meta: { date: '2026-06-11' } });
  for (const forbidden of ['yes_bid', 'yes_ask', 'no_bid', 'no_ask', 'open_interest', 'last_price', 'volume', 'orderbook', '"ticker"']) {
    assert.ok(!text.includes(forbidden), `raw market field "${forbidden}" leaked into main packet`);
  }
  // The packet references markets as display-only context, never dumps raw inventory.
  assert.ok(text.includes('market lines attached'), 'market comparison must summarize lines, not dump them');
});

test('packet stays mobile-readable (bounded length per match)', () => {
  const { match, board } = makeFixture();
  const text = renderWorldCupPacket({ matches: [match], boards: [board], meta: { date: '2026-06-11' } });
  assert.ok(text.length < 8000, `single-match packet should stay compact, got ${text.length} chars`);
});

function makeGoalFixture() {
  const match = {
    match_id: '400021480',
    home_team: 'Brazil',
    away_team: 'Serbia',
    group: 'G',
    stage: 'group',
    kickoff_utc: '2026-06-22T17:00:00Z',
    lineup_status: 'lineup_pending',
  };
  const ledger = composeEvidenceLedgerForGame(fullSide(78), fullSide(52));
  const board = composeMultiLaneCeilingBoard({
    homeLedger: ledger.home,
    awayLedger: ledger.away,
    marketContexts: [
      { ticker: 'KXWC-BRA', market_type: 'match_winner', implied_probability: 0.62 },
      { ticker: 'KXWC-TOT', market_type: 'total_goals', line: 2.5 },
      { ticker: 'KXWC-SPR', market_type: 'spread_full_game', line: -0.5, side: 'home' },
    ],
    isKnockout: false,
    lineupConfirmed: false,
  });
  return { match, board };
}

test('packet renders projected goals, total, both-score, spread, and score-grid check in soccer language', () => {
  const { match, board } = makeGoalFixture();
  const text = renderWorldCupPacket({ matches: [match], boards: [board], meta: { date: '2026-06-22' } });
  assert.ok(/Goal forecast: Projected goals: \w+ [\d.]+, \w+ [\d.]+/.test(text), 'projected goals block must render');
  assert.ok(/Total goals forecast: Projected total [\d.]+/.test(text), 'projected total must render');
  assert.ok(/Both-score forecast: \d+%/.test(text), 'both-score (BTTS) forecast must render');
  assert.ok(/Goal-spread forecast: \w+ \+[\d.]+ goals/.test(text), 'goal-spread forecast must render');
  assert.ok(/Score-grid check: (models aligned|model disagreement|model check limited)/.test(text), 'score-grid check must render');
  assert.ok(!/Poisson 1X2 cross-check/.test(text), 'no "Poisson 1X2 cross-check" jargon in user packet');
});

test('Total Goals with no line shows projection, no fabricated over/under (no banned label)', () => {
  const ledger = composeEvidenceLedgerForGame(fullSide(60), fullSide(58));
  const board = composeMultiLaneCeilingBoard({
    homeLedger: ledger.home,
    awayLedger: ledger.away,
    marketContexts: [], // no lines at all
    isKnockout: false,
    lineupConfirmed: false,
  });
  const match = { match_id: 'x', home_team: 'A', away_team: 'B', stage: 'group', kickoff_utc: '2026-06-22T17:00:00Z', lineup_status: 'lineup_pending' };
  const text = renderWorldCupPacket({ matches: [match], boards: [board], meta: { date: '2026-06-22' } });
  assert.ok(/Total goals forecast: Projected total [\d.]+/.test(text), 'projected total still shown without a line');
  assert.ok(text.includes('no market lines attached'), 'no markets → comparison states no lines attached');
  assert.ok(/no line available to grade/.test(text), 'no line → spread states no line available to grade');
  assert.ok(!/projection-only/.test(text), 'banned "projection-only" label must not appear');
});

test('rendered packet contains no betting-tout shorthand (PICK/LEAN/WATCH/FADE/etc.)', () => {
  const { match, board } = makeGoalFixture();
  const text = renderWorldCupPacket({ matches: [match], boards: [board], meta: { date: '2026-06-22' } });
  for (const re of BANNED_USER_FACING) {
    assert.ok(!re.test(text), `banned user-facing token ${re} appeared in packet`);
  }
});

test('first-half lanes stay BLOCKED_MODEL_LAYER_MISSING', () => {
  const { match, board } = makeGoalFixture();
  const firstHalfLanes = board.lanes.filter(l => /first_half/.test(l.lane));
  assert.ok(firstHalfLanes.length >= 4, 'all four 1st-half lanes present');
  for (const l of firstHalfLanes) {
    assert.equal(l.recommendation, 'BLOCKED_MODEL_LAYER_MISSING', `${l.lane} must stay blocked`);
  }
});

test('new goal lanes introduce no price-leak tokens', () => {
  const { match, board } = makeGoalFixture();
  const text = renderWorldCupPacket({ matches: [match], boards: [board], meta: { date: '2026-06-22' } });
  for (const forbidden of [/¢/, /\bcents\b/i, /\bopen[_ -]?interest\b/i, /\bOI\b/, /\bvolume\b/i, /\bbid\b/i, /\bask\b/i, /\bladder\b/i, /\borderbook\b/i, /\/home\//, /\/Users\//]) {
    assert.ok(!forbidden.test(text), `price-leak token ${forbidden} leaked into packet`);
  }
});
