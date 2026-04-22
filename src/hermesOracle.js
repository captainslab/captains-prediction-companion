import { buildFocusedKalshiMarketPlan, buildEventMarketPlanSummary } from './eventMarketTool.js';
import { readHermesOraclePacket, runHermesChat, stringifyCompactJson } from './hermesRuntime.js';

const ACTIONABLE_RECOMMENDATIONS = new Set(['buy_yes', 'buy_no']);
const VALID_RECOMMENDATIONS = new Set(['buy_yes', 'buy_no', 'watch', 'pass']);
const VALID_CONFIDENCE = new Set(['low', 'medium', 'high']);
const VALID_EDGE_TYPES = new Set(['historical', 'behavioral', 'timing', 'market_structure', 'information', 'none']);
const VALID_TIME_SENSITIVITY = new Set(['low', 'medium', 'high']);
const GENERIC_REASONING_PATTERNS = [
  /\bno evidence\b/i,
  /\bunclear\b/i,
  /\bweak signal\b/i,
  /\binsufficient information\b/i,
  /\bno strong evidence\b/i,
];
const REQUIRED_REASONING_PATTERNS = [
  /\[historical pattern\]|historical pattern|historically|history shows/i,
  /\[behavioral tendency\]|behavioral tendency|management tends|speaker tends|usually/i,
  /\[timing\/catalyst insight\]|timing\/catalyst insight|q&a|prepared remarks|event window|timing|catalyst/i,
  /\[market-structure mismatch\]|market-structure mismatch|market structure|spread|liquidity|overpriced|underpriced|priced in/i,
];

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value) {
  return value == null ? '' : String(value).trim();
}

function normalizeNullableString(value) {
  const cleaned = normalizeString(value);
  return cleaned || null;
}

function normalizeRecommendation(value, fallback = 'watch') {
  const cleaned = normalizeString(value).toLowerCase();
  if (VALID_RECOMMENDATIONS.has(cleaned)) return cleaned;
  return fallback;
}

function normalizeConfidence(value, fallback = 'low') {
  const cleaned = normalizeString(value).toLowerCase();
  if (VALID_CONFIDENCE.has(cleaned)) return cleaned;
  return fallback;
}

function normalizeEdgeType(value, recommendation = 'watch') {
  const cleaned = normalizeString(value).toLowerCase();
  if (VALID_EDGE_TYPES.has(cleaned)) return cleaned;
  return ACTIONABLE_RECOMMENDATIONS.has(recommendation) ? 'information' : 'none';
}

function normalizeTimeSensitivity(value, fallback = null) {
  const cleaned = normalizeString(value).toLowerCase();
  if (VALID_TIME_SENSITIVITY.has(cleaned)) return cleaned;
  return fallback;
}

function formatPercentage(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return `${Math.round(numeric * 100)}%`;
}

function formatCents(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const rounded = Math.round(numeric);
  return `${rounded >= 0 ? '' : '-'}${Math.abs(rounded)}c`;
}

function normalizeChildContracts(value) {
  if (!Array.isArray(value)) return [];
  return value.map(contract => ({
    ticker: contract?.ticker ?? contract?.market_ticker ?? null,
    label: contract?.label ?? null,
    yes_bid: contract?.yes_bid ?? contract?.market_yes_bid ?? null,
    yes_ask: contract?.yes_ask ?? contract?.market_yes_ask ?? null,
    last_price: contract?.last_price ?? null,
    source_url: contract?.source_url ?? null,
    transcript_excerpt: contract?.transcript_excerpt ?? null,
    phrase_found: contract?.phrase_found ?? null,
    evidence: Array.isArray(contract?.evidence) ? contract.evidence.filter(item => typeof item === 'string') : [],
  }));
}

function normalizeReasoningChain(value, fallback = []) {
  if (!Array.isArray(value)) return Array.isArray(fallback) ? fallback : [];
  const cleaned = value
    .filter(item => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean);
  return cleaned.length > 0 ? cleaned : (Array.isArray(fallback) ? fallback : []);
}

function hasRealEvidence(result = {}) {
  return Boolean(
    normalizeNullableString(result?.official_source_url) ||
    normalizeNullableString(result?.transcript_excerpt) ||
    (Array.isArray(result?.official_source_candidates) && result.official_source_candidates.length > 0)
  );
}

