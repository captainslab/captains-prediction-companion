#!/usr/bin/env node
// INTERACTIVE mention research via Perplexity (two-pass, priority sources).
// NOT for cron — Perplexity key lives only in interactive sessions.
//
// Pipeline:
//   1. Hydrate the event (public Kalshi API, read-only).
//   2. Candidate words = each market's exact strike phrase (yes_sub_title).
//   3. Classify rule family + build PRIORITY source allowlists (registry +
//      outlets named in the contract rules). Trump/White House → rollcall.com
//      default (user directive).
//   4. Two Perplexity passes:
//        - proof pass:        search_domain_filter = proof allowlist
//        - handicapping pass: open web (news cycle / habit)
//      Each returns a per-phrase literal-utterance likelihood (0-100) + reason.
//   5. Write a PRICE-FREE research artifact. If the event is already settled,
//      compare predicted likelihood vs actual YES/NO result (backtest).
//
// PRICE ISOLATION: no bid/ask/price/volume/OI ever enters the prompt, the layer
// values, or the artifact. market.result is a settled OUTCOME (yes/no), allowed
// for backtest display only — never a scoring input. The Perplexity key is read
// from ~/.config/cpc/perplexity.key and is NEVER printed.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  defaultFetcher,
  KALSHI_API_BASE,
} from '../packets/lib/kalshi-discovery.mjs';
import {
  classifyPriorityFamily,
  buildPriorityDomains,
  extractDomainsFromText,
} from './source-priority-registry.mjs';

const PPLX_URL = 'https://api.perplexity.ai/chat/completions';
const KEY_PATH = resolve(homedir(), '.config/cpc/perplexity.key');

function argValue(args, flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; }

// Key source order: PERPLEXITY_API_KEY env first (cron-usable, loaded from
// .env.local), then the interactive home-dir key file. Env support is what lets
// the cron pipeline run Perplexity research; the file path stays as the
// interactive fallback. The key is NEVER printed.
export function hasPerplexityKey(env = process.env) {
  const fromEnv = (env.PERPLEXITY_API_KEY || env.PPLX_API_KEY || '').trim();
  return Boolean(fromEnv) || existsSync(KEY_PATH);
}

function readKey(env = process.env) {
  const fromEnv = (env.PERPLEXITY_API_KEY || env.PPLX_API_KEY || '').replace(/\s+/g, '');
  if (fromEnv) return fromEnv;
  if (!existsSync(KEY_PATH)) {
    throw new Error(`Perplexity key not found: set PERPLEXITY_API_KEY (env / .env.local) or write ${KEY_PATH}`);
  }
  const k = readFileSync(KEY_PATH, 'utf8').replace(/\s+/g, '');
  if (!k) throw new Error('Perplexity key file is empty');
  return k;
}

// Drop the structural EDNQ strike; collect distinct exact strike phrases.
function candidateWordsFromEvent(event) {
  const out = [];
  const seen = new Set();
  for (const m of event.markets ?? []) {
    const phrase = (m.yes_sub_title || '').trim();
    if (!phrase) continue;
    if (/event does not qualify|does not occur/i.test(phrase)) continue;
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ phrase, ticker: m.ticker, result: m.result ?? null });
  }
  return out;
}

