#!/usr/bin/env node
// One-shot helper invoked by cron: send rendered+undelivered composite windows for TODAY CT.
// MLB composite-only: only windows from the composite pipeline are delivered.
// Forbidden-string guard blocks any artifact that contains pricing or legacy board content.
// Uses America/Chicago date so late-night games stay on the correct slate date.
//
// Script-owned delivery only. No LLM agent. No send_message.
// Idempotent: delivered_idempotency_key prevents duplicate sends.
//
// Usage:
//   node scripts/mlb/_send-due.mjs [--date YYYY-MM-DD] [--state-root state] [--dry-run]
//
// Exit codes:
//   0 = ok (nothing to send, or sent successfully)
//   1 = unexpected error
//   2 = telegram env missing

import fs from 'node:fs';
import path from 'node:path';
import { resolve, dirname } from 'node:path';
import { mkdirSync, appendFileSync } from 'node:fs';

function parseArgs(argv) {
  const opts = { date: null, stateRoot: 'state', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') opts.date = argv[++i];
    else if (a === '--state-root') opts.stateRoot = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!opts.date) opts.date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const TODAY = opts.date;
const PLAN = path.join(opts.stateRoot, 'mlb', TODAY, 'slate-run-plan.json');
if (!fs.existsSync(PLAN)) { log(`no plan for ${TODAY}`); process.exit(0); }

// Accept both the legacy trigger source and the direct composite-refresh source.
const COMPOSITE_SOURCES = new Set([
  'late-slate-composite-refresh',
  'composite-refresh-trigger',
]);

const LOG_PATH = resolve('logs', 'mlb-prelock-delivery.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, line);
  } catch {
    // If logging fails, silently drop — do not spam cron stdout.
  }
}

// Strings that must never appear in an MLB Telegram artifact.
const FORBIDDEN = [
  'BOARD_ONLY', 'MARKET-ONLY', 'MARKET_ONLY', 'KXMLB',
  '¢', 'open interest', 'open_interest',
  ' bid', ' ask', ' volume',
];

export function hasForbiddenContent(text) {
  const lower = text.toLowerCase();
  return FORBIDDEN.some((s) => lower.includes(s.toLowerCase()));
}

const plan = JSON.parse(fs.readFileSync(PLAN, 'utf8'));
const windows = plan.report_windows || [];

const writePlan = () => {
  const tmp = PLAN + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(plan, null, 2));
  fs.renameSync(tmp, PLAN);
};

// Fallback: if a window lacks last_artifact, try to locate the newest
// composite-refresh artifact for this date on disk.
function findCompositeArtifact(stateRoot, date) {
  const dir = path.join(stateRoot, 'mlb', date);
  if (!fs.existsSync(dir)) return null;
  const candidates = [];
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith('composite-refresh') && entry.endsWith('.txt')) {
      const full = path.join(dir, entry);
      const st = fs.statSync(full);
      candidates.push({ path: full, mtime: st.mtimeMs });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].path;
}

const sendList = [];
for (const w of windows) {
  if (w.status !== 'rendered') continue;
  if (w.delivered_idempotency_key && w.delivered_idempotency_key === w.idempotency_key) continue;

  // Composite-only guard: skip windows not produced by the composite pipeline.
  if (!COMPOSITE_SOURCES.has(w.source)) {
    log(`skip ${w.cluster_id} — not composite source (${w.source ?? 'none'})`);
    continue;
  }

  // Resolve artifact path: prefer compact, then last_artifact, then disk fallback.
  let artifactPath = null;
  if (w.compact_artifact && fs.existsSync(w.compact_artifact)) {
    artifactPath = w.compact_artifact;
  } else if (w.last_artifact && fs.existsSync(w.last_artifact)) {
    artifactPath = w.last_artifact;
  } else {
    const fallback = findCompositeArtifact(opts.stateRoot, TODAY);
    if (fallback) {
      artifactPath = fallback;
      // Heal the plan so the next poll finds the artifact immediately.
      w.last_artifact = fallback;
    }
  }

  if (!artifactPath || !fs.existsSync(artifactPath)) {
    w.status = 'error';
    w.error = 'artifact_missing';
    continue;
  }
  sendList.push({ window: w, artifactPath });
}
writePlan();

if (sendList.length === 0) { log('no due windows to send'); process.exit(0); }

// Load env from project .env if present
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}
loadEnv('.env');
loadEnv('.env.local');

async function tgSendDocument(filePath, caption) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_HOME_CHANNEL;
  if (!token || !chat) throw new Error('telegram env missing');
  const form = new FormData();
  form.append('chat_id', chat);
  form.append('caption', caption);
  form.append('document', new Blob([fs.readFileSync(filePath)], { type: 'text/plain' }), path.basename(filePath));
  const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: 'POST',
    body: form,
  });
  const j = await res.json();
  if (!j.ok) throw new Error('telegram fail: ' + JSON.stringify(j));
  return j.result.message_id;
}

function countPicks(text) {
  let n = 0;
  for (const ln of text.split('\n')) {
    if (/^[-★◆◇]\s*(PICK|PLAY|CLEAR|EVIDENCE_LEAN|LEAN)/i.test(ln)) { n++; continue; }
    const m = ln.match(/^- (Decision|Confidence):\s*(.+?)\s*$/);
    if (m && /^(CLEAR|EVIDENCE_LEAN|LEAN)/i.test(m[2]) && !/^NO CLEAR PICK/i.test(m[2])) n++;
  }
  return n;
}

const summary = [];
for (const { window: w, artifactPath } of sendList) {
  const text = fs.readFileSync(artifactPath, 'utf8');
  const clearLean = countPicks(text);
  if (clearLean === 0) {
    log(`skip ${w.cluster_id} — no picks`);
    continue;
  }
  const mode = (artifactPath === w.compact_artifact) ? 'compact' : 'verbose';
  const caption = `MLB ${w.cluster_id} — ${clearLean} pick${clearLean !== 1 ? 's' : ''}`;

  // Forbidden-string guard: never deliver an artifact that contains pricing or legacy board labels.
  if (hasForbiddenContent(text)) {
    console.error(`BLOCK ${w.cluster_id} — artifact contains forbidden content (pricing/board data). Not sent.`);
    continue;
  }
  if (opts.dryRun) {
    log(`[dry-run] would send ${w.cluster_id} (${mode}) — ${clearLean} pick(s)`);
    continue;
  }
  const id = await tgSendDocument(artifactPath, caption);
  w.status = 'sent';
  w.delivered_idempotency_key = w.idempotency_key;
  w.delivered_utc = new Date().toISOString();
  w.delivered_telegram_message_ids = [id];
  w.delivered_mode = mode;
  w.clear_lean_count = clearLean;
  writePlan();
  log(`sent ${w.cluster_id} (${mode}) — ${clearLean} pick(s), msg_id=${id}`);
  summary.push(`${w.cluster_id}(${mode})`);
}

if (summary.length) {
  log(`delivery complete: ${summary.length} window(s): ${summary.join(', ')}`);
}