function reasoningHasRequiredCategory(chain = []) {
  return chain.some(item => REQUIRED_REASONING_PATTERNS.some(pattern => pattern.test(item)));
}

function reasoningIsGeneric(chain = []) {
  return chain.some(item => GENERIC_REASONING_PATTERNS.some(pattern => pattern.test(item)));
}

function reasoningHasProbabilityComparison(chain = []) {
  return chain.some(item => /probability gap|implied market probability|fair probability|market implies|fair yes|edge/i.test(item));
}

function buildProbabilityGapItem(summary = {}) {
  const tradeView = summary?.market_view?.trade_view ?? {};
  const marketYes = formatPercentage(tradeView.market_yes ?? tradeView.last_price ?? null);
  const fairYes = formatPercentage(tradeView.fair_yes ?? null);
  const edgeCents = formatCents(tradeView.edge_cents ?? null);

  if (!marketYes || !fairYes || !edgeCents) return null;

  return `[probability gap] Implied market probability is ${marketYes} YES while local fair probability is ${fairYes} YES, leaving a ${edgeCents} gap that needs source-backed explanation.`;
}

function inferFallbackCatalyst(baseBoard = {}, localSummary = {}) {
  return (
    normalizeNullableString(baseBoard?.catalyst) ??
    normalizeNullableString(localSummary?.context?.event_name) ??
    normalizeNullableString(localSummary?.next_action) ??
    'official-source update window'
  );
}

function buildFallbackReasoningChain(baseBoard = {}, localSummary = {}, reasonCode = 'oracle_unavailable') {
  const chain = [];
  const eventName = normalizeNullableString(localSummary?.context?.event_name);
  const isEarnings = /earnings|quarter/i.test(normalizeString(baseBoard?.event_format)) || /earnings|quarter/i.test(normalizeString(eventName));

  if (hasRealEvidence(baseBoard) && isEarnings) {
    chain.push('[timing/catalyst insight] This is a live earnings-call board, so the remaining edge depends on transcript, replay, and Q&A timing rather than price math alone.');
  } else if (hasRealEvidence(baseBoard)) {
    chain.push('[behavioral tendency] Official-source evidence exists, but the runtime still needs a non-generic live oracle explanation before taking risk.');
  } else {
    chain.push('[timing/catalyst insight] The market is event-driven, but verified official-source evidence is still missing, so the board must stay non-actionable.');
  }

  const probabilityGapItem = buildProbabilityGapItem(localSummary);
  if (probabilityGapItem) {
    chain.push(probabilityGapItem);
  }

  if (reasonCode === 'evidence_required') {
    chain.push('[market-structure mismatch] Price can move before proof arrives, but without a verified official source the board cannot justify an actionable call.');
  } else if (reasonCode === 'oracle_output_invalid') {
    chain.push('[market-structure mismatch] The local price/fair gap may be real, but the live Hermes oracle response was too generic or incomplete to trust.');
  } else {
    chain.push('[behavioral tendency] Until the live oracle returns a structured source-backed explanation, the board should remain on watch instead of forcing a pick.');
  }

  return chain;
}

function deriveDowngradeBoard(baseBoard = {}, localSummary = {}, reasonCode = 'oracle_unavailable', customMessage = null) {
  const marketStatus = normalizeString(localSummary?.market_view?.trade_view?.market_status).toLowerCase();
  const downgradedRecommendation = marketStatus === 'active' ? 'watch' : 'pass';
  const defaultMessageByCode = {
    evidence_required: 'The board was downgraded because verified official-source evidence was missing for an actionable decision.',
    oracle_output_invalid: 'The board was downgraded because the live Hermes oracle response was generic or incomplete.',
    oracle_unavailable: 'The board was downgraded because the live Hermes oracle did not return a usable structured decision.',
  };

  return {
    ...baseBoard,
    board_headline:
      downgradedRecommendation === 'watch'
        ? 'The board stays on watch pending a stronger source-backed live oracle decision.'
        : 'The board passes because the live oracle could not justify an actionable decision.',
    board_recommendation: downgradedRecommendation,
    board_confidence: 'low',
    board_no_edge_reason_code: reasonCode,
    board_no_edge_reason: customMessage ?? defaultMessageByCode[reasonCode] ?? defaultMessageByCode.oracle_unavailable,
    edge_type: 'none',
    catalyst: inferFallbackCatalyst(baseBoard, localSummary),
    reasoning_chain: buildFallbackReasoningChain(baseBoard, localSummary, reasonCode),
    invalidation_condition:
      normalizeNullableString(baseBoard?.invalidation_condition) ??
      (hasRealEvidence(baseBoard)
        ? 'If the official source adds exact-phrase confirmation or a stronger live oracle explanation appears, re-run the board.'
        : 'If a verified official source appears, re-run the board.'),
    time_sensitivity: normalizeTimeSensitivity(baseBoard?.time_sensitivity, 'high') ?? 'high',
  };
}

