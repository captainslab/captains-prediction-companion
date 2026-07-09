#!/usr/bin/env node
// READ-ONLY Discord inventory snapshot.
//
// GET-only. No channel/webhook/role/permission edits. No message sends. No
// secrets printed. This CLI snapshots guild structure via the Discord REST API
// and writes local inventory artifacts only when auth is present.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { scrubSecrets } from '../shared/discord-format.mjs';

const REPO_ROOT = process.cwd();
const INVENTORY_JSON_PATH = path.join(REPO_ROOT, 'state', 'discord', 'inventory.json');
const INVENTORY_MD_PATH = path.join(REPO_ROOT, 'state', 'discord', 'inventory.md');
const DISCORD_API_BASE = 'https://discord.com/api/v10';

export const DISCORD_CHANNEL_TYPE_LABELS = Object.freeze({
  0: 'guild_text',
  1: 'dm',
  2: 'guild_voice',
  3: 'group_dm',
  4: 'guild_category',
  5: 'guild_announcement',
  10: 'announcement_thread',
  11: 'public_thread',
  12: 'private_thread',
  13: 'guild_stage_voice',
  14: 'guild_directory',
  15: 'guild_forum',
  16: 'guild_media',
});

const EXTRA_SECRET_PATTERNS = [
  [/\bBot\.FAKE\.TOKEN\.value\b/g, '<REDACTED_DISCORD_TOKEN>'],
  [/\b(?:[A-Za-z0-9_-]+\.){3,}[A-Za-z0-9_-]+\b/g, '<REDACTED_TOKEN>'],
  [/https?:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+/gi, '<REDACTED_DISCORD_WEBHOOK>'],
];

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}

export function resolveDiscordAuth(env = process.env) {
  const token = String(env.DISCORD_BOT_TOKEN ?? env.DISCORD_TOKEN ?? '').trim();
  const guildId = String(env.DISCORD_GUILD_ID ?? env.DISCORD_SERVER_ID ?? '').trim();
  return {
    token: token || null,
    guildId: guildId || null,
    tokenEnvVar: env.DISCORD_BOT_TOKEN?.trim() ? 'DISCORD_BOT_TOKEN' : env.DISCORD_TOKEN?.trim() ? 'DISCORD_TOKEN' : null,
    guildEnvVar: env.DISCORD_GUILD_ID?.trim() ? 'DISCORD_GUILD_ID' : env.DISCORD_SERVER_ID?.trim() ? 'DISCORD_SERVER_ID' : null,
  };
}

export function channelTypeLabel(type) {
  return DISCORD_CHANNEL_TYPE_LABELS[type] ?? `type_${type}`;
}

function redactString(value) {
  let { text, redactions } = scrubSecrets(String(value));
  for (const [pattern, replacement] of EXTRA_SECRET_PATTERNS) {
    text = text.replace(pattern, () => {
      redactions += 1;
      return replacement;
    });
  }
  return { text, redactions };
}

export function redactDeep(value) {
  let redactions = 0;

  function walk(input) {
    if (typeof input === 'string') {
      const out = redactString(input);
      redactions += out.redactions;
      return out.text;
    }
    if (Array.isArray(input)) return input.map(walk);
    if (!input || typeof input !== 'object') return input;
    const out = {};
    for (const [key, entry] of Object.entries(input)) {
      out[key] = walk(entry);
    }
    return out;
  }

  return { value: walk(value), redactions };
}

function safeJson(text) {
  return redactString(text).text;
}

export function normalizeWebhookEntry(entry, channelId) {
  const safe = {
    name: entry?.name ?? null,
    id: entry?.id ?? null,
    channelId: entry?.channel_id ?? entry?.channelId ?? channelId ?? null,
  };
  return redactDeep(safe).value;
}

function normalizeRoleEntry(entry, order) {
  return redactDeep({
    id: entry?.id ?? null,
    name: entry?.name ?? null,
    position: entry?.position ?? null,
    order,
  }).value;
}

function normalizeChannelEntry(entry) {
  return redactDeep({
    id: entry?.id ?? null,
    name: entry?.name ?? null,
    type: channelTypeLabel(entry?.type),
    typeId: entry?.type ?? null,
    position: entry?.position ?? null,
    order: null,
    parentId: entry?.parent_id ?? entry?.parentId ?? null,
    categoryId: null,
    categoryName: null,
    webhookCount: 0,
  }).value;
}

