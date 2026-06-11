// Minimal smoke tests for packet generator helpers.
// No network. No filesystem outside a temp dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parsePacketArgs,
  chunkForTelegram,
  ensurePacketDir,
  writeAudit,
  previewAudit,
  TELEGRAM_SAFE_CHARS,
  NO_TRADE_FOOTER,
  runPacketCommand,
} from '../scripts/packets/lib/common.mjs';
import { primeMlbResearch, extractGames } from '../scripts/packets/generate-mlb-daily.mjs';
import { primeMentionResearch, primeMentionSourceResearch } from '../scripts/packets/generate-mentions-daily.mjs';

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

test('previewAudit returns deliverable paths without writing files', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'packet-preview-'));
  try {
    const dir = join(tmp, 'packets', '2099-01-01', 'mentions-daily');
    const w = previewAudit(dir, 'sample', 'payload');
    assert.equal(w.chunkCount, 1);
    assert.equal(w.txtPath.endsWith('sample.txt'), true);
    assert.equal(w.metaPath.endsWith('sample.meta.json'), true);
    assert.equal(existsSync(w.txtPath), false);
    assert.equal(existsSync(w.metaPath), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('NO_TRADE_FOOTER is the literal expected sentence', () => {
  assert.equal(NO_TRADE_FOOTER, 'No trades placed by this workflow.');
});


test('runPacketCommand captures command status without shell expansion', () => {
  const result = runPacketCommand('node', ['-e', 'process.stdout.write("ok")']);
  assert.equal(result.ok, true);
  assert.equal(result.stdout, 'ok');
  assert.equal(result.label, 'node -e process.stdout.write("ok")');
});

test('primeMlbResearch runs live-readonly discover before outputs', () => {
  const calls = [];
  const runner = (command, args) => {
    calls.push([command, args]);
    return { status: 0, stdout: '', stderr: '' };
  };
  const attempts = primeMlbResearch('2026-05-18', { runner, cwd: '/tmp/repo' });
  assert.equal(attempts.length, 2);
  assert.deepEqual(calls[0], ['node', ['scripts/mlb/mlb-workspace.mjs', 'discover', '--date', '2026-05-18', '--live-readonly', '--source', 'all']]);
  assert.deepEqual(calls[1], ['node', ['scripts/mlb/mlb-workspace.mjs', 'outputs', '--date', '2026-05-18']]);
});

test('primeMlbResearch stops before outputs when discovery fails', () => {
  const calls = [];
  const runner = (command, args) => {
    calls.push([command, args]);
    return { status: 1, stdout: '', stderr: 'blocked' };
  };
  const attempts = primeMlbResearch('2026-05-18', { runner });
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].ok, false);
  assert.equal(calls.length, 1);
});

test('primeMentionResearch reports exact missing discovery interface instead of inventing events', () => {
  const attempts = primeMentionResearch('2026-05-18', { workflow: { available: false, missing_interface: 'missing mentions CLI' } });
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].ok, false);
  assert.equal(attempts[0].skipped, true);
  assert.match(attempts[0].stderr, /missing mentions CLI/);
});

test('primeMentionResearch invokes available read-only mention workflow', () => {
  const calls = [];
  const workflow = {
    available: true,
    command: 'node',
    argsForDate: date => ['scripts/mentions/mentions-workspace.mjs', 'discover', '--date', date, '--live-readonly'],
  };
  const runner = (command, args) => {
    calls.push([command, args]);
    return { status: 0, stdout: '', stderr: '' };
  };
  const attempts = primeMentionResearch('2026-05-18', { workflow, runner });
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].ok, true);
  assert.deepEqual(calls[0], ['node', ['scripts/mentions/mentions-workspace.mjs', 'discover', '--date', '2026-05-18', '--live-readonly']]);
});

test('primeMentionSourceResearch invokes the source-collector CLI after discovery exists', () => {
  const calls = [];
  const runner = (command, args) => {
    calls.push([command, args]);
    return { status: 0, stdout: '', stderr: '' };
  };
  const attempts = primeMentionSourceResearch('2026-05-18', { runner });
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].ok, true);
  assert.deepEqual(calls[0], ['node', ['scripts/mentions/collect-mentions-research.mjs', '--date', '2026-05-18']]);
});

test('extractGames reads MLB workflow slate_manifest games and normalizes one-packet units', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'packet-mlb-test-'));
  try {
    const fp = join(tmp, 'slate_manifest.json');
    const payload = {
      games: [
        { game_pk: 1, game: 'Away A at Home A', start_time_utc: '2026-05-18T18:00:00Z', teams: { away: 'Away A', home: 'Home A' } },
        { game_pk: 2, game: 'Away B at Home B', start_time_utc: '2026-05-18T20:00:00Z', teams: { away: 'Away B', home: 'Home B' } },
      ],
    };
    writeFileSync(fp, JSON.stringify(payload), 'utf8');
    const games = extractGames([fp]);
    assert.equal(games.length, 2);
    assert.equal(games[0].game_id, 1);
    assert.equal(games[0].matchup, 'Away A at Home A');
    assert.equal(games[0].start_utc, '2026-05-18T18:00:00Z');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
