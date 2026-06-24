// MLB Perplexity research prompt builder.
//
// Pure ESM (no network, no side effects). Builds standardized, game-anchored
// Perplexity research prompts that:
//   - anchor every query to a specific game_pk + date + matchup + venue,
//   - treat the MLB official/local adapter as the source of truth for live state,
//   - keep Perplexity SUPPLEMENTAL only (lineup/news, injury, starter, weather/park,
//     storyline, series_context),
//   - explicitly forbid betting odds, Kalshi prices, bid/ask, open interest,
//     volume, liquidity, sportsbook lines, money lines, point spreads, and
//     market prices/ladders (Price Isolation Invariant),
//   - refuse cross-day contamination (a prior/future game of the same matchup may
//     only appear as `series_context`, never as current-game state),
//   - require source URLs + titles for EVERY claim and the literal answer
//     "unavailable"/UNAVAILABLE instead of guessing.
//
// No I/O. No dependencies.

export const QUERY_TYPES = Object.freeze([
  'PRE_GAME',
  'IN_GAME',
  'POST_GAME',
  'LINEUP_INJURY_ONLY',
  'WEATHER_PARK_ONLY',
]);

// Literal forbidden market terms — these exact words/phrases must appear in the
// forbid instructions so price-isolation tests can assert them.
export const FORBIDDEN_MARKET_TERMS = Object.freeze([
  'betting odds',
  'Kalshi prices',
  'bid/ask',
  'open interest',
  'volume',
  'liquidity',
  'sportsbook lines',
  'money lines',
  'point spreads',
  'market prices',
  'market ladders',
]);

// The exact JSON response schema the prompt instructs Perplexity to return.
export const OUTPUT_SCHEMA = Object.freeze({
  query_type: 'PRE_GAME|IN_GAME|POST_GAME|LINEUP_INJURY_ONLY|WEATHER_PARK_ONLY',
  game_anchor: {
    game_pk: '...',
    date: '...',
    away_team: '...',
    home_team: '...',
    venue: '...',
    first_pitch_utc: '...',
  },
  facts: [
    {
      claim: '...',
      category: 'lineup|injury|starter|weather|park|storyline|series_context',
      status: 'CONFIRMED|UNCONFIRMED|CONFLICTED|UNAVAILABLE',
      source_title: '...',
      source_url: '...',
      source_time_or_date: '...',
    },
  ],
  conflicts: [{ claim: '...', conflict: '...', source_urls: [] }],
  forbidden_market_data_present: false,
  summary: '...',
});

function val(x) {
  if (x === null || x === undefined) return 'unknown';
  const s = String(x).trim();
  return s.length ? s : 'unknown';
}

function anchorBlock(a = {}) {
  const starterAway = a.away_starter ? val(a.away_starter) : 'unknown';
  const starterHome = a.home_starter ? val(a.home_starter) : 'unknown';
  return [
    'GAME ANCHOR (the ONLY game this query is about):',
    `- game_pk: ${a.game_pk ? val(a.game_pk) : 'unknown'}`,
    `- date: ${val(a.date)}`,
    `- away_team: ${val(a.away_team)}`,
    `- home_team: ${val(a.home_team)}`,
    `- venue: ${val(a.venue)}`,
    `- first_pitch_utc: ${val(a.first_pitch_utc)}`,
    `- official away starter: ${starterAway}`,
    `- official home starter: ${starterHome}`,
  ].join('\n');
}

function forbidBlock() {
  return [
    'FORBIDDEN — market/price data must NOT appear anywhere in your output:',
    `Do NOT report or reference ${FORBIDDEN_MARKET_TERMS.join(', ')}.`,
    'No Kalshi prices, no sportsbook lines, no implied probabilities derived from any price.',
    'Set "forbidden_market_data_present" to true ONLY if you were forced to ignore such data; never include the data itself.',
  ].join('\n');
}

