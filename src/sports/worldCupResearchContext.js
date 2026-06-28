/**
 * worldCupResearchContext.js
 * World Cup research context layer.
 * Fetches, caches, and surfaces live match-day context for CPC World Cup packet generation.
 *
 * Output feeds publicPacketRenderer.js.
 * All unknown values are returned as null (never invented).
 * Contains the stale-model forecast gate: if official XIs are confirmed but the
 * model has NOT consumed the confirmed XI state, active forecast language is blocked.
 */

'use strict';

const { callPerplexity } = require('./perplexityClient');
const { setArtifact, getArtifact } = require('./researchCache');
const { buildCitationMeta } = require('./citationHandler');

const SPORT = 'worldcup';

// ─── Prompt Templates ──────────────────────────────────────────────────────────

const WC_SYSTEM_PROMPT = `You are a football (soccer) research assistant providing factual match-day context for an AI analysis system.
Respond ONLY with a valid JSON object. Do not include any prose, markdown, or explanation outside the JSON.
For any field you cannot verify with high confidence, return null — do not invent or estimate values.
Do not reference, mention, or include any market prices, numerical probability estimates, or financial data.`;

/**
 * Build user prompt for a World Cup match.
 * @param {object} match
 * @returns {string}
 */
function buildWcUserPrompt(match) {
  return `Provide pre-match research context for the FIFA World Cup match: ${match.homeTeam} vs ${match.awayTeam} on ${match.matchDate}${match.venue ? ` at ${match.venue}` : ''}${match.group ? ` (${match.group})` : ''}.

Return a JSON object with exactly these keys:
{
  "home_team": string,
  "away_team": string,
  "match_date": string,
  "venue": string | null,
  "group": string | null,
  "home_confirmed_xi": string[] | null,
  "away_confirmed_xi": string[] | null,
  "home_xi_source": string | null,
  "away_xi_source": string | null,
  "home_xi_confirmed": boolean | null,
  "away_xi_confirmed": boolean | null,
  "home_injury_notes": string | null,
  "away_injury_notes": string | null,
  "home_suspension_notes": string | null,
  "away_suspension_notes": string | null,
  "group_standings_note": string | null,
  "advancement_context": string | null,
  "recent_form_home": string | null,
  "recent_form_away": string | null,
  "match_context_note": string | null,
  "research_confidence": "high" | "medium" | "low",
  "research_notes": string | null
}

Constraints:
- Return null for any field you cannot verify.
- Do not include any price, probability estimate, or financial figure.
- Do not use the words: bet, betting, wager, odds, moneyline, prop, pick, lean, lock, fade, edge, bankroll, stake, unit.`;
}

// ─── Stale-Model Gate ────────────────────────────────────────────────────────────

/**
 * World Cup stale-model forecast freshness gate.
 *
 * RULE: If official XIs are confirmed AND the model did NOT consume the confirmed
 * XI state (model_consumes_lineup === false), the public packet MUST NOT render
 * active forecast language or stale projected goals / BTTS / margin / score numbers.
 *
 * @param {object} forecastMeta
 * @param {boolean} forecastMeta.lineup_confirmed   — true if official XI is locked
 * @param {boolean} forecastMeta.model_consumes_lineup — true if model was run with confirmed XI
 * @returns {{ allow_active_forecast: boolean, held_reason: string | null }}
 */
function checkForecastFreshness(forecastMeta) {
  const { lineup_confirmed = false, model_consumes_lineup = false } = forecastMeta || {};

  if (lineup_confirmed && !model_consumes_lineup) {
    return {
      allow_active_forecast: false,
      held_reason:
        'FORECAST_HELD — Official starting XI confirmed but model composite predates lineup lock. ' +
        'Projected goals, BTTS, margin, and score distribution from prior composite are suppressed ' +
        'in public output. Confirmed XIs and match context are shown. ' +
        'Audit artifact retains prior composite numbers separately.',
    };
  }

  return {
    allow_active_forecast: true,
    held_reason: null,
  };
}

// ─── Core ─────────────────────────────────────────────────────────────────────────

/**
 * Fetch World Cup pre-match research context.
 * Returns cached artifact if fresh; otherwise calls Perplexity and caches result.
 *
 * @param {object} match
 * @param {string} match.homeTeam
 * @param {string} match.awayTeam
 * @param {string} match.matchDate        — YYYY-MM-DD
 * @param {string} [match.venue]
 * @param {string} [match.group]          — e.g. 'Group J'
 * @param {string} [match.eventId]        — unique identifier for caching
 * @param {boolean} [match.dryRun]
 * @returns {Promise<object>}             — { _meta, _citation_meta, research }
 */
async function fetchWcResearchContext(match) {
  const eventId = match.eventId || `${match.matchDate}_${match.homeTeam}_${match.awayTeam}`
    .replace(/\s+/g, '-').toLowerCase();

  // ── Cache check ──
  const cached = getArtifact(SPORT, eventId);
  if (cached) return cached;

  // ── Call Perplexity ──
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
