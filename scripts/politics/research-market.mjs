#!/usr/bin/env node
// Orchestrator for the politics-market research swarm (Phase 2).
//
// Modes:
//   live (default): fetch Kalshi → auto-build settlement+market+marketStructure
//                   → write prompt envelopes → merge any branchesDir outputs
//                   → validate → render → write report.
//   replay:         skip Kalshi, read cached branches.json or branchesDir only.
//   envelopes-only: produce prompt envelopes for an operator/cron to dispatch.
//
// CLI:
//   --market <id>          required (event ticker, e.g. KXNEXTAG-29)
//   --url <url>            optional public market URL
//   --out <path>           markdown report path
//   --branches-json <path> legacy single-file branches input
//   --branches-dir <dir>   per-branch JSON inputs (official.json, etc.)
//   --cache-dir <dir>      where to write auto-built branches + envelopes
//   --mode live|replay|envelopes-only
//   --model-xsignal grok|inherit
//   --model-skeptic grok|inherit
//   --offline              skip Kalshi fetch (uses cached fetch.json if present)
//
// Exit codes: 0 ok, 2 bad args, 3 schema failure (after repair attempt),
//             4 Kalshi blocker, 5 forbidden-language hit in rendered report.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { renderReport } from './lib/report-render.mjs';
import { fetchEventMarkets, buildMarketBranches } from './lib/kalshi-fetch.mjs';
import { buildEnvelopes, buildJudgmentEnvelope, loadBranchesDir, mergeBranches, BRANCHES } from './lib/branch-dispatch.mjs';
import { validateBranches, scanForbiddenLanguage } from './lib/branch-contract.mjs';
import { crossCheckBranches } from './lib/integrity-check.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[key] = val;
    }
  }
  return out;
}

export function buildBranches({ market, url, branchesJsonPath }) {
  // Legacy entry point preserved for tests + back-compat.
  let branches = {};
  if (branchesJsonPath) branches = JSON.parse(readFileSync(branchesJsonPath, 'utf8'));
  branches.market = {
    id:    branches.market?.id    ?? market,
    url:   branches.market?.url   ?? url,
    title: branches.market?.title ?? `Kalshi ${market}`,
    asOf:  branches.market?.asOf  ?? new Date().toISOString(),
  };
  branches.meta = branches.meta ?? {};
  return branches;
}

