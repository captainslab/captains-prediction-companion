// Bounded source research for mentions events.
//
// Acquires a SMALL, explicit set of source documents (declared URLs only —
// never crawling), caches them by URL hash under
// state/mentions/<date>/research-cache/, and runs ONE cheap-tier
// (gpt-5.4-mini) batch extraction per source document covering ALL event
// terms in a single strict-JSON call. Cost scales with source documents,
// never with contract count.
//
// Hard bounds:
//   * sources per event capped (MENTIONS_RESEARCH_MAX_SOURCES, default 3)
//   * bytes per source capped (MENTIONS_RESEARCH_MAX_SOURCE_BYTES, default 120000)
//   * one model call per source document, cheap tier only
//   * cache hit -> zero network fetch
//
// Models return strict JSON evidence fields only. Invalid/missing extraction
// JSON fails closed: no layers merge, research_quality stays stub/no_source,
// and the gaps are explained deterministically. Pricing fields are rejected
// from extracted records (mention-composite-core would throw on them anyway).

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runCheapExtractionJson } from './model-router.mjs';

export const EVIDENCE_LAYERS = Object.freeze([
  'baseline_relevance',
  'source_velocity',
  'direct_mention_pathway',
  'historical_tendency',
  'storyline_relevance',
]);

export const DEFAULT_MAX_SOURCES = 3;
export const DEFAULT_MAX_FALLBACK_PAGES = 3;
export const DEFAULT_MAX_SOURCE_BYTES = 120_000;
export const DEFAULT_FETCH_TIMEOUT_MS = 20_000;
export const DEFAULT_BROWSER_FETCH_TIMEOUT_MS = 30_000;

export const SOURCE_FETCH_STATUS = Object.freeze({
  SOURCE_FETCHED: 'SOURCE_FETCHED',
  SOURCE_FETCHED_BROWSER: 'SOURCE_FETCHED_BROWSER',
  SOURCE_FETCH_BLOCKED_BY_SITE: 'SOURCE_FETCH_BLOCKED_BY_SITE',
  SOURCE_FETCH_TIMEOUT: 'SOURCE_FETCH_TIMEOUT',
});

const FORBIDDEN_KEYS = ['price', 'bid', 'ask', 'odds', 'volume', 'open_interest', 'yes_bid', 'yes_ask'];
const PRICE_HOST_PATTERNS = [
  /(^|\.)kalshi\.com$/i,
  /(^|\.)polymarket\.com$/i,
  /(^|\.)predictit\.org$/i,
  /(^|\.)manifold\.markets$/i,
  /(^|\.)betfair\./i,
  /(^|\.)draftkings\.com$/i,
  /(^|\.)fanduel\.com$/i,
  /(^|\.)oddschecker\./i,
  /(^|\.)bovada\./i,
];
const BOT_BLOCK_PATTERNS = [
  /\baccess denied\b/i,
  /\bforbidden\b/i,
  /\brequest blocked\b/i,
  /\bblocked by\b/i,
  /\bbot detection\b/i,
  /\bcloudflare\b/i,
  /\bakamai\b/i,
  /\bincapsula\b/i,
  /\bperimeterx\b/i,
  /\bdatadome\b/i,
  /\bcaptcha\b/i,
  /\bverify you are human\b/i,
  /\bjust a moment\b/i,
  /\benable javascript and cookies\b/i,
];

export function maxSources(env = process.env) {
  const n = Number(env.MENTIONS_RESEARCH_MAX_SOURCES);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10) : DEFAULT_MAX_SOURCES;
}

export function maxFallbackPages(env = process.env) {
  const n = Number(env.MENTIONS_RESEARCH_MAX_FALLBACK_PAGES ?? env.MENTIONS_RESEARCH_MAX_SOURCES);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10) : DEFAULT_MAX_FALLBACK_PAGES;
}

