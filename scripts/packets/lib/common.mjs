// Shared helpers for packet generators.
// No credentials. No trades. No order placement.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const TELEGRAM_SAFE_CHARS = 3500;
export const NO_TRADE_FOOTER = 'No trades placed by this workflow.';

export function parsePacketArgs(argv) {
  const opts = { date: null, dryRun: false, stateRoot: 'state', help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--date') opts.date = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--state-root') opts.stateRoot = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!opts.date) {
    const d = new Date();
    opts.date = d.toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) {
    throw new Error(`Invalid --date value: ${opts.date} (expected YYYY-MM-DD)`);
  }
  return opts;
}

export function ensurePacketDir(stateRoot, date, packetType) {
  const dir = resolve(stateRoot, 'packets', date, packetType);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function chunkForTelegram(text, limit = TELEGRAM_SAFE_CHARS) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(cursor + limit, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end);
      if (nl > cursor + Math.floor(limit * 0.5)) end = nl;
    }
    chunks.push(text.slice(cursor, end));
    cursor = end;
  }
  return chunks.map((c, i) => `[part ${i + 1}/${chunks.length}]\n${c.trim()}`);
}

export function writeAudit(dir, baseName, packetText, meta = {}) {
  const safeBase = baseName.replace(/[^a-z0-9._-]/gi, '_').slice(0, 80);
  const txtPath = join(dir, `${safeBase}.txt`);
  const metaPath = join(dir, `${safeBase}.meta.json`);
  writeFileSync(txtPath, packetText, 'utf8');
  const chunks = chunkForTelegram(packetText);
  writeFileSync(
    metaPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        char_count: packetText.length,
        chunk_count: chunks.length,
        chunk_lengths: chunks.map((c) => c.length),
        no_trades_placed: true,
        ...meta,
      },
      null,
      2,
    ),
    'utf8',
  );
  if (chunks.length > 1) {
    for (let i = 0; i < chunks.length; i += 1) {
      writeFileSync(join(dir, `${safeBase}.chunk-${i + 1}.txt`), chunks[i], 'utf8');
    }
  }
  return { txtPath, metaPath, chunkCount: chunks.length };
}

// Dry-run twin of writeAudit: same return shape, zero filesystem writes.
// Callers honoring --dry-run must use this so preview runs can never leave
// deliverable artifacts behind for a sender to pick up.
export function previewAudit(dir, baseName, packetText) {
  const safeBase = baseName.replace(/[^a-z0-9._-]/gi, '_').slice(0, 80);
  return {
    txtPath: join(dir, `${safeBase}.txt`),
    metaPath: join(dir, `${safeBase}.meta.json`),
    chunkCount: chunkForTelegram(packetText).length,
  };
}

export function findExistingStateDir(stateRoot, sport, date) {
  // Best-effort: look for an existing state/<sport>/<date>/ artifact dir.
  const candidates = [
    resolve(stateRoot, sport, date),
    resolve(stateRoot, sport, 'workspace', date),
    resolve(stateRoot, sport, 'discovery', date),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isDirectory()) return c;
  }
  // Fallback: scan for any subdir starting with date.
  const root = resolve(stateRoot, sport);
  if (existsSync(root) && statSync(root).isDirectory()) {
    for (const child of readdirSync(root)) {
      const p = join(root, child);
      try {
        if (statSync(p).isDirectory() && existsSync(join(p, date))) return join(p, date);
      } catch {}
    }
  }
  return null;
}

export function readJsonIfExists(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function textFromSpawnValue(value) {
  if (value == null) return '';
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return String(value);
}

export function formatPacketCommand(command, args = []) {
  return [command, ...args].join(' ');
}

export function runPacketCommand(command, args = [], options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const runner = options.runner ?? spawnSync;
  const result = runner(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
  });
  const status = typeof result?.status === 'number' ? result.status : result?.error ? 1 : 0;
  const stdout = textFromSpawnValue(result?.stdout).trim();
  const stderr = textFromSpawnValue(result?.stderr).trim();
  const error = result?.error ? (result.error.message ?? String(result.error)) : null;
  return {
    ok: status === 0 && !error,
    command,
    args,
    cwd,
    status,
    stdout,
    stderr,
    error,
    label: formatPacketCommand(command, args),
  };
}

export function packetHeader({ title, date, packetType, sources = [] }) {
  return [
    `=== ${title} ===`,
    `date: ${date}`,
    `packet_type: ${packetType}`,
    `generated_utc: ${new Date().toISOString()}`,
    sources.length ? `sources: ${sources.join(', ')}` : 'sources: (none discovered)',
    '',
  ].join('\n');
}

export function packetFooter() {
  return ['', '---', NO_TRADE_FOOTER, 'No bankroll advice. No order placement. Research only.'].join('\n');
}

export function printDryRunSummary({ packetType, date, dir, items }) {
  const lines = [
    `[dry-run] packet_type=${packetType} date=${date}`,
    `[dry-run] audit_dir=${dir}`,
    `[dry-run] item_count=${items.length}`,
  ];
  for (const it of items) {
    lines.push(`[dry-run]   - ${it.name}  chunks=${it.chunkCount}  file=${it.txtPath}`);
  }
  lines.push(`[dry-run] ${NO_TRADE_FOOTER}`);
  return lines.join('\n');
}
