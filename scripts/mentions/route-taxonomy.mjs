// Mention route taxonomy + route contract (Phase 1 freeze).
//
// Pure, deterministic, offline. This module is the FROZEN contract that
// downstream lexical / history / scoring code consumes. It is NOT the literal
// lexical engine and NOT history lookup — it only declares, per active route:
// route_group, market_shape, comparable_unit, history_window_policy,
// trusted_corpus_policy, settlement_proof_policy, minimum_rules_fields,
// block_gates, and first_proof_lane_priority.
//
// Authority: rules_snapshot rule_family is authoritative for active routes
// (see classifyRouteFromSnapshot). Out-of-scope snapshots (weekly / monthly /
// truth_social) must never become active routes here. Unclear rules stay a
// hard BLOCKED_RULES_UNCLEAR block — never softened to WATCH/PASS.
//
// Price isolation: this module declares only static policy labels and reads
// only non-price snapshot keys (rule_family, out_of_scope, block_reasons), so
// price / bid / ask / volume / open interest / liquidity / spread / notional /
// settlement_value_dollars can never enter a route contract artifact or the
// routing output.

import { RULES_ACTIVE_FAMILIES, RULES_FORBIDDEN_PATTERN } from './rules-analyst.mjs';

// The 9 active routes. Frozen to the rules-analyst active family set so the two
// can never drift apart.
export const ACTIVE_ROUTES = Object.freeze([...RULES_ACTIVE_FAMILIES]);

// Out-of-scope routes. truth_social is a reserved hook only — no active
// implementation builds weekly / monthly / truth_social logic.
export const OUT_OF_SCOPE_ROUTES = Object.freeze([
  'trump_weekly',
  'trump_monthly',
  'truth_social',
]);

export const ROUTE_GROUPS = Object.freeze({
  event_bound_binary_or_threshold: Object.freeze([
    'earnings_call',
    'fed_agency',
    'trump_event',
    'political_general',
    'debate_hearing',
    'sports_announcer',
    'talk_show_media',
    'entertainment_reality',
  ]),
  comparative_count_or_ranking: Object.freeze([
    'topic_most_mentioned',
  ]),
  out_of_scope: Object.freeze([...OUT_OF_SCOPE_ROUTES]),
});

// Hard block that must survive into every active route as a binary packet
// gate. Unclear rules never degrade to WATCH / NO_CLEAR_PICK / LOW_SOURCE.
export const HARD_BLOCK_GATE = 'BLOCKED_RULES_UNCLEAR';

// Proof lanes, in escalation order. earnings_call (and the other event-bound
// routes) read Kalshi settled history FIRST, then a trusted corpus, then
// bounded current-context research, and treat the settlement source as the
// FINAL proof.
const PROOF_LANE = Object.freeze({
  kalshi_history: 'kalshi_historical_hits_misses',
  trusted_corpus: 'trusted_corpus',
  trusted_transcript_corpus: 'trusted_transcript_corpus',
  current_context: 'bounded_current_context_research',
  settlement_final: 'settlement_source_final_proof',
});

const MINIMUM_RULES_FIELDS_EVENT_BOUND = Object.freeze([
  'rule_family',
  'market_type',
  'accepted_forms',
  'blocked_forms',
  'eligible_speaker_set',
  'speaker_scope_policy',
  'content_window_policy',
  'resolution_authority',
  'settlement_sources',
]);

const MINIMUM_RULES_FIELDS_COMPARATIVE = Object.freeze([
  'rule_family',
  'market_type',
  'accepted_forms',
  'content_window_policy',
  'resolution_authority',
  'settlement_sources',
]);

function contract(route, fields) {
  return Object.freeze({ route, ...fields });
}

