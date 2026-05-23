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

// --- Phase 3 tests: Judgment / Aggregator branch ---

import { buildJudgmentEnvelope } from '../scripts/politics/lib/branch-dispatch.mjs';

const PHASE3_JUDGMENT = {
  strongestSignal: 'Senate Judiciary hearing already on calendar (official.facts[0])',
  strongestCounter: 'Acting AG exclusion creates real NO path (skeptic.settlementTraps[0])',
  biggestSettlementAmbiguity: 'Whether an acting AG could resolve every contract NO',
  biggestUncertainty: 'Whether confirmation occurs before market expiry',
  confidence: 'medium',
  watchlistTriggers: ['Senate Judiciary vote scheduled', 'On-record withdrawal by leader'],
  wouldChangeView:   ['Withdrawal of nomination', 'Senate Republican defection cluster'],
  citations: [
    { branch: 'official', ref: 'facts[0] hearing scheduled' },
    { branch: 'skeptic',  ref: 'settlementTraps[0] acting AG trap' },
  ],
};

test('validateBranches accepts the Phase 3 judgment shape', () => {
  const sample = { ...SAMPLE, judgment: PHASE3_JUDGMENT };
  const v = validateBranches(sample);
  assert.ok(v.ok, JSON.stringify(v.errors));
});

test('validateBranches rejects judgment with wrong-typed arrays', () => {
  const bad = { ...SAMPLE, judgment: { ...PHASE3_JUDGMENT, watchlistTriggers: 'nope' } };
  const v = validateBranches(bad);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('watchlistTriggers')));
});

test('renderReport surfaces Phase 3 judgment fields in TLDR and §9', () => {
  const md = renderReport({ ...SAMPLE, judgment: PHASE3_JUDGMENT });
  assert.ok(md.includes('Strongest verified non-price signal'), 'TLDR strongestSignal label');
  assert.ok(md.includes('Strongest counter-signal'),            'TLDR counter-signal label');
  assert.ok(md.includes('Biggest settlement ambiguity'),        'TLDR settlement ambiguity label');
  assert.ok(md.includes('Watchlist triggers'),                  '§9 watchlist triggers label');
  assert.ok(md.includes('Senate Judiciary hearing already on calendar'), 'judgment text rendered');
  assert.ok(md.includes('Research-only.'), 'explicit no-trade research-only line');
  // forbidden-language scan must stay clean on the rendered report
  assert.equal(scanForbiddenLanguage(md).clean, true);
});

test('buildJudgmentEnvelope wraps merged JSON, marks inputsOnly, defaults inherit', () => {
  const merged = { ...SAMPLE, judgment: undefined };
  const env = buildJudgmentEnvelope(merged);
  assert.equal(env.branch, 'judgment');
  assert.equal(env.inputsOnly, true);
  assert.equal(env.expectedOutputPath, 'judgment.json');
  assert.equal(env.model, 'inherit');
  assert.match(env.prompt, /Use ONLY the merged JSON/);
  assert.match(env.prompt, /Todd Blanche/); // merged JSON injected
});

test('judgment prompt does not allow trade/sizing/pick language in output spec', () => {
  const env = buildJudgmentEnvelope(SAMPLE);
  // The prompt itself negates picks/sizing — it must not instruct prescriptive output.
  assert.ok(!/\b(buy yes|buy no|place a trade|recommend(ed)? (a |to )?(trade|bet)|kelly fraction|stake \d)/i.test(env.prompt));
  assert.match(env.prompt, /Do NOT produce a pick/);
});

test('orchestrate replay mode renders judgment when judgment.json is present', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pol-judge-'));
  const bdir = join(dir, 'branches');
  mkdirSync(bdir, { recursive: true });
  writeFileSync(join(bdir, 'official.json'),    JSON.stringify({ facts: [{ claim: 'hearing scheduled', source: 'https://judiciary.senate.gov/x', date: '2026-05-20', verified: true }] }));
  writeFileSync(join(bdir, 'plausibility.json'), JSON.stringify({ candidates: [] }));
  writeFileSync(join(bdir, 'skeptic.json'),      JSON.stringify({ favoriteWrongReason: 'x', underpricedReason: 'y', settlementTraps: ['z'], narrativeTraps: ['w'] }));
  writeFileSync(join(bdir, 'judgment.json'),    JSON.stringify(PHASE3_JUDGMENT));
  const out = join(dir, 'r.md');
  const r = await orchestrate({ market: 'X', url: 'u', mode: 'replay', branchesDir: bdir, out });
  const md = readFileSync(r.path, 'utf8');
  assert.ok(md.includes('Senate Judiciary hearing already on calendar'));
  assert.ok(md.includes('Watchlist triggers'));
  assert.equal(scanForbiddenLanguage(md).clean, true);
});

