#!/usr/bin/env node
// CLI wrapper: send (or dry-run) a CPC decision packet to Discord.
//
// SAFE BY DEFAULT. Dry-run is the default; a live network send happens ONLY when
// --send is passed. The webhook URL is read from an ENV VAR ONLY and is never
// printed. Raw inventory artifacts (*.inventory.txt) are rejected outright.
//
// Usage:
//   node scripts/packets/send-discord-packet.mjs \
//     --packet state/packets/2026-05-31/nascar-sunday/2026-05-31-KXNASCARRACE-CRAB26.txt \
//     --packet-type nascar-sunday \
//     --title "CPC NASCAR — 2026-05-31"            # dry-run (default)
//
//   ...same command... --route operator-dry-runs   # Captain's Crew route dry-run
//
//   ...same command... --send                      # explicit live send
//
// Output reports: packet path, packet type, the SELECTED ENV VAR NAME (not its
// value), part count, redaction count, and send status.

import fs from 'node:fs';
import path from 'node:path';
import { sendDiscordPacket, sendDiscordRoute, resolveWebhookEnv, resolveRouteWebhookEnv, DISCORD_ENV_BY_TYPE, DISCORD_FALLBACK_ENV } from '../shared/discord-send.mjs';
import { CAPTAINS_CREW_ROUTES, CAPTAINS_CREW_ROUTE_ENV } from '../shared/discord-format.mjs';

const VALID_TYPES = new Set(Object.keys(DISCORD_ENV_BY_TYPE));
const VALID_ROUTES = new Set(CAPTAINS_CREW_ROUTES);

function parseArgs(argv) {
  const opts = { packet: null, packetType: null, route: null, title: null, send: false, dryRun: true, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--packet') opts.packet = argv[++i];
    else if (a === '--packet-type') opts.packetType = argv[++i];
    else if (a === '--route') opts.route = argv[++i];
    else if (a === '--title') opts.title = argv[++i];
    else if (a === '--send') { opts.send = true; opts.dryRun = false; }
    else if (a === '--dry-run') { opts.dryRun = true; opts.send = false; }
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

// Load env from project .env / .env.local if present (values never printed).
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

const HELP = `send-discord-packet — safe Discord delivery for CPC packets

  --packet <path>         path to the rendered SECTIONED board (.txt)
  --packet-type <type>    one of: ${[...VALID_TYPES].join(' | ')}
  --route <name>          Captain's Crew route (alternative to --packet-type)
  --title <title>         optional channel post title
  --dry-run               plan only, no network (DEFAULT)
  --send                  explicit live send (requires a Discord webhook env var)

  Webhook env (value never printed):
    type-specific: ${Object.entries(DISCORD_ENV_BY_TYPE).map(([t, v]) => `${t} -> ${v}`).join(', ')}
    fallback:      ${DISCORD_FALLBACK_ENV}

  Captain's Crew routes (dry-run default; operator-dry-runs is the first safe test route):
${CAPTAINS_CREW_ROUTES.map((route) => `    ${route.padEnd(19)} -> ${CAPTAINS_CREW_ROUTE_ENV[route]}`).join('\n')}

  *.inventory.txt is rejected. Raw inventory is never sent to Discord.`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); process.exit(0); }

  if (!opts.packet) { console.error('ERROR: --packet <path> is required'); process.exit(2); }
  if (opts.route && !VALID_ROUTES.has(opts.route)) {
    console.error(`ERROR: --route must be one of: ${CAPTAINS_CREW_ROUTES.join(', ')}`);
    process.exit(2);
  }
  if (!opts.route && (!opts.packetType || !VALID_TYPES.has(opts.packetType))) {
    console.error(`ERROR: --packet-type must be one of: ${[...VALID_TYPES].join(', ')}`);
    process.exit(2);
  }
  // Hard refuse raw inventory artifacts by filename.
  if (/\.inventory\.[^/]*$/.test(opts.packet) || /\.inventory$/.test(opts.packet)) {
    console.error(`ERROR: refusing inventory artifact: ${opts.packet} (raw inventory is never sent to Discord)`);
    process.exit(2);
  }
  if (!fs.existsSync(opts.packet)) { console.error(`ERROR: packet not found: ${opts.packet}`); process.exit(2); }

  loadEnv('.env');
  loadEnv('.env.local');

  const packetText = fs.readFileSync(opts.packet, 'utf8');
  const packetLabel = opts.route ?? opts.packetType;
  const title = opts.title ?? `CPC ${packetLabel}`;

  // Pre-resolve env presence for the report (names only).
  const envInfo = opts.route ? resolveRouteWebhookEnv(opts.route) : resolveWebhookEnv(opts.packetType);

  let result;
  try {
    result = opts.route ? await sendDiscordRoute({
      route: opts.route,
      packetText,
      title,
      send: opts.send,
    }) : await sendDiscordPacket({
      packetText,
      packetType: opts.packetType,
      title,
      send: opts.send,
    });
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }

  const lines = [
    '=== Discord packet delivery ===',
    `packet_path     : ${path.resolve(opts.packet)}`,
    `${opts.route ? 'route           ' : 'packet_type     '}: ${packetLabel}`,
    `selected_env_var: ${result.selectedEnvVar ?? '(none present)'}`,
    `credential      : ${envInfo.present ? 'present' : 'MISSING'}`,
    `part_count      : ${result.partCount}`,
    `redaction_count : ${result.redactions}`,
    `mode            : ${opts.send ? 'live (--send)' : 'dry-run'}`,
    `send_status     : ${result.status}`,
  ];
  if (result.error) lines.push(`note            : ${result.error}`);
  if (result.deliveredParts) {
    lines.push(`delivered_parts : ${result.deliveredParts.map((p) => `#${p.part}=${p.status}`).join(' ')}`);
  }
  if (!envInfo.present && opts.send) {
    lines.push('');
    lines.push(`To enable live send, set one of (env-only, never committed):`);
    lines.push(`  ${envInfo.specificVar ?? (opts.route ? CAPTAINS_CREW_ROUTE_ENV[opts.route] : DISCORD_ENV_BY_TYPE[opts.packetType])}   (preferred for ${packetLabel})`);
    lines.push(`  ${DISCORD_FALLBACK_ENV}   (fallback for all types)`);
  }
  console.log(lines.join('\n'));

  // Exit non-zero on a requested live send that did not succeed.
  if (opts.send && !result.sent) process.exit(1);
}

main();
