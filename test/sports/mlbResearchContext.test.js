/**
 * test/sports/mlbResearchContext.test.js
 * Tests: MLB research context feeds public packet rendering.
 * Uses dry-run mode (no live API calls).
 */

'use strict';

const assert = require('node:assert/strict');
const { renderMlbPublicPacket, scanPublicOutput } = require('../../src/sports/publicPacketRenderer');

console.log('\n► mlbResearchContext: public packet rendering from research context');

// Simulated research artifact (as would be returned by fetchMlbResearchContext)
const MOCK_RESEARCH_ARTIFACT = {
  _meta: { status: 'ok', sport: 'mlb', parse_status: 'ok', missing_fields: [] },
  research: {
    home_team: 'Detroit Tigers',
    away_team: 'Houston Astros',
    game_date: '2026-06-27',
    venue: 'Comerica Park',
    home_starter_name: 'Tarik Skubal',
    home_starter_handedness: 'L',
    home_starter_recent_note: '7 IP, 1 ER in last start',
    away_starter_name: 'Framber Valdez',
    away_starter_handedness: 'L',
    away_starter_recent_note: 'Allowed 4 ER in 5 IP last outing',
    home_lineup_status: 'confirmed',
    away_lineup_status: 'projected',
    home_injury_notes: null,
    away_injury_notes: 'Jose Abreu (IL60, back)',
    home_bullpen_note: null,
    away_bullpen_note: null,
    weather_note: '78°F, wind 8 mph out to left field',
    weather_risk: false,
    run_environment_note: 'Comerica Park plays slightly pitcher-friendly',
    recent_series_context: 'Astros took 2 of 3 in last series (April)',
    home_last_5_record: '3-2',
    away_last_5_record: '2-3',
    research_confidence: 'high',
    research_notes: null,
  },
};

// Test: research context feeds packet
{
  const result = renderMlbPublicPacket({
    gameMeta: {
      homeTeam: 'Detroit Tigers',
      awayTeam: 'Houston Astros',
      gameDate: '2026-06-27',
      venue: 'Comerica Park',
    },
    researchContext: MOCK_RESEARCH_ARTIFACT,
  });

  assert.ok(result.output.includes('Tarik Skubal'), 'Home starter must appear in output');
  assert.ok(result.output.includes('Framber Valdez'), 'Away starter must appear in output');
  assert.ok(result.output.includes('Jose Abreu'), 'Injury note must appear in output');
  assert.ok(result.output.includes('78°F'), 'Weather note must appear in output');
  assert.ok(result.output.includes('Comerica Park'), 'Venue must appear in output');
  assert.equal(result.scan.clean, true, 'MLB public packet must pass banned-language scan');

  console.log('  ✓ MLB research context feeds public packet correctly');
  console.log('  ✓ starter, injury, weather, venue all present in output');
  console.log('  ✓ MLB public packet passes banned-language scan');
}

// Test: null research fields are handled gracefully
{
  const result = renderMlbPublicPacket({
    gameMeta: { homeTeam: 'Team A', awayTeam: 'Team B', gameDate: '2026-06-27' },
    researchContext: { research: null },
  });
  assert.ok(result.output.includes('Team B at Team A'), 'Header must render even with null research');
  assert.equal(result.scan.clean, true, 'Null-research packet must still pass scan');
  console.log('  ✓ null research fields handled gracefully');
}

console.log('\n✓ mlbResearchContext tests passed\n');
