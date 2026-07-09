// Live Discord sender for CPC decision packets.
//
// SECRETS-OUT, ENV-ONLY. This module is the ONLY Discord code allowed to open a
// network connection, and it does so under tight rules:
//
//   1. The webhook URL is read from an ENV VAR ONLY. It is never hard-coded,
//      never printed, never logged, never returned in any result object.
//   2. It reuses buildDiscordPost() from discord-format.mjs, so the 2000-char
//      split, the secret scrub, and the raw-inventory refusal all still apply.
//   3. It refuses raw inventory text (defence-in-depth on top of the formatter).
//   4. It scrubs secrets out of every part before sending.
//   5. Live network send happens ONLY when { send: true } is passed explicitly.
//      The default is dry-run (plan only, no network).
//
// What callers get back is a redacted PLAN/RESULT: the selected ENV VAR NAME
// (not its value), the channel hint, the part count, the redaction count, and a
// status. The webhook value never appears anywhere in this module's output.

import { buildDiscordPost, looksLikeRawInventory, scrubSecrets } from './discord-format.mjs';
import { CAPTAINS_CREW_ROUTE_ENV } from './discord-format.mjs';

// Per-packet-type env var precedence. The type-specific var is preferred; the
// generic DISCORD_WEBHOOK_URL is the fallback for every type.
export const DISCORD_ENV_BY_TYPE = Object.freeze({
  'mlb-daily': 'DISCORD_WEBHOOK_URL_MLB',
  'nascar-sunday': 'DISCORD_WEBHOOK_URL_NASCAR',
  'mentions-daily': 'DISCORD_WEBHOOK_URL_MENTIONS',
  alerts: 'DISCORD_WEBHOOK_URL_ALERTS',
});

export const DISCORD_FALLBACK_ENV = 'DISCORD_WEBHOOK_URL';

function pickWebhookEnv(specificVar, env = process.env) {
  if (specificVar && env[specificVar] && String(env[specificVar]).trim()) {
    return { specificVar, fallbackVar: DISCORD_FALLBACK_ENV, selectedVar: specificVar, present: true };
  }
  if (env[DISCORD_FALLBACK_ENV] && String(env[DISCORD_FALLBACK_ENV]).trim()) {
    return { specificVar, fallbackVar: DISCORD_FALLBACK_ENV, selectedVar: DISCORD_FALLBACK_ENV, present: true };
  }
  return { specificVar, fallbackVar: DISCORD_FALLBACK_ENV, selectedVar: null, present: false };
}

/**
 * Resolve which env var NAME supplies the webhook for a packet type, and whether
 * it is present. Returns names only — never the value.
 *
 * @param {string} packetType
 * @param {object} [env=process.env]
 * @returns {{ specificVar: string|null, fallbackVar: string, selectedVar: string|null, present: boolean }}
 */
export function resolveWebhookEnv(packetType, env = process.env) {
  const specificVar = DISCORD_ENV_BY_TYPE[packetType] ?? null;
  return pickWebhookEnv(specificVar, env);
}

/**
 * Resolve which Captain's Crew route env var NAME supplies the webhook, and
 * whether it is present. Returns names only — never the value.
 *
 * Unknown routes fail closed.
 *
 * @param {string} route
 * @param {object} [env=process.env]
 * @returns {{ route: string, specificVar: string|null, fallbackVar: string, selectedVar: string|null, present: boolean, error?: string }}
 */
export function resolveRouteWebhookEnv(route, env = process.env) {
  const specificVar = CAPTAINS_CREW_ROUTE_ENV[route] ?? null;
  if (!specificVar) {
    return {
      route,
      specificVar: null,
      fallbackVar: DISCORD_FALLBACK_ENV,
      selectedVar: null,
      present: false,
      error: 'unknown route',
    };
  }
  return { route, ...pickWebhookEnv(specificVar, env) };
}

// A webhook URL must look like a Discord webhook. We validate the SHAPE without
// ever returning or logging the value.
function isWebhookShaped(value) {
  return /^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/.test(String(value));
}

function redactParts(parts) {
  let extraRedactions = 0;
  const redactedParts = parts.map((p) => {
    const { text, redactions } = scrubSecrets(p);
    extraRedactions += redactions;
    return text;
  });
  return { parts: redactedParts, redactions: extraRedactions };
}

async function sendDiscordParts({ webhook, parts, fetchImpl }) {
  const responses = [];
  for (let i = 0; i < parts.length; i += 1) {
    const res = await fetchImpl(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: parts[i] }),
    });
    const ok = res && (res.ok ?? (res.status >= 200 && res.status < 300));
    responses.push({ part: i + 1, status: res?.status ?? null, ok: Boolean(ok) });
    if (!ok) {
      return {
        sent: false,
        status: 'send failed',
        deliveredParts: responses,
        error: `Discord returned status ${res?.status ?? 'unknown'} on part ${i + 1}/${parts.length}`,
      };
    }
  }

  return { sent: true, status: 'sent', deliveredParts: responses };
}

