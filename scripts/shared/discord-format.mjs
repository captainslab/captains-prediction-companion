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

// A line that is nothing but repeated decorative characters (=, -, _, *, ~, #, •
// and the box-drawing horizontals ─ ━ ═). These are the "divider clutter" the
// cron packet renderers emit between sections. We drop them in favor of real
// Markdown headings + spacing. A real Markdown heading (`# text`) has text after
// the marker, so it never matches.
const DECORATIVE_DIVIDER = /^\s*[-=_*~#•─━═]{3,}\s*$/;
// A pure box-drawing horizontal rule. Some renderers (e.g. the World Cup packet)
// frame each section title BETWEEN two of these instead of using `=== ... ===`.
const BOX_DIVIDER = /^\s*[─━═]{3,}\s*$/;
// `=== ... ===` banner header with inner text.
const BANNER_HEADER = /^\s*={2,}\s*(.+?)\s*={2,}\s*$/;
// A leading `key: value` metadata line (word-ish key, a colon, then a value).
const META_LINE = /^[A-Za-z_][\w .()\/-]*:\s+\S/;

/**
 * Convert a raw sectioned decision board into clean Discord Markdown WITHOUT
 * changing meaning, section order, or content. This is a pure string transform:
 *
 *   - `=== Title ===`      -> `# Title`  (first banner)  / `## Section` (rest)
 *   - a contiguous run of `key: value` metadata lines right under the title is
 *     collapsed into one compact Discord subtext line (`-# a · b · c`)
 *   - pure decorative divider lines (`----`, `====`, `****`, ...) are removed
 *   - runs of blank lines are collapsed to a single blank line
 *
 * It never reorders sections, never touches market/price fields, and is applied
 * only to already-scrubbed packet text. Route selection does not use its output.
 */
export function beautifyPacketMarkdown(text = '') {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let seenTitle = false;
  let inLeadingMeta = false;
  let metaBuffer = [];

  const flushMeta = () => {
    if (metaBuffer.length) out.push(`-# ${metaBuffer.join(' · ')}`);
    metaBuffer = [];
    inLeadingMeta = false;
  };

  // Emit a section heading, mirroring the `=== Title ===` semantics: the very
  // first title becomes `# ...` (and may be followed by leading metadata); every
  // later section becomes `## ...` with a blank separator line before it.
  const pushHeading = (label) => {
    flushMeta();
    if (!seenTitle) {
      out.push(`# ${label}`);
      seenTitle = true;
      inLeadingMeta = true; // metadata may follow the top title
    } else {
      if (out.length && out[out.length - 1].trim() !== '') out.push('');
      out.push(`## ${label}`);
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const banner = line.match(BANNER_HEADER);
    if (banner) {
      pushHeading(banner[1].trim());
      continue;
    }
    // Box-divider-sandwiched section title:  ─────  /  Title  /  ─────
    // (opening rule, exactly one non-empty non-divider line, closing rule).
    // A box rule that is NOT this exact shape (e.g. one wrapping a multi-line
    // footer note) falls through and is dropped as decorative clutter below.
    if (
      BOX_DIVIDER.test(line) &&
      lines[i + 1] !== undefined &&
      lines[i + 1].trim() !== '' &&
      !BOX_DIVIDER.test(lines[i + 1]) &&
      lines[i + 2] !== undefined &&
      BOX_DIVIDER.test(lines[i + 2])
    ) {
      pushHeading(lines[i + 1].trim());
      i += 2; // consume the title line and the closing divider
      continue;
    }
    // Drop pure decorative dividers (they are not headers — those matched above).
    if (DECORATIVE_DIVIDER.test(line)) continue;
    // Collapse the contiguous metadata block that immediately follows the title.
    if (inLeadingMeta) {
      if (META_LINE.test(line)) {
        metaBuffer.push(line.trim());
        continue;
      }
      flushMeta();
    }
    out.push(line);
  }
  flushMeta();

  // Collapse 2+ consecutive blank lines to a single blank line, then trim ends.
  const collapsed = [];
  for (const l of out) {
    if (l.trim() === '' && collapsed.length && collapsed[collapsed.length - 1].trim() === '') continue;
    collapsed.push(l);
  }
  while (collapsed.length && collapsed[0].trim() === '') collapsed.shift();
  while (collapsed.length && collapsed[collapsed.length - 1].trim() === '') collapsed.pop();
  return collapsed.join('\n');
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
      const slice = body.slice(cursor, end);
      const minBreak = Math.floor(limit * 0.4);
      // Prefer to break at a logical section boundary: a Markdown heading
      // (`## ` / `# `), then a blank line, then any newline.
      let breakAt = Math.max(slice.lastIndexOf('\n## '), slice.lastIndexOf('\n# '));
      if (breakAt <= minBreak) breakAt = slice.lastIndexOf('\n\n');
      if (breakAt <= minBreak) breakAt = slice.lastIndexOf('\n');
      if (breakAt > minBreak) end = cursor + breakAt;
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

  // Scrub secrets FIRST (before any reshaping), then convert the raw banner
  // board into clean Discord Markdown. Order matters: scrub never depends on
  // layout, and beautify only ever sees already-redacted text.
  const { text: scrubbed, redactions } = scrubSecrets(packetText);
  const pretty = beautifyPacketMarkdown(scrubbed);

  const headerLines = [];
  if (title) headerLines.push(`**${title}**`);
  // Artifact references are paths only (never file contents) so a reader can
  // open the full audit locally. Paths are scrubbed too, defensively.
  const safeArtifacts = (artifactPaths || []).map((p) => scrubSecrets(String(p)).text);

  let composed = pretty;
  if (safeArtifacts.length) {
    composed = `${pretty}\n\n— audit artifacts (open locally, not posted) —\n${safeArtifacts.map((p) => `• ${p}`).join('\n')}`;
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

export const CAPTAINS_CREW_ROUTES = Object.freeze([
  'operator-dry-runs',
  'delivery-logs',
  'daily-brief',
  'research-cards',
  'packet-index',
  'settlement-reviews',
  'source-gaps',
  'mentions-packets',
  'earnings-packets',
  'mlb-packets',
  'ufc-packets',
  'nascar-packets',
  'soccer-packets',
  'politics-packets',
  'other-packets',
]);

export const CAPTAINS_CREW_ROUTE_ENV = Object.freeze({
  'operator-dry-runs': 'DISCORD_WEBHOOK_OPERATOR_DRY_RUNS',
  'delivery-logs': 'DISCORD_WEBHOOK_DELIVERY_LOGS',
  'daily-brief': 'DISCORD_WEBHOOK_DAILY_BRIEF',
  'research-cards': 'DISCORD_WEBHOOK_RESEARCH_CARDS',
  'packet-index': 'DISCORD_WEBHOOK_PACKET_INDEX',
  'settlement-reviews': 'DISCORD_WEBHOOK_SETTLEMENT_REVIEWS',
  'source-gaps': 'DISCORD_WEBHOOK_SOURCE_GAPS',
  'mentions-packets': 'DISCORD_WEBHOOK_MENTIONS_PACKETS',
  'earnings-packets': 'DISCORD_WEBHOOK_EARNINGS_PACKETS',
  'mlb-packets': 'DISCORD_WEBHOOK_MLB_PACKETS',
  'ufc-packets': 'DISCORD_WEBHOOK_UFC_PACKETS',
  'nascar-packets': 'DISCORD_WEBHOOK_NASCAR_PACKETS',
  'soccer-packets': 'DISCORD_WEBHOOK_SOCCER_PACKETS',
  'politics-packets': 'DISCORD_WEBHOOK_POLITICS_PACKETS',
  'other-packets': 'DISCORD_WEBHOOK_OTHER_PACKETS',
});

export function routeDiscordPosts(packets = []) {
  return packets.map(({ packetType, packetText, title, artifactPaths }) => {
    const channel = CPC_CHANNEL_MAP[packetType] ?? '#cpc-alerts';
    return buildDiscordPost({ packetText, title: title ?? packetType, channel, artifactPaths });
  });
}
