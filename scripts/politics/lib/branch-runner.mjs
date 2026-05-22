// Phase 5 branch executor.
//
// Pluggable adapter interface: an adapter is `{ kind, canRouteTo(model),
// execute({ branch, model, prompt, inputsOnly }, { signal }) -> Promise<string> }`.
// execute() must resolve to the RAW JSON STRING the branch wrote (the runner
// owns parsing + repair + validation surface).
//
// Built-in adapters:
//   - fakeAdapter(handlers, { canRoute }) — in-process map, for tests.
//   - cacheAdapter(branchesDir) — replays pre-existing branches/*.json from a
//                                 prior operator dispatch. Proof-of-wiring path.
//   - cmdAdapter(cmd, opts)    — shells out per branch; cmd receives the prompt
//                                 on stdin and must emit JSON on stdout.
//                                 Lets an operator wire Hermes/delegate_task or
//                                 any other LLM runtime without changing this file.
//
// Status records (returned per branch in `execution[]` and stitched into
// `merged.meta.branchExecution`):
//   { branch, status: 'ok'|'repaired'|'failed'|'timeout'|'fallback-routed',
//     model, requestedModel, ms, error?, repairUsed?: boolean }
//
// 'fallback-routed' is a *parallel* status to ok/repaired/failed — recorded
// alongside them. The runner emits it as a leading record for visibility, then
// the actual ok/repaired record follows for the same branch.

import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

class TimeoutError extends Error {
  constructor(ms) { super(`timed out after ${ms}ms`); this.name = 'TimeoutError'; }
}

// --- JSON parse with one repair retry --------------------------------------

export function parseBranchJson(raw, { branchKey } = {}) {
  if (typeof raw !== 'string') throw new Error('parseBranchJson: raw must be string');
  try {
    return { value: maybeUnwrap(JSON.parse(raw), branchKey), repaired: false };
  } catch (e) {
    const repaired = repairJson(raw);
    if (repaired == null) throw e;
    try {
      return { value: maybeUnwrap(JSON.parse(repaired), branchKey), repaired: true };
    } catch (e2) {
      const err = new Error(`unparseable after repair: ${e2.message}`);
      err.original = e.message;
      throw err;
    }
  }
}

