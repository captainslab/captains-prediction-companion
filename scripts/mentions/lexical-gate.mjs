// Lexical pre-evidence gate.
//
// Thin, pure, offline integration layer that runs the literal lexical engine
// (scripts/mentions/lexical-engine.mjs) as a HARD pre-evidence gate before any
// downstream composite / confidence / posture / rendering treats a mention
// market as valid.
//
// Contract:
//   - BLOCKED_RULES_UNCLEAR  -> decision 'BLOCK'        (hard block, no soft verdict)
//   - OUT_OF_SCOPE_ROLLING   -> decision 'OUT_OF_SCOPE' (hard block / never active)
//   - status NO_MATCH        -> decision 'NO_MATCH'     (suppress conviction)
//   - status MATCH           -> decision 'MATCH'        (proceed to evidence layers)
//   - rules valid, no text   -> decision 'PENDING'      (proceed; evidence not yet seen)
//
// "No evidence yet" (no candidate_text) is NOT a NO_MATCH: a well-formed,
// in-scope market with no transcript text supplied has simply not been
// evaluated against evidence, so it must not be suppressed — it proceeds to the
// later history/evidence layers. Only an evaluated NO_MATCH suppresses.
//
// Price isolation: this module never reads or forwards any market price field.
// The rules snapshot is built by the rules-analyst (which sanitizes price) and
// the lexical engine deep-sanitizes again. candidate_text is plain transcript
// text. No bid/ask/volume/OI/spread/liquidity/notional ever touches the gate.

import { evaluateLexicalMention } from './lexical-engine.mjs';
import { buildMarketRulesSnapshot, hasTruthSocialFraming } from './rules-analyst.mjs';

export const LEXICAL_GATE_DECISIONS = Object.freeze([
  'BLOCK',
  'OUT_OF_SCOPE',
  'ROLLING_SUPPORTED',
  'NO_MATCH',
  'MATCH',
  'PENDING',
]);

function firstNonEmptyString(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate;
  }
  return null;
}

// Legacy mention carriers (target_phrase / event_context style) are not Kalshi
// event/market objects. Project the determinable fields onto the snapshot input
// shape so a legacy-only caller that already carries the exact strike word is
// not fake-blocked for "sparse fixture shape". Strike-bearing fields only — no
// price field is ever read here.
function syntheticMarketFromLegacy(legacy) {
  if (!legacy || typeof legacy !== 'object') return {};
  return {
    ticker: legacy.ticker ?? legacy.event_id ?? null,
    custom_strike: legacy.target_phrase ?? legacy.phrase ?? legacy.keyword ?? null,
    title: legacy.title ?? null,
  };
}

function syntheticEventFromLegacy(legacy) {
  if (!legacy || typeof legacy !== 'object') return {};
  return {
    event_ticker: legacy.event_id ?? null,
    title: legacy.event_context ?? legacy.context ?? legacy.title ?? null,
    sub_title: legacy.speaker ?? legacy.company ?? legacy.entity ?? null,
  };
}

/**
 * Run the lexical pre-evidence gate for a single mention market.
 *
 * @param {object}  opts
 * @param {object?} opts.event         - Kalshi-style event (text/ticker fields only)
 * @param {object?} opts.market        - Single market under the event
 * @param {object?} opts.legacy        - Legacy strike carrier (may hold candidate_text)
 * @param {object?} opts.rulesSnapshot - Pre-built rules snapshot (skips rebuild when supplied)
 * @param {string?} opts.candidateText - Transcript/evidence text to match literally
 *
 * @returns {object} Frozen gate verdict:
 *   { decision, hard_blocked, suppress_conviction, proceed_to_evidence,
 *     evidence_evaluated, lexical_result }
 */
export function gateMentionMarket({
  event = null,
  market = null,
  legacy = null,
  rulesSnapshot = null,
  candidateText = null,
} = {}) {
  // Snapshot subjects: prefer the real event/market; otherwise project the
  // legacy carrier onto the snapshot input shape so determinable legacy markets
  // are not fake-blocked.
  const snapshotEvent = event ?? syntheticEventFromLegacy(legacy);
  const snapshotMarket = market ?? syntheticMarketFromLegacy(legacy);
  const snapshot = rulesSnapshot ?? buildMarketRulesSnapshot(snapshotEvent, snapshotMarket);

  const text = firstNonEmptyString(
    candidateText,
    legacy?.candidate_text,
    market?.candidate_text,
    event?.candidate_text,
  );
  const evidenceEvaluated = typeof text === 'string' && text.trim().length > 0;

  const lexicalResult = evaluateLexicalMention({
    rules_snapshot: snapshot,
    candidate_text: text ?? '',
  });

  let decision;
  if (lexicalResult.status === 'BLOCKED') {
    if (lexicalResult.out_of_scope) {
      // Distinguish a true reserved out-of-scope market (Truth Social reserved
      // hook) — a HARD block — from rolling weekly/monthly framing, which stays
      // a legacy-supported CPC mention route handled by the research-route
      // resolver and must NOT be hard-blocked. When the caller supplied only a
      // pre-built snapshot (no event/market to inspect), fail closed and block.
      const inspectable = event || market || legacy;
      const reserved = inspectable ? hasTruthSocialFraming(snapshotEvent, snapshotMarket) : true;
      decision = reserved ? 'OUT_OF_SCOPE' : 'ROLLING_SUPPORTED';
    } else {
      decision = 'BLOCK';
    }
  } else if (!evidenceEvaluated) {
    // Rules are valid and in-scope but no evidence text has been evaluated yet.
    // Do NOT suppress: the market proceeds to later history/evidence layers.
    decision = 'PENDING';
  } else if (lexicalResult.status === 'MATCH') {
    decision = 'MATCH';
  } else {
    decision = 'NO_MATCH';
  }

  const hardBlocked = decision === 'BLOCK' || decision === 'OUT_OF_SCOPE';
  const suppressConviction = decision === 'NO_MATCH';

  return Object.freeze({
    decision,
    hard_blocked: hardBlocked,
    suppress_conviction: suppressConviction,
    proceed_to_evidence: !hardBlocked,
    evidence_evaluated: evidenceEvaluated,
    lexical_result: lexicalResult,
  });
}