// The frozen per-route contract. Strings are policy LABELS, not implementations.
export const ROUTE_CONTRACT = Object.freeze({
  earnings_call: contract('earnings_call', {
    route_group: 'event_bound_binary_or_threshold',
    market_shape: 'binary_or_threshold',
    comparable_unit: 'same_company_same_call_format_same_rule_family_quarter',
    history_window_policy: 'recent_quarters_recency_weighted',
    trusted_corpus_policy: 'company_ir_transcript_corpus',
    settlement_proof_policy: 'company_ir_transcript_is_final_proof',
    minimum_rules_fields: MINIMUM_RULES_FIELDS_EVENT_BOUND,
    block_gates: Object.freeze([HARD_BLOCK_GATE]),
    // Kalshi history first, trusted transcript corpus second, current-context
    // research third, settlement source final proof.
    first_proof_lane_priority: Object.freeze([
      PROOF_LANE.kalshi_history,
      PROOF_LANE.trusted_transcript_corpus,
      PROOF_LANE.current_context,
      PROOF_LANE.settlement_final,
    ]),
  }),
  fed_agency: contract('fed_agency', {
    route_group: 'event_bound_binary_or_threshold',
    market_shape: 'binary_or_threshold',
    comparable_unit: 'same_agency_same_event_format_same_rule_family',
    history_window_policy: 'recent_events_recency_weighted',
    trusted_corpus_policy: 'agency_official_transcript_corpus',
    settlement_proof_policy: 'agency_official_record_is_final_proof',
    minimum_rules_fields: MINIMUM_RULES_FIELDS_EVENT_BOUND,
    block_gates: Object.freeze([HARD_BLOCK_GATE]),
    first_proof_lane_priority: Object.freeze([
      PROOF_LANE.kalshi_history,
      PROOF_LANE.trusted_corpus,
      PROOF_LANE.current_context,
      PROOF_LANE.settlement_final,
    ]),
  }),
  trump_event: contract('trump_event', {
    route_group: 'event_bound_binary_or_threshold',
    market_shape: 'binary_or_threshold',
    // Comparable history is conditioned by SAME speaker, SAME event format, and
    // SAME rule family — a rally is not comparable to a press conference.
    comparable_unit: 'same_speaker_same_event_format_same_rule_family',
    history_window_policy: 'recent_same_format_events_recency_weighted',
    trusted_corpus_policy: 'live_event_video_then_transcript_corpus',
    settlement_proof_policy: 'live_event_video_then_transcript_is_final_proof',
    minimum_rules_fields: MINIMUM_RULES_FIELDS_EVENT_BOUND,
    block_gates: Object.freeze([HARD_BLOCK_GATE]),
    first_proof_lane_priority: Object.freeze([
      PROOF_LANE.kalshi_history,
      PROOF_LANE.trusted_corpus,
      PROOF_LANE.current_context,
      PROOF_LANE.settlement_final,
    ]),
  }),
  political_general: contract('political_general', {
    route_group: 'event_bound_binary_or_threshold',
    market_shape: 'binary_or_threshold',
    comparable_unit: 'same_speaker_same_event_format_same_rule_family',
    history_window_policy: 'recent_same_format_events_recency_weighted',
    trusted_corpus_policy: 'live_event_video_then_transcript_corpus',
    settlement_proof_policy: 'live_event_video_then_transcript_is_final_proof',
    minimum_rules_fields: MINIMUM_RULES_FIELDS_EVENT_BOUND,
    block_gates: Object.freeze([HARD_BLOCK_GATE]),
    first_proof_lane_priority: Object.freeze([
      PROOF_LANE.kalshi_history,
      PROOF_LANE.trusted_corpus,
      PROOF_LANE.current_context,
      PROOF_LANE.settlement_final,
    ]),
  }),
  debate_hearing: contract('debate_hearing', {
    route_group: 'event_bound_binary_or_threshold',
    market_shape: 'binary_or_threshold',
    comparable_unit: 'same_event_format_same_rule_family',
    history_window_policy: 'recent_same_format_events_recency_weighted',
    trusted_corpus_policy: 'live_event_video_then_transcript_corpus',
    settlement_proof_policy: 'live_event_video_then_transcript_is_final_proof',
    minimum_rules_fields: MINIMUM_RULES_FIELDS_EVENT_BOUND,
    block_gates: Object.freeze([HARD_BLOCK_GATE]),
    first_proof_lane_priority: Object.freeze([
      PROOF_LANE.kalshi_history,
      PROOF_LANE.trusted_corpus,
      PROOF_LANE.current_context,
      PROOF_LANE.settlement_final,
    ]),
  }),
  sports_announcer: contract('sports_announcer', {
    route_group: 'event_bound_binary_or_threshold',
    market_shape: 'binary_or_threshold',
    comparable_unit: 'same_broadcast_format_same_rule_family',
    history_window_policy: 'recent_same_broadcast_events_recency_weighted',
    trusted_corpus_policy: 'live_broadcast_video_then_transcript_corpus',
    // Context / pregame chatter is NOT spoken-word proof; only the live
    // broadcast spoken word settles. Final proof is video then transcript.
    settlement_proof_policy: 'broadcast_context_is_not_spoken_word_proof_video_then_transcript_is_final_proof',
    minimum_rules_fields: MINIMUM_RULES_FIELDS_EVENT_BOUND,
    block_gates: Object.freeze([HARD_BLOCK_GATE]),
    first_proof_lane_priority: Object.freeze([
      PROOF_LANE.kalshi_history,
      PROOF_LANE.trusted_corpus,
      PROOF_LANE.current_context,
      PROOF_LANE.settlement_final,
    ]),
  }),
  talk_show_media: contract('talk_show_media', {
    route_group: 'event_bound_binary_or_threshold',
    market_shape: 'binary_or_threshold',
    comparable_unit: 'same_speaker_same_show_format_same_rule_family',
    history_window_policy: 'recent_same_format_events_recency_weighted',
    trusted_corpus_policy: 'broadcast_video_then_transcript_corpus',
    settlement_proof_policy: 'broadcast_video_then_transcript_is_final_proof',
    minimum_rules_fields: MINIMUM_RULES_FIELDS_EVENT_BOUND,
    block_gates: Object.freeze([HARD_BLOCK_GATE]),
    first_proof_lane_priority: Object.freeze([
      PROOF_LANE.kalshi_history,
      PROOF_LANE.trusted_corpus,
      PROOF_LANE.current_context,
      PROOF_LANE.settlement_final,
    ]),
  }),
  entertainment_reality: contract('entertainment_reality', {
    route_group: 'event_bound_binary_or_threshold',
    market_shape: 'binary_or_threshold',
    comparable_unit: 'same_show_format_same_rule_family',
    history_window_policy: 'recent_same_format_episodes_recency_weighted',
    trusted_corpus_policy: 'episode_broadcast_video_then_transcript_corpus',
    settlement_proof_policy: 'episode_broadcast_video_then_transcript_is_final_proof',
    minimum_rules_fields: MINIMUM_RULES_FIELDS_EVENT_BOUND,
    block_gates: Object.freeze([HARD_BLOCK_GATE]),
    first_proof_lane_priority: Object.freeze([
      PROOF_LANE.kalshi_history,
      PROOF_LANE.trusted_corpus,
      PROOF_LANE.current_context,
      PROOF_LANE.settlement_final,
    ]),
  }),
  topic_most_mentioned: contract('topic_most_mentioned', {
    route_group: 'comparative_count_or_ranking',
    // Comparative ranking across a word bank, not a normal yes/no binary.
    market_shape: 'comparative_count_or_ranking',
    comparable_unit: 'same_word_bank_same_counting_window_same_rule_family',
    history_window_policy: 'recent_same_format_counts_recency_weighted',
    trusted_corpus_policy: 'counting_window_video_then_transcript_corpus',
    settlement_proof_policy: 'counted_transcript_ranking_is_final_proof',
    minimum_rules_fields: MINIMUM_RULES_FIELDS_COMPARATIVE,
    block_gates: Object.freeze([HARD_BLOCK_GATE]),
    first_proof_lane_priority: Object.freeze([
      PROOF_LANE.kalshi_history,
      PROOF_LANE.trusted_corpus,
      PROOF_LANE.current_context,
      PROOF_LANE.settlement_final,
    ]),
  }),
});

