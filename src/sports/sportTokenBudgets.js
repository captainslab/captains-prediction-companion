/**
 * sportTokenBudgets.js
 * Per-sport Perplexity token budgets and recency filter settings.
 * Extend this file when adding UFC, NASCAR, or other sports.
 */

'use strict';

/**
 * Token budget definitions per sport.
 * max_tokens: max response tokens requested from Perplexity.
 * recency_filter: Perplexity search recency ('hour', 'day', 'week', 'month').
 * cost_ceiling_usd: soft ceiling — caller should log a warning if exceeded.
 */
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

module.exports = { SPORT_TOKEN_BUDGETS };
