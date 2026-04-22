import { buildEventMarketPlanSummary } from './eventMarketTool.js';
import { readHermesResearchPacket, runHermesChat, stringifyCompactJson } from './hermesRuntime.js';
import { buildOfficialSourcePacket } from './sourcePackets.js';

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function buildHermesResearchPrompt(input = {}) {
  const packet = readHermesResearchPacket();
  const payload = {
    board_url: input.url ?? null,
    venue: input.venue ?? 'Kalshi',
    title: input.title ?? null,
    question: input.question ?? null,
    market_id: input.market_id ?? null,
    metadata: isObject(input.metadata) ? input.metadata : {},
    source_packet: input.source_packet ?? null,
  };

  return [
    packet.trim(),
    '',
    'research_input:',
    stringifyCompactJson(payload),
    '',
    'Return only the required JSON object.',
  ]
    .filter(Boolean)
    .join('\n');
}

function normalizeResearchResult(result, input = {}, sourcePacket = {}) {
  const summary = buildEventMarketPlanSummary(result);
  const childContracts = normalizeChildContracts(result?.child_contracts ?? summary?.market_view?.available_contracts ?? []);

  return {
    board_url: result?.board_url ?? summary?.source?.url ?? input.url ?? null,
    board_headline: result?.board_headline ?? summary?.summary?.headline ?? null,
    board_recommendation: result?.board_recommendation ?? summary?.summary?.recommendation ?? 'watch',
    board_confidence: result?.board_confidence ?? summary?.confidence ?? 'low',
    child_contracts: childContracts,
    board_no_edge_reason_code: result?.board_no_edge_reason_code ?? null,
    board_no_edge_reason: result?.board_no_edge_reason ?? null,
    official_source_url: result?.official_source_url ?? sourcePacket?.official_source_url ?? null,
    official_source_type: result?.official_source_type ?? sourcePacket?.official_source_type ?? null,
    transcript_excerpt: result?.transcript_excerpt ?? sourcePacket?.transcript_excerpt ?? null,
    research_summary: result?.research_summary ?? sourcePacket?.research_summary ?? summary?.summary?.one_line_reason ?? null,
    evidence_strength: result?.evidence_strength ?? sourcePacket?.evidence_strength ?? null,
    source_quality: result?.source_quality ?? sourcePacket?.source_quality ?? null,
    source_packet_kind: result?.source_packet_kind ?? sourcePacket?.source_packet_kind ?? null,
    event_format: result?.event_format ?? sourcePacket?.event_format ?? null,
    speaker_type: result?.speaker_type ?? sourcePacket?.speaker_type ?? null,
    timing_relevance: result?.timing_relevance ?? sourcePacket?.timing_relevance ?? null,
    why_valid_under_kalshi_rules: result?.why_valid_under_kalshi_rules ?? sourcePacket?.why_valid_under_kalshi_rules ?? null,
    catalyst: result?.catalyst ?? sourcePacket?.catalyst ?? null,
    reasoning_chain: Array.isArray(result?.reasoning_chain)
      ? result.reasoning_chain
      : Array.isArray(sourcePacket?.reasoning_chain)
        ? sourcePacket.reasoning_chain
        : [],
    invalidation_condition: result?.invalidation_condition ?? sourcePacket?.invalidation_condition ?? null,
    time_sensitivity: result?.time_sensitivity ?? sourcePacket?.time_sensitivity ?? null,
    exact_phrase_status: result?.exact_phrase_status ?? sourcePacket?.exact_phrase_status ?? null,
    official_source_candidates: Array.isArray(result?.official_source_candidates)
      ? result.official_source_candidates
      : Array.isArray(sourcePacket?.official_source_candidates)
        ? sourcePacket.official_source_candidates
        : [],
    unresolved_gaps: Array.isArray(result?.unresolved_gaps) ? result.unresolved_gaps : [],
    user_facing: summary,
  };
}

export async function runHermesResearch(input = {}, options = {}) {
  const sourcePacket = input.source_packet ?? (await buildOfficialSourcePacket(input, options));
  const query = buildHermesResearchPrompt({
    ...input,
    source_packet: sourcePacket,
  });
  const hermesResult = runHermesChat(query, {
    ...options,
    source: options.source ?? 'hermes-research',
  });

  if (hermesResult.ok && isObject(hermesResult.parsed)) {
    return normalizeResearchResult({
      ...sourcePacket,
      ...hermesResult.parsed,
      source_packet_kind: sourcePacket?.source_packet_kind ?? hermesResult.parsed?.source_packet_kind ?? null,
      official_source_candidates: hermesResult.parsed?.official_source_candidates ?? sourcePacket?.official_source_candidates ?? [],
    }, input);
  }

  return {
    board_url: input.url ?? null,
    board_headline: 'Hermes research fallback',
    board_recommendation: 'watch',
    board_confidence: 'low',
    child_contracts: [],
    board_no_edge_reason_code: 'research_unavailable',
    board_no_edge_reason: 'Hermes research did not return usable structured evidence, so the pipeline fell back to local market analysis.',
    official_source_url: sourcePacket?.official_source_url ?? null,
    official_source_type: sourcePacket?.official_source_type ?? null,
    transcript_excerpt: sourcePacket?.transcript_excerpt ?? null,
    research_summary: sourcePacket?.research_summary || hermesResult.stderr?.trim() || 'Hermes returned no usable structured response.',
    evidence_strength: sourcePacket?.evidence_strength ?? 'low',
    source_quality: sourcePacket?.source_quality ?? 'unknown',
    source_packet_kind: sourcePacket?.source_packet_kind ?? null,
    event_format: sourcePacket?.event_format ?? null,
    speaker_type: sourcePacket?.speaker_type ?? null,
    timing_relevance: sourcePacket?.timing_relevance ?? null,
    why_valid_under_kalshi_rules: sourcePacket?.why_valid_under_kalshi_rules ?? null,
    catalyst: sourcePacket?.catalyst ?? null,
    reasoning_chain: Array.isArray(sourcePacket?.reasoning_chain) ? sourcePacket.reasoning_chain : [],
    invalidation_condition: sourcePacket?.invalidation_condition ?? null,
    time_sensitivity: sourcePacket?.time_sensitivity ?? null,
    exact_phrase_status: sourcePacket?.exact_phrase_status ?? null,
    official_source_candidates: Array.isArray(sourcePacket?.official_source_candidates) ? sourcePacket.official_source_candidates : [],
    unresolved_gaps: ['Hermes research output unavailable', ...(Array.isArray(sourcePacket?.unresolved_gaps) ? sourcePacket.unresolved_gaps : [])],
    user_facing: buildEventMarketPlanSummary({
      user_facing: {
        source: {
          platform: 'Kalshi',
          url: input.url ?? null,
          market_id: input.market_id ?? null,
        },
        event_domain: 'general',
        event_type: 'general',
        market_type: 'general',
        status: 'insufficient_context',
        confidence: 'low',
        summary: {
          headline: 'Hermes research fallback',
          recommendation: 'watch',
          one_line_reason: 'Hermes research did not return usable structured evidence.',
        },
        next_action: 'confirm_event_context',
        context: {},
        market_view: {},
      },
    }),
  };
}