function formatHeaderLine(label, value) {
  return `- ${label}: ${safeJson(value)}`;
}

async function discordGetJson(pathname, token, fetchImpl) {
  const res = await fetchImpl(`${DISCORD_API_BASE}${pathname}`, {
    method: 'GET',
    headers: {
      Authorization: `Bot ${token}`,
      Accept: 'application/json',
    },
  });

  const status = res?.status ?? 0;
  const ok = res?.ok ?? (status >= 200 && status < 300);
  if (!ok) {
    const err = new Error(`Discord GET ${pathname} failed with status ${status || 'unknown'}`);
    err.status = status;
    err.path = pathname;
    throw err;
  }

  return res.json();
}

async function fetchChannelWebhooks(channelId, token, fetchImpl) {
  const res = await fetchImpl(`${DISCORD_API_BASE}/channels/${encodeURIComponent(channelId)}/webhooks`, {
    method: 'GET',
    headers: {
      Authorization: `Bot ${token}`,
      Accept: 'application/json',
    },
  });

  const status = res?.status ?? 0;
  const ok = res?.ok ?? (status >= 200 && status < 300);
  if (ok) {
    const rows = await res.json();
    return Array.isArray(rows) ? rows.map((entry) => normalizeWebhookEntry(entry, channelId)) : [];
  }

  if (status === 400 || status === 404 || status === 405) {
    return [];
  }

  const err = new Error(`Discord GET /channels/${channelId}/webhooks failed with status ${status || 'unknown'}`);
  err.status = status;
  err.path = `/channels/${channelId}/webhooks`;
  throw err;
}

function buildInventoryMarkdown(snapshot) {
  const lines = [];
  lines.push('# Discord Inventory Snapshot');
  lines.push(formatHeaderLine('guild', `${snapshot.guild.name} (${snapshot.guild.id})`));
  lines.push(formatHeaderLine('capturedAt', snapshot.capturedAt));
  lines.push('');

  lines.push('## Categories');
  if (snapshot.categories.length === 0) {
    lines.push('- none');
  } else {
    for (const category of snapshot.categories) {
      lines.push(`- ${safeJson(category.name)} (${category.id}) [position ${category.position}]`);
      if (category.children.length === 0) {
        lines.push('  - none');
        continue;
      }
      for (const child of category.children) {
        lines.push(`  - ${safeJson(child.name)} (${child.id}) [${child.type}; webhooks: ${child.webhookCount}]`);
      }
    }
  }

  lines.push('');
  lines.push('## Uncategorized Channels');
  if (snapshot.uncategorizedChannels.length === 0) {
    lines.push('- none');
  } else {
    for (const channel of snapshot.uncategorizedChannels) {
      lines.push(`- ${safeJson(channel.name)} (${channel.id}) [${channel.type}; webhooks: ${channel.webhookCount}]`);
    }
  }

  lines.push('');
  lines.push('## Roles');
  if (snapshot.roles.length === 0) {
    lines.push('- none');
  } else {
    for (const role of snapshot.roles) {
      lines.push(`- ${safeJson(role.name)} (${role.id}) [position ${role.position}]`);
    }
  }

  lines.push('');
  lines.push('## Webhooks');
  if (snapshot.webhooks.length === 0) {
    lines.push('- none');
  } else {
    for (const webhook of snapshot.webhooks) {
      lines.push(`- ${safeJson(webhook.name)} (${webhook.id}) channel=${webhook.channelId}`);
    }
  }

  return safeJson(lines.join('\n'));
}

