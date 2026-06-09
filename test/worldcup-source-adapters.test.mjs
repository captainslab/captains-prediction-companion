// World Cup source adapter tests.
//
// Pins: normalization schemas, fail-soft MISSING behavior (never fabricate),
// opponent-relative matchup scoring, and market math kept out of the model.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeEspnEvent,
  loadCachedStructure,
  STAGE,
  DEFAULT_FIFA_API_URL,
} from '../scripts/worldcup/source-adapters/static-structure.mjs';
import { buildOpponentMatchup } from '../scripts/worldcup/source-adapters/opponent-matchup.mjs';
import {
  normalizeSquad,
  normalizeLineup,
  normalizeInjuries,
  LINEUP_STATUS,
} from '../scripts/worldcup/source-adapters/matchday-data.mjs';
import {
  impliedProbability,
  computeEdge,
  normalizeMarketContext,
} from '../scripts/worldcup/source-adapters/market-context.mjs';

// ---------------------------------------------------------------------------
// Static structure
// ---------------------------------------------------------------------------

test('FIFA default URL targets the 2026 season (285023), not Qatar 2022', () => {
  assert.ok(DEFAULT_FIFA_API_URL.includes('idSeason=285023'), DEFAULT_FIFA_API_URL);
  assert.ok(DEFAULT_FIFA_API_URL.includes('idCompetition=17'), DEFAULT_FIFA_API_URL);
});

test('normalizeEspnEvent maps a scoreboard event into the shared fixture schema', () => {
  const ev = {
    id: '760415',
    date: '2026-06-11T19:00Z',
    season: { slug: 'fifa-world-cup' },
    status: { type: { name: 'STATUS_SCHEDULED', completed: false } },
    competitions: [{
      notes: [{ headline: 'Group A - 2026 FIFA World Cup' }],
      venue: { fullName: 'Estadio Banorte', address: { city: 'Mexico City' } },
      competitors: [
        { homeAway: 'home', team: { displayName: 'Mexico' }, score: '0' },
        { homeAway: 'away', team: { displayName: 'South Africa' }, score: '0' },
      ],
    }],
  };
  const m = normalizeEspnEvent(ev);
  assert.equal(m.home_team, 'Mexico');
  assert.equal(m.away_team, 'South Africa');
  assert.equal(m.group, 'A');
  assert.equal(m.stage, STAGE.GROUP);
  assert.equal(m.kickoff_utc, '2026-06-11T19:00:00.000Z');
  assert.equal(m.venue, 'Estadio Banorte');
  assert.equal(m.status, 'SCHEDULED');
  assert.equal(m.home_goals, null, 'no score before completion — never fabricate results');
});

test('normalizeEspnEvent returns null for malformed events instead of inventing fields', () => {
  assert.equal(normalizeEspnEvent(null), null);
  assert.equal(normalizeEspnEvent({ id: 'x', competitions: [{ competitors: [] }] }), null);
});

test('loadCachedStructure is a cache MISS, not fabricated data, when no file exists', () => {
  const out = loadCachedStructure('state', '1999-01-01');
  assert.equal(out.ok, false);
  assert.ok(!out.matches, 'missing cache must not produce matches');
});

// ---------------------------------------------------------------------------
// Opponent matchup — scores must be opponent-relative both ways
// ---------------------------------------------------------------------------

const BASELINES = {
  Mexico: { attack_rating: 84.2, defense_rating: 84.2 },
  'South Africa': { attack_rating: 64.3, defense_rating: 64.3 },
};

test('buildOpponentMatchup scores each side against THIS opponent', () => {
  const m = buildOpponentMatchup({ homeTeam: 'Mexico', awayTeam: 'South Africa', teamBaselines: BASELINES });
  assert.equal(m.ok, true);
  const homeAtk = m.home.attack_vs_opponent_defense;
  const awayAtk = m.away.attack_vs_opponent_defense;
  assert.equal(homeAtk.present, true);
  assert.equal(awayAtk.present, true);
  // Stronger side attacking weaker defense must outscore the reverse.
  assert.ok(homeAtk.score > awayAtk.score,
    `home attack vs weaker defense (${homeAtk.score}) should exceed away attack vs stronger defense (${awayAtk.score})`);
  // Basis strings must name both TEAMS (regression: away basis once interpolated an object).
  for (const side of ['home', 'away']) {
    for (const [key, rec] of Object.entries(m[side])) {
      if (rec && typeof rec.basis === 'string') {
        assert.ok(!rec.basis.includes('[object Object]'), `${side}.${key} basis leaked an object: ${rec.basis}`);
      }
    }
  }
});

