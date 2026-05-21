import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderReport, __NO_TRADE__ } from '../scripts/politics/lib/report-render.mjs';
import { classifySource, sortBySourceTier, TIERS } from '../scripts/politics/lib/source-classifier.mjs';
import { runResearch, buildBranches } from '../scripts/politics/research-market.mjs';

const SAMPLE = {
  market: { id: 'KXNEXTAG-29', url: 'https://kalshi.com/m', title: 'Next AG', asOf: '2026-05-21T00:00:00Z' },
  settlement: { rules: 'Next confirmed AG.', ambiguities: ['acting AG excluded?'], actingInterim: 'excluded' },
  official: {
    facts: [
      { date: '2026-05-20', claim: 'Senate hearing scheduled', source: 'https://judiciary.senate.gov/x', verified: true },
      { date: '2026-05-19', claim: 'Reuters reports shortlist', source: 'https://reuters.com/x',         verified: false },
    ],
  },
  xSignal: { narratives: [{ claim: 'Blanche locked in', tier: 'rumor', repeated: true, source: 'https://x.com/y' }] },
  marketStructure: {
    board: [
      { candidate: 'Todd Blanche', yesCents: 62, noCents: 39, vol: 12000, oi: 5000 },
      { candidate: 'Lee Zeldin',   yesCents: 18, noCents: 83, vol:  4000, oi: 1500 },
      { candidate: 'Jeanine Pirro', yesCents: 9, noCents: 92, vol:  2000, oi:  800 },
    ],
    movement: 'Blanche drifted 55→62 over 48h.',
    limitations: 'Thin book; one large fill can shift 5¢.',
  },
  plausibility: {
    candidates: [
      { name: 'Todd Blanche', strengths: ['Trump loyalist'], weaknesses: ['no AG experience'], obstacles: ['Senate math'] },
    ],
  },
  skeptic: {
    favoriteWrongReason: 'Press narrative ≠ confirmation vote',
    underpricedReason: 'Zeldin has confirm-friendly resume',
    settlementTraps: ['acting AG could resolve NO for everyone'],
    narrativeTraps: ['X loops the same rumor'],
  },
  judgment: {
    probabilityRange: '0.45-0.60',
    confidence: 'medium',
    bestNonPriceReason: 'Confirmation-vote math, not chatter',
    biggestUncertainty: 'Whether settlement counts acting AG',
    wouldChangeView: ['On-record withdrawal'],
    monitorNext: ['Senate Judiciary schedule'],
  },
  meta: { xSearchAvailable: true, xSearchUsed: true, notChecked: ['DOJ inside sources'] },
};

test('classifySource ranks tiers correctly', () => {
  assert.equal(classifySource('https://judiciary.senate.gov/x').tier, TIERS.OFFICIAL_GOV);
  assert.equal(classifySource('https://reuters.com/x').tier,           TIERS.REPORTING);
  assert.equal(classifySource('https://x.com/y').tier,                 TIERS.X_SOCIAL);
  assert.equal(classifySource('https://kalshi.com/markets/x').tier,    TIERS.MARKET);
  assert.equal(classifySource('kalshi rules: next AG').tier,           TIERS.KALSHI_RULES);
  assert.equal(classifySource(null).tier,                              TIERS.UNKNOWN);
});

test('sortBySourceTier puts gov before reporting before x', () => {
  const sorted = sortBySourceTier([
    { source: 'https://x.com/a' },
    { source: 'https://reuters.com/a' },
    { source: 'https://doj.gov/a' },
  ]);
  assert.equal(classifySource(sorted[0].source).tier, TIERS.OFFICIAL_GOV);
  assert.equal(classifySource(sorted[2].source).tier, TIERS.X_SOCIAL);
});

test('renderReport emits all 9 sections + meta + no-trade footer', () => {
  const md = renderReport(SAMPLE);
  for (const h of [
    '1. TLDR', '2. Settlement Rules', '3. Candidate Board', '4. Official Evidence',
    '5. X Signal', '6. Market Structure', '7. Political Plausibility',
    '8. Skeptic Review', '9. Final Research Judgment',
  ]) assert.ok(md.includes(h), `missing section: ${h}`);
  assert.ok(md.includes(__NO_TRADE__), 'no-trade disclaimer missing');
  assert.ok(md.includes('Todd Blanche'),  'candidate board missing Blanche');
  assert.ok(md.includes('judiciary.senate.gov'), 'official source missing');
  assert.ok(md.includes('x_search available'),   'meta missing');
  // Disclaimers may mention "bankroll" / "trade" in NEGATION; we forbid prescriptive language.
  assert.ok(!/\b(buy yes|buy no|place a trade|recommend(ed)? (a |to )?(trade|bet)|kelly fraction|stake \d)/i.test(md),
    'must not include prescriptive trade language');
});

test('renderReport is deterministic for the same input', () => {
  assert.equal(renderReport(SAMPLE), renderReport(SAMPLE));
});

test('renderReport tolerates empty branches (scaffold mode)', () => {
  const md = renderReport({ market: { id: 'X', title: 'X', url: 'u', asOf: 'now' } });
  assert.ok(md.includes('(UNKNOWN — branch not run)'));
  assert.ok(md.includes(__NO_TRADE__));
});

test('runResearch writes file to disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pol-swarm-'));
  const branchesPath = join(dir, 'b.json');
  writeFileSync(branchesPath, JSON.stringify(SAMPLE));
  const out = join(dir, 'report.md');
  const r = runResearch({ market: 'KXNEXTAG-29', url: 'https://kalshi.com/m', branchesJsonPath: branchesPath, out });
  assert.equal(r.path, out);
  const md = readFileSync(out, 'utf8');
  assert.ok(md.startsWith('# Politics-Market Research Report'));
});

test('buildBranches preserves provided market metadata', () => {
  const b = buildBranches({ market: 'KXNEXTAG-29', url: 'https://k/m' });
  assert.equal(b.market.id,  'KXNEXTAG-29');
  assert.equal(b.market.url, 'https://k/m');
});
