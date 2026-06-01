import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  sendDiscordPacket,
  resolveWebhookEnv,
  DISCORD_ENV_BY_TYPE,
  DISCORD_FALLBACK_ENV,
} from '../scripts/shared/discord-send.mjs';

// A representative sectioned decision board (NOT raw inventory).
function sampleBoard() {
  return [
    '=== NASCAR Sunday Decision Board ===',
    'date: 2026-05-31',
    '',
    'TLDR BOARD:',
    '  rows=38 :: top_edge=0 | watchlist=0 | blocked=38 | pass=0',
    '',
    '=== 1. TOP EDGE CANDIDATES (0) ===',
    '  (none)',
    '=== 4. BLOCKED / NEEDS SOURCE (38) ===',
    '#1 [BLOCKED] KX-1 :: needs model',
  ].join('\n');
}

// A fake webhook URL with the right SHAPE (test-only; not a real credential).
const FAKE_WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz-0123456789_test';

test('resolveWebhookEnv prefers the type-specific var over the fallback', () => {
  const env = {
    DISCORD_WEBHOOK_URL_NASCAR: FAKE_WEBHOOK,
    DISCORD_WEBHOOK_URL: FAKE_WEBHOOK,
  };
  const r = resolveWebhookEnv('nascar-sunday', env);
  assert.equal(r.selectedVar, 'DISCORD_WEBHOOK_URL_NASCAR');
  assert.equal(r.present, true);
});

test('resolveWebhookEnv falls back to DISCORD_WEBHOOK_URL when type var unset', () => {
  const env = { DISCORD_WEBHOOK_URL: FAKE_WEBHOOK };
  const r = resolveWebhookEnv('mlb-daily', env);
  assert.equal(r.selectedVar, DISCORD_FALLBACK_ENV);
  assert.equal(r.present, true);
});

test('resolveWebhookEnv reports absence when nothing is set', () => {
  const r = resolveWebhookEnv('mentions-daily', {});
  assert.equal(r.present, false);
  assert.equal(r.selectedVar, null);
  assert.equal(r.specificVar, DISCORD_ENV_BY_TYPE['mentions-daily']);
});

test('env missing => no network call, no send, clear status', async () => {
  let fetchCalled = false;
  const res = await sendDiscordPacket({
    packetText: sampleBoard(),
    packetType: 'nascar-sunday',
    send: true,
    env: {}, // no credential
    fetchImpl: async () => { fetchCalled = true; return { ok: true, status: 200 }; },
  });
  assert.equal(fetchCalled, false, 'fetch must not be called without a credential');
  assert.equal(res.sent, false);
  assert.match(res.status, /credential missing/);
  assert.match(res.error, /DISCORD_WEBHOOK_URL/);
});

test('raw inventory text is refused before any send', async () => {
  const inv = '=== RAW CONTRACT INVENTORY (AUDIT ONLY — NOT IN MAIN PACKET) ===\n#1 ...';
  await assert.rejects(
    () => sendDiscordPacket({ packetText: inv, packetType: 'nascar-sunday', send: true, env: { DISCORD_WEBHOOK_URL: FAKE_WEBHOOK } }),
    /RAW inventory/,
  );
});

test('dry-run never calls the network even when a credential is present', async () => {
  let fetchCalled = false;
  const res = await sendDiscordPacket({
    packetText: sampleBoard(),
    packetType: 'nascar-sunday',
    send: false, // dry-run
    env: { DISCORD_WEBHOOK_URL_NASCAR: FAKE_WEBHOOK },
    fetchImpl: async () => { fetchCalled = true; return { ok: true, status: 200 }; },
  });
  assert.equal(fetchCalled, false, 'dry-run must not touch the network');
  assert.equal(res.sent, false);
  assert.match(res.status, /dry-run/);
  assert.equal(res.credentialPresent, true);
});

