// Mentions model router.
//
// Maps pipeline roles to model tiers (config/mentions-model-routing.json):
//   cheap    = gpt-5.4-mini  (OpenAI Codex)  extractor/classifier/JSON validator
//   standard = gpt-5.4       (OpenAI Codex)  packet analyst
//   premium  = gpt-5.5       (OpenAI Codex)  synthesis/closer, gate-only
//   redteam  = grok-4.3      (XAI Grok OAuth) optional, JSON only, never scores
//
// Models may ONLY return strict JSON fields. They never write packet layout,
// never see scoring internals as mutable inputs, and never receive authority
// over the CPC composite score. Invalid/missing model output falls back to a
// deterministic render with MISSING analyst fields — the packet still ships.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHermesChat } from '../../src/hermesRuntime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROUTING_PATH = resolve(__dirname, '../../config/mentions-model-routing.json');

export const TIERS = Object.freeze(['cheap', 'standard', 'premium', 'redteam']);

const DEFAULT_ROUTING = Object.freeze({
  tiers: {
    cheap: { model: 'gpt-5.4-mini', provider: 'openai-codex' },
    standard: { model: 'gpt-5.4', provider: 'openai-codex' },
    premium: { model: 'gpt-5.5', provider: 'openai-codex' },
    redteam: { model: 'grok-4.3', provider: 'xai-grok-oauth', optional: true },
  },
  premium_gate: { require_source_backed: true, min_best_score: 68, allow_flags: ['high_value', 'public_sample', 'source_backed'] },
});

export function loadModelRouting(path = ROUTING_PATH) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && typeof parsed.tiers === 'object') return parsed;
  } catch {
    // fall through to safe default
  }
  return DEFAULT_ROUTING;
}

export function resolveTier(tierName, routing = loadModelRouting()) {
  const tier = routing?.tiers?.[tierName] ?? DEFAULT_ROUTING.tiers[tierName];
  if (!tier?.model || !tier?.provider) {
    throw new Error(`model routing tier "${tierName}" is missing model/provider`);
  }
  return { tier: tierName, model: tier.model, provider: tier.provider, optional: tier.optional === true };
}

// ─── analyst tier selection / premium gate ───────────────────────────────────
// Proximity-only or fully blocked events never spend a model call: they render
// deterministically. Premium (gpt-5.5) requires the gate: source-backed
// evidence AND (score threshold OR an explicit high-value flag).

export function selectAnalystTier({ summary = {}, flags = [], env = process.env, routing = loadModelRouting() } = {}) {
  const sourceBacked = Number(summary.source_backed_count ?? 0);
  const total = Number(summary.market_count ?? 0);
  const proximityOnly = Number(summary.proximity_only_count ?? 0);
  if (total === 0 || sourceBacked === 0 || proximityOnly >= total) {
    return { tier: 'none', reason: 'proximity-only/blocked event: deterministic render, no model synthesis' };
  }
  const gate = routing.premium_gate ?? DEFAULT_ROUTING.premium_gate;
  const allowFlags = new Set(gate.allow_flags ?? []);
  const envFlags = String(env.MENTIONS_PREMIUM_FLAGS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const allFlags = [...flags, ...envFlags];
  const flagged = allFlags.some((f) => allowFlags.has(f));
  const bestScore = Number(summary.best_score ?? Number.NEGATIVE_INFINITY);
  const scoreOk = Number.isFinite(bestScore) && bestScore >= Number(gate.min_best_score ?? 68);
  if ((gate.require_source_backed === false || sourceBacked > 0) && flagged && scoreOk) {
    return { tier: 'premium', reason: `gate passed: source_backed=${sourceBacked}, best_score=${bestScore}, flags=[${allFlags.join(',')}]` };
  }
  return { tier: 'standard', reason: 'normal paid packet: standard analyst tier' };
}

// ─── strict JSON schemas + safe fallbacks ────────────────────────────────────

function cleanString(value, maxLen = 400) {
  if (typeof value !== 'string') return null;
  const s = value.replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, maxLen) : null;
}

function cleanStringArray(value, maxItems = 8, maxLen = 240) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => cleanString(v, maxLen)).filter(Boolean).slice(0, maxItems);
}

// Analyst JSON: narrative fields only. No scores, no prices, no layout.
export function validateAnalystJson(parsed) {
  const errors = [];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, errors: ['analyst output is not a JSON object'], value: emptyAnalyst() };
  }
  const value = emptyAnalyst();
  value.fast_read = cleanString(parsed.fast_read, 600);
  if (!value.fast_read) errors.push('missing fast_read');
  value.final_read = cleanString(parsed.final_read, 600);
  if (!value.final_read) errors.push('missing final_read');
  value.source_gaps = cleanStringArray(parsed.source_gaps);
  value.upgrade_triggers = cleanStringArray(parsed.upgrade_triggers);
  value.downgrade_triggers = cleanStringArray(parsed.downgrade_triggers);
  if (Array.isArray(parsed.term_notes)) {
    for (const note of parsed.term_notes.slice(0, 40)) {
      const term = cleanString(note?.term, 80);
      if (!term) continue;
      value.term_notes[term] = {
        catalyst: cleanString(note?.catalyst, 160),
        settlement_fit: cleanString(note?.settlement_fit, 160),
        trap_risk: cleanString(note?.trap_risk, 160),
      };
    }
  }
  // Hard rule: analysts can never smuggle scores/prices back into the pipeline.
  for (const banned of ['cpc_score', 'composite_score', 'score', 'posture', 'price', 'yes_bid', 'yes_ask']) {
    if (banned in parsed) errors.push(`analyst returned forbidden field "${banned}" (ignored)`);
  }
  return { ok: errors.length === 0, errors, value };
}

