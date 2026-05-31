// Discord dry-run formatter for CPC decision packets.
//
// PURE + OFFLINE. This module NEVER opens a network connection, NEVER reads
// credentials, and NEVER sends a Discord message. It only transforms an
// already-rendered decision packet (the sectioned board from
// scripts/shared/decision-packet.mjs) into Discord-ready message parts so the
// output can be inspected and tested without any bot token or webhook URL.
//
// Live delivery is intentionally out of scope: wiring an actual webhook/bot send
// is a separate, explicitly-authorized step (see the Discord integration plan).
//
// Guarantees enforced here (all covered by test/discord-format.test.mjs):
//   1. No message part exceeds the Discord hard limit (2000 chars).
//   2. The raw per-contract inventory dump is never included in a Discord post.
//   3. Secret-looking tokens are scrubbed to <REDACTED> before formatting.
//   4. The canonical packet sections (TLDR / Top Edge / Watchlist / Fades /
//      Blocked / Audit) survive the transform.

export const DISCORD_HARD_LIMIT = 2000;
// Leave headroom for the per-part "[part i/n]" prefix and code-fence wrappers.
export const DISCORD_SAFE_CHARS = 1850;

// Markers that identify a RAW inventory artifact. If a caller accidentally
// passes inventory text instead of the sectioned board, we refuse it rather
// than dump hundreds of contract lines into a channel.
const RAW_INVENTORY_MARKERS = [
  'RAW CONTRACT INVENTORY',
  'AUDIT ONLY — NOT IN MAIN PACKET',
  'AUDIT ONLY -- NOT IN MAIN PACKET',
];

// Conservative secret patterns. We never want a token/URL/key to ride along in
// a packet body. These are scrubbed to <REDACTED> defensively even though the
// packet generators are not supposed to emit them.
const SECRET_PATTERNS = [
  // Discord bot tokens (mfa + standard shapes)
  [/mfa\.[\w-]{20,}/gi, '<REDACTED_DISCORD_TOKEN>'],
  [/[MNO][\w-]{23}\.[\w-]{6}\.[\w-]{27,}/g, '<REDACTED_DISCORD_TOKEN>'],
  // Discord webhook URLs
  [/https?:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\/\S+/gi, '<REDACTED_DISCORD_WEBHOOK>'],
  // Telegram bot token (digits:base64ish)
  [/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, '<REDACTED_TELEGRAM_TOKEN>'],
  // Generic bearer / api key assignments
  [/\b(?:bot[_-]?token|api[_-]?key|client[_-]?secret|webhook[_-]?url|secret|authorization|bearer)\b\s*[:=]\s*\S+/gi, (m) => m.replace(/[:=].*/, '=<REDACTED>')],
  // Long opaque hex/base64 blobs (>=32 chars) that look like keys
  [/\b[A-Fa-f0-9]{32,}\b/g, '<REDACTED_HEX>'],
];

/**
 * Defensive secret scrub. Returns { text, redactions } where redactions is the
 * number of substitutions made. The packet body should normally produce 0.
 */
export function scrubSecrets(text = '') {
  let out = String(text);
  let redactions = 0;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, (...args) => {
      redactions += 1;
      return typeof replacement === 'function' ? replacement(args[0]) : replacement;
    });
  }
  return { text: out, redactions };
}

/** True if the supplied text looks like a raw inventory artifact (not a board). */
export function looksLikeRawInventory(text = '') {
  const upper = String(text).toUpperCase();
  return RAW_INVENTORY_MARKERS.some((m) => upper.includes(m.toUpperCase()));
}

/**
 * Split text into Discord-safe parts at line boundaries where possible. Each
 * returned part is <= DISCORD_HARD_LIMIT including its "[part i/n]" prefix.
 */
export function splitForDiscord(text, limit = DISCORD_SAFE_CHARS) {
  const body = String(text);
  if (body.length <= limit) return [body];

  const rawParts = [];
  let cursor = 0;
  while (cursor < body.length) {
    let end = Math.min(cursor + limit, body.length);
    if (end < body.length) {
      const nl = body.lastIndexOf('\n', end);
      if (nl > cursor + Math.floor(limit * 0.4)) end = nl;
    }
    rawParts.push(body.slice(cursor, end).trim());
    cursor = end;
  }
  const total = rawParts.length;
  return rawParts.map((p, i) => `[part ${i + 1}/${total}]\n${p}`);
}

/**
 * Build the concise Discord channel payload from a rendered packet board.
 *
 * @param {object} input
 * @param {string} input.packetText  - the sectioned decision board text (NOT raw inventory)
 * @param {string} [input.title]     - optional channel post title
 * @param {string} [input.channel]   - logical channel hint (e.g. '#cpc-mlb'); never resolved/sent
 * @param {string[]} [input.artifactPaths] - audit artifact paths to LINK (paths only, no contents)
 * @returns {{ parts: string[], channel: string|null, redactions: number, partCount: number }}
 * @throws if packetText is missing or is a raw inventory dump.
 */
export function buildDiscordPost({ packetText, title = null, channel = null, artifactPaths = [] } = {}) {
  if (!packetText || !String(packetText).trim()) {
    throw new Error('buildDiscordPost: packetText is required');
  }
  if (looksLikeRawInventory(packetText)) {
    throw new Error('buildDiscordPost: refusing to post a RAW inventory dump to Discord — pass the sectioned board, link the inventory as an artifact instead');
  }

  const { text: scrubbed, redactions } = scrubSecrets(packetText);

  const headerLines = [];
  if (title) headerLines.push(`**${title}**`);
  // Artifact references are paths only (never file contents) so a reader can
  // open the full audit locally. Paths are scrubbed too, defensively.
  const safeArtifacts = (artifactPaths || []).map((p) => scrubSecrets(String(p)).text);

  let composed = scrubbed;
  if (safeArtifacts.length) {
    composed = `${scrubbed}\n\n— audit artifacts (open locally, not posted) —\n${safeArtifacts.map((p) => `• ${p}`).join('\n')}`;
  }
  if (headerLines.length) composed = `${headerLines.join('\n')}\n\n${composed}`;

  const parts = splitForDiscord(composed);
  return { parts, channel: channel ?? null, redactions, partCount: parts.length };
}

/**
 * Route a multi-sport set of packets to logical Discord channels WITHOUT
 * sending. Returns an array of { channel, parts, redactions } dry-run payloads.
 * Channel mapping is a static convention only — no IDs, no tokens, no network.
 */
export const CPC_CHANNEL_MAP = Object.freeze({
  'mlb-daily': '#cpc-mlb',
  'nascar-sunday': '#cpc-nascar',
  'mentions-daily': '#cpc-mentions',
  alerts: '#cpc-alerts',
});

export function routeDiscordPosts(packets = []) {
  return packets.map(({ packetType, packetText, title, artifactPaths }) => {
    const channel = CPC_CHANNEL_MAP[packetType] ?? '#cpc-alerts';
    return buildDiscordPost({ packetText, title: title ?? packetType, channel, artifactPaths });
  });
}
