import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDiscordPost,
  scrubSecrets,
  CAPTAINS_CREW_ROUTE_ENV,
  CAPTAINS_CREW_ROUTES,
} from '../scripts/shared/discord-format.mjs';
import {
  resolveRouteWebhookEnv,
  sendDiscordRoute,
  DISCORD_FALLBACK_ENV,
} from '../scripts/shared/discord-send.mjs';

const FAKE_WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz-0123456789_test';

function boardText() {
  return [
    '=== Captain\'s Crew Decision Board ===',
    'date: 2026-07-08',
    '',
    'TLDR BOARD:',
    '  rows=2 :: top_edge=1 | watchlist=1 | blocked=0 | pass=0',
    '',
    '=== 1. TOP EDGE CANDIDATES (1) ===',
    '#1 [PICK] ROUTE-1 :: concise board line',
    '    model: fair=61% score=61 posture=LEAN layers=6/9',
    '',
    '=== 2. WATCHLIST / TRIGGER BOARD (1) ===',
    '#1 [WATCH] ROUTE-2 :: keep watching',
    '',
    '=== 5. AUDIT ARTIFACTS ===',
    '  - /state/packets/2026-07-08/operator-dry-runs/board.inventory.txt',
  ].join('\n');
}

test('dry-run route send never calls the network', async () => {
  let called = false;
  const res = await sendDiscordRoute({
    route: 'operator-dry-runs',
    packetText: boardText(),
    send: false,
    env: { [CAPTAINS_CREW_ROUTE_ENV['operator-dry-runs']]: FAKE_WEBHOOK },
    fetchImpl: () => {
      called = true;
      throw new Error('network must not be touched in dry-run');
    },
  });

  assert.equal(called, false);
  assert.equal(res.sent, false);
  assert.match(res.status, /dry-run/);
  assert.equal(res.route, 'operator-dry-runs');
});

test('missing webhook fails closed without throwing or calling network', async () => {
  let called = false;
  const res = await sendDiscordRoute({
    route: 'delivery-logs',
    packetText: boardText(),
    send: true,
    env: {},
    fetchImpl: () => {
      called = true;
      throw new Error('network must not be touched when webhook is missing');
    },
  });

  assert.equal(called, false);
  assert.equal(res.sent, false);
  assert.match(res.status, /credential missing/);
  assert.equal(res.selectedEnvVar, null);
  assert.equal(res.credentialPresent, false);
});

test('route resolution maps specific routes to placeholder env vars and uses fallback', () => {
  const cases = [
    ['operator-dry-runs', CAPTAINS_CREW_ROUTE_ENV['operator-dry-runs']],
    ['delivery-logs', CAPTAINS_CREW_ROUTE_ENV['delivery-logs']],
    ['mlb-packets', CAPTAINS_CREW_ROUTE_ENV['mlb-packets']],
    ['other-packets', CAPTAINS_CREW_ROUTE_ENV['other-packets']],
  ];

  for (const [route, specificVar] of cases) {
    const withSpecific = resolveRouteWebhookEnv(route, { [specificVar]: FAKE_WEBHOOK });
    assert.equal(withSpecific.selectedVar, specificVar);
    assert.equal(withSpecific.present, true);
  }

  const fallback = resolveRouteWebhookEnv('packet-index', { [DISCORD_FALLBACK_ENV]: FAKE_WEBHOOK });
  assert.equal(fallback.selectedVar, DISCORD_FALLBACK_ENV);
  assert.equal(fallback.present, true);
});

test('unknown route fails closed and never hits the network', async () => {
  const resolved = resolveRouteWebhookEnv('not-a-route', {});
  assert.equal(resolved.selectedVar, null);
  assert.equal(resolved.present, false);
  assert.equal(resolved.error, 'unknown route');

  let called = false;
  const res = await sendDiscordRoute({
    route: 'not-a-route',
    packetText: boardText(),
    send: true,
    env: {},
    fetchImpl: () => {
      called = true;
      throw new Error('network must not be touched for unknown routes');
    },
  });

  assert.equal(called, false);
  assert.equal(res.sent, false);
  assert.equal(res.selectedEnvVar, null);
  assert.equal(res.credentialPresent, false);
  assert.match(res.status, /unknown route/);
});

test('payload splitting keeps every part under the Discord hard limit', () => {
  const bigBoard = `${boardText()}\n${Array.from({ length: 450 }, (_, i) => `#${i} [BLOCKED] ROUTE-${i} :: compact line`).join('\n')}`;
  const post = buildDiscordPost({ packetText: bigBoard, title: 'Captain\'s Crew' });

  assert.ok(post.partCount > 1);
  for (const part of post.parts) {
    assert.ok(part.length <= 2000, `part length ${part.length} must be <= 2000`);
  }
});

test('board text is preserved without injecting promo or gambling phrases', () => {
  const input = boardText();
  const post = buildDiscordPost({ packetText: input, title: 'Captain\'s Crew' });
  const joined = post.parts.join('\n');

  assert.match(joined, /Captain's Crew Decision Board/);
  assert.match(joined, /TOP EDGE CANDIDATES/);
  assert.match(joined, /WATCHLIST \/ TRIGGER BOARD/);
  assert.doesNotMatch(joined, /guaranteed|bet now|sign up|lock of the day|sure thing/i);
});

test('telegram-shaped tokens are redacted and no telegram send text is introduced', () => {
  const dirty = `${boardText()}\ntelegram_token=1234567890:AAFakeFakeFakeFakeFakeFakeFakeFakeFake`;
  const { parts, redactions } = buildDiscordPost({ packetText: dirty, title: 'Captain\'s Crew' });
  const joined = parts.join('\n');

  assert.ok(redactions >= 1);
  assert.doesNotMatch(joined, /1234567890:AAFakeFakeFakeFakeFakeFakeFakeFakeFake/);
  const scrubbed = scrubSecrets('telegram_token=1234567890:AAFakeFakeFakeFakeFakeFakeFakeFakeFake');
  assert.match(scrubbed.text, /<REDACTED_TELEGRAM_TOKEN>/);
  assert.doesNotMatch(joined, /telegram send/i);
});

test('route selection ignores price-like fields and depends only on the route name', () => {
  const specificVar = CAPTAINS_CREW_ROUTE_ENV['research-cards'];
  const base = resolveRouteWebhookEnv('research-cards', { [specificVar]: FAKE_WEBHOOK });
  const noisy = resolveRouteWebhookEnv('research-cards', {
    [specificVar]: FAKE_WEBHOOK,
    bid: 0.41,
    ask: 0.43,
    price: 0.42,
    volume: 1234,
  });

  assert.equal(base.selectedVar, specificVar);
  assert.equal(noisy.selectedVar, base.selectedVar);
  assert.equal(noisy.present, true);
  assert.equal(CAPTAINS_CREW_ROUTES.includes('research-cards'), true);
});
