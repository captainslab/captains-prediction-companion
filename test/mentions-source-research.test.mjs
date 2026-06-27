import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  firecrawlCliFetch,
  fetchSourceDocument,
  runBoundedSourceResearch,
  validateExtractionJson,
  mergeExtractedLayers,
  loadDeclaredSources,
  cachePathForUrl,
  sourceHealthPathForUrl,
  maxSources,
  SOURCE_FETCH_STATUS,
  EVIDENCE_LAYERS,
} from '../scripts/mentions/source-research.mjs';
import { buildEventResearch } from '../scripts/mentions/collect-mentions-research.mjs';
import {
  mergePasses,
  buildResearchTermNote,
  ensurePerplexityEnvLoaded,
  runResearchForEvent,
} from '../scripts/mentions/mentions-research-perplexity.mjs';

test('cron-like env: Perplexity key loads from .env.local without exported shell state', () => {
  const root = mkdtempSync(join(tmpdir(), 'pplx-env-'));
  // Other secrets present too — only the Perplexity key vars must be read.
  writeFileSync(join(root, '.env.local'), [
    'TELEGRAM_BOT_TOKEN=should-not-load',
    'PERPLEXITY_API_KEY="pplx-test-secret-123"',
    '',
  ].join('\n'));
  const env = {}; // no inherited shell state, mimics non-interactive cron
  ensurePerplexityEnvLoaded(env, { root });
  assert.equal(env.PERPLEXITY_API_KEY, 'pplx-test-secret-123', 'key loaded from .env.local');
  assert.equal(env.TELEGRAM_BOT_TOKEN, undefined, 'narrow: non-Perplexity secrets are NOT loaded');
});

test('ensurePerplexityEnvLoaded never overwrites an already-set key and is silent', () => {
  const root = mkdtempSync(join(tmpdir(), 'pplx-env-keep-'));
  writeFileSync(join(root, '.env.local'), 'PERPLEXITY_API_KEY=from-file-secret\n');
  const env = { PERPLEXITY_API_KEY: 'from-shell-secret' };
  const logs = [];
  const orig = { log: console.log, error: console.error };
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => logs.push(a.join(' '));
  try {
    ensurePerplexityEnvLoaded(env, { root });
  } finally {
    console.log = orig.log; console.error = orig.error;
  }
  assert.equal(env.PERPLEXITY_API_KEY, 'from-shell-secret', 'existing env var wins, file does not override');
  const blob = logs.join('\n');
  assert.ok(!/from-file-secret|from-shell-secret/.test(blob), 'secret value never printed');
});

test('ensurePerplexityEnvLoaded fabricates no key when no .env / .env.local exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'pplx-env-none-'));
  const env = {};
  ensurePerplexityEnvLoaded(env, { root });
  assert.equal(env.PERPLEXITY_API_KEY, undefined, 'no key invented when config is absent (fail-closed upstream)');
});

const DATE = '2026-06-12';
const TERMS = ['China / Chinese', 'Epstein', 'Pardon / Pardoned'];

function fakeFetch(text = 'transcript: he discussed China and the pardon at length', counter = { calls: 0 }) {
  return async () => {
    counter.calls += 1;
    return { ok: true, status: 200, text: async () => text };
  };
}

function statusFetch(status, text = '') {
  return async () => ({ ok: false, status, text: async () => text });
}

function makeExecFileSequence(responses) {
  let calls = 0;
  const execFileImpl = (_cmd, _args, _opts, cb) => {
    const response = responses[Math.min(calls, responses.length - 1)];
    calls += 1;
    const err = response?.error ?? new Error(response?.message ?? 'firecrawl failure');
    if (response?.killed != null) err.killed = response.killed;
    cb(err, response?.stdout ?? '', response?.stderr ?? '');
  };
  return { execFileImpl, getCalls: () => calls };
}

function goodExtraction() {
  return {
    terms: [
      { term: 'China / Chinese', layers: { direct_mention_pathway: { present: true, score: 72, basis: '"discussed China" verbatim' }, historical_tendency: { present: true, score: 64, basis: 'recurring topic in prior interviews' } } },
      { term: 'Pardon / Pardoned', layers: { storyline_relevance: { present: true, score: 81, basis: 'pardon is the interview premise' } } },
    ],
  };
}

