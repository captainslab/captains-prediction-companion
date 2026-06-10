#!/usr/bin/env node
// Mentions Alpha intake helpers.
//
// Intentional URL intake for mentions only:
// - manual queue under state/mentions/intake/manual_queue.json
// - recent URL dedupe cache under state/mentions/intake/recent_urls.json
// - env seed URLs via CPC_MENTIONS_SEED_URLS
// - tiny fallback only when no manual/env intake exists
//
// Pure-ish helpers: queue/cache I/O is local, fetch is injected, no scoring,
// no rendering, no trading.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseKalshiUrl } from '../../channels/shared/intake.mjs';

const KALSHI_EVENTS_API = 'https://api.elections.kalshi.com/trade-api/v2/events';
const KALSHI_MARKETS_API = 'https://api.elections.kalshi.com/trade-api/v2/markets';
const DEFAULT_RECENT_LIMIT = 200;
const DEFAULT_FALLBACK_LIMIT = 1;
const DEFAULT_SEED_ENV = 'CPC_MENTIONS_SEED_URLS';

function asText(value) {
  return value == null ? '' : String(value).trim();
}

function readJsonIfExists(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalizeStoredArray(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  if (data && Array.isArray(data.urls)) return data.urls;
  return [];
}

function canonicalizeKalshiUrl(raw) {
  const parsed = parseKalshiUrl(raw);
  if (!parsed) return null;
  const url = new URL(parsed.url);
  url.hash = '';
  url.search = '';
  url.hostname = url.hostname.toLowerCase();
  const canonicalUrl = url.toString().replace(/\/$/, '');
  const resourceKind = parsed.path.startsWith('/events/')
    ? 'event'
    : parsed.path.startsWith('/markets/')
      ? 'market'
      : 'url';
  const eventTicker = parsed.tail || null;
  return {
    raw: asText(raw),
    canonical_url: canonicalUrl,
    event_ticker: eventTicker,
    resource_kind: resourceKind,
    intake_key: eventTicker || canonicalUrl,
  };
}

function normalizeQueueItem(item) {
  if (typeof item === 'string') {
    const normalized = canonicalizeKalshiUrl(item);
    return normalized ? { ...normalized, note: null } : null;
  }
  if (!item || typeof item !== 'object') return null;
  if (item.canonical_url && item.intake_key) {
    return {
      raw: asText(item.raw || item.url || item.source_url || item.href || item.canonical_url),
      canonical_url: asText(item.canonical_url),
      event_ticker: asText(item.event_ticker) || null,
      resource_kind: asText(item.resource_kind) || 'url',
      intake_key: asText(item.intake_key),
      note: asText(item.note) || null,
      added_at: asText(item.added_at || item.addedAt) || null,
      source: asText(item.source) || 'manual_queue',
    };
  }
  const normalized = canonicalizeKalshiUrl(item.url ?? item.source_url ?? item.href ?? '');
  if (!normalized) return null;
  return {
    ...normalized,
    note: asText(item.note) || null,
    added_at: asText(item.added_at || item.addedAt) || null,
    source: asText(item.source) || 'manual_queue',
  };
}

function normalizeRecentItem(item) {
  if (!item || typeof item !== 'object') return null;
  const normalized = canonicalizeKalshiUrl(item.url ?? item.source_url ?? item.href ?? '');
  const key = asText(item.key) || normalized?.intake_key || null;
  if (!normalized && !key) return null;
  return {
    key: key || normalized.intake_key,
    url: normalized?.canonical_url || asText(item.url ?? item.source_url ?? item.href ?? ''),
    event_ticker: asText(item.event_ticker) || normalized?.event_ticker || null,
    source: asText(item.source) || null,
    status: asText(item.status) || 'processed',
    seen_at: asText(item.seen_at || item.seenAt) || null,
  };
}

function dedupeRecentItems(items) {
  const map = new Map();
  for (const item of items) {
    if (!item?.key) continue;
    map.set(item.key, item);
  }
  return [...map.values()].slice(0, DEFAULT_RECENT_LIMIT);
}

function upsertRecentItem(items, record) {
  if (!record?.key) return dedupeRecentItems(items);
  const next = items.filter((item) => item?.key !== record.key);
  next.unshift(record);
  return dedupeRecentItems(next);
}

function getIntakePaths(stateRoot = resolve('state')) {
  const dir = resolve(stateRoot, 'mentions', 'intake');
  return {
    dir,
    manualQueuePath: join(dir, 'manual_queue.json'),
    recentUrlsPath: join(dir, 'recent_urls.json'),
  };
}

function loadManualQueue(stateRoot = resolve('state')) {
  const { manualQueuePath } = getIntakePaths(stateRoot);
  return normalizeStoredArray(readJsonIfExists(manualQueuePath, null))
    .map(normalizeQueueItem)
    .filter(Boolean);
}

function loadRecentUrls(stateRoot = resolve('state')) {
  const { recentUrlsPath } = getIntakePaths(stateRoot);
  return normalizeStoredArray(readJsonIfExists(recentUrlsPath, null))
    .map(normalizeRecentItem)
    .filter(Boolean);
}

function writeManualQueue(stateRoot, items) {
  const { manualQueuePath } = getIntakePaths(stateRoot);
  writeJson(manualQueuePath, { version: 1, items });
}

function writeRecentUrls(stateRoot, items) {
  const { recentUrlsPath } = getIntakePaths(stateRoot);
  writeJson(recentUrlsPath, { version: 1, items: dedupeRecentItems(items) });
}

function parseSeedUrls(env = process.env) {
  const raw = asText(env?.[DEFAULT_SEED_ENV]);
  if (!raw) return [];

  let values = [];
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) values = parsed.map(asText);
    } catch {
      values = raw.split(/[\n,;\s]+/g);
    }
  } else {
    values = raw.split(/[\n,;\s]+/g);
  }

  const seen = new Set();
  const normalized = [];
  for (const value of values) {
    const item = normalizeQueueItem(value);
    if (!item) continue;
    if (seen.has(item.intake_key)) continue;
    seen.add(item.intake_key);
    normalized.push(item);
  }
  return normalized;
}

