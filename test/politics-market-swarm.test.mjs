import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderReport, __NO_TRADE__ } from '../scripts/politics/lib/report-render.mjs';
import { classifySource, sortBySourceTier, TIERS } from '../scripts/politics/lib/source-classifier.mjs';
import { runResearch, buildBranches, orchestrate } from '../scripts/politics/research-market.mjs';
import { validateBranches, scanForbiddenLanguage } from '../scripts/politics/lib/branch-contract.mjs';
import { buildMarketBranches, normalizeMarket } from '../scripts/politics/lib/kalshi-fetch.mjs';
import { buildEnvelopes, mergeBranches, loadBranchesDir, BRANCHES } from '../scripts/politics/lib/branch-dispatch.mjs';
import { mkdirSync } from 'node:fs';

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

// --- Phase 2 tests ---

const FAKE_KALSHI = {
  markets: [
    { ticker: 'KXNEXTAG-29-TBLA', yes_sub_title: 'Todd Blanche', yes_bid_dollars: 0.43, yes_ask_dollars: 0.44,
      no_bid_dollars: 0.56, no_ask_dollars: 0.57, open_interest_fp: 391875, volume_24h_fp: 32712,
      rules_primary: 'If the first new person to be Attorney General is Todd Blanche before Jan 20, 2029, then the market resolves to Yes.',
      rules_secondary: 'Acting and Interim holders of the office are not included in the Payout Criterion.' },
    { ticker: 'KXNEXTAG-29-LZEL', yes_sub_title: 'Lee Zeldin', yes_bid_dollars: 0.27, yes_ask_dollars: 0.29,
      no_bid_dollars: 0.71, no_ask_dollars: 0.73, open_interest_fp: 336175, volume_24h_fp: 23644 },
  ],
};

test('validateBranches accepts a complete sample', () => {
  const v = validateBranches(SAMPLE);
  assert.ok(v.ok, JSON.stringify(v.errors));
});

test('validateBranches rejects missing market.id and root-non-object', () => {
  assert.equal(validateBranches({}).ok, false);
  assert.equal(validateBranches('nope').ok, false);
  assert.equal(validateBranches({ market: { url: 'x', asOf: 'now' } }).ok, false);
});

test('validateBranches repair fills missing branch arrays', () => {
  const v = validateBranches({ market: { id: 'X', url: 'u', asOf: 'now' }, official: {} }, { repair: true });
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.deepEqual(v.repaired.official.facts, []);
});

test('scanForbiddenLanguage allows disclaimer, flags prescription', () => {
  assert.equal(scanForbiddenLanguage('No bankroll sizing. Research only.').clean, true);
  assert.equal(scanForbiddenLanguage('I recommend buy YES at 43c').clean, false);
  assert.equal(scanForbiddenLanguage('place a trade at the open').clean, false);
});

test('kalshi normalizeMarket converts dollars to cents', () => {
  const n = normalizeMarket(FAKE_KALSHI.markets[0]);
  assert.equal(n.yesBidCents, 43);
  assert.equal(n.yesAskCents, 44);
  assert.equal(n.candidate, 'Todd Blanche');
});

test('buildMarketBranches produces market/settlement/marketStructure', () => {
  const b = buildMarketBranches(FAKE_KALSHI, { eventTicker: 'KXNEXTAG-29', eventUrl: 'https://kalshi.com/x' });
  assert.equal(b.market.id, 'KXNEXTAG-29');
  assert.match(b.settlement.rules, /<CANDIDATE>/);
  assert.match(b.settlement.actingInterim, /excluded/);
  assert.equal(b.marketStructure.board[0].candidate, 'Todd Blanche');
  assert.equal(b.marketStructure.board[0].yesCents, 43);
  assert.equal(b.marketStructure.contractCount, 2);
});