test('mergePasses prefers the handicap reason when proof is empty and the blend is handicap-driven', () => {
  const rows = mergePasses(
    [{ phrase: 'Affordability', ticker: 'AFF' }],
    [{ phrase: 'Affordability', likelihood_pct: 8, confidence: 'low', reason: 'no evidence / no mention in the provided results' }],
    [{ phrase: 'Affordability', likelihood_pct: 74, confidence: 'high', reason: 'habit/news-cycle pressure keeps the phrase live' }],
    { by_word: new Map([['affordability', { n: 5, yes: 3 }]]) },
  );
  assert.equal(rows[0].proof_reason, 'no evidence / no mention in the provided results');
  assert.equal(rows[0].handicap_reason, 'habit/news-cycle pressure keeps the phrase live');
  assert.equal(rows[0].reason, 'habit/news-cycle pressure keeps the phrase live');
  assert.ok(!/no evidence|no mention/i.test(rows[0].reason), 'rendered reason must not assert no evidence on a YES-leaning blend');
});

test('buildResearchTermNote derives settlement fit from 2-term slash bundles and repeat requirements', () => {
  const note = buildResearchTermNote({
    phrase: 'Afford / Affordable (N+ times)',
    reason: 'habit/news-cycle pressure',
    kalshiNativePct: 50,
    kalshiNativeN: 2,
    proofPct: 10,
    handicapPct: 72,
    requiredCount: 3,
  });
  assert.ok(note, 'research note should be built from usable research');
  assert.match(note.catalyst, /habit\/news-cycle pressure/);
  assert.match(note.catalyst, /historically YES in 1\/2 comparable events/);
  assert.match(note.settlement_fit, /either exact token "Afford" or "Affordable"/);
  assert.match(note.settlement_fit, /Requires 3 or more qualifying mentions, not just one\./);
  assert.match(note.provenance, /comparable_event_history: source=kalshi_native n=2 yes=1 hit_rate=0\.50/);
});

test('buildResearchTermNote renders every variant in 3-term slash bundles', () => {
  const note = buildResearchTermNote({
    phrase: 'Endorse / Endorsed / Endorsement',
    reason: 'campaign language keeps the endorsement family active',
    kalshiNativePct: 67,
    kalshiNativeN: 3,
    proofPct: 25,
    handicapPct: 71,
    speaker: 'Trump',
  });
  assert.ok(note, 'research note should be built from usable research');
  assert.match(note.settlement_fit, /"Endorse"/);
  assert.match(note.settlement_fit, /"Endorsed"/);
  assert.match(note.settlement_fit, /"Endorsement"/);
  assert.match(note.settlement_fit, /any of "Endorse", "Endorsed", or "Endorsement"/);

  const afford = buildResearchTermNote({
    phrase: 'Afford / Affordable / Affordability',
    reason: 'housing affordability framing is live',
    proofPct: 62,
    handicapPct: 67,
    speaker: 'Trump',
  });
  assert.match(afford.settlement_fit, /"Afford"/);
  assert.match(afford.settlement_fit, /"Affordable"/);
  assert.match(afford.settlement_fit, /"Affordability"/);

  const cheat = buildResearchTermNote({
    phrase: 'Cheat / Cheater / Cheating',
    reason: 'election-integrity language is live',
    proofPct: 58,
    handicapPct: 64,
    speaker: 'Trump',
  });
  assert.match(cheat.settlement_fit, /"Cheat"/);
  assert.match(cheat.settlement_fit, /"Cheater"/);
  assert.match(cheat.settlement_fit, /"Cheating"/);
});

test('threshold research prompt carries required_count and repeat-count context', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pplx-threshold-'));
  const event = {
    event_ticker: 'KXTHRESH-26JUN12',
    series_ticker: 'KXTHRESH',
    title: 'What will Trump say during the press portion?',
    markets: [
      {
        ticker: 'KXTHRESH-26JUN12-TARIFF',
        title: 'Will Trump say tariff 3+ times?',
        yes_sub_title: 'tariff',
        custom_strike: 'tariff',
        rules_primary: 'Resolves YES if Trump says tariff 3+ times during the press portion.',
      },
    ],
  };
  const prompts = [];
  const res = await runResearchForEvent({
    event,
    date: DATE,
    stateRoot: root,
    env: { PERPLEXITY_API_KEY: 'test-key' },
    fetcherImpl: async () => ({ ok: true, json: { events: [], cursor: null } }),
    perplexityImpl: async ({ messages }) => {
      prompts.push(messages.map((m) => m.content).join('\n'));
      return {
        content: JSON.stringify([
          { phrase: 'tariff', likelihood_pct: 11, confidence: 'low', reason: 'single mention only' },
        ]),
        citations: [],
      };
    },
  });
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /count threshold: estimate probability the token is said at least 3 times/);
  assert.match(prompts[0], /keep the repeat-count threshold in view/i);
  assert.equal(res.rows[0].required_count, 3);
  assert.equal(res.rows[0].market_type, 'threshold_count');
  assert.equal(res.rows[0].repeat_requirement, '3+ times');
});