function commonRules(a = {}) {
  return [
    'SOURCE HIERARCHY:',
    '- The MLB official/local adapter is the SOURCE OF TRUTH for game_pk, live state, inning, score, starters, and status.',
    '- You (Perplexity) are SUPPLEMENTAL ONLY: lineup/news, injury, starter confirmation, weather/park (only if official is missing), and matchup/storyline.',
    '',
    'ANCHORING / NO CROSS-DAY CONTAMINATION:',
    `- Report ONLY the game on ${val(a.date)} between ${val(a.away_team)} at ${val(a.home_team)} at ${val(a.venue)} (game_pk ${a.game_pk ? val(a.game_pk) : 'unknown'}).`,
    '- EXCLUDE previous-day and future games of the same matchup. Do NOT use any prior or later game of this matchup as current-game state.',
    '- A prior/later game of the same matchup may ONLY appear with category "series_context" — never as lineup, starter, weather, or live state for this anchor.',
    `- If a source\'s date does not match ${val(a.date)}, either drop it or mark it status "CONFLICTED" / category "series_context".`,
    '',
    'EVIDENCE REQUIREMENTS:',
    '- Every claim MUST include a source_title and a source_url. Claims without a source URL are not allowed.',
    '- Include source_time_or_date for every claim so it can be checked against the anchor date.',
    '- If a fact cannot be confirmed from a source, return the literal status "UNAVAILABLE" and the word "unavailable" in the claim — do NOT guess, infer, or fabricate.',
    '',
    forbidBlock(),
    '',
    'OUTPUT:',
    '- Return ONLY the JSON object matching the schema below. No prose outside the JSON.',
  ].join('\n');
}

function schemaBlock() {
  return [
    'REQUIRED OUTPUT SCHEMA (return exactly this shape):',
    JSON.stringify(OUTPUT_SCHEMA, null, 2),
  ].join('\n');
}

const SYSTEM_BY_TYPE = {
  PRE_GAME:
    'You are a price-free MLB research assistant. Report only sourced, game-anchored facts. Never invent lineups, starters, scores, or weather. Never include betting/market/price data. If a fact is unconfirmed, return UNAVAILABLE.',
  IN_GAME:
    'You are a price-free MLB research assistant. Official MLB live state is authoritative; you must not decide or override the live score. Report only sourced supplemental facts. Never include betting/market/price data. If a fact is unconfirmed, return UNAVAILABLE.',
  POST_GAME:
    'You are a price-free MLB research assistant. Report a final recap ONLY after MLB official reports the game as final; otherwise return UNAVAILABLE for the final result. Never include betting/market/price data. If a fact is unconfirmed, return UNAVAILABLE.',
  LINEUP_INJURY_ONLY:
    'You are a price-free MLB research assistant restricted to lineup and injury facts. Report only sourced, game-anchored lineup/injury facts. Never include betting/market/price data. If a fact is unconfirmed, return UNAVAILABLE.',
  WEATHER_PARK_ONLY:
    'You are a price-free MLB research assistant restricted to weather and park facts, and only when official weather is missing. Report only sourced, game-anchored facts. Never include betting/market/price data. If a fact is unconfirmed, return UNAVAILABLE.',
};

function taskBlock(queryType) {
  switch (queryType) {
    case 'PRE_GAME':
      return [
        'TASK (PRE_GAME):',
        '- Confirm the projected/announced starting pitchers for each side (category "starter").',
        '- Confirm or report the projected/announced lineups (category "lineup").',
        '- Report any injury or roster news affecting this game (category "injury").',
        '- Report weather/park conditions ONLY if the official adapter is missing them (category "weather"/"park").',
        '- Report one or two key storylines (category "storyline").',
      ].join('\n');
    case 'IN_GAME':
      return [
        'TASK (IN_GAME):',
        '- Official MLB live state (inning, score, base/out, status) is AUTHORITATIVE. You must NOT decide or override the live score.',
        '- Provide only supplemental in-game context: confirmed lineup changes, injuries during the game, weather changes (category lineup/injury/weather/park/storyline).',
        '- Do NOT report a final result while the game is live; if the game is not final, return UNAVAILABLE for any final-result claim.',
      ].join('\n');
    case 'POST_GAME':
      return [
        'TASK (POST_GAME):',
        '- A final recap is allowed ONLY after MLB official reports the game is final. If MLB official has not reported the game final, return UNAVAILABLE for the final result.',
        '- When final, report the recap and key storylines (category "storyline"), plus any injuries reported from the game (category "injury").',
      ].join('\n');
    case 'LINEUP_INJURY_ONLY':
      return [
        'TASK (LINEUP_INJURY_ONLY):',
        '- Restrict all facts to category "lineup" or "injury" (starter confirmation counts as "starter").',
        '- Do NOT report weather, park, score, or storyline facts.',
      ].join('\n');
    case 'WEATHER_PARK_ONLY':
      return [
        'TASK (WEATHER_PARK_ONLY):',
        '- Restrict all facts to category "weather" or "park", and ONLY when official weather is missing.',
        '- Do NOT report lineup, injury, starter, score, or storyline facts.',
      ].join('\n');
    default:
      return '';
  }
}

