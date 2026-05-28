// Profile: sports_announcer_mentions
//
// Layers and weights for scoring sports-announcer broadcast mention markets.
// Covers: game commentary, pregame/postgame shows, injuries, milestones, rivalries.
//
// Closed-event calendar applies — check last 6 closed broadcast events for the
// same announcer/team/show before sourcing external broadcast notes.
//
// Shared layers (all mention profiles):
//   baseline_relevance, event_proximity, source_velocity,
//   direct_mention_pathway, historical_tendency, suppression_signal, evidence_quality
//
// Sports-announcer-specific:
//   storyline_relevance      — active injury/record/milestone/rivalry narrative
//   injury_milestone_trigger — live breaking context (news since last broadcast)
//   mention_type_likelihood  — live commentary vs. pregame/postgame (affects certainty window)

export const PROFILE_KEY = 'sports_announcer_mentions';

export const LAYER_DEFS = Object.freeze([
  {
    key:    'baseline_relevance',
    weight: 0.08,
    label:  'Announcer/broadcast-to-keyword baseline relevance (team, player, or topic fit)',
  },
  {
    key:    'event_proximity',
    weight: 0.20,
    label:  'Game/broadcast schedule proximity: confirmed air time and game start before market close',
  },
  {
    key:    'source_velocity',
    weight: 0.05,
    label:  'Source velocity: recent sports media coverage of this keyword in broadcast context',
  },
  {
    key:    'direct_mention_pathway',
    weight: 0.10,
    label:  'Direct mention pathway: show notes, pre-game rundowns, broadcaster known talking points for this keyword',
  },
  {
    key:    'historical_tendency',
    weight: 0.12,
    label:  'Historical tendency: prior broadcast hit rate from closed-event calendar (same announcer/show)',
  },
  {
    key:    'storyline_relevance',
    weight: 0.14,
    label:  'Storyline relevance: active injury, record chase, milestone, rivalry, or narrative directly involving this keyword',
  },
  {
    key:    'injury_milestone_trigger',
    weight: 0.10,
    label:  'Injury/milestone/narrative trigger: live breaking news or record-setting context forcing a mention',
  },
  {
    key:    'mention_type_likelihood',
    weight: 0.08,
    label:  'Mention-type likelihood: live in-game commentary (high certainty window) vs. pregame/postgame (moderate)',
  },
  {
    key:    'suppression_signal',
    weight: 0.05,
    label:  'Suppression signal: broadcast sponsor conflicts, network restrictions, topic avoidance. High score = less suppressed.',
  },
  {
    key:    'evidence_quality',
    weight: 0.08,
    label:  'Evidence quality: confirmed broadcast schedule, official network/team context, sourced show notes',
  },
]);
