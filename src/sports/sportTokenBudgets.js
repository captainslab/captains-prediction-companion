/**
 * sportTokenBudgets.js
 * Per-sport Perplexity token budgets and recency filter settings.
 */

'use strict';

const SPORT_TOKEN_BUDGETS = {
  mlb: {
    max_tokens: 3500,
    recency_filter: 'day',
    cost_ceiling_usd: 0.0035,
  },
  worldcup: {
    max_tokens: 3000,
    recency_filter: 'hour',
    cost_ceiling_usd: 0.003,
  },
  ufc: {
    max_tokens: 2500,
    recency_filter: 'day',
    cost_ceiling_usd: 0.0025,
  },
  nascar: {
    max_tokens: 2000,
    recency_filter: 'day',
    cost_ceiling_usd: 0.002,
  },
  default: {
    max_tokens: 2000,
    recency_filter: 'day',
    cost_ceiling_usd: 0.002,
  },
};

function maxTokens(sport) {
  return (SPORT_TOKEN_BUDGETS[sport] || SPORT_TOKEN_BUDGETS.default).max_tokens;
}

module.exports = { SPORT_TOKEN_BUDGETS, maxTokens };