const ACTIVE_ROUTE_SET = new Set(ACTIVE_ROUTES);
const OUT_OF_SCOPE_SET = new Set(OUT_OF_SCOPE_ROUTES);

export function isActiveRoute(route) {
  return ACTIVE_ROUTE_SET.has(route);
}

export function isOutOfScopeRoute(route) {
  return OUT_OF_SCOPE_SET.has(route);
}

/** Group name for a route, or null if the route is unknown. */
export function routeGroupOf(route) {
  if (ACTIVE_ROUTE_SET.has(route)) return ROUTE_CONTRACT[route].route_group;
  if (OUT_OF_SCOPE_SET.has(route)) return 'out_of_scope';
  return null;
}

/** Frozen contract for an active route, or null. Never returns price data. */
export function getRouteContract(route) {
  return ACTIVE_ROUTE_SET.has(route) ? ROUTE_CONTRACT[route] : null;
}

function readActiveFamily(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const direct = snapshot.rule_family;
  if (snapshot.out_of_scope !== true && typeof direct === 'string' && ACTIVE_ROUTE_SET.has(direct)) {
    return direct;
  }
  if (Array.isArray(snapshot.markets)) {
    for (const market of snapshot.markets) {
      if (market?.out_of_scope === true) continue;
      const family = market?.rule_family;
      if (typeof family === 'string' && ACTIVE_ROUTE_SET.has(family)) return family;
    }
  }
  return null;
}

