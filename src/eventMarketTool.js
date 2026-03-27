import { buildEventMarketContract } from './eventMarketContract.js';

export async function buildEventMarketPlan(input = {}) {
  return buildEventMarketContract(input);
}

export function buildEventMarketPlanSummary(result = {}) {
  return result.user_facing ?? {
    source: {
      platform: 'Kalshi',
      url: null,
      market_id: null,
    },
    event_domain: 'general',
    event_type: 'general',
    market_type: 'general',
    status: 'insufficient_context',
    confidence: 'low',
    summary: {
      headline: 'The market needs more detail before the app can build a card.',
      recommendation: 'pass',
      one_line_reason:
        'The planner did not receive enough market context to classify the event cleanly.',
    },
    next_action: 'confirm_event_context',
    context: {},
    market_view: {},
  };
}