test('buildEnvelopes emits one prompt per non-auto-built branch with overrides', () => {
  const auto = buildMarketBranches(FAKE_KALSHI, { eventTicker: 'KXNEXTAG-29' });
  const envs = buildEnvelopes(auto, { modelOverrides: { xSignal: 'grok', skeptic: 'grok' } });
  const keys = envs.map((e) => e.branch);
  assert.deepEqual(keys.sort(), ['official', 'plausibility', 'skeptic', 'xSignal'].sort());
  const xs = envs.find((e) => e.branch === 'xSignal');
  assert.equal(xs.model, 'grok');
  assert.match(xs.prompt, /Todd Blanche: 43¢ YES/);
});

test('loadBranchesDir + mergeBranches: auto-built market wins on asOf', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pol-bdir-'));
  writeFileSync(join(dir, 'official.json'), JSON.stringify({ facts: [{ claim: 'x', source: 'https://doj.gov/x', date: '2026-05-20', verified: true }] }));
  writeFileSync(join(dir, 'xSignal.json'),  JSON.stringify({ narratives: [{ claim: 'y', tier: 'rumor', repeated: false, source: 'https://x.com/z' }] }));
  const fromDir = loadBranchesDir(dir);
  const auto = buildMarketBranches(FAKE_KALSHI, { eventTicker: 'KXNEXTAG-29' });
  const merged = mergeBranches(auto, fromDir);
  assert.equal(merged.official.facts.length, 1);
  assert.equal(merged.xSignal.narratives.length, 1);
  assert.equal(merged.market.id, 'KXNEXTAG-29');
  assert.ok(merged.marketStructure.board.length >= 2);
});

test('orchestrate live mode with injected fetchImpl writes report + envelopes + cache', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pol-orch-'));
  const cacheDir = join(dir, 'cache');
  const out      = join(dir, 'report.md');
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => FAKE_KALSHI, text: async () => '' });
  const r = await orchestrate({
    market: 'KXNEXTAG-29', url: 'https://kalshi.com/x',
    mode: 'live', cacheDir, out, fetchImpl: fakeFetch,
    modelOverrides: { xSignal: 'grok' },
  });
  assert.equal(r.path, out);
  assert.ok(r.envelopes.length >= 4);
  assert.ok(readFileSync(join(cacheDir, 'fetch.json'), 'utf8').includes('Todd Blanche'));
  assert.ok(readFileSync(join(cacheDir, 'envelopes.json'), 'utf8').includes('xSignal'));
  const md = readFileSync(out, 'utf8');
  assert.ok(md.includes('Todd Blanche'));
  assert.ok(md.includes('Acting and Interim') || md.includes('actingInterim') || md.includes('excluded'));
  assert.equal(scanForbiddenLanguage(md).clean, true);
});

test('orchestrate replay mode reads cached branches without network', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pol-replay-'));
  const cacheDir = join(dir, 'cache');
  mkdirSync(cacheDir, { recursive: true });
  // Pre-seed a branches-dir with minimal LLM outputs.
  const bdir = join(dir, 'branches');
  mkdirSync(bdir, { recursive: true });
  writeFileSync(join(bdir, 'official.json'), JSON.stringify({ facts: [] }));
  writeFileSync(join(bdir, 'plausibility.json'), JSON.stringify({ candidates: [] }));
  const out = join(dir, 'replay.md');
  const r = await orchestrate({
    market: 'KXNEXTAG-29', url: 'https://kalshi.com/x',
    mode: 'replay', branchesDir: bdir, out,
    fetchImpl: () => { throw new Error('NETWORK FORBIDDEN IN REPLAY'); },
  });
  assert.equal(r.path, out);
  const md = readFileSync(out, 'utf8');
  assert.ok(md.startsWith('# Politics-Market Research Report'));
});

test('orchestrate fails fast (code 3) on un-repairable branch JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pol-bad-'));
  const bdir = join(dir, 'branches');
  mkdirSync(bdir, { recursive: true });
  // official.facts is a string, not an array — repair leaves it broken.
  writeFileSync(join(bdir, 'official.json'), JSON.stringify({ facts: 'oops' }));
  await assert.rejects(
    () => orchestrate({ market: 'X', url: 'u', mode: 'replay', branchesDir: bdir, out: join(dir, 'r.md') }),
    (e) => e.code === 3,
  );
});
