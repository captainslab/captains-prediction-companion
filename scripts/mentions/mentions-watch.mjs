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

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
import { resolveResearchRoute } from './mention-route-resolver.mjs';

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

function parsePositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function isTerminalSeenEntry(entry) {
  return Boolean(entry?.delivered_at) || entry?.status === 'mark-seen-only' || entry?.status === 'held';
}

function normalizeHeldEntries(ledger, maxRetryAttempts) {
  const held = [];
  for (const [ticker, entry] of Object.entries(ledger.events ?? {})) {
    if (!entry || typeof entry !== 'object' || isTerminalSeenEntry(entry)) continue;
    const attempts = Number(entry.attempts ?? 0);
    if (attempts < maxRetryAttempts) continue;
    entry.status = 'held';
    entry.held_reason = entry.held_reason ?? `attempts ${attempts} reached max ${maxRetryAttempts}`;
    held.push(ticker);
  }
  return held;
}

function buildLedgerEntry({ ev, date, stateRoot, existingEntry, nowUtc }) {
  const ticker = ev.event_ticker;
  const packetStem = `${date}-${ticker}`;
  return {
    ...(existingEntry ?? {}),
    event_ticker: ticker,
    event_url: ev.event_url ?? ev.url ?? existingEntry?.event_url ?? null,
    event_date: deriveEventDate(ev) ?? existingEntry?.event_date ?? null,
    research_route: ev.research_route?.route ?? existingEntry?.research_route ?? null,
    first_seen_utc: existingEntry?.first_seen_utc ?? nowUtc,
    packet_path: existingEntry?.packet_path ?? join(stateRoot, 'packets', date, PACKET_TYPE, `${packetStem}.txt`),
    status: 'pending',
    blocker_path: null,
    delivered_at: existingEntry?.delivered_at ?? null,
    delivery_message_ids: existingEntry?.delivery_message_ids ?? null,
    idempotency_key: existingEntry?.idempotency_key ?? `mentions:${date}:${ticker}`,
    attempts: Number(existingEntry?.attempts ?? 0) + 1,
    held_reason: null,
  };
}

// Pure: split candidate events into { fresh, seen, deferred, retryable } for the date.
export function selectNewTodayEvents(candidates, ledger, date) {
  const todayGuard = filterByEventDate(date, { windowDays: 0, allowUndated: false });
  const fresh = [];
  const seen = [];
  const deferred = [];
  const retryable = [];
  const dedup = new Set();
  for (const ev of candidates) {
    const ticker = ev?.event_ticker;
    if (!ticker || dedup.has(ticker)) continue;
    dedup.add(ticker);
    if (!todayGuard(ev)) {
      deferred.push(ev);
      continue;
    }
    const entry = ledger.events?.[ticker];
    if (!entry) {
      fresh.push(ev);
      continue;
    }
    if (isTerminalSeenEntry(entry)) {
      seen.push(ev);
      continue;
    }
    retryable.push(ev);
  }
  return { fresh, seen, deferred, retryable };
}

// Annotate every candidate with its research route at discovery time — BEFORE
// any source fetch or model extraction. The generator re-resolves through the
// same shared resolver, so collector and generator can never disagree.
export function annotateResearchRoutes(candidates) {
  for (const ev of candidates) {
    if (!ev || typeof ev !== 'object') continue;
    ev.research_route = resolveResearchRoute(ev);
  }
  return candidates;
}

async function discoverCandidates({ stateRoot, env, eventsFile }) {
  if (eventsFile) {
    // Test/recovery hook: read candidate events from a local JSON file
    // instead of the network. Shape: [{ event_ticker, ... }] or { events: [...] }.
    const parsed = JSON.parse(readFileSync(eventsFile, 'utf8'));
    return annotateResearchRoutes(Array.isArray(parsed) ? parsed : (parsed.events ?? []));
  }
  const candidates = [];
  const broad = await fetchKalshiEvents('broad');
  candidates.push(...filterMentionEvents(broad.events).mentionEvents);
  const series = await fetchMentionEventsBySeries();
  candidates.push(...filterMentionEvents(series.events).mentionEvents);
  const alpha = await collectAlphaMentionIntake({ stateRoot, env, fallbackEvents: [] });
  candidates.push(...(alpha.events || []));
  return annotateResearchRoutes(candidates);
}

