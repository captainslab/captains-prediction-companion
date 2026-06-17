#!/usr/bin/env node
// Mentions health summary — read-only ledger audit, no sends, no network.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ledgerPath as watchLedgerPath } from './mentions-watch.mjs';

const PACKET_TYPE = 'mentions-daily';

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

function loadJsonLedger(path, fallback) {
  if (!existsSync(path)) {
    return { ok: false, ledger: fallback };
  }
  try {
    return { ok: true, ledger: JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return { ok: false, ledger: fallback };
  }
}

function parsePositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function summarizeMentionsHealth({
  date,
  stateRoot = 'state',
  env = process.env,
} = {}) {
  const seenPath = watchLedgerPath(stateRoot, date);
  const senderPath = join(stateRoot, 'packets', date, PACKET_TYPE, '.delivery-ledger.json');
  const seen = loadJsonLedger(seenPath, { events: {} });
  const sender = loadJsonLedger(senderPath, { delivered: {} });
  const events = Object.entries(seen.ledger?.events ?? {});
  const delivered = sender.ledger?.delivered ?? {};
  const maxRetryAttempts = parsePositiveInt(env.MENTIONS_WATCH_MAX_RETRY_ATTEMPTS, 3);

  let deliveredCount = 0;
  let blockedCount = 0;
  let retryableCount = 0;
  let heldCount = 0;
  let staleCount = 0;

  for (const [ticker, entry] of events) {
    if (entry?.delivered_at) deliveredCount += 1;
    if (entry?.status === 'blocked' && !entry?.delivered_at) blockedCount += 1;
    if (entry?.status === 'held') heldCount += 1;
    if (!entry?.delivered_at && entry?.status !== 'held' && (entry?.status === 'pending' || entry?.status === 'blocked')) {
      const attempts = Number(entry.attempts ?? 0);
      if (attempts < maxRetryAttempts) retryableCount += 1;
    }

    const stem = `${date}-${ticker}`;
    const senderRec = delivered[stem];
    if (entry?.delivered_at && !senderRec) {
      staleCount += 1;
    }
  }

  for (const [stem, senderRec] of Object.entries(delivered)) {
    if (!senderRec) continue;
    const ticker = stem.startsWith(`${date}-`) ? stem.slice(date.length + 1) : null;
    if (!ticker) {
      staleCount += 1;
      continue;
    }
    const entry = seen.ledger?.events?.[ticker];
    if (!entry?.delivered_at) staleCount += 1;
  }

  return {
    discovered: events.length,
    delivered: deliveredCount,
    blocked: blockedCount,
    retryable: retryableCount,
    held: heldCount,
    stale: staleCount,
    ledger_ok: Boolean(seen.ok && sender.ok),
  };
}

export function formatMentionsHealthSummary(date, summary) {
  return `[mentions-health] date=${date} discovered=${summary.discovered} delivered=${summary.delivered} blocked=${summary.blocked} retryable=${summary.retryable} held=${summary.held} stale=${summary.stale} ledger_ok=${summary.ledger_ok}`;
}

export function printMentionsHealth({
  date,
  stateRoot = 'state',
  env = process.env,
  log = console.log,
} = {}) {
  const summary = summarizeMentionsHealth({ date, stateRoot, env });
  log(formatMentionsHealthSummary(date, summary));
  return summary;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node scripts/mentions/mentions-health.mjs [--date YYYY-MM-DD] [--state-root state]');
    return;
  }
  const date = argValue(args, '--date') || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`cannot determine a valid run date (got "${date}")`);
  }
  const stateRoot = argValue(args, '--state-root') || 'state';
  printMentionsHealth({ date, stateRoot });
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isDirectRun) {
  main().catch((err) => {
    console.error(`[mentions-health] failed: ${err.message}`);
    process.exit(1);
  });
}
