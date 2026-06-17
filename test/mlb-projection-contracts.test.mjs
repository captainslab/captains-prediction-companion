// MLB projection-contract foundation tests.
//
// PINs the market-FREE foundation layer (scripts/mlb/lib/projection-contracts.mjs):
//   1. price isolation — no market/odds/board-shape field may enter inputs or
//      outputs; a smuggled price field THROWS; clean output JSON has none.
//   2. fail-closed gating — missing starters/lineup/weather block or downgrade
//      per the architecture doc, and a blocked family never emits outputs.
//   3. shared coherence — one score contract feeds ML/spread/total; specialized
//      YRFI / Ks / HR contracts share the inputs + uncertainty stack.
//
// Pure unit tests — no I/O, no network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  SCORE_ENGINE_SCHEMA, YRFI_SCHEMA, KS_SCHEMA, HR_SCHEMA,
  FORBIDDEN_PRICE_KEYS, PROJECTION_STATUSES, NO_TRADE_NOTE,
  findPriceKeys, assertNoPriceFields, distributionFloorMean,
  buildScoreEngineProjection, buildYrfiProjection,
  buildKsProjection, buildHrProjection,
} from '../scripts/mlb/lib/projection-contracts.mjs';

// Forbidden market/odds JSON keys that must never appear in any contract output.
const FORBIDDEN_JSON_KEYS = [
  '"price"', '"odds"', '"bid"', '"ask"', '"yes_ask"', '"no_bid"',
  '"kalshi_ask"', '"kalshi_bid"', '"moneyline_odds"', '"implied_prob"',
  '"market_prob"', '"fair_value"', '"edge"', '"kelly"', '"stake"', '"vig"',
  '"open_interest"', '"volume"', '"board_shape"', '"spread_shape"',
];
function assertNoForbiddenKeys(obj, ctx) {
  const json = JSON.stringify(obj);
  for (const k of FORBIDDEN_JSON_KEYS) {
    assert.ok(!json.includes(k), `${ctx}: forbidden market key leaked: ${k}`);
  }
}

// ---- Canonical clean inputs (no prices anywhere) ---------------------------
const AS_OF = '2026-06-16T21:30:00Z';
const GAME_ID = '2026-06-16-NYY-BOS';
const SCORE_INPUTS = {
  home_lineup: [{ player_id: 1, spot: 1 }, { player_id: 2, spot: 2 }],
  away_lineup: [{ player_id: 3, spot: 1 }, { player_id: 4, spot: 2 }],
  home_starter: { player_id: 10 },
  away_starter: { player_id: 11 },
  park: { id: 'BOS', roof: 'open' },
  weather: { temp_f: 78, wind_mph: 7, wind_dir: 'out_to_rf' },
};
const SCORE_OUTPUTS = {
  moneyline_home: 0.562,
  runline_home_minus_1_5: 0.401,
  total_over_8_5: 0.487,
  total_runs_distribution: { 0: 0.05, 1: 0.10, 2: 0.15, 3: 0.20, '4+': 0.50 },
  team_runs_distribution: {
    home: { 0: 0.10, 1: 0.20, 2: 0.30, '3+': 0.40 },
    away: { 0: 0.15, 1: 0.25, 2: 0.30, '3+': 0.30 },
  },
};

// ---------------------------------------------------------------------------
// GROUP 0 — schema + constants surface
// ---------------------------------------------------------------------------
test('schema versions are stable and distinct', () => {
  const all = [SCORE_ENGINE_SCHEMA, YRFI_SCHEMA, KS_SCHEMA, HR_SCHEMA];
  assert.equal(new Set(all).size, 4);
  assert.equal(SCORE_ENGINE_SCHEMA, 'mlb_score_engine_projection_v1');
  assert.deepEqual(PROJECTION_STATUSES, ['official', 'provisional', 'blocked']);
  assert.match(NO_TRADE_NOTE, /no trade/i);
});

// ---------------------------------------------------------------------------
// GROUP 1 — price isolation guard
// ---------------------------------------------------------------------------
test('findPriceKeys locates nested price/board-shape fields', () => {
  const hits = findPriceKeys({
    park: { id: 'BOS' },
    nested: { deep: [{ yes_ask: 0.9 }] },
    fair_value: 0.5,
    board_shape: 'thin',
  });
  assert.ok(hits.includes('fair_value'));
  assert.ok(hits.includes('board_shape'));
  assert.ok(hits.some((h) => h.endsWith('yes_ask')));
});

