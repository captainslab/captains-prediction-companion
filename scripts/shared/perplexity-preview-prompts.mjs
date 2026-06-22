// Shared preview prompt contracts for Perplexity-backed sports research.
// Pure ESM. No I/O.
//
// TODO(full-slate integration): scripts/worldcup/lib/packet-renderer.mjs
// TODO(full-slate integration): scripts/mlb/lib/article-render.mjs

const PACKET_SCHEMA = 'sports_preview_research_v1';

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
  'orderbook',
  'spread prices',
  'spreads',
]);

export const RESEARCH_ARTIFACT_REQUIRED_FIELDS = Object.freeze([
  'schema',
  'sport',
  'packet_type',
  'game_id|match_id',
  'generated_at',
  'source_id',
  'source_urls',
  'source_titles',
  'source_freshness',
  'confirmed_facts',
  'unconfirmed_claims',
  'unavailable_fields',
  'model_safe_inputs',
  'editorial_context',
  'why_this_game_matters|why_this_match_matters',
  'headline_candidates',
  'risk_notes',
]);

function valueOf(input) {
  if (input === null || input === undefined) return 'unknown';
  const text = String(input).trim();
  return text.length ? text : 'unknown';
}

function joinLines(lines) {
  return lines.filter(Boolean).join('\n');
}

function anchorLines(anchor = {}, idKey) {
  const idValue = valueOf(anchor[idKey] ?? anchor.game_id ?? anchor.match_id ?? anchor.slate_id ?? anchor.matchday_id);
  const matchup = valueOf(anchor.matchup ?? anchor.game_matchup ?? anchor.matchup_label ?? anchor.fixture ?? anchor.teams);
  const venue = valueOf(anchor.venue);
  const date = valueOf(anchor.date);
  const kickoff = valueOf(anchor.first_pitch_utc ?? anchor.kickoff_utc ?? anchor.start_time_utc);
  const secondary = Array.isArray(anchor.games) && anchor.games.length
    ? anchor.games.map((game) => `${valueOf(game.game_id ?? game.match_id ?? game.id)} | ${valueOf(game.matchup ?? game.fixture ?? game.teams)} | ${valueOf(game.venue)}`).join('\n')
    : '';

  return joinLines([
    'ANCHORING RULES:',
    `- Anchor this packet to ${idValue}, date ${date}, matchup ${matchup}, and venue ${venue}.`,
    `- Keep kickoff / first pitch in view only as ${kickoff}.`,
    secondary ? '- Additional anchored games or matches:' : '',
    secondary ? secondary : '',
  ]);
}

function forbidLines() {
  return joinLines([
    'PRICE ISOLATION RULES:',
    `- Never mention or infer any of these terms: ${FORBIDDEN_MARKET_TERMS.join(', ')}.`,
    '- If a source only offers market language, respond with "unavailable" instead of guessing.',
    '- Market data never belongs in model_safe_inputs, scoring, posture, ranking, or preview classification.',
  ]);
}

function splitRules() {
  return joinLines([
    'OUTPUT SPLIT RULES:',
    '- Put only sourced lineup/starters, injuries/suspensions, standings/group/seeding, venue/weather/roof, rest/travel, and advancement/elimination facts into model_safe_inputs, and only when sourced.',
    '- Put rivalry / head-to-head, public narrative, history, tournament storyline, momentum, and tactical angle into editorial_context.',
    '- Do not mix market context into either block.',
  ]);
}

function requiredFieldsBlock(whyField) {
  return joinLines([
    'REQUIRED ARTIFACT FIELDS:',
    `- ${RESEARCH_ARTIFACT_REQUIRED_FIELDS.join(', ')}`,
    `- Use ${whyField} as the why-this field for this packet type.`,
  ]);
}

function commonUserPrompt({ sport, packet_type, anchor, whyField, idKey, scopeLabel, outputSchema }) {
  return joinLines([
    `${scopeLabel.toUpperCase()} RESEARCH PACKET`,
    `sport: ${sport}`,
    `packet_type: ${packet_type}`,
    '',
    anchorLines(anchor, idKey),
    '',
    forbidLines(),
    '',
    splitRules(),
    '',
    requiredFieldsBlock(whyField),
    '',
    'RETURN FORMAT:',
    '- Return one JSON object only.',
    '- Return unavailable for any field you cannot source.',
    '- Do not add commentary outside the JSON object.',
    '',
    'RESEARCH ARTIFACT SCHEMA:',
    JSON.stringify(outputSchema, null, 2),
  ]);
}

function makeCommonSchema({ sport, packet_type, idKey, whyField }) {
  return {
    schema: PACKET_SCHEMA,
    sport,
    packet_type,
    [idKey]: '...',
    generated_at: '...',
    source_id: 'perplexity',
    source_urls: ['https://...'],
    source_titles: ['...'],
    source_freshness: {
      status: 'fresh|stale|mixed|unknown',
      notes: ['...'],
    },
    confirmed_facts: ['...'],
    unconfirmed_claims: ['...'],
    unavailable_fields: ['...'],
    model_safe_inputs: {
      starters_or_lineups: '...',
      injuries_or_suspensions: '...',
      standings_group_or_seeding: '...',
      venue_weather_roof: '...',
      rest_travel: '...',
      advancement_or_elimination: '...',
    },
    editorial_context: {
      rivalry_or_h2h: '...',
      public_narrative: '...',
      history: '...',
      tournament_storyline: '...',
      momentum: '...',
      tactical_angle: '...',
    },
    [whyField]: '...',
    headline_candidates: ['...'],
    risk_notes: ['...'],
  };
}

function buildPrompt({ sport, packet_type, anchor, whyField, idKey, scopeLabel }) {
  const outputSchema = makeCommonSchema({ sport, packet_type, idKey, whyField });
  return {
    schema: PACKET_SCHEMA,
    sport,
    packet_type,
    system: `You are a price-isolated ${scopeLabel} research assistant. Return only sourced facts, and answer "unavailable" instead of guessing. Never include market prices or betting language.`,
    user: commonUserPrompt({
      sport,
      packet_type,
      anchor,
      whyField,
      idKey,
      scopeLabel,
      outputSchema,
    }),
    output_schema: outputSchema,
    forbidden_market_terms: [...FORBIDDEN_MARKET_TERMS],
  };
}

export function buildMlbGamePreviewPrompt(anchor = {}) {
  return buildPrompt({
    sport: 'mlb',
    packet_type: 'mlb-game',
    anchor,
    whyField: 'why_this_game_matters',
    idKey: 'game_id',
    scopeLabel: 'mlb',
  });
}

export function buildMlbSlatePreviewPrompt(anchor = {}) {
  return buildPrompt({
    sport: 'mlb',
    packet_type: 'mlb-slate',
    anchor,
    whyField: 'why_this_game_matters',
    idKey: 'game_id',
    scopeLabel: 'mlb slate',
  });
}

export function buildWorldCupMatchPreviewPrompt(anchor = {}) {
  return buildPrompt({
    sport: 'worldcup',
    packet_type: 'worldcup-match',
    anchor,
    whyField: 'why_this_match_matters',
    idKey: 'match_id',
    scopeLabel: 'world cup',
  });
}

export function buildWorldCupMatchdayPreviewPrompt(anchor = {}) {
  return buildPrompt({
    sport: 'worldcup',
    packet_type: 'worldcup-matchday',
    anchor,
    whyField: 'why_this_match_matters',
    idKey: 'match_id',
    scopeLabel: 'world cup matchday',
  });
}
