#!/usr/bin/env node
// One-shot helper invoked by cron: send rendered+undelivered windows for TODAY CT.
// Uses America/Chicago date so late-night games (post-midnight UTC) stay on the
// correct slate date rather than rolling over to the next UTC day at 7pm CT.
import fs from 'node:fs';
import path from 'node:path';

const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
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
    if (/^[-★◆]\s*(PICK|PLAY|CLEAR|LEAN)/i.test(ln)) { n++; continue; }
    const m = ln.match(/^- (Decision|Confidence):\s*(.+?)\s*$/);
    if (m && /^(CLEAR|LEAN)/i.test(m[2]) && !/^NO CLEAR PICK/i.test(m[2])) n++;
  }
  return n;
}

const summary = [];
for (const w of sendList) {
  const artifactPath = (w.compact_artifact && fs.existsSync(w.compact_artifact))
    ? w.compact_artifact
    : w.last_artifact;
  const text = fs.readFileSync(artifactPath, 'utf8');
  const clearLean = countPicks(text);
  if (clearLean === 0) {
    console.log(`skip ${w.cluster_id} — no picks`);
    continue;
  }
  const caption = `MLB ${w.cluster_id} — ${clearLean} pick${clearLean !== 1 ? 's' : ''}`;

  const id = await tgSendDocument(artifactPath, caption);
  w.status = 'sent';
  w.delivered_idempotency_key = w.idempotency_key;
  w.delivered_utc = new Date().toISOString();
  w.delivered_telegram_message_ids = [id];
  w.delivered_mode = mode;
  w.clear_lean_count = clearLean;
  writePlan();
  summary.push(`${w.cluster_id}(${mode})`);
}

console.log(`sent ${summary.length} window(s): ${summary.join(', ')}`);