test('FORBIDDEN_PRICE_KEYS covers price, odds, OI, volume, board shape', () => {
  for (const k of ['price', 'odds', 'open_interest', 'volume', 'board_shape', 'yes_ask', 'fair_value']) {
    assert.ok(FORBIDDEN_PRICE_KEYS.includes(k), `expected ${k} forbidden`);
  }
});

test('assertNoPriceFields throws on any smuggled market field', () => {
  assert.throws(() => assertNoPriceFields({ park: { id: 'BOS', yes_ask: 0.9 } }), /price-isolation/);
  assert.doesNotThrow(() => assertNoPriceFields(SCORE_INPUTS));
});

test('a price field smuggled into score-engine inputs is BLOCKED by a throw', () => {
  assert.throws(
    () => buildScoreEngineProjection({
      game_id: GAME_ID, as_of: AS_OF, lineup_status: 'confirmed', weather_status: 'complete',
      inputs: { ...SCORE_INPUTS, park: { id: 'BOS', roof: 'open', moneyline_odds: -180 } },
      outputs: SCORE_OUTPUTS,
    }),
    /price-isolation/,
  );
});

test('clean projections carry NO market/odds/board-shape keys', () => {
  const score = buildScoreEngineProjection({
    game_id: GAME_ID, as_of: AS_OF, lineup_status: 'confirmed', weather_status: 'complete',
    inputs: SCORE_INPUTS, outputs: SCORE_OUTPUTS,
  });
  assertNoForbiddenKeys(score, 'score engine');
});

// Static guarantee: the contract source never *reads* a price field name.
test('projection-contracts source reads no price field names', () => {
  const src = readFileSync(new URL('../scripts/mlb/lib/projection-contracts.mjs', import.meta.url), 'utf8');
  // strip the declared guard lists (FORBIDDEN_*) — those are denylists, not reads.
  const body = src
    .replace(/export const FORBIDDEN_PRICE_KEYS[\s\S]*?\]\);/, '')
    .replace(/const FORBIDDEN_SUBSTRINGS[\s\S]*?\]\);/, '');
  for (const token of ['yes_ask', 'no_bid', 'kalshi', 'moneyline_odds', 'implied_prob', '.price', '.odds', '.bid', '.ask']) {
    assert.ok(!body.includes(token), `contract body must not reference price token "${token}"`);
  }
});

// ---------------------------------------------------------------------------
// GROUP 2 — score engine gating (ML / spread / total coherent)
// ---------------------------------------------------------------------------
test('score engine: confirmed lineup + complete weather + outputs → official', () => {
  const p = buildScoreEngineProjection({
    game_id: GAME_ID, as_of: AS_OF, lineup_status: 'confirmed', weather_status: 'complete',
    inputs: SCORE_INPUTS, outputs: SCORE_OUTPUTS,
  });
  assert.equal(p.schema_version, SCORE_ENGINE_SCHEMA);
  assert.deepEqual(p.market_families, ['moneyline', 'spread', 'total']);
  assert.equal(p.status, 'official');
  assert.equal(p.outputs.moneyline_home, 0.562);
  assert.equal(p.no_trade, true);
});

test('score engine: unconfirmed lineup → provisional with lineup penalty', () => {
  const p = buildScoreEngineProjection({
    game_id: GAME_ID, as_of: AS_OF, lineup_status: 'unconfirmed', weather_status: 'complete',
    inputs: SCORE_INPUTS, outputs: SCORE_OUTPUTS,
  });
  assert.equal(p.status, 'provisional');
  assert.ok(p.uncertainty.lineup_penalty > 0);
  assert.ok(p.outputs !== null, 'ML/spread/total may publish a provisional pre-lineup version');
});

test('score engine: missing starter → blocked, outputs null (no fabrication)', () => {
  const p = buildScoreEngineProjection({
    game_id: GAME_ID, as_of: AS_OF, lineup_status: 'confirmed', weather_status: 'complete',
    inputs: { ...SCORE_INPUTS, home_starter: null }, outputs: SCORE_OUTPUTS,
  });
  assert.equal(p.status, 'blocked');
  assert.equal(p.outputs, null);
  assert.ok(p.blocked_reasons.includes('home_starter_unconfirmed'));
});