// --- Phase 4 tests: cross-branch integrity ---

import { crossCheckBranches } from '../scripts/politics/lib/integrity-check.mjs';

test('crossCheckBranches passes on the Phase 3 sample', () => {
  const r = crossCheckBranches({ ...SAMPLE, judgment: PHASE3_JUDGMENT });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.warnings, []);
});

test('crossCheckBranches errors when judgment cites a missing branch', () => {
  const bad = { market: { id: 'X', url: 'u', asOf: 'now' },
    judgment: { citations: [{ branch: 'official', ref: 'x' }] } };
  const r = crossCheckBranches(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('official') && e.includes('empty')));
});

test('crossCheckBranches errors on unknown citation branch name', () => {
  const bad = { ...SAMPLE,
    judgment: { ...PHASE3_JUDGMENT, citations: [{ branch: 'made-up', ref: 'x' }] } };
  const r = crossCheckBranches(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('unknown branch')));
});

test('crossCheckBranches warns when official facts cite X_SOCIAL sources', () => {
  const merged = { market: { id: 'X', url: 'u', asOf: 'now' },
    official: { facts: [{ claim: 'leaked from X', source: 'https://x.com/abc', date: '2026-05-01', verified: true }] } };
  const r = crossCheckBranches(merged);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.length === 1);
  assert.match(r.warnings[0], /X_SOCIAL/);
  assert.match(r.warnings[0], /xSignal/);
});

test('crossCheckBranches warns on verified=true with UNKNOWN-tier source', () => {
  const merged = { market: { id: 'X', url: 'u', asOf: 'now' },
    official: { facts: [{ claim: 'trust me', source: '', date: '2026-05-01', verified: true }] } };
  const r = crossCheckBranches(merged);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.length === 1);
  assert.match(r.warnings[0], /UNKNOWN/);
});

test('orchestrate exits code 6 when judgment cites an empty branch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pol-int-'));
  const bdir = join(dir, 'branches');
  mkdirSync(bdir, { recursive: true });
  writeFileSync(join(bdir, 'official.json'), JSON.stringify({ facts: [] }));
  writeFileSync(join(bdir, 'judgment.json'), JSON.stringify({
    judgment: { confidence: 'low', citations: [{ branch: 'plausibility', ref: 'nope' }] },
  }));
  await assert.rejects(
    () => orchestrate({ market: 'X', url: 'u', mode: 'replay', branchesDir: bdir, out: join(dir, 'r.md') }),
    (e) => e.code === 6,
  );
});

test('orchestrate surfaces integrity warnings into report meta', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pol-intw-'));
  const bdir = join(dir, 'branches');
  mkdirSync(bdir, { recursive: true });
  writeFileSync(join(bdir, 'official.json'), JSON.stringify({
    facts: [{ claim: 'rumor laundered as fact', source: 'https://x.com/handle/status/1',
              date: '2026-05-01', verified: true }],
  }));
  writeFileSync(join(bdir, 'plausibility.json'), JSON.stringify({ candidates: [] }));
  const out = join(dir, 'r.md');
  await orchestrate({ market: 'X', url: 'u', mode: 'replay', branchesDir: bdir, out });
  const md = readFileSync(out, 'utf8');
  assert.ok(md.includes('Integrity warnings'),  'meta section should expose integrity warnings');
  assert.ok(md.includes('X_SOCIAL'),            'specific X_SOCIAL warning should render');
  assert.equal(scanForbiddenLanguage(md).clean, true);
});


// --- Phase 5 tests: pluggable branch executor ---

import {
  runBranches, fakeAdapter, cacheAdapter, parseBranchJson,
} from '../scripts/politics/lib/branch-runner.mjs';

function envsFromFakeKalshi(overrides = {}) {
  const auto = buildMarketBranches(FAKE_KALSHI, { eventTicker: 'KXNEXTAG-29', eventUrl: 'https://kalshi.com/x' });
  return { auto, envs: buildEnvelopes(auto, { modelOverrides: overrides }) };
}

