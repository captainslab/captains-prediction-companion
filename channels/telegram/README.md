# CPC Telegram Bot MVP

Telegram is the first fan-facing CPC app layer. It accepts a Kalshi market URL or
ticker and returns a safe CPC decision packet, or a clear BLOCKED/WAITING/
UNSUPPORTED response.

## Safety Contract

- Research only: no live trades, no bankroll, no order placement.
- Market data is displayed for edge comparison but is NOT IN SCORE.
- Raw inventory dumps are refused; link audit artifact paths instead.
- Secrets are scrubbed before formatting.
- Dry-run never contacts Telegram and does not require a bot token.
- Live mode requires an explicit `--live` command and `TELEGRAM_BOT_TOKEN`.

## Dry Run

```bash
node channels/telegram/bot.mjs --dry-run "KX..."
node channels/telegram/bot.mjs --dry-run "https://kalshi.com/..."
```

Dry-run prints the routed workflow, Telegram message preview, redaction count,
and a local preview artifact path under `scratch/channel-telegram/`.

## Live Polling

```bash
TELEGRAM_BOT_TOKEN=... node channels/telegram/bot.mjs --live
```

The token is read from the environment and never printed. The bot replies to the
chat that sent the message, so `TELEGRAM_CHAT_ID` is not required for live
inbound polling.

## Environment

```bash
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

`TELEGRAM_CHAT_ID` is optional and reserved for future outbound/channel tests.

## Supported Inputs

- Kalshi market/event URL.
- Kalshi market/event ticker.
- Plain text market request only when it includes a source URL or ticker.

Plain requests without a source return WAITING_FOR_MARKET_SOURCE. Unsupported
links or casual text return UNSUPPORTED with `/help` as the next command.