test('buildOpponentMatchup with no baseline data returns MISSING scores, not defaults', () => {
  const m = buildOpponentMatchup({ homeTeam: 'A', awayTeam: 'B', teamBaselines: {} });
  assert.equal(m.ok, true);
  assert.equal(m.home.attack_vs_opponent_defense.present, false);
  assert.equal(m.home.attack_vs_opponent_defense.score, null);
  assert.equal(m.away.defense_vs_opponent_attack.score, null);
});

test('buildOpponentMatchup H2H advantage is symmetric between sides', () => {
  const h2h = [
    { home: 'Mexico', away: 'South Africa', home_goals: 2, away_goals: 1 },
    { home: 'South Africa', away: 'Mexico', home_goals: 0, away_goals: 1 },
    { home: 'Mexico', away: 'South Africa', home_goals: 0, away_goals: 1 },
  ];
  const m = buildOpponentMatchup({ homeTeam: 'Mexico', awayTeam: 'South Africa', teamBaselines: {}, historicalH2H: h2h });
  assert.equal(m.h2h_total_matches, 3);
  assert.equal(m.home.h2h_advantage.score + m.away.h2h_advantage.score, 100);
});

// ---------------------------------------------------------------------------
// Matchday data
// ---------------------------------------------------------------------------

test('normalizeLineup maps confirmation status and never invents players', () => {
  const confirmed = normalizeLineup({ team: 'Mexico', formation: '4-3-3', status: 'confirmed', startingXI: [{ name: 'P1', position: 'GK', number: 1 }] });
  assert.equal(confirmed.status, LINEUP_STATUS.CONFIRMED);
  assert.equal(confirmed.starting_xi.length, 1);
  const pending = normalizeLineup({ team: 'Mexico', startingXI: [] });
  assert.equal(pending.status, LINEUP_STATUS.PENDING);
  assert.equal(normalizeLineup({ team: 'Mexico' }), null, 'no startingXI array → null, not a fake lineup');
});

test('normalizeSquad and normalizeInjuries fail soft on malformed input', () => {
  assert.equal(normalizeSquad({}), null);
  assert.equal(normalizeInjuries({}), null);
  const inj = normalizeInjuries({ team: 'Mexico', injuries: [{ player: 'X', injury: 'hamstring' }], suspensions: [{ player: 'Y' }] });
  assert.equal(inj.injuries.length, 1);
  assert.equal(inj.suspensions.length, 1);
});

// ---------------------------------------------------------------------------
// Market context — post-score reference only
// ---------------------------------------------------------------------------

test('impliedProbability uses bid/ask midpoint, handles cents and missing data', () => {
  assert.equal(impliedProbability({ yes_bid: 0.4, yes_ask: 0.6 }), 0.5);
  assert.equal(impliedProbability({ yes_bid: 40, yes_ask: 60 }), 0.5, 'cent-denominated prices normalize');
  assert.equal(impliedProbability({ last_price: 0.62 }), 0.62);
  assert.equal(impliedProbability({}), null, 'no market data → null, never fabricated');
});

test('computeEdge is computed AFTER the model, in percentage points', () => {
  assert.equal(computeEdge(0.65, 0.58), 7);
  assert.equal(computeEdge(null, 0.58), null);
  assert.equal(computeEdge(0.65, null), null);
});

test('normalizeMarketContext strips raw price fields down to reference context', () => {
  const ctx = normalizeMarketContext({ ticker: 'KXWC-MEX', title: 'Mexico wins', yes_bid: 0.55, yes_ask: 0.61, volume: 9999, open_interest: 5000 });
  assert.equal(ctx.ticker, 'KXWC-MEX');
  assert.ok(Math.abs(ctx.implied_probability - 0.58) < 1e-9);
  const json = JSON.stringify(ctx);
  for (const k of ['"yes_bid"', '"yes_ask"', '"volume"', '"open_interest"', '"last_price"']) {
    assert.ok(!json.includes(k), `normalized market context must not carry raw field ${k}`);
  }
});
