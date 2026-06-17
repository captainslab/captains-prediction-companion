// MLB projection-first language tests.
//
// PINs that packet wording (scripts/mlb/lib/projection-language.mjs) states the
// MODEL's projection — projected runs, win probability, YRFI probability, K
// counts, HR risk — and NEVER an over/under market-line pick, a trade call, or
// a market price. Blocked families say BLOCKED explicitly.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildScoreEngineProjection, buildYrfiProjection,
  buildKsProjection, buildHrProjection,
} from '../scripts/mlb/lib/projection-contracts.mjs';
import {
  describeMoneyline, describeRunline, describeTotal, describeTeamRuns,
  describeYrfi, describeKs, describeHr, renderProjectionBlock, NO_TRADE_FOOTER,
} from '../scripts/mlb/lib/projection-language.mjs';

const AS_OF = '2026-06-16T21:30:00Z';
const GAME_ID = '2026-06-16-NYY-BOS';
const SCORE_INPUTS = {
  home_starter: { player_id: 10 }, away_starter: { player_id: 11 },
  park: { id: 'BOS', roof: 'open' }, weather: { temp_f: 78 },
};
const SCORE_OUTPUTS = {
  moneyline_home: 0.562, runline_home_minus_1_5: 0.401, total_over_8_5: 0.487,
  total_runs_distribution: { 0: 0.05, 1: 0.10, 2: 0.15, 3: 0.20, '4+': 0.50 },
  team_runs_distribution: {
    home: { 0: 0.10, 1: 0.20, 2: 0.30, '3+': 0.40 },
    away: { 0: 0.15, 1: 0.25, 2: 0.30, '3+': 0.30 },
  },
};
const scoreProj = (over = {}) => buildScoreEngineProjection({
  game_id: GAME_ID, as_of: AS_OF, lineup_status: 'confirmed', weather_status: 'complete',
  inputs: SCORE_INPUTS, outputs: SCORE_OUTPUTS, ...over,
});

// Forbidden betting / market vocabulary that must never appear in projection copy.
const FORBIDDEN_PHRASES = [
  /take the over/i, /take the under/i, /\bbet\b/i, /\bwager\b/i,
  /\bvalue play\b/i, /\bcover the\b.*\bbet/i, /\bodds\b/i, /\bprice\b/i,
  /\b[-+]\d{2,4}\b/, // american odds like -180 / +145
];
function assertProjectionFirst(line) {
  for (const re of FORBIDDEN_PHRASES) {
    assert.ok(!re.test(line), `betting/market phrasing leaked: ${re} → "${line}"`);
  }
}

test('moneyline copy: win probability, model-not-line, no betting phrasing', () => {
  const line = describeMoneyline(scoreProj(), { home_team: 'BOS', away_team: 'NYY' });
  assert.match(line, /win probability/i);
  assert.match(line, /BOS 56\.2%/);
  assert.match(line, /not a market line/i);
  assertProjectionFirst(line);
});

test('total copy: projected runs + rung probability, never "over/under call"', () => {
  const line = describeTotal(scoreProj());
  assert.match(line, /projected/i);
  assert.match(line, /total runs/i);
  assert.match(line, /P\(total > 8\.5\)/);
  assert.match(line, /not an over\/under call/i);
  assertProjectionFirst(line);
});

test('runline + team runs copy is projection-first', () => {
  const rl = describeRunline(scoreProj(), { home_team: 'BOS' });
  assert.match(rl, /cover probability/i);
  assertProjectionFirst(rl);
  const tr = describeTeamRuns(scoreProj(), 'home', 'BOS');
  assert.match(tr, /Projected runs — BOS/);
  assertProjectionFirst(tr);
});

test('yrfi copy: first-inning run probability phrasing', () => {
  const proj = buildYrfiProjection({
    game_id: GAME_ID, as_of: AS_OF, lineup_status: 'confirmed',
    inputs: { home_starter: { player_id: 10 }, away_starter: { player_id: 11 }, park: { id: 'BOS' } },
    outputs: { yrfi_prob: 0.47, nrfi_prob: 0.53 },
  });
  const line = describeYrfi(proj);
  assert.match(line, /first-inning run \(YRFI\) probability 47%/i);
  assert.match(line, /NRFI\) 53%/);
  assertProjectionFirst(line);
});

test('ks copy: projected strikeout count, not an over/under call', () => {
  const proj = buildKsProjection({
    game_id: GAME_ID, as_of: AS_OF, player_id: 10, lineup_status: 'confirmed',
    inputs: { starter: { player_id: 10 }, pitch_count_leash: 95, opponent_lineup: [1] },
    outputs: { distribution: { 4: 0.3, 5: 0.4, '6+': 0.3 }, derived_probs: { over_5_5: 0.39 } },
  });
  const line = describeKs(proj, 'Gerrit Cole');
  assert.match(line, /Projected strikeouts — Gerrit Cole/);
  assert.match(line, /P\(≥ 5\.5 K\) 39%/);
  assert.match(line, /not an over\/under call/i);
  assertProjectionFirst(line);
});

test('hr copy: HR risk phrasing, rare-event', () => {
  const proj = buildHrProjection({
    game_id: GAME_ID, as_of: AS_OF, player_id: 99, lineup_status: 'confirmed', weather_status: 'complete',
    inputs: { batter_in_lineup: true, expected_pa: 4.2, park: { id: 'BOS', roof: 'open' }, weather: { temp_f: 78 } },
    outputs: { p_at_least_one_hr: 0.18 },
  });
  const line = describeHr(proj, 'Aaron Judge');
  assert.match(line, /Projected HR risk — Aaron Judge: 18%/);
  assert.match(line, /≥ 1 home run/);
  assertProjectionFirst(line);
});

test('blocked family renders an explicit BLOCKED line, never a borrowed pick', () => {
  const proj = buildKsProjection({
    game_id: GAME_ID, as_of: AS_OF, player_id: 10, lineup_status: 'projected',
    inputs: { starter: { player_id: 10 } },
  });
  const line = describeKs(proj, 'Gerrit Cole');
  assert.match(line, /BLOCKED_MODEL_LAYER_MISSING/);
  assert.match(line, /No projection issued/);
  assertProjectionFirst(line);
});

test('provisional status is tagged in the copy', () => {
  const line = describeMoneyline(scoreProj({ lineup_status: 'unconfirmed' }), { home_team: 'BOS', away_team: 'NYY' });
  assert.match(line, /\[provisional/);
  assert.match(line, /lineup unconfirmed/);
});

test('renderProjectionBlock appends the no-trade footer', () => {
  const block = renderProjectionBlock([describeMoneyline(scoreProj(), { home_team: 'BOS', away_team: 'NYY' })]);
  assert.ok(block.endsWith(NO_TRADE_FOOTER));
  assert.match(NO_TRADE_FOOTER, /No trades placed\. No bankroll sizing\. Research only\./);
});
