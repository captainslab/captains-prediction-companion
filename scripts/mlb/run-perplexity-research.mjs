#!/usr/bin/env node
// Minimal MLB Perplexity research runner.
//
// Bridges the committed, price-free prompt builder
// (scripts/mlb/lib/perplexity-prompt-builder.mjs) to the repo's EXISTING safe
// Perplexity key path (scripts/mentions/mentions-research-perplexity.mjs:
// ensurePerplexityEnvLoaded + hasPerplexityKey). It does NOT define a new
// credential file or env convention — it reuses the one already in the repo.
//
// Key source order (inherited from the mentions helper): PERPLEXITY_API_KEY /
// PPLX_API_KEY env (auto-loaded from repo .env / .env.local), then the
// interactive ~/.config/cpc/perplexity.key file. The key is NEVER printed and
// NEVER persisted into the artifact.
//
// PRICE ISOLATION: the prompt forbids all market/price terms; the artifact
// stores only the price-free prompt + Perplexity's sourced facts. No bid/ask,
// no odds, no volume, no Kalshi price ever enters prompt, result, or artifact.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import {
  buildMlbResearchPrompt,
  classifyResearchFact,
} from './lib/perplexity-prompt-builder.mjs';
import { fetchMlbResearchContext } from '../../src/sports/mlbResearchContext.js';
import { scanPublicOutput } from '../../src/sports/publicPacketRenderer.js';
import {
  ensurePerplexityEnvLoaded,
  hasPerplexityKey,
} from '../mentions/mentions-research-perplexity.mjs';

const PPLX_URL = 'https://api.perplexity.ai/chat/completions';
const KEY_PATH = resolve(homedir(), '.config/cpc/perplexity.key');

// Reuse the EXISTING safe loader for status/value; never print the key.
function readKeyInternal(env = process.env) {
  ensurePerplexityEnvLoaded(env);
  const fromEnv = (env.PERPLEXITY_API_KEY || env.PPLX_API_KEY || '').replace(/\s+/g, '');
  if (fromEnv) return fromEnv;
  if (existsSync(KEY_PATH)) {
    const k = readFileSync(KEY_PATH, 'utf8').replace(/\s+/g, '');
    if (k) return k;
  }
  throw new Error('Perplexity key unavailable (env / .env.local / ~/.config/cpc/perplexity.key)');
}

async function callPerplexity({ key, system, user, model = 'sonar', maxTokens = 1200, timeoutMs = 55000 }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(PPLX_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: maxTokens,
        temperature: 0.1,
        return_citations: true,
      }),
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Build the anchored prompt, call Perplexity only when a key is present, and
 * write a bounded, price-free artifact. Returns a status object (never the key).
 *
 * @param {object} opts
 * @param {string} opts.queryType One of the prompt builder QUERY_TYPES.
 * @param {object} opts.gameAnchor Anchor passed straight to buildMlbResearchPrompt.
 * @param {string} opts.outPath Artifact path.
 * @param {string} [opts.eventTicker]
 * @param {string} [opts.model]
 * @param {object} [opts.env]
 * @param {boolean} [opts.persist]
 */