// ─── single-run lock ──────────────────────────────────────────────────────────
// One watcher run per date at a time. The lock holds the holder's pid; a lock
// whose pid is no longer alive (or whose file is unreadable/too old) is stale
// and gets recovered, so a crashed run can never wedge the cron permanently.

export const DEFAULT_LOCK_STALE_MS = 60 * 60 * 1000;

export function runLockPath(stateRoot, date) {
  return resolve(stateRoot, 'mentions', date, 'watch.lock');
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function acquireRunLock(path, { pid = process.pid, staleMs = DEFAULT_LOCK_STALE_MS, now = Date.now() } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, JSON.stringify({ pid, started_utc: new Date(now).toISOString() }), { flag: 'wx' });
      return { acquired: true };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let holder = null;
      try {
        holder = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        // unreadable lock -> stale
      }
      const age = holder?.started_utc ? now - Date.parse(holder.started_utc) : Infinity;
      const stale = !holder || !pidAlive(holder.pid) || !(age < staleMs);
      if (!stale) return { acquired: false, holder };
      rmSync(path, { force: true });
      // loop: retry the atomic create once after recovering the stale lock
    }
  }
  return { acquired: false, holder: null };
}

export function releaseRunLock(path) {
  rmSync(path, { force: true });
}

// ─── per-step timeout with process-group cleanup ─────────────────────────────
// Each generator/sender child runs detached as its own process-group leader.
// On timeout, spawnSync SIGKILLs the direct child; we then SIGKILL the whole
// group so grandchildren (e.g. `hermes chat` spawned by the generator) cannot
// outlive the step and keep running headless.

export const DEFAULT_STEP_TIMEOUT_MS = 900 * 1000;

export function stepTimeoutMs(env = process.env) {
  const seconds = Number(env.MENTIONS_WATCH_STEP_TIMEOUT_SECONDS);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_STEP_TIMEOUT_MS;
}