export function maxSourceBytes(env = process.env) {
  const n = Number(env.MENTIONS_RESEARCH_MAX_SOURCE_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_SOURCE_BYTES;
}

export function isMarketLikeUrl(url) {
  let host;
  try {
    host = new URL(String(url)).hostname;
  } catch {
    return true;
  }
  return PRICE_HOST_PATTERNS.some((re) => re.test(host));
}

export function classifySourceText(text) {
  const raw = String(text ?? '');
  const compact = raw.replace(/\s+/g, ' ').trim();
  if (!compact) return { useful: false, reason: 'empty_body', fallbackEligible: true };
  if (!/[A-Za-z0-9]/.test(compact)) return { useful: false, reason: 'useless_body', fallbackEligible: true };
  if (BOT_BLOCK_PATTERNS.some((re) => re.test(compact))) {
    return { useful: false, reason: 'bot_or_edge_block_body', fallbackEligible: true };
  }
  return { useful: true, reason: null, fallbackEligible: false };
}

function isTimeoutError(err) {
  const name = String(err?.name ?? '');
  const code = String(err?.code ?? '');
  const message = String(err?.message ?? '');
  return name === 'TimeoutError'
    || name === 'AbortError'
    || code === 'ETIMEDOUT'
    || code === 'ABORT_ERR'
    || /timed?\s*out|timeout/i.test(message);
}

function statusFromCacheHit(hit) {
  if (hit?.source_status === SOURCE_FETCH_STATUS.SOURCE_FETCHED_BROWSER || hit?.fetch_method === 'firecrawl') {
    return SOURCE_FETCH_STATUS.SOURCE_FETCHED_BROWSER;
  }
  if (hit?.source_status === SOURCE_FETCH_STATUS.SOURCE_FETCHED) return SOURCE_FETCH_STATUS.SOURCE_FETCHED;
  return SOURCE_FETCH_STATUS.SOURCE_FETCHED;
}

function stripAnsi(text) {
  return String(text ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function extractFirecrawlText(stdout) {
  const raw = stripAnsi(stdout).trim();
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.markdown === 'string') return parsed.markdown;
    if (typeof parsed?.data?.markdown === 'string') return parsed.data.markdown;
    if (typeof parsed?.content === 'string') return parsed.content;
  } catch {
    // CLI markdown output is plain text by default.
  }
  return raw;
}

export async function firecrawlCliFetch({ url, env = process.env, timeoutMs = DEFAULT_BROWSER_FETCH_TIMEOUT_MS } = {}) {
  const command = env.MENTIONS_RESEARCH_FIRECRAWL_COMMAND || env.FIRECRAWL_COMMAND || 'firecrawl';
  const args = [
    'scrape',
    url,
    '--only-main-content',
    '--format',
    'markdown',
  ];
  if (env.MENTIONS_RESEARCH_FIRECRAWL_WAIT_MS) {
    args.push('--wait-for', String(env.MENTIONS_RESEARCH_FIRECRAWL_WAIT_MS));
  }
  if (env.MENTIONS_RESEARCH_FIRECRAWL_PROXY) {
    args.push('--proxy', String(env.MENTIONS_RESEARCH_FIRECRAWL_PROXY));
  }

  return await new Promise((resolvePromise) => {
    execFile(command, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: maxSourceBytes(env) + 64_000,
      env: { ...process.env, ...env },
    }, (err, stdout, stderr) => {
      if (err) {
        const timedOut = err.killed || isTimeoutError(err);
        resolvePromise({
          ok: false,
          text: null,
          timedOut,
          error: `firecrawl scrape failed: ${timedOut ? 'timeout' : (stderr || err.message || 'unknown').trim()}`,
        });
        return;
      }
      const text = extractFirecrawlText(stdout).slice(0, maxSourceBytes(env));
      const classified = classifySourceText(text);
      if (!classified.useful) {
        resolvePromise({ ok: false, text: null, timedOut: false, error: `firecrawl returned ${classified.reason}` });
        return;
      }
      resolvePromise({ ok: true, text, timedOut: false, error: null });
    });
  });
}

function shouldUseBrowserFallback(fetchOutcome) {
  if (!fetchOutcome) return false;
  if (fetchOutcome.timeout) return true;
  if ([401, 403, 429].includes(Number(fetchOutcome.status))) return true;
  if (fetchOutcome.bodyClass?.fallbackEligible) return true;
  return false;
}