test('source extraction batches by source document, not per term (1 model call for N terms)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'src-research-'));
  let modelCalls = 0;
  const chatRunner = async (prompt) => {
    modelCalls += 1;
    // single prompt must carry ALL terms
    for (const t of TERMS) assert.ok(prompt.includes(t), `prompt batches term ${t}`);
    return { ok: true, parsed: goodExtraction(), status: 0 };
  };
  const res = await runBoundedSourceResearch({
    eventTitle: 'Hunter Biden podcast', eventTicker: 'X', profile: 'political_mentions',
    terms: TERMS, sources: ['https://example.com/transcript'],
    stateRoot: root, date: DATE, env: {}, fetchImpl: fakeFetch(), chatRunner,
  });
  assert.equal(modelCalls, 1, 'one cheap call per source document, regardless of term count');
  assert.equal(res.stats.model_calls, 1);
  assert.equal(res.stats.terms_batched_per_call, 3);
  assert.equal(res.quality, 'source_backed');
  assert.equal(res.byTerm['China / Chinese'].direct_mention_pathway.score, 72);
});

test('source cache prevents repeat fetches (second run = cache hit, zero network)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'src-cache-'));
  const counter = { calls: 0 };
  const fetchImpl = fakeFetch('some text', counter);
  const url = 'https://example.com/page';
  const first = await fetchSourceDocument({ url, stateRoot: root, date: DATE, env: {}, fetchImpl });
  const second = await fetchSourceDocument({ url, stateRoot: root, date: DATE, env: {}, fetchImpl });
  const cached = JSON.parse(readFileSync(cachePathForUrl(root, DATE, url), 'utf8'));
  assert.equal(counter.calls, 1, 'network fetched exactly once');
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.text, 'some text');
  assert.equal(second.source_health.provider, 'cache');
  assert.equal(second.source_health.from_cache, true);
  assert.equal(second.source_health.cache_only, true);
  assert.equal(second.source_health.disclosure_required, true);
  const cachedAt = new Date(cached.fetched_at_utc).getTime();
  const generatedAt = new Date(second.source_health.generated_utc).getTime();
  const firstGeneratedAt = new Date(first.source_health.generated_utc).getTime();
  assert.ok(Number.isFinite(cachedAt) && Number.isFinite(generatedAt));
  assert.ok(Number.isFinite(firstGeneratedAt));
  assert.ok(Math.abs(generatedAt - cachedAt) <= 5, 'cache timestamp should match within a few milliseconds');
  assert.ok(Math.abs(firstGeneratedAt - generatedAt) <= 5, 'first and second fetches should share the same cache timestamp within a few milliseconds');
  assert.ok(cachePathForUrl(root, DATE, url).includes('research-cache'));
});

test('403 normal fetch triggers bounded browser/Firecrawl fallback and caches fetched text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'src-browser-ok-'));
  const url = 'https://www.governor.ny.gov/';
  let normalFetches = 0;
  let fallbackFetches = 0;
  const doc = await fetchSourceDocument({
    url, stateRoot: root, date: DATE, env: {},
    fetchImpl: async () => { normalFetches += 1; return { ok: false, status: 403, text: async () => 'Forbidden' }; },
    fallbackFetchImpl: async ({ url: fallbackUrl }) => {
      fallbackFetches += 1;
      assert.equal(fallbackUrl, url, 'fallback receives the exact declared URL only');
      return { ok: true, text: 'Governor transcript: affordability and New York families', timedOut: false, error: null };
    },
  });
  assert.equal(normalFetches, 1, 'normal fetch remains first path');
  assert.equal(fallbackFetches, 1, '403 triggers exactly one fallback page fetch');
  assert.equal(doc.source_status, SOURCE_FETCH_STATUS.SOURCE_FETCHED_BROWSER);
  assert.equal(doc.fetch_method, 'firecrawl');
  assert.equal(doc.text.includes('affordability'), true);
  const cached = JSON.parse(readFileSync(cachePathForUrl(root, DATE, url), 'utf8'));
  assert.equal(cached.source_status, SOURCE_FETCH_STATUS.SOURCE_FETCHED_BROWSER);
  assert.equal(cached.fetch_method, 'firecrawl');
});