/**
 * Build a standardized, game-anchored, price-free MLB Perplexity research prompt.
 * Pure: no network, no side effects.
 *
 * @param {string} queryType One of QUERY_TYPES.
 * @param {object} gameAnchor { game_pk, date, away_team, home_team, venue, first_pitch_utc, away_starter?, home_starter? }
 * @param {object} [opts]
 * @returns {{ query_type: string, system: string, user: string, output_schema: object, forbidden_market_terms: string[] }}
 */
export function buildMlbResearchPrompt(queryType, gameAnchor = {}, opts = {}) {
  if (!QUERY_TYPES.includes(queryType)) {
    throw new Error(`Unknown queryType: ${queryType}. Expected one of ${QUERY_TYPES.join(', ')}.`);
  }
  const a = gameAnchor || {};
  const user = [
    `MLB RESEARCH REQUEST — query_type: ${queryType}`,
    '',
    anchorBlock(a),
    '',
    taskBlock(queryType),
    '',
    commonRules(a),
    '',
    schemaBlock(),
  ].join('\n');

  return {
    query_type: queryType,
    system: SYSTEM_BY_TYPE[queryType],
    user,
    output_schema: OUTPUT_SCHEMA,
    forbidden_market_terms: [...FORBIDDEN_MARKET_TERMS],
  };
}

function normDate(x) {
  if (x === null || x === undefined) return '';
  // Accept "2026-06-20" or ISO timestamps; compare on the YYYY-MM-DD prefix.
  const s = String(x).trim();
  const m = s.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : s;
}

/**
 * Classify a parsed research fact against the game anchor.
 * Pure: no network, no side effects.
 *
 * Returns whether the fact belongs to the current game or is contamination.
 * A fact whose source_time_or_date/date does not match the anchor date is NOT
 * treated as current-game state: it is reported as CONFLICTED and coerced to
 * category "series_context".
 *
 * @param {object} fact Parsed fact: { claim, category, status, source_time_or_date, date? }
 * @param {object} gameAnchor { date, ... }
 * @returns {{ belongs_to_current_game: boolean, status: string, category: string, reason: string }}
 */
export function classifyResearchFact(fact = {}, gameAnchor = {}) {
  const f = fact || {};
  const anchorDate = normDate(gameAnchor?.date);
  const factDate = normDate(f.source_time_or_date ?? f.date);

  // No date to check against → cannot affirm current-game membership; preserve
  // incoming status but do not assert it belongs to the current game.
  if (!anchorDate || !factDate) {
    return {
      belongs_to_current_game: false,
      status: f.status || 'UNCONFIRMED',
      category: f.category || 'storyline',
      reason: 'missing_date',
    };
  }

  if (factDate !== anchorDate) {
    // Cross-day contamination: never current-game state.
    return {
      belongs_to_current_game: false,
      status: 'CONFLICTED',
      category: 'series_context',
      reason: `date_mismatch(${factDate}!=${anchorDate})`,
    };
  }

  // Date matches the anchor → belongs to the current game; keep its category.
  return {
    belongs_to_current_game: true,
    status: f.status || 'UNCONFIRMED',
    category: f.category || 'storyline',
    reason: 'date_match',
  };
}

export default { buildMlbResearchPrompt, classifyResearchFact, QUERY_TYPES, FORBIDDEN_MARKET_TERMS, OUTPUT_SCHEMA };
