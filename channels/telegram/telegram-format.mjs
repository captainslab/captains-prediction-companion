// Telegram-safe formatter for CPC channel responses.
// Pure/offline: no credentials, no network, no sends.

import {
  looksLikeRawInventory,
  scrubSecrets,
} from '../shared/channel-response.mjs';

export const TELEGRAM_HARD_LIMIT = 4096;
export const TELEGRAM_SAFE_CHARS = 3900;

function textOrThrow(packetText) {
  const text = String(packetText ?? '').trim();
  if (!text) throw new Error('buildTelegramMessages: packetText is required');
  if (looksLikeRawInventory(text)) {
    throw new Error('buildTelegramMessages: refusing to send raw inventory to Telegram; link the audit artifact path instead');
  }
  return text;
}

function splitPlainText(text, limit = TELEGRAM_SAFE_CHARS) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(cursor + limit, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end);
      if (nl > cursor + Math.floor(limit * 0.45)) end = nl;
    }
    if (end <= cursor) end = Math.min(cursor + limit, text.length);
    chunks.push(text.slice(cursor, end).trim());
    cursor = end;
  }
  const total = chunks.length;
  return chunks.map((chunk, idx) => `[part ${idx + 1}/${total}]\n${chunk}`);
}

export function splitForTelegram(text, limit = TELEGRAM_SAFE_CHARS) {
  const parts = splitPlainText(String(text ?? ''), limit);
  for (const part of parts) {
    if (part.length > TELEGRAM_HARD_LIMIT) {
      throw new Error(`splitForTelegram: part exceeds Telegram hard limit (${part.length} > ${TELEGRAM_HARD_LIMIT})`);
    }
  }
  return parts;
}

export function buildTelegramMessages(response = {}) {
  const packetText = textOrThrow(response.packetText);
  const title = response.title ? `${response.title}\n\n` : '';
  const { text: scrubbed, redactions } = scrubSecrets(`${title}${packetText}`);
  const parts = splitForTelegram(scrubbed);
  return {
    parts,
    partCount: parts.length,
    redactions,
    parseMode: null,
    disableWebPagePreview: true,
  };
}