function writeCache({ stateRoot, date, url, rawText, text, fetchMethod, sourceStatus, env }) {
  mkdirSync(cacheDir(stateRoot, date), { recursive: true });
  writeFileSync(cachePathForUrl(stateRoot, date, url), JSON.stringify({
    url,
    fetched_at_utc: new Date().toISOString(),
    fetch_method: fetchMethod,
    source_status: sourceStatus,
    truncated: String(rawText ?? '').length > String(text ?? '').length,
    text,
  }, null, 0));
}

// ─── cache (by URL hash) ─────────────────────────────────────────────────────

export function cacheKeyForUrl(url) {
  return createHash('sha256').update(String(url)).digest('hex').slice(0, 32);
}

export function cacheDir(stateRoot, date) {
  return resolve(stateRoot, 'mentions', date, 'research-cache');
}

export function cachePathForUrl(stateRoot, date, url) {
  return resolve(cacheDir(stateRoot, date), `${cacheKeyForUrl(url)}.json`);
}

/**
 * Fetch one declared source document, cache-first. Never crawls; one URL in,
 * at most one network request out, truncated to the byte cap.
 */
export async function fetchSourceDocument({
  url,
  stateRoot,
  date,
  env = process.env,
  fetchImpl = globalThis.fetch,
  fallbackFetchImpl = firecrawlCliFetch,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  browserTimeoutMs = DEFAULT_BROWSER_FETCH_TIMEOUT_MS,
  allowFallback = true,
} = {}) {
  if (!url || !/^https?:\/\//i.test(String(url))) {
    return { url, text: null, cached: false, source_status: null, fetch_method: null, error: 'invalid or non-http url (declared sources only)' };
  }
  if (isMarketLikeUrl(url)) {
    return { url, text: null, cached: false, source_status: null, fetch_method: null, rejected: true, error: 'rejected market/price url before fetch' };
  }
  const path = cachePathForUrl(stateRoot, date, url);
  if (existsSync(path)) {
    try {
      const hit = JSON.parse(readFileSync(path, 'utf8'));
      if (typeof hit.text === 'string') {
        return {
          url,
          text: hit.text,
          cached: true,
          source_status: statusFromCacheHit(hit),
          fetch_method: hit.fetch_method ?? 'normal',
          error: null,
        };
      }
    } catch {
      // unreadable cache entry -> refetch
    }
  }
  let normalOutcome = null;
  try {
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
      headers: {
        // Official sites (e.g. *.gov) commonly 403 a header-less client.
        // A standard browser UA is required to actually retrieve the declared
        // source document. No cookies, no auth, read-only GET.
        'user-agent': env.MENTIONS_RESEARCH_USER_AGENT
          || 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    if (!res?.ok) {
      normalOutcome = { status: res?.status ?? null, timeout: false, bodyClass: null, error: `fetch failed: status ${res?.status ?? 'unknown'}` };
    } else {
      const raw = await res.text();
      const bodyClass = classifySourceText(raw);
      normalOutcome = { status: res.status ?? 200, timeout: false, bodyClass, raw, error: bodyClass.useful ? null : `fetch returned ${bodyClass.reason}` };
      if (bodyClass.useful) {
        const text = String(raw).slice(0, maxSourceBytes(env));
        writeCache({ stateRoot, date, url, rawText: raw, text, fetchMethod: 'normal', sourceStatus: SOURCE_FETCH_STATUS.SOURCE_FETCHED, env });
        return { url, text, cached: false, source_status: SOURCE_FETCH_STATUS.SOURCE_FETCHED, fetch_method: 'normal', error: null };
      }
    }
  } catch (err) {
    normalOutcome = { status: null, timeout: isTimeoutError(err), bodyClass: null, error: `fetch failed: ${err.message}` };
  }

  if (allowFallback && shouldUseBrowserFallback(normalOutcome) && typeof fallbackFetchImpl === 'function') {
    const fallback = await fallbackFetchImpl({ url, env, timeoutMs: browserTimeoutMs });
    if (fallback?.ok && typeof fallback.text === 'string') {
      const text = fallback.text.slice(0, maxSourceBytes(env));
      writeCache({ stateRoot, date, url, rawText: fallback.text, text, fetchMethod: 'firecrawl', sourceStatus: SOURCE_FETCH_STATUS.SOURCE_FETCHED_BROWSER, env });
      return {
        url,
        text,
        cached: false,
        source_status: SOURCE_FETCH_STATUS.SOURCE_FETCHED_BROWSER,
        fetch_method: 'firecrawl',
        normal_error: normalOutcome.error,
        error: null,
      };
    }
    const status = fallback?.timedOut ? SOURCE_FETCH_STATUS.SOURCE_FETCH_TIMEOUT : SOURCE_FETCH_STATUS.SOURCE_FETCH_BLOCKED_BY_SITE;
    return {
      url,
      text: null,
      cached: false,
      source_status: status,
      fetch_method: 'firecrawl',
      normal_error: normalOutcome.error,
      error: fallback?.error ?? 'browser/firecrawl fallback failed',
    };
  }

  const status = normalOutcome?.timeout ? SOURCE_FETCH_STATUS.SOURCE_FETCH_TIMEOUT : SOURCE_FETCH_STATUS.SOURCE_FETCH_BLOCKED_BY_SITE;
  return { url, text: null, cached: false, source_status: status, fetch_method: 'normal', error: normalOutcome?.error ?? 'fetch failed' };
}

// Optional per-event declared-source manifest:
// state/mentions/<date>/sources/<TICKER>.json -> { "urls": ["https://..."] }
export function loadDeclaredSources(stateRoot, date, eventTicker, env = process.env) {
  const path = resolve(stateRoot, 'mentions', date, 'sources', `${eventTicker}.json`);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const urls = Array.isArray(parsed?.urls) ? parsed.urls : [];
    return urls
      .filter((u) => /^https?:\/\//i.test(String(u)))
      .filter((u) => !isMarketLikeUrl(u))
      .slice(0, maxSources(env));
  } catch {
    return [];
  }
}

// ─── batch extraction (one cheap call per source document) ──────────────────

export function buildBatchExtractionPrompt({ eventTitle, profile, terms, sourceUrl, sourceText }) {
  return [
    'You are an evidence extractor for a Kalshi mentions event. Return STRICT JSON ONLY.',
    'Given ONE source document, assess evidence for EVERY listed term in one pass.',
    'Never include prices, odds, volume, or market data. Only source-text evidence.',
    `Allowed layers: ${EVIDENCE_LAYERS.join(', ')}.`,
    'Schema: {"terms":[{"term": string (exactly as listed),',
    ' "layers": {"<layer>": {"present": boolean, "score": integer 0-100, "basis": string (quote or pointer from the source)}}}]}',
    'Only set present=true with a score when the source genuinely supports that layer for that term.',
    '',
    `event_title: ${eventTitle}`,
    `profile: ${profile}`,
    `terms: ${JSON.stringify(terms)}`,
    `source_url: ${sourceUrl}`,
    'source_text:',
    String(sourceText ?? ''),
  ].join('\n');
}

/**
 * Validate one batch-extraction result. Fails closed: anything malformed is
 * dropped; unknown layers, out-of-range scores, and pricing-shaped fields are
 * rejected record-by-record.
 */
export function validateExtractionJson(parsed, expectedTerms = []) {
  const byTerm = {};
  const errors = [];
  const expected = new Set(expectedTerms.map((t) => String(t)));
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.terms)) {
    return { ok: false, errors: ['extraction output is not {terms:[...]}'], byTerm };
  }
  for (const entry of parsed.terms.slice(0, 80)) {
    const term = typeof entry?.term === 'string' ? entry.term.trim() : null;
    if (!term || !expected.has(term)) {
      if (term) errors.push(`unknown term "${term}" (ignored)`);
      continue;
    }
    const layers = entry.layers;
    if (!layers || typeof layers !== 'object' || Array.isArray(layers)) continue;
    for (const [key, rec] of Object.entries(layers)) {
      if (!EVIDENCE_LAYERS.includes(key)) { errors.push(`unknown layer "${key}" (ignored)`); continue; }
      if (!rec || typeof rec !== 'object') continue;
      if (FORBIDDEN_KEYS.some((k) => k in rec)) { errors.push(`layer "${key}" carried pricing-shaped field (rejected)`); continue; }
      const score = Number(rec.score);
      if (rec.present !== true || !Number.isFinite(score) || score < 0 || score > 100) continue;
      const basis = typeof rec.basis === 'string' && rec.basis.trim() ? rec.basis.trim().slice(0, 240) : null;
      if (!basis) { errors.push(`layer "${key}" for "${term}" missing basis (rejected)`); continue; }
      byTerm[term] = byTerm[term] ?? {};
      byTerm[term][key] = { present: true, score: Math.round(score), basis };
    }
  }
  return { ok: errors.length === 0, errors, byTerm };
}

