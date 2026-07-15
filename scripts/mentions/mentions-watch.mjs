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
  discoverMentionEvents,
  filterMentionEvents,
  filterByEventDate,
  deriveEventDate,
  canonicalKalshiEventUrl,
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

function declaredSourceUrlForEvent({ ev, stateRoot, date }) {
  if (ev?.declared_source_url) return ev.declared_source_url;
  const ticker = ev?.event_ticker;
  if (!ticker) return null;
  const manifestPath = resolve(stateRoot, 'mentions', date, 'sources', `${ticker}.json`);
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return Array.isArray(manifest?.urls) && manifest.urls[0] ? manifest.urls[0] : null;
  } catch {
    return null;
  }
}

function buildLedgerEntry({ ev, date, stateRoot, existingEntry, nowUtc }) {
  const ticker = ev.event_ticker;
  const packetStem = `${date}-${ticker}`;
  return {
    ...(existingEntry ?? {}),
    event_ticker: ticker,
    event_url: ev.event_url ?? ev.url ?? canonicalKalshiEventUrl(ticker) ?? existingEntry?.event_url ?? null,
    declared_source_url: declaredSourceUrlForEvent({ ev, stateRoot, date }) ?? existingEntry?.declared_source_url ?? null,
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

// Earliest settlement/close timestamp (ms since epoch) across an event and its
// markets. TIME fields only (close_time / expected_expiration_time) — never
// price/odds/bid/ask/volume/OI — so delivery ordering keeps price isolation
// intact. Returns Infinity when no timestamp is parseable.
export function eventImminenceMs(event) {
  const markets = Array.isArray(event?.markets) ? event.markets : [];
  const stamps = [
    event?.close_time,
    event?.expected_expiration_time,
    ...markets.flatMap((m) => [m?.close_time, m?.expected_expiration_time]),
  ];
  let earliest = Infinity;
  for (const s of stamps) {
    const ms = s ? Date.parse(s) : NaN;
    if (Number.isFinite(ms) && ms < earliest) earliest = ms;
  }
  return earliest;
}

// Stable ordering: most imminent (soonest-closing) events first so the per-run
// throttle never queues an about-to-start event behind ones with hours of
// runway. Undated events keep their discovery order at the back.
export function orderByImminence(events) {
  return (Array.isArray(events) ? events : [])
    .map((ev, idx) => ({ ev, idx, at: eventImminenceMs(ev) }))
    .sort((a, b) => {
      if (a.at !== b.at) {
        if (!Number.isFinite(a.at)) return 1;
        if (!Number.isFinite(b.at)) return -1;
        return a.at - b.at;
      }
      return a.idx - b.idx;
    })
    .map((x) => x.ev);
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

// Build an optional JS-rendering page fetcher for the scraper-first layer.
// The calendar/mentions board is a client-rendered SPA, so a plain fetch sees
// no events. When MENTIONS_PAGE_FETCH_CMD is set (e.g. a firecrawl render
// command with a {url} placeholder), we shell out to it and feed the rendered
// HTML to the scraper. When it is NOT set — the default in cron — there is no
// browser dependency and discovery falls through to the free, deterministic
// /series category scan. firecrawl (or any renderer) is therefore opt-in and
// never load-bearing.
export function buildPageFetcherFromEnv(env = process.env) {
  const tmpl = env.MENTIONS_PAGE_FETCH_CMD;
  if (!tmpl || !tmpl.trim()) return undefined;
  return async (url) => {
    const cmd = tmpl.includes('{url}') ? tmpl.replaceAll('{url}', url) : `${tmpl} ${url}`;
    const r = spawnSync('bash', ['-lc', cmd], {
      encoding: 'utf8',
      timeout: Number(env.MENTIONS_PAGE_FETCH_TIMEOUT_MS || '120000'),
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: r.status === 0, status: r.status ?? 0, text: r.stdout || '', error: r.stderr || null };
  };
}

// Dedupe candidate events by event_ticker, first writer wins.
function dedupeByTicker(events) {
  const byTicker = new Map();
  for (const ev of events) {
    const t = ev?.event_ticker;
    if (!t) continue;
    if (!byTicker.has(t)) byTicker.set(t, ev);
  }
  return [...byTicker.values()];
}

// ─── bounded discovery ───────────────────────────────────────────────────────
// The scraper-first watcher fans across three independent discovery sources —
// the calendar/board scrape+/series scan (discoverMentionEvents), the broad
// language API scan (fetchKalshiEvents 'broad'), and the local Alpha intake.
// Any one of them can stall on a black-holed upstream; without a bound, a single
// hung socket wedges the whole cron past its hard script timeout. Each source
// now runs under its own wall-clock deadline with an AbortSignal it threads to
// fetch: when the budget elapses we abort the source (cancelling open sockets)
// and give it a short grace window to return partial results, while the
// surviving sources' results still flow through. A degraded-status artifact
// records exactly what was skipped and why.

export const DEFAULT_DISCOVERY_SOURCE_TIMEOUT_MS = 20 * 1000;
export const PARTIAL_GRACE_MS = 3000;

export function discoverySourceTimeoutMs(env = process.env) {
  const seconds = Number(env.MENTIONS_WATCH_DISCOVERY_TIMEOUT_SECONDS);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_DISCOVERY_SOURCE_TIMEOUT_MS;
}

export function discoveryPartialGraceMs(env = process.env) {
  const milliseconds = Number(env.MENTIONS_WATCH_PARTIAL_GRACE_MS);
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : PARTIAL_GRACE_MS;
}

function discoveryErrorText(error) {
  const text = error?.message ? String(error.message) : String(error);
  return text || 'empty discovery rejection';
}

// Run one discovery source against a deadline. The source receives an AbortSignal
// it threads to fetch; on timeout we abort it (cancelling open sockets) and
// give it a short grace window to return events collected before the abort.
// Errors are also degraded, never fatal. Returns { label, status: 'ok'|'partial'|'timeout'|'error', ms, events, error }.
async function runDiscoverySource(label, fn, timeoutMs, partialGraceMs = PARTIAL_GRACE_MS) {
  const controller = new AbortController();
  const started = Date.now();
  let timer = null;
  let graceTimer = null;
  const sourcePromise = Promise.resolve()
    .then(() => fn(controller.signal))
    .then((value) => ({ value }), (error) => ({ error }));
  const timeout = new Promise((res) => {
    timer = setTimeout(() => {
      controller.abort();
      res({ __timedOut: true });
    }, timeoutMs);
  });
  console.log(`[mentions-watch] discovery source=${label} start (budget=${Math.round(timeoutMs / 1000)}s)`);
  try {
    const outcome = await Promise.race([sourcePromise, timeout]);
    const ms = Date.now() - started;
    if (outcome.__timedOut) {
      const graceTimeout = new Promise((res) => {
        graceTimer = setTimeout(() => res({ __graceExpired: true }), partialGraceMs);
      });
      const afterAbort = await Promise.race([sourcePromise, graceTimeout]);
      const graceMs = Date.now() - started;
      if (!afterAbort.__graceExpired && !('error' in afterAbort)) {
        const events = Array.isArray(afterAbort.value) ? afterAbort.value : [];
        if (events.length > 0) {
          const error = `partial: timed out after ${Math.round(timeoutMs / 1000)}s, returned ${events.length} events collected before abort`;
          console.error(`[mentions-watch] discovery source=${label} PARTIAL after ${graceMs}ms — budget expired, kept ${events.length} events`);
          return { label, status: 'partial', ms: graceMs, events, error };
        }
      }
      if (!afterAbort.__graceExpired && 'error' in afterAbort) {
        controller.abort();
        const error = discoveryErrorText(afterAbort.error);
        console.error(`[mentions-watch] discovery source=${label} ERROR after ${graceMs}ms — skipped (degraded): ${error}`);
        return { label, status: 'error', ms: graceMs, events: [], error };
      }
      console.error(`[mentions-watch] discovery source=${label} TIMEOUT after ${graceMs}ms — skipped (degraded)`);
      return { label, status: 'timeout', ms: graceMs, events: [], error: `timed out after ${Math.round(timeoutMs / 1000)}s` };
    }
    if ('error' in outcome) {
      controller.abort();
      const error = discoveryErrorText(outcome.error);
      console.error(`[mentions-watch] discovery source=${label} ERROR after ${ms}ms — skipped (degraded): ${error}`);
      return { label, status: 'error', ms, events: [], error };
    }
    const events = Array.isArray(outcome.value) ? outcome.value : [];
    console.log(`[mentions-watch] discovery source=${label} ok in ${ms}ms (mention_events=${events.length})`);
    return { label, status: 'ok', ms, events, error: null };
  } finally {
    if (timer) clearTimeout(timer);
    if (graceTimer) clearTimeout(graceTimer);
  }
}

function writeDiscoveryStatusArtifact({ stateRoot, date, sources }) {
  const dir = resolve(stateRoot, 'mentions', date);
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, 'discovery-status.json');
  writeFileSync(path, JSON.stringify({
    date,
    generated_at_utc: new Date().toISOString(),
    degraded: sources.some((s) => s.status !== 'ok'),
    sources: sources.map((s) => ({ source: s.label, status: s.status, ms: s.ms, error: s.error })),
  }, null, 2));
  return path;
}

async function discoverCandidates({ stateRoot, date, env, eventsFile, discovery = {} }) {
  if (eventsFile) {
    // Test/recovery hook: read candidate events from a local JSON file
    // instead of the network. Shape: [{ event_ticker, ... }] or { events: [...] }.
    const parsed = JSON.parse(readFileSync(eventsFile, 'utf8'));
    return {
      candidates: annotateResearchRoutes(Array.isArray(parsed) ? parsed : (parsed.events ?? [])),
      sources: [{ label: 'events-file', status: 'ok', ms: 0, events: [], error: null }],
      degraded: false,
    };
  }

  const discoverImpl = discovery.discoverMentionEvents ?? discoverMentionEvents;
  const fetchBroadImpl = discovery.fetchKalshiEvents ?? fetchKalshiEvents;
  const collectAlphaImpl = discovery.collectAlphaMentionIntake ?? collectAlphaMentionIntake;
  const timeoutMs = discovery.timeoutMs ?? discoverySourceTimeoutMs(env);
  const partialGraceMs = discovery.partialGraceMs ?? discoveryPartialGraceMs(env);

  const candidates = [];
  const sources = [];

  // Source 1: scraper-FIRST board scan with deterministic /series fallback.
  const scraper = await runDiscoverySource('scraper-board', async (signal) => {
    const disc = await discoverImpl({ pageFetcher: buildPageFetcherFromEnv(env), signal });
    console.log(`[mentions-watch] discovery sources: scrape=${JSON.stringify(disc?.sources?.scrape ?? {})} series=${JSON.stringify(disc?.sources?.series ?? {})}`);
    return filterMentionEvents(disc?.events ?? []).mentionEvents;
  }, timeoutMs, partialGraceMs);
  sources.push(scraper);
  candidates.push(...scraper.events);

  // Source 2: broad language discovery — catches mention markets nested under
  // series that are not themselves tagged/named "mention".
  const broad = await runDiscoverySource('kalshi-broad', async (signal) => {
    const res = await fetchBroadImpl('broad', { signal });
    return filterMentionEvents(res?.events ?? []).mentionEvents;
  }, timeoutMs, partialGraceMs);
  sources.push(broad);
  candidates.push(...broad.events);

  // Source 3: local Alpha intake. Inject a signal-aware fetch so a hung intake
  // request actually aborts at the deadline instead of holding the process open.
  const alpha = await runDiscoverySource('alpha-intake', async (signal) => {
    const res = await collectAlphaImpl({
      stateRoot,
      env,
      fallbackEvents: [],
      fetchImpl: (url, opts = {}) => fetch(url, { ...opts, signal }),
    });
    return res?.events ?? [];
  }, timeoutMs, partialGraceMs);
  sources.push(alpha);
  candidates.push(...alpha.events);

  const degraded = sources.some((s) => s.status !== 'ok');
  if (degraded) {
    writeDiscoveryStatusArtifact({ stateRoot, date, sources });
  }
  return { candidates: annotateResearchRoutes(dedupeByTicker(candidates)), sources, degraded };
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
  discovery = {},
} = {}) {
  // Single-run lock: overlapping cron fires exit 0 quietly instead of
  // double-generating/double-sending. Stale locks (dead pid) are recovered.
  const lockPath = runLockPath(stateRoot, date);
  const lock = acquireRunLock(lockPath);
  if (!lock.acquired) {
    console.log(`[mentions-watch] ${date}: already running (lock held by pid ${lock.holder?.pid ?? 'unknown'} since ${lock.holder?.started_utc ?? 'unknown'}) — exit 0`);
    return { skipped: 'already-running', fresh: [], seen: [], deferred: [], retryable: [], attempted: [], retried: [], queued: [], retryQueued: [], succeeded: [], failed: [], held: [], discovery: { degraded: false, sources: [] } };
  }
  try {
    return await watchLocked({ date, stateRoot, dryRun, markSeenOnly, eventsFile, env, runStepImpl, maxNewPerRunDefault, discovery });
  } finally {
    releaseRunLock(lockPath);
  }
}

async function watchLocked({ date, stateRoot, dryRun, markSeenOnly, eventsFile, env, runStepImpl, maxNewPerRunDefault, discovery = {} }) {
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
  const discoveryResult = await discoverCandidates({ stateRoot, date, env, eventsFile, discovery });
  const candidates = discoveryResult.candidates;
  const discoverySummary = { degraded: discoveryResult.degraded, sources: discoveryResult.sources };
  if (discoveryResult.degraded) {
    const skipped = discoveryResult.sources.filter((s) => s.status !== 'ok').map((s) => `${s.label}:${s.status}`).join(', ');
    console.error(`[mentions-watch] ${date}: DEGRADED discovery — ${skipped}; continuing with available sources`);
  }
  const { fresh, seen, deferred, retryable } = selectNewTodayEvents(candidates, ledger, date);

  if (deferred.length) {
    const sample = deferred.slice(0, 8).map(e => `${e.event_ticker}(${deriveEventDate(e) ?? 'undated'})`).join(', ');
    console.log(`[mentions-watch] ${date}: ${deferred.length} non-today event(s) excluded (past/future/undated), e.g. ${sample}`);
  }
  if (!fresh.length && !retryable.length) {
    console.log(`[mentions-watch] ${date}: no new today events (seen=${seen.length}, watchlist=${deferred.length}) — quiet exit`);
    return { fresh: [], seen, deferred, retryable: [], attempted: [], retried: [], queued: [], retryQueued: [], succeeded: [], failed: [], held: normalizedHeld, discovery: discoverySummary };
  }

  if (markSeenOnly) {
    // Backlog suppression / baseline seeding: record ALL fresh events as seen
    // without generating or sending (bypasses the throttle on purpose), so
    // only events listed AFTER this point deliver.
    const nowUtc = new Date().toISOString();
    for (const ev of fresh) {
      ledger.events[ev.event_ticker] = {
        event_ticker: ev.event_ticker,
        event_url: ev.event_url ?? ev.url ?? canonicalKalshiEventUrl(ev.event_ticker) ?? null,
        declared_source_url: declaredSourceUrlForEvent({ ev, stateRoot, date }),
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
    return { fresh, seen, deferred, retryable, attempted: [], retried: [], queued: [], retryQueued: [], succeeded: [], failed: [], held: normalizedHeld, discovery: discoverySummary };
  }

  // Throttle: never burst-deliver a big first-run batch. Events beyond the cap
  // are NOT touched in the ledger — they stay unseen and are picked up on the
  // next watcher run.
  // Deliver the most imminent same-day events first so an about-to-start packet
  // is never queued behind events with hours of runway.
  const orderedFresh = orderByImminence(fresh);
  const attempted = orderedFresh.slice(0, maxNewPerRun);
  const queued = orderedFresh.slice(maxNewPerRun);
  const orderedRetryable = orderByImminence(retryable);
  const retried = orderedRetryable.slice(0, maxRetryPerRun);
  const retryQueued = orderedRetryable.slice(maxRetryPerRun);
  console.log(`[mentions-watch] ${date}: ${fresh.length} new today event(s); processing ${attempted.length} this run (max_new_per_run=${maxNewPerRun})${queued.length ? `; ${queued.length} queued for next run: ${queued.map(e => e.event_ticker).join(', ')}` : ''}`);
  if (retryable.length) {
    console.log(`[mentions-watch] ${date}: ${retryable.length} retryable event(s); processing ${retried.length} this run (max_retry_per_run=${maxRetryPerRun}, max_retry_attempts=${maxRetryAttempts})${retryQueued.length ? `; ${retryQueued.length} queued for next run: ${retryQueued.map(e => e.event_ticker).join(', ')}` : ''}`);
  }

  if (dryRun) {
    const dryTargets = [...attempted.map((ev) => ev.event_ticker), ...retried.map((ev) => ev.event_ticker)];
    console.log(`[mentions-watch] [dry-run] would generate + send packets for: ${dryTargets.join(', ')} (ledger not written)`);
    return { fresh, seen, deferred, retryable, attempted, retried, queued, retryQueued, succeeded: [], failed: [], held: normalizedHeld, discovery: discoverySummary };
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
      const eventPath = resolve(stateRoot, 'mentions', date, 'kalshi-events', `${ticker.replace(/[^A-Z0-9_-]/gi, '_').slice(0, 80)}.json`);
      if (existsSync(eventPath)) {
        try {
          const persistedEvent = JSON.parse(readFileSync(eventPath, 'utf8'));
          entry.event_url = persistedEvent?.event_url
            ?? canonicalKalshiEventUrl(persistedEvent?.event_ticker ?? ticker)
            ?? entry.event_url
            ?? null;
          entry.declared_source_url = persistedEvent?.declared_source_url ?? entry.declared_source_url ?? null;
        } catch {
          // Keep the discovery-side value when the persisted artifact is unreadable.
        }
      }
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
  return { fresh, seen, deferred, retryable, attempted, retried, queued, retryQueued, succeeded, failed, held, discovery: discoverySummary };
}

export const DEFAULT_MAX_NEW_PER_RUN = 6;
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

// Flush stdio, then force-exit. A discovery source aborted at its deadline can
// leave an undici socket in the connection pool that stays referenced for
// several seconds (the connect timeout of a black-holed upstream), which would
// otherwise keep this process alive past the cron's hard script timeout even
// though all watcher logic has finished. An explicit exit makes termination
// deterministic; the short drain guards against truncating piped logs.
function flushAndExit(code) {
  let pending = 0;
  let exited = false;
  const finish = () => { if (!exited) { exited = true; process.exit(code); } };
  for (const stream of [process.stdout, process.stderr]) {
    if (stream.writableLength > 0) {
      pending += 1;
      stream.write('', () => { pending -= 1; if (pending === 0) finish(); });
    }
  }
  if (pending === 0) finish();
  // Safety net: never let a stalled drain hold the process open.
  setTimeout(finish, 250).unref();
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
  main().then(
    () => flushAndExit(0),
    (err) => {
      console.error(`[mentions-watch] failed: ${err.message}`);
      flushAndExit(1);
    },
  );
}
