import assert from 'node:assert/strict';
import test from 'node:test';
import {
  channelTypeLabel,
  redactDeep,
  normalizeWebhookEntry,
  runInventory,
} from '../scripts/discord/inventory-discord.mjs';

test('channelTypeLabel maps known Discord channel types', () => {
  assert.equal(channelTypeLabel(0), 'guild_text');
  assert.equal(channelTypeLabel(4), 'guild_category');
  assert.equal(channelTypeLabel(5), 'guild_announcement');
  assert.equal(channelTypeLabel(11), 'public_thread');
  assert.equal(channelTypeLabel(15), 'guild_forum');
});

test('redaction removes webhook-URL and token-shaped strings from captured fields', () => {
  const fixture = {
    name: 'ops',
    url: 'https://discord.com/api/webhooks/1/AAAA',
    token: 'Bot.FAKE.TOKEN.value',
    nested: ['https://discord.com/api/webhooks/1/AAAA', 'Bot.FAKE.TOKEN.value'],
  };
  const { value } = redactDeep(fixture);
  const serialized = JSON.stringify(value);
  assert.ok(!serialized.includes('https://discord.com/api/webhooks/1/AAAA'));
  assert.ok(!serialized.includes('Bot.FAKE.TOKEN.value'));
});

test('webhook capture keeps only name id and channelId', () => {
  const captured = normalizeWebhookEntry({
    id: 'w1',
    name: 'general-hook',
    channel_id: 'c1',
    url: 'https://discord.com/api/webhooks/1/AAAA',
    token: 'Bot.FAKE.TOKEN.value',
    application_id: 'ignored',
    user: { id: 'u1' },
  }, 'fallback-channel');

  assert.deepEqual(captured, { name: 'general-hook', id: 'w1', channelId: 'c1' });
  assert.equal(Object.hasOwn(captured, 'url'), false);
  assert.equal(Object.hasOwn(captured, 'token'), false);
});

test('missing-auth path blocks without making any network call', async () => {
  let fetchCalls = 0;
  const result = await runInventory({
    env: {},
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('network should not be called');
    },
    writeFiles: false,
  });

  assert.equal(fetchCalls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.exitCode, 3);
  assert.match(result.message, /DISCORD_BOT_TOKEN/);
  assert.match(result.message, /DISCORD_GUILD_ID/);
});
