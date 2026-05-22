import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DECISION_STATUSES,
  MARKET_TYPES,
  classifyMarketType,
  evaluateDecisionProcess,
  renderDecisionProcess,
} from '../scripts/shared/decision-process.mjs';

test('market classifier covers required concrete types and generic fallback', () => {
  assert.equal(classifyMarketType({ series_ticker: 'KXMLBGAME', title: 'Mets vs Phillies' }), MARKET_TYPES.SPORTS_GAME);
  assert.equal(classifyMarketType({ series_ticker: 'KXMLBKS', title: 'Pitcher strikeouts' }), MARKET_TYPES.PLAYER_PROP);
  assert.equal(classifyMarketType({ title: 'Will Trump mention tariffs in the speech transcript?' }), MARKET_TYPES.MENTION_MARKET);
  assert.equal(classifyMarketType({ id: 'KXNEXTAG-29', title: 'Next AG' }), MARKET_TYPES.POLITICS_PERSONNEL);
  assert.equal(classifyMarketType({ title: 'Which party wins the Senate election?' }), MARKET_TYPES.ELECTION);
  assert.equal(classifyMarketType({ title: 'Will OpenAI release GPT-6?' }), MARKET_TYPES.AI_NEWS);
  assert.equal(classifyMarketType({ title: 'Will ACME beat earnings guidance?' }), MARKET_TYPES.EARNINGS_COMPANY);
  assert.equal(classifyMarketType({ title: 'Will a generic event happen?' }), MARKET_TYPES.GENERIC_EVENT);
});

test('price-only or board-only signals cannot become evidence leans for any market type', () => {
  for (const marketType of Object.values(MARKET_TYPES)) {
    const checked = marketType === MARKET_TYPES.PLAYER_PROP
      ? { line_ladder_comparison: true }
      : { market_board_context: true };
    const p = evaluateDecisionProcess({
      marketType,
      rawDecision: 'LEAN',
      hasMarketSignal: true,
      checked,
    });
    assert.notEqual(p.decisionStatus, DECISION_STATUSES.EVIDENCE_LEAN, marketType);
    assert.notEqual(p.decisionStatus, DECISION_STATUSES.STRONG_EVIDENCE_LEAN, marketType);
  }
});

test('missing settlement rules cap mention/personnel/election markets at WATCH', () => {
  for (const marketType of [MARKET_TYPES.MENTION_MARKET, MARKET_TYPES.POLITICS_PERSONNEL, MARKET_TYPES.ELECTION]) {
    const p = evaluateDecisionProcess({
      marketType,
      rawDecision: 'LEAN',
      hasMarketSignal: true,
      checked: {
        market_board_context: true,
        official_evidence: true,
        credible_reporting: true,
        political_plausibility: true,
        skeptic_case: true,
        x_chatter_separated: true,
      },
    });
    assert.equal(p.decisionStatus, DECISION_STATUSES.WATCH, marketType);
  }
});

test('sports game without lineup/starter/context cannot be stronger than MARKET-ONLY LEAN', () => {
  const p = evaluateDecisionProcess({
    marketType: MARKET_TYPES.SPORTS_GAME,
    rawDecision: 'LEAN',
    hasMarketSignal: true,
    checked: {
      projected_participants: true,
      market_board_context: true,
    },
  });
  assert.equal(p.decisionStatus, DECISION_STATUSES.MARKET_ONLY_LEAN);
  assert.ok(p.missingEvidence.some((x) => /Lineup/.test(x)));
});

test('complete sports evidence can become evidence lean, but not before checklist completion', () => {
  const p = evaluateDecisionProcess({
    marketType: MARKET_TYPES.SPORTS_GAME,
    rawDecision: 'LEAN',
    hasMarketSignal: true,
    checked: {
      projected_participants: true,
      lineup_injury_news: true,
      venue_context: true,
      recent_form_matchup: true,
      market_board_context: true,
      evidence_supported_side: true,
    },
  });
  assert.equal(p.decisionStatus, DECISION_STATUSES.EVIDENCE_LEAN);
});

test('renderDecisionProcess separates facts, market signal, social chatter, inference, skeptic review, and judgment', () => {
  const p = evaluateDecisionProcess({
    marketType: MARKET_TYPES.MENTION_MARKET,
    rawDecision: 'LEAN',
    hasMarketSignal: true,
    checked: {
      exact_settlement_wording: true,
      market_board_context: true,
      x_chatter_separated: true,
    },
    verifiedFacts: 'Official transcript not yet available.',
    socialChatter: 'X chatter separated as signal only.',
    inference: 'Inference withheld.',
    skepticReview: 'MISSING.',
  });
  const md = renderDecisionProcess(p);
  assert.match(md, /Settlement rules:/);
  assert.match(md, /Verified facts:/);
  assert.match(md, /Market signal:/);
  assert.match(md, /X\/social chatter:/);
  assert.match(md, /Inference:/);
  assert.match(md, /Skeptic review:/);
  assert.match(md, /Final judgment:/);
});