test('score engine: open-air weather missing → provisional with weather penalty', () => {
  const p = buildScoreEngineProjection({
    game_id: GAME_ID, as_of: AS_OF, lineup_status: 'confirmed', weather_status: 'missing',
    inputs: SCORE_INPUTS, outputs: SCORE_OUTPUTS,
  });
  assert.equal(p.status, 'provisional');
  assert.ok(p.uncertainty.weather_penalty > 0);
});

test('score engine: closed roof does not require weather for official', () => {
  const p = buildScoreEngineProjection({
    game_id: GAME_ID, as_of: AS_OF, lineup_status: 'confirmed', weather_status: 'missing',
    inputs: { ...SCORE_INPUTS, park: { id: 'TB', roof: 'closed' } }, outputs: SCORE_OUTPUTS,
  });
  assert.equal(p.status, 'official');
  assert.equal(p.uncertainty.weather_penalty, 0);
});

test('score engine: malformed distribution (does not sum to 1) is rejected', () => {
  assert.throws(() => buildScoreEngineProjection({
    game_id: GAME_ID, as_of: AS_OF, lineup_status: 'confirmed', weather_status: 'complete',
    inputs: SCORE_INPUTS,
    outputs: { total_runs_distribution: { 0: 0.2, 1: 0.2 } },
  }), /distribution/);
});

test('score engine: missing game_id/as_of throws (as-of discipline)', () => {
  assert.throws(() => buildScoreEngineProjection({ as_of: AS_OF, inputs: SCORE_INPUTS }), /game_id/);
  assert.throws(() => buildScoreEngineProjection({ game_id: GAME_ID, inputs: SCORE_INPUTS }), /as_of/);
});

// ---------------------------------------------------------------------------
// GROUP 3 — YRFI gating
// ---------------------------------------------------------------------------
const YRFI_INPUTS = {
  home_top_order: [1, 2, 3], away_top_order: [4, 5, 6],
  home_starter: { player_id: 10 }, away_starter: { player_id: 11 },
  park: { id: 'BOS', roof: 'open' }, weather: { temp_f: 78 },
};
test('yrfi: confirmed lineup + starters → official', () => {
  const p = buildYrfiProjection({
    game_id: GAME_ID, as_of: AS_OF, lineup_status: 'confirmed', weather_status: 'complete',
    inputs: YRFI_INPUTS, outputs: { yrfi_prob: 0.47, nrfi_prob: 0.53 },
  });
  assert.equal(p.schema_version, YRFI_SCHEMA);
  assert.equal(p.status, 'official');
  assert.equal(p.outputs.yrfi_prob, 0.47);
});

test('yrfi: unconfirmed lineup → provisional, sharply downgraded', () => {
  const p = buildYrfiProjection({
    game_id: GAME_ID, as_of: AS_OF, lineup_status: 'unconfirmed',
    inputs: YRFI_INPUTS, outputs: { yrfi_prob: 0.47, nrfi_prob: 0.53 },
  });
  assert.equal(p.status, 'provisional');
  assert.ok(p.uncertainty.lineup_penalty >= 0.25, 'YRFI lineup penalty must be sharp');
  assert.equal(p.inputs_complete, false);
});

test('yrfi: missing starter → blocked', () => {
  const p = buildYrfiProjection({
    game_id: GAME_ID, as_of: AS_OF, lineup_status: 'confirmed',
    inputs: { ...YRFI_INPUTS, away_starter: null }, outputs: { yrfi_prob: 0.47, nrfi_prob: 0.53 },
  });
  assert.equal(p.status, 'blocked');
  assert.equal(p.outputs, null);
});

