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
export const DEFAULT_MAX_SOURCE_BYTES = 120_000;

const FORBIDDEN_KEYS = ['price', 'bid', 'ask', 'odds', 'volume', 'open_interest', 'yes_bid', 'yes_ask'];

export function maxSources(env = process.env) {
  const n = Number(env.MENTIONS_RESEARCH_MAX_SOURCES);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10) : DEFAULT_MAX_SOURCES;
}

export function maxSourceBytes(env = process.env) {
  const n = Number(env.MENTIONS_RESEARCH_MAX_SOURCE_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_SOURCE_BYTES;
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
  timeoutMs = 20_000,
} = {}) {
  if (!url || !/^https?:\/\//i.test(String(url))) {
    return { url, text: null, cached: false, error: 'invalid or non-http url (declared sources only)' };
  }
  const path = cachePathForUrl(stateRoot, date, url);
  if (existsSync(path)) {
    try {
      const hit = JSON.parse(readFileSync(path, 'utf8'));
      if (typeof hit.text === 'string') return { url, text: hit.text, cached: true, error: null };
    } catch {
      // unreadable cache entry -> refetch
    }
  }
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
    if (!res?.ok) return { url, text: null, cached: false, error: `fetch failed: status ${res?.status ?? 'unknown'}` };
    const raw = await res.text();
    const text = String(raw).slice(0, maxSourceBytes(env));
    mkdirSync(cacheDir(stateRoot, date), { recursive: true });
    writeFileSync(path, JSON.stringify({ url, fetched_at_utc: new Date().toISOString(), truncated: raw.length > text.length, text }, null, 0));
    return { url, text, cached: false, error: null };
  } catch (err) {
    return { url, text: null, cached: false, error: `fetch failed: ${err.message}` };
  }
}

// Optional per-event declared-source manifest:
// state/mentions/<date>/sources/<TICKER>.json -> { "urls": ["https://..."] }
export function loadDeclaredSources(stateRoot, date, eventTicker, env = process.env) {
  const path = resolve(stateRoot, 'mentions', date, 'sources', `${eventTicker}.json`);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const urls = Array.isArray(parsed?.urls) ? parsed.urls : [];
    return urls.filter((u) => /^https?:\/\//i.test(String(u))).slice(0, maxSources(env));
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
  chatRunner,
  routing = null,
} = {}) {
  const capped = (sources ?? []).slice(0, maxSources(env));
  const stats = {
    sources_declared: (sources ?? []).length,
    sources_used: capped.length,
    fetched: 0,
    cache_hits: 0,
    fetch_errors: 0,
    model_calls: 0,
    fallback_calls: 0,
    extraction_tiers: [],
    terms_batched_per_call: terms.length,
    extraction_failures: 0,
  };
  const byTerm = {};
  const notes = [];

  for (const url of capped) {
    const doc = await fetchSourceDocument({ url, stateRoot, date, env, fetchImpl });
    if (doc.cached) stats.cache_hits += 1;
    else if (doc.text != null) stats.fetched += 1;
    if (doc.text == null) {
      stats.fetch_errors += 1;
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
  if (quality !== 'source_backed') {
    notes.push(capped.length
      ? 'no usable source evidence extracted; layers remain missing (research_quality=no_source)'
      : 'no sources declared for this event; layers remain missing (research_quality=stub)');
  }
  return { byTerm, stats, quality, notes };
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
