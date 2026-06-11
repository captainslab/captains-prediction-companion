#!/usr/bin/env node
// Mentions rolling watcher — today-only, incremental, quiet. No LLM agent.
//
// Designed to run often from cron. Each run:
//   1. Light detection scan: Kalshi broad + series discovery, plus explicit
//      Alpha intake (manual_queue + env seeds). No research priming here —
//      that only happens when something new actually appears.
//   2. Keeps only events whose derived event date IS the run date. Future
//      (26JUN12+) and undated events are logged as watchlist scope, never sent.
//   3. Diffs against the durable seen ledger state/mentions/<date>/seen-events.json.
//   4. Nothing new -> single log line, exit 0 (cron wrapper keeps it silent).
//   5. New today event(s) -> runs the existing generator for ONLY those
//      tickers (full composite/profile/research path), then the idempotent
//      Telegram sender. Each event is generated and delivered exactly once.
//
// No trades. No bankroll advice. Market pricing never enters scoring
// (enforced by mention-composite-core; the watcher never touches pricing).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  fetchKalshiEvents,
  fetchMentionEventsBySeries,
  filterMentionEvents,
  filterByEventDate,
  deriveEventDate,
} from '../packets/lib/kalshi-discovery.mjs';
import { collectAlphaMentionIntake } from './alpha-intake.mjs';

const PACKET_TYPE = 'mentions-daily';

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

export function ledgerPath(stateRoot, date) {
  return resolve(stateRoot, 'mentions', date, 'seen-events.json');
}

export function loadLedger(path) {
  if (!existsSync(path)) return { events: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed.events === 'object' ? parsed : { events: {} };
  } catch {
    return { events: {} };
  }
}

export function saveLedger(path, ledger) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(ledger, null, 2));
  renameSync(tmp, path);
}

// Pure: split candidate events into { fresh, seen, deferred } for the date.
export function selectNewTodayEvents(candidates, ledger, date) {
  const todayGuard = filterByEventDate(date, { windowDays: 0, allowUndated: false });
  const fresh = [];
  const seen = [];
  const deferred = [];
  const dedup = new Set();
  for (const ev of candidates) {
    const ticker = ev?.event_ticker;
    if (!ticker || dedup.has(ticker)) continue;
    dedup.add(ticker);
    if (!todayGuard(ev)) {
      deferred.push(ev);
      continue;
    }
    if (ledger.events[ticker]) seen.push(ev);
    else fresh.push(ev);
  }
  return { fresh, seen, deferred };
}

async function discoverCandidates({ stateRoot, env, eventsFile }) {
  if (eventsFile) {
    // Test/recovery hook: read candidate events from a local JSON file
    // instead of the network. Shape: [{ event_ticker, ... }] or { events: [...] }.
    const parsed = JSON.parse(readFileSync(eventsFile, 'utf8'));
    return Array.isArray(parsed) ? parsed : (parsed.events ?? []);
  }
  const candidates = [];
  const broad = await fetchKalshiEvents('broad');
  candidates.push(...filterMentionEvents(broad.events).mentionEvents);
  const series = await fetchMentionEventsBySeries();
  candidates.push(...filterMentionEvents(series.events).mentionEvents);
  const alpha = await collectAlphaMentionIntake({ stateRoot, env, fallbackEvents: [] });
  candidates.push(...(alpha.events || []));
  return candidates;
}

function runStep(label, cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) {
    throw new Error(`${label} exited ${r.status ?? 'signal'}`);
  }
}