test('Firecrawl 402 marks credits exhausted and does not loop retries', async () => {
  const { execFileImpl, getCalls } = makeExecFileSequence([
    { stderr: '402 Payment Required: insufficient credits' },
  ]);
  const res = await firecrawlCliFetch({
    url: 'https://example.com/transcript',
    env: {},
    execFileImpl,
    sleepImpl: async () => {},
    maxRetries: 4,
  });
  assert.equal(getCalls(), 1, '402 is fail-closed immediately');
  assert.equal(res.ok, false);
  assert.equal(res.error_code, 'FETCH_CREDIT_EXHAUSTED');
  assert.equal(res.status, 'exhausted');
  assert.equal(res.retry_count, 0);
  assert.equal(res.attempts.length, 1);
});

test('Firecrawl 429 retries with backoff before manual fallback succeeds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'src-fc-429-'));
  const sleepCalls = [];
  const { execFileImpl, getCalls } = makeExecFileSequence([
    { stderr: '429 Too Many Requests\nRetry-After: 0.01' },
    { stderr: '429 Too Many Requests\nRetry-After: 0.01' },
    { stderr: '429 Too Many Requests\nRetry-After: 0.01' },
  ]);
  const doc = await fetchSourceDocument({
    url: 'https://official.gov/transcript',
    stateRoot: root,
    date: DATE,
    env: {},
    fetchImpl: statusFetch(403),
    fallbackFetchImpl: async ({ url }) => firecrawlCliFetch({
      url,
      env: {},
      execFileImpl,
      sleepImpl: async (ms) => { sleepCalls.push(ms); },
      maxRetries: 2,
    }),
    manualFallbackImpl: async ({ url }) => ({
      ok: true,
      text: `manual browser transcript for ${url}`,
      timedOut: false,
      error: null,
    }),
    sleepImpl: async () => {},
  });
  assert.equal(getCalls(), 3, '429 firecrawl retry budget is capped');
  assert.equal(sleepCalls.length, 2, 'backoff happens between retry attempts');
  assert.equal(doc.fetch_method, 'manual');
  assert.equal(doc.source_status, SOURCE_FETCH_STATUS.SOURCE_FETCHED_BROWSER);
  assert.equal(doc.source_health.provider, 'browser_manual');
  assert.equal(doc.source_health.fallback_used, true);
  assert.equal(doc.source_health.disclosure_required, false);
  assert.equal(doc.source_health.attempts.some((attempt) => attempt.error_code === 'FETCH_RATE_LIMITED'), true);
  assert.equal(readFileSync(doc.source_health_path, 'utf8').includes('browser_manual'), true);
});

test('5xx failures cap retries and then fall back cleanly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'src-5xx-'));
  let directCalls = 0;
  let fallbackCalls = 0;
  const doc = await fetchSourceDocument({
    url: 'https://official.gov/transcript',
    stateRoot: root,
    date: DATE,
    env: { MENTIONS_RESEARCH_PROVIDER_MAX_RETRIES: '1' },
    fetchImpl: async () => {
      directCalls += 1;
      return { ok: false, status: 503, text: async () => 'service unavailable' };
    },
    fallbackFetchImpl: async () => {
      fallbackCalls += 1;
      return { ok: false, text: null, timedOut: false, error: 'fallback exhausted' };
    },
    sleepImpl: async () => {},
  });
  assert.equal(directCalls, 2, '503 retries are capped');
  assert.equal(fallbackCalls, 1, '503 falls through to fallback once');
  assert.equal(doc.text, null);
  assert.equal(doc.source_health.error_code, 'FETCH_PROVIDER_EXHAUSTED');
  assert.equal(doc.source_health.provider, 'firecrawl');
  assert.equal(doc.source_health.attempts.filter((attempt) => attempt.provider === 'direct').length, 2);
});

test('cache hits require disclosure and keep source health explicit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'src-cache-disclose-'));
  const url = 'https://example.com/cache-only';
  const first = await fetchSourceDocument({
    url,
    stateRoot: root,
    date: DATE,
    env: {},
    fetchImpl: fakeFetch('cache-disclosed source text'),
  });
  const second = await fetchSourceDocument({
    url,
    stateRoot: root,
    date: DATE,
    env: {},
    fetchImpl: fakeFetch('should not be used'),
  });
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.source_health.provider, 'cache');
  assert.equal(second.source_health.disclosure_required, true);
  assert.equal(second.source_health.text_cached, true);
  assert.equal(second.source_health.from_cache, true);
  assert.equal(second.source_health.cache_only, true);
  assert.equal(second.source_health.attempts[0].cache_status, 'hit');
  assert.equal(second.source_health_path, sourceHealthPathForUrl(root, DATE, url));
});

