/**
 * worldCupResearchContext.js
 * World Cup research context layer.
 */

'use strict';

const { callPerplexity, buildWcUserPrompt } = require('./perplexityClient.js');
const { setArtifact, getArtifact } = require('./researchCache.js');
const { buildCitationMeta } = require('./citationHandler.js');

const SPORT = 'worldcup';
const WC_SYSTEM_PROMPT = `You are a football (soccer) research assistant providing factual match-day context for a public sports packet.
Respond ONLY with a valid JSON object. Do not include prose, markdown, or explanation outside JSON.
Return null for anything you cannot verify with high confidence.`;

function checkForecastFreshness(forecastMeta) {
  const lineup_confirmed = Boolean(forecastMeta?.lineup_confirmed);
  const model_consumes_lineup = forecastMeta?.model_consumes_lineup;
  if (lineup_confirmed && model_consumes_lineup !== true) {
    return {
      allow_active_forecast: false,
      held_reason: 'FORECAST_HELD — Official starting XI confirmed but model composite predates lineup lock. Projected goals, BTTS, margin, and score distribution from prior composite are suppressed in public output. Confirmed XIs and match context are shown. Audit artifact retains prior composite numbers separately.',
    };
  }
  return {
    allow_active_forecast: true,
    held_reason: null,
  };
}

async function fetchWcResearchContext(match) {
  const eventId = match.eventId || `${match.matchDate}_${match.homeTeam}_${match.awayTeam}`
    .replace(/\s+/g, '-').toLowerCase();

  const cached = getArtifact(SPORT, eventId);
  if (cached) return cached;

  const result = await callPerplexity({
    sport: SPORT,
    systemPrompt: WC_SYSTEM_PROMPT,
    userPrompt: buildWcUserPrompt(match),
    dryRun: match.dryRun || false,
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
  const ttlMs = result._meta.status === 'ok' ? 20 * 60 * 1000 : 5 * 60 * 1000;
  setArtifact(SPORT, eventId, artifact, ttlMs);
  return artifact;
}

module.exports = {
  fetchWcResearchContext,
  buildWcUserPrompt,
  checkForecastFreshness,
  WC_SYSTEM_PROMPT,
};