function hasCompleteOracleDecision(result = {}) {
  const recommendation = normalizeRecommendation(result?.board_recommendation ?? result?.summary?.recommendation ?? null, null);
  const edgeType = normalizeNullableString(result?.edge_type);
  const catalyst = normalizeNullableString(result?.catalyst);
  const invalidationCondition = normalizeNullableString(result?.invalidation_condition);
  const timeSensitivity = normalizeTimeSensitivity(result?.time_sensitivity, null);
  const chain = normalizeReasoningChain(result?.reasoning_chain, []);

  return Boolean(
    recommendation &&
      edgeType &&
      catalyst &&
      invalidationCondition &&
      timeSensitivity &&
      chain.length > 0 &&
      !reasoningIsGeneric(chain) &&
      reasoningHasRequiredCategory(chain)
  );
}

function buildBaseBoard(researchResult = {}, input = {}, localSummary = {}) {
  const childContracts = normalizeChildContracts(
    researchResult?.child_contracts ?? localSummary?.market_view?.available_contracts ?? []
  );
  const boardRecommendation = normalizeRecommendation(
    researchResult?.board_recommendation ?? localSummary?.summary?.recommendation ?? 'watch'
  );
  const boardConfidence = normalizeConfidence(
    researchResult?.board_confidence ?? localSummary?.confidence ?? 'low'
  );
  const reasoningChain = normalizeReasoningChain(researchResult?.reasoning_chain, []);
  const probabilityGapItem = buildProbabilityGapItem(localSummary);

  return {
    board_url: researchResult?.board_url ?? localSummary?.source?.url ?? input.url ?? null,
    board_headline: researchResult?.board_headline ?? localSummary?.summary?.headline ?? 'Hermes board analysis',
    board_recommendation: boardRecommendation,
    board_confidence: boardConfidence,
    child_contracts: childContracts,
    board_no_edge_reason_code: researchResult?.board_no_edge_reason_code ?? null,
    board_no_edge_reason: researchResult?.board_no_edge_reason ?? null,
    official_source_url: researchResult?.official_source_url ?? null,
    official_source_type: researchResult?.official_source_type ?? null,
    transcript_excerpt: researchResult?.transcript_excerpt ?? null,
    research_summary: researchResult?.research_summary ?? localSummary?.summary?.one_line_reason ?? null,
    evidence_strength: researchResult?.evidence_strength ?? null,
    source_quality: researchResult?.source_quality ?? null,
    source_packet_kind: researchResult?.source_packet_kind ?? null,
    event_format: researchResult?.event_format ?? null,
    speaker_type: researchResult?.speaker_type ?? null,
    timing_relevance: researchResult?.timing_relevance ?? null,
    why_valid_under_kalshi_rules: researchResult?.why_valid_under_kalshi_rules ?? null,
    unresolved_gaps: Array.isArray(researchResult?.unresolved_gaps) ? researchResult.unresolved_gaps : [],
    edge_type: normalizeEdgeType(researchResult?.edge_type, boardRecommendation),
    catalyst: researchResult?.catalyst ?? null,
    reasoning_chain:
      probabilityGapItem && !reasoningHasProbabilityComparison(reasoningChain)
        ? [...reasoningChain, probabilityGapItem]
        : reasoningChain,
    invalidation_condition: researchResult?.invalidation_condition ?? null,
    time_sensitivity: normalizeTimeSensitivity(researchResult?.time_sensitivity, null),
    exact_phrase_status: researchResult?.exact_phrase_status ?? null,
    official_source_candidates: Array.isArray(researchResult?.official_source_candidates)
      ? researchResult.official_source_candidates
      : [],
    user_facing: localSummary,
  };
}

