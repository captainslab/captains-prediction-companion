#!/usr/bin/env node
// Packet sender — script-owned Telegram delivery, no LLM agent.
//
// Reads state/packets/<date>/<type>/ produced by the matching
// scripts/packets/generate-<type>.mjs and delivers one message per
// packet (pre-split .chunk-N.txt files sent in order when present).
//
// Rules:
//   * .inventory.txt and *.meta.json are audit artifacts — never delivered.
//   * Idempotent: a delivery ledger in the packet dir records sent files;
//     re-runs skip anything already delivered.
//   * No-events day -> a single short status message, also ledger-guarded.
//   * Routine output goes to stdout (cron wrapper logs it). Hard failures go
//     to stderr with a non-zero exit so cron alerting fires.
//   * No trades. No bankroll advice. Sender never edits packet content.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const TELEGRAM_SAFE_CHARS = 3500;

const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}
const dryRun = args.includes('--dry-run');
const date = argValue('--date') || new Date().toISOString().slice(0, 10);
const stateRoot = argValue('--state-root') || 'state';
const packetType = argValue('--type') || 'mentions-daily';

// Load env from project .env if present (same pattern as scripts/mlb/_send-due.mjs)
function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    const v = m[2].replace(/^['"]|['"]$/g, '');
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}
loadEnv('.env');
loadEnv('.env.local');

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

function chunkText(text) {
  if (text.length <= TELEGRAM_SAFE_CHARS) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > TELEGRAM_SAFE_CHARS) {
    let cut = rest.lastIndexOf('\n', TELEGRAM_SAFE_CHARS);
    if (cut < TELEGRAM_SAFE_CHARS / 2) cut = TELEGRAM_SAFE_CHARS;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function planDeliveries(dir, dateStr) {
  // Returns [{ name, files }] — one entry per event packet, in stable order.
  // Audit artifacts (.inventory.txt, *.meta.json) are excluded by design.
  const all = readdirSync(dir).sort();
  const bases = all.filter((f) =>
    f.startsWith(`${dateStr}-`) &&
    f.endsWith('.txt') &&
    !f.endsWith('.inventory.txt') &&
    !/\.chunk-\d+\.txt$/.test(f),
  );
  const plan = [];
  for (const base of bases) {
    const stem = base.replace(/\.txt$/, '');
    const chunks = all
      .filter((f) => f.startsWith(`${stem}.chunk-`) && f.endsWith('.txt'))
      .sort((a, b) => {
        const na = Number(a.match(/\.chunk-(\d+)\.txt$/)[1]);
        const nb = Number(b.match(/\.chunk-(\d+)\.txt$/)[1]);
        return na - nb;
      });
    plan.push({ name: stem, files: chunks.length ? chunks : [base] });
  }
  return plan;
}

function loadLedger(path) {
  if (!existsSync(path)) return { delivered: {} };
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { delivered: {} };
  }
}

function saveLedger(path, ledger) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(ledger, null, 2));
  renameSync(tmp, path);
}

async function main() {
  const dir = resolve(stateRoot, 'packets', date, packetType);
  const ledgerPath = join(dir, '.delivery-ledger.json');

  if (!existsSync(dir)) {
    console.log(`${packetType} ${date}: no packet directory — nothing to send`);
    return;
  }

  const ledger = loadLedger(ledgerPath);
  const plan = planDeliveries(dir, date);
  const noEventsOnly = plan.length === 1 && plan[0].name === `${date}-no-events`;

  if (plan.length === 0 || noEventsOnly) {
    const key = `${date}-no-events-status`;
    if (ledger.delivered[key]) {
      console.log(`${packetType} ${date}: no-events status already delivered — skip`);
      return;
    }
    const msg = `${packetType} ${date}: no events discovered.`;
    if (dryRun) {
      console.log(`[dry-run] would send status: ${msg}`);
      return;
    }
    await tgSendMessage(msg);
    ledger.delivered[key] = { utc: new Date().toISOString() };
    saveLedger(ledgerPath, ledger);
    console.log(`${packetType} ${date}: sent no-events status`);
    return;
  }

  let sent = 0;
  let skipped = 0;
  for (const entry of plan) {
    if (entry.name === `${date}-no-events`) continue;
    if (ledger.delivered[entry.name]) {
      skipped += 1;
      continue;
    }
    const pieces = [];
    for (const f of entry.files) {
      const text = readFileSync(join(dir, f), 'utf8');
      pieces.push(...chunkText(text));
    }
    if (dryRun) {
      console.log(`[dry-run] would send ${entry.name} — ${pieces.length} message(s) from ${entry.files.join(', ')}`);
      continue;
    }
    const ids = [];
    for (const piece of pieces) {
      ids.push(await tgSendMessage(piece));
    }
    ledger.delivered[entry.name] = { utc: new Date().toISOString(), message_ids: ids };
    saveLedger(ledgerPath, ledger);
    sent += 1;
    console.log(`sent ${entry.name} — ${ids.length} message(s)`);
  }
  console.log(`${packetType} ${date}: delivered=${sent} skipped_already_delivered=${skipped} total_packets=${plan.length}`);
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isDirectRun) {
  main().catch((err) => {
    console.error(`${packetType} sender failed: ${err.message}`);
    process.exit(1);
  });
}