export function runStep(label, cmd, args, { timeoutMs = stepTimeoutMs() } = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  const timedOut = r.error?.code === 'ETIMEDOUT';
  if ((timedOut || r.error || r.status !== 0) && r.pid) {
    // Sweep the whole group on any failure path; harmless if already gone.
    try { process.kill(-r.pid, 'SIGKILL'); } catch { /* group already gone */ }
  }
  if (timedOut) {
    throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s (child process group killed)`);
  }
  if (r.error) {
    throw new Error(`${label} failed to spawn: ${r.error.message}`);
  }
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
  maxNewPerRunDefault = DEFAULT_MAX_NEW_PER_RUN,
} = {}) {
  // Single-run lock: overlapping cron fires exit 0 quietly instead of
  // double-generating/double-sending. Stale locks (dead pid) are recovered.
  const lockPath = runLockPath(stateRoot, date);
  const lock = acquireRunLock(lockPath);
  if (!lock.acquired) {
    console.log(`[mentions-watch] ${date}: already running (lock held by pid ${lock.holder?.pid ?? 'unknown'} since ${lock.holder?.started_utc ?? 'unknown'}) — exit 0`);
    return { skipped: 'already-running', fresh: [], seen: [], deferred: [], retryable: [], attempted: [], retried: [], queued: [], retryQueued: [], succeeded: [], failed: [], held: [] };
  }
  try {
    return await watchLocked({ date, stateRoot, dryRun, markSeenOnly, eventsFile, env, runStepImpl, maxNewPerRunDefault });
  } finally {
    releaseRunLock(lockPath);
  }
}

async function watchLocked({ date, stateRoot, dryRun, markSeenOnly, eventsFile, env, runStepImpl, maxNewPerRunDefault }) {
  const path = ledgerPath(stateRoot, date);
  const ledger = loadLedger(path);
  const maxNewPerRun = parsePositiveInt(env.MENTIONS_WATCH_MAX_NEW_PER_RUN, maxNewPerRunDefault);
  const maxRetryPerRun = parsePositiveInt(env.MENTIONS_WATCH_MAX_RETRY_PER_RUN, DEFAULT_MAX_RETRY_PER_RUN);
  const maxRetryAttempts = parsePositiveInt(env.MENTIONS_WATCH_MAX_RETRY_ATTEMPTS, DEFAULT_MAX_RETRY_ATTEMPTS);
  const normalizedHeld = normalizeHeldEntries(ledger, maxRetryAttempts);
  if (normalizedHeld.length && !dryRun) {
    saveLedger(path, ledger);
  }

  console.log(`[mentions-watch] ${new Date().toISOString()} scan start date=${date}${dryRun ? ' (dry-run)' : ''}${markSeenOnly ? ' (mark-seen-only)' : ''}`);
  const candidates = await discoverCandidates({ stateRoot, env, eventsFile });
  const { fresh, seen, deferred, retryable } = selectNewTodayEvents(candidates, ledger, date);

  if (deferred.length) {
    const sample = deferred.slice(0, 8).map(e => `${e.event_ticker}(${deriveEventDate(e) ?? 'undated'})`).join(', ');
    console.log(`[mentions-watch] ${date}: ${deferred.length} non-today event(s) excluded (past/future/undated), e.g. ${sample}`);
  }
  if (!fresh.length && !retryable.length) {
    console.log(`[mentions-watch] ${date}: no new today events (seen=${seen.length}, watchlist=${deferred.length}) — quiet exit`);
    return { fresh: [], seen, deferred, retryable: [], attempted: [], retried: [], queued: [], retryQueued: [], succeeded: [], failed: [], held: normalizedHeld };
  }

  if (markSeenOnly) {
    // Backlog suppression / baseline seeding: record ALL fresh events as seen
    // without generating or sending (bypasses the throttle on purpose), so
    // only events listed AFTER this point deliver.
    const nowUtc = new Date().toISOString();
    for (const ev of fresh) {
      ledger.events[ev.event_ticker] = {
        event_ticker: ev.event_ticker,
        event_url: ev.event_url ?? ev.url ?? null,
        event_date: deriveEventDate(ev),
        first_seen_utc: nowUtc,
        status: 'mark-seen-only',
        delivered_at: null,
        delivery_message_ids: null,
        idempotency_key: `mentions:${date}:${ev.event_ticker}`,
        note: 'mark-seen-only (backlog suppressed, never delivered by watcher)',
      };
    }
    saveLedger(path, ledger);
    console.log(`[mentions-watch] ${date}: marked ${fresh.length} event(s) seen WITHOUT delivery; ledger at ${path}`);
    return { fresh, seen, deferred, retryable, attempted: [], retried: [], queued: [], retryQueued: [], succeeded: [], failed: [], held: normalizedHeld };
  }

  // Throttle: never burst-deliver a big first-run batch. Events beyond the cap
  // are NOT touched in the ledger — they stay unseen and are picked up on the
  // next watcher run.
  const attempted = fresh.slice(0, maxNewPerRun);
  const queued = fresh.slice(maxNewPerRun);
  const retried = retryable.slice(0, maxRetryPerRun);
  const retryQueued = retryable.slice(maxRetryPerRun);
  console.log(`[mentions-watch] ${date}: ${fresh.length} new today event(s); processing ${attempted.length} this run (max_new_per_run=${maxNewPerRun})${queued.length ? `; ${queued.length} queued for next run: ${queued.map(e => e.event_ticker).join(', ')}` : ''}`);
  if (retryable.length) {
    console.log(`[mentions-watch] ${date}: ${retryable.length} retryable event(s); processing ${retried.length} this run (max_retry_per_run=${maxRetryPerRun}, max_retry_attempts=${maxRetryAttempts})${retryQueued.length ? `; ${retryQueued.length} queued for next run: ${retryQueued.map(e => e.event_ticker).join(', ')}` : ''}`);
  }

  if (dryRun) {
    const dryTargets = [...attempted.map((ev) => ev.event_ticker), ...retried.map((ev) => ev.event_ticker)];
    console.log(`[mentions-watch] [dry-run] would generate + send packets for: ${dryTargets.join(', ')} (ledger not written)`);
    return { fresh, seen, deferred, retryable, attempted, retried, queued, retryQueued, succeeded: [], failed: [], held: normalizedHeld };
  }

  // Per-event isolation: each new event gets its own generate + validate +
  // send cycle. One bad model packet writes a blocker artifact and the run
  // continues; only infrastructure failures make the watcher exit nonzero.
  const succeeded = [];
  const failed = [];
  const held = [...normalizedHeld];
  const senderLedgerPath = resolve(stateRoot, 'packets', date, PACKET_TYPE, '.delivery-ledger.json');
  const work = [
    ...attempted.map((ev) => ({ ev, kind: 'fresh' })),
    ...retried.map((ev) => ({ ev, kind: 'retryable' })),
  ];
  for (const { ev } of work) {
    const ticker = ev.event_ticker;
    const existingEntry = ledger.events[ticker];
    if (existingEntry?.delivered_at) {
      continue;
    }
    const stem = `${date}-${ticker}`;
    const packetPath = resolve(stateRoot, 'packets', date, PACKET_TYPE, `${stem}.txt`);
    const entry = buildLedgerEntry({ ev, date, stateRoot, existingEntry, nowUtc: new Date().toISOString() });
    entry.status = 'pending';
    entry.held_reason = null;
    ledger.events[ticker] = entry;
    saveLedger(path, ledger);

    const generatorArgs = [
      'scripts/packets/generate-mentions-daily.mjs',
      '--date', date, '--state-root', stateRoot, '--only', ticker,
    ];
    const senderArgs = [
      'scripts/packets/send-packets-telegram.mjs',
      '--type', PACKET_TYPE, '--date', date, '--state-root', stateRoot,
      '--only', stem,
    ];
    console.log(`[mentions-watch] ${date}: [${ticker}] generator command ${process.execPath} ${generatorArgs.join(' ')}`);
    try {
      runStepImpl(`generator:${ticker}`, process.execPath, generatorArgs);
      if (!existsSync(packetPath)) {
        throw new Error(`generator wrote no packet at ${packetPath} (packet blocked — see blocker artifact)`);
      }
      console.log(`[mentions-watch] ${date}: [${ticker}] sender command ${process.execPath} ${senderArgs.join(' ')}`);
      runStepImpl(`sender:${ticker}`, process.execPath, senderArgs);
      entry.status = 'delivered';
      entry.held_reason = null;
      succeeded.push(ticker);
    } catch (err) {
      entry.status = entry.attempts >= maxRetryAttempts ? 'held' : 'blocked';
      entry.held_reason = entry.status === 'held' ? `attempts ${entry.attempts} reached max ${maxRetryAttempts}` : null;
      entry.blocker_path = writeBlockerArtifact({ stateRoot, date, ticker, error: err.message });
      console.error(`[mentions-watch] ${date}: [${ticker}] ${entry.status.toUpperCase()} (not delivered): ${err.message}; blocker at ${entry.blocker_path}`);
      failed.push(ticker);
      if (entry.status === 'held') {
        held.push(ticker);
      }
      // Persist the blocked outcome immediately: an external kill (e.g. the
      // cron runner's script timeout) right after this event must not lose it.
      saveLedger(path, ledger);
      continue;
    }

    // Pull delivery facts back from the sender's ledger (best-effort).
    if (existsSync(senderLedgerPath)) {
      try {
        const delivered = JSON.parse(readFileSync(senderLedgerPath, 'utf8')).delivered ?? {};
        const rec = delivered[stem];
        if (rec) {
          entry.delivered_at = rec.utc ?? null;
          entry.delivery_message_ids = rec.message_ids ?? null;
        }
      } catch {
        // delivery facts are best-effort; seen-state below is what guarantees idempotency
      }
    }
    // Persist after EVERY event, not just at run end: if the run is killed
    // externally mid-batch, already-delivered events stay seen and are never
    // re-generated or re-sent by the next run.
    saveLedger(path, ledger);
  }

  saveLedger(path, ledger);
  console.log(`[mentions-watch] ${date}: processed ${work.length} event(s) (delivered=${succeeded.length}, blocked=${failed.length}, held=${held.length}, queued=${queued.length}, retryQueued=${retryQueued.length}); ledger updated at ${path}`);
  return { fresh, seen, deferred, retryable, attempted, retried, queued, retryQueued, succeeded, failed, held };
}

export const DEFAULT_MAX_NEW_PER_RUN = 3;
export const DEFAULT_MAX_RETRY_PER_RUN = 2;
export const DEFAULT_MAX_RETRY_ATTEMPTS = 3;

function writeBlockerArtifact({ stateRoot, date, ticker, error }) {
  const dir = resolve(stateRoot, 'mentions', date, 'blockers');
  mkdirSync(dir, { recursive: true });
  const blockerPath = resolve(dir, `${date}-${ticker}.watch.json`);
  writeFileSync(blockerPath, JSON.stringify({
    event_ticker: ticker,
    date,
    stage: 'watch_generate_or_send',
    error,
    blocked_at_utc: new Date().toISOString(),
    delivered: false,
  }, null, 2));
  return blockerPath;
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
