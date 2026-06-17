import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  formatMentionsHealthSummary,
  printMentionsHealth,
  summarizeMentionsHealth,
} from '../scripts/mentions/mentions-health.mjs';
const DATE = '2026-06-11';

test('mentions health summary returns counts from fixture ledgers and prints one line', () => {
  const root = mkdtempSync(join(tmpdir(), 'mentions-health-'));
  const seenDir = join(root, 'mentions', DATE);
  const senderDir = join(root, 'packets', DATE, 'mentions-daily');
  mkdirSync(seenDir, { recursive: true });
  mkdirSync(senderDir, { recursive: true });

  writeFileSync(join(seenDir, 'seen-events.json'), JSON.stringify({
    events: {
      'KXDELIVEREDMENTION-26JUN11': { status: 'delivered', delivered_at: '2026-06-11T12:00:00Z', attempts: 1 },
      'KXBLOCKEDMENTION-26JUN11': { status: 'blocked', delivered_at: null, attempts: 1 },
      'KXRETRYMENTION-26JUN11': { status: 'pending', delivered_at: null, attempts: 2 },
      'KXHELDMENTION-26JUN11': { status: 'held', delivered_at: null, attempts: 3, held_reason: 'attempts 3 reached max 3' },
      'KXMARKSEENMENTION-26JUN11': { status: 'mark-seen-only', delivered_at: null, attempts: 0 },
    },
  }, null, 2));
  writeFileSync(join(senderDir, '.delivery-ledger.json'), JSON.stringify({
    delivered: {
      '2026-06-11-KXDELIVEREDMENTION-26JUN11': { utc: '2026-06-11T12:00:00Z', message_ids: [11, 12] },
      '2026-06-11-KXSTALEMENTION-26JUN11': { utc: '2026-06-11T13:00:00Z', message_ids: [21, 22] },
    },
  }, null, 2));

  const summary = summarizeMentionsHealth({ date: DATE, stateRoot: root });
  assert.deepEqual(summary, {
    discovered: 5,
    delivered: 1,
    blocked: 1,
    retryable: 2,
    held: 1,
    stale: 1,
    ledger_ok: true,
  });

  const lines = [];
  const printed = printMentionsHealth({ date: DATE, stateRoot: root, log: (line) => lines.push(line) });
  assert.deepEqual(printed, summary);
  assert.deepEqual(lines, [formatMentionsHealthSummary(DATE, summary)]);
});