function repairJson(raw) {
  // Strip ```json fences and trim to outermost {...} or [...].
  const noFence = raw.replace(/^[\s\S]*?```(?:json)?\s*/i, '').replace(/```[\s\S]*$/i, '');
  const candidate = noFence.trim() || raw.trim();
  const first = candidate.search(/[{\[]/);
  if (first < 0) return null;
  const open = candidate[first];
  const close = open === '{' ? '}' : ']';
  const last = candidate.lastIndexOf(close);
  if (last <= first) return null;
  return candidate.slice(first, last + 1);
}

function maybeUnwrap(parsed, key) {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && key) {
    const keys = Object.keys(parsed);
    if (keys.length === 1 && keys[0] === key) return parsed[key];
  }
  return parsed;
}

// --- adapters ---------------------------------------------------------------

export function fakeAdapter(handlers, { canRoute = ['inherit'] } = {}) {
  const routable = new Set(canRoute);
  return {
    kind: 'fake',
    canRouteTo(model) { return routable.has(model); },
    async execute({ branch, model, prompt, inputsOnly }) {
      const h = handlers[branch];
      if (!h) throw new Error(`fakeAdapter: no handler for branch "${branch}"`);
      const r = await h({ branch, model, prompt, inputsOnly });
      if (typeof r === 'string') return r;
      return JSON.stringify(r);
    },
  };
}

export function cacheAdapter(branchesDir) {
  return {
    kind: 'cache',
    canRouteTo() { return true }, // cache adapter doesn't care about model
    async execute({ branch }) {
      const p = join(branchesDir, `${branch}.json`);
      if (!existsSync(p)) throw new Error(`cacheAdapter: ${p} missing`);
      return readFileSync(p, 'utf8');
    },
  };
}

// cmdAdapter: spawn `cmd` per branch. Prompt goes to stdin. Stdout must be JSON.
// `env` is passed BRANCH=<key> and MODEL=<route>. Honors signal for timeouts.
export function cmdAdapter(cmd, { shell = true, canRoute = ['inherit'] } = {}) {
  const routable = new Set(canRoute);
  return {
    kind: 'cmd',
    canRouteTo(model) { return routable.has(model); },
    async execute({ branch, model, prompt, inputsOnly }, { signal } = {}) {
      return await new Promise((resolveP, rejectP) => {
        const child = spawn(cmd, [], {
          shell,
          env: { ...process.env, POLITICS_BRANCH: branch, POLITICS_MODEL: model,
                 POLITICS_INPUTS_ONLY: inputsOnly ? '1' : '0' },
          stdio: ['pipe', 'pipe', 'inherit'],
        });
        let out = '';
        child.stdout.on('data', (b) => { out += b.toString('utf8'); });
        child.on('error', rejectP);
        child.on('close', (code) => {
          if (code !== 0) return rejectP(new Error(`cmdAdapter: exit ${code}`));
          resolveP(out);
        });
        if (signal) signal.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
        child.stdin.end(prompt);
      });
    },
  };
}

// --- runner -----------------------------------------------------------------

async function withTimeout(promiseFn, ms) {
  const ac = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { ac.abort(); reject(new TimeoutError(ms)); }, ms);
  });
  try {
    return await Promise.race([promiseFn(ac.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function runOne(envelope, adapter, { timeoutMs }) {
  const t0 = Date.now();
  const requestedModel = envelope.model;
  const records = [];
  let effectiveModel = requestedModel;

  // Fallback routing: requested non-inherit (e.g. 'grok') but adapter can't.
  if (requestedModel !== 'inherit' && !adapter.canRouteTo(requestedModel)) {
    records.push({
      branch: envelope.branch, status: 'fallback-routed',
      requestedModel, model: 'inherit',
      ms: 0, note: `adapter (${adapter.kind}) cannot route ${requestedModel}; using inherit`,
    });
    effectiveModel = 'inherit';
  }

  try {
    const raw = await withTimeout(
      (signal) => adapter.execute({ ...envelope, model: effectiveModel }, { signal }),
      timeoutMs,
    );
    let parsed;
    try {
      parsed = parseBranchJson(raw, { branchKey: envelope.branch });
    } catch (e) {
      records.push({
        branch: envelope.branch, status: 'failed', model: effectiveModel, requestedModel,
        ms: Date.now() - t0, error: `parse: ${e.message}`,
      });
      return { records, value: null };
    }
    records.push({
      branch: envelope.branch,
      status: parsed.repaired ? 'repaired' : 'ok',
      model: effectiveModel, requestedModel,
      ms: Date.now() - t0,
      repairUsed: parsed.repaired || undefined,
    });
    return { records, value: parsed.value };
  } catch (e) {
    const status = e instanceof TimeoutError ? 'timeout' : 'failed';
    records.push({
      branch: envelope.branch, status, model: effectiveModel, requestedModel,
      ms: Date.now() - t0, error: e.message,
    });
    return { records, value: null };
  }
}

async function runWithConcurrency(items, n, fn) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// runBranches: parallel research branches, then judgment serially.
// envelopes: research envelopes (no judgment).
// judgmentEnvelopeBuilder(mergedSoFar) -> envelope|null. Called AFTER research.
export async function runBranches({
  envelopes, adapter,
  judgmentEnvelopeBuilder = null,
  concurrency = 3, timeoutMs = 90_000,
  onProgress = () => {},
} = {}) {
  if (!adapter) throw new Error('runBranches: adapter required');
  if (!Array.isArray(envelopes)) throw new Error('runBranches: envelopes must be array');

  const branches = {};
  const execution = [];

  const research = await runWithConcurrency(envelopes, concurrency, async (env) => {
    const r = await runOne(env, adapter, { timeoutMs });
    for (const rec of r.records) { execution.push(rec); onProgress(rec); }
    return { branch: env.branch, value: r.value };
  });

  for (const { branch, value } of research) {
    if (value != null) branches[branch] = value;
  }

  // Judgment runs strictly after research and ONLY if all research branches
  // produced a value (otherwise it would cite empty/missing branches and fail
  // Phase 4 integrity). We still try, so the failure surfaces clearly.
  if (judgmentEnvelopeBuilder) {
    const jEnv = judgmentEnvelopeBuilder(branches);
    if (jEnv) {
      const jR = await runOne(jEnv, adapter, { timeoutMs });
      for (const rec of jR.records) { execution.push(rec); onProgress(rec); }
      if (jR.value != null) branches.judgment = jR.value;
    }
  }

  return { branches, execution };
}
