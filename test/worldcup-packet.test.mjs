// World Cup packet shape tests.
//
// Pins the decision-board contract:
//   - all required sections render
//   - missing lineups → BLOCKED row + pre-lineup PICK downgrade (no fake pick)
//   - market is labeled reference-only
//   - no raw market inventory / raw price fields dumped into the main packet

import test from 'node:test';
import assert from 'node:assert/strict';

import { attachWorldCupResearchContext } from '../scripts/worldcup/generate-matchday-packet.mjs';
import { composeEvidenceLedgerForGame } from '../scripts/worldcup/lib/evidence-ledger.mjs';
import { composeMultiLaneCeilingBoard } from '../scripts/worldcup/lib/multi-lane-ceiling.mjs';
import { evaluateLineupCacheFreshness } from '../scripts/worldcup/lib/lineup-freshness.mjs';
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

function makeFixture({
  lineupStatus = 'lineup_pending',
  homeScore = 85,
  awayScore = 55,
  lineupConfirmed = lineupStatus === 'lineup_confirmed',
  lineupLockedVerified = false,
  liveContext = null,
} = {}) {
  const match = {
    match_id: '400021443',
    home_team: 'Mexico',
    away_team: 'South Africa',
    group: 'A',
    stage: 'group',
    kickoff_utc: '2026-06-11T19:00:00Z',
    lineup_status: lineupStatus,
    lineup_locked_verified: lineupLockedVerified,
  };
  if (liveContext) match.live_context = liveContext;
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
  '3. Reference Comparison',
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
  assert.ok(text.includes("Model basis: latest prior team composite, not today's official starting lineup"),
    'pre-lock model basis must be stated');
  assert.ok(/Model-rated side \(forecast only\)/.test(text),
    'edges must be framed as forecast-only');
  assert.ok(!/PICK_HOME|PICK_AWAY/.test(text),
    'no full PICK enum may be emitted while lineups are unconfirmed');
  assert.ok(!text.includes('LINEUP LOCKED'), 'pre-lock packet must not claim a locked lineup');
});

test('confirmed lineups with strong evidence → clear model side, marked lineup-locked', () => {
  const { match, board } = makeFixture({ lineupStatus: 'lineup_confirmed', lineupLockedVerified: true });
  const text = renderWorldCupPacket({ matches: [match], boards: [board], meta: { date: '2026-06-11', packet_stage: 'lineup_locked' } });
  assert.ok(/Match forecast: Mexico rates higher/.test(text), 'strong confirmed-lineup edge should produce a clear model side');
  assert.ok(text.includes('Status: LINEUP LOCKED — official starting XI confirmed'),
    'confirmed lineups must be marked lineup-locked');
  assert.ok(!/\bPICK\b/.test(text), 'no raw PICK enum in user-facing text');
  assert.ok(!text.includes('Status: Pre-lock'), 'locked match must not be flagged pre-lock');
});

test('lineup cache stays fresh when the source event id differs from the internal match id', () => {
  const freshness = evaluateLineupCacheFreshness({
    ok: true,
    match_id: '400021443',
    source: { event_id: '400099999', event_state: 'pre' },
    fetched_utc: '2026-06-11T18:40:00Z',
  }, {
    matchId: '400021443',
    kickoffUtc: '2026-06-11T19:00:00Z',
    refreshStartedAtIso: '2026-06-11T18:35:00Z',
  });
  assert.equal(freshness.verified, true);
  const { match, board } = makeFixture({ lineupStatus: 'lineup_confirmed', lineupLockedVerified: freshness.verified });
  const text = renderWorldCupPacket({ matches: [match], boards: [board], meta: { date: '2026-06-11', packet_stage: 'lineup_locked' } });
  assert.ok(text.includes('Status: LINEUP LOCKED — official starting XI confirmed'));
  assert.ok(!text.includes('Status: Pre-lock'));
});

test('actual match id mismatch still keeps the packet pre-lock', () => {
  const freshness = evaluateLineupCacheFreshness({
    ok: true,
    match_id: '400099999',
    source: { event_id: '400021443', event_state: 'pre' },
    fetched_utc: '2026-06-11T18:40:00Z',
  }, {
    matchId: '400021443',
    kickoffUtc: '2026-06-11T19:00:00Z',
    refreshStartedAtIso: '2026-06-11T18:35:00Z',
  });
  assert.equal(freshness.verified, false);
  const { match, board } = makeFixture({ lineupStatus: 'lineup_pending', lineupLockedVerified: freshness.verified });
  const text = renderWorldCupPacket({ matches: [match], boards: [board], meta: { date: '2026-06-11' } });
  assert.ok(text.includes('Status: Pre-lock, lineups not confirmed'));
  assert.ok(!text.includes('LINEUP LOCKED'));
});