const FAKE_BRANCH_OUTPUTS = {
  official:    { facts: [{ claim: 'Hearing scheduled', source: 'https://judiciary.senate.gov/h', date: '2026-05-20', verified: true }] },
  xSignal:     { narratives: [{ claim: 'Buzz', tier: 'rumor', repeated: true, source: 'https://x.com/u/status/1' }] },
  plausibility:{ candidates: [{ name: 'Todd Blanche', strengths: ['Trump trust'], weaknesses: ['Already SDAG'], obstacles: ['Senate math'] }] },
  skeptic:     { favoriteWrong: ['Acting AG path'], secondUnderpriced: ['Zeldin'], settlementTraps: ['Acting exclusion'], narrativeTraps: ['X echo'] },
  judgment:    {
    strongestSignal: 'official.facts[0]',
    strongestCounter: 'skeptic.settlementTraps[0]',
    biggestSettlementAmbiguity: 'Acting AG resolution path',
    biggestUncertainty: 'Confirmation before expiry',
    confidence: 'medium',
    watchlistTriggers: ['Judiciary vote scheduled'],
    wouldChangeView:   ['Withdrawal'],
    citations: [{ branch: 'official', ref: 'facts[0]' }, { branch: 'skeptic', ref: 'settlementTraps[0]' }],
  },
};

test('Phase 5: fakeAdapter executes all research branches in parallel and produces values', async () => {
  const { envs } = envsFromFakeKalshi();
  const order = [];
  const adapter = fakeAdapter({
    official:     async () => { order.push('official:start');     await new Promise(r => setTimeout(r, 10)); order.push('official:end');     return FAKE_BRANCH_OUTPUTS.official; },
    xSignal:      async () => { order.push('xSignal:start');      await new Promise(r => setTimeout(r, 10)); order.push('xSignal:end');      return FAKE_BRANCH_OUTPUTS.xSignal; },
    plausibility: async () => { order.push('plausibility:start'); await new Promise(r => setTimeout(r, 10)); order.push('plausibility:end'); return FAKE_BRANCH_OUTPUTS.plausibility; },
    skeptic:      async () => { order.push('skeptic:start');      await new Promise(r => setTimeout(r, 10)); order.push('skeptic:end');      return FAKE_BRANCH_OUTPUTS.skeptic; },
  });
  const r = await runBranches({ envelopes: envs, adapter, concurrency: 4 });
  assert.equal(Object.keys(r.branches).sort().join(','), 'official,plausibility,skeptic,xSignal');
  // Parallel proof: first 4 events must all be `:start` before any `:end`.
  const firstFour = order.slice(0, 4);
  assert.ok(firstFour.every((s) => s.endsWith(':start')), `expected 4 starts first, got ${JSON.stringify(order)}`);
  assert.equal(r.execution.filter((e) => e.status === 'ok').length, 4);
});

test('Phase 5: judgment runs only AFTER research branches complete', async () => {
  const { auto, envs } = envsFromFakeKalshi();
  const seenAtJudgment = { official: false, xSignal: false, plausibility: false, skeptic: false };
  let researchDoneCount = 0;
  const adapter = fakeAdapter({
    official:     async () => { researchDoneCount++; return FAKE_BRANCH_OUTPUTS.official; },
    xSignal:      async () => { researchDoneCount++; return FAKE_BRANCH_OUTPUTS.xSignal; },
    plausibility: async () => { researchDoneCount++; return FAKE_BRANCH_OUTPUTS.plausibility; },
    skeptic:      async () => { researchDoneCount++; return FAKE_BRANCH_OUTPUTS.skeptic; },
    judgment: async () => {
      assert.equal(researchDoneCount, 4, 'judgment fired before all research branches completed');
      return FAKE_BRANCH_OUTPUTS.judgment;
    },
  });
  const r = await runBranches({
    envelopes: envs, adapter, concurrency: 4,
    judgmentEnvelopeBuilder: (partial) => {
      for (const k of Object.keys(seenAtJudgment)) seenAtJudgment[k] = partial[k] != null;
      return { branch: 'judgment', model: 'inherit', prompt: 'j', expectedOutputPath: 'judgment.json', inputsOnly: true };
    },
  });
  assert.ok(r.branches.judgment, 'judgment should be populated');
  assert.deepEqual(seenAtJudgment, { official: true, xSignal: true, plausibility: true, skeptic: true });
});

