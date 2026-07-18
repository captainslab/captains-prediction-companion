import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runCorrection } from '../scripts/packets/send-correction.mjs';

const DATE = '2026-07-18';
const STEM = `${DATE}-KXMLBGAME-TEST`;
const NOW_MS = Date.parse('2026-07-18T12:00:00.000Z');
const PACKET = [
  '=== Captain MLB — CPC Packet: Daily Slate Board ===',
  `Date: ${DATE}`,
  'First pitch: 2026-07-18T20:00:00.000Z',
  'NYY at BOS',
  'NOT IN SCORE',
  'Research only. No trades.',
].join('\n');
const ORIGINAL = { utc: '2026-07-18T11:00:00.000Z', message_ids: [101, 102], document_file: `${STEM}.txt` };

function hash(text) {
  return createHash('sha256').update(Buffer.from(text)).digest('hex');
}

function setup({ delivered = true, corrections = [] } = {}) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mlb-correction-'));
  const dir = join(stateRoot, 'packets', DATE, 'mlb-daily');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${STEM}.txt`), PACKET);
  const ledger = {
    schema: 'cpc_packet_delivery_ledger_v1',
    delivered: delivered ? { [STEM]: structuredClone(ORIGINAL) } : {},
    corrections,
  };
  const ledgerPath = join(dir, '.delivery-ledger.json');
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  return { stateRoot, dir, ledgerPath, ledger };
}

function args(ctx, correctionId = 'mlb-board-v1', extra = []) {
  return [
    '--type', 'mlb-daily',
    '--date', DATE,
    '--reason', 'replace stale lineup block',
    '--correction-id', correctionId,
    '--state-root', ctx.stateRoot,
    ...extra,
  ];
}

function deps({ calls, output = [] } = {}) {
  return {
    inspect: () => ({ verdict: 'SEND_ALLOWED' }),
    sendMessage: async (notice) => {
      calls?.push({ kind: 'notice', notice });
      return 9001;
    },
    sendDocument: async (filePath, options) => {
      calls?.push({ kind: 'document', filePath, options });
      return 9002;
    },
    output: (line) => output.push(line),
    nowMs: NOW_MS,
    sleepImpl: async () => {},
  };
}

function cleanup(ctx) {
  rmSync(ctx.stateRoot, { recursive: true, force: true });
}

test('refuses when the original delivered record is missing', async () => {
  const ctx = setup({ delivered: false });
  try {
    await assert.rejects(
      runCorrection(args(ctx).concat('--confirm'), deps({ calls: [] })),
      /original delivery record/,
    );
  } finally {
    cleanup(ctx);
  }
});

test('refuses unsupported types and arbitrary packet-path flags', async () => {
  const ctx = setup();
  try {
    await assert.rejects(
      runCorrection([
        '--type', 'mentions-daily', '--date', DATE, '--reason', 'x', '--correction-id', 'x', '--confirm',
        '--state-root', ctx.stateRoot,
      ], deps({ calls: [] })),
      /unsupported correction packet type/,
    );
    await assert.rejects(
      runCorrection(args(ctx).concat('--confirm', '--file', '/tmp/arbitrary.txt'), deps({ calls: [] })),
      /unsupported flag: --file/,
    );
    await assert.rejects(
      runCorrection(args(ctx).concat('--confirm', '--packet-path', '/tmp/arbitrary.txt'), deps({ calls: [] })),
      /unsupported flag: --packet-path/,
    );
  } finally {
    cleanup(ctx);
  }
});

test('refuses to do anything without --confirm, including dry-run', async () => {
  const ctx = setup();
  try {
    for (const extra of [[], ['--dry-run']]) {
      const calls = [];
      await assert.rejects(runCorrection(args(ctx).concat(extra), deps({ calls })), /--confirm is required/);
      assert.deepEqual(calls, []);
    }
  } finally {
    cleanup(ctx);
  }
});

test('confirmed dry-run prints the notice, document, preview, and id without Telegram or ledger mutation', async () => {
  const ctx = setup();
  const calls = [];
  const output = [];
  const before = readFileSync(ctx.ledgerPath, 'utf8');
  try {
    const result = await runCorrection(args(ctx, 'mlb-board-dry-1').concat('--confirm', '--dry-run'), deps({ calls, output }));
    const expected = {
      utc: new Date(NOW_MS).toISOString(),
      source_packet_stem: STEM,
      reason: 'replace stale lineup block',
      original_message_ids: [101, 102],
      correction_message_ids: null,
      artifact_hash: hash(PACKET),
      operator_mode: 'dry_run',
      correction_id: 'mlb-board-dry-1',
    };
    assert.deepEqual(result.correction, expected);
    assert.deepEqual(output, [
      'CORRECTION_NOTICE: CORRECTED MLB DAILY PACKET — replace stale lineup block',
      `CORRECTION_DOCUMENT: ${STEM}.txt`,
      `CORRECTION_LEDGER_ENTRY: ${JSON.stringify(expected)}`,
      'CORRECTION_ID: mlb-board-dry-1',
    ]);
    assert.deepEqual(calls, []);
    assert.equal(readFileSync(ctx.ledgerPath, 'utf8'), before);
  } finally {
    cleanup(ctx);
  }
});

test('live correction preserves delivered and appends one structured correction with the packet hash', async () => {
  const ctx = setup();
  const calls = [];
  const beforeOriginal = structuredClone(ctx.ledger.delivered[STEM]);
  try {
    const result = await runCorrection(args(ctx, 'mlb-board-live-1').concat('--confirm'), deps({ calls }));
    const disk = JSON.parse(readFileSync(ctx.ledgerPath, 'utf8'));
    assert.deepEqual(disk.delivered[STEM], beforeOriginal);
    assert.equal(disk.corrections.length, 1);
    assert.deepEqual(disk.corrections[0], {
      utc: new Date(NOW_MS).toISOString(),
      source_packet_stem: STEM,
      reason: 'replace stale lineup block',
      original_message_ids: [101, 102],
      correction_message_ids: [9001, 9002],
      artifact_hash: hash(PACKET),
      operator_mode: 'live',
      correction_id: 'mlb-board-live-1',
    });
    assert.deepEqual(calls.map((call) => call.kind), ['notice', 'document']);
    assert.equal(calls[0].notice, 'CORRECTED MLB DAILY PACKET — replace stale lineup block');
    assert.equal(calls[1].filePath, join(ctx.dir, `${STEM}.txt`));
    assert.equal(result.status, 'live');
  } finally {
    cleanup(ctx);
  }
});

test('the same correction id is refused without sends or a second ledger entry', async () => {
  const ctx = setup();
  const firstCalls = [];
  try {
    await runCorrection(args(ctx, 'mlb-board-repeat').concat('--confirm'), deps({ calls: firstCalls }));
    const before = readFileSync(ctx.ledgerPath, 'utf8');
    const secondCalls = [];
    await assert.rejects(
      runCorrection(args(ctx, 'mlb-board-repeat').concat('--confirm', '--dry-run'), deps({ calls: secondCalls })),
      /already recorded/,
    );
    assert.deepEqual(secondCalls, []);
    assert.equal(readFileSync(ctx.ledgerPath, 'utf8'), before);
    assert.equal(JSON.parse(before).corrections.length, 1);
  } finally {
    cleanup(ctx);
  }
});

test('a different correction id succeeds and appends a distinct second entry', async () => {
  const ctx = setup();
  try {
    await runCorrection(args(ctx, 'mlb-board-first').concat('--confirm'), deps({ calls: [] }));
    const second = await runCorrection(args(ctx, 'mlb-board-second').concat('--confirm', '--document-only'), deps({ calls: [] }));
    const disk = JSON.parse(readFileSync(ctx.ledgerPath, 'utf8'));
    assert.equal(second.status, 'live');
    assert.equal(disk.corrections.length, 2);
    assert.deepEqual(disk.corrections.map((entry) => entry.correction_id), ['mlb-board-first', 'mlb-board-second']);
    assert.deepEqual(disk.corrections[1].correction_message_ids, [9002]);
    assert.deepEqual(disk.delivered[STEM], ORIGINAL);
  } finally {
    cleanup(ctx);
  }
});