// Extraction routing: Gemini 3.5 Flash first; schema failure/timeout/unstable
// JSON falls back ONCE to gpt-5.4-mini under the same strict schema. Total
// failure fails closed (no layers merge; quality stays stub/no_source).
export async function extractEvidenceForSource({ doc, eventTitle, profile, terms, chatRunner, routing } = {}) {
  const prompt = buildBatchExtractionPrompt({ eventTitle, profile, terms, sourceUrl: doc.url, sourceText: doc.text });
  const run = await runCheapExtractionJson({
    prompt,
    validate: (parsed) => validateExtractionJson(parsed, terms),
    ...(chatRunner ? { chatRunner } : {}),
    ...(routing ? { routing } : {}),
    source: 'mentions-source-extraction',
  });
  if (!run.ok) {
    const detail = run.attempts.map((a) => `${a.tier}: ${a.error}`).join(' | ');
    return { ok: false, byTerm: {}, errors: [`extraction failed on all cheap tiers (${detail})`], invocation: run.invocation, tier: null, fallback_used: run.fallback_used, attempts: run.attempts };
  }
  return { ...run.validated, invocation: run.invocation, tier: run.tier, fallback_used: run.fallback_used, attempts: run.attempts };
}

// ─── orchestration ───────────────────────────────────────────────────────────

