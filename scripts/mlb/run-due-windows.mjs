#!/usr/bin/env node
// Polling runner: read state/mlb/<DATE>/slate-run-plan.json and fire any
// report windows whose report_at_utc has arrived (within --grace-minutes),
// using idempotency_key to avoid duplicate sends. Designed to be called
// every N minutes by a single recurring cron job. No trades.
//
// Quiet mode: routine logs go to a local log file; only hard errors go to stderr.

import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const LOG_PATH = resolve('logs', 'mlb-prelock-reporter.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, line);
  } catch {
    // If logging fails, silently drop — do not spam cron stdout.
  }
}

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
    log(`no plan for ${opts.date} (${planPath}) — nothing to do`);
    return;
  }
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const now = Date.now();
  const due = (plan.report_windows || []).filter((w) => {
    if (w.status === 'sent') return false;
    const t = Date.parse(w.report_at_utc);
    const isInitialDue = Number.isFinite(t) && t <= now && (now - t) <= opts.graceMinutes * 60_000;
    if (w.status !== 'rendered' && isInitialDue) return true;
    // One-shot final retry if lineups were still pending at first render.
    if (w.status === 'rendered' && !w.final_retry_done) {
      const r = Date.parse(w.final_retry_at_utc);
      if (Number.isFinite(r) && r <= now && (now - r) <= opts.graceMinutes * 60_000) {
        const pendingLineups = w.lineup_status === 'pending' || (w.clear_lean_count ?? 0) === 0;
        return pendingLineups;
      }
    }
    return false;
  });
  if (!due.length) {
    log(`no due windows (date=${opts.date}, total=${(plan.report_windows||[]).length})`);
    return;
  }

  // Composite-only dispatch: fire one composite refresh for all due windows.
  // pre-lock-report.mjs (legacy board-only path) is intentionally bypassed here.
  const clusterIds = due.map((w) => w.cluster_id).join(', ');
  log(`firing composite refresh for ${due.length} due window(s): ${clusterIds}`);
  const r = spawnSync('node', [
    'scripts/mlb/late-slate-composite-refresh.mjs',
    '--date', opts.date,
    '--state-root', opts.stateRoot,
    '--no-send',  // _send-due.mjs cron handles Telegram delivery
  ], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`[mlb-run-due] composite refresh exited status=${r.status}`);
  }

  // Mark each triggered cluster window as rendered with a non-deliverable source
  // so it is not re-fired during the grace window by the next poll iteration.
  try {
    const { writeFileSync } = await import('node:fs');
    const cur = JSON.parse(readFileSync(planPath, 'utf8'));
    for (const fired of due) {
      for (const x of cur.report_windows || []) {
        if (x.cluster_id === fired.cluster_id && x.status !== 'sent') {
          x.status = 'rendered';
          x.last_rendered_utc = new Date().toISOString();
          x.source = 'composite-refresh-trigger';
          if (fired.status === 'rendered') x.final_retry_done = true;
        }
      }
    }
    writeFileSync(planPath, JSON.stringify(cur, null, 2));
    log(`marked ${due.length} window(s) as rendered`);
  } catch (e) {
    console.error(`[mlb-run-due] failed to mark windows rendered: ${e.message}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`[mlb-run-due] error: ${err.message}`);
    process.exit(1);
  });
}
