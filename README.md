# Captains Prediction Companion

ChatGPT-first prediction market assistant focused on **Kalshi event and mention markets**.

The primary integration surface is a **remote MCP server**. A browser dashboard is the next expansion step.

## What it does

- Accepts Kalshi market URLs
- Builds event-market and mention-market analysis plans
- Returns compact, user-facing market cards
- Exposes MCP tools over HTTP for ChatGPT and compatible clients
- Serves a lightweight browser UI at `GET /`

## Runtime surfaces

| Endpoint | Purpose |
|---|---|
| `GET /` | Browser dashboard UI |
| `GET /healthz` | Health check JSON |
| `POST /mcp` | MCP transport for ChatGPT / compatible clients |

## Quick start

```bash
cp .env.example .env
# Fill in OPENROUTER_API_KEY
npm install
npm start
```

Then open:
- `http://localhost:3000/` — browser dashboard
- `http://localhost:3000/healthz` — health check
- `http://localhost:3000/mcp` — MCP endpoint

## Environment

See `.env.example` for all supported variables. Required:
- `OPENROUTER_API_KEY` — model provider key (OpenRouter)

Optional:
- `OPENROUTER_MODEL` — defaults to `openrouter/free`
- `PORT` — defaults to `3000`
- `ENABLE_NOTE_TOOLS` — enables note storage MCP tools (default: `false`)

## Project structure

```
src/
├── server.js              # HTTP + MCP server, serves GET /
├── env.js                 # Env loader
├── eventMarketTool.js     # Market plan builder
├── eventMarketPrompt.js   # Workflow prompt builder
├── eventMarketAlpha.js    # Alpha / edge calculation
├── eventMarketContract.js # Output contract types
├── kalshiApi.js           # Kalshi API client
├── noteStore.js           # Optional note storage
├── modelDefaults.js       # LLM model defaults
└── storage.js             # Persistent storage helpers
public/
└── index.html             # Browser dashboard
```

## ChatGPT integration

See [CONNECT_CHATGPT.md](./CONNECT_CHATGPT.md) for full setup instructions.

## Known failure modes

- If the market card shows `fair_yes: null` — check that `OPENROUTER_API_KEY` is set in the running process environment. A healthy `/healthz` alone does not prove alpha is enabled.
- If the public URL shows stale data — rotate the tunnel. Old `trycloudflare` links can stay attached to outdated processes.
