#!/usr/bin/env node
// Polling runner: read state/mlb/<DATE>/slate-run-plan.json and fire any
// report windows whose report_at_utc has arrived (within --grace-minutes),
// using idempotency_key to avoid duplicate sends. Designed to be called
// every N minutes by a single recurring cron job. No trades.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const opts = { date: null, stateRoot: 'state', graceMinutes: 60 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--date') opts.date = argv[++i];
    else if (a === '--state-root') opts.stateRoot = argv[++i];
    else if (a === '--grace-minutes') opts.graceMinutes = Number(argv[++i]);
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!opts.date) opts.date = new Date().toISOString().slice(0, 10);
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node scripts/mlb/run-due-windows.mjs [--date YYYY-MM-DD] [--state-root state] [--grace-minutes 60]');
    return;
  }
  const planPath = resolve(opts.stateRoot, 'mlb', opts.date, 'slate-run-plan.json');
  if (!existsSync(planPath)) {
    console.log(`[mlb-run-due] no plan for ${opts.date} (${planPath}) — nothing to do`);
    return;
  }
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const now = Date.now();
  const due = (plan.report_windows || []).filter((w) => {
    if (w.status === 'rendered' || w.status === 'sent') return false;
    const t = Date.parse(w.report_at_utc);
    return Number.isFinite(t) && t <= now && (now - t) <= opts.graceMinutes * 60_000;
  });
  if (!due.length) {
    console.log(`[mlb-run-due] no due windows (date=${opts.date}, total=${(plan.report_windows||[]).length})`);
    return;
  }
  for (const w of due) {
    console.log(`[mlb-run-due] firing cluster=${w.cluster_id} report_at=${w.report_at_utc}`);
    const r = spawnSync('node', [
      'scripts/mlb/pre-lock-report.mjs',
      '--date', opts.date,
      '--state-root', opts.stateRoot,
      '--cluster', w.cluster_id,
      '--dry-run',
    ], { stdio: 'inherit' });
    if (r.status !== 0) {
      console.error(`[mlb-run-due] cluster=${w.cluster_id} exited status=${r.status}`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`[mlb-run-due] error: ${err.message}`);
    process.exit(1);
  });
}
