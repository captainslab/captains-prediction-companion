#!/usr/bin/env node
// 6:00 AM CT entry point.
// Builds today's slate-run-plan.json via slate-check and sends a single
// morning Telegram summary describing the day's games + report windows.
// Idempotent — re-runs in the same UTC day are skipped unless --force.
//
// No trades. No picks. Pricing is NOT used for scoring; this summary lists
// game times and planned report windows only.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSlatePlan, writePlan } from './slate-check.mjs';

function parseArgs(argv) {
  const opts = { date: null, stateRoot: 'state', force: false, noSend: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--date') opts.date = argv[++i];
    else if (a === '--state-root') opts.stateRoot = argv[++i];
    else if (a === '--force') opts.force = true;
    else if (a === '--no-send') opts.noSend = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!opts.date) {
    opts.date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  }
  return opts;
}

function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}

export function renderMorningSummary(plan) {
  const lines = [];
  lines.push(`Captain MLB — Morning Slate ${plan.date}`);
  lines.push(`generated ${plan.generated_utc.replace('T', ' ').slice(0, 16)} UTC`);
  lines.push('');
  lines.push(`Games: ${plan.game_count}    Report windows: ${(plan.report_windows || []).length}`);
  lines.push('');
  lines.push('GAMES');
  for (const g of plan.games || []) {
    const away = g.away ?? '?';
    const home = g.home ?? '?';
    const ct = g.first_pitch_ct ?? '?';
    lines.push(`  ${away} @ ${home}  — ${ct}`);
  }
  lines.push('');
  lines.push('REPORT WINDOWS  (45–60 min before first pitch of each cluster)');
  for (const w of plan.report_windows || []) {
    const at = w.report_at_ct ?? '?';
    const lead = w.lead_first_pitch_ct ?? '?';
    const gc = (w.game_keys || []).length;
    lines.push(`  ${w.cluster_id}  fire ${at}  → lead first pitch ${lead}  (${gc} game${gc === 1 ? '' : 's'})`);
  }
  lines.push('');
  lines.push('Sports model uses real sports data only. No pricing in scoring.');
  lines.push('No trades placed.');
  return lines.join('\n');
}

export function isMorningSummaryEligible(plan, { force = false } = {}) {
  return force || !plan?.morning_summary_sent_utc;
}

async function tgSendMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_HOME_CHANNEL;
  if (!token || !chat) throw new Error('telegram env missing (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)');
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error('telegram fail: ' + JSON.stringify(j));
  return j.result.message_id;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node scripts/mlb/morning-slate-summary.mjs [--date YYYY-MM-DD] [--state-root state] [--force] [--no-send]');
    return;
  }
  loadEnv('.env');
  loadEnv('.env.local');

  // Build/refresh the slate plan via slate-check (preserves delivery records).
  const planPath = resolve(opts.stateRoot, 'mlb', opts.date, 'slate-run-plan.json');
  let existing = null;
  if (existsSync(planPath)) {
    try { existing = JSON.parse(readFileSync(planPath, 'utf8')); } catch { existing = null; }
  }

  const fresh = await buildSlatePlan({ date: opts.date, prelockMinutes: 60, clusterWithin: 10 });

  // Merge: keep existing delivery records on matching cluster_ids so we never resend.
  if (existing && Array.isArray(existing.report_windows)) {
    const prior = new Map(existing.report_windows.map((w) => [w.cluster_id, w]));
    fresh.report_windows = fresh.report_windows.map((w) => {
      const p = prior.get(w.cluster_id);
      if (!p) return w;
      return {
        ...w,
        status: p.status === 'sent' || p.status === 'rendered' ? p.status : w.status,
        last_artifact: p.last_artifact ?? w.last_artifact,
        last_rendered_utc: p.last_rendered_utc ?? w.last_rendered_utc,
        delivered_idempotency_key: p.delivered_idempotency_key ?? w.delivered_idempotency_key,
        delivered_utc: p.delivered_utc ?? w.delivered_utc,
        delivered_telegram_message_ids: p.delivered_telegram_message_ids ?? w.delivered_telegram_message_ids,
        delivered_mode: p.delivered_mode ?? w.delivered_mode,
        clear_lean_count: p.clear_lean_count ?? w.clear_lean_count,
        final_retry_at_utc: p.final_retry_at_utc ?? w.final_retry_at_utc,
        final_retry_done: p.final_retry_done ?? w.final_retry_done,
        morning_summary_sent_utc: p.morning_summary_sent_utc ?? w.morning_summary_sent_utc,
      };
    });
    fresh.morning_summary_sent_utc = existing.morning_summary_sent_utc ?? null;
    fresh.morning_summary_telegram_message_id = existing.morning_summary_telegram_message_id ?? null;
  }

  // Add a one-shot final-retry timestamp 15 min after each window's report_at,
  // used by run-due-windows to re-render once if lineups were still pending.
  for (const w of fresh.report_windows) {
    if (!w.final_retry_at_utc) {
      const t = Date.parse(w.report_at_utc);
      if (Number.isFinite(t)) {
        w.final_retry_at_utc = new Date(t + 15 * 60_000).toISOString();
      }
    }
    if (w.final_retry_done == null) w.final_retry_done = false;
  }

  writePlan(opts.stateRoot, opts.date, fresh);

  const summary = renderMorningSummary(fresh);
  const summaryPath = resolve(opts.stateRoot, 'mlb', opts.date, 'morning-slate-summary.txt');
  writeFileSync(summaryPath, summary, 'utf8');

  console.log(`[mlb-morning] date=${opts.date} games=${fresh.game_count} windows=${(fresh.report_windows||[]).length}`);
  console.log(`[mlb-morning] plan=${planPath}`);
  console.log(`[mlb-morning] summary=${summaryPath}`);

  if (opts.noSend) {
    console.log('[mlb-morning] --no-send set, skipping Telegram');
    return;
  }
  if (!isMorningSummaryEligible(fresh, { force: opts.force })) {
    console.log(`[mlb-morning] morning summary already sent ${fresh.morning_summary_sent_utc}, skip (use --force to resend)`);
    return;
  }
  if (!process.env.TELEGRAM_BOT_TOKEN || !(process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_HOME_CHANNEL)) {
    console.log('[mlb-morning] telegram env missing, summary written but not sent');
    return;
  }
  try {
    const msgId = await tgSendMessage(summary);
    fresh.morning_summary_sent_utc = new Date().toISOString();
    fresh.morning_summary_telegram_message_id = msgId;
    writePlan(opts.stateRoot, opts.date, fresh);
    console.log(`[mlb-morning] telegram sent message_id=${msgId}`);
  } catch (err) {
    console.error(`[mlb-morning] telegram send failed: ${err.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`[mlb-morning] error: ${err.message}`);
    process.exit(1);
  });
}
