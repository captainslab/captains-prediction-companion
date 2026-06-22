// Shared preview prompt contracts for Perplexity-backed sports research.
// Pure ESM. No I/O.
//
// TODO(full-slate integration): scripts/worldcup/lib/packet-renderer.mjs
// TODO(full-slate integration): scripts/mlb/lib/article-render.mjs

import {
  CPC_RESEARCH_ARTIFACT_SCHEMA,
  makeEmptyCpcResearchArtifact,
} from './cpc-research-artifact-schema.mjs';

const PACKET_SCHEMA = 'sports_preview_research_v1';

// Shared forbidden market-term set. Superset of the repo's neutrality patterns.
// Existing terms are kept first (existing prompts/tests depend on them); the
// PDF superset additions follow. De-duped, case-insensitive uniqueness.
const FORBIDDEN_MARKET_TERMS_BASE = [
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
];

const FORBIDDEN_MARKET_TERMS_ADDITIONS = [
  'prices',
  'odds',
  'bid',
  'ask',
  'yes_bid',
  'yes_ask',
  'no_bid',
  'no_ask',
  'last_price',
  'market price',
  'yes/no price',
  'moneyline',
  'spread',
  'vol',
  'open_interest',
  'oi',
  'ladder',
  'ladders',
  'implied probability',
  'implied_prob',
  'order_book',
  'market_snapshot',
];

