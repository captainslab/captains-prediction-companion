// Minimal smoke tests for packet generator helpers.
// No network. No filesystem outside a temp dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parsePacketArgs,
  chunkForTelegram,
  ensurePacketDir,
  writeAudit,
  TELEGRAM_SAFE_CHARS,
  NO_TRADE_FOOTER,
} from '../scripts/packets/lib/common.mjs';

test('parsePacketArgs accepts --date and --dry-run', () => {
  const opts = parsePacketArgs(['--date', '2026-05-18', '--dry-run']);
  assert.equal(opts.date, '2026-05-18');
  assert.equal(opts.dryRun, true);
});

test('parsePacketArgs rejects bad date', () => {
  assert.throws(() => parsePacketArgs(['--date', 'not-a-date']));
});

test('parsePacketArgs defaults date to today (YYYY-MM-DD)', () => {
  const opts = parsePacketArgs([]);
  assert.match(opts.date, /^\d{4}-\d{2}-\d{2}$/);
});

test('chunkForTelegram returns single chunk under limit', () => {
  const chunks = chunkForTelegram('hello world');
  assert.equal(chunks.length, 1);
});

test('chunkForTelegram splits long text into <= TELEGRAM_SAFE_CHARS-ish parts', () => {
  const big = 'x'.repeat(TELEGRAM_SAFE_CHARS * 3 + 50);
  const chunks = chunkForTelegram(big);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) {
    assert.ok(c.length <= TELEGRAM_SAFE_CHARS + 50, `chunk length ${c.length} too large`);
  }
});

test('writeAudit writes txt + meta and chunk files when oversized', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'packet-test-'));
  try {
    const dir = ensurePacketDir(tmp, '2026-05-18', 'unit-test');
    const big = 'y'.repeat(TELEGRAM_SAFE_CHARS * 2 + 10);
    const w = writeAudit(dir, 'sample', big);
    const meta = JSON.parse(readFileSync(w.metaPath, 'utf8'));
    assert.equal(meta.no_trades_placed, true);
    assert.ok(meta.chunk_count >= 2);
    assert.equal(w.chunkCount, meta.chunk_count);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('NO_TRADE_FOOTER is the literal expected sentence', () => {
  assert.equal(NO_TRADE_FOOTER, 'No trades placed by this workflow.');
});