// ---------------------------------------------------------------------------
// GROUP 4 — Ks gating (block when uncertain)
// ---------------------------------------------------------------------------
const KS_DIST = { 0: 0.01, 1: 0.03, 2: 0.07, 3: 0.12, 4: 0.18, 5: 0.20, 6: 0.17, 7: 0.12, '8_plus': 0.10 };
test('ks: confirmed starter + leash + lineup → official', () => {
  const p = buildKsProjection({
    game_id: GAME_ID, as_of: AS_OF, player_id: 10, lineup_status: 'confirmed',
    inputs: { starter: { player_id: 10 }, pitch_count_leash: 95, opponent_lineup: [1, 2, 3] },
    outputs: { distribution: KS_DIST, derived_probs: { over_5_5: 0.39, over_6_5: 0.22 } },
    explanation: { expected_batters_faced: 24.8, expected_k_rate: 0.243 },
  });
  assert.equal(p.schema_version, KS_SCHEMA);
  assert.equal(p.market_family, 'pitcher_strikeouts');
  assert.equal(p.status, 'official');
  assert.equal(p.explanation.lineup_confirmed, true);
});

test('ks: missing pitch-count leash → blocked', () => {
  const p = buildKsProjection({
    game_id: GAME_ID, as_of: AS_OF, player_id: 10, lineup_status: 'confirmed',
    inputs: { starter: { player_id: 10 }, opponent_lineup: [1, 2, 3] },
    outputs: { distribution: KS_DIST },
  });
  assert.equal(p.status, 'blocked');
  assert.ok(p.blocked_reasons.includes('pitch_count_leash_unknown'));
  assert.equal(p.outputs, null);
});

test('ks: unconfirmed opposing lineup → blocked (no provisional tier)', () => {
  const p = buildKsProjection({
    game_id: GAME_ID, as_of: AS_OF, player_id: 10, lineup_status: 'projected',
    inputs: { starter: { player_id: 10 }, pitch_count_leash: 95 },
    outputs: { distribution: KS_DIST },
  });
  assert.equal(p.status, 'blocked');
  assert.ok(p.blocked_reasons.includes('opponent_lineup_unconfirmed'));
});

// ---------------------------------------------------------------------------
// GROUP 5 — HR gating (block when lineup pending)
// ---------------------------------------------------------------------------
test('hr: confirmed lineup + batter present + pa + park + weather → official', () => {
  const p = buildHrProjection({
    game_id: GAME_ID, as_of: AS_OF, player_id: 99, lineup_status: 'confirmed', weather_status: 'complete',
    inputs: { batter_in_lineup: true, expected_pa: 4.2, park: { id: 'BOS', roof: 'open' }, weather: { temp_f: 78 } },
    outputs: { p_at_least_one_hr: 0.18 },
  });
  assert.equal(p.schema_version, HR_SCHEMA);
  assert.equal(p.status, 'official');
  assert.equal(p.outputs.p_at_least_one_hr, 0.18);
});

test('hr: pending lineup → blocked', () => {
  const p = buildHrProjection({
    game_id: GAME_ID, as_of: AS_OF, player_id: 99, lineup_status: 'unconfirmed', weather_status: 'complete',
    inputs: { batter_in_lineup: false, expected_pa: 4.2, park: { id: 'BOS' } },
    outputs: { p_at_least_one_hr: 0.18 },
  });
  assert.equal(p.status, 'blocked');
  assert.equal(p.outputs, null);
  assert.ok(p.blocked_reasons.includes('lineup_unconfirmed'));
});

test('hr: open-air weather gap → provisional', () => {
  const p = buildHrProjection({
    game_id: GAME_ID, as_of: AS_OF, player_id: 99, lineup_status: 'confirmed', weather_status: 'missing',
    inputs: { batter_in_lineup: true, expected_pa: 4.2, park: { id: 'BOS', roof: 'open' } },
    outputs: { p_at_least_one_hr: 0.18 },
  });
  assert.equal(p.status, 'provisional');
  assert.ok(p.uncertainty.weather_penalty > 0);
});

// ---------------------------------------------------------------------------
// GROUP 6 — distribution helper
// ---------------------------------------------------------------------------
test('distributionFloorMean uses leading integer of open buckets', () => {
  const m = distributionFloorMean({ 0: 0.5, '2+': 0.5 });
  assert.ok(Math.abs(m - 1.0) < 1e-9);
  assert.equal(distributionFloorMean(null), null);
  assert.equal(distributionFloorMean({ 0: 0.5, x: 'nope' }), null, 'non-probability value → null');
});