test('live mode calls fetch once per part with a JSON content payload', async () => {
  const calls = [];
  const res = await sendDiscordPacket({
    packetText: sampleBoard(),
    packetType: 'nascar-sunday',
    title: 'CPC NASCAR',
    send: true,
    env: { DISCORD_WEBHOOK_URL_NASCAR: FAKE_WEBHOOK },
    fetchImpl: async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 204 }; },
  });
  assert.equal(res.sent, true);
  assert.equal(res.status, 'sent');
  assert.equal(calls.length, res.partCount, 'one fetch per part');
  for (const c of calls) {
    const body = JSON.parse(c.opts.body);
    assert.ok(typeof body.content === 'string' && body.content.length > 0);
    assert.equal(c.opts.method, 'POST');
  }
});

test('oversized packet splits into multiple parts, one fetch each', async () => {
  const big = sampleBoard() + '\n' + Array.from({ length: 400 }, (_, i) =>
    `#${i} [BLOCKED] KX-${i} :: long driver name needs model layer to unlock edge here`).join('\n');
  const calls = [];
  const res = await sendDiscordPacket({
    packetText: big,
    packetType: 'nascar-sunday',
    send: true,
    env: { DISCORD_WEBHOOK_URL_NASCAR: FAKE_WEBHOOK },
    fetchImpl: async () => { calls.push(1); return { ok: true, status: 204 }; },
  });
  assert.ok(res.partCount > 1, 'oversized packet splits');
  assert.equal(calls.length, res.partCount);
  assert.equal(res.sent, true);
});

test('the webhook URL value never appears in the result object', async () => {
  const res = await sendDiscordPacket({
    packetText: sampleBoard(),
    packetType: 'nascar-sunday',
    send: true,
    env: { DISCORD_WEBHOOK_URL_NASCAR: FAKE_WEBHOOK },
    fetchImpl: async () => ({ ok: true, status: 204 }),
  });
  const serialized = JSON.stringify(res);
  assert.doesNotMatch(serialized, /api\/webhooks\/123456789012345678/, 'webhook value must not leak into result');
  assert.doesNotMatch(serialized, /AbCdEfGhIjKlMnOpQrStUvWxYz/, 'webhook token must not leak into result');
  // it should still report the env var NAME
  assert.equal(res.selectedEnvVar, 'DISCORD_WEBHOOK_URL_NASCAR');
});

test('a leaked secret in the board is scrubbed and counted before send', async () => {
  const leaky = sampleBoard() + '\nwebhook_url=https://discord.com/api/webhooks/999/SECRETTOKENVALUE12345';
  let bodySeen = '';
  const res = await sendDiscordPacket({
    packetText: leaky,
    packetType: 'alerts',
    send: true,
    env: { DISCORD_WEBHOOK_URL: FAKE_WEBHOOK },
    fetchImpl: async (url, opts) => { bodySeen += opts.body; return { ok: true, status: 204 }; },
  });
  assert.ok(res.redactions >= 1, 'leak detected and redacted');
  assert.doesNotMatch(bodySeen, /SECRETTOKENVALUE12345/, 'secret never reaches the wire');
});

test('a non-2xx Discord response is reported as a failure with status code only', async () => {
  const res = await sendDiscordPacket({
    packetText: sampleBoard(),
    packetType: 'alerts',
    send: true,
    env: { DISCORD_WEBHOOK_URL: FAKE_WEBHOOK },
    fetchImpl: async () => ({ ok: false, status: 429 }),
  });
  assert.equal(res.sent, false);
  assert.match(res.status, /send failed/);
  assert.match(res.error, /429/);
  // ensure the webhook value is not echoed in the error
  assert.doesNotMatch(JSON.stringify(res), /api\/webhooks\/123456789012345678/);
});

test('a malformed (non-webhook-shaped) env value is refused without sending', async () => {
  let fetchCalled = false;
  const res = await sendDiscordPacket({
    packetText: sampleBoard(),
    packetType: 'alerts',
    send: true,
    env: { DISCORD_WEBHOOK_URL: 'not-a-real-webhook-url' },
    fetchImpl: async () => { fetchCalled = true; return { ok: true, status: 204 }; },
  });
  assert.equal(fetchCalled, false);
  assert.equal(res.sent, false);
  assert.match(res.status, /malformed webhook/);
  // the bad value must not be echoed
  assert.doesNotMatch(JSON.stringify(res), /not-a-real-webhook-url/);
});