test('all providers failing yields no_source and keeps the required layer fail-closed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'src-all-fail-'));
  const res = await runBoundedSourceResearch({
    eventTitle: 'Official transcript',
    eventTicker: 'KXFAIL',
    profile: 'political_mentions',
    terms: ['Affordability'],
    sources: ['https://official.gov/transcript'],
    stateRoot: root,
    date: DATE,
    env: { MENTIONS_RESEARCH_PROVIDER_MAX_RETRIES: '0' },
    fetchImpl: async () => ({ ok: false, status: 503, text: async () => 'service unavailable' }),
    fallbackFetchImpl: async () => ({ ok: false, text: null, timedOut: false, error: 'fallback exhausted' }),
    sleepImpl: async () => {},
  });
  assert.equal(res.quality, 'no_source');
  assert.deepEqual(res.byTerm, {});
  assert.ok(res.notes.some((n) => n.includes('source unavailable')));
});

test('optional source research failure is caught and packet assembly keeps going', async () => {
  const root = mkdtempSync(join(tmpdir(), 'src-optional-fail-'));
  const event = {
    event_ticker: 'KXOPT-26JUN12',
    title: 'What will Governor Hochul say during the announcement?',
    markets: [
      { ticker: 'KXOPT-26JUN12-FOO', custom_strike: { Word: 'Affordability' }, close_time: '2026-06-12T22:00:00Z' },
    ],
  };
  const research = await buildEventResearch(event, 'political_mentions', {
    stateRoot: root,
    date: DATE,
    env: {},
    deps: {
      loadDeclaredSources: () => ['https://official.gov/transcript'],
      runBoundedSourceResearch: async () => { throw new Error('provider chain exploded'); },
    },
  });
  assert.equal(research.markets.length, 1);
  assert.equal(research.markets[0].research_quality, 'stub');
  assert.equal(research.source_status, 'DECLARED');
  assert.ok(research.source_research_stats);
});

test('successful browser fallback populates source_research_stats and extracted layer evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'src-browser-stats-'));
  const res = await runBoundedSourceResearch({
    eventTitle: 'Governor Kathy Hochul announcement', eventTicker: 'KXH', profile: 'political_mentions',
    terms: ['Affordability'], sources: ['https://www.governor.ny.gov/'],
    stateRoot: root, date: DATE, env: {},
    fetchImpl: statusFetch(403),
    fallbackFetchImpl: async () => ({ ok: true, text: 'Governor said affordability in prepared remarks', timedOut: false, error: null }),
    chatRunner: async () => ({
      ok: true, status: 0,
      parsed: { terms: [{ term: 'Affordability', layers: { direct_mention_pathway: { present: true, score: 77, basis: '"affordability" in remarks' } } }] },
    }),
  });
  assert.equal(res.source_status, SOURCE_FETCH_STATUS.SOURCE_FETCHED_BROWSER);
  assert.equal(res.stats.source_status, SOURCE_FETCH_STATUS.SOURCE_FETCHED_BROWSER);
  assert.equal(res.stats.fallback_attempts, 1);
  assert.equal(res.stats.fetched_browser, 1);
  assert.equal(res.quality, 'source_backed');
  assert.equal(res.byTerm.Affordability.direct_mention_pathway.score, 77);
  assert.equal(readdirSync(join(root, 'mentions', DATE, 'research-cache')).length, 1, 'browser text cached');
});

test('failed browser fallback marks SOURCE_FETCH_BLOCKED_BY_SITE and fabricates no evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'src-browser-block-'));
  let modelCalls = 0;
  const res = await runBoundedSourceResearch({
    eventTitle: 'Governor Kathy Hochul announcement', eventTicker: 'KXH', profile: 'political_mentions',
    terms: ['Affordability'], sources: ['https://www.governor.ny.gov/'],
    stateRoot: root, date: DATE, env: {},
    fetchImpl: statusFetch(403),
    fallbackFetchImpl: async () => ({ ok: false, text: null, timedOut: false, error: 'firecrawl returned access denied' }),
    chatRunner: async () => { modelCalls += 1; return { ok: true, parsed: { terms: [] }, status: 0 }; },
  });
  assert.equal(res.source_status, SOURCE_FETCH_STATUS.SOURCE_FETCH_BLOCKED_BY_SITE);
  assert.equal(res.stats.blocked_by_site, 1);
  assert.equal(res.quality, 'no_source');
  assert.deepEqual(res.byTerm, {});
  assert.equal(modelCalls, 0, 'extraction only runs on fetched/cached text');
  assert.ok(res.notes.some((n) => n.includes('firecrawl returned access denied')));
});