test('Phase 5: fallback-routed status when adapter cannot route requested model', async () => {
  const { envs } = envsFromFakeKalshi({ xSignal: 'grok', skeptic: 'grok' });
  const adapter = fakeAdapter({
    official:     async () => FAKE_BRANCH_OUTPUTS.official,
    xSignal:      async () => FAKE_BRANCH_OUTPUTS.xSignal,
    plausibility: async () => FAKE_BRANCH_OUTPUTS.plausibility,
    skeptic:      async () => FAKE_BRANCH_OUTPUTS.skeptic,
  }, { canRoute: ['inherit'] });
  const r = await runBranches({ envelopes: envs, adapter });
  const fallbacks = r.execution.filter((e) => e.status === 'fallback-routed');
  assert.equal(fallbacks.length, 2);
  const branches = fallbacks.map((e) => e.branch).sort();
  assert.deepEqual(branches, ['skeptic', 'xSignal']);
  // The actual run record still completes ok.
  assert.equal(r.execution.filter((e) => e.branch === 'xSignal' && e.status === 'ok').length, 1);
});

test('Phase 5: parseBranchJson succeeds with one repair retry for fenced JSON', () => {
  const fenced = "```json\n{\"facts\":[]}\n```\n";
  const r = parseBranchJson(fenced, { branchKey: 'official' });
  assert.equal(r.repaired, true);
  assert.deepEqual(r.value, { facts: [] });

  const ok = parseBranchJson('{"facts":[]}', { branchKey: 'official' });
  assert.equal(ok.repaired, false);

  assert.throws(() => parseBranchJson('not json at all', { branchKey: 'official' }));
});

test('Phase 5: branch repair surfaces as "repaired" status, broken surfaces as "failed"', async () => {
  const { envs } = envsFromFakeKalshi();
  const adapter = fakeAdapter({
    official:     async () => "```json\n" + JSON.stringify(FAKE_BRANCH_OUTPUTS.official) + "\n```",
    xSignal:      async () => 'totally broken not-json',
    plausibility: async () => FAKE_BRANCH_OUTPUTS.plausibility,
    skeptic:      async () => FAKE_BRANCH_OUTPUTS.skeptic,
  });
  const r = await runBranches({ envelopes: envs, adapter });
  const byBranch = Object.fromEntries(r.execution.filter((e) => e.status !== 'fallback-routed').map((e) => [e.branch, e]));
  assert.equal(byBranch.official.status, 'repaired');
  assert.equal(byBranch.official.repairUsed, true);
  assert.equal(byBranch.xSignal.status, 'failed');
  assert.match(byBranch.xSignal.error, /parse/);
  assert.equal(r.branches.xSignal, undefined);
});

test('Phase 5: timeout surfaces as "timeout" status in execution[]', async () => {
  const { envs } = envsFromFakeKalshi();
  const adapter = fakeAdapter({
    official:     async () => new Promise(() => {}),  // hangs forever
    xSignal:      async () => FAKE_BRANCH_OUTPUTS.xSignal,
    plausibility: async () => FAKE_BRANCH_OUTPUTS.plausibility,
    skeptic:      async () => FAKE_BRANCH_OUTPUTS.skeptic,
  });
  const r = await runBranches({ envelopes: envs, adapter, timeoutMs: 30, concurrency: 4 });
  const off = r.execution.find((e) => e.branch === 'official');
  assert.equal(off.status, 'timeout');
  assert.match(off.error, /timed out/);
});

test('Phase 5: execute mode produces a clean rendered report end-to-end', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pol-exec-'));
  const cacheDir = join(dir, 'cache');
  const out = join(dir, 'report.md');
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => FAKE_KALSHI, text: async () => '' });
  const adapter = fakeAdapter({
    official:     async () => FAKE_BRANCH_OUTPUTS.official,
    xSignal:      async () => FAKE_BRANCH_OUTPUTS.xSignal,
    plausibility: async () => FAKE_BRANCH_OUTPUTS.plausibility,
    skeptic:      async () => FAKE_BRANCH_OUTPUTS.skeptic,
    judgment:     async () => FAKE_BRANCH_OUTPUTS.judgment,
  });
  const r = await orchestrate({
    market: 'KXNEXTAG-29', url: 'https://kalshi.com/x',
    mode: 'execute', cacheDir, out, fetchImpl: fakeFetch,
    executor: adapter, executorOpts: { concurrency: 4, timeoutMs: 5000 },
  });
  assert.equal(r.path, out);
  assert.ok(r.execution.length >= 5, 'should have 4 research + 1 judgment execution records');
  const md = readFileSync(out, 'utf8');
  assert.equal(scanForbiddenLanguage(md).clean, true);
  assert.ok(md.includes('Todd Blanche'));
  // branches/*.json must have been written for replay parity.
  const writtenJudgment = JSON.parse(readFileSync(join(cacheDir, 'branches', 'judgment.json'), 'utf8'));
  assert.equal(writtenJudgment.confidence, 'medium');
  // meta.branchExecution must be embedded in merged.
  const merged = JSON.parse(readFileSync(join(cacheDir, 'branches.merged.json'), 'utf8'));
  assert.ok(Array.isArray(merged.meta.branchExecution));
});

