// Resumable, day-chunked Statcast ingest for the regular-game HR model.
// Raw training rows stay under .cache/ and are never written to CPC state/.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isTerminalPa } from '../source-adapters/baseball-savant-distributions.mjs';
import {
  buildStatcastCsvUrl,
  parseStatcastCsv,
} from '../source-adapters/baseball-savant-readonly.mjs';

export const STATCAST_CACHE_SCHEMA = 'cpc_statcast_terminal_pa_day_v1';
export const DEFAULT_STATCAST_CACHE_DIR = '.cache/mlb-hr-statcast';
const DAY_MS = 86_400_000;
const MAX_CONCURRENCY = 4;

const KEEP_FIELDS = Object.freeze([
  'game_date', 'game_type', 'game_pk', 'at_bat_number', 'batter', 'pitcher',
  'player_name', 'events', 'stand', 'p_throws', 'home_team', 'away_team',
  'inning_topbot', 'bb_type', 'launch_speed', 'launch_angle',
  'launch_speed_angle', 'hit_distance_sc', 'hc_x', 'barrel',
]);

function ymd(value) {
  const text = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`invalid date: ${value}`);
  return parsed.toISOString().slice(0, 10);
}

export function enumerateDays(start, end) {
  const first = new Date(`${ymd(start)}T00:00:00.000Z`).getTime();
  const last = new Date(`${ymd(end)}T00:00:00.000Z`).getTime();
  if (first > last) throw new Error('start date must not be after end date');
  const days = [];
  for (let cursor = first; cursor <= last; cursor += DAY_MS) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return days;
}

function cachePath(cacheDir, season, day) {
  return join(resolve(cacheDir), String(season), `${day}.json`);
}

function slimTerminalRow(row) {
  const output = {};
  for (const field of KEEP_FIELDS) output[field] = row[field] ?? '';
  return output;
}

function atomicWriteJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, 'utf8');
  renameSync(temporary, filePath);
}

