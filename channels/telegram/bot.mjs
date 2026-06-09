#!/usr/bin/env node
// CPC Telegram bot MVP.
// Dry-run is default for local preview. Live polling requires --live and
// TELEGRAM_BOT_TOKEN. No trades, no bankroll, no order placement.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseIntakeText } from '../shared/intake.mjs';
import { routeMarket, runRoutedWorkflow } from '../shared/route-market.mjs';
import {
  buildChannelResponse,
  looksLikeRawInventory,
  scrubSecrets,
  withArtifactPaths,
} from '../shared/channel-response.mjs';
import { buildTelegramMessages } from './telegram-format.mjs';

const DEFAULT_ARTIFACT_ROOT = 'scratch/channel-telegram';

function normalizeFlag(value = '') {
  return String(value).replace(/^\u2013|\u2014/, '--');
}

export function parseBotArgs(argv = []) {
  const args = argv.map(normalizeFlag);
  const opts = {
    mode: null,
    input: '',
    help: false,
    artifactRoot: DEFAULT_ARTIFACT_ROOT,
    writeArtifact: true,
    pollOnce: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--dry-run') {
      opts.mode = 'dry-run';
      opts.input = args.slice(i + 1).join(' ').trim();
      break;
    }
    if (arg === '--live') {
      opts.mode = 'live';
    } else if (arg === '--poll-once') {
      opts.pollOnce = true;
    } else if (arg === '--artifact-root') {
      opts.artifactRoot = args[++i];
    } else if (arg === '--no-artifact') {
      opts.writeArtifact = false;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (!opts.mode && arg) {
      opts.mode = 'dry-run';
      opts.input = args.slice(i).join(' ').trim();
      break;
    }
  }

  if (!opts.mode) opts.mode = opts.help ? 'help' : 'usage';
  return opts;
}

export function usageText() {
  return [
    'Usage:',
    '  node channels/telegram/bot.mjs --dry-run "market input"',
    '  node channels/telegram/bot.mjs --live',
    '',
    'Dry-run does not contact Telegram and does not require TELEGRAM_BOT_TOKEN.',
    'Live mode requires TELEGRAM_BOT_TOKEN and polls Telegram explicitly.',
  ].join('\n');
}

export function resolveLiveConfig(env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is required for --live; token value was not printed.');
  }
  return { token };
}