function buildInventoryJson(snapshot) {
  const { value } = redactDeep(snapshot);
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sortByPositionAndName(a, b) {
  const aPos = Number.isFinite(a?.position) ? a.position : Number.MAX_SAFE_INTEGER;
  const bPos = Number.isFinite(b?.position) ? b.position : Number.MAX_SAFE_INTEGER;
  if (aPos !== bPos) return aPos - bPos;
  const aName = String(a?.name ?? '').toLowerCase();
  const bName = String(b?.name ?? '').toLowerCase();
  if (aName !== bName) return aName.localeCompare(bName);
  return String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
}

export async function runInventory({ env = process.env, fetchImpl = globalThis.fetch, writeFiles = true, now = () => new Date().toISOString() } = {}) {
  const auth = resolveDiscordAuth(env);
  if (!auth.token || !auth.guildId) {
    const message = [
      'BLOCKED: Discord inventory needs read-only bot auth before it can query the guild.',
      'Required env vars: DISCORD_BOT_TOKEN and DISCORD_GUILD_ID.',
      'Accepted fallbacks: DISCORD_TOKEN and DISCORD_SERVER_ID.',
      'Read-only bot scope: View Channels + Manage Webhooks.',
      'No Discord API calls were made.',
    ].join('\n');
    return {
      ok: false,
      status: 'blocked',
      exitCode: 3,
      message,
      auth,
      wroteFiles: false,
    };
  }

  if (typeof fetchImpl !== 'function') {
    throw new Error('runInventory: fetchImpl must be a function');
  }

  let guild;
  let channelsRaw;
  let rolesRaw;
  try {
    guild = await discordGetJson(`/guilds/${encodeURIComponent(auth.guildId)}`, auth.token, fetchImpl);
    channelsRaw = await discordGetJson(`/guilds/${encodeURIComponent(auth.guildId)}/channels`, auth.token, fetchImpl);
    rolesRaw = await discordGetJson(`/guilds/${encodeURIComponent(auth.guildId)}/roles`, auth.token, fetchImpl);
  } catch (err) {
    if (err?.status === 401 || err?.status === 403) {
      return {
        ok: false,
        status: 'blocked',
        exitCode: 4,
        message: [
          'BLOCKED: Discord returned 401/403 while reading guild inventory.',
          'Check the bot token and make sure the bot can View Channels + Manage Webhooks in the target guild.',
          'No Discord state was modified.',
        ].join('\n'),
        auth,
        wroteFiles: false,
      };
    }
    throw err;
  }

  const guildSafe = redactDeep({
    id: guild?.id ?? auth.guildId,
    name: guild?.name ?? 'unknown-guild',
  }).value;

  const channels = Array.isArray(channelsRaw)
    ? channelsRaw.map(normalizeChannelEntry).sort(sortByPositionAndName)
    : [];

  const channelMap = new Map(channels.map((channel) => [channel.id, channel]));

  for (const channel of channels) {
    const parent = channel.parentId ? channelMap.get(channel.parentId) : null;
    if (parent) {
      channel.categoryId = parent.id;
      channel.categoryName = parent.name;
    }
  }

  const webhookByChannel = new Map();
  for (const channel of channels) {
    if (channel.typeId === 4) {
      webhookByChannel.set(channel.id, []);
      continue;
    }
    const webhooks = await fetchChannelWebhooks(channel.id, auth.token, fetchImpl);
    webhookByChannel.set(channel.id, webhooks);
  }

  for (const channel of channels) {
    channel.webhookCount = webhookByChannel.get(channel.id)?.length ?? 0;
  }

  const categories = channels
    .filter((channel) => channel.typeId === 4)
    .map((category, index) => {
      const children = channels
        .filter((channel) => channel.parentId === category.id)
        .sort(sortByPositionAndName)
        .map((child, childIndex) => redactDeep({
          id: child.id,
          name: child.name,
          type: child.type,
          typeId: child.typeId,
          position: child.position,
          order: childIndex,
          parentId: child.parentId,
          categoryId: child.categoryId,
          categoryName: child.categoryName,
          webhookCount: child.webhookCount,
        }).value);

      return redactDeep({
        id: category.id,
        name: category.name,
        type: category.type,
        typeId: category.typeId,
        position: category.position,
        order: index,
        parentId: category.parentId,
        categoryId: category.categoryId,
        categoryName: category.categoryName,
        webhookCount: category.webhookCount,
        children,
      }).value;
    });

  const uncategorizedChannels = channels
    .filter((channel) => channel.typeId !== 4 && !channel.categoryId)
    .map((channel, index) => redactDeep({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      typeId: channel.typeId,
      position: channel.position,
      order: index,
      parentId: channel.parentId,
      categoryId: channel.categoryId,
      categoryName: channel.categoryName,
      webhookCount: channel.webhookCount,
    }).value);

  const roles = Array.isArray(rolesRaw)
    ? rolesRaw
        .map((role, index) => normalizeRoleEntry(role, index))
        .sort((a, b) => {
          const aPos = Number.isFinite(a?.position) ? a.position : Number.MAX_SAFE_INTEGER;
          const bPos = Number.isFinite(b?.position) ? b.position : Number.MAX_SAFE_INTEGER;
          if (aPos !== bPos) return aPos - bPos;
          return String(a?.name ?? '').localeCompare(String(b?.name ?? ''));
        })
    : [];

  const webhooks = [];
  for (const channel of channels) {
    const perChannel = webhookByChannel.get(channel.id) ?? [];
    for (const webhook of perChannel) {
      webhooks.push(redactDeep({
        name: webhook.name,
        id: webhook.id,
        channelId: webhook.channelId ?? channel.id,
      }).value);
    }
  }

  const snapshot = redactDeep({
    capturedAt: now(),
    guild: guildSafe,
    categories,
    channels: channels.map((channel, index) => redactDeep({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      typeId: channel.typeId,
      position: channel.position,
      order: index,
      parentId: channel.parentId,
      categoryId: channel.categoryId,
      categoryName: channel.categoryName,
      webhookCount: channel.webhookCount,
    }).value),
    uncategorizedChannels,
    roles,
    webhooks,
  }).value;

  const result = {
    ok: true,
    status: 'ok',
    exitCode: 0,
    auth,
    wroteFiles: false,
    snapshot,
  };

  if (writeFiles) {
    fs.mkdirSync(path.dirname(INVENTORY_JSON_PATH), { recursive: true });
    const jsonText = safeJson(buildInventoryJson(snapshot));
    const mdText = safeJson(buildInventoryMarkdown(snapshot));
    fs.writeFileSync(INVENTORY_JSON_PATH, jsonText, 'utf8');
    fs.writeFileSync(INVENTORY_MD_PATH, `${mdText}\n`, 'utf8');
    result.wroteFiles = true;
    result.paths = { json: INVENTORY_JSON_PATH, md: INVENTORY_MD_PATH };
  }

  return result;
}

function buildHelp() {
  return [
    'inventory-discord — READ-ONLY Discord server inventory snapshot',
    '',
    'Usage:',
    '  node scripts/discord/inventory-discord.mjs',
    '  node scripts/discord/inventory-discord.mjs --help',
    '',
    'Env:',
    '  DISCORD_BOT_TOKEN (fallback DISCORD_TOKEN)',
    '  DISCORD_GUILD_ID  (fallback DISCORD_SERVER_ID)',
    '',
    'Permissions:',
    '  View Channels + Manage Webhooks',
    '',
    'Behavior:',
    '  GET-only. No sends. No edits. No secrets printed.',
  ].join('\n');
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(buildHelp());
    return { ok: true, status: 'help', exitCode: 0 };
  }

  loadEnv('.env');
  loadEnv('.env.local');

  try {
    const result = await runInventory({ env, fetchImpl: globalThis.fetch, writeFiles: true });
    if (!result.ok) {
      console.error(result.message);
      process.exitCode = result.exitCode;
      return result;
    }
    console.log([
      '=== Discord inventory snapshot ===',
      `guild          : ${result.snapshot.guild.name} (${result.snapshot.guild.id})`,
      `capturedAt     : ${result.snapshot.capturedAt}`,
      `categories     : ${result.snapshot.categories.length}`,
      `channels       : ${result.snapshot.channels.length}`,
      `roles          : ${result.snapshot.roles.length}`,
      `webhooks       : ${result.snapshot.webhooks.length}`,
      `inventory_json : ${INVENTORY_JSON_PATH}`,
      `inventory_md   : ${INVENTORY_MD_PATH}`,
    ].join('\n'));
    return result;
  } catch (err) {
    const status = err?.status;
    if (status === 401 || status === 403) {
      console.error([
        'BLOCKED: Discord returned 401/403 while reading guild inventory.',
        'Check the bot token and make sure the bot can View Channels + Manage Webhooks in the target guild.',
        'No Discord state was modified.',
      ].join('\n'));
      process.exitCode = 4;
      return { ok: false, status: 'blocked', exitCode: 4 };
    }

    console.error(`ERROR: ${err?.message ?? String(err)}`);
    process.exitCode = 1;
    return { ok: false, status: 'error', exitCode: 1, error: err };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
