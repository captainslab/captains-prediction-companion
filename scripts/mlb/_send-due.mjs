#!/usr/bin/env node
// One-shot helper invoked by cron: send rendered+undelivered windows for TODAY UTC.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TODAY = new Date().toISOString().slice(0, 10);
const PLAN = `state/mlb/${TODAY}/slate-run-plan.json`;
if (!fs.existsSync(PLAN)) { console.log(`no plan for ${TODAY}`); process.exit(0); }

const plan = JSON.parse(fs.readFileSync(PLAN, 'utf8'));
const windows = plan.report_windows || [];

const writePlan = () => {
  const tmp = PLAN + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(plan, null, 2));
  fs.renameSync(tmp, PLAN);
};

const sendList = [];
for (const w of windows) {
  if (w.status !== 'rendered') continue;
  if (w.delivered_idempotency_key && w.delivered_idempotency_key === w.idempotency_key) continue;
  if (!w.last_artifact) continue;
  if (!fs.existsSync(w.last_artifact)) {
    w.status = 'error';
    w.error = 'artifact_missing';
    continue;
  }
  sendList.push(w);
}
writePlan();

if (sendList.length === 0) { console.log('no due windows to send'); process.exit(0); }

const CHUNK = 3500;
function chunkText(text) {
  const lines = text.split('\n');
  const chunks = [];
  let cur = '';
  for (const ln of lines) {
    const add = (cur ? cur + '\n' : '') + ln;
    if (add.length > CHUNK && cur) { chunks.push(cur); cur = ln; }
    else cur = add;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function tgSend(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_HOME_CHANNEL;
  if (!token || !chat) throw new Error('telegram env missing');
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error('telegram fail: ' + JSON.stringify(j));
  return j.result.message_id;
}

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

const summary = [];
for (const w of sendList) {
  let text = fs.readFileSync(w.last_artifact, 'utf8');
  // count CLEAR/LEAN on Decision/Confidence lines, excluding "NO CLEAR PICK"
  let clearLean = 0;
  for (const ln of text.split('\n')) {
    const m = ln.match(/^- (Decision|Confidence):\s*(.+?)\s*$/);
    if (!m) continue;
    const val = m[2].trim();
    if (/^NO CLEAR PICK/i.test(val)) continue;
    const tok = val.toUpperCase();
    if (tok === 'CLEAR' || tok === 'LEAN') clearLean++;
  }
  const mode = clearLean === 0 ? 'BOARD_ONLY' : 'PICKS_PRESENT';
  const oldTitle = '=== Captain MLB — Pre-Lock Pick Report ===';
  const newTitle = mode === 'BOARD_ONLY'
    ? '=== Captain MLB — NO CLEAR PICK REPORT — board only ==='
    : oldTitle;
  const subhdr = mode === 'BOARD_ONLY'
    ? 'mode: BOARD_ONLY — scaffolding build; no fair-value model, lineups, weather, park, starter splits, or ump/handedness gates integrated yet. Use as decision-support board, NOT as picks.'
    : 'mode: PICKS_PRESENT — at least one game has a CLEAR or LEAN; review evidence before acting.';
  if (text.startsWith(oldTitle)) {
    text = newTitle + '\n' + subhdr + '\n' + text.slice(oldTitle.length + 1);
  } else if (/^=== Captain MLB[^\n]*\n/.test(text)) {
    text = newTitle + '\n' + subhdr + '\n' + text.replace(/^=== Captain MLB[^\n]*\n/, '');
  } else {
    text = newTitle + '\n' + subhdr + '\n' + text;
  }
  const chunks = chunkText(text);
  const M = chunks.length;
  const ids = [];
  for (let i = 0; i < M; i++) {
    const body = M > 1 ? `[part ${i+1}/${M}]\n${chunks[i]}` : chunks[i];
    const id = await tgSend(body);
    ids.push(id);
  }
  w.status = 'sent';
  w.delivered_idempotency_key = w.idempotency_key;
  w.delivered_utc = new Date().toISOString();
  w.delivered_telegram_message_ids = ids;
  w.delivered_mode = mode;
  w.clear_lean_count = clearLean;
  writePlan();
  summary.push(`${w.cluster_id}(${mode})`);
}

console.log(`sent ${summary.length} window(s): ${summary.join(', ')}`);
