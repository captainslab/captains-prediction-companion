# ChatGPT Developer Mode Readiness

CPC is intended for private ChatGPT Developer Mode use through its MCP server.
This checklist does not claim public ChatGPT app submission readiness.

## Endpoints

- Production MCP endpoint: `https://captainlabs.io/mcp`
- Production health endpoint: `https://captainlabs.io/healthz`
- Production upstream port behind nginx: `127.0.0.1:8000`
- Local default: `http://localhost:3000/mcp` and `http://localhost:3000/healthz`

## Expected Tools

Default tools:

- `app_status`
- `analyze_kalshi_market_url`
- `mentions_research`
- `earnings_mention_research`
- `settled_event_history`
- `run_composite_model`
- `mlb_sports_preview`
- `sports_preview`

Optional note tool:

- `remember_note` only when `ENABLE_NOTE_TOOLS=true`

## Private Developer Mode Setup

1. Start CPC locally with `npm start`, or deploy the Node server behind
   `https://captainlabs.io`.
2. Confirm health with `curl -s http://localhost:3000/healthz` locally or
   `curl -s https://captainlabs.io/healthz` in production.
3. In ChatGPT web, enable Developer Mode under app settings.
4. Create a private app draft and enter `https://captainlabs.io/mcp`.
5. Keep the app in draft/private testing. Do not submit it as a public app.
6. Run the golden prompts below before using it for real research.

## How A Customer Uses It

1. Open the private ChatGPT app in Developer Mode.
2. Ask `app_status` first to confirm the tool list and read-only posture.
3. Paste a Kalshi market URL, event ticker, or packet request.
4. Read the card headline, plain-English meaning, settlement line, and CPC Read.
5. Treat price, bid/ask, and movement as display-only context.
6. If the packet is blocked, use the missing evidence note to decide what input is still needed.

## Required Environment

Minimum local/private use:

- `GEMINI_API_KEY` for Hermes/Gemini model calls

Optional:

- `HERMES_COMMAND` if the Hermes binary is not on `PATH`
- `EVENT_MARKET_ALPHA_PROVIDER`
- `EVENT_MARKET_ALPHA_MODEL`
- `MCP_COMPACT_DEFAULT=true` for compact cards by default
- `PERPLEXITY_API_KEY` for fresh mentions research
- `ENABLE_NOTE_TOOLS=true` only when private note writes are intended

Never place secrets in docs, packet text, `app_status`, structured tool output,
or committed files.

## Read/Write Posture

Default posture is read-only:

- No trades or orders.
- No Telegram sends.
- No Discord sends.
- No public write tools.
- Note writes are hidden unless `ENABLE_NOTE_TOOLS=true`.
- Market price, bid/ask, volume, open interest, liquidity, and movement are
  display-only and must not enter CPC scoring, posture, ranking, or upgrades.

## Verification Commands

Local:

```bash
npm test
npm run demo
curl -s http://localhost:3000/healthz
```

Production:

```bash
curl -s https://captainlabs.io/healthz
```

MCP Inspector, if available:

```bash
npx @modelcontextprotocol/inspector http://localhost:3000/mcp
```

## Golden Prompts

- "Call `app_status` and list the tools you can use."
- "Analyze this Kalshi market URL and show the Plain English card first: `<URL>`."
- "For this mention event, explain what YES settlement requires before giving a CPC Read: `<EVENT_TICKER>`."
- "Run the MLB composite model for this URL and confirm price is display-only: `<URL>`."
- "Show today's MLB preview. If the packet is unavailable, say what source is missing."

## Pass/Fail Checklist

- [ ] `/healthz` returns `{"ok":true,...}`.
- [ ] `app_status` returns `structuredContent`.
- [ ] `app_status` exposes no secret values or local credential paths.
- [ ] Default tool list matches this document.
- [ ] Every default tool is read-only.
- [ ] `remember_note` is absent unless `ENABLE_NOTE_TOOLS=true`.
- [ ] Card text starts with a plain-English title and meaning.
- [ ] Ticker or market ID is secondary, not the headline.
- [ ] Price context says display-only and not used in scoring.
- [ ] Packet/card output follows `docs/CPC_OUTPUT_LANGUAGE.md`.
- [ ] Private Developer Mode checks pass.
- [ ] Public app submission remains out of scope.

Passing this checklist means CPC is ready for private ChatGPT Developer Mode
testing. It is not public ChatGPT app submission ready.