function buildHermesOraclePrompt(researchResult = {}, input = {}, localSummary = {}, baseBoard = {}) {
  const packet = readHermesOraclePacket();
  const tradeView = localSummary?.market_view?.trade_view ?? {};
  const payload = {
    board_url: baseBoard.board_url ?? input.url ?? null,
    venue: input.venue ?? localSummary?.source?.platform ?? 'Kalshi',
    event: {
      event_domain: localSummary?.event_domain ?? null,
      event_type: localSummary?.event_type ?? null,
      market_type: localSummary?.market_type ?? null,
      event_name: localSummary?.context?.event_name ?? null,
      speaker: localSummary?.context?.speaker ?? null,
      target_phrase: localSummary?.market_view?.target_phrase ?? null,
      rules_summary: localSummary?.market_view?.rules_summary ?? null,
    },
    market_snapshot: {
      market_ticker: tradeView?.market_ticker ?? null,
      market_status: tradeView?.market_status ?? null,
      implied_yes_probability: tradeView?.market_yes ?? tradeView?.last_price ?? null,
      yes_bid: tradeView?.market_yes_bid ?? null,
      yes_ask: tradeView?.market_yes_ask ?? null,
      last_price: tradeView?.last_price ?? null,
      fair_yes: tradeView?.fair_yes ?? null,
      edge_cents: tradeView?.edge_cents ?? null,
      watch_for: Array.isArray(localSummary?.market_view?.watch_for) ? localSummary.market_view.watch_for : [],
    },
    research_packet: {
      official_source_url: baseBoard.official_source_url,
      official_source_type: baseBoard.official_source_type,
      transcript_excerpt: baseBoard.transcript_excerpt,
      research_summary: baseBoard.research_summary,
      source_quality: baseBoard.source_quality,
      evidence_strength: baseBoard.evidence_strength,
      source_packet_kind: baseBoard.source_packet_kind,
      event_format: baseBoard.event_format,
      speaker_type: baseBoard.speaker_type,
      timing_relevance: baseBoard.timing_relevance,
      why_valid_under_kalshi_rules: baseBoard.why_valid_under_kalshi_rules,
      exact_phrase_status: baseBoard.exact_phrase_status,
      unresolved_gaps: baseBoard.unresolved_gaps,
      official_source_candidates: baseBoard.official_source_candidates,
    },
    current_board_state: {
      board_headline: baseBoard.board_headline,
      board_recommendation: baseBoard.board_recommendation,
      board_confidence: baseBoard.board_confidence,
      board_no_edge_reason_code: baseBoard.board_no_edge_reason_code,
      board_no_edge_reason: baseBoard.board_no_edge_reason,
      edge_type: baseBoard.edge_type,
      catalyst: baseBoard.catalyst,
      reasoning_chain: baseBoard.reasoning_chain,
      invalidation_condition: baseBoard.invalidation_condition,
      time_sensitivity: baseBoard.time_sensitivity,
    },
    child_contracts: baseBoard.child_contracts,
  };

  return [
    packet.trim(),
    '',
    'oracle_input:',
    stringifyCompactJson(payload),
    '',
    'Return only the required JSON object.',
  ]
    .filter(Boolean)
    .join('\n');
}

