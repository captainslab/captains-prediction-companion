// Tiny cache + IO helper for NASCAR Stage 2 dry-run adapters.
// Atomic JSON/text writes only. No network. No credentials. No trading.
import { mkdirSync, renameSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true });
}

export function writeJsonAtomic(filePath, value) {
  const absolutePath = resolve(filePath);
  ensureDir(dirname(absolutePath));
  const tempPath = `${absolutePath}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tempPath, absolutePath);
  return absolutePath;
}

export function writeTextAtomic(filePath, value) {
  const absolutePath = resolve(filePath);
  ensureDir(dirname(absolutePath));
  const tempPath = `${absolutePath}.tmp`;
  writeFileSync(tempPath, value.endsWith('\n') ? value : `${value}\n`, 'utf8');
  renameSync(tempPath, absolutePath);
  return absolutePath;
}

export function readJsonIfExists(filePath) {
  const absolutePath = resolve(filePath);
  if (!existsSync(absolutePath)) return null;
  try {
    return JSON.parse(readFileSync(absolutePath, 'utf8'));
  } catch {
    return null;
  }
}

export function formatDateInTimeZone(date = new Date(), timeZone = 'America/Chicago') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function defaultDiscoveryDir(runDate) {
  return `state/nascar/${runDate}/discovery`;
}

export function isoNow(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

// Shared envelope constructor used by every Stage 2 NASCAR source adapter.
// Stage 2 is read-only / fixture-first. No trade, order, stake, pick,
// recommendation, fair value, or execution fields are permitted in records.
export function makeEnvelope({
  source_id,
  status,
  checked_at_utc,
  cache_path,
  required = false,
  records = [],
  warnings = [],
  errors = [],
  source_urls = [],
}) {
  return {
    source_id,
    status,
    checked_at_utc,
    cache_key: `${source_id}_${checked_at_utc}`,
    cache_path,
    required,
    records,
    warnings,
    errors,
    source_urls,
  };
}
