/**
 * mlbResearchContext.js
 * MLB pre-game research context layer.
 * Fetches, caches, and surfaces live game-day context for CPC MLB packet generation.
 *
 * Output feeds publicPacketRenderer.js — never contains betting/market language.
 * All unknown values are returned as null (never invented).
 */

'use strict';

const { callPerplexity } = require('./perplexityClient');
const { setArtifact, getArtifact } = require('./researchCache');
const { buildCitationMeta } = require('./citationHandler');

const SPORT = 'mlb';

// ─── Prompt Templates ──────────────────────────────────────────────────────────

const MLB_SYSTEM_PROMPT = `You are a baseball research assistant providing factual pre-game context for an AI analysis system.
Respond ONLY with a valid JSON object. Do not include any prose, markdown, or explanation outside the JSON.
For any field you cannot verify with high confidence, return null — do not invent or estimate values.
Do not reference, mention, or include any market prices, numerical probability estimates, or financial data.`;

/**
 * Build the user prompt for a specific MLB game.
 * @param {object} game
 * @param {string} game.homeTeam
 * @param {string} game.awayTeam
 * @param {string} game.gameDate  — YYYY-MM-DD
 * @param {string} [game.venue]
 * @returns {string}
 */
function buildMlbUserPrompt(game) {
  return `Provide pre-game research context for the MLB game: ${game.awayTeam} at ${game.homeTeam} on ${game.gameDate}${game.venue ? ` at ${game.venue}` : ''}.

Return a JSON object with exactly these keys:
{
  "home_team": string,
  "away_team": string,
  "game_date": string,
  "venue": string | null,
  "home_starter_name": string | null,
  "home_starter_handedness": "R" | "L" | "S" | null,
  "home_starter_recent_note": string | null,
  "away_starter_name": string | null,
  "away_starter_handedness": "R" | "L" | "S" | null,
  "away_starter_recent_note": string | null,
  "home_lineup_status": "confirmed" | "projected" | "unavailable" | null,
  "away_lineup_status": "confirmed" | "projected" | "unavailable" | null,
  "home_injury_notes": string | null,
  "away_injury_notes": string | null,
  "home_bullpen_note": string | null,
  "away_bullpen_note": string | null,
  "weather_note": string | null,
  "weather_risk": boolean | null,
  "run_environment_note": string | null,
  "recent_series_context": string | null,
  "home_last_5_record": string | null,
  "away_last_5_record": string | null,
  "research_confidence": "high" | "medium" | "low",
  "research_notes": string | null
}

Constraints:
- Return null for any field you cannot verify.
- Do not include any price, probability estimate, or financial figure.
- Do not use the words: bet, betting, wager, odds, moneyline, prop, pick, lean, lock, fade, edge, bankroll, stake, unit.`;
}

// ─── Core ─────────────────────────────────────────────────────────────────────────

/**
 * Fetch MLB pre-game research context for a single game.
 * Returns cached artifact if fresh; otherwise calls Perplexity and caches result.
 *
 * @param {object} game
 * @param {string} game.awayTeam
 * @param {string} game.homeTeam
 * @param {string} game.gameDate    — YYYY-MM-DD
 * @param {string} [game.venue]
 * @param {string} [game.eventId]   — unique identifier for caching
 * @param {boolean} [game.dryRun]   — skip API, return safe fallback
 * @returns {Promise<object>}       — { _meta, research }
 */
async function fetchMlbResearchContext(game) {
  const eventId = game.eventId || `${game.gameDate}_${game.awayTeam}_${game.homeTeam}`
    .replace(/\s+/g, '-').toLowerCase();

  // ── Cache check ──
  const cached = getArtifact(SPORT, eventId);
  if (cached) return cached;

  // ── Call Perplexity ──
  const result = await callPerplexity({
    sport: SPORT,
    systemPrompt: MLB_SYSTEM_PROMPT,
    userPrompt: buildMlbUserPrompt(game),
    dryRun: game.dryRun || false,
  });

  // ── Enrich _meta with structured citation block ──
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

  // ── Cache result (even fallbacks, so we don't hammer on failure) ──
  const ttlMs = result._meta.status === 'ok' ? 30 * 60 * 1000 : 5 * 60 * 1000;
  setArtifact(SPORT, eventId, artifact, ttlMs);

  return artifact;
}

/**
 * Fetch research context for a full slate of MLB games.
 * @param {Array<object>} games — array of game objects (same shape as fetchMlbResearchContext)
 * @returns {Promise<Array<object>>}
 */
async function fetchMlbSlateContext(games) {
  return Promise.all(games.map(g => fetchMlbResearchContext(g)));
}

module.exports = {
  fetchMlbResearchContext,
  fetchMlbSlateContext,
  buildMlbUserPrompt,
  MLB_SYSTEM_PROMPT,
};
