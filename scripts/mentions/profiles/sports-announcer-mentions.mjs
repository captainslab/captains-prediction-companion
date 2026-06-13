// Profile: sports_announcer_mentions
//
// Layers and weights for scoring sports-announcer broadcast mention markets.
// Covers: game commentary, pregame/postgame shows, injuries, milestones, rivalries.
//
// Phase 3 layers:
//   settled_mentions_history   — settled hit/miss history (priority-one alpha)
//   sport_phrase_frequency     — term frequency across settled sports mention events
//   venue_team_phrase_relevance — venue/team/matchup-specific phrase relevance
//   current_game_context       — game-context builder output (teams, venue, matchup)
//   sport_phrase_likelihood    — game-context-derived phrase likelihood
//   game_context_trigger       — game-specific phrase trigger (rivalry, milestone, etc.)
//
// Shared layers (all mention profiles):
//   baseline_relevance, event_proximity, source_velocity,
//   direct_mention_pathway, historical_tendency, suppression_signal, evidence_quality
//
// Sports-announcer-specific (Phase 1):
//   storyline_relevance      — active injury/record/milestone/rivalry narrative
//   injury_milestone_trigger — live breaking context (news since last broadcast)
//   mention_type_likelihood  — live commentary vs. pregame/postgame (affects certainty window)

export const PROFILE_KEY = 'sports_announcer_mentions';

export const LAYER_DEFS = Object.freeze([
  // --- Phase 3: settled history alpha (priority-one) ---
  {
    key:    'settled_mentions_history',
    weight: 0.10,
    label:  'Settled sports mention history: prior hit/miss from same series/sport/announcer events',
  },
  {
    key:    'sport_phrase_frequency',
    weight: 0.06,
    label:  'Sport phrase frequency: how often this term appeared as YES across settled sports mention events',
  },
  {
    key:    'venue_team_phrase_relevance',
    weight: 0.05,
    label:  'Venue/team phrase relevance: team/venue/matchup-specific phrase affinity from settled history',
  },
  // --- Phase 3: game context alpha (priority-two) ---
  {
    key:    'current_game_context',
    weight: 0.08,
    label:  'Current game context: teams, venue, matchup, series/tournament state, probable lineups',
  },
  {
    key:    'sport_phrase_likelihood',
    weight: 0.06,
    label:  'Sport phrase likelihood: game-context-derived likelihood this term is mentioned',
  },
  {
    key:    'game_context_trigger',
    weight: 0.05,
    label:  'Game context trigger: rivalry, milestone, injury, or transaction forcing a mention in this game',
  },
  // --- Shared + Phase 1 layers (weights redistributed) ---
  {
    key:    'baseline_relevance',
    weight: 0.05,
    label:  'Announcer/broadcast-to-keyword baseline relevance (team, player, or topic fit)',
  },
  {
    key:    'event_proximity',
    weight: 0.14,
    label:  'Game/broadcast schedule proximity: confirmed air time and game start before market close',
  },
  {
    key:    'source_velocity',
    weight: 0.03,
    label:  'Source velocity: recent sports media coverage of this keyword in broadcast context',
  },
  {
    key:    'direct_mention_pathway',
    weight: 0.07,
    label:  'Direct mention pathway: show notes, pre-game rundowns, broadcaster known talking points for this keyword',
  },
  {
    key:    'historical_tendency',
    weight: 0.08,
    label:  'Historical tendency: prior broadcast hit rate from closed-event calendar (same announcer/show)',
  },
  {
    key:    'storyline_relevance',
    weight: 0.08,
    label:  'Storyline relevance: active injury, record chase, milestone, rivalry, or narrative directly involving this keyword',
  },
  {
    key:    'injury_milestone_trigger',
    weight: 0.06,
    label:  'Injury/milestone/narrative trigger: live breaking news or record-setting context forcing a mention',
  },
  {
    key:    'mention_type_likelihood',
    weight: 0.04,
    label:  'Mention-type likelihood: live in-game commentary (high certainty window) vs. pregame/postgame (moderate)',
  },
  {
    key:    'suppression_signal',
    weight: 0.03,
    label:  'Suppression signal: broadcast sponsor conflicts, network restrictions, topic avoidance. High score = less suppressed.',
  },
  {
    key:    'evidence_quality',
    weight: 0.05,
    label:  'Evidence quality: confirmed broadcast schedule, official network/team context, sourced show notes',
  },
]);
