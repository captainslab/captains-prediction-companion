#!/usr/bin/env node
// Polling runner: read state/mlb/<DATE>/slate-run-plan.json and fire any
// report windows whose report_at_utc has arrived (within --grace-minutes),
// using idempotency_key to avoid duplicate sends. Designed to be called
// every N minutes by a single recurring cron job. No trades.
//
// Quiet mode: routine logs go to a local log file; only hard errors go to stderr.

import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runPregameRefresh } from './mlb-workspace.mjs';

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
  const opts = { date: null, stateRoot: 'state', graceMinutes: 5 };
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

export function selectDueWindows(plan, { nowMs = Date.now(), graceMinutes = 5 } = {}) {
  return (plan?.report_windows || []).filter((w) => {
    if (w.status === 'sent' || w.status === 'rendered' || w.status === 'blocked' || w.status === 'processing') return false;
    const candidate = w.status === 'retry_pending'
      ? w.retry_at_utc?.[w.retry_index ?? 0]
      : w.report_at_utc;
    const t = Date.parse(candidate);
    return Number.isFinite(t) && t <= nowMs && (nowMs - t) <= graceMinutes * 60_000;
  });
}

function readRecords(stateRoot, date, filename) {
  const path = resolve(stateRoot, 'mlb', date, 'discovery', filename);
  if (!existsSync(path)) return [];
  try { return JSON.parse(readFileSync(path, 'utf8')).records ?? []; } catch { return []; }
}

function requiredInputsReady(stateRoot, date, gamePk) {
  const stats = readRecords(stateRoot, date, 'stats_adapter.json').find((r) => String(r.game_pk) === String(gamePk));
  const context = readRecords(stateRoot, date, 'context_adapter.json').find((r) => String(r.game_pk) === String(gamePk));
  const missing = [];
  if (!stats) missing.push('stats_adapter');
  if (!context) missing.push('context_adapter');
  if (context && context.lineup_status !== 'confirmed_or_boxscore_available') missing.push('confirmed_lineup');
  return { ok: missing.length === 0, missing };
}

function writePlanAtomic(planPath, plan) {
  const tmp = `${planPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(plan, null, 2));
  renameSync(tmp, planPath);
}

export async function runDueWindows({
  options: injectedOptions = null,
  argv = process.argv.slice(2),
  nowMs = Date.now(),
  refreshPregame = runPregameRefresh,
  spawn = spawnSync,
  logFn = log,
} = {}) {
  const opts = injectedOptions ?? parseArgs(argv);
  if (opts.help) {
    console.log('Usage: node scripts/mlb/run-due-windows.mjs [--date YYYY-MM-DD] [--state-root state] [--grace-minutes 60]');
    return;
  }
  const planPath = resolve(opts.stateRoot, 'mlb', opts.date, 'slate-run-plan.json');
  if (!existsSync(planPath)) {
    logFn(`no plan for ${opts.date} (${planPath}) — nothing to do`);
    return;
  }
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const due = selectDueWindows(plan, { nowMs, graceMinutes: opts.graceMinutes });
  if (!due.length) {
    logFn(`no due windows (date=${opts.date}, total=${(plan.report_windows||[]).length})`);
    return;
  }

  for (const fired of due) {
    if (fired.game_pk == null) {
      logFn(`blocked ${fired.cluster_id} — official game_pk missing`);
      continue;
    }
    try {
      await refreshPregame([
        '--date', opts.date,
        '--state-root', opts.stateRoot,
        '--live-readonly',
      ]);
    } catch (error) {
      const cur = JSON.parse(readFileSync(planPath, 'utf8'));
      const target = (cur.report_windows || []).find((w) => w.idempotency_key === fired.idempotency_key);
      if (target) {
        target.last_refresh_error_utc = new Date().toISOString();
        target.refresh_error = error instanceof Error ? error.message : String(error);
        writePlanAtomic(planPath, cur);
      }
      logFn(`skipped game_pk=${fired.game_pk} — pregame refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const readiness = requiredInputsReady(opts.stateRoot, opts.date, fired.game_pk);
    if (!readiness.ok) {
      const cur = JSON.parse(readFileSync(planPath, 'utf8'));
      const target = (cur.report_windows || []).find((w) => w.idempotency_key === fired.idempotency_key);
      if (target) {
        const nextRetry = (target.retry_index ?? 0) + 1;
        target.last_input_check_utc = new Date().toISOString();
        target.missing_inputs = readiness.missing;
        if (nextRetry < (target.retry_at_utc || []).length) {
          target.status = 'retry_pending';
          target.retry_index = nextRetry;
          logFn(`deferred game_pk=${fired.game_pk} missing=${readiness.missing.join(',')} retry=${nextRetry}`);
        } else {
          target.status = 'blocked';
          target.blocked_reason = 'required_game_inputs_unavailable';
          logFn(`blocked game_pk=${fired.game_pk} missing=${readiness.missing.join(',')}`);
        }
        writePlanAtomic(planPath, cur);
      }
      continue;
    }
    const claimed = JSON.parse(readFileSync(planPath, 'utf8'));
    const claim = (claimed.report_windows || []).find((w) => w.idempotency_key === fired.idempotency_key);
    if (!claim || claim.status !== 'pending' && claim.status !== 'retry_pending') continue;
    claim.status = 'processing';
    claim.claimed_at_utc = new Date().toISOString();
    writePlanAtomic(planPath, claimed);
    logFn(`firing game packet game_pk=${fired.game_pk} window=${fired.cluster_id}`);
    const r = spawn('node', [
      'scripts/mlb/late-slate-composite-refresh.mjs',
      '--date', opts.date,
      '--state-root', opts.stateRoot,
      '--game-pk', String(fired.game_pk),
      '--no-send',
      '--no-plan-window',
    ], { stdio: 'inherit' });
    if (r.status !== 0) {
      console.error(`[mlb-run-due] game_pk=${fired.game_pk} exited status=${r.status}`);
      const failed = JSON.parse(readFileSync(planPath, 'utf8'));
      const target = (failed.report_windows || []).find((w) => w.idempotency_key === fired.idempotency_key);
      if (target) {
        const nextRetry = (target.retry_index ?? 0) + 1;
        if (nextRetry < (target.retry_at_utc || []).length) {
          target.status = 'retry_pending';
          target.retry_index = nextRetry;
        } else {
          target.status = 'blocked';
          target.blocked_reason = 'game_packet_generation_failed';
        }
        writePlanAtomic(planPath, failed);
      }
      continue;
    }
    const stateDir = resolve(opts.stateRoot, 'mlb', opts.date);
    const stem = `composite-refresh-${fired.game_pk}`;
    const cur = JSON.parse(readFileSync(planPath, 'utf8'));
    const target = (cur.report_windows || []).find((w) => w.idempotency_key === fired.idempotency_key);
    if (target) {
      target.status = 'rendered';
      target.last_rendered_utc = new Date().toISOString();
      target.last_artifact = resolve(stateDir, `${stem}-verbose.txt`);
      target.compact_artifact = resolve(stateDir, `${stem}-compact.txt`);
      target.article_artifact = resolve(stateDir, `${stem}-article.txt`);
      target.source = 'composite-refresh-trigger';
    }
    writePlanAtomic(planPath, cur);
    logFn(`marked game_pk=${fired.game_pk} rendered`);
  }
}

async function main() {
  await runDueWindows();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`[mlb-run-due] error: ${err.message}`);
    process.exit(1);
  });
}