const normWord = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// KALSHI-NATIVE FIRST (mandatory): pull the series' prior SETTLED events and
// compute, per exact strike phrase, the native historical YES base rate. This is
// the Wave-1 Kalshi prior that must be checked before any external research.
// Free, read-only, no auth. result (yes/no) is a settled OUTCOME, not price.
async function kalshiNativePrior({ event, fetcher = defaultFetcher }) {
  const series = event.series_ticker;
  const out = { series, by_word: new Map(), events_scanned: 0, settled_events: 0 };
  if (!series) return out;
  let cursor = '';
  let pages = 0;
  const settledEvents = [];
  while (pages < 5) {
    const url = `${KALSHI_API_BASE}/events?series_ticker=${encodeURIComponent(series)}&limit=200&with_nested_markets=true${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`;
    const res = await fetcher(url);
    if (!res.ok || !res.json) break;
    const evs = Array.isArray(res.json.events) ? res.json.events : [];
    out.events_scanned += evs.length;
    for (const ev of evs) {
      if (ev.event_ticker === event.event_ticker) continue; // exclude self
      const settled = (ev.markets ?? []).some((m) => m.result === 'yes' || m.result === 'no');
      if (settled) settledEvents.push(ev);
    }
    cursor = res.json.cursor || '';
    pages += 1;
    if (!cursor) break;
  }
  out.settled_events = settledEvents.length;
  // Per normalized word: count settled markets and YES outcomes across comparables.
  const tally = new Map();
  for (const ev of settledEvents) {
    for (const m of ev.markets ?? []) {
      if (m.result !== 'yes' && m.result !== 'no') continue;
      const key = normWord(m.yes_sub_title);
      if (!key) continue;
      const t = tally.get(key) || { n: 0, yes: 0 };
      t.n += 1; if (m.result === 'yes') t.yes += 1;
      tally.set(key, t);
    }
  }
  out.by_word = tally;
  return out;
}