test('Phase 5: cacheAdapter replays branches from disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pol-cache-'));
  const bdir = join(dir, 'branches');
  mkdirSync(bdir, { recursive: true });
  for (const [k, v] of Object.entries(FAKE_BRANCH_OUTPUTS)) {
    writeFileSync(join(bdir, `${k}.json`), JSON.stringify(v));
  }
  const { envs } = envsFromFakeKalshi();
  const r = await runBranches({
    envelopes: envs,
    adapter: cacheAdapter(bdir),
    judgmentEnvelopeBuilder: () => ({ branch: 'judgment', model: 'inherit', prompt: 'j', expectedOutputPath: 'judgment.json', inputsOnly: true }),
  });
  assert.ok(r.branches.judgment);
  assert.equal(r.execution.filter((e) => e.status === 'ok').length, 5);
});

test('Phase 5: existing replay/envelopes-only modes still work (regression)', async () => {
  // envelopes-only
  const dir1 = mkdtempSync(join(tmpdir(), 'pol-env-'));
  const cacheDir1 = join(dir1, 'cache');
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => FAKE_KALSHI, text: async () => '' });
  const r1 = await orchestrate({
    market: 'KXNEXTAG-29', url: 'https://kalshi.com/x',
    mode: 'envelopes-only', cacheDir: cacheDir1, fetchImpl: fakeFetch,
  });
  assert.ok(r1.envelopes.length >= 4);
  assert.equal(r1.path, undefined);

  // replay
  const dir2 = mkdtempSync(join(tmpdir(), 'pol-rp2-'));
  const bdir = join(dir2, 'branches');
  mkdirSync(bdir, { recursive: true });
  writeFileSync(join(bdir, 'official.json'),     JSON.stringify(FAKE_BRANCH_OUTPUTS.official));
  writeFileSync(join(bdir, 'plausibility.json'), JSON.stringify(FAKE_BRANCH_OUTPUTS.plausibility));
  const out = join(dir2, 'replay.md');
  const r2 = await orchestrate({
    market: 'KXNEXTAG-29', url: 'https://kalshi.com/x',
    mode: 'replay', branchesDir: bdir, out,
  });
  assert.equal(r2.path, out);
  assert.equal(r2.execution, null, 'replay mode must not produce execution records');
});


// --- Phase 6 tests: hermes-bridge.sh via cmdAdapter ---

import { cmdAdapter } from '../scripts/politics/lib/branch-runner.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = pathResolve(HERE, '..', 'scripts', 'politics', 'bin', 'hermes-bridge.sh');

function bridgeEnvCmd(extra = '') {
  // Pass env via the shell prefix so cmdAdapter's child env merge applies cleanly.
  return `${extra} ${BRIDGE}`;
}

test('Phase 6: dry-run bridge emits branch-valid JSON for every branch', async () => {
  const adapter = cmdAdapter(`POLITICS_BRIDGE_MODE=dry-run ${BRIDGE}`);
  const branches = ['official', 'xSignal', 'plausibility', 'skeptic', 'judgment'];
  const merged = { market: { id: 'KXNEXTAG-29', url: 'https://kalshi.com/x', asOf: 'now' } };
  for (const b of branches) {
    const env = { branch: b, model: 'inherit', prompt: 'p', inputsOnly: b === 'judgment' };
    const raw = await adapter.execute(env, {});
    const obj = JSON.parse(raw);
    merged[b] = obj;
  }
  const v = validateBranches(merged);
  assert.ok(v.ok, `validate errors: ${JSON.stringify(v.errors)}`);
});