test('browser fallback never crawls extra links from fetched page', async () => {
  const root = mkdtempSync(join(tmpdir(), 'src-browser-one-page-'));
  const calls = [];
  const res = await runBoundedSourceResearch({
    eventTitle: 'E', eventTicker: 'X', profile: 'political_mentions', terms: TERMS,
    sources: ['https://official.gov/start'], stateRoot: root, date: DATE, env: {},
    fetchImpl: statusFetch(429),
    fallbackFetchImpl: async ({ url }) => {
      calls.push(url);
      return { ok: true, text: 'transcript body with link https://official.gov/next and China', timedOut: false, error: null };
    },
    chatRunner: async () => ({ ok: true, parsed: goodExtraction(), status: 0 }),
  });
  assert.deepEqual(calls, ['https://official.gov/start']);
  assert.equal(res.stats.fallback_attempts, 1);
  assert.equal(res.stats.sources_used, 1);
});

test('market/price URLs are rejected before normal fetch or fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'src-market-reject-'));
  mkdirSync(join(root, 'mentions', DATE, 'sources'), { recursive: true });
  writeFileSync(join(root, 'mentions', DATE, 'sources', 'KXPRICE.json'), JSON.stringify({
    urls: ['https://kalshi.com/events/KXPRICE', 'https://www.governor.ny.gov/'],
  }));
  assert.deepEqual(loadDeclaredSources(root, DATE, 'KXPRICE', {}), ['https://www.governor.ny.gov/']);
  let normal = 0;
  let fallback = 0;
  const doc = await fetchSourceDocument({
    url: 'https://kalshi.com/events/KXPRICE', stateRoot: root, date: DATE, env: {},
    fetchImpl: async () => { normal += 1; return { ok: true, status: 200, text: async () => 'market page' }; },
    fallbackFetchImpl: async () => { fallback += 1; return { ok: true, text: 'x' }; },
  });
  assert.equal(doc.rejected, true);
  assert.equal(normal, 0);
  assert.equal(fallback, 0);
});

test('source fetching is bounded: declared list capped, non-http rejected, bytes truncated', async () => {
  const root = mkdtempSync(join(tmpdir(), 'src-bound-'));
  assert.equal(maxSources({}), 3);
  assert.equal(maxSources({ MENTIONS_RESEARCH_MAX_SOURCES: '50' }), 10, 'hard ceiling even via env');
  const many = Array.from({ length: 9 }, (_, i) => `https://example.com/${i}`);
  const counter = { calls: 0 };
  const res = await runBoundedSourceResearch({
    eventTitle: 'E', eventTicker: 'X', profile: 'political_mentions', terms: TERMS,
    sources: many, stateRoot: root, date: DATE, env: {},
    fetchImpl: fakeFetch('t', counter), chatRunner: async () => ({ ok: true, parsed: goodExtraction(), status: 0 }),
  });
  assert.equal(res.stats.sources_used, 3);
  assert.equal(counter.calls, 3, 'never fetches beyond the cap');
  const bad = await fetchSourceDocument({ url: 'file:///etc/passwd', stateRoot: root, date: DATE, env: {} });
  assert.equal(bad.text, null);
  const big = await fetchSourceDocument({ url: 'https://example.com/big', stateRoot: root, date: DATE, env: { MENTIONS_RESEARCH_MAX_SOURCE_BYTES: '10' }, fetchImpl: fakeFetch('x'.repeat(1000)) });
  assert.equal(big.text.length, 10, 'source text truncated to byte cap');
});

test('invalid/missing extraction JSON fails closed: no layers merged, quality no_source, gaps explained', async () => {
  const root = mkdtempSync(join(tmpdir(), 'src-fail-'));
  for (const bad of [null, 'prose', { terms: 'nope' }, []]) {
    const v = validateExtractionJson(bad, TERMS);
    assert.equal(v.ok, false);
    assert.deepEqual(v.byTerm, {});
  }
  const res = await runBoundedSourceResearch({
    eventTitle: 'E', eventTicker: 'X', profile: 'political_mentions', terms: TERMS,
    sources: ['https://example.com/a'], stateRoot: root, date: DATE, env: {},
    fetchImpl: fakeFetch(), chatRunner: async () => ({ ok: true, parsed: { not: 'terms' }, status: 0 }),
  });
  assert.equal(res.quality, 'no_source');
  assert.deepEqual(res.byTerm, {});
  assert.ok(res.notes.some((n) => n.includes('failed closed')));
  assert.ok(res.notes.some((n) => n.includes('no_source')));
});

