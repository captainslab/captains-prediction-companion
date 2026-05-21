#!/usr/bin/env node
// Orchestrator for the politics-market research swarm.
// Reads a branches.json (subagent outputs) and renders a structured report.
// When no --branches-json is given, renders a scaffold report that documents
// the workflow but flags every section as branch-not-run.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { renderReport } from './lib/report-render.mjs';

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
  let branches = {};
  if (branchesJsonPath) {
    branches = JSON.parse(readFileSync(branchesJsonPath, 'utf8'));
  }
  branches.market = {
    id:    branches.market?.id    ?? market,
    url:   branches.market?.url   ?? url,
    title: branches.market?.title ?? `Kalshi ${market}`,
    asOf:  branches.market?.asOf  ?? new Date().toISOString(),
  };
  branches.meta = branches.meta ?? {};
  return branches;
}

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
    console.error('usage: research-market.mjs --market <id> --url <url> [--branches-json path] [--out path]');
    process.exit(2);
  }
  const res = runResearch({
    market: args.market,
    url: args.url,
    branchesJsonPath: args['branches-json'] || null,
    out: args.out || null,
  });
  if (res.path) console.log(`wrote ${res.bytes} bytes → ${res.path}`);
  else          process.stdout.write(res.md);
}