test('market context is labeled reference-only and shown as display-only', () => {
  const { match, board } = makeFixture();
  const text = renderWorldCupPacket({ matches: [match], boards: [board], meta: { date: '2026-06-11' } });
  assert.ok(text.includes('3. Reference Comparison'), 'market comparison section must render');
  assert.match(text, /Market Context - NOT IN SCORE/i, 'market context marker must be explicit');
  assert.ok(text.includes('reference-only'), 'market must be labeled reference-only');
  assert.ok(text.includes('Reference prices are not used in the model.'),
    'market prices must be disclosed as not used in the model');
});

test('no raw market inventory or raw price fields leak into the main packet', () => {
  const { match, board } = makeFixture();
  const text = renderWorldCupPacket({ matches: [match], boards: [board], meta: { date: '2026-06-11' } });
  for (const forbidden of ['yes_bid', 'yes_ask', 'no_bid', 'no_ask', 'open_interest', 'last_price', 'volume', 'orderbook', '"ticker"']) {
    assert.ok(!text.includes(forbidden), `raw market field "${forbidden}" leaked into main packet`);
  }
  // The packet references external lines as reference-only context, never dumps raw inventory.
  assert.ok(text.includes('external lines attached'), 'reference comparison must summarize lines, not dump them');
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

function makeBlockedGoalFixture() {
  const match = {
    match_id: '400021481',
    home_team: 'France',
    away_team: 'Japan',
    group: 'H',
    stage: 'group',
    kickoff_utc: '2026-06-22T17:00:00Z',
    lineup_status: 'lineup_pending',
  };
  const mk = (score) => ({ present: true, score });
  const home = {
    team_quality_baseline: mk(84),
    recent_form: mk(84),
    attacking_strength: { present: false, score: null },
    defensive_strength: mk(84),
    opponent_adjusted_attack: mk(84),
    opponent_adjusted_defense: mk(84),
    opponent_style_fit: mk(84),
    set_piece_matchup: mk(84),
    goalkeeper_edge: mk(84),
    squad_availability: mk(84),
    lineup_strength_delta: mk(84),
    rest_travel_venue_climate: mk(84),
    tournament_incentive_state: mk(84),
    knockout_extra_time_penalty: mk(84),
  };
  const away = fullSide(52);
  const ledger = composeEvidenceLedgerForGame(home, away);
  const board = composeMultiLaneCeilingBoard({
    homeLedger: ledger.home,
    awayLedger: ledger.away,
    marketContexts: [],
    isKnockout: false,
    lineupConfirmed: false,
  });
  return { match, board };
}

function makeLockedGoalscorerFixture({
  matchId = '400021482',
  homeTeam = 'Brazil',
  awayTeam = 'Serbia',
  kickoffUtc = '2026-06-22T17:00:00Z',
  homeScore = 78,
  awayScore = 52,
  lineupStatus = 'lineup_pending',
  homeXi = [
    { name: 'Goalkeeper One', position: 'GK', number: '1' },
    { name: 'Defender One', position: 'CB', number: '4' },
    { name: 'Forward One', position: 'F', number: '9', xg_per_90: 0.54 },
    { name: 'Forward Two', position: 'F', number: '11', xg_per_90: 0.43 },
    { name: 'Midfielder One', position: 'M', number: '10', xg_per_90: 0.21 },
  ],
  awayXi = [
    { name: 'Goalkeeper Two', position: 'GK', number: '1' },
    { name: 'Defender Two', position: 'CB', number: '4' },
    { name: 'Forward Three', position: 'F', number: '9', xg_per_90: 0.47 },
    { name: 'Forward Four', position: 'F', number: '11', xg_per_90: 0.39 },
    { name: 'Midfielder Two', position: 'M', number: '10', xg_per_90: 0.18 },
  ],
} = {}) {
  const match = {
    match_id: matchId,
    home_team: homeTeam,
    away_team: awayTeam,
    group: 'H',
    stage: 'group',
    kickoff_utc: kickoffUtc,
    lineup_status: lineupStatus,
    lineup_locked_verified: true,
    matchday: {
      source: {
        provider: 'fifa',
        league: 'worldcup',
        event_id: matchId,
        event_state: 'pre',
      },
      fetched_utc: '2026-06-22T16:10:00Z',
      home: {
        lineup_status: 'lineup_pending',
        lineup: {
          team_name: homeTeam,
          starting_xi: homeXi,
        },
      },
      away: {
        lineup_status: 'lineup_pending',
        lineup: {
          team_name: awayTeam,
          starting_xi: awayXi,
        },
      },
    },
  };
  const ledger = composeEvidenceLedgerForGame(fullSide(homeScore), fullSide(awayScore));
  const board = composeMultiLaneCeilingBoard({
    homeLedger: ledger.home,
    awayLedger: ledger.away,
    marketContexts: [],
    isKnockout: false,
    lineupConfirmed: true,
  });
  return { match, board };
}

function makeConfirmedGoalscorerFixture() {
  const { match, board } = makeLockedGoalscorerFixture({
    homeXi: [
      { name: 'Player One', position: 'GK', number: '1' },
      { name: 'Player Two', position: 'CB', number: '5' },
      { name: 'Player Three', position: 'F', number: '9', xg_per_90: 0.58 },
      { name: 'Player Four', position: 'M', number: '10', xg_per_90: 0.27 },
      { name: 'Player Five', position: 'F', number: '11', xg_per_90: 0.49 },
    ],
    awayXi: [
      { name: 'Player Six', position: 'GK', number: '1' },
      { name: 'Player Seven', position: 'CB', number: '5' },
      { name: 'Player Eight', position: 'F', number: '9', xg_per_90: 0.51 },
      { name: 'Player Nine', position: 'M', number: '10', xg_per_90: 0.24 },
      { name: 'Player Ten', position: 'F', number: '11', xg_per_90: 0.46 },
    ],
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

test('packet renders Why it matters and a blocked goalscorer sidecar when player pool is missing', () => {
  const { match, board } = makeGoalFixture();
  const text = renderWorldCupPacket({ matches: [match], boards: [board], meta: { date: '2026-06-22', packet_stage: 'morning_pre_lock' } });
  assert.ok(text.includes('Why it matters'), 'Why it matters section must render');
  assert.ok(text.includes('Anytime Goalscorer Model — no price attached'), 'goalscorer section must render');
  assert.ok(text.includes('BLOCKED_PLAYER_DATA_MISSING'), 'missing player pool must be called out');
});

test('confirmed XI packet can render READY goalscorer players', () => {
  const { match, board } = makeConfirmedGoalscorerFixture();
  const text = renderWorldCupPacket({
    matches: [match],
    boards: [board],
    meta: { date: '2026-06-22', packet_stage: 'lineup_locked' },
  });
  assert.ok(text.includes('Why it matters'), 'Why it matters section must render');
  assert.ok(text.includes('Anytime Goalscorer Model — no price attached'), 'goalscorer section must render');
  assert.ok(text.includes('READY'), 'confirmed XI players should be able to render READY');
  assert.ok(/Player One|Player Five/.test(text), 'confirmed starter names should appear');
  assert.equal((text.match(/player candidates available/g) || []).length, 1, 'player candidates available must render only once');
});

test('per-match coverage block lists all eight layers with attached live context as gathered', () => {
  const { match, board } = makeConfirmedGoalscorerFixture();
  match.live_context = {
    status: 'gathered',
    source_id: 'perplexity',
    source_label: 'Perplexity research',
    matched_by: 'match_id',
    match_id: match.match_id,
    event_id: '760489',
    source_quality: 'High',
    summary: 'Germany and Paraguay preview includes a predicted Germany XI and one injury note.',
    citations: ['[1]', '[2]'],
  };
  const text = renderWorldCupPacket({
    matches: [match],
    boards: [board],
    meta: {
      date: '2026-06-22',
      packet_stage: 'lineup_locked',
      research: { status: 'ok', attached_count: 1 },
    },
  });
  assert.ok(text.includes('Data coverage (gathered / unavailable / blocked):'), 'coverage sub-header must render');
  for (const label of [
    'official starting lineup:',
    'player positions/roles:',
    'player scoring priors:',
    'team baseline composite:',
    'lineup-adjusted team model:',
    'reference lines:',
    'advancement/standings:',
    'live context:',
  ]) {
    assert.ok(text.includes(label), `coverage block missing ${label}`);
  }
  assert.ok(/official starting lineup: gathered —/.test(text), 'official lineup must be gathered');
  assert.ok(/player positions\/roles: gathered —/.test(text), 'positions/roles must be gathered');
  assert.ok(/player scoring priors: gathered —/.test(text), 'player priors must be gathered');
  assert.ok(/team baseline composite: gathered —/.test(text), 'team baseline must be gathered');
  assert.ok(/lineup-adjusted team model: blocked —/.test(text), 'lineup-adjusted model must be blocked');
  assert.ok(/reference lines: unavailable —/.test(text), 'reference lines must be unavailable when none are attached');
  assert.ok(/advancement\/standings: unavailable —/.test(text), 'advancement standings must be unavailable');
  assert.ok(/live context: gathered — Perplexity research/.test(text), 'live context must be gathered when attached');
  assert.ok(/Perplexity research: live supplemental context captured for 1\/1 matches\./.test(text));
});

test('no live context attached stays unavailable and Source Quality stays honest', () => {
  const { match, board } = makeFixture();
  const text = renderWorldCupPacket({
    matches: [match],
    boards: [board],
    meta: { date: '2026-06-11', packet_stage: 'morning_board', research: { status: 'ok' } },
  });
  assert.ok(/live context: unavailable — no live context attached to this match/.test(text));
  assert.ok(/Perplexity research: unavailable — no match-level live context attached/.test(text));
  assert.ok(!/captured for \d+\/\d+ matches/.test(text), 'source quality must not claim captured context');
});

test('mismatched research record does not attach and does not count as captured', () => {
  const match = {
    match_id: '400021443',
    home_team: 'Mexico',
    away_team: 'South Africa',
    kickoff_utc: '2026-06-11T19:00:00Z',
  };
  const attached = attachWorldCupResearchContext(match, {
    researchStatus: 'ok',
    researchIndex: [{
      record: {
        match_id: '999999',
        summary: 'Different fixture',
        source_quality: 'High',
      },
      index: 0,
      keys: ['match_id:999999'],
      used: false,
    }],
  });
  assert.equal(attached.live_context.status, 'unavailable');
  const board = makeFixture().board;
  const text = renderWorldCupPacket({
    matches: [attached],
    boards: [board],
    meta: { date: '2026-06-11', packet_stage: 'morning_board', research: { status: 'ok' } },
  });
  assert.ok(/live context: unavailable — no live context attached to this match/.test(text));
  assert.ok(/Perplexity research: unavailable — no match-level live context attached/.test(text));
});

test('goalkeepers and low-prior defenders never appear in the goalscorer section', () => {
  const { match, board } = makeLockedGoalscorerFixture({
    homeXi: [
      { name: 'Goalkeeper One', position: 'GK', number: '1' },
      { name: 'Defender One', position: 'CB', number: '4' },
      { name: 'Forward One', position: 'F', number: '9', xg_per_90: 0.54 },
      { name: 'Forward Two', position: 'F', number: '11', xg_per_90: 0.43 },
      { name: 'Midfielder One', position: 'M', number: '10', xg_per_90: 0.21 },
    ],
    awayXi: [
      { name: 'Goalkeeper Two', position: 'GK', number: '1' },
      { name: 'Defender Two', position: 'CB', number: '4' },
      { name: 'Forward Three', position: 'F', number: '9', xg_per_90: 0.47 },
      { name: 'Forward Four', position: 'F', number: '11', xg_per_90: 0.39 },
      { name: 'Midfielder Two', position: 'M', number: '10', xg_per_90: 0.18 },
    ],
  });
  const text = renderWorldCupPacket({ matches: [match], boards: [board], meta: { date: '2026-06-22', packet_stage: 'lineup_locked' } });
  const goalSection = text.split('Anytime Goalscorer Model — no price attached')[1];
  assert.ok(goalSection, 'goalscorer section must be present');
  for (const name of ['Goalkeeper One', 'Goalkeeper Two', 'Defender One', 'Defender Two']) {
    assert.ok(!goalSection.includes(name), `${name} must not appear in goalscorer candidates`);
  }
});

test('goalscorer section is bounded to top 3 per team', () => {
  const { match, board } = makeConfirmedGoalscorerFixture();
  match.matchday.home.lineup.starting_xi.push(
    { name: 'Player Nine', position: 'F', number: '19' },
    { name: 'Player Ten', position: 'F', number: '20' },
  );
  match.matchday.away.lineup.starting_xi.push(
    { name: 'Player Eleven', position: 'F', number: '19' },
    { name: 'Player Twelve', position: 'F', number: '20' },
  );
  const text = renderWorldCupPacket({ matches: [match], boards: [board], meta: { date: '2026-06-22', packet_stage: 'lineup_locked' } });
  const goalSection = text.split('Anytime Goalscorer Model — no price attached')[1];
  const playerLines = (goalSection.match(/^\s+- /gm) || []);
  assert.ok(playerLines.length <= 6, `goalscorer section must stay bounded; got ${playerLines.length}`);
});

test('confirmed XI without xg priors blocks player scoring priors while the team forecast still renders', () => {
  const { match, board } = makeLockedGoalscorerFixture({
    homeXi: [
      { name: 'NoPrior One', position: 'GK', number: '1' },
      { name: 'NoPrior Two', position: 'CB', number: '4' },
      { name: 'NoPrior Three', position: 'F', number: '9' },
      { name: 'NoPrior Four', position: 'M', number: '10' },
    ],
    awayXi: [
      { name: 'NoPrior Five', position: 'GK', number: '1' },
      { name: 'NoPrior Six', position: 'CB', number: '4' },
      { name: 'NoPrior Seven', position: 'F', number: '9' },
      { name: 'NoPrior Eight', position: 'M', number: '10' },
    ],
  });
  const text = renderWorldCupPacket({ matches: [match], boards: [board], meta: { date: '2026-06-22', packet_stage: 'lineup_locked' } });
  assert.ok(text.includes('Goal forecast: Projected goals:'), 'team goal forecast must still render');
  assert.ok(text.includes('Goalscorer status: blocked — player-level scoring priors unavailable'),
    'confirmed XI with no xG priors must be blocked');
  assert.ok(!text.includes('READY'), 'no READY status may appear without xG priors');
});

test('missing team goal projection renders BLOCKED_TEAM_GOALS_MISSING', () => {
  const { match, board } = makeBlockedGoalFixture();
  const text = renderWorldCupPacket({ matches: [match], boards: [board], meta: { date: '2026-06-22', packet_stage: 'morning_pre_lock' } });
  assert.ok(text.includes('BLOCKED_TEAM_GOALS_MISSING'), 'team goal block must render explicitly');
});

test('Canada vs Switzerland single-match packet renders Why it matters and READY goalscorer output', () => {
  const { match, board } = makeLockedGoalscorerFixture({
    homeTeam: 'Canada',
    awayTeam: 'Switzerland',
    matchId: '400021451',
    homeXi: [
      { name: 'Canada Keeper', position: 'GK', number: '1' },
      { name: 'Canada Left Back', position: 'LB', number: '3' },
      { name: 'Canada Forward', position: 'F', number: '9', xg_per_90: 0.57 },
      { name: 'Canada Midfield', position: 'M', number: '10', xg_per_90: 0.26 },
      { name: 'Canada Winger', position: 'F', number: '11', xg_per_90: 0.45 },
    ],
    awayXi: [
      { name: 'Switzerland Keeper', position: 'GK', number: '1' },
      { name: 'Switzerland Center Back', position: 'CB', number: '5' },
      { name: 'Switzerland Forward', position: 'F', number: '9', xg_per_90: 0.49 },
      { name: 'Switzerland Midfield', position: 'M', number: '10', xg_per_90: 0.24 },
      { name: 'Switzerland Winger', position: 'F', number: '11', xg_per_90: 0.41 },
    ],
  });
  const text = renderWorldCupPacket({
    matches: [match],
    boards: [board],
    meta: { date: '2026-06-24', packet_stage: 'lineup_locked' },
  });
  assert.ok(text.includes('Why it matters'), 'single-match packet must include Why it matters');
  assert.ok(text.includes('Anytime Goalscorer Model — no price attached'), 'single-match packet must include goalscorer section');
  assert.ok(text.includes('READY'), 'Canada vs Switzerland test packet should render READY goalscorer players');
  assert.ok(text.includes('Switzerland') && text.includes('Canada'), 'match teams should appear in the packet');
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
  assert.ok(text.includes('no external lines attached'), 'no lines → comparison states no lines attached');
  assert.ok(/projected goal difference only; no external line attached/.test(text), 'no line → spread/total use the new line-less phrasing');
  assert.ok(!/projection-only/.test(text), 'banned "projection-only" label must not appear');
});

test('fully locked 1/1 packet suppresses remaining pre-lineup wording', () => {
  const { match, board } = makeLockedGoalscorerFixture({
    matchId: '400021499',
    homeTeam: 'Norway',
    awayTeam: 'France',
    homeXi: [
      { name: 'Norway Keeper', position: 'GK', number: '1' },
      { name: 'Norway Forward', position: 'F', number: '9', xg_per_90: 0.58 },
      { name: 'Norway Midfield', position: 'M', number: '10', xg_per_90: 0.23 },
      { name: 'Norway Winger', position: 'F', number: '11', xg_per_90: 0.41 },
    ],
    awayXi: [
      { name: 'France Keeper', position: 'GK', number: '1' },
      { name: 'France Forward', position: 'F', number: '9', xg_per_90: 0.55 },
      { name: 'France Midfield', position: 'M', number: '10', xg_per_90: 0.28 },
      { name: 'France Winger', position: 'F', number: '11', xg_per_90: 0.44 },
    ],
  });
  const text = renderWorldCupPacket({ matches: [match], boards: [board], meta: { date: '2026-06-22', packet_stage: 'lineup_locked' } });
  assert.ok(!text.includes('remaining matches are pre-lineup'), '1/1 fully locked packet must not mention pre-lineup matches');
});

test('rendered packet contains no betting-tout shorthand (PICK/LEAN/WATCH/FADE/etc.)', () => {
  const { match, board } = makeGoalFixture();
  const text = renderWorldCupPacket({ matches: [match], boards: [board], meta: { date: '2026-06-22' } });
  for (const re of BANNED_USER_FACING) {
    assert.ok(!re.test(text), `banned user-facing token ${re} appeared in packet`);
  }
});

test('goalscorer block uses customer-facing lineup labels, never raw enums', () => {
  // Locked packet: goalscorer per-team header must read "official starting
  // lineup", never leak the internal CONFIRMED_XI / PRE_LOCK_PROJECTED tokens.
  const { match, board } = makeConfirmedGoalscorerFixture();
  const lockedText = renderWorldCupPacket({
    matches: [match], boards: [board],
    meta: { date: '2026-06-22', packet_stage: 'lineup_locked' },
  });
  assert.ok(/lineup official starting lineup/.test(lockedText),
    'locked goalscorer header must use the customer-facing lineup label');
  for (const raw of [/CONFIRMED_XI/, /PRE_LOCK_PROJECTED/, /LINEUP_SENSITIVE/, /lineup UNAVAILABLE/]) {
    assert.ok(!raw.test(lockedText), `raw lineup enum ${raw} leaked into locked packet`);
  }
  // Pre-lock packet must likewise not leak the raw projected enum.
  const { match: preMatch, board: preBoard } = makeGoalFixture();
  const preText = renderWorldCupPacket({
    matches: [preMatch], boards: [preBoard],
    meta: { date: '2026-06-22', packet_stage: 'morning_pre_lock' },
  });
  assert.ok(!/PRE_LOCK_PROJECTED/.test(preText), 'pre-lock packet must not leak PRE_LOCK_PROJECTED enum');
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

test('market prices on the board do not change composite score or posture', () => {
  const ledger = composeEvidenceLedgerForGame(fullSide(81), fullSide(57));
  const clean = composeMultiLaneCeilingBoard({
    homeLedger: ledger.home,
    awayLedger: ledger.away,
    marketContexts: [],
    isKnockout: false,
    lineupConfirmed: false,
  });
  const dirty = composeMultiLaneCeilingBoard({
    homeLedger: ledger.home,
    awayLedger: ledger.away,
    marketContexts: [
      {
        ticker: 'KXWC-MEX',
        market_type: 'match_winner',
        yes_bid: 0.43,
        yes_ask: 0.47,
        implied_probability: 0.45,
      },
    ],
    isKnockout: false,
    lineupConfirmed: false,
  });
  const cleanLane = clean.lanes.find((lane) => lane.lane === 'match_winner');
  const dirtyLane = dirty.lanes.find((lane) => lane.lane === 'match_winner');
  assert.deepEqual(
    {
      home: dirtyLane.composite_score_home,
      away: dirtyLane.composite_score_away,
      postureHome: dirtyLane.posture_home,
      postureAway: dirtyLane.posture_away,
    },
    {
      home: cleanLane.composite_score_home,
      away: cleanLane.composite_score_away,
      postureHome: cleanLane.posture_home,
      postureAway: cleanLane.posture_away,
    },
    'market price fields must not alter the composite score or posture',
  );
});