test('extraction rejects pricing-shaped fields, unknown layers, missing basis, out-of-range scores', () => {
  const v = validateExtractionJson({
    terms: [{
      term: 'Epstein',
      layers: {
        direct_mention_pathway: { present: true, score: 70, basis: 'quoted', yes_ask: 12 },
        made_up_layer: { present: true, score: 50, basis: 'x' },
        historical_tendency: { present: true, score: 150, basis: 'x' },
        storyline_relevance: { present: true, score: 60 },
        baseline_relevance: { present: true, score: 55, basis: 'discussed repeatedly in prior pods' },
      },
    }],
  }, TERMS);
  assert.equal(v.ok, false);
  assert.deepEqual(Object.keys(v.byTerm.Epstein), ['baseline_relevance'], 'only the clean record survives');
  assert.ok(v.errors.some((e) => e.includes('pricing-shaped')));
});

test('mergeExtractedLayers fills gaps but never overwrites adapter evidence; market price cannot enter via merge', () => {
  const base = {
    event_proximity: { present: true, score: 98, source_basis: 'schedule' },
    direct_mention_pathway: { present: false, score: null, missing_note: 'none' },
  };
  const merged = mergeExtractedLayers(base, {
    event_proximity: { score: 10, basis: 'should not win' }, // not an EVIDENCE_LAYER -> ignored
    direct_mention_pathway: { score: 72, basis: 'verbatim quote' },
  });
  assert.equal(merged.event_proximity.score, 98, 'adapter evidence untouched');
  assert.equal(merged.direct_mention_pathway.present, true);
  assert.equal(merged.direct_mention_pathway.score, 72);
  for (const rec of Object.values(merged)) {
    for (const k of ['price', 'yes_bid', 'yes_ask', 'volume']) assert.equal(k in rec, false);
  }
  assert.ok(EVIDENCE_LAYERS.includes('direct_mention_pathway'));
});

test('collector end-to-end: declared sources upgrade stub research to source_backed via one batch call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'collector-'));
  mkdirSync(join(root, 'mentions', DATE, 'sources'), { recursive: true });
  writeFileSync(join(root, 'mentions', DATE, 'sources', 'KXTEST-26JUN12.json'), JSON.stringify({ urls: ['https://example.com/transcript'] }));
  const event = {
    event_ticker: 'KXTEST-26JUN12',
    title: 'What will Hunter Biden say during the podcast?',
    markets: [
      { ticker: 'KXTEST-26JUN12-CHIN', custom_strike: { Word: 'China / Chinese' }, close_time: '2026-06-12T22:00:00Z' },
      { ticker: 'KXTEST-26JUN12-EPST', custom_strike: { Word: 'Epstein' }, close_time: '2026-06-12T22:00:00Z' },
      { ticker: 'KXTEST-26JUN12-PARD', custom_strike: { Word: 'Pardon / Pardoned' }, close_time: '2026-06-12T22:00:00Z' },
    ],
  };
  let modelCalls = 0;
  const research = await buildEventResearch(event, 'political_mentions', {
    stateRoot: root, date: DATE, env: {},
    deps: {
      fetchImpl: fakeFetch(),
      chatRunner: async () => { modelCalls += 1; return { ok: true, parsed: goodExtraction(), status: 0 }; },
    },
  });
  assert.equal(modelCalls, 1, 'one batch call for the whole 3-market event');
  const china = research.markets.find((m) => m.keyword === 'China / Chinese');
  assert.equal(china.research_quality, 'source_backed');
  assert.equal(china.layer_records.direct_mention_pathway.present, true);
  assert.equal(china.layer_records.event_proximity.present, true, 'stub schedule layer retained');
  const epstein = research.markets.find((m) => m.keyword === 'Epstein');
  assert.equal(epstein.research_quality, 'no_source', 'terms with no extracted evidence are explained, not invented');
  assert.ok(readdirSync(join(root, 'mentions', DATE, 'research-cache')).length === 1, 'fetched page cached');
});

