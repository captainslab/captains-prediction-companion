import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  scrubSecrets,
  looksLikeRawInventory,
  splitForDiscord,
  buildDiscordPost,
  routeDiscordPosts,
  DISCORD_HARD_LIMIT,
  CPC_CHANNEL_MAP,
} from '../scripts/shared/discord-format.mjs';

// A representative sectioned decision board (the kind generate-*.mjs emit).
function sampleBoard() {
  return [
    '=== MLB Daily Decision Board ===',
    'date: 2026-05-31',
    '',
    'TLDR BOARD:',
    '  rows=139 :: top_edge=1 | watchlist=4 | blocked=126 | pass=8',
    '  legend: edge_status PICK>LEAN>FADE>WATCH>BLOCKED>PASS; Market price is NEVER a composite input.',
    '',
    '=== 1. TOP EDGE CANDIDATES (1) ===',
    '#1 [PICK] KX-1 :: Over 6.5 runs',
    '    model: fair=85% score=85 posture=PICK layers=6/9 conf=medium',
    '    market: implied=0.70 yes_ask=0.70 | edge=+4pp',
    '',
    '=== 2. WATCHLIST / TRIGGER BOARD (0) ===',
    '  (none)',
    '',
    '=== 3. FADES / OVERPRICED (0) ===',
    '  (none)',
    '',
    '=== 4. BLOCKED / NEEDS SOURCE (1) ===',
    '#1 [BLOCKED] KX-2 :: needs source',
    '',
    '=== 5. AUDIT ARTIFACTS ===',
    '  - /state/packets/2026-05-31/mlb-daily/x.inventory.txt',
  ].join('\n');
}

test('scrubSecrets redacts discord webhook, bot tokens, and telegram tokens', () => {
  const dirty = [
    'webhook: https://discord.com/api/webhooks/123456789012345678/abcDEF-ghiJKL_mnoPQR',
    'DISCORD_BOT_TOKEN=mfa.aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789',
    'tg 1234567890:AAFakeFakeFakeFakeFakeFakeFakeFakeFake',
    'api_key: sk-thisisaverylongsecretkeyvalue0000',
  ].join('\n');
  const { text, redactions } = scrubSecrets(dirty);
  assert.ok(redactions >= 3, 'multiple secrets redacted');
  assert.doesNotMatch(text, /api\/webhooks\/123456789012345678/);
  assert.doesNotMatch(text, /mfa\.aBcDeFgHiJkLmNoPqRsTuVwXyZ/);
  assert.doesNotMatch(text, /AAFakeFakeFake/);
  assert.match(text, /<REDACTED/);
});

test('clean board produces zero redactions', () => {
  const { redactions } = scrubSecrets(sampleBoard());
  assert.equal(redactions, 0, 'a clean decision board has no secret-looking tokens');
});

test('looksLikeRawInventory detects the audit-only inventory header', () => {
  assert.equal(looksLikeRawInventory('=== RAW CONTRACT INVENTORY (AUDIT ONLY — NOT IN MAIN PACKET) ==='), true);
  assert.equal(looksLikeRawInventory(sampleBoard()), false);
});

test('buildDiscordPost refuses to post a raw inventory dump', () => {
  const inv = '=== RAW CONTRACT INVENTORY (AUDIT ONLY — NOT IN MAIN PACKET) ===\n#1 ...\n#2 ...';
  assert.throws(() => buildDiscordPost({ packetText: inv }), /RAW inventory/);
});

test('buildDiscordPost requires packet text', () => {
  assert.throws(() => buildDiscordPost({ packetText: '' }), /required/);
});

test('every Discord message part stays under the hard 2000-char limit', () => {
  // Build an oversized board by repeating a blocked row many times.
  const big = sampleBoard() + '\n' + Array.from({ length: 400 }, (_, i) =>
    `#${i} [BLOCKED] KX-${i} :: long driver name needs source layer to unlock edge here`).join('\n');
  const { parts, partCount } = buildDiscordPost({ packetText: big, title: 'CPC MLB' });
  assert.ok(partCount > 1, 'oversized packet splits into multiple parts');
  for (const p of parts) {
    assert.ok(p.length <= DISCORD_HARD_LIMIT, `part length ${p.length} must be <= ${DISCORD_HARD_LIMIT}`);
  }
  // splitting preserves the [part i/n] markers
  assert.match(parts[0], /\[part 1\//);
});

test('buildDiscordPost preserves the canonical packet sections', () => {
  const { parts } = buildDiscordPost({ packetText: sampleBoard(), title: 'CPC MLB' });
  const joined = parts.join('\n');
  assert.match(joined, /TLDR BOARD:/);
  assert.match(joined, /TOP EDGE CANDIDATES/);
  assert.match(joined, /WATCHLIST \/ TRIGGER BOARD/);
  assert.match(joined, /FADES \/ OVERPRICED/);
  assert.match(joined, /BLOCKED \/ NEEDS SOURCE/);
  assert.match(joined, /AUDIT ARTIFACTS/);
});

test('artifact paths are linked, not dumped, and never carry file contents', () => {
  const { parts } = buildDiscordPost({
    packetText: sampleBoard(),
    title: 'CPC MLB',
    artifactPaths: ['/state/packets/2026-05-31/mlb-daily/x.inventory.txt'],
  });
  const joined = parts.join('\n');
  assert.match(joined, /audit artifacts \(open locally, not posted\)/);
  assert.match(joined, /x\.inventory\.txt/);
  // the inventory CONTENTS (RAW header) must never appear
  assert.doesNotMatch(joined, /RAW CONTRACT INVENTORY/);
});

test('splitForDiscord returns single part when text fits', () => {
  const parts = splitForDiscord('short text');
  assert.equal(parts.length, 1);
  assert.equal(parts[0], 'short text');
});

test('routeDiscordPosts maps packet types to CPC channels without sending', () => {
  const out = routeDiscordPosts([
    { packetType: 'mlb-daily', packetText: sampleBoard() },
    { packetType: 'nascar-sunday', packetText: sampleBoard() },
    { packetType: 'mentions-daily', packetText: sampleBoard() },
    { packetType: 'unknown-type', packetText: sampleBoard() },
  ]);
  assert.equal(out[0].channel, CPC_CHANNEL_MAP['mlb-daily']);
  assert.equal(out[1].channel, '#cpc-nascar');
  assert.equal(out[2].channel, '#cpc-mentions');
  assert.equal(out[3].channel, '#cpc-alerts', 'unknown packet types fall back to alerts');
  // dry-run: payloads are returned, nothing is sent
  for (const p of out) assert.ok(Array.isArray(p.parts) && p.parts.length >= 1);
});

test('a secret accidentally embedded in a board is scrubbed before posting', () => {
  const leaky = sampleBoard() + '\nwebhook_url=https://discord.com/api/webhooks/999/SECRETTOKENVALUE12345';
  const { parts, redactions } = buildDiscordPost({ packetText: leaky, title: 'CPC' });
  assert.ok(redactions >= 1, 'leak detected and redacted');
  assert.doesNotMatch(parts.join('\n'), /SECRETTOKENVALUE12345/);
});