export async function runMlbResearch({
  queryType,
  gameAnchor,
  outPath,
  eventTicker = null,
  model = 'sonar',
  env = process.env,
  persist = true,
  games = [],
  packetText = null,
  outputPacketText = null,
  callImpl = callPerplexity,
} = {}) {
  const prompt = buildMlbResearchPrompt(queryType, gameAnchor);

  if (!hasPerplexityKey(env)) {
    return { status: 'BLOCKED', reason: 'no_key', key_present: false, prompt };
  }

  const key = readKeyInternal(env);
  const resp = await callImpl({ key, system: prompt.system, user: prompt.user, model });

  const attachedGames = [];
  if (Array.isArray(games) && games.length) {
    for (const game of games) {
      const research_context = await fetchMlbResearchContext(game);
      game.research_context = research_context;
      attachedGames.push(game);
    }
  }

  if (!resp.ok) {
    return {
      status: 'FAIL',
      reason: `http_${resp.status}`,
      detail: resp.json?.error?.message || 'unknown',
      key_present: true,
      prompt,
      games: attachedGames,
    };
  }

  const content = resp.json?.choices?.[0]?.message?.content ?? '';
  const citations = Array.isArray(resp.json?.citations)
    ? resp.json.citations
    : (Array.isArray(resp.json?.search_results)
      ? resp.json.search_results.map((s) => s.url || s.title).filter(Boolean)
      : []);
  // Persist citations as title/url/date ONLY. Raw provider snippets are dropped
  // before persistence: third-party scoreboard snippets can passively contain
  // market data (e.g. a moneyline), and the artifact must stay price-free even
  // though snippet bodies are never read back into scoring.
  const search_results = (Array.isArray(resp.json?.search_results) ? resp.json.search_results : [])
    .map((s) => ({ title: s?.title ?? null, url: s?.url ?? null, date: s?.date ?? s?.last_updated ?? null }));

  // Best-effort parse of the JSON the prompt schema asks for; tolerate prose.
  let parsed = null;
  try {
    const m = content.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  } catch { parsed = null; }

  // Anchor-classify any facts so cross-day contamination is downgraded to
  // series_context rather than presented as current-game state.
  let classified = [];
  if (parsed && Array.isArray(parsed.facts)) {
    classified = parsed.facts.map((f) => ({ fact: f, anchor_check: classifyResearchFact(f, gameAnchor) }));
  }

  const artifact = {
    generated_utc: new Date().toISOString(),
    lane: 'mlb-perplexity-research',
    query_type: queryType,
    model,
    event_ticker: eventTicker,
    game_anchor: gameAnchor,
    prompt_system: prompt.system,
    prompt_user: prompt.user,
    forbidden_market_terms: prompt.forbidden_market_terms,
    answer: content,
    parsed,
    classified_facts: classified,
    citations,
    search_results,
    usage: resp.json?.usage ?? null,
    price_free: true,
    games: attachedGames,
  };

  const packetCandidate = outputPacketText ?? packetText;
  if (typeof packetCandidate === 'string' && packetCandidate.trim()) {
    const scan = scanPublicOutput(packetCandidate);
    if (!scan.clean) {
      throw new Error(`Public packet contains banned terms: ${scan.violations.join(', ')}`);
    }
    artifact.public_packet_scan = scan;
  }

  if (persist && outPath) {
    mkdirSync(resolve(outPath, '..'), { recursive: true });
    writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  }

  return {
    status: 'PASS',
    key_present: true,
    answer_chars: content.length,
    citations_count: citations.length,
    artifact,
    out_path: outPath || null,
  };
}

// CLI: bounded BAL @ LAD POST_GAME proof by default; flags override the anchor.
function argValue(args, flag, fallback = null) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
}

async function main() {
  const args = process.argv.slice(2);
  const queryType = argValue(args, '--type', 'POST_GAME');
  const gameAnchor = {
    game_pk: argValue(args, '--game-pk', '823937'),
    date: argValue(args, '--date', '2026-06-20'),
    away_team: argValue(args, '--away', 'Baltimore Orioles'),
    home_team: argValue(args, '--home', 'Los Angeles Dodgers'),
    venue: argValue(args, '--venue', 'Dodger Stadium'),
    first_pitch_utc: argValue(args, '--first-pitch', 'unknown'),
  };
  const eventTicker = argValue(args, '--ticker', 'KXMLBGAME-26JUN202210BALLAD');
  const outPath = argValue(
    args,
    '--out',
    resolve(`state/mlb/${gameAnchor.date}/packet-tests/${eventTicker}-postgame-research.json`),
  );

  const result = await runMlbResearch({ queryType, gameAnchor, outPath, eventTicker });
  // Status only — never the key.
  console.log(`RESULT: ${result.status}${result.reason ? ` (${result.reason}${result.detail ? ': ' + result.detail : ''})` : ''}`);
  console.log('key_present:', result.key_present ? 'YES' : 'NO');
  if (result.status === 'PASS') {
    console.log('answer_chars:', result.answer_chars);
    console.log('citations_count:', result.citations_count);
    console.log('out_path:', result.out_path);
  }
  if (result.status === 'FAIL') process.exitCode = 2;
  if (result.status === 'BLOCKED') process.exitCode = 3;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.log(`RESULT: ERROR (${e.message})`);
    process.exit(1);
  });
}

export default { runMlbResearch };