/**
 * Bounded source research for one event: <= maxSources declared URLs, one
 * cheap batch extraction per fetched document, evidence merged per term
 * (max score per layer across sources, bases concatenated).
 */
export async function runBoundedSourceResearch({
  eventTitle,
  eventTicker,
  profile,
  terms,
  sources = [],
  stateRoot = 'state',
  date,
  env = process.env,
  fetchImpl = globalThis.fetch,
  fallbackFetchImpl = firecrawlCliFetch,
  chatRunner,
  routing = null,
} = {}) {
  const capped = (sources ?? []).slice(0, maxSources(env));
  const fallbackPageCap = maxFallbackPages(env);
  const stats = {
    sources_declared: (sources ?? []).length,
    sources_used: capped.length,
    fetched: 0,
    fetched_browser: 0,
    cache_hits: 0,
    fetch_errors: 0,
    fetch_timeouts: 0,
    blocked_by_site: 0,
    fallback_attempts: 0,
    fallback_page_cap: fallbackPageCap,
    model_calls: 0,
    fallback_calls: 0,
    extraction_tiers: [],
    terms_batched_per_call: terms.length,
    extraction_failures: 0,
  };
  const byTerm = {};
  const notes = [];
  const sourceStatuses = [];

  for (const url of capped) {
    const fallbackAttemptsSoFar = stats.fallback_attempts;
    const doc = await fetchSourceDocument({
      url,
      stateRoot,
      date,
      env,
      fetchImpl,
      fallbackFetchImpl,
      allowFallback: fallbackAttemptsSoFar < fallbackPageCap,
    });
    if (doc.source_status) sourceStatuses.push(doc.source_status);
    if (doc.cached) stats.cache_hits += 1;
    else if (doc.text != null && doc.source_status === SOURCE_FETCH_STATUS.SOURCE_FETCHED_BROWSER) stats.fetched_browser += 1;
    else if (doc.text != null) stats.fetched += 1;
    if (doc.fetch_method === 'firecrawl' && !doc.cached) stats.fallback_attempts += 1;
    if (doc.text == null) {
      stats.fetch_errors += 1;
      if (doc.source_status === SOURCE_FETCH_STATUS.SOURCE_FETCH_TIMEOUT) stats.fetch_timeouts += 1;
      if (doc.source_status === SOURCE_FETCH_STATUS.SOURCE_FETCH_BLOCKED_BY_SITE) stats.blocked_by_site += 1;
      notes.push(`source unavailable: ${url} (${doc.error})`);
      continue;
    }
    const extraction = await extractEvidenceForSource({ doc, eventTitle, profile, terms, chatRunner, routing });
    // one cheap call per source document, +1 only if the schema fallback fired
    stats.model_calls += extraction.attempts?.length ?? 1;
    if (extraction.fallback_used) stats.fallback_calls = (stats.fallback_calls ?? 0) + 1;
    if (extraction.tier) stats.extraction_tiers = [...new Set([...(stats.extraction_tiers ?? []), extraction.tier])];
    if (!extraction.ok && Object.keys(extraction.byTerm).length === 0) {
      stats.extraction_failures += 1;
      notes.push(`extraction failed closed for ${url}: ${extraction.errors.join('; ')}`);
      continue;
    }
    for (const [term, layers] of Object.entries(extraction.byTerm)) {
      byTerm[term] = byTerm[term] ?? {};
      for (const [key, rec] of Object.entries(layers)) {
        const prev = byTerm[term][key];
        if (!prev || rec.score > prev.score) {
          byTerm[term][key] = { ...rec, basis: `${rec.basis} [${url}]` };
        }
      }
    }
  }

  const evidenceTerms = Object.keys(byTerm).length;
  const quality = evidenceTerms > 0 ? 'source_backed' : (capped.length ? 'no_source' : 'stub');
  const source_status = sourceStatuses.includes(SOURCE_FETCH_STATUS.SOURCE_FETCHED_BROWSER)
    ? SOURCE_FETCH_STATUS.SOURCE_FETCHED_BROWSER
    : sourceStatuses.includes(SOURCE_FETCH_STATUS.SOURCE_FETCHED)
      ? SOURCE_FETCH_STATUS.SOURCE_FETCHED
      : sourceStatuses.includes(SOURCE_FETCH_STATUS.SOURCE_FETCH_TIMEOUT)
        ? SOURCE_FETCH_STATUS.SOURCE_FETCH_TIMEOUT
        : sourceStatuses.includes(SOURCE_FETCH_STATUS.SOURCE_FETCH_BLOCKED_BY_SITE)
          ? SOURCE_FETCH_STATUS.SOURCE_FETCH_BLOCKED_BY_SITE
          : null;
  stats.source_status = source_status;
  if (quality !== 'source_backed') {
    notes.push(capped.length
      ? 'no usable source evidence extracted; layers remain missing (research_quality=no_source)'
      : 'no sources declared for this event; layers remain missing (research_quality=stub)');
  }
  return { byTerm, stats, quality, notes, source_status };
}

/**
 * Merge extracted evidence into an adapter-produced layer_records map for one
 * term. Extracted layers only ever FILL missing layers or upgrade
 * non-present stubs — proximity/scheduling layers from adapters are kept.
 */
export function mergeExtractedLayers(baseRecords = {}, extracted = {}, sourceLabel = 'batch-extraction') {
  const merged = { ...baseRecords };
  for (const [key, rec] of Object.entries(extracted)) {
    if (!EVIDENCE_LAYERS.includes(key)) continue;
    const existing = merged[key];
    if (existing?.present === true) continue; // adapter evidence wins; extraction fills gaps
    merged[key] = {
      present: true,
      score: rec.score,
      source_basis: `${sourceLabel}: ${rec.basis}`,
      source_path: null,
      detail: null,
      missing_note: null,
    };
  }
  return merged;
}