export async function orchestrate(opts) {
  const {
    market, url, out, mode = 'live',
    branchesJsonPath, branchesDir, cacheDir,
    modelOverrides = {}, offline = false, fetchImpl,
  } = opts;
  if (!market) throw new Error('orchestrate: market required');

  let auto = { market: { id: market, url, title: `Kalshi ${market}`, asOf: new Date().toISOString() } };
  let raw  = null;

  // --- live fetch (skipped on replay / offline) ---
  if (mode !== 'replay') {
    const cachePath = cacheDir ? join(cacheDir, 'fetch.json') : null;
    if (offline && cachePath && existsSync(cachePath)) {
      raw = JSON.parse(readFileSync(cachePath, 'utf8'));
    } else if (!offline) {
      try {
        raw = await fetchEventMarkets(market, { fetchImpl });
      } catch (e) {
        const err = new Error(`Kalshi blocker: ${e.message}`);
        err.code = 4;
        throw err;
      }
      if (cachePath) {
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(cachePath, JSON.stringify(raw, null, 2));
      }
    }
    if (raw) auto = { ...auto, ...buildMarketBranches(raw, { eventTicker: market, eventUrl: url }) };
  } else if (cacheDir) {
    // Replay: hydrate settlement + marketStructure from prior fetch.json so the
    // judgment branch can legitimately cite them. If no cache, replay still
    // works against branchesDir/branchesJsonPath alone.
    const cachePath = join(cacheDir, 'fetch.json');
    if (existsSync(cachePath)) {
      raw = JSON.parse(readFileSync(cachePath, 'utf8'));
      auto = { ...auto, ...buildMarketBranches(raw, { eventTicker: market, eventUrl: url }) };
    }
  }

  // --- branch envelopes (always written when cacheDir set) ---
  let envelopes = [];
  if (auto.settlement) {
    envelopes = buildEnvelopes(auto, { modelOverrides });
    if (cacheDir) {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, 'envelopes.json'), JSON.stringify(envelopes, null, 2));
    }
  }
  if (mode === 'envelopes-only') return { envelopes, autoBuilt: auto };

  // --- gather LLM-produced branches ---
  let fromDir = {};
  if (branchesDir) fromDir = loadBranchesDir(branchesDir);
  let hand = {};
  if (branchesJsonPath) hand = JSON.parse(readFileSync(branchesJsonPath, 'utf8'));

  let merged = mergeBranches(auto, fromDir, hand);

  // --- judgment envelope (Phase 3): always written when cacheDir set so the
  // operator can dispatch it after research branches complete. If branchesDir
  // already includes judgment.json it will flow through via loadBranchesDir
  // above and be rendered into the report.
  if (cacheDir) {
    const jEnv = buildJudgmentEnvelope(merged, { modelOverrides });
    writeFileSync(join(cacheDir, 'judgment-envelope.json'), JSON.stringify(jEnv, null, 2));
  }
  if (mode === 'judgment-envelope-only') {
    return { judgmentEnvelope: buildJudgmentEnvelope(merged, { modelOverrides }), merged };
  }

  // --- validate (one repair attempt, then fail) ---
  let v = validateBranches(merged);
  if (!v.ok) {
    const v2 = validateBranches(merged, { repair: true });
    if (!v2.ok) {
      const e = new Error(`Branch schema invalid after repair: ${v2.errors.join('; ')}`);
      e.code = 3;
      throw e;
    }
    merged = v2.repaired;
  }

  // --- cross-branch integrity (Phase 4) ---
  const integrity = crossCheckBranches(merged);
  if (!integrity.ok) {
    const e = new Error(`Integrity check failed: ${integrity.errors.join('; ')}`);
    e.code = 6;
    throw e;
  }
  if (integrity.warnings.length) {
    for (const w of integrity.warnings) console.error(`WARN: ${w}`);
    merged.meta = merged.meta ?? {};
    merged.meta.integrityWarnings = integrity.warnings;
  }

  // --- render ---
  const md = renderReport(merged);

  // --- forbidden-language guard on rendered output ---
  const scan = scanForbiddenLanguage(md);
  if (!scan.clean) {
    const e = new Error(`Forbidden language in report: ${JSON.stringify(scan.hits)}`);
    e.code = 5;
    throw e;
  }

  // --- write ---
  if (out) {
    const abs = resolve(out);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, md);
    if (cacheDir) writeFileSync(join(cacheDir, 'branches.merged.json'), JSON.stringify(merged, null, 2));
    return { path: abs, bytes: md.length, envelopes, scan };
  }
  return { path: null, bytes: md.length, md, envelopes, scan };
}

// Back-compat sync entry point used by existing tests.
export function runResearch(opts) {
  const branches = buildBranches(opts);
  const md       = renderReport(branches);
  if (opts.out) {
    const abs = resolve(opts.out);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, md);
    return { path: abs, bytes: md.length };
  }
  return { path: null, bytes: md.length, md };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.market) {
    console.error('usage: research-market.mjs --market <id> [--url <url>] [--out <path>] [--branches-dir <dir>] [--cache-dir <dir>] [--mode live|replay|envelopes-only] [--model-xsignal grok] [--model-skeptic grok] [--offline]');
    process.exit(2);
  }
  const modelOverrides = {};
  if (args['model-xsignal']) modelOverrides.xSignal = args['model-xsignal'];
  if (args['model-skeptic']) modelOverrides.skeptic = args['model-skeptic'];

  orchestrate({
    market: args.market,
    url:    args.url,
    out:    args.out || null,
    mode:   args.mode || 'live',
    branchesJsonPath: args['branches-json'] || null,
    branchesDir:      args['branches-dir'] || null,
    cacheDir:         args['cache-dir'] || null,
    offline:          !!args.offline,
    modelOverrides,
  }).then((r) => {
    if (r.path) console.log(`wrote ${r.bytes} bytes → ${r.path}`);
    else if (r.md) process.stdout.write(r.md);
    if (r.envelopes?.length) console.error(`(${r.envelopes.length} envelopes built; model overrides: ${JSON.stringify(modelOverrides)})`);
  }).catch((e) => {
    console.error(`ERROR[${e.code ?? 1}]: ${e.message}`);
    process.exit(e.code ?? 1);
  });
}