export async function watch({
  date,
  stateRoot = 'state',
  dryRun = false,
  markSeenOnly = false,
  eventsFile = null,
  env = process.env,
  runStepImpl = runStep,
} = {}) {
  const path = ledgerPath(stateRoot, date);
  const ledger = loadLedger(path);

  console.log(`[mentions-watch] ${new Date().toISOString()} scan start date=${date}${dryRun ? ' (dry-run)' : ''}${markSeenOnly ? ' (mark-seen-only)' : ''}`);
  const candidates = await discoverCandidates({ stateRoot, env, eventsFile });
  const { fresh, seen, deferred } = selectNewTodayEvents(candidates, ledger, date);

  if (deferred.length) {
    const sample = deferred.slice(0, 8).map(e => `${e.event_ticker}(${deriveEventDate(e) ?? 'undated'})`).join(', ');
    console.log(`[mentions-watch] ${date}: ${deferred.length} non-today event(s) excluded (past/future/undated), e.g. ${sample}`);
  }
  if (!fresh.length) {
    console.log(`[mentions-watch] ${date}: no new today events (seen=${seen.length}, watchlist=${deferred.length}) — quiet exit`);
    return { fresh: [], seen, deferred };
  }

  const tickers = fresh.map(e => e.event_ticker);
  const packetStems = fresh.map((e) => `${date}-${e.event_ticker}`);
  console.log(`[mentions-watch] ${date}: ${fresh.length} new today event(s): ${tickers.join(', ')}`);

  const nowUtc = new Date().toISOString();
  for (const ev of fresh) {
    ledger.events[ev.event_ticker] = {
      event_ticker: ev.event_ticker,
      event_url: ev.event_url ?? ev.url ?? null,
      event_date: deriveEventDate(ev),
      first_seen_utc: nowUtc,
      packet_path: join(stateRoot, 'packets', date, PACKET_TYPE, `${date}-${ev.event_ticker}.txt`),
      delivered_at: null,
      delivery_message_ids: null,
      idempotency_key: `mentions:${date}:${ev.event_ticker}`,
    };
  }

  if (dryRun) {
    console.log(`[mentions-watch] [dry-run] would generate + send packets for: ${tickers.join(', ')} (ledger not written)`);
    return { fresh, seen, deferred };
  }

  if (markSeenOnly) {
    // Backlog suppression / baseline seeding: record events as seen without
    // generating or sending, so only events listed AFTER this point deliver.
    for (const ev of fresh) ledger.events[ev.event_ticker].note = 'mark-seen-only (backlog suppressed, never delivered by watcher)';
    saveLedger(path, ledger);
    console.log(`[mentions-watch] ${date}: marked ${fresh.length} event(s) seen WITHOUT delivery; ledger at ${path}`);
    return { fresh, seen, deferred };
  }

  // Generate packets for ONLY the new tickers (today-only default window),
  // then deliver via the idempotent sender — previously delivered packets in
  // the same dir are skipped by its delivery ledger.
  const generatorArgs = [
    'scripts/packets/generate-mentions-daily.mjs',
    '--date', date, '--state-root', stateRoot, '--only', tickers.join(','),
  ];
  const senderArgs = [
    'scripts/packets/send-packets-telegram.mjs',
    '--type', PACKET_TYPE, '--date', date, '--state-root', stateRoot,
    '--only', packetStems.join(','),
  ];
  console.log(`[mentions-watch] ${date}: generator command ${process.execPath} ${generatorArgs.join(' ')}`);
  console.log(`[mentions-watch] ${date}: sender command ${process.execPath} ${senderArgs.join(' ')}`);
  runStepImpl('generator', process.execPath, generatorArgs);
  runStepImpl('sender', process.execPath, senderArgs);

  // Pull delivery facts back from the sender's ledger.
  const senderLedgerPath = resolve(stateRoot, 'packets', date, PACKET_TYPE, '.delivery-ledger.json');
  if (existsSync(senderLedgerPath)) {
    try {
      const delivered = JSON.parse(readFileSync(senderLedgerPath, 'utf8')).delivered ?? {};
      for (const ev of fresh) {
        const rec = delivered[`${date}-${ev.event_ticker}`];
        if (rec) {
          ledger.events[ev.event_ticker].delivered_at = rec.utc ?? null;
          ledger.events[ev.event_ticker].delivery_message_ids = rec.message_ids ?? null;
        }
      }
    } catch {
      // delivery facts are best-effort; seen-state below is what guarantees idempotency
    }
  }

  saveLedger(path, ledger);
  console.log(`[mentions-watch] ${date}: processed ${fresh.length} new event(s); ledger updated at ${path}`);
  return { fresh, seen, deferred };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node scripts/mentions/mentions-watch.mjs [--date YYYY-MM-DD] [--state-root state] [--dry-run] [--mark-seen-only] [--events-file events.json]');
    return;
  }
  const date = argValue(args, '--date') || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`cannot determine a valid run date (got "${date}")`);
  }
  await watch({
    date,
    stateRoot: argValue(args, '--state-root') || 'state',
    dryRun: args.includes('--dry-run'),
    markSeenOnly: args.includes('--mark-seen-only'),
    eventsFile: argValue(args, '--events-file'),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`[mentions-watch] failed: ${err.message}`);
    process.exit(1);
  });
}