export function emptyAnalyst() {
  return {
    fast_read: null,
    final_read: null,
    term_notes: {},
    source_gaps: [],
    upgrade_triggers: [],
    downgrade_triggers: [],
  };
}

// Red-team JSON: advisory flags only. Scores/postures are ignored by design,
// so a hostile or hallucinating red-team model cannot move the CPC board.
export function validateRedteamJson(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, errors: ['redteam output is not a JSON object'], value: { trap_flags: {}, narrative_risks: [] } };
  }
  const value = { trap_flags: {}, narrative_risks: cleanStringArray(parsed.narrative_risks, 6) };
  if (Array.isArray(parsed.trap_flags)) {
    for (const flag of parsed.trap_flags.slice(0, 40)) {
      const term = cleanString(flag?.term, 80);
      const note = cleanString(flag?.note, 200);
      if (term && note) value.trap_flags[term] = note;
    }
  }
  return { ok: true, errors: [], value };
}

// ─── prompts (JSON in, JSON out; never layout) ──────────────────────────────

export function buildAnalystPrompt(input) {
  return [
    'You are a research analyst for a Kalshi mentions event. You receive deterministic',
    'composite data as JSON. Return STRICT JSON ONLY — no prose, no markdown, no layout.',
    'You do NOT write the packet; code renders it. Never return scores, postures, or prices.',
    'Market context in the input is labeled NOT IN SCORE and must not influence your read of likelihood.',
    'Schema: {"fast_read": string, "final_read": string,',
    ' "term_notes": [{"term": string (use the provided short term), "catalyst": string, "settlement_fit": string, "trap_risk": string}],',
    ' "source_gaps": [string], "upgrade_triggers": [string], "downgrade_triggers": [string]}',
    '',
    'input_json:',
    JSON.stringify(input, null, 2),
  ].join('\n');
}

export function buildRedteamPrompt(input) {
  return [
    'You are an optional red-team reviewer for a Kalshi mentions event. Return STRICT JSON ONLY.',
    'You cannot change scores or postures; flag traps and narrative risks only.',
    'Schema: {"trap_flags": [{"term": string, "note": string}], "narrative_risks": [string]}',
    '',
    'input_json:',
    JSON.stringify(input, null, 2),
  ].join('\n');
}

// ─── model invocation ────────────────────────────────────────────────────────

export async function runTierJson({ tierName, prompt, routing = loadModelRouting(), chatRunner = runHermesChat, timeoutMs = null, source = 'mentions-model-router' } = {}) {
  const { model, provider } = resolveTier(tierName, routing);
  const timeout = timeoutMs ?? Number(process.env.MENTIONS_MODEL_TIMEOUT_SECONDS || '300') * 1000;
  const result = await chatRunner(prompt, { provider, model, source, timeout, toolsets: [], skills: [] });
  return {
    ok: Boolean(result?.ok && result?.parsed != null),
    parsed: result?.parsed ?? null,
    invocation: { tier: tierName, provider, model, status: result?.status ?? null },
    stderr: result?.stderr ?? null,
  };
}

// Analyst call with fail-safe fallback: any failure returns empty analyst
// fields and the deterministic renderer ships the packet with MISSING notes.
export async function fetchAnalystFields({ input, summary = {}, flags = [], env = process.env, routing = loadModelRouting(), chatRunner = runHermesChat } = {}) {
  const selection = selectAnalystTier({ summary, flags, env, routing });
  if (selection.tier === 'none') {
    return { analyst: emptyAnalyst(), tier: 'none', reason: selection.reason, invocation: null, fallback: false };
  }
  try {
    const run = await runTierJson({ tierName: selection.tier, prompt: buildAnalystPrompt(input), routing, chatRunner, source: 'mentions-analyst' });
    if (!run.ok) {
      return { analyst: emptyAnalyst(), tier: selection.tier, reason: `analyst model unavailable (${run.stderr || 'no JSON'}) — deterministic fallback`, invocation: run.invocation, fallback: true };
    }
    const validated = validateAnalystJson(run.parsed);
    return { analyst: validated.value, tier: selection.tier, reason: selection.reason, invocation: run.invocation, fallback: !validated.ok, validation_errors: validated.errors };
  } catch (err) {
    return { analyst: emptyAnalyst(), tier: selection.tier, reason: `analyst call failed (${err.message}) — deterministic fallback`, invocation: null, fallback: true };
  }
}

// Optional red-team call. Disabled unless MENTIONS_REDTEAM=1. Output is
// advisory JSON only; the renderer prints flags but never re-scores.
export async function fetchRedteamFields({ input, env = process.env, routing = loadModelRouting(), chatRunner = runHermesChat } = {}) {
  if (String(env.MENTIONS_REDTEAM ?? '') !== '1') {
    return { redteam: null, invocation: null, reason: 'redteam disabled (set MENTIONS_REDTEAM=1 to enable)' };
  }
  try {
    const run = await runTierJson({ tierName: 'redteam', prompt: buildRedteamPrompt(input), routing, chatRunner, source: 'mentions-redteam' });
    if (!run.ok) return { redteam: null, invocation: run.invocation, reason: 'redteam unavailable — skipped (optional)' };
    return { redteam: validateRedteamJson(run.parsed).value, invocation: run.invocation, reason: 'redteam ok' };
  } catch (err) {
    return { redteam: null, invocation: null, reason: `redteam failed (${err.message}) — skipped (optional)` };
  }
}
