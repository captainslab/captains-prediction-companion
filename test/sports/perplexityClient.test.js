'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  auditPrompt,
  buildSafeFallback,
  BANNED_PROMPT_TERMS,
  buildMlbUserPrompt,
  buildWcUserPrompt,
  callPerplexity,
  formatCitationBlock,
  hasPerplexityKey,
  maxTokens,
  readPerplexityKey,
} = require('../../src/sports/perplexityClient.js');

test('auditPrompt skips policy blocks and flags banned terms outside them', () => {
  const safe = auditPrompt(
    'Write for a general audience. [POLICY_START] betting odds and moneyline [POLICY_END]',
    { skipPolicyBlock: true },
  );
  assert.equal(safe.safe, true);
  assert.deepEqual(safe.violations, []);

  const dirty = auditPrompt('The betting odds and moneyline are public.');
  assert.equal(dirty.safe, false);
  assert.ok(dirty.violations.includes('betting'));
  assert.ok(dirty.violations.includes('moneyline'));
});

test('every banned prompt term is still detected', () => {
  for (const term of BANNED_PROMPT_TERMS) {
    const result = auditPrompt(`Research the ${term} for this match.`);
    assert.equal(result.safe, false, `term "${term}" should trigger audit failure`);
  }
});

test('buildMlbUserPrompt and buildWcUserPrompt are audit-clean', () => {
  const mlbPrompt = buildMlbUserPrompt({
    awayTeam: 'Houston Astros',
    homeTeam: 'Detroit Tigers',
    gameDate: '2026-06-27',
    venue: 'Comerica Park',
  });
  const wcPrompt = buildWcUserPrompt({
    awayTeam: 'Austria',
    homeTeam: 'Algeria',
    matchDate: '2026-06-27',
    venue: 'Kansas City Stadium',
    group: 'Group J',
  });

  assert.equal(auditPrompt(mlbPrompt, { skipPolicyBlock: true }).safe, true);
  assert.equal(auditPrompt(wcPrompt, { skipPolicyBlock: true }).safe, true);
});

test('callPerplexity reaches the API path with a key and returns the shared shape', async () => {
  const originalFetch = global.fetch;
  let called = false;
  let requestBody = null;
  global.fetch = async (url, options) => {
    called = true;
    requestBody = JSON.parse(options.body);
    assert.equal(url, 'https://api.perplexity.ai/chat/completions');
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
    const prompt = buildMlbUserPrompt({
      awayTeam: 'Houston Astros',
      homeTeam: 'Detroit Tigers',
      gameDate: '2026-06-27',
      venue: 'Comerica Park',
    });

    const result = await callPerplexity({
      sport: 'mlb',
      systemPrompt: 'You are a research assistant.',
      userPrompt: prompt,
      env: { PERPLEXITY_API_KEY: 'test-key' },
      domainAllowlist: ['example.com'],
      timeout: 5000,
      temperature: 0.2,
    });

    assert.equal(called, true);
    assert.equal(requestBody.search_domain_filter[0], 'example.com');
    assert.equal(requestBody.temperature, 0.2);
    assert.equal(requestBody.max_tokens, maxTokens('mlb'));
    assert.equal(result.ok, true);
    assert.equal(result.status, 'ok');
    assert.equal(result.error, null);
    assert.equal(result.research.home_starter_name, 'Tarik Skubal');
    assert.equal(result.research.away_starter_name, 'Framber Valdez');
    assert.match(formatCitationBlock(result.citations), /Example/);
    assert.ok(hasPerplexityKey({ PERPLEXITY_API_KEY: 'test-key' }));
    assert.equal(readPerplexityKey({ PERPLEXITY_API_KEY: ' test-key ' }), 'test-key');
  } finally {
    global.fetch = originalFetch;
  }
});

test('buildSafeFallback keeps the shared return shape', () => {
  const fallback = buildSafeFallback('worldcup', 'no_api_key');
  assert.equal(fallback.ok, false);
  assert.equal(fallback.status, 'unavailable');
  assert.equal(fallback.content, null);
  assert.deepEqual(fallback.citations, []);
  assert.equal(fallback.error, 'no_api_key');
  assert.equal(fallback._meta.status, 'unavailable');
  assert.equal(fallback.research, null);
});