function validCachedDay(filePath, day) {
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (parsed?.schema_version !== STATCAST_CACHE_SCHEMA || parsed?.date !== day || !Array.isArray(parsed?.rows)) return null;
    if (!parsed.rows.every(isTerminalPa)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

class StatcastRateLimitError extends Error {
  constructor(status, day) {
    super(`Baseball Savant returned HTTP ${status} for ${day}`);
    this.name = 'StatcastRateLimitError';
    this.status = status;
    this.day = day;
  }
}

async function fetchDay(day, {
  fetchImpl,
  retries,
  delayMs,
  userAgent,
} = {}) {
  const sourceUrl = buildStatcastCsvUrl(day);
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await delay(delayMs * (2 ** (attempt - 1)));
    try {
      const response = await fetchImpl(sourceUrl, {
        method: 'GET',
        headers: {
          accept: 'text/csv,text/plain,*/*',
          'user-agent': userAgent,
        },
      });
      if (response.status === 403 || response.status === 429) {
        throw new StatcastRateLimitError(response.status, day);
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const csvText = await response.text();
      const parsed = parseStatcastCsv(csvText);
      const exactDay = parsed.rows.filter((row) => ymd(row.game_date) === day);
      const regularSeasonRows = exactDay.filter((row) => !row.game_type || row.game_type === 'R');
      const rows = regularSeasonRows.filter(isTerminalPa).map(slimTerminalRow);
      return {
        sourceUrl,
        rawRows: parsed.rows.length,
        exactDayRows: exactDay.length,
        rows,
      };
    } catch (error) {
      if (error instanceof StatcastRateLimitError) throw error;
      lastError = error;
    }
  }
  throw new Error(`Statcast fetch failed for ${day} after ${retries + 1} attempt(s): ${lastError?.message ?? 'unknown error'}`);
}

export function summarizeCachedDays(records = []) {
  const rows = records.flatMap((record) => record.rows ?? []);
  return {
    days: records.length,
    terminal_pa: rows.length,
    home_runs: rows.filter((row) => String(row.events).trim().toLowerCase() === 'home_run').length,
    first_date: records[0]?.date ?? null,
    last_date: records[records.length - 1]?.date ?? null,
  };
}

export function readCachedTerminalRows({
  cacheDir = DEFAULT_STATCAST_CACHE_DIR,
  season = 2025,
  start = `${season}-03-18`,
  end = `${season}-09-28`,
  requireComplete = true,
} = {}) {
  const records = [];
  const missing = [];
  for (const day of enumerateDays(start, end)) {
    const record = validCachedDay(cachePath(cacheDir, season, day), day);
    if (record) records.push(record);
    else missing.push(day);
  }
  if (requireComplete && missing.length) {
    throw new Error(`Statcast cache incomplete: ${missing.length} missing day(s); first missing ${missing[0]}`);
  }
  return {
    rows: records.flatMap((record) => record.rows),
    records,
    missing,
    summary: summarizeCachedDays(records),
  };
}

export async function ingestStatcastSeason({
  season = 2025,
  start = `${season}-03-18`,
  end = `${season}-09-28`,
  cacheDir = DEFAULT_STATCAST_CACHE_DIR,
  concurrency = 3,
  delayMs = 250,
  retries = 2,
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
  onProgress = () => {},
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new Error(`concurrency must be an integer from 1 to ${MAX_CONCURRENCY}`);
  }
  if (!Number.isInteger(retries) || retries < 0) throw new Error('retries must be a non-negative integer');
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('delayMs must be non-negative');

  const days = enumerateDays(start, end);
  const cached = [];
  const pending = [];
  for (const day of days) {
    const existing = validCachedDay(cachePath(cacheDir, season, day), day);
    if (existing) cached.push(existing);
    else pending.push(day);
  }

  let cursor = 0;
  let stopped = null;
  const fetched = [];
  const failures = [];
  const userAgent = 'captains-prediction-companion-hr-training/1.0';

  async function worker() {
    while (!stopped) {
      const index = cursor;
      cursor += 1;
      if (index >= pending.length) return;
      const day = pending[index];
      if (index > 0 && delayMs > 0) await delay(delayMs);
      try {
        const result = await fetchDay(day, { fetchImpl, retries, delayMs, userAgent });
        const payload = {
          schema_version: STATCAST_CACHE_SCHEMA,
          season,
          date: day,
          fetched_utc: now(),
          source_url: result.sourceUrl,
          raw_pitch_rows: result.rawRows,
          exact_day_pitch_rows: result.exactDayRows,
          terminal_pa: result.rows.length,
          home_runs: result.rows.filter((row) => String(row.events).trim().toLowerCase() === 'home_run').length,
          rows: result.rows,
        };
        atomicWriteJson(cachePath(cacheDir, season, day), payload);
        fetched.push(payload);
        onProgress({ status: 'fetched', day, terminal_pa: payload.terminal_pa, home_runs: payload.home_runs });
      } catch (error) {
        const failure = {
          day,
          status: error instanceof StatcastRateLimitError ? error.status : null,
          error: error instanceof Error ? error.message : String(error),
        };
        failures.push(failure);
        onProgress({ status: 'failed', ...failure });
        if (error instanceof StatcastRateLimitError) stopped = failure;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length || 1) }, () => worker()));
  const complete = readCachedTerminalRows({ cacheDir, season, start, end, requireComplete: false });
  const manifest = {
    schema_version: 'cpc_statcast_terminal_pa_manifest_v1',
    season,
    requested_range: { start: ymd(start), end: ymd(end), days: days.length },
    generated_utc: now(),
    cache_dir: resolve(cacheDir),
    cached_before_run: cached.length,
    fetched_this_run: fetched.length,
    missing_days: complete.missing,
    stopped,
    failures,
    summary: complete.summary,
  };
  atomicWriteJson(join(resolve(cacheDir), String(season), 'manifest.json'), manifest);
  return manifest;
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--season') opts.season = Number(argv[++i]);
    else if (arg === '--start') opts.start = argv[++i];
    else if (arg === '--end') opts.end = argv[++i];
    else if (arg === '--cache-dir') opts.cacheDir = argv[++i];
    else if (arg === '--concurrency') opts.concurrency = Number(argv[++i]);
    else if (arg === '--delay-ms') opts.delayMs = Number(argv[++i]);
    else if (arg === '--retries') opts.retries = Number(argv[++i]);
    else if (arg === '--help') opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node scripts/mlb/hr-engine/statcast-ingest.mjs [--season 2025] [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--cache-dir PATH] [--concurrency 1-4]');
    return;
  }
  const manifest = await ingestStatcastSeason({
    ...opts,
    onProgress: (event) => console.log(JSON.stringify(event)),
  });
  console.log(JSON.stringify(manifest, null, 2));
  if (manifest.stopped || manifest.missing_days.length) process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
}
