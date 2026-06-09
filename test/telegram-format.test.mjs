import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TELEGRAM_HARD_LIMIT,
  buildTelegramMessages,
  splitForTelegram,
} from '../channels/telegram/telegram-format.mjs';

function sampleResponse(packetText) {
  return {
    title: 'CPC Telegram Test',
    packetText,
    artifactPaths: [],
  };
}

test('Telegram formatter splits every message under 4096 chars', () => {
  const longPacket = Array.from({ length: 500 }, (_, i) =>
    `#${i} [WAITING] KXTEST-${i} :: source-backed row awaiting model layer`).join('\n');
  const out = buildTelegramMessages(sampleResponse(longPacket));
  assert.ok(out.partCount > 1);
  for (const part of out.parts) {
    assert.ok(part.length <= TELEGRAM_HARD_LIMIT, `part length ${part.length} must be <= ${TELEGRAM_HARD_LIMIT}`);
  }
});

test('splitForTelegram returns one part when text fits', () => {
  assert.deepEqual(splitForTelegram('short packet'), ['short packet']);
});

test('Telegram formatter scrubs secret-looking strings', () => {
  const fakeToken = '1234567890:' + 'AAFakeFakeFakeFakeFakeFakeFakeFakeFake';
  const fakeKey = 'sk-' + 'thisIsAFakeSecretValue123456789';
  const out = buildTelegramMessages(sampleResponse(`token=${fakeToken}\napi_key=${fakeKey}`));
  const joined = out.parts.join('\n');
  assert.ok(out.redactions >= 2);
  assert.doesNotMatch(joined, /AAFakeFakeFake/);
  assert.doesNotMatch(joined, /thisIsAFakeSecretValue/);
  assert.match(joined, /<REDACTED/);
});

test('Telegram formatter refuses raw inventory dumps', () => {
  assert.throws(
    () => buildTelegramMessages(sampleResponse('=== RAW CONTRACT INVENTORY (AUDIT ONLY - NOT IN MAIN PACKET) ===\n#1 ...')),
    /raw inventory/i,
  );
});