function formatIntakeSummary(summary = {}) {
  return [
    `manual_queue_offered=${summary.manual_queue_offered ?? 0}`,
    `manual_queue_consumed=${summary.manual_queue_consumed ?? 0}`,
    `env_seeds_offered=${summary.env_seeds_offered ?? 0}`,
    `env_seeds_consumed=${summary.env_seeds_consumed ?? 0}`,
    `env_seeds_skipped_recent=${summary.env_seeds_skipped_recent ?? 0}`,
    `fallback_used=${summary.fallback_used ? 'yes' : 'no'}`,
    `fallback_emitted=${summary.fallback_emitted ?? 0}`,
    `recent_cache_size=${summary.recent_cache_size ?? 0}`,
    `accepted=${summary.accepted ?? 0}`,
    `skipped_recent=${summary.skipped_recent ?? 0}`,
    `invalid=${summary.invalid ?? 0}`,
  ].join(' ');
}

async function fetchMentionEventByTicker(eventTicker, fetchImpl = fetch) {
  const ticker = asText(eventTicker);
  if (!ticker) return null;

  // Primary: direct event endpoint /events/{event_ticker}
  const directUrl = `${KALSHI_EVENTS_API}/${encodeURIComponent(ticker)}`;
  const directRes = await fetchImpl(directUrl);
  if (directRes.ok) {
    const data = await directRes.json();
    if (data && typeof data === 'object' && data.event_ticker) {
      return data;
    }
  } else if (directRes.status !== 404) {
    const body = typeof directRes.text === 'function' ? await directRes.text().catch(() => '') : '';
    throw new Error(`Kalshi intake fetch failed ${directRes.status} for ${ticker} at ${directUrl}${body ? ` :: ${body.slice(0, 120)}` : ''}`);
  }

  // Fallback: markets endpoint /markets?event_ticker={event_ticker}
  const marketsUrl = `${KALSHI_MARKETS_API}?event_ticker=${encodeURIComponent(ticker)}`;
  const marketsRes = await fetchImpl(marketsUrl);
  if (!marketsRes.ok) {
    if (marketsRes.status === 404) return null;
    const body = typeof marketsRes.text === 'function' ? await marketsRes.text().catch(() => '') : '';
    throw new Error(`Kalshi intake fetch failed ${marketsRes.status} for ${ticker} at ${marketsUrl}${body ? ` :: ${body.slice(0, 120)}` : ''}`);
  }
  const marketsData = await marketsRes.json();
  const markets = Array.isArray(marketsData?.markets) ? marketsData.markets : [];
  if (markets.length === 0) return null;
  return {
    event_ticker: ticker,
    markets,
  };
}

function decorateEvent(event, normalized, source) {
  return {
    ...event,
    source_url: normalized.canonical_url,
    intake_source: source,
    intake_key: normalized.intake_key,
    intake_resource_kind: normalized.resource_kind,
  };
}

function fallbackEventEntry(event) {
  if (!event || typeof event !== 'object') return null;
  const ticker = asText(event.event_ticker || event.ticker);
  if (!ticker) return null;
  return {
    ...event,
    source_url: asText(event.source_url) || `https://kalshi.com/markets/${ticker}`,
    intake_source: 'fallback_discovery',
    intake_key: ticker,
    intake_resource_kind: 'event',
  };
}

