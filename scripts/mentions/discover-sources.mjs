#!/usr/bin/env node
// discover-sources.mjs
//
// Declared-source DISCOVERY step for mentions events. Runs BEFORE bounded
// source research. For each Kalshi mention event it mines a SMALL, bounded set
// of official source URLs and writes a per-event manifest:
//
//   state/mentions/<date>/sources/<EVENT_TICKER>.json -> { urls: [...], ... }
//
// Source candidates, in priority order (route-aware):
//   1. declared manual overrides  state/mentions/<date>/sources-manual/<TICKER>.json
//   2. official URLs parsed out of the Kalshi market resolution rules
//      (rules_secondary / rules_primary) — these are the settlement/source
//      links Kalshi itself names (e.g. https://www.governor.ny.gov/).
//
// HARD BOUNDS / SAFETY:
//   * URLs only — never search engines, never crawl seeds, never market pages.
//   * Price/market hosts (kalshi, polymarket, predictit, betting/odds sites)
//     are rejected so market data can never enter the research layer.
//   * Capped to MENTIONS_RESEARCH_MAX_SOURCES (default 3, hard ceiling 10).
//   * Pure text parsing — this module makes ZERO network requests. Fetching is
//     the job of source-research.mjs (declared-URL, cache-first, bounded).
//   * No trades. No order placement. No pricing fields ever written.
//
// If no usable source URL is found, the manifest is written with
// status:"NO_DECLARED_SOURCES" and urls:[] so downstream research reports an
// explicit verified gap instead of a silent stub.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { maxSources } from './source-research.mjs';

// ─── status codes ────────────────────────────────────────────────────────────
export const SOURCE_STATUS = Object.freeze({
  DECLARED: 'DECLARED',
  NO_DECLARED_SOURCES: 'NO_DECLARED_SOURCES',
  SOURCE_FETCHED: 'SOURCE_FETCHED',
  SOURCE_FETCHED_BROWSER: 'SOURCE_FETCHED_BROWSER',
  SOURCE_FETCH_BLOCKED_BY_SITE: 'SOURCE_FETCH_BLOCKED_BY_SITE',
  SOURCE_FETCH_TIMEOUT: 'SOURCE_FETCH_TIMEOUT',
});

// ─── price / market host firewall ────────────────────────────────────────────
// Any host matching these is a market/price surface and must never be used as
// research evidence. Keeps market data out of layer_records by construction.
const PRICE_HOST_PATTERNS = [
  /(^|\.)kalshi\.com$/i,
  /(^|\.)polymarket\.com$/i,
  /(^|\.)predictit\.org$/i,
  /(^|\.)manifold\.markets$/i,
  /(^|\.)betfair\./i,
  /(^|\.)draftkings\.com$/i,
  /(^|\.)fanduel\.com$/i,
  /(^|\.)oddschecker\./i,
  /(^|\.)bovada\./i,
];

export function isPriceLikeUrl(url) {
  let host;
  try {
    host = new URL(String(url)).hostname;
  } catch {
    return true; // unparseable -> reject
  }
  return PRICE_HOST_PATTERNS.some((re) => re.test(host));
}

