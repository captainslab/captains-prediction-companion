import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
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
  return `state/mlb/${runDate}/discovery`;
}