function readBlockReasons(snapshot) {
  const out = [];
  if (Array.isArray(snapshot?.block_reasons)) out.push(...snapshot.block_reasons);
  if (Array.isArray(snapshot?.markets)) {
    for (const market of snapshot.markets) {
      if (Array.isArray(market?.block_reasons)) out.push(...market.block_reasons);
    }
  }
  return out;
}

/**
 * Classify a rules_snapshot into a route taxonomy verdict. rule_family is
 * authoritative for active routes. Out-of-scope snapshots are reported as
 * out_of_scope and never activate a route. BLOCKED_RULES_UNCLEAR is a hard
 * block. Reads only non-price keys, so price fields cannot affect the output.
 *
 * Returns: { status, route, route_group, contract, block_gates }
 *   status: 'active' | 'out_of_scope' | 'blocked'
 */
export function classifyRouteFromSnapshot(snapshot) {
  const blockReasons = readBlockReasons(snapshot);
  if (blockReasons.includes(HARD_BLOCK_GATE)) {
    return Object.freeze({
      status: 'blocked',
      route: null,
      route_group: null,
      contract: null,
      block_gates: Object.freeze([HARD_BLOCK_GATE]),
    });
  }

  const family = readActiveFamily(snapshot);
  if (family) {
    const c = ROUTE_CONTRACT[family];
    return Object.freeze({
      status: 'active',
      route: family,
      route_group: c.route_group,
      contract: c,
      block_gates: c.block_gates,
    });
  }

  // No active family. Either explicitly out-of-scope, or unresolved → never an
  // active route. Out-of-scope snapshots stay out_of_scope (weekly / monthly /
  // truth_social do not activate here).
  return Object.freeze({
    status: 'out_of_scope',
    route: null,
    route_group: 'out_of_scope',
    contract: null,
    block_gates: Object.freeze([]),
  });
}

// Re-exported so taxonomy consumers can assert price isolation without
// importing two modules.
export { RULES_FORBIDDEN_PATTERN };