function buildPlanResult({ route = null, packetType = null, selectedVar, specificVar, fallbackVar, present, parts, redactions, sent, status }) {
  const result = {
    selectedEnvVar: selectedVar,
    credentialPresent: present,
    partCount: parts.length,
    redactions,
    sent,
    status,
  };
  if (route !== null) result.route = route;
  if (packetType !== null) result.packetType = packetType;
  if (specificVar !== undefined) result.specificEnvVar = specificVar;
  if (fallbackVar !== undefined) result.fallbackEnvVar = fallbackVar;
  return result;
}

/**
 * Send (or plan) a CPC packet to Discord.
 *
 * @param {object} input
 * @param {string} input.packetText   - the rendered SECTIONED board (NOT raw inventory)
 * @param {string} input.packetType   - mlb-daily | nascar-sunday | mentions-daily | alerts
 * @param {string} [input.title]      - channel post title
 * @param {string[]} [input.artifactPaths] - audit artifact paths to LINK (paths only)
 * @param {boolean} [input.send=false]- when true (and webhook present), perform the network send
 * @param {object} [input.env=process.env]
 * @param {function} [input.fetchImpl=globalThis.fetch] - injectable for tests; never called in dry-run
 * @returns {Promise<object>} redacted result — contains NO webhook value
 */
export async function sendDiscordPacket({
  packetText,
  packetType,
  title = null,
  artifactPaths = [],
  send = false,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!packetText || !String(packetText).trim()) {
    throw new Error('sendDiscordPacket: packetText is required');
  }
  // Defence-in-depth: refuse raw inventory before we even build the post.
  if (looksLikeRawInventory(packetText)) {
    throw new Error('sendDiscordPacket: refusing to send a RAW inventory dump to Discord — pass the sectioned board');
  }

  const { selectedVar, specificVar, fallbackVar, present } = resolveWebhookEnv(packetType, env);

  const post = buildDiscordPost({ packetText, title, channel: null, artifactPaths });
  const { parts, redactions: extraRedactions } = redactParts(post.parts);
  const redactions = post.redactions + extraRedactions;
  const baseResult = buildPlanResult({
    packetType,
    selectedVar,
    specificVar,
    fallbackVar,
    present,
    parts,
    redactions,
    sent: false,
    status: 'dry-run',
  });

  // Dry-run / check mode: never touch the network.
  if (!send) {
    return { ...baseResult, status: present ? 'dry-run (credential present)' : 'dry-run (no credential)' };
  }

  // Live mode requested but no credential present -> no-op, clear status.
  if (!present) {
    return { ...baseResult, status: 'no-send: credential missing', error: `missing env var (set ${specificVar ?? fallbackVar} or ${fallbackVar})` };
  }

  const webhook = String(env[selectedVar]).trim();
  if (!isWebhookShaped(webhook)) {
    // Do NOT echo the value. Only report the shape failure + the var name.
    return { ...baseResult, status: 'no-send: malformed webhook', error: `env var ${selectedVar} is not a Discord webhook URL shape` };
  }

  return { ...baseResult, ...(await sendDiscordParts({ webhook, parts, fetchImpl })) };
}

/**
 * Send (or plan) a Captain's Crew route packet to Discord.
 *
 * @param {object} input
 * @param {string} input.route       - named Captain's Crew route
 * @param {string} input.packetText   - the rendered SECTIONED board (NOT raw inventory)
 * @param {string} input.title       - channel post title
 * @param {string[]} [input.artifactPaths] - audit artifact paths to LINK (paths only)
 * @param {boolean} [input.send=false]- when true (and webhook present), perform the network send
 * @param {object} [input.env=process.env]
 * @param {function} [input.fetchImpl=globalThis.fetch] - injectable for tests; never called in dry-run
 * @returns {Promise<object>} redacted result — contains NO webhook value
 */
export async function sendDiscordRoute({
  route,
  packetText,
  title = null,
  artifactPaths = [],
  send = false,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!packetText || !String(packetText).trim()) {
    throw new Error('sendDiscordRoute: packetText is required');
  }
  if (looksLikeRawInventory(packetText)) {
    throw new Error('sendDiscordRoute: refusing to send a RAW inventory dump to Discord — pass the sectioned board');
  }

  const resolved = resolveRouteWebhookEnv(route, env);
  const post = buildDiscordPost({ packetText, title, channel: null, artifactPaths });
  const { parts, redactions: extraRedactions } = redactParts(post.parts);
  const redactions = post.redactions + extraRedactions;
  const baseResult = buildPlanResult({
    route,
    selectedVar: resolved.selectedVar,
    specificVar: resolved.specificVar,
    fallbackVar: resolved.fallbackVar,
    present: resolved.present,
    parts,
    redactions,
    sent: false,
    status: resolved.error ? 'unknown route' : 'dry-run',
  });

  if (resolved.error) {
    return baseResult;
  }

  if (!send) {
    return { ...baseResult, status: resolved.present ? 'dry-run (credential present)' : 'dry-run (no credential)' };
  }

  if (!resolved.present) {
    return { ...baseResult, status: 'no-send: credential missing' };
  }

  const webhook = String(env[resolved.selectedVar]).trim();
  if (!isWebhookShaped(webhook)) {
    return { ...baseResult, status: 'no-send: malformed webhook' };
  }

  return { ...baseResult, ...(await sendDiscordParts({ webhook, parts, fetchImpl })) };
}