test('Phase 6: bridge stderr noise does NOT corrupt stdout JSON', async () => {
  const adapter = cmdAdapter(`POLITICS_BRIDGE_MODE=dry-run ${BRIDGE}`);
  const raw = await adapter.execute(
    { branch: 'official', model: 'inherit', prompt: 'hello world bytes', inputsOnly: false }, {},
  );
  // Pure JSON, no stray "[hermes-bridge]" log lines mixed in
  assert.doesNotMatch(raw, /\[hermes-bridge\]/);
  assert.deepEqual(typeof JSON.parse(raw), 'object');
});

test('Phase 6: bridge non-zero exit surfaces as cmdAdapter "failed"', async () => {
  // Force the inherit route, which is a stub that exits 2 by design.
  const adapter = cmdAdapter(`POLITICS_BRIDGE_MODE=inherit ${BRIDGE}`);
  const auto = buildMarketBranches(FAKE_KALSHI, { eventTicker: 'KXNEXTAG-29' });
  const envs = buildEnvelopes(auto).slice(0, 1); // one branch is enough
  const r = await runBranches({ envelopes: envs, adapter, concurrency: 1, timeoutMs: 5000 });
  const rec = r.execution.find((e) => e.status !== 'fallback-routed');
  assert.equal(rec.status, 'failed');
  assert.match(rec.error, /exit 2|exit code|cmdAdapter/i);
});

test('Phase 6: bridge timeout surfaces as cmdAdapter "timeout"', async () => {
  // sleep 5 then echo — runner timeout at 50ms should kill it.
  const slow = `bash -c "sleep 5; echo '{}'"`;
  const adapter = cmdAdapter(slow);
  const auto = buildMarketBranches(FAKE_KALSHI, { eventTicker: 'KXNEXTAG-29' });
  const envs = buildEnvelopes(auto).slice(0, 1);
  const r = await runBranches({ envelopes: envs, adapter, concurrency: 1, timeoutMs: 50 });
  const rec = r.execution.find((e) => e.status !== 'fallback-routed');
  assert.equal(rec.status, 'timeout');
});

test('Phase 6: execute mode + cmdAdapter + dry-run bridge produces clean rendered report', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pol-bridge-'));
  const cacheDir = join(dir, 'cache');
  const out = join(dir, 'report.md');
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => FAKE_KALSHI, text: async () => '' });
  const adapter = cmdAdapter(`POLITICS_BRIDGE_MODE=dry-run ${BRIDGE}`);
  const r = await orchestrate({
    market: 'KXNEXTAG-29', url: 'https://kalshi.com/x',
    mode: 'execute', cacheDir, out, fetchImpl: fakeFetch,
    executor: adapter, executorOpts: { concurrency: 4, timeoutMs: 10_000 },
  });
  assert.equal(r.path, out);
  assert.equal(r.execution.filter((e) => e.status === 'ok').length, 5);
  const md = readFileSync(out, 'utf8');
  assert.equal(scanForbiddenLanguage(md).clean, true);
  assert.ok(md.includes('Todd Blanche'));
  // Replay parity: branches/*.json written for every branch.
  for (const b of ['official', 'xSignal', 'plausibility', 'skeptic', 'judgment']) {
    JSON.parse(readFileSync(join(cacheDir, 'branches', `${b}.json`), 'utf8'));
  }
});

test('Phase 6: fallback-routed triggers when cmdAdapter does not declare grok', async () => {
  // canRoute defaults to ['inherit']; xSignal/skeptic request grok → fallback.
  const adapter = cmdAdapter(`POLITICS_BRIDGE_MODE=dry-run ${BRIDGE}`);
  const auto = buildMarketBranches(FAKE_KALSHI, { eventTicker: 'KXNEXTAG-29' });
  const envs = buildEnvelopes(auto, { modelOverrides: { xSignal: 'grok', skeptic: 'grok' } });
  const r = await runBranches({ envelopes: envs, adapter, concurrency: 4, timeoutMs: 10_000 });
  const fb = r.execution.filter((e) => e.status === 'fallback-routed').map((e) => e.branch).sort();
  assert.deepEqual(fb, ['skeptic', 'xSignal']);
  // And they still complete ok after fallback (dry-run succeeds on inherit).
  for (const b of ['xSignal', 'skeptic']) {
    const ok = r.execution.find((e) => e.branch === b && e.status === 'ok');
    assert.ok(ok, `${b} should complete ok after fallback`);
  }
});
