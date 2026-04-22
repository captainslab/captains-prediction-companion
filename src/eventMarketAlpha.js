import { runHermesChat } from './hermesRuntime.js';

const EDGE_THRESHOLD_CENTS = 3;
const ALPHA_PROVIDER_DEFAULT = 'gemini';
const ALPHA_MODEL_DEFAULT = 'gemini-2.5-flash';
const ALPHA_SYSTEM_PROMPT =
  'You are the oracle stage for a prediction-market companion. Treat mention markets as resolution-constrained language problems. Use only the provided market data and any supplied official source packet. Do not assume extra facts. Do not output pick, watch, or pass from price math alone. Reasoning must not be shallow or generic. If a real research packet is missing or empty, downgrade to watch or pass. Respect the exact phrase, exact speaker, exact event boundary, exact source constraints, and exact official-source hierarchy from the rules summary. Return JSON only with keys fair_yes, confidence, reasoning, and watch_for. fair_yes must be a number from 0 to 1. confidence must be low, medium, or high. reasoning must be one short sentence and must explain why implied market probability differs from model/fair probability using at least one of: historical pattern, behavioral tendency, timing/catalyst insight, or market-structure mismatch. watch_for must be an array of up to three short strings. Do not use the live market price itself as evidence. If fair value is inside the no-bet band, say there is no actionable edge rather than implying certainty. watch_for items must be concrete monitoring hooks such as transcript release, exact-phrase confirmation, official-source publication, or excluded-segment risk, not names, tickers, or event titles. If a source packet is provided, prefer it over generic assumptions and do not invent evidence beyond it.';

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeConfiguredString(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  return cleaned || null;
}

function normalizeAlphaProviderName(value) {
  const cleaned = normalizeConfiguredString(value);
  if (!cleaned) return null;

  const lowered = cleaned.toLowerCase();
  if (lowered === 'google' || lowered === 'google-ai' || lowered === 'google_gemini') {
    return 'gemini';
  }

  return cleaned;
}

function resolveAlphaProvider(options = {}) {
  return (
    normalizeAlphaProviderName(options.alphaProvider) ??
    normalizeAlphaProviderName(process.env.EVENT_MARKET_ALPHA_PROVIDER) ??
    normalizeAlphaProviderName(process.env.HERMES_PROVIDER) ??
    ALPHA_PROVIDER_DEFAULT
  );
}

function resolveAlphaModel(options = {}) {
  const candidates = [
    options.alphaModel,
    process.env.EVENT_MARKET_ALPHA_MODEL,
    process.env.GEMINI_MODEL,
    process.env.HERMES_MODEL,
    process.env.IMPLICATIONS_MODEL,
    process.env.GOOGLE_MODEL,
  ];

  for (const candidate of candidates) {
    const cleaned = normalizeConfiguredString(candidate);
    if (!cleaned) continue;
    if (cleaned === 'openrouter/free' || cleaned.startsWith('openrouter/')) continue;
    return cleaned;
  }

  return ALPHA_MODEL_DEFAULT;
}

function parseJsonResponse(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (!fenced?.[1]) return null;
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      return null;
    }
  }
}

function extractMessageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  return content
    .map(part => (typeof part?.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

function buildHermesAlphaQuery(payload) {
  return [ALPHA_SYSTEM_PROMPT, '', 'alpha_input:', JSON.stringify(payload), '', 'Return only the required JSON object.']
    .join('\n');
}

async function callHermesAlpha(payload, options) {
  const chatRunner = options.alphaChatRunner ?? options.alphaRunner ?? runHermesChat;
  if (typeof chatRunner !== 'function') return null;

  const provider = resolveAlphaProvider(options);
  const model = resolveAlphaModel(options);

  try {
    const hermesResult = await chatRunner(buildHermesAlphaQuery(payload), {
      ...options,
      provider,
      ...(model ? { model } : {}),
      source: options.alphaSource ?? 'event-market-alpha',
      skills: options.alphaSkills ?? [],
      toolsets: options.alphaToolsets ?? [],
    });

    if (isObject(hermesResult?.parsed)) {
      return hermesResult.parsed;
    }

    const text = extractMessageText(hermesResult?.stdout ?? hermesResult?.content ?? hermesResult?.text);
    const parsed = parseJsonResponse(text);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function mergeMetadata(input, extraMetadata) {
  return {
    ...(isObject(input.metadata) ? input.metadata : {}),
    ...extraMetadata,
  };
}

function toNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampProbability(value) {
  const number = toNumber(value);
  if (number == null) return null;
  return Math.max(0, Math.min(1, number));
}

function normalizeConfidence(value) {
  if (typeof value !== 'string') return 'low';
  const lowered = value.trim().toLowerCase();
  if (lowered === 'high' || lowered === 'medium' || lowered === 'low') {
    return lowered;
  }
  return 'low';
}

function normalizeReasoning(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  return cleaned || null;
}

function normalizeWatchFor(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(item => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, 3);
}

function buildPromptPayload(input) {
  const metadata = isObject(input.metadata) ? input.metadata : {};
  const availableContracts = Array.isArray(metadata.available_contracts)
    ? metadata.available_contracts.slice(0, 5).map(contract => ({
        market_ticker: contract.market_ticker ?? null,
        label: contract.label ?? null,
        market_yes: contract.market_yes ?? null,
        yes_bid: contract.yes_bid ?? null,
        yes_ask: contract.yes_ask ?? null,
        last_price: contract.last_price ?? null,
      }))
    : [];

  return {
    venue: input.venue ?? 'Kalshi',
    market_id: input.market_id ?? metadata.market_ticker ?? null,
    title: input.title ?? null,
    question: input.question ?? null,
    event_domain_hint: input.domain ?? null,
    event_name: metadata.event_name ?? null,
    speaker: metadata.speaker ?? null,
    target_phrase: metadata.target_phrase ?? null,
    rules_summary: metadata.rules_summary ?? null,
    source_packet: isObject(input.source_packet) ? input.source_packet : null,
    source_packet_kind: input.source_packet?.source_packet_kind ?? null,
    official_source_url: input.source_packet?.official_source_url ?? null,
    official_source_type: input.source_packet?.official_source_type ?? null,
    source_quality: input.source_packet?.source_quality ?? null,
    evidence_strength: input.source_packet?.evidence_strength ?? null,
    market: {
      status: metadata.market_status ?? null,
      market_yes: metadata.market_yes ?? null,
      market_yes_bid: metadata.market_yes_bid ?? null,
      market_yes_ask: metadata.market_yes_ask ?? null,
      last_price: metadata.market_last_price ?? null,
    },
    available_contracts: availableContracts,
  };
}

export async function enrichEventMarketAlpha(input = {}, options = {}) {
  const metadata = isObject(input.metadata) ? input.metadata : {};
  const targetPhrase = metadata.target_phrase ?? null;
  const marketTicker = metadata.market_ticker ?? null;
  const marketYes = toNumber(metadata.market_yes);
  const marketStatus = metadata.market_status ?? null;

  if (!targetPhrase || !marketTicker || marketYes == null) {
    return input;
  }

  if (marketStatus && marketStatus !== 'active') {
    return input;
  }

  if (metadata.fair_yes != null && metadata.edge_cents != null) {
    return input;
  }

  const alpha = await callHermesAlpha(buildPromptPayload(input), options);
  if (!isObject(alpha)) {
    return input;
  }

  const fairYes = clampProbability(alpha.fair_yes);
  const confidence = normalizeConfidence(alpha.confidence);
  const reasoning = normalizeReasoning(alpha.reasoning);
  const watchFor = normalizeWatchFor(alpha.watch_for);

  if (fairYes == null) {
    return input;
  }

  const signedEdge = Number(((fairYes - marketYes) * 100).toFixed(1));
  const boundedEdge = Math.abs(signedEdge) < EDGE_THRESHOLD_CENTS ? 0 : signedEdge;

  return {
    ...input,
    metadata: mergeMetadata(input, {
      fair_yes: fairYes,
      edge_cents: boundedEdge,
      alpha_confidence: confidence,
      alpha_summary_reason: reasoning,
      watch_for: watchFor.length > 0 ? watchFor : metadata.watch_for,
      alpha_model: resolveAlphaModel(options),
    }),
  };
}