export async function collectAlphaMentionIntake({
  stateRoot = resolve('state'),
  env = process.env,
  fetchImpl = fetch,
  fallbackEvents = [],
  fallbackLimit = DEFAULT_FALLBACK_LIMIT,
} = {}) {
  const paths = getIntakePaths(stateRoot);
  const manualQueue = loadManualQueue(stateRoot);
  const recentUrls = loadRecentUrls(stateRoot);
  const recentKeys = new Set(recentUrls.map((item) => item.key).filter(Boolean));
  const nextQueue = [];
  let nextRecent = recentUrls.slice();

  const summary = {
    manual_queue_offered: manualQueue.length,
    manual_queue_consumed: 0,
    env_seeds_offered: 0,
    env_seeds_consumed: 0,
    env_seeds_skipped_recent: 0,
    fallback_used: false,
    fallback_emitted: 0,
    recent_cache_size: recentKeys.size,
    accepted: 0,
    skipped_recent: 0,
    invalid: 0,
  };

  const intakeEvents = [];
  const seedUrls = parseSeedUrls(env);
  const sawExplicitIntake = manualQueue.length > 0 || seedUrls.length > 0;

  const processEntry = async (entry, source, keepOnFailure) => {
    const normalized = normalizeQueueItem(entry);
    if (!normalized) {
      summary.invalid += 1;
      if (source === 'manual_queue') summary.manual_queue_consumed += 1;
      return;
    }

    if (recentKeys.has(normalized.intake_key)) {
      summary.skipped_recent += 1;
      if (source === 'manual_queue') summary.manual_queue_consumed += 1;
      if (source === 'env_seed') summary.env_seeds_skipped_recent += 1;
      return;
    }

    try {
      const event = await fetchMentionEventByTicker(normalized.event_ticker, fetchImpl);
      if (!event) {
        summary.invalid += 1;
        const recentRecord = {
          key: normalized.intake_key,
          url: normalized.canonical_url,
          event_ticker: normalized.event_ticker,
          source,
          status: 'invalid_resolution',
          seen_at: new Date().toISOString(),
        };
        nextRecent = upsertRecentItem(nextRecent, recentRecord);
        recentKeys.add(normalized.intake_key);
        if (source === 'manual_queue') summary.manual_queue_consumed += 1;
        if (source === 'env_seed') summary.env_seeds_consumed += 1;
        return;
      }

      const decorated = decorateEvent(event, normalized, source);
      intakeEvents.push(decorated);
      summary.accepted += 1;
      const recentRecord = {
        key: normalized.intake_key,
        url: normalized.canonical_url,
        event_ticker: normalized.event_ticker,
        source,
        status: 'accepted',
        seen_at: new Date().toISOString(),
      };
      nextRecent = upsertRecentItem(nextRecent, recentRecord);
      recentKeys.add(normalized.intake_key);
      if (source === 'manual_queue') summary.manual_queue_consumed += 1;
      if (source === 'env_seed') summary.env_seeds_consumed += 1;
    } catch (err) {
      if (keepOnFailure) {
        nextQueue.push(typeof entry === 'string' ? { url: entry, source } : { ...entry, source });
        return;
      }
      // Env/fallback failures are not persisted; they are safe to retry later.
      return;
    }
  };

  for (const entry of manualQueue) {
    await processEntry(entry, 'manual_queue', true);
  }

  summary.env_seeds_offered = seedUrls.length;
  for (const entry of seedUrls) {
    await processEntry(entry, 'env_seed', false);
  }

  if (!sawExplicitIntake && intakeEvents.length === 0 && fallbackEvents.length > 0) {
    const candidates = fallbackEvents
      .map(fallbackEventEntry)
      .filter((item) => item && item.intake_key && !recentKeys.has(item.intake_key))
      .slice(0, Math.max(0, Number(fallbackLimit) || 0));
    if (candidates.length) {
      summary.fallback_used = true;
      summary.fallback_emitted = candidates.length;
      for (const event of candidates) {
        intakeEvents.push(event);
        nextRecent = upsertRecentItem(nextRecent, {
          key: event.intake_key,
          url: event.source_url,
          event_ticker: event.event_ticker || event.intake_key,
          source: 'fallback',
          status: 'accepted',
          seen_at: new Date().toISOString(),
        });
        recentKeys.add(event.intake_key);
      }
    }
  }

  writeManualQueue(stateRoot, nextQueue);
  writeRecentUrls(stateRoot, nextRecent);

  return {
    paths,
    events: intakeEvents,
    summary,
  };
}

export {
  DEFAULT_SEED_ENV,
  collectAlphaMentionIntake as collectMentionAlphaIntake,
  formatIntakeSummary as formatAlphaIntakeSummary,
  getIntakePaths,
  loadManualQueue,
  loadRecentUrls,
  parseSeedUrls as parseAlphaSeedUrls,
};
