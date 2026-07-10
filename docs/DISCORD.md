# Discord Delivery and Inventory

CPC separates Discord support into three layers:

1. **Formatting** — pure, offline message preparation.
2. **Delivery** — dry-run by default; live webhook POST only with explicit `--send`.
3. **Inventory** — GET-only guild structure snapshot with no message sends.

No bot token or webhook URL is committed, printed, or written to artifacts.

## 1. Offline formatter

`scripts/shared/discord-format.mjs` transforms a rendered decision board into
Discord-ready message parts. It never opens a network connection and never reads
a credential.

| Guarantee | How |
|---|---|
| No part exceeds Discord's 2000-char limit | `splitForDiscord()` splits at line boundaries with headroom (`DISCORD_SAFE_CHARS = 1850`) |
| Raw inventory never reaches a channel | `buildDiscordPost()` throws if handed a raw inventory dump |
| Secrets are scrubbed | `scrubSecrets()` redacts token, webhook, key, and bearer shapes |
| Canonical sections survive the transform | TLDR / Top Edge / Watchlist / Fades / Blocked / Audit pass through |

```js
import { buildDiscordPost } from './scripts/shared/discord-format.mjs';

const { parts, channel, redactions, partCount } = buildDiscordPost({
  packetText,
  title: 'CPC MLB — 2026-07-10',
  channel: '#cpc-mlb',
  artifactPaths: [
    'state/packets/2026-07-10/mlb-daily/board.inventory.txt',
  ],
});
```

Returned shape:

```text
{ parts: string[], channel: string|null, redactions: number, partCount: number }
```

If `redactions > 0`, treat that as a generator defect. A rendered packet should
never contain a credential in the first place.

## 2. Captain's Crew delivery routes

The route adapter supports 15 named destinations. Each route maps to an
environment variable **name** only. The repository never contains the webhook
value.

| Route | Webhook environment variable |
|---|---|
| `operator-dry-runs` | `DISCORD_WEBHOOK_OPERATOR_DRY_RUNS` |
| `delivery-logs` | `DISCORD_WEBHOOK_DELIVERY_LOGS` |
| `daily-brief` | `DISCORD_WEBHOOK_DAILY_BRIEF` |
| `research-cards` | `DISCORD_WEBHOOK_RESEARCH_CARDS` |
| `packet-index` | `DISCORD_WEBHOOK_PACKET_INDEX` |
| `settlement-reviews` | `DISCORD_WEBHOOK_SETTLEMENT_REVIEWS` |
| `source-gaps` | `DISCORD_WEBHOOK_SOURCE_GAPS` |
| `mentions-packets` | `DISCORD_WEBHOOK_MENTIONS_PACKETS` |
| `earnings-packets` | `DISCORD_WEBHOOK_EARNINGS_PACKETS` |
| `mlb-packets` | `DISCORD_WEBHOOK_MLB_PACKETS` |
| `ufc-packets` | `DISCORD_WEBHOOK_UFC_PACKETS` |
| `nascar-packets` | `DISCORD_WEBHOOK_NASCAR_PACKETS` |
| `soccer-packets` | `DISCORD_WEBHOOK_SOCCER_PACKETS` |
| `politics-packets` | `DISCORD_WEBHOOK_POLITICS_PACKETS` |
| `other-packets` | `DISCORD_WEBHOOK_OTHER_PACKETS` |

`DISCORD_WEBHOOK_URL` remains the general fallback.

### Dry-run preview

Dry-run is the default and makes no network call:

```bash
node scripts/packets/send-discord-packet.mjs \
  --packet state/packets/<date>/<type>/<packet>.txt \
  --route operator-dry-runs \
  --dry-run
```

The report includes the selected environment variable **name**, part count,
redaction count, and send status. It never prints the webhook value.

### Explicit live send

A live POST happens only when all of these are true:

1. `--send` is supplied.
2. The selected route or fallback webhook environment variable is present.
3. The packet is a rendered board, not a raw inventory artifact.
4. Formatting and secret-scrubbing complete successfully.

```bash
node scripts/packets/send-discord-packet.mjs \
  --packet state/packets/<date>/<type>/<packet>.txt \
  --route operator-dry-runs \
  --send
```

Start with `operator-dry-runs`. Promote other routes one at a time only after the
pilot output and destination are verified.

## 3. Read-only guild inventory

`scripts/discord/inventory-discord.mjs` snapshots the current Discord server
structure before provisioning or route rollout.

It uses GET-only Discord REST calls to collect:

- guild identity
- categories and child-channel order
- channel types
- role names and positions
- webhook metadata by channel (`name`, `id`, `channelId` only)

It does not create, edit, or delete channels, roles, permissions, or webhooks. It
does not send messages and never writes webhook URLs or tokens.

Required environment variables:

```bash
DISCORD_BOT_TOKEN=...
DISCORD_GUILD_ID=...
```

Fallback names are `DISCORD_TOKEN` and `DISCORD_SERVER_ID`.

Run:

```bash
node scripts/discord/inventory-discord.mjs
```

Successful output is written to:

```text
state/discord/inventory.json
state/discord/inventory.md
```

Missing credentials fail closed with zero API calls. Discord `401` or `403`
responses return `BLOCKED` and write no successful inventory snapshot.

The inventory bot needs read-only access sufficient for `View Channels` and
`Manage Webhooks` so webhook metadata can be listed. Do not grant message-send,
channel-management, or role-management permissions for this inventory step.

## Multi-sport logical routing

`routeDiscordPosts()` still supports logical packet-type routing without IDs,
tokens, or network access:

```js
import { routeDiscordPosts } from './scripts/shared/discord-format.mjs';

const payloads = routeDiscordPosts([
  { packetType: 'mlb-daily', packetText, title: 'CPC MLB' },
]);
```

The logical channel map is formatting metadata. The live route adapter uses the
explicit Captain's Crew route and its environment variable.

## Secret scrubbing patterns

`scrubSecrets()` defensively redacts:

- Discord bot tokens
- Discord webhook URLs
- Telegram bot tokens
- `bot_token=`, `api_key=`, `client_secret=`, `webhook_url=`, and bearer assignments
- long opaque hex/base64 blobs

## Safety boundary

- Discord delivery never feeds model input, scoring, ranking, posture, or confidence.
- Route selection depends only on the explicit route or packet type.
- Market prices, odds, bid/ask, volume, open interest, spread, and movement do not select a route.
- Telegram delivery remains separate and unchanged.
- CPC remains research-only and places no trades.

See [SECURITY_PRIVACY.md](./SECURITY_PRIVACY.md) for the full security screen.