function safeArtifactName(response) {
  const status = String(response.status ?? 'response').toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 32);
  const hash = createHash('sha256')
    .update(String(response.packetText ?? ''))
    .digest('hex')
    .slice(0, 12);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${status}-${hash}.txt`;
}

export function writeResponseArtifact(response = {}, options = {}) {
  if (options.writeArtifact === false) return null;
  const packetText = String(response.packetText ?? '').trim();
  if (!packetText) return null;
  if (looksLikeRawInventory(packetText)) {
    throw new Error('writeResponseArtifact: refusing to write raw inventory through Telegram channel');
  }
  const { text } = scrubSecrets(packetText);
  const root = resolve(options.artifactRoot ?? DEFAULT_ARTIFACT_ROOT);
  const day = new Date().toISOString().slice(0, 10);
  const dir = join(root, day);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, safeArtifactName({ ...response, packetText: text }));
  writeFileSync(file, `${text}\n`, 'utf8');
  return relative(process.cwd(), file);
}

export async function buildTelegramPreview(text, options = {}) {
  const intake = parseIntakeText(text);
  const route = routeMarket(intake);
  const workflowResult = route.status === 'routed'
    ? await runRoutedWorkflow(route, options)
    : { status: route.status, route, summary: null, plan: null, blocker: route.blocker ?? route.reason ?? null };
  let response = buildChannelResponse({ intake, route, workflowResult });
  const artifactPath = writeResponseArtifact(response, options);
  if (artifactPath) response = withArtifactPaths(response, [artifactPath]);
  const formatted = buildTelegramMessages(response);
  return { intake, route, workflowResult, response, formatted };
}

export function formatDryRunOutput(preview) {
  const lines = [
    '[telegram-bot] mode=dry-run',
    `[telegram-bot] input_type=${preview.intake.inputType}`,
    `[telegram-bot] route_status=${preview.route.status}`,
    `[telegram-bot] route_family=${preview.route.family}`,
    `[telegram-bot] workflow=${preview.route.workflow?.id ?? 'none'}`,
    `[telegram-bot] telegram_parts=${preview.formatted.partCount}`,
    `[telegram-bot] redactions=${preview.formatted.redactions}`,
  ];
  if (preview.response.artifactPaths?.length) {
    for (const p of preview.response.artifactPaths) lines.push(`[telegram-bot] artifact=${p}`);
  }
  preview.formatted.parts.forEach((part, idx) => {
    lines.push(`--- telegram message ${idx + 1}/${preview.formatted.parts.length} ---`);
    lines.push(part);
  });
  return lines.join('\n');
}

async function telegramApi(token, method, body, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  if (!res.ok || !json?.ok) {
    const description = json?.description ? ` ${json.description}` : '';
    throw new Error(`Telegram API ${method} failed: status=${res.status}${description}`);
  }
  return json.result;
}

export async function sendTelegramParts({ token, chatId, parts, fetchImpl = globalThis.fetch }) {
  const sent = [];
  for (const text of parts) {
    const result = await telegramApi(token, 'sendMessage', {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }, fetchImpl);
    sent.push(result?.message_id ?? null);
  }
  return sent;
}

async function handleTelegramUpdate(update, config, options = {}) {
  const message = update?.message;
  const chatId = message?.chat?.id;
  const text = message?.text;
  if (!chatId || !text) return { skipped: true };
  const preview = await buildTelegramPreview(text, {
    ...options,
    artifactRoot: options.artifactRoot ?? DEFAULT_ARTIFACT_ROOT,
  });
  const messageIds = await sendTelegramParts({
    token: config.token,
    chatId,
    parts: preview.formatted.parts,
    fetchImpl: options.fetchImpl,
  });
  return {
    skipped: false,
    messageIds,
    routeStatus: preview.route.status,
    routeFamily: preview.route.family,
    redactions: preview.formatted.redactions,
  };
}

export async function runLiveBot(options = {}) {
  const config = options.config ?? resolveLiveConfig(options.env ?? process.env);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  let offset = options.offset ?? 0;
  const pollOnce = options.pollOnce === true;
  console.log('[telegram-bot] live mode started; TELEGRAM_BOT_TOKEN present; value not printed.');
  while (true) {
    const updates = await telegramApi(config.token, 'getUpdates', {
      timeout: pollOnce ? 0 : 25,
      offset,
      allowed_updates: ['message'],
    }, fetchImpl);
    for (const update of updates) {
      offset = Math.max(offset, Number(update.update_id ?? 0) + 1);
      try {
        const result = await handleTelegramUpdate(update, config, options);
        if (!result.skipped) {
          console.log(`[telegram-bot] handled update=${update.update_id} route=${result.routeStatus}/${result.routeFamily} messages=${result.messageIds.length} redactions=${result.redactions}`);
        }
      } catch (err) {
        console.error(`[telegram-bot] update failed: ${err.message}`);
      }
    }
    if (pollOnce) break;
  }
}

async function main() {
  const opts = parseBotArgs(process.argv.slice(2));
  if (opts.help || opts.mode === 'usage' || opts.mode === 'help') {
    console.log(usageText());
    return;
  }

  if (opts.mode === 'dry-run') {
    if (!opts.input) throw new Error('--dry-run requires market input text');
    const preview = await buildTelegramPreview(opts.input, {
      artifactRoot: opts.artifactRoot,
      writeArtifact: opts.writeArtifact,
    });
    console.log(formatDryRunOutput(preview));
    return;
  }

  if (opts.mode === 'live') {
    await runLiveBot({
      pollOnce: opts.pollOnce,
      artifactRoot: opts.artifactRoot,
      writeArtifact: opts.writeArtifact,
    });
    return;
  }

  throw new Error(`unknown mode: ${opts.mode}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`[telegram-bot] error: ${err.message}`);
    process.exit(1);
  });
}
