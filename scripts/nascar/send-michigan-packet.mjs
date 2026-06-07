#!/usr/bin/env node
// NASCAR Michigan packet Telegram sender.
// Sends state/nascar/2026-06-07/firekeepers-casino-400/packet.md as a document.
// Uses TELEGRAM_BOT_TOKEN + (TELEGRAM_CHAT_ID or TELEGRAM_HOME_CHANNEL).
// No trades. No pricing data. Research only.
//
// Usage:
//   node scripts/nascar/send-michigan-packet.mjs [--dry-run]
//
// Attempt result (success or error) is written to:
//   state/nascar/2026-06-07/firekeepers-casino-400/telegram-send-attempt.json

import { readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKET_PATH = 'state/nascar/2026-06-07/firekeepers-casino-400/packet.md';
const ATTEMPT_LOG = 'state/nascar/2026-06-07/firekeepers-casino-400/telegram-send-attempt.json';
const CAPTION = 'NASCAR FireKeepers Casino 400 — Michigan International Speedway | Research-Only Packet | 2026-06-07 | No trades.';

const dryRun = process.argv.includes('--dry-run');

function loadEnv(file) {
  try {
    const text = readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}
loadEnv('.env');
loadEnv('.env.local');

function resolveCredentials() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_HOME_CHANNEL;
  const chatSource = process.env.TELEGRAM_CHAT_ID ? 'TELEGRAM_CHAT_ID'
    : process.env.TELEGRAM_HOME_CHANNEL ? 'TELEGRAM_HOME_CHANNEL' : null;
  return { token, chat, chatSource };
}

function httpsMultipart(urlStr, fields, fileField, fileBuf, fileName) {
  return new Promise((res, rej) => {
    const url = new URL(urlStr);
    const boundary = `----captainBoundary${Date.now()}`;
    const parts = [];
    for (const [k, v] of Object.entries(fields)) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n`));
    parts.push(fileBuf);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(parts);
    const req = request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', c => chunks.push(c));
      response.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        try { res({ status: response.statusCode, body: JSON.parse(txt) }); }
        catch { res({ status: response.statusCode, body: { raw: txt.slice(0, 500) } }); }
      });
    });
    req.on('error', rej);
    req.write(body);
    req.end();
  });
}

async function main() {
  const attemptedAt = new Date().toISOString();
  const result = {
    attempted_at: attemptedAt,
    packet_path: PACKET_PATH,
    dry_run: dryRun,
    ok: false,
    message_id: null,
    error: null,
    blocker: null,
    no_trades: true,
    market_neutral: true,
  };

  const { token, chat, chatSource } = resolveCredentials();

  if (!token || !chat) {
    const missing = [];
    if (!token) missing.push('TELEGRAM_BOT_TOKEN');
    if (!chat) missing.push('TELEGRAM_CHAT_ID or TELEGRAM_HOME_CHANNEL');
    result.blocker = `CREDENTIALS_MISSING: ${missing.join(', ')} not set in environment`;
    result.error = result.blocker;
    process.stderr.write(`[nascar-telegram] BLOCKER: ${result.blocker}\n`);
    writeFileSync(ATTEMPT_LOG, JSON.stringify(result, null, 2));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(2);
  }

  result.chat_source = chatSource;

  if (dryRun) {
    result.ok = true;
    result.dry_run_note = 'DRY RUN: credentials resolved, packet exists, would send sendDocument to Telegram API';
    result.packet_bytes = readFileSync(PACKET_PATH).length;
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    writeFileSync(ATTEMPT_LOG, JSON.stringify(result, null, 2));
    return;
  }

  let packetBuf;
  try {
    packetBuf = readFileSync(resolve(PACKET_PATH));
  } catch (e) {
    result.error = `Packet file not found: ${PACKET_PATH} — ${e.message}`;
    result.blocker = 'PACKET_MISSING';
    writeFileSync(ATTEMPT_LOG, JSON.stringify(result, null, 2));
    process.stderr.write(`[nascar-telegram] ${result.error}\n`);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(3);
  }

  const apiUrl = `https://api.telegram.org/bot${token}/sendDocument`;
  process.stderr.write(`[nascar-telegram] Sending ${PACKET_PATH} (${packetBuf.length} bytes) to chat ${chatSource}...\n`);

  try {
    const resp = await httpsMultipart(
      apiUrl,
      { chat_id: chat, caption: CAPTION.slice(0, 1000) },
      'document',
      packetBuf,
      'firekeepers-casino-400-packet.md',
    );
    if (resp.body?.ok) {
      result.ok = true;
      result.message_id = resp.body.result?.message_id ?? null;
      result.http_status = resp.status;
      process.stderr.write(`[nascar-telegram] SUCCESS: message_id=${result.message_id}\n`);
    } else {
      result.ok = false;
      result.http_status = resp.status;
      result.error = `Telegram API error: ${JSON.stringify(resp.body).slice(0, 400)}`;
      process.stderr.write(`[nascar-telegram] API FAIL: ${result.error}\n`);
    }
  } catch (e) {
    result.ok = false;
    result.error = `Network error: ${e.message ?? String(e)}`;
    process.stderr.write(`[nascar-telegram] NETWORK ERROR: ${result.error}\n`);
  }

  writeFileSync(ATTEMPT_LOG, JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(err => {
    process.stderr.write(`send-michigan-packet failed: ${err.message ?? err}\n`);
    process.exit(1);
  });
}