function mergeOracleDecision(baseBoard = {}, parsed = {}, localSummary = {}) {
  const recommendation = normalizeRecommendation(
    parsed?.board_recommendation ?? parsed?.recommendation ?? baseBoard?.board_recommendation ?? 'watch'
  );
  const confidence = normalizeConfidence(
    parsed?.board_confidence ?? parsed?.confidence ?? baseBoard?.board_confidence ?? 'low'
  );
  const edgeType = normalizeEdgeType(parsed?.edge_type, recommendation);
  const catalyst = normalizeNullableString(parsed?.catalyst) ?? normalizeNullableString(baseBoard?.catalyst);
  const invalidationCondition =
    normalizeNullableString(parsed?.invalidation_condition) ?? normalizeNullableString(baseBoard?.invalidation_condition);
  const timeSensitivity =
    normalizeTimeSensitivity(parsed?.time_sensitivity, null) ?? normalizeTimeSensitivity(baseBoard?.time_sensitivity, null);
  let reasoningChain = normalizeReasoningChain(parsed?.reasoning_chain, baseBoard?.reasoning_chain ?? []);
  const probabilityGapItem = buildProbabilityGapItem(localSummary);

  if (probabilityGapItem && !reasoningHasProbabilityComparison(reasoningChain)) {
    reasoningChain = [...reasoningChain, probabilityGapItem];
  }

  if (ACTIONABLE_RECOMMENDATIONS.has(recommendation) && !hasRealEvidence(baseBoard)) {
    return deriveDowngradeBoard(baseBoard, localSummary, 'evidence_required');
  }

  if (
    !catalyst ||
    !invalidationCondition ||
    !timeSensitivity ||
    reasoningChain.length === 0 ||
    reasoningIsGeneric(reasoningChain) ||
    !reasoningHasRequiredCategory(reasoningChain)
  ) {
    return deriveDowngradeBoard(baseBoard, localSummary, 'oracle_output_invalid');
  }

  const board = {
    ...baseBoard,
    board_headline: normalizeNullableString(parsed?.board_headline) ?? baseBoard?.board_headline,
    board_recommendation: recommendation,
    board_confidence: confidence,
    edge_type: edgeType,
    catalyst,
    reasoning_chain: reasoningChain,
    invalidation_condition: invalidationCondition,
    time_sensitivity: timeSensitivity,
  };

  if (ACTIONABLE_RECOMMENDATIONS.has(recommendation)) {
    board.board_no_edge_reason_code = null;
    board.board_no_edge_reason = null;
    return board;
  }

  board.board_no_edge_reason_code =
    normalizeNullableString(parsed?.board_no_edge_reason_code) ??
    baseBoard?.board_no_edge_reason_code ??
    'no_actionable_edge';
  board.board_no_edge_reason =
    normalizeNullableString(parsed?.board_no_edge_reason) ??
    baseBoard?.board_no_edge_reason ??
    'The board stayed non-actionable because the live Hermes oracle did not find a source-backed edge.';
  return board;
}

async function resolveLocalPlan(input = {}, options = {}) {
  if (isObject(options?.localPlan)) return options.localPlan;
  if (isObject(input?.local_plan)) return input.local_plan;
  if (!normalizeNullableString(input?.url)) return null;

  try {
    return await buildFocusedKalshiMarketPlan(
      {
        url: input.url,
        venue: input.venue ?? 'Kalshi',
      },
      options
    );
  } catch {
    return null;
  }
}

export async function runHermesOracle(researchResult = {}, input = {}, options = {}) {
  const localPlan = await resolveLocalPlan(input, options);
  const localSummary = buildEventMarketPlanSummary(localPlan ?? researchResult);
  const baseBoard = buildBaseBoard(researchResult, input, localSummary);

  if (!options.forceOracleCall && hasCompleteOracleDecision(researchResult)) {
    if (!ACTIONABLE_RECOMMENDATIONS.has(baseBoard.board_recommendation) && !baseBoard.board_no_edge_reason_code) {
      return deriveDowngradeBoard(baseBoard, localSummary, 'oracle_output_invalid');
    }
    return baseBoard;
  }

  const query = buildHermesOraclePrompt(researchResult, input, localSummary, baseBoard);
  const chatRunner = options.oracleChatRunner ?? runHermesChat;
  const oracleProvider = options.oracleProvider ?? options.provider ?? 'copilot';
  const oracleModel =
    options.oracleModel ??
    (oracleProvider === 'copilot' ? undefined : (options.validationModel ?? options.model));
  const hermesResult = await chatRunner(query, {
    ...options,
    provider: oracleProvider,
    ...(oracleModel ? { model: oracleModel } : {}),
    source: options.oracleSource ?? 'hermes-oracle',
    skills: options.oracleSkills ?? [],
    toolsets: options.oracleToolsets ?? [],
    maxTurns: options.oracleMaxTurns ?? 4,
  });

  if (hermesResult?.ok && isObject(hermesResult?.parsed)) {
    return mergeOracleDecision(baseBoard, hermesResult.parsed, localSummary);
  }

  const stderrMessage = normalizeNullableString(hermesResult?.stderr);
  return deriveDowngradeBoard(
    baseBoard,
    localSummary,
    'oracle_unavailable',
    stderrMessage
      ? `The board was downgraded because the live Hermes oracle did not return a usable structured decision: ${stderrMessage}`
      : null
  );
}