function dedupeTerms(terms) {
  const seen = new Set();
  const out = [];
  for (const term of terms) {
    const key = String(term).trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

export const FORBIDDEN_MARKET_TERMS = Object.freeze(
  dedupeTerms([...FORBIDDEN_MARKET_TERMS_BASE, ...FORBIDDEN_MARKET_TERMS_ADDITIONS]),
);

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

// ---------------------------------------------------------------------------
// Generalized CPC research prompt contracts (cpc_research_artifact_v1).
//
// Perplexity is a source-backed extractor only. Route and submarket for mention
// families are resolved deterministically by CPC and passed IN as inputs; the
// prompts never ask Perplexity to classify route. Every contract requires one
// JSON object, the model_safe_inputs / editorial_context split, and the full
// forbidden-market-term set.
// ---------------------------------------------------------------------------

const COMMON_SYSTEM_CLAUSE =
  'Return one JSON object only. Never output markdown, layout, picks, prices, probabilities, scores, or rankings. ' +
  'Split verified facts into model_safe_inputs and narrative context into editorial_context. ' +
  'Use "unavailable" instead of guessing. Never invent facts.';

const MENTIONS_FAMILY = 'mentions';

function keyPlaceholderObject(keys) {
  const out = {};
  for (const key of keys) out[key] = '...';
  return out;
}

function anchorValue(anchor, key, fallback = 'unavailable') {
  const raw = anchor && anchor[key];
  if (raw === null || raw === undefined) return fallback;
  const text = String(raw).trim();
  return text.length ? text : fallback;
}

function bulletList(keys) {
  return keys.map((key) => `- ${key}`).join('\n');
}

export function buildCpcResearchPrompt({
  packet_family,
  packet_type,
  route,
  submarket,
  systemSentence,
  primarySourceBias,
  modelSafeKeys,
  editorialKeys,
  anchor = {},
}) {
  const resolvedRoute = route;
  const resolvedSubmarket = submarket;

  const outputSchema = makeEmptyCpcResearchArtifact({
    packet_family,
    packet_type,
    route: resolvedRoute,
    submarket: resolvedSubmarket,
    event_id: anchorValue(anchor, 'event_id', '{{event_id}}'),
    market_id: anchorValue(anchor, 'market_id', '{{market_id_or_unavailable}}'),
    event_url: anchorValue(anchor, 'event_url', '{{event_url}}'),
    model_safe_inputs: keyPlaceholderObject(modelSafeKeys),
    editorial_context: keyPlaceholderObject(editorialKeys),
  });

  const isMentions = packet_family === MENTIONS_FAMILY;

  const userLines = [
    `Research this ${packet_type} for CPC.`,
    '',
    `packet_family: ${packet_family}`,
    `packet_type: ${packet_type}`,
    `route: ${resolvedRoute}`,
    `submarket: ${resolvedSubmarket}`,
    `event_id: ${anchorValue(anchor, 'event_id', '{{event_id}}')}`,
    `market_id: ${anchorValue(anchor, 'market_id', '{{market_id_or_unavailable}}')}`,
    `event_url: ${anchorValue(anchor, 'event_url', '{{event_url}}')}`,
    `date_central: ${anchorValue(anchor, 'date_central', '{{date_central}}')}`,
  ];

  if (isMentions) {
    userLines.push(
      'route and submarket are already resolved by CPC; do not reclassify them.',
    );
  }

  userLines.push(
    '',
    primarySourceBias,
    '',
    'Return one JSON object with the common CPC research artifact schema.',
    'Populate model_safe_inputs only with:',
    bulletList(modelSafeKeys),
    '',
    'Populate editorial_context only with:',
    bulletList(editorialKeys),
    '',
    `Forbidden terms and fields: ${FORBIDDEN_MARKET_TERMS.join(', ')}.`,
    'Use "unavailable" instead of guessing. Never output prices, odds, probabilities, scores, picks, or rankings.',
    '',
    'RESEARCH ARTIFACT SCHEMA:',
    JSON.stringify(outputSchema, null, 2),
  );

  return {
    schema: CPC_RESEARCH_ARTIFACT_SCHEMA,
    packet_family,
    packet_type,
    route: resolvedRoute,
    submarket: resolvedSubmarket,
    system: `${systemSentence} ${COMMON_SYSTEM_CLAUSE}`,
    user: userLines.join('\n'),
    output_schema: outputSchema,
    forbidden_market_terms: [...FORBIDDEN_MARKET_TERMS],
  };
}

// Per-category configuration tables (from the PDF comparison tables).
const CPC_RESEARCH_PROMPT_CONFIG = Object.freeze({
  'mlb-game': {
    packet_family: 'sports',
    route: 'mlb_game',
    submarket: 'game_preview',
    systemSentence: 'You are CPC research extraction for a single MLB game.',
    primarySourceBias:
      'Use primary sources first: MLB probable pitchers, MLB starting lineups, MLB injury report, MLB standings, official team/league game notes, and an official weather source when relevant.',
    modelSafeKeys: ['probable_pitchers', 'confirmed_lineups', 'injury_report', 'standings_context', 'venue_weather_roof', 'rest_travel', 'bullpen_usage_last_3d', 'series_state'],
    editorialKeys: ['rivalry_or_series_note', 'head_to_head_note', 'public_narrative', 'tactical_matchup', 'historical_context'],
  },
  'mlb-slate': {
    packet_family: 'sports',
    route: 'mlb_slate',
    submarket: 'slate_preview',
    systemSentence: 'You are CPC research extraction for a full MLB slate.',
    primarySourceBias:
      'Use primary sources first: MLB schedule, standings, probable pitchers, starting lineups, injury report, official team notes, and official weather sources where relevant.',
    modelSafeKeys: ['schedule', 'probable_pitcher_board', 'lineup_watch', 'injury_clusters', 'standings_pressure', 'doubleheader_flags', 'travel_spots', 'weather_clusters'],
    editorialKeys: ['division_race_storylines', 'ace_duels', 'bullpen_stress_clusters', 'rivalry_clusters', 'slate_headline_themes'],
  },
  'worldcup-match': {
    packet_family: 'sports',
    route: 'worldcup_match',
    submarket: 'match_preview',
    systemSentence: 'You are CPC research extraction for one World Cup match.',
    primarySourceBias:
      'Prefer primary sources such as official competition pages, federation releases, official team announcements, and official lineup or squad sources.',
    modelSafeKeys: ['team_quality_baseline', 'recent_form', 'attacking_strength', 'defensive_strength', 'opponent_adjusted_attack', 'opponent_adjusted_defense', 'opponent_style_fit', 'set_piece_matchup', 'goalkeeper_edge', 'squad_availability', 'lineup_strength_delta', 'rest_travel_venue_climate', 'tournament_incentive_state', 'knockout_extra_time_penalty', 'suspensions_and_discipline'],
    editorialKeys: ['group_or_knockout_pressure', 'historical_meeting_note', 'manager_tactical_theme', 'public_storyline', 'rivalry_or_regional_context'],
  },
  'worldcup-matchday': {
    packet_family: 'sports',
    route: 'worldcup_matchday',
    submarket: 'matchday_preview',
    systemSentence: 'You are CPC research extraction for a full World Cup matchday.',
    primarySourceBias:
      'Prefer primary sources such as official competition pages, federation releases, official team announcements, and official squad/lineup sources.',
    modelSafeKeys: ['schedule', 'group_table_snapshot', 'lineup_watch', 'suspension_watch', 'travel_and_rest_clusters', 'venue_and_climate_overview', 'advancement_and_elimination_states', 'knockout_rule_context'],
    editorialKeys: ['matchday_headlines', 'group_pressure_storylines', 'revenge_or_rematch_notes', 'tactical_clusters', 'public_attention_themes'],
  },
  'mentions-daily': {
    packet_family: 'mentions',
    route: 'multi_route_mentions',
    submarket: 'daily_board',
    systemSentence: 'You are CPC research extraction for a full day of Kalshi mentions events. Use the provided route metadata for each event instead of inventing new routes.',
    primarySourceBias:
      'Use primary sources first: official schedule/event pages, route-specific official documents, and transcript status.',
    modelSafeKeys: ['events_summary', 'event_schedule', 'resolved_routes', 'official_source_map', 'speaker_or_cast_lists', 'witness_or_guest_lists', 'transcript_or_video_status', 'strike_catalog_summary', 'word_bank_summary', 'threshold_rules_summary'],
    editorialKeys: ['cross_event_themes', 'headline_events', 'collision_or_overlap_notes', 'repeat_topic_watch', 'narrative_risk_summary'],
  },
  'mention-event': {
    packet_family: 'mentions',
    route: '{{resolved_route}}',
    submarket: 'event',
    systemSentence: 'You are CPC research extraction for one mentions event. Do not classify price data, do not write packet layout, and do not predict whether the phrase will be said. Use the provided resolved_route.',
    primarySourceBias:
      'Use primary sources first: official event page, official documents, transcript/video status.',
    modelSafeKeys: ['event_metadata', 'official_schedule', 'speaker_or_cast', 'venue_or_platform', 'official_documents', 'transcript_or_video_status', 'market_catalog', 'strike_constraints', 'source_window'],
    editorialKeys: ['theme_frame', 'target_phrase_context', 'prior_event_continuity', 'agenda_pressure', 'narrative_risk'],
  },
  'earnings-call-mention': {
    packet_family: 'mentions',
    route: 'earnings_call',
    submarket: 'event',
    systemSentence: 'You are CPC research extraction for an earnings-call mention market. Never predict what management will say.',
    primarySourceBias:
      'Use primary sources first: company investor-relations releases/webcasts, SEC filings, and official transcript or prepared-remarks sources.',
    modelSafeKeys: ['company_identity', 'fiscal_period', 'call_datetime', 'executive_speakers', 'press_release_url', 'sec_filing_urls', 'prepared_remarks_status', 'transcript_status', 'prior_call_topics', 'current_guidance_topics', 'known_issues', 'current_catalysts'],
    editorialKeys: ['management_focus', 'continuity_vs_change', 'street_narrative', 'sensitivity_topics', 'why_this_quarter_matters'],
  },
  'hearing-testimony-mention': {
    packet_family: 'mentions',
    route: 'debate_hearing',
    submarket: 'event',
    systemSentence: 'You are CPC research extraction for a hearing or testimony mention market. Use the provided resolved_route and never predict whether the term will be said.',
    primarySourceBias:
      'Use primary sources first: official committee or agency hearing pages, witness lists, prepared testimony, official video, official transcripts, calendars, and agenda documents.',
    modelSafeKeys: ['committee_or_agency', 'hearing_title', 'hearing_datetime', 'room_or_platform', 'witness_list', 'opening_statement_urls', 'prepared_testimony_urls', 'agenda_documents', 'transcript_status', 'official_video_status'],
    editorialKeys: ['issue_frame', 'partisan_or_institutional_fault_lines', 'topic_pressure', 'witness_focus', 'historical_context'],
  },
  'hearing-word-bank-mention': {
    packet_family: 'mentions',
    route: 'debate_hearing',
    submarket: 'word_bank_threshold',
    systemSentence: 'You are CPC research extraction for a hearing phrase-count or word-bank market. Use the provided resolved_route. Never estimate counts or rank terms.',
    primarySourceBias:
      'Use primary sources first: official hearing page, witness list, prepared testimony, official video, official transcript availability, and official agenda documents.',
    modelSafeKeys: ['committee_or_agency', 'hearing_title', 'witness_list', 'speaker_scope', 'word_bank', 'threshold_rule', 'counting_rule', 'transcript_status', 'official_video_status', 'agenda_documents'],
    editorialKeys: ['high_frequency_topic_candidates', 'semantic_ambiguity_notes', 'phrase_collision_risk', 'narrative_pressure'],
  },
  'public-figure-mention': {
    packet_family: 'mentions',
    route: 'trump_event',
    submarket: 'event',
    systemSentence: 'You are CPC research extraction for a public-figure mention market. Use the provided resolved_route and horizon. Never predict what the person will say.',
    primarySourceBias:
      'Use primary sources first: official schedule pages, official speech/event pages, official transcripts, official video, and official documents. Treat mirror or repost sources as unconfirmed unless they point to an official primary source.',
    modelSafeKeys: ['speaker_identity', 'event_type', 'horizon', 'official_schedule', 'venue_or_platform', 'prepared_remarks_status', 'official_transcript_status', 'official_video_status', 'agenda_topics', 'associated_official_documents'],
    editorialKeys: ['campaign_or_public_narrative', 'repeat_theme_watch', 'issue_salience', 'audience_context', 'historical_phrase_context'],
  },
  'sports-mention': {
    packet_family: 'mentions',
    route: 'sports_announcer',
    submarket: 'event',
    systemSentence: 'You are CPC research extraction for a sports-announcer mention market. Never predict whether a phrase will be said.',
    primarySourceBias:
      'Use primary sources first: official league/team game pages, official lineups or probable starters, official injuries/suspensions, official broadcast notes, and official standings or advancement pages.',
    modelSafeKeys: ['sport', 'matchup', 'competition_stage', 'broadcast_network', 'announcer_list', 'official_game_notes', 'confirmed_lineups_or_starting_pitchers', 'injuries_or_suspensions', 'standings_or_advancement_state', 'venue_weather'],
    editorialKeys: ['broadcast_storylines', 'rivalry_note', 'star_focus', 'historical_meeting_note', 'tactical_angle'],
  },
  'tv-show-mention': {
    packet_family: 'mentions',
    route: 'talk_show_media',
    submarket: 'event',
    systemSentence: 'You are CPC research extraction for a TV or show-based mention market. Use the provided resolved_route. Never predict whether a phrase will be said.',
    primarySourceBias:
      'Use primary sources first: official network or platform episode pages, official synopses, official cast/guest listings, official recaps, and official schedule pages.',
    modelSafeKeys: ['show_title', 'series_episode', 'air_datetime', 'network_or_platform', 'official_synopsis', 'cast_or_contestants', 'format_twist', 'official_clip_or_recap_status'],
    editorialKeys: ['episode_arc', 'fan_attention_theme', 'relationship_or_conflict_context', 'host_or_judge_focus', 'running_gag_or_catchphrase_context'],
  },
  'topic-most-mentioned': {
    packet_family: 'mentions',
    route: 'topic_most_mentioned',
    submarket: 'most_mentioned',
    systemSentence: 'You are CPC research extraction for a topic-most-mentioned or word-bank market. Do not predict the winner.',
    primarySourceBias:
      'Use primary sources first: official transcript or transcript-availability pages, official video, official agenda or event pages, and official rules/documents defining the speaking window.',
    modelSafeKeys: ['source_corpus_definition', 'candidate_topics', 'counting_rule', 'normalization_rule', 'speaker_scope', 'official_transcript_status', 'official_video_status', 'agenda_documents', 'time_window'],
    editorialKeys: ['dominant_themes', 'phrase_ambiguity', 'collisions_and_synonyms', 'historical_topic_pressure', 'narrative_focus'],
  },
});

function makeResearchBuilder(packet_type) {
  const config = CPC_RESEARCH_PROMPT_CONFIG[packet_type];
  return (anchor = {}) =>
    buildCpcResearchPrompt({
      packet_family: config.packet_family,
      packet_type,
      // Mentions routes/submarkets may be overridden by the resolved anchor;
      // CPC owns route resolution, the prompt only consumes it.
      route: anchorValue(anchor, 'route', config.route),
      submarket: anchorValue(anchor, 'submarket', config.submarket),
      systemSentence: config.systemSentence,
      primarySourceBias: config.primarySourceBias,
      modelSafeKeys: config.modelSafeKeys,
      editorialKeys: config.editorialKeys,
      anchor,
    });
}

export const buildMlbGameResearchPrompt = makeResearchBuilder('mlb-game');
export const buildMlbSlateResearchPrompt = makeResearchBuilder('mlb-slate');
export const buildWorldCupMatchResearchPrompt = makeResearchBuilder('worldcup-match');
export const buildWorldCupMatchdayResearchPrompt = makeResearchBuilder('worldcup-matchday');
export const buildMentionsDailyResearchPrompt = makeResearchBuilder('mentions-daily');
export const buildGenericMentionResearchPrompt = makeResearchBuilder('mention-event');
export const buildEarningsMentionResearchPrompt = makeResearchBuilder('earnings-call-mention');
export const buildHearingTestimonyMentionResearchPrompt = makeResearchBuilder('hearing-testimony-mention');
export const buildHearingWordBankMentionResearchPrompt = makeResearchBuilder('hearing-word-bank-mention');
export const buildPublicFigureMentionResearchPrompt = makeResearchBuilder('public-figure-mention');
export const buildTrumpMentionResearchPrompt = buildPublicFigureMentionResearchPrompt;
export const buildSportsMentionResearchPrompt = makeResearchBuilder('sports-mention');
export const buildTvShowMentionResearchPrompt = makeResearchBuilder('tv-show-mention');
export const buildTopicMostMentionedResearchPrompt = makeResearchBuilder('topic-most-mentioned');

export const CPC_RESEARCH_PROMPT_BUILDERS = Object.freeze({
  'mlb-game': buildMlbGameResearchPrompt,
  'mlb-slate': buildMlbSlateResearchPrompt,
  'worldcup-match': buildWorldCupMatchResearchPrompt,
  'worldcup-matchday': buildWorldCupMatchdayResearchPrompt,
  'mentions-daily': buildMentionsDailyResearchPrompt,
  'mention-event': buildGenericMentionResearchPrompt,
  'earnings-call-mention': buildEarningsMentionResearchPrompt,
  'hearing-testimony-mention': buildHearingTestimonyMentionResearchPrompt,
  'hearing-word-bank-mention': buildHearingWordBankMentionResearchPrompt,
  'public-figure-mention': buildPublicFigureMentionResearchPrompt,
  'sports-mention': buildSportsMentionResearchPrompt,
  'tv-show-mention': buildTvShowMentionResearchPrompt,
  'topic-most-mentioned': buildTopicMostMentionedResearchPrompt,
});
