// Shared fan-channel market router.
// Routes parsed intake to CPC workflows without placing trades or reading secrets.

import {
  buildFocusedKalshiMarketPlan,
  buildEventMarketPlanSummary,
} from '../../src/eventMarketTool.js';

const SUPPORTED_FAMILIES = new Set([
  'kalshi_event',
  'kalshi_mentions',
  'kalshi_mlb',
  'kalshi_nascar',
  'kalshi_politics',
  'kalshi_ufc',
]);

const WORKFLOWS = Object.freeze({
  event_market_card: {
    id: 'event_market_card',
    label: 'CPC event-market card',
    module: 'src/eventMarketTool.js',
    exportName: 'buildFocusedKalshiMarketPlan',
    network: 'Kalshi public REST only; Hermes is optional and downgrades to watch if unavailable.',
  },
  mlb_daily_packet: {
    id: 'mlb_daily_packet',
    label: 'MLB daily packet generator',
    module: 'scripts/packets/generate-mlb-daily.mjs',
    network: 'Read-only source adapters; no trades.',
  },
  mentions_daily_packet: {
    id: 'mentions_daily_packet',
    label: 'Mentions daily packet generator',
    module: 'scripts/packets/generate-mentions-daily.mjs',
    network: 'Read-only Kalshi/source discovery; no trades.',
  },
  nascar_sunday_packet: {
    id: 'nascar_sunday_packet',
    label: 'NASCAR Sunday packet generator',
    module: 'scripts/packets/generate-nascar-sunday.mjs',
    network: 'Read-only Kalshi/source discovery; no trades.',
  },
  politics_research_market: {
    id: 'politics_research_market',
    label: 'Politics research market workflow',
    module: 'scripts/politics/research-market.mjs',
    network: 'Read-only research workflow; no trades.',
  },
});

function packetWorkflowForFamily(family) {
  if (family === 'kalshi_mlb') return WORKFLOWS.mlb_daily_packet;
  if (family === 'kalshi_mentions') return WORKFLOWS.mentions_daily_packet;
  if (family === 'kalshi_nascar') return WORKFLOWS.nascar_sunday_packet;
  if (family === 'kalshi_politics') return WORKFLOWS.politics_research_market;
  return null;
}

function supportedTypesText() {
  return [
    'Kalshi market/event URL',
    'Kalshi market/event ticker',
    'mentions/speech/earnings phrasing markets',
    'MLB/NASCAR/UFC/politics Kalshi families when a URL or ticker is provided',
  ].join('; ');
}

export function buildEventMarketInputFromRoute(route = {}) {
  const intake = route.intake ?? {};
  const metadata = {};
  if (intake.ticker) metadata.market_ticker = intake.ticker;
  return {
    url: intake.url ?? null,
    market_id: intake.ticker ?? null,
    market_ticker: intake.ticker ?? null,
    question: intake.intentText ?? intake.normalizedText ?? null,
    metadata,
  };
}

export function routeMarket(intake = {}) {
  if (intake.inputType === 'command') {
    return {
      status: 'command',
      supported: true,
      command: intake.command,
      family: 'command',
      workflow: null,
      intake,
    };
  }

  if (intake.inputType === 'unsupported_url') {
    return {
      status: 'unsupported',
      supported: false,
      family: 'unsupported',
      workflow: null,
      intake,
      reason: 'Only Kalshi market/event URLs are supported in the Telegram MVP.',
      nextBestCommand: '/help',
      supportedTypes: supportedTypesText(),
    };
  }

  if (intake.inputType === 'unsupported') {
    return {
      status: 'unsupported',
      supported: false,
      family: 'unsupported',
      workflow: null,
      intake,
      reason: 'Message does not look like a market URL, ticker, or market request.',
      nextBestCommand: '/help',
      supportedTypes: supportedTypesText(),
    };
  }

  if (intake.inputType === 'market_request') {
    return {
      status: 'blocked',
      supported: false,
      family: intake.marketFamily ?? 'market_request',
      workflow: null,
      intake,
      reason: 'CPC needs a source-backed Kalshi URL or ticker before it can build a fan-facing packet.',
      nextBestCommand: 'Send a Kalshi URL or ticker, for example: KX... or https://kalshi.com/...',
      supportedTypes: supportedTypesText(),
      blocker: 'WAITING_FOR_MARKET_SOURCE',
    };
  }

  if (!SUPPORTED_FAMILIES.has(intake.marketFamily)) {
    return {
      status: 'unsupported',
      supported: false,
      family: intake.marketFamily ?? 'unsupported',
      workflow: null,
      intake,
      reason: 'This market family is not mapped to a CPC workflow yet.',
      nextBestCommand: '/help',
      supportedTypes: supportedTypesText(),
    };
  }

  return {
    status: 'routed',
    supported: true,
    family: intake.marketFamily,
    workflow: WORKFLOWS.event_market_card,
    packetWorkflow: packetWorkflowForFamily(intake.marketFamily),
    intake,
    safety: {
      marketDataInScore: false,
      rawInventoryAuditOnly: true,
      liveTrades: false,
      bankroll: false,
      orderPlacement: false,
    },
  };
}

export async function runRoutedWorkflow(route = {}, options = {}) {
  if (route.status !== 'routed') {
    return {
      status: route.status,
      route,
      summary: null,
      plan: null,
      blocker: route.blocker ?? route.reason ?? null,
    };
  }

  const planBuilder = options.planBuilder ?? buildFocusedKalshiMarketPlan;
  const input = buildEventMarketInputFromRoute(route);
  const planOptions = {};
  if (options.fetchImpl) planOptions.fetchImpl = options.fetchImpl;

  try {
    const plan = await planBuilder(input, planOptions);
    const summary = options.summaryBuilder
      ? options.summaryBuilder(plan)
      : buildEventMarketPlanSummary(plan);
    return {
      status: summary?.status ?? 'ready',
      route,
      summary,
      plan,
      blocker: null,
    };
  } catch (err) {
    return {
      status: 'blocked',
      route,
      summary: null,
      plan: null,
      blocker: `WORKFLOW_ERROR: ${err?.message ?? String(err)}`,
    };
  }
}

export const CHANNEL_WORKFLOWS = WORKFLOWS;
