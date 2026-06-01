// Politics market-neutrality protection tests.
//
// Politics has NO numeric composite scorer — it is a qualitative branch swarm.
// The neutrality rule here is therefore different from MLB/NASCAR: market price
// (bid/ask/last/volume/OI) is allowed to appear ONLY inside the marketStructure
// branch as descriptive context, and must NEVER:
//   (a) change the rendered report's section ordering or judgment text, or
//   (b) be promoted into a model-produced probability or a prescriptive trade.
//
// This pins that injecting/perturbing the market board does not move the
// research output, mirroring the odds-isolation intent of the MLB/NASCAR
// neutrality regressions.
//
// If this fails after a change, market data started influencing the judgment.

import test from 'node:test';
import assert from 'node:assert/strict';

import { renderReport } from '../scripts/politics/lib/report-render.mjs';
import { scanForbiddenLanguage } from '../scripts/politics/lib/branch-contract.mjs';

const BASE = {
  market: { id: 'KXNEUTRAL-1', url: 'https://kalshi.com/m', title: 'Neutrality probe', asOf: '2026-05-31T00:00:00Z' },
  settlement: { rules: 'First confirmed officeholder.', ambiguities: ['acting excluded?'], actingInterim: 'excluded' },
  official: {
    facts: [
      { date: '2026-05-29', claim: 'Senate hearing scheduled', source: 'https://judiciary.senate.gov/x', verified: true },
    ],
  },
  xSignal: { narratives: [{ claim: 'Candidate A locked in', tier: 'rumor', repeated: true, source: 'https://x.com/y' }] },
  marketStructure: {
    board: [
      { candidate: 'Candidate A', yesCents: 62, noCents: 39, vol: 12000, oi: 5000 },
      { candidate: 'Candidate B', yesCents: 18, noCents: 83, vol: 4000, oi: 1500 },
    ],
    movement: 'A drifted 55->62 over 48h.',
    limitations: 'Thin book.',
  },
  plausibility: {
    candidates: [
      { name: 'Candidate A', strengths: ['loyalist'], weaknesses: ['no experience'], obstacles: ['Senate math'] },
    ],
  },
  skeptic: {
    favoriteWrongReason: 'Press narrative is not a confirmation vote',
    underpricedReason: 'B has a confirm-friendly resume',
    settlementTraps: ['acting officeholder could resolve NO'],
    narrativeTraps: ['X loops the same rumor'],
  },
  judgment: {
    probabilityRange: '0.45-0.60',
    confidence: 'medium',
    bestNonPriceReason: 'Confirmation-vote math, not market chatter',
    biggestUncertainty: 'Whether settlement counts an acting officeholder',
    wouldChangeView: ['On-record withdrawal'],
    monitorNext: ['Senate Judiciary schedule'],
  },
  meta: { xSearchAvailable: true, xSearchUsed: true, notChecked: [] },
};

// Perturb ONLY the market board (prices/volume/OI). A neutral research process
// must render an identical report: the judgment is built from evidence, not price.
function perturbMarketOnly(sample) {
  const c = structuredClone(sample);
  c.marketStructure.board = [
    { candidate: 'Candidate A', yesCents: 12, noCents: 89, vol: 999999, oi: 7777 },   // flipped cheap
    { candidate: 'Candidate B', yesCents: 91, noCents: 10, vol: 1, oi: 1 },           // flipped expensive
  ];
  c.marketStructure.movement = 'A collapsed 62->12 over 48h.';
  return c;
}

test('neutrality: perturbing only the market board does not change the judgment text', () => {
  const clean = renderReport(BASE);
  const dirty = renderReport(perturbMarketOnly(BASE));
  // The §9 judgment and TLDR are evidence-driven; extract everything after the
  // market-structure section to compare the non-market narrative.
  const judgmentMarker = '9. Final Research Judgment';
  const cleanJudgment = clean.slice(clean.indexOf(judgmentMarker));
  const dirtyJudgment = dirty.slice(dirty.indexOf(judgmentMarker));
  assert.equal(dirtyJudgment, cleanJudgment,
    'market-board perturbation leaked into the final research judgment');
});

test('neutrality: section ordering is identical regardless of market prices', () => {
  const headings = (md) =>
    md.split('\n').filter(l => /^\s*#{1,6}\s|^\s*\d+\.\s[A-Z]/.test(l));
  assert.deepEqual(headings(renderReport(perturbMarketOnly(BASE))), headings(renderReport(BASE)));
});

test('neutrality: rendered report never emits a model probability disguised as fair value or prescriptive trade', () => {
  const md = renderReport(BASE);
  // The probabilityRange comes from the judgment branch (research estimate), but
  // the report must NOT present a market-derived "fair value" or a trade order.
  assert.ok(scanForbiddenLanguage(md).clean, 'forbidden prescriptive/trade language present');
  assert.ok(!/\bfair[ _]value\b/i.test(md), 'report must not label any number "fair value"');
  assert.ok(!/\b(buy yes|buy no|place a trade|kelly fraction|stake \d)/i.test(md),
    'report must not include prescriptive trade language');
});

test('neutrality: market context survives only inside the Market Structure section, not the evidence sections', () => {
  const md = renderReport(BASE);
  const settlementIdx = md.indexOf('2. Settlement Rules');
  const officialIdx = md.indexOf('4. Official Evidence');
  const marketIdx = md.indexOf('6. Market Structure');
  assert.ok(settlementIdx !== -1 && officialIdx !== -1 && marketIdx !== -1, 'expected sections present');
  // The cents/vol/oi figures should appear at/after the market section, not be
  // injected into the settlement or official-evidence narrative.
  const officialBlock = md.slice(officialIdx, marketIdx);
  assert.ok(!/\b\d+\s*¢|\byesCents\b|\bvol\b\s*[:=]/i.test(officialBlock),
    'market price figures leaked into the official-evidence section');
});
