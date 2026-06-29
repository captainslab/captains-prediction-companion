/**
 * mlbResearchContext.js
 * MLB pre-game research context layer.
 */

'use strict';

const { callPerplexity, buildMlbUserPrompt } = require('./perplexityClient.js');
const { setArtifact, getArtifact } = require('./researchCache.js');
const { buildCitationMeta } = require('./citationHandler.js');

const SPORT = 'mlb';
const MLB_SYSTEM_PROMPT = `You are a baseball research assistant providing factual pre-game context for a public sports packet.
Respond ONLY with a valid JSON object. Do not include prose, markdown, or explanation outside JSON.
Return null for anything you cannot verify with high confidence.`;

async function fetchMlbResearchContext(game) {
  const eventId = game.eventId || `${game.gameDate}_${game.awayTeam}_${game.homeTeam}`
    .replace(/\s+/g, '-').toLowerCase();

  const cached = getArtifact(SPORT, eventId);
  if (cached) return cached;

  const result = await callPerplexity({
    sport: SPORT,
    systemPrompt: MLB_SYSTEM_PROMPT,
    userPrompt: buildMlbUserPrompt(game),
    dryRun: game.dryRun || false,
  });

  const citationMeta = buildCitationMeta({
    provider: result._meta.provider,
    model: result._meta.model,
    sport: SPORT,
    fetchedUtc: result._meta.fetched_utc,
    rawCitations: result._meta.citations,
    parseStatus: result._meta.parse_status,
    missingFields: result._meta.missing_fields,
    costUsd: result._meta.cost_usd,
  });

  const artifact = { ...result, _citation_meta: citationMeta };
  const ttlMs = result._meta.status === 'ok' ? 30 * 60 * 1000 : 5 * 60 * 1000;
  setArtifact(SPORT, eventId, artifact, ttlMs);
  return artifact;
}

async function fetchMlbSlateContext(games) {
  return Promise.all(games.map((game) => fetchMlbResearchContext(game)));
}

module.exports = {
  fetchMlbResearchContext,
  fetchMlbSlateContext,
  buildMlbUserPrompt,
  MLB_SYSTEM_PROMPT,
};