function extractJsonArray(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

async function perplexity({ key, model, messages, domains, maxTokens = 1200 }) {
  const body = { model, messages, max_tokens: maxTokens, temperature: 0.2 };
  if (Array.isArray(domains) && domains.length) body.search_domain_filter = domains;
  const res = await fetch(PPLX_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Perplexity HTTP ${res.status}: ${json?.error?.message || 'unknown'}`);
  }
  return {
    content: json?.choices?.[0]?.message?.content ?? '',
    citations: Array.isArray(json?.citations) ? json.citations : [],
    cost: json?.usage?.cost?.total_cost ?? null,
  };
}

function buildPrompt({ event, words, pass }) {
  const title = event.title || event.event_ticker;
  const phraseList = words.map((w, i) => `${i + 1}. "${w.phrase}"`).join('\n');
  const lexRules = [
    'Resolution is LITERAL: the exact word/phrase must be spoken aloud by the speaker.',
    'Plural and possessive forms COUNT. Other inflections (tense/derivation) do NOT.',
    'Acronyms are NOT their expansion ("AI" is not "artificial intelligence") and vice-versa.',
    'Synonyms / paraphrases / same-topic talk do NOT count — only the literal token.',
  ].join(' ');
  const framing = pass === 'proof'
    ? 'Use the official record / named outlets. Judge whether each exact phrase was (or would be) actually spoken by the speaker during this specific appearance.'
    : 'Use the broader news cycle, the speaker\'s recent verbal habits, and what topics are being forced right now to judge how likely each exact phrase is to be spoken.';
  return [
    {
      role: 'system',
      content: 'You are a literal-utterance forecaster for Kalshi "mention" markets. You estimate the probability that a specific speaker says an EXACT word/phrase during a specific appearance. Never use market prices or odds. Output ONLY a JSON array, no prose.',
    },
    {
      role: 'user',
      content:
        `Event: ${title}\n` +
        `Speaker/context from the event title above.\n\n` +
        `${framing}\n${lexRules}\n\n` +
        `Candidate exact phrases:\n${phraseList}\n\n` +
        `Return ONLY a JSON array, one object per phrase, in the same order:\n` +
        `[{"phrase": string, "likelihood_pct": integer 0-100, "confidence": "low"|"med"|"high", "reason": string (<=20 words)}]`,
    },
  ];
}

function mergePasses(words, proof, hcap, prior) {
  const byPhrase = (arr) => {
    const m = new Map();
    for (const r of arr ?? []) {
      if (r && typeof r.phrase === 'string') m.set(r.phrase.toLowerCase(), r);
    }
    return m;
  };
  const pm = byPhrase(proof);
  const hm = byPhrase(hcap);
  return words.map((w) => {
    const p = pm.get(w.phrase.toLowerCase());
    const h = hm.get(w.phrase.toLowerCase());
    // Kalshi-native prior FIRST: native historical YES rate for this exact word.
    const nat = prior?.by_word?.get(normWord(w.phrase)) || null;
    const kalshiPct = nat && nat.n > 0 ? Math.round((nat.yes / nat.n) * 100) : null;
    const kalshiN = nat ? nat.n : 0;
    const vals = [p?.likelihood_pct, h?.likelihood_pct].filter((v) => Number.isFinite(v));
    const pplxBlend = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
    // Blend: Kalshi-native prior anchors when it has real sample (n>=2);
    // Perplexity adjusts. n<2 native = not evidence, fall back to Perplexity.
    let blended;
    if (kalshiPct != null && kalshiN >= 2 && pplxBlend != null) {
      const wNat = Math.min(0.6, 0.2 + 0.1 * kalshiN); // more native sample → more weight, capped
      blended = Math.round(wNat * kalshiPct + (1 - wNat) * pplxBlend);
    } else {
      blended = pplxBlend ?? kalshiPct;
    }
    return {
      phrase: w.phrase,
      ticker: w.ticker,
      kalshi_native_pct: kalshiPct,   // checked FIRST (Kalshi calendar/native)
      kalshi_native_n: kalshiN,
      proof_pct: Number.isFinite(p?.likelihood_pct) ? p.likelihood_pct : null,
      handicap_pct: Number.isFinite(h?.likelihood_pct) ? h.likelihood_pct : null,
      blended_pct: blended,
      confidence: p?.confidence || h?.confidence || 'low',
      reason: p?.reason || h?.reason || null,
      actual_result: w.result, // settled outcome (yes/no) — backtest only, NOT a score input
    };
  });
}

export async function runResearch({ ticker, date, stateRoot = 'state', model = 'sonar', persist = true, env = process.env, perplexityImpl = perplexity, fetcherImpl = defaultFetcher } = {}) {
  if (!ticker) throw new Error('--ticker is required');

  const event = await hydrateEventByTicker(ticker, fetcherImpl);
  if (!event?.event_ticker) throw new Error(`could not hydrate event ${ticker}`);

  return runResearchForEvent({ event, date, stateRoot, model, persist, env, perplexityImpl, fetcherImpl });
}

// Read-only public-API hydration of a single event by ticker (no auth). Used by
// the interactive CLI path; the cron path already holds a hydrated event and
// calls runResearchForEvent directly.
async function hydrateEventByTicker(ticker, fetcher = defaultFetcher) {
  const url = `${KALSHI_API_BASE}/events/${encodeURIComponent(ticker)}?with_nested_markets=true`;
  const res = await fetcher(url);
  if (!res?.ok || !res.json) throw new Error(`Kalshi event fetch failed for ${ticker}`);
  return res.json.event ?? res.json;
}

// Core research for an ALREADY-HYDRATED event object. This is the cron entry
// point: collect-mentions-research.mjs passes the Kalshi event it already has,
// so no second live hydration is needed. perplexityImpl/fetcherImpl are
// injectable for tests (no live API call, no network) and for cron, which loads
// PERPLEXITY_API_KEY from .env.local. Returns { artifact, outPath, rows } or
// throws when the key is absent (caller fails closed). PRICE-FREE throughout.
export async function runResearchForEvent({ event, date, stateRoot = 'state', model = 'sonar', persist = true, env = process.env, perplexityImpl = perplexity, fetcherImpl = defaultFetcher } = {}) {
  if (!event?.event_ticker) throw new Error('runResearchForEvent requires a hydrated event');
  const ticker = event.event_ticker;
  const key = readKey(env);

  const words = candidateWordsFromEvent(event);
  if (!words.length) throw new Error('no candidate strike phrases found on event');

  // ── STEP 1 (MANDATORY): Kalshi-native FIRST — series settled comparables. ──
  const prior = await kalshiNativePrior({ event, fetcher: fetcherImpl });

  // ── STEP 2: Perplexity (default non-Kalshi alpha seeker). ──
  const rulesText = (event.markets ?? [])
    .map((m) => `${m.rules_primary || ''} ${m.rules_secondary || ''}`).join('\n');
  const rulesNamedDomains = extractDomainsFromText(rulesText);
  const family = classifyPriorityFamily(event);
  const { priorityDomains } = buildPriorityDomains(event, { family, rulesNamedDomains });

  // Two passes: (1) PRIORITY — restricted to the priority allowlist (official +
  // default priority sources like rollcall.com); (2) OPEN — broad news cycle.
  const proofRes = await perplexityImpl({
    key, model, domains: priorityDomains,
    messages: buildPrompt({ event, words, pass: 'proof' }),
  });
  const hcapRes = await perplexityImpl({
    key, model, domains: null,
    messages: buildPrompt({ event, words, pass: 'handicapping' }),
  });

  const rows = mergePasses(words, extractJsonArray(proofRes.content), extractJsonArray(hcapRes.content), prior);

  const artifact = {
    generated_utc: new Date().toISOString(),
    engine: 'kalshi-native-first + perplexity', model,
    event_ticker: event.event_ticker,
    event_title: event.title,
    family,
    kalshi_native_first: {
      series_ticker: prior.series,
      settled_comparable_events: prior.settled_events,
      events_scanned: prior.events_scanned,
    },
    priority_sources: {
      priority_allowlist: priorityDomains,
      handicapping_open: true,
      rules_named_domains: rulesNamedDomains,
    },
    rows,
    proof_pass: { citations: proofRes.citations, cost_usd: proofRes.cost },
    handicapping_pass: { citations: hcapRes.citations, cost_usd: hcapRes.cost },
  };

  let outPath = null;
  if (persist) {
    outPath = resolve(stateRoot, 'mentions', date, 'research-perplexity', `${ticker}.json`);
    mkdirSync(resolve(outPath, '..'), { recursive: true });
    writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  }
  return { artifact, outPath, rows };
}

// Map Perplexity per-phrase rows into PRICE-FREE mention evidence layers keyed
// by exact strike phrase. blended_pct/proof_pct are literal-utterance
// likelihoods (0-100), NOT prices — they feed direct_mention_pathway. The
// Kalshi-native settled YES rate (n>=2) feeds historical_tendency. A row with
// no usable signal yields no layers (the term stays a verified gap, never
// invented). Returns { byTerm: { <phrase>: { <layer>: record } }, usableTerms }.
export function perplexityRowsToLayers(rows = []) {
  const byTerm = {};
  let usableTerms = 0;
  for (const r of rows) {
    if (!r || typeof r.phrase !== 'string') continue;
    const layers = {};
    const likelihood = Number.isFinite(r.blended_pct) ? r.blended_pct
      : (Number.isFinite(r.proof_pct) ? r.proof_pct
        : (Number.isFinite(r.handicap_pct) ? r.handicap_pct : null));
    if (likelihood != null) {
      layers.direct_mention_pathway = {
        present: true,
        score: Math.max(0, Math.min(100, Math.round(likelihood))),
        source_basis: `perplexity literal-utterance forecast (proof=${r.proof_pct ?? 'n/a'} handicap=${r.handicap_pct ?? 'n/a'} blended=${r.blended_pct ?? 'n/a'}, conf=${r.confidence ?? 'low'})`,
        source_path: null,
        detail: r.reason ?? null,
        missing_note: null,
      };
    }
    if (Number.isFinite(r.kalshi_native_pct) && Number.isFinite(r.kalshi_native_n) && r.kalshi_native_n >= 2) {
      layers.historical_tendency = {
        present: true,
        score: Math.max(0, Math.min(100, Math.round(r.kalshi_native_pct))),
        source_basis: `kalshi-native settled comparables: ${r.kalshi_native_pct}% YES across n=${r.kalshi_native_n}`,
        source_path: null,
        detail: null,
        missing_note: null,
      };
    }
    if (Object.keys(layers).length) {
      byTerm[r.phrase] = layers;
      usableTerms += 1;
    }
  }
  return { byTerm, usableTerms };
}

function pct(v) { return v == null ? '  -' : String(v).padStart(3); }

function printSummary(a, outPath) {
  console.log('── Perplexity mention research (interactive) ─────────────');
  console.log(`event   : ${a.event_ticker}  ${a.event_title}`);
  console.log(`family  : ${a.family}`);
  console.log(`KALSHI-NATIVE FIRST: series ${a.kalshi_native_first.series_ticker} — ${a.kalshi_native_first.settled_comparable_events} settled comparable event(s)`);
  console.log(`priority allowlist (non-Kalshi): ${a.priority_sources.priority_allowlist.join(', ') || '(none)'}`);
  console.log(`rules-named        : ${a.priority_sources.rules_named_domains.join(', ') || '(none)'}`);
  const settled = a.rows.some((r) => r.actual_result);
  console.log('');
  const head = `phrase                         kalshi(n) proof handi blend conf  ${settled ? 'actual hit' : ''}`;
  console.log(head);
  console.log('-'.repeat(head.length));
  let hits = 0, scored = 0;
  for (const r of [...a.rows].sort((x, y) => (y.blended_pct ?? -1) - (x.blended_pct ?? -1))) {
    let tail = '';
    if (settled) {
      const actual = r.actual_result ? r.actual_result.toUpperCase() : '  -';
      let hit = '';
      if (r.actual_result && r.blended_pct != null) {
        const predYes = r.blended_pct >= 50;
        const wasYes = r.actual_result.toLowerCase() === 'yes';
        hit = predYes === wasYes ? 'Y' : 'N';
        scored += 1; if (hit === 'Y') hits += 1;
      }
      tail = `${actual.padEnd(6)} ${hit}`;
    }
    const kal = r.kalshi_native_pct == null ? ' -' : String(r.kalshi_native_pct);
    const kalCol = `${kal}(${r.kalshi_native_n})`.padStart(8);
    console.log(`${r.phrase.slice(0, 30).padEnd(30)} ${kalCol} ${pct(r.proof_pct)}   ${pct(r.handicap_pct)}   ${pct(r.blended_pct)}  ${(r.confidence||'').padEnd(4)} ${tail}`);
  }
  const cost = (a.proof_pass.cost_usd || 0) + (a.handicapping_pass.cost_usd || 0);
  console.log('');
  if (settled && scored) console.log(`BACKTEST: ${hits}/${scored} directional hits (pred YES≥50% vs actual settled YES/NO)`);
  console.log(`cost: ~$${cost.toFixed(4)} (2 calls)`);
  if (outPath) console.log(`artifact: ${outPath}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node scripts/mentions/mentions-research-perplexity.mjs --ticker TICKER [--date YYYY-MM-DD] [--state-root state] [--model sonar] [--json]');
    return;
  }
  const ticker = argValue(args, '--ticker');
  const date = argValue(args, '--date') || new Date().toISOString().slice(0, 10);
  const { artifact, outPath } = await runResearch({
    ticker, date,
    stateRoot: argValue(args, '--state-root') || 'state',
    model: argValue(args, '--model') || 'sonar',
    persist: !args.includes('--no-persist'),
  });
  if (args.includes('--json')) console.log(JSON.stringify(artifact, null, 2));
  else printSummary(artifact, outPath);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => { console.error(`[mentions-research] failed: ${err.message}`); process.exit(1); });
}
