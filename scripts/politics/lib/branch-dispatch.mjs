// Branch dispatch helpers.
//
// The orchestrator does NOT call LLMs directly from Node — Hermes is the
// runtime that owns model routing (delegate_task / x_search). Instead this
// module:
//
//   1. Loads prompt templates from scripts/politics/prompts/.
//   2. Materializes a prompt envelope per branch with the live Kalshi context
//      pre-injected (settlement rules, candidate board, market structure).
//   3. Discovers per-branch JSON outputs in --branches-dir (one file per branch:
//      official.json, xSignal.json, plausibility.json, skeptic.json, judgment.json).
//   4. Merges them with the auto-built market/settlement/marketStructure.
//
// Grok/xAI routing is configured per-branch via meta.modelRouting and surfaced
// in the prompt envelope; the actual provider switch is performed by the
// Hermes operator/cron that consumes envelopes.json.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_DIR = resolve(__dirname, '..', 'prompts');

export const BRANCHES = [
  // settlement is auto-built from Kalshi; LLM may augment ambiguities.
  { key: 'settlement',     promptFile: 'settlement.md',     autoBuilt: true,  defaultModel: 'inherit' },
  { key: 'official',       promptFile: 'official.md',       autoBuilt: false, defaultModel: 'inherit' },
  { key: 'xSignal',        promptFile: 'x-signal.md',       autoBuilt: false, defaultModel: 'grok' },
  { key: 'marketStructure',promptFile: 'market-structure.md',autoBuilt: true, defaultModel: 'inherit' },
  { key: 'plausibility',   promptFile: 'plausibility.md',   autoBuilt: false, defaultModel: 'inherit' },
  { key: 'skeptic',        promptFile: 'skeptic.md',        autoBuilt: false, defaultModel: 'grok' },
  { key: 'judgment',       promptFile: 'judgment.md',       autoBuilt: false, defaultModel: 'inherit', aggregator: true },
];

function loadPrompt(name) {
  const p = join(PROMPT_DIR, name);
  if (!existsSync(p)) return `(missing prompt: ${name})`;
  return readFileSync(p, 'utf8');
}

export function buildEnvelopes({ market, settlement, marketStructure }, { modelOverrides = {} } = {}) {
  const ctx = {
    market_id:   market.id,
    market_url:  market.url,
    market_title: market.title,
    asOf:        market.asOf,
    rules:       settlement?.rules ?? '',
    actingInterim: settlement?.actingInterim ?? '',
    boardSummary: (marketStructure?.board ?? [])
      .slice(0, 10)
      .map((c) => `${c.candidate}: ${c.yesCents ?? '?'}¢ YES, OI ${Math.round(c.oi ?? 0)}`)
      .join('\n'),
  };

  return BRANCHES.filter((b) => !b.autoBuilt && !b.aggregator).map((b) => ({
    branch: b.key,
    model:  modelOverrides[b.key] ?? b.defaultModel,
    prompt: interpolate(loadPrompt(b.promptFile), ctx),
    expectedOutputPath: `${b.key}.json`,
  }));
}

// Build the judgment envelope from already-merged branch JSON. The judgment
// branch reads only merged JSON — it is forbidden from introducing new facts.
export function buildJudgmentEnvelope(merged, { modelOverrides = {} } = {}) {
  const spec = BRANCHES.find((b) => b.key === 'judgment');
  const ctx = {
    market_id:   merged.market?.id ?? '',
    market_url:  merged.market?.url ?? '',
    market_title:merged.market?.title ?? '',
    asOf:        merged.market?.asOf ?? '',
    mergedJson:  JSON.stringify(merged, null, 2),
  };
  return {
    branch: 'judgment',
    model:  modelOverrides.judgment ?? spec.defaultModel,
    prompt: interpolate(loadPrompt(spec.promptFile), ctx),
    expectedOutputPath: 'judgment.json',
    inputsOnly: true,
  };
}

function interpolate(tpl, ctx) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (ctx[k] ?? `<missing:${k}>`));
}

// Load per-branch JSONs from a directory. Each file must be named `<branchKey>.json`.
export function loadBranchesDir(dir) {
  if (!dir || !existsSync(dir)) return {};
  const out = {};
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const key = f.replace(/\.json$/, '');
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    } catch (e) {
      throw new Error(`Failed to parse ${join(dir, f)}: ${e.message}`);
    }
    // Auto-unwrap: branch outputs sometimes wrap their payload under a top-level
    // key matching the branch name (e.g. judgment.json => { judgment: {...} }).
    // Unwrap so merged[key] is the inner object the renderer expects.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && Object.keys(parsed).length === 1 && Object.prototype.hasOwnProperty.call(parsed, key)) {
      parsed = parsed[key];
    }
    out[key] = parsed;
  }
  return out;
}

// Merge: auto-built market/settlement/marketStructure win unless a branchesDir
// override explicitly provides them. LLM branches override empty defaults.
export function mergeBranches(autoBuilt, fromDir, hand = {}) {
  return { ...autoBuilt, ...hand, ...fromDir,
    // ensure auto-built market always overrides meta (it has live asOf)
    market: { ...autoBuilt.market, ...(fromDir.market ?? hand.market ?? {}) },
  };
}
