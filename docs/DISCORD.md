# Discord Output (Dry-Run Formatter)

CPC ships an **offline** Discord formatter at
`scripts/shared/discord-format.mjs`. It transforms a rendered decision board into
Discord-ready message parts. It does **not** send anything.

## Hard guarantees

The formatter is pure and offline. It:

1. **Never opens a network connection.**
2. **Never reads a credential** (no bot token, no webhook URL).
3. **Never sends a Discord message.**

Live delivery is intentionally out of scope. Wiring an actual webhook/bot send is
a separate, explicitly-authorized step. Until then, this module exists so output
can be inspected and tested without any token.

All four guarantees below are covered by `test/discord-format.test.mjs`:

| Guarantee | How |
|---|---|
| No part exceeds Discord's 2000-char limit | `splitForDiscord()` splits at line boundaries with headroom (`DISCORD_SAFE_CHARS = 1850`) |
| Raw inventory never reaches a channel | `buildDiscordPost()` throws if handed a raw inventory dump |
| Secrets are scrubbed | `scrubSecrets()` redacts token/webhook/key shapes to `<REDACTED_*>` |
| Canonical sections survive the transform | TLDR / Top Edge / Watchlist / Fades / Blocked / Audit pass through |

## Captain's Crew routes

The adapter now supports named Captain's Crew routes. Each route maps to a
placeholder env var name only. No real webhook URL or token is stored here.

Dry-run remains the default. `--send` is the only live-send switch, and it
requires a real webhook env var to be present. `operator-dry-runs` is the first
safe test route.

| Route | Placeholder env var |
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

## Usage

```js
import { buildDiscordPost } from './scripts/shared/discord-format.mjs';

const { parts, channel, redactions, partCount } = buildDiscordPost({
  packetText,                 // a rendered SECTIONED board (not raw inventory)
  title: 'CPC MLB — 2026-05-31',
  channel: '#cpc-mlb',        // logical hint only — never resolved or sent
  artifactPaths: [            // linked as paths only; contents never posted
    'state/packets/2026-05-31/mlb-daily/board.inventory.txt',
  ],
});

// `parts` is an array of <=2000-char strings ready to inspect or (later, with
// explicit authorization) send. `redactions` should normally be 0.
```

Returned shape: `{ parts: string[], channel: string|null, redactions: number, partCount: number }`.

For named Captain's Crew routes, the sender API returns a redacted plan/result
that includes the route name and selected env var name, but never the webhook
value.

## Multi-sport routing (still dry-run)

`routeDiscordPosts()` maps packet types to logical channels via a static
convention — no IDs, no tokens, no network:

```js
import { routeDiscordPosts, CPC_CHANNEL_MAP } from './scripts/shared/discord-format.mjs';

// CPC_CHANNEL_MAP:
//   mlb-daily      -> #cpc-mlb
//   nascar-sunday  -> #cpc-nascar
//   mentions-daily -> #cpc-mentions
//   alerts         -> #cpc-alerts

const payloads = routeDiscordPosts([
  { packetType: 'mlb-daily', packetText, title: 'CPC MLB' },
]);
// payloads: [{ channel, parts, redactions, partCount }, ...]
```

## Secret scrubbing patterns

`scrubSecrets()` defensively redacts (even though generators are not supposed to
emit these):

- Discord bot tokens (`mfa.*` and standard shapes)
- Discord webhook URLs (`https://discord.com/api/webhooks/...`)
- Telegram bot tokens (`digits:base64ish`)
- `bot_token=` / `api_key=` / `client_secret=` / `webhook_url=` / `bearer ...`
  assignments
- Long opaque hex/base64 blobs (≥32 chars)

If `redactions > 0` on a packet body, treat it as a bug in the generator — the
board should never contain a secret in the first place.

## Going live (future, authorized only)

Live send is disabled by default and only happens when `--send` is passed and a
real webhook env var is present. When using the route layer, it must:

1. Read the webhook URL from an **env var only** (never hard-coded, never logged).
2. Require explicit authorization per the security screen.
3. Reuse `buildDiscordPost()` so the 2000-char split, secret scrub, and
   raw-inventory refusal still apply.
4. Keep route selection independent of packet prices or other market data.

See [SECURITY_PRIVACY.md](./SECURITY_PRIVACY.md) → Discord rules.