test('Gemini cheap extraction uses the same strict schema and is preferred (no fallback when valid)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'src-gem-'));
  const tiersCalled = [];
  const chatRunner = async (prompt, opts) => {
    tiersCalled.push(`${opts.provider}/${opts.model}`);
    for (const t of TERMS) assert.ok(prompt.includes(t), 'same batched schema prompt');
    return { ok: true, parsed: goodExtraction(), status: 0 };
  };
  const res = await runBoundedSourceResearch({
    eventTitle: 'E', eventTicker: 'X', profile: 'political_mentions', terms: TERMS,
    sources: ['https://example.com/a'], stateRoot: root, date: DATE, env: {},
    fetchImpl: fakeFetch(), chatRunner,
  });
  assert.deepEqual(tiersCalled, ['gemini/gemini-3.5-flash'], 'Gemini preferred; no fallback fired');
  assert.deepEqual(res.stats.extraction_tiers, ['cheap']);
  assert.equal(res.stats.fallback_calls, 0);
  assert.equal(res.quality, 'source_backed');
});

test('Gemini schema failure falls back to gpt-5.4-mini; total failure fails closed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'src-fb-'));
  // Gemini returns unstable JSON, mini succeeds
  let order = [];
  const res = await runBoundedSourceResearch({
    eventTitle: 'E', eventTicker: 'X', profile: 'political_mentions', terms: TERMS,
    sources: ['https://example.com/a'], stateRoot: root, date: DATE, env: {},
    fetchImpl: fakeFetch(),
    chatRunner: async (_p, opts) => {
      order.push(opts.model);
      if (opts.model === 'gemini-3.5-flash') return { ok: true, parsed: { terms: 'unstable' }, status: 0 };
      return { ok: true, parsed: goodExtraction(), status: 0 };
    },
  });
  assert.deepEqual(order, ['gemini-3.5-flash', 'gpt-5.4-mini']);
  assert.equal(res.stats.fallback_calls, 1);
  assert.deepEqual(res.stats.extraction_tiers, ['cheap_fallback']);
  assert.equal(res.quality, 'source_backed', 'fallback evidence merged');
  // both tiers fail -> closed, deterministic no_source
  const res2 = await runBoundedSourceResearch({
    eventTitle: 'E', eventTicker: 'X', profile: 'political_mentions', terms: TERMS,
    sources: ['https://example.com/b'], stateRoot: root, date: DATE, env: {},
    fetchImpl: fakeFetch(), chatRunner: async () => ({ ok: true, parsed: 'garbage', status: 0 }),
  });
  assert.equal(res2.quality, 'no_source');
  assert.deepEqual(res2.byTerm, {});
  assert.ok(res2.notes.some((n) => n.includes('failed closed')));
});

test('neither cheap model can assign CPC score/posture/price: extraction yields layer evidence only', async () => {
  const hostile = {
    terms: [{
      term: 'Epstein',
      cpc_score: 99, posture: 'PICK', price: 50,
      layers: {
        baseline_relevance: { present: true, score: 55, basis: 'legit basis' },
        direct_mention_pathway: { present: true, score: 70, basis: 'quote', cpc_score: 99, posture: 'PICK' },
      },
    }],
  };
  const v = validateExtractionJson(hostile, TERMS);
  // layer-level extra fields are not copied: output shape is fixed {present,score,basis}
  for (const rec of Object.values(v.byTerm.Epstein)) {
    assert.deepEqual(Object.keys(rec).sort(), ['basis', 'present', 'score']);
  }
  assert.equal('cpc_score' in v.byTerm.Epstein, false);
  // and merged records carry no posture/cpc/price either
  const merged = mergeExtractedLayers({}, v.byTerm.Epstein);
  for (const rec of Object.values(merged)) {
    for (const k of ['cpc_score', 'posture', 'price']) assert.equal(k in rec, false);
  }
});

test('no declared sources -> zero fetches, zero model calls, stub quality with deterministic note', async () => {
  const root = mkdtempSync(join(tmpdir(), 'src-none-'));
  assert.deepEqual(loadDeclaredSources(root, DATE, 'KXNONE', {}), []);
  let calls = 0;
  const res = await runBoundedSourceResearch({
    eventTitle: 'E', eventTicker: 'X', profile: 'political_mentions', terms: TERMS,
    sources: [], stateRoot: root, date: DATE, env: {},
    fetchImpl: async () => { calls += 1; }, chatRunner: async () => { calls += 1; },
  });
  assert.equal(calls, 0);
  assert.equal(res.quality, 'stub');
  assert.ok(res.notes.some((n) => n.includes('no sources declared')));
});
