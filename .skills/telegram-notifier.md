# Skill: telegram-notifier

**Conditional: activate only when explicitly building Telegram output.**

## Purpose

Context and safety rules for adding Telegram push notifications to CPC card output. Do not apply this skill to unrelated tasks.

## Activation condition

This skill is active only when the task explicitly says: "add Telegram output", "build the Telegram notifier", "wire up Telegram", or similar direct instruction.

## What this integration does

When complete, CPC will push prediction cards to a Telegram chat when configured. The server produces a card → the notifier sends it to Telegram.

## Trigger options (decide before implementing)

| Trigger | Description |
|---|---|
| Every card | Any `analyze_kalshi_market_url` result is sent |
| Actionable only | Only `buy_yes` or `buy_no` recommendations are sent |
| Pipeline batch complete | Sent when a production pipeline run finishes |

## Required configuration

Add to `.env.example` before implementing:

```
# Telegram output (optional — only needed if ENABLE_TELEGRAM_NOTIFICATIONS=true)
ENABLE_TELEGRAM_NOTIFICATIONS=false
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

## Implementation scope

- New file: `src/telegramNotifier.js`
- No changes to core prediction logic
- No changes to `src/server.js` request handling
- Hook point: after card is built in `src/eventMarketTool.js` or after pipeline run in `src/pipelineService.js`
- Disabled by default (`ENABLE_TELEGRAM_NOTIFICATIONS=false`)
- Silent failure — if Telegram send fails, card output is unaffected

## Message format (decide before implementing)

Minimum viable message:
```
[CPC] {board_recommendation} — {board_headline}
Confidence: {board_confidence}
{board_url}
```

Full card option: adds reasoning chain, edge type, catalyst.

## Pre-requisites before activating this skill

1. Public-alpha baseline committed and tagged.
2. `npm run demo` passes on committed state.
3. Captain has a Telegram bot token (from @BotFather) and a target chat ID.
4. Trigger type decided (every card / actionable only / pipeline batch).
5. Message format decided.

## Safety rules

- Bot token goes in `.env` only — never committed, never logged.
- If `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` is missing, notifier silently skips — never throws.
- No market analysis logic may depend on the notifier. It is output-only.
- Notifier must not block the MCP response path — run async or fire-and-forget after card is returned.
