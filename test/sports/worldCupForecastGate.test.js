/**
 * test/sports/worldCupForecastGate.test.js
 * Tests: stale-model forecast gate behavior.
 *
 * Proves:
 *  1. lineup_confirmed=true + model_consumes_lineup=false => forecast held
 *  2. lineup_confirmed=true + model_consumes_lineup=true  => active forecast allowed
 *  3. lineup_confirmed=false                              => active forecast allowed
 *  4. Stale public packets do NOT render projected goals/BTTS/margin/score numbers
 *  5. Active packets DO render forecast when model consumed lineup
 */

'use strict';

const assert = require('node:assert/strict');
const { checkForecastFreshness } = require('../../src/sports/worldCupResearchContext');
const { renderWcPublicPacket, scanPublicOutput } = require('../../src/sports/publicPacketRenderer');

const STALE_FORECAST = {
  projected_goals_home: 1.37,
  projected_goals_away: 1.27,
  projected_total: 2.64,
  btts_pct: 54,
};

const MATCH_META = {
  homeTeam: 'Algeria',
  awayTeam: 'Austria',
  matchDate: '2026-06-27',
  venue: 'Kansas City Stadium',
  group: 'Group J',
};

const RESEARCH_CONTEXT = {
  research: {
    home_confirmed_xi: ['Oussama Benbot', 'Riyad Mahrez', 'Amine Gouiri'],
    away_confirmed_xi: ['Alexander Schlager', 'Marko Arnautovic', 'Marcel Sabitzer'],
    home_injury_notes: null,
    away_injury_notes: null,
    group_standings_note: 'Group J final matchday',
    advancement_context: 'Both teams need a result to advance',
    match_context_note: null,
  },
};

// ─── checkForecastFreshness ────────────────────────────────────────────────────

console.log('\n► worldCupForecastGate: checkForecastFreshness');

// Test 1: confirmed lineup + stale model => HOLD
{
  const gate = checkForecastFreshness({ lineup_confirmed: true, model_consumes_lineup: false });
  assert.equal(gate.allow_active_forecast, false, 'Must hold when lineup confirmed but model is stale');
  assert.ok(gate.held_reason.includes('FORECAST_HELD'), 'held_reason must contain FORECAST_HELD');
  assert.ok(gate.held_reason.includes('prior composite'), 'held_reason must mention prior composite');
  console.log('  ✓ lineup_confirmed=true + model_consumes_lineup=false => forecast held');
}

// Test 2: confirmed lineup + model consumed lineup => ALLOW
{
  const gate = checkForecastFreshness({ lineup_confirmed: true, model_consumes_lineup: true });
  assert.equal(gate.allow_active_forecast, true, 'Must allow when model consumed confirmed lineup');
  assert.equal(gate.held_reason, null, 'held_reason must be null when forecast is allowed');
  console.log('  ✓ lineup_confirmed=true + model_consumes_lineup=true => active forecast allowed');
}

// Test 3: lineup not yet confirmed => ALLOW
{
  const gate = checkForecastFreshness({ lineup_confirmed: false, model_consumes_lineup: false });
  assert.equal(gate.allow_active_forecast, true, 'Must allow when lineup not yet confirmed');
  console.log('  ✓ lineup_confirmed=false => active forecast allowed (pre-lock state)');
}

// Test 4: null/missing meta => ALLOW (safe default)
{
  const gate = checkForecastFreshness(null);
  assert.equal(gate.allow_active_forecast, true, 'Null meta should default to allow');
  console.log('  ✓ null forecastMeta defaults to allow (safe)');
}

// ─── renderWcPublicPacket: stale path ─────────────────────────────────────────

console.log('\n► worldCupForecastGate: stale public packet');

{
  const auditArtifact = {};
  const result = renderWcPublicPacket({
    matchMeta: MATCH_META,
    forecastMeta: { lineup_confirmed: true, model_consumes_lineup: false },
    forecast: STALE_FORECAST,
    researchContext: RESEARCH_CONTEXT,
    auditArtifact,
  });

  // Held flag
  assert.equal(result.held, true, 'Packet must be held when stale');
  assert.ok(result.held_reason, 'held_reason must be non-null');

  // Stale numbers must NOT appear in public output
  assert.ok(!result.output.includes('1.37'), 'Projected home goals must be suppressed in public output');
  assert.ok(!result.output.includes('1.27'), 'Projected away goals must be suppressed in public output');
  assert.ok(!result.output.includes('2.64'), 'Projected total must be suppressed in public output');
  assert.ok(!result.output.includes('54%'), 'BTTS % must be suppressed in public output');

  // FORECAST HELD notice must appear
  assert.ok(result.output.includes('FORECAST HELD'), 'FORECAST HELD notice must appear in stale packet');

  // Confirmed XIs must still appear
  assert.ok(result.output.includes('Riyad Mahrez'), 'Confirmed XI must appear even when forecast held');
  assert.ok(result.output.includes('Marko Arnautovic'), 'Confirmed XI must appear even when forecast held');

  // Suppressed numbers preserved in audit artifact
  assert.ok(auditArtifact._suppressed_forecast, 'Suppressed forecast must be in audit artifact');
  assert.equal(auditArtifact._suppressed_forecast.prior_composite.projected_total, 2.64,
    'Suppressed total preserved in audit');

  // Public-safe scan
  assert.equal(result.scan.clean, true, 'Stale public packet must pass banned-language scan');

  console.log('  ✓ stale packet: forecast numbers suppressed in public output');
  console.log('  ✓ stale packet: FORECAST HELD notice present');
  console.log('  ✓ stale packet: confirmed XIs shown');
  console.log('  ✓ stale packet: suppressed numbers in audit artifact');
  console.log('  ✓ stale packet: passes banned-language scan');
}

// ─── renderWcPublicPacket: active path ─────────────────────────────────────────

console.log('\n► worldCupForecastGate: active public packet (model consumed lineup)');

{
  const result = renderWcPublicPacket({
    matchMeta: MATCH_META,
    forecastMeta: { lineup_confirmed: true, model_consumes_lineup: true },
    forecast: STALE_FORECAST, // same numbers, now considered fresh
    researchContext: RESEARCH_CONTEXT,
  });

  assert.equal(result.held, false, 'Packet must NOT be held when model consumed lineup');
  assert.equal(result.held_reason, null, 'held_reason must be null for active packet');

  // Forecast numbers must appear
  assert.ok(result.output.includes('1.37'), 'Projected home goals must appear in active packet');
  assert.ok(result.output.includes('2.64'), 'Projected total must appear in active packet');
  assert.ok(result.output.includes('54%'), 'BTTS % must appear in active packet');

  // Public-safe scan
  assert.equal(result.scan.clean, true, 'Active public packet must pass banned-language scan');

  console.log('  ✓ active packet: forecast numbers rendered when model consumed lineup');
  console.log('  ✓ active packet: passes banned-language scan');
}

console.log('\n✓ worldCupForecastGate tests passed\n');
