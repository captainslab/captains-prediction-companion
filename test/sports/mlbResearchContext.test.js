'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { fetchMlbResearchContext } = require('../../src/sports/mlbResearchContext.js');

test('fetchMlbResearchContext attaches a structured research context to the game object', async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.PERPLEXITY_API_KEY;
  let called = false;

  process.env.PERPLEXITY_API_KEY = 'unit-test-key';
  global.fetch = async (url, options) => {
    called = true;
    assert.equal(url, 'https://api.perplexity.ai/chat/completions');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'sonar');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
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
              weather_note: '78F, wind 8 mph out to left field',
              weather_risk: false,
              run_environment_note: 'Comerica Park plays slightly pitcher-friendly',
              recent_series_context: 'Astros took 2 of 3 in last series',
              home_last_5_record: '3-2',
              away_last_5_record: '2-3',
              research_confidence: 'high',
              research_notes: null,
            }),
          },
        }],
        citations: [{ url: 'https://example.com', title: 'Example', snippet: 'snippet' }],
        usage: { cost: { total_cost: 0.0001 } },
      }),
    };
  };

  try {
    const game = {
      eventId: `mlb-test-${Date.now()}`,
      gameDate: '2026-06-27',
      awayTeam: 'Houston Astros',
      homeTeam: 'Detroit Tigers',
      venue: 'Comerica Park',
    };

    const research = await fetchMlbResearchContext(game);
    game.research_context = research;

    assert.equal(called, true);
    assert.equal(research.ok, true);
    assert.equal(research.status, 'ok');
    assert.equal(research.error, null);
    assert.equal(research.research.home_starter_name, 'Tarik Skubal');
    assert.equal(research.research.away_starter_name, 'Framber Valdez');
    assert.equal(research.research.away_injury_notes, 'Jose Abreu (IL60, back)');
    assert.equal(research._meta.status, 'ok');
    assert.ok(research._citation_meta);
    assert.equal(research._citation_meta.citation_count, 1);
    assert.equal(game.research_context.research.home_team, 'Detroit Tigers');
    assert.equal(game.research_context.research.away_team, 'Houston Astros');
    assert.equal(game.research_context.research.home_starter_name, 'Tarik Skubal');
    assert.equal(game.research_context._meta.status, 'ok');
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) {
      delete process.env.PERPLEXITY_API_KEY;
    } else {
      process.env.PERPLEXITY_API_KEY = originalKey;
    }
  }
});
