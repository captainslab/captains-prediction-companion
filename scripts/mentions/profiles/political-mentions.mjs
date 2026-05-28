// Profile: political_mentions
//
// Layers and weights for scoring political-speaker mention markets.
// Covers: rallies, interviews, hearings, debates, press gaggles.
//
// Shared layers (all mention profiles):
//   baseline_relevance, event_proximity, source_velocity,
//   direct_mention_pathway, historical_tendency, suppression_signal, evidence_quality
//
// Political-specific:
//   news_cycle_pressure    — keyword dominating current news cycle
//   opponent_topic_relevance — debate agenda, counterpart salience

export const PROFILE_KEY = 'political_mentions';

export const LAYER_DEFS = Object.freeze([
  {
    key:    'baseline_relevance',
    weight: 0.08,
    label:  'Speaker-to-keyword baseline relevance (topic fit, public record)',
  },
  {
    key:    'event_proximity',
    weight: 0.18,
    label:  'Scheduled event proximity: rally, interview, hearing, or debate before close',
  },
  {
    key:    'source_velocity',
    weight: 0.10,
    label:  'Source velocity: recent articles/transcripts citing this keyword for this speaker',
  },
  {
    key:    'direct_mention_pathway',
    weight: 0.15,
    label:  'Direct mention pathway: known talking points, confirmed prepared remarks, direct quote history',
  },
  {
    key:    'historical_tendency',
    weight: 0.15,
    label:  'Historical tendency: prior speech/transcript hit rate from closed-event calendar',
  },
  {
    key:    'news_cycle_pressure',
    weight: 0.10,
    label:  'News-cycle pressure: keyword dominating current media cycle, forcing on-record response',
  },
  {
    key:    'opponent_topic_relevance',
    weight: 0.08,
    label:  'Opponent/topic relevance: debate agenda, counterpart statements, issue salience',
  },
  {
    key:    'suppression_signal',
    weight: 0.08,
    label:  'Suppression/counter-signal: political incentive to avoid this keyword (high score = less suppressed)',
  },
  {
    key:    'evidence_quality',
    weight: 0.08,
    label:  'Evidence quality: official schedule confirmed, credible transcript sourcing',
  },
]);
