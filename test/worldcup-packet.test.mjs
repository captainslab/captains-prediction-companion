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
  '1. TLDR BOARD',
  '2. MODEL vs MARKET — LARGEST GAPS',
  '3. MONITOR — NO CLEAR SIDE',
  '4. OPPOSITE-SIDE VALUE',
  '5. BLOCKED / NEEDS SOURCE',
  '6. AUDIT ARTIFACTS',
  '7. SOURCE QUALITY / MODEL COMPLETENESS',
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

test('missing lineups → match appears in BLOCKED and no full PICK is emitted', () => {
  const { match, board } = makeFixture({ lineupStatus: 'lineup_pending' });
  const text = renderWorldCupPacket({ matches: [match], boards: [board], meta: { date: '2026-06-11' } });
  assert.ok(text.includes('Mexico vs South Africa: blocked — missing lineups'),
    'pending lineups must appear in BLOCKED / NEEDS SOURCE');
  assert.ok(!/PICK_HOME|PICK_AWAY/.test(text),
    'no full PICK may be emitted while lineups are unconfirmed (pre-lineup downgrade)');
  assert.ok(text.includes('Pre-lineup: model side held back until lineups confirm'),
    'pre-lineup hold-back must be stated in soccer language');
  assert.ok(text.includes('Pre-lineup confidence downgrade: YES'));
});

test('confirmed lineups with strong evidence → clear model side, not blocked for lineups', () => {
  const { match, board } = makeFixture({ lineupStatus: 'lineup_confirmed' });
  const text = renderWorldCupPacket({ matches: [match], boards: [board], meta: { date: '2026-06-11', packet_stage: 'lineup_locked' } });
  assert.ok(/Clear model side: Mexico/.test(text), 'strong confirmed-lineup edge should produce a clear model side');
  assert.ok(!/\bPICK\b/.test(text), 'no raw PICK enum in user-facing text');
  assert.ok(!text.includes('blocked — missing lineups'));
});

test('market context is labeled NOT IN SCORE on every lane row', () => {
  const { match, board } = makeFixture();
  const text = renderWorldCupPacket({ matches: [match], boards: [board], meta: { date: '2026-06-11' } });
  const laneHeaders = text.match(/^  \[[^\]]+\] .*/gm) || [];
  const renderedModelLanes = laneHeaders.filter(l => !/Model unavailable/.test(l)).length;
  const marketRows = (text.match(/MARKET \(NOT IN SCORE\)/g) || []).length;
  assert.ok(renderedModelLanes > 0, 'packet must contain model lane rows');
  assert.equal(marketRows, renderedModelLanes, 'every rendered model lane must pair with a NOT IN SCORE market row');
});

test('no raw market inventory or raw price fields leak into the main packet', () => {
  const { match, board } = makeFixture();
  const text = renderWorldCupPacket({ matches: [match], boards: [board], meta: { date: '2026-06-11' } });
  for (const forbidden of ['yes_bid', 'yes_ask', 'no_bid', 'no_ask', 'open_interest', 'last_price', 'volume', 'orderbook', '"ticker"']) {
    assert.ok(!text.includes(forbidden), `raw market field "${forbidden}" leaked into main packet`);
  }
  assert.ok(text.includes('Full raw market inventory'), 'audit section must point at audit artifacts instead');
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

test('packet renders projected goals, total/BTTS/spread probabilities, and score-grid cross-check in soccer language', () => {
  const { match, board } = makeGoalFixture();
  const text = renderWorldCupPacket({ matches: [match], boards: [board], meta: { date: '2026-06-22' } });
  assert.ok(/projected goals: H [\d.]+ \/ A [\d.]+ \| total [\d.]+ \| margin/.test(text), 'projected goals block must render');
  assert.ok(/Score-grid cross-check: (models aligned|model disagreement|monitor model disagreement)/.test(text), 'score-grid cross-check must render');
  assert.ok(!/Poisson 1X2 cross-check/.test(text), 'no "Poisson 1X2 cross-check" jargon in user packet');
  assert.ok(/Goal projection: [\d.]+/.test(text), 'goal projection must render');
  assert.ok(/Total view: (Over 2\.5 profile|Under 2\.5 profile|no clear total side)/.test(text), 'total view must render');
  assert.ok(/Over profile: \d+% \/ Under profile: \d+%/.test(text), 'over/under profiles must render with a graded line');
  assert.ok(/Both-score probability: \d+%/.test(text), 'BTTS probability must render');
  assert.ok(/Clean-sheet risk: (low|moderate|high)/.test(text), 'clean-sheet risk must render');
  assert.ok(/Projected margin: \w+ \+[\d.]+ goals/.test(text), 'projected margin must render');
  assert.ok(/Cover profile: \d+%/.test(text), 'spread cover profile must render');
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
  assert.ok(/Goal projection: [\d.]+/.test(text), 'goal projection still shown without a line');
  assert.ok(/Total view: no line available to grade/.test(text), 'no line → no line available to grade');
  assert.ok(/Spread view: no line available to grade/.test(text), 'no line → spread no line available to grade');
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