// ─── url extraction (text only) ──────────────────────────────────────────────
export function extractUrlsFromText(text) {
  if (!text) return [];
  const raw = String(text).match(/https?:\/\/[^\s"'<>)\]}]+/gi) || [];
  const cleaned = raw.map((u) => u.replace(/[.,;:!?]+$/, '').trim()).filter(Boolean);
  return [...new Set(cleaned)];
}

// ─── route-aware ranking ─────────────────────────────────────────────────────
// Lower rank = preferred. Political/public announcements prefer official/
// government pages first; earnings prefer IR/SEC/press; sports lean on the
// settled-history adapter so current-source URLs are optional support.
function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

function rankForProfile(url, profile) {
  const host = hostOf(url);
  const path = (() => { try { return new URL(url).pathname.toLowerCase(); } catch { return ''; } })();
  const isGov = /\.gov$/.test(host) || host.endsWith('.gov') || /(^|\.)gov\./.test(host);
  const isIr = /investor|ir\.|sec\.gov/.test(host) || /investor|press|news/.test(path);
  const isTranscript = /transcript|caption|press|remarks|advisory/.test(path);

  if (profile === 'earnings_mentions') {
    if (/sec\.gov$/.test(host)) return 0;
    if (isIr) return 1;
    if (isTranscript) return 2;
    return 5;
  }
  if (profile === 'sports_announcer_mentions') {
    // settled-history leads; current sources are optional support
    if (isTranscript) return 3;
    return 6;
  }
  // political_mentions (default): official/government first
  if (isGov) return 0;
  if (isTranscript) return 1;
  if (/press|whitehouse|official/.test(host)) return 2;
  return 5;
}

// ─── manual override manifest ────────────────────────────────────────────────
// state/mentions/<date>/sources-manual/<TICKER>.json -> { urls: [...] }
export function loadManualOverrides(stateRoot, date, eventTicker) {
  const path = resolve(stateRoot, 'mentions', date, 'sources-manual', `${eventTicker}.json`);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const urls = Array.isArray(parsed?.urls) ? parsed.urls : [];
    return urls.map((u) => String(u).trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// ─── manifest paths ──────────────────────────────────────────────────────────
export function sourcesManifestPath(stateRoot, date, eventTicker) {
  return resolve(stateRoot, 'mentions', date, 'sources', `${eventTicker}.json`);
}

// ─── core discovery (pure: text in, manifest object out) ─────────────────────
export function discoverSourcesForEvent(event, { profile, manualUrls = [], env = process.env } = {}) {
  const eventTicker = event?.event_ticker || 'UNKNOWN';
  const markets = Array.isArray(event?.markets) ? event.markets : [];

  const provenance = [];
  const candidates = [];

  // 1. manual overrides win (highest priority, kept ahead of parsed URLs)
  for (const u of manualUrls) {
    if (isPriceLikeUrl(u)) { provenance.push({ url: u, origin: 'manual_override', rejected: 'price_or_market_host' }); continue; }
    candidates.push({ url: u, origin: 'manual_override', rank: -1 });
    provenance.push({ url: u, origin: 'manual_override' });
  }

  // 2. official URLs named inside the Kalshi resolution rules
  const ruleTexts = [];
  if (typeof event?.rules_secondary === 'string') ruleTexts.push(event.rules_secondary);
  if (typeof event?.rules_primary === 'string') ruleTexts.push(event.rules_primary);
  for (const m of markets) {
    if (typeof m?.rules_secondary === 'string') ruleTexts.push(m.rules_secondary);
    if (typeof m?.rules_primary === 'string') ruleTexts.push(m.rules_primary);
  }
  for (const url of extractUrlsFromText(ruleTexts.join('\n'))) {
    if (isPriceLikeUrl(url)) { provenance.push({ url, origin: 'kalshi_resolution_rules', rejected: 'price_or_market_host' }); continue; }
    if (candidates.some((c) => c.url === url)) continue;
    candidates.push({ url, origin: 'kalshi_resolution_rules', rank: rankForProfile(url, profile) });
    provenance.push({ url, origin: 'kalshi_resolution_rules' });
  }

  // stable priority sort (manual first via rank -1, then route-aware rank)
  candidates.sort((a, b) => a.rank - b.rank);

  const cap = maxSources(env);
  const urls = [...new Set(candidates.map((c) => c.url))].slice(0, cap);
  const status = urls.length ? SOURCE_STATUS.DECLARED : SOURCE_STATUS.NO_DECLARED_SOURCES;

  return {
    event_ticker: eventTicker,
    profile: profile ?? null,
    status,
    urls,
    capped_at: cap,
    candidates_considered: candidates.length,
    provenance,
    discovered_at: new Date().toISOString(),
    discovered_by: 'discover-sources.mjs',
  };
}

// ─── idempotent manifest writer ──────────────────────────────────────────────
// Writes the manifest only when absent unless force=true. Never clobbers a
// human-authored sources/<TICKER>.json. Returns { path, manifest, wrote }.
export function ensureSourcesManifest(event, {
  profile,
  stateRoot = resolve('state'),
  date,
  env = process.env,
  force = false,
  manualUrls = null,
} = {}) {
  const eventTicker = event?.event_ticker || 'UNKNOWN';
  const path = sourcesManifestPath(stateRoot, date, eventTicker);

  if (!force && existsSync(path)) {
    try {
      return { path, manifest: JSON.parse(readFileSync(path, 'utf8')), wrote: false };
    } catch {
      // unreadable manifest -> regenerate below
    }
  }

  const overrides = manualUrls ?? loadManualOverrides(stateRoot, date, eventTicker);
  const manifest = discoverSourcesForEvent(event, { profile, manualUrls: overrides, env });
  mkdirSync(resolve(stateRoot, 'mentions', date, 'sources'), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2), 'utf8');
  return { path, manifest, wrote: true };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { date: null, event: null, force: false, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--date') opts.date = argv[++i];
    else if (a === '--event') opts.event = argv[++i];
    else if (a === '--force') opts.force = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!opts.date) opts.date = new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) throw new Error(`Invalid --date: ${opts.date} (expected YYYY-MM-DD)`);
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node scripts/mentions/discover-sources.mjs --date YYYY-MM-DD [--event TICKER] [--force] [--dry-run]');
    process.exit(0);
  }

  // inferProfile lives in the collector; import lazily to avoid a cycle.
  const { inferProfile } = await import('./collect-mentions-research.mjs');

  const stateRoot = resolve('state');
  const kalshiDir = resolve(stateRoot, 'mentions', opts.date, 'kalshi-events');
  if (!existsSync(kalshiDir)) {
    console.error(`[discover-sources] No kalshi-events dir: ${kalshiDir}`);
    process.exit(1);
  }

  let files = readdirSync(kalshiDir).filter((f) => f.endsWith('.json'));
  if (opts.event) files = files.filter((f) => f === `${opts.event}.json` || f.startsWith(`${opts.event}.`));
  if (!files.length) {
    console.error(`[discover-sources] No matching kalshi-events for date=${opts.date}${opts.event ? ` event=${opts.event}` : ''}`);
    process.exit(1);
  }

  let declared = 0;
  let noSource = 0;
  for (const file of files) {
    let event;
    try {
      event = JSON.parse(readFileSync(join(kalshiDir, file), 'utf8'));
    } catch (err) {
      console.error(`[discover-sources] SKIP parse ${file}: ${err.message}`);
      continue;
    }
    const profile = inferProfile(event);

    if (opts.dryRun) {
      const overrides = loadManualOverrides(stateRoot, opts.date, event.event_ticker);
      const manifest = discoverSourcesForEvent(event, { profile, manualUrls: overrides });
      console.log(`[discover-sources] [dry-run] ${event.event_ticker} profile=${profile} status=${manifest.status} urls=${JSON.stringify(manifest.urls)}`);
      if (manifest.status === SOURCE_STATUS.DECLARED) declared += 1; else noSource += 1;
      continue;
    }

    const { path, manifest, wrote } = ensureSourcesManifest(event, { profile, stateRoot, date: opts.date, force: opts.force });
    if (manifest.status === SOURCE_STATUS.DECLARED) declared += 1; else noSource += 1;
    console.log(`[discover-sources] ${wrote ? 'WROTE' : 'KEEP '} ${path} status=${manifest.status} urls=${manifest.urls.length}`);
  }

  console.log(`[discover-sources] DONE date=${opts.date} declared=${declared} no_source=${noSource}${opts.dryRun ? ' (dry-run)' : ''}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`[discover-sources] ERROR: ${err.message}`);
    process.exit(1);
  });
}
