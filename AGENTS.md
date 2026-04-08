# AGENTS.md

> ChatGPT-first prediction market assistant. Remote MCP server backed by a Node.js app that accepts Kalshi market URLs, builds event-market and mention-market analysis plans, and returns compact user-facing cards.

## Commands

```bash
# Install
npm install

# Development
npm run dev       # Start server with --watch (auto-restart on file changes)
npm start         # Start server (production)
npm test          # Run tests (node --test)
```

## Project Structure

```
src/
├── server.js              # HTTP + MCP server, tool/prompt registration
├── kalshiApi.js           # Kalshi REST API client, URL parsing, market enrichment
├── eventMarketTool.js     # Market plan builder
├── eventMarketPrompt.js   # Workflow prompt builder
├── eventMarketAlpha.js    # Alpha / edge calculation
├── eventMarketContract.js # Output contract types
├── modelDefaults.js       # OpenRouter model resolution helpers
├── noteStore.js           # Optional note storage (ENABLE_NOTE_TOOLS)
├── storage.js             # Persistent JSON storage helpers
└── env.js                 # .env loader
public/
└── index.html             # Browser dashboard served at GET /
test/
└── server.test.js         # Node built-in test runner
```

## API / MCP Surfaces

| Endpoint | Description |
|----------|-------------|
| `GET /` | Browser dashboard |
| `GET /healthz` | Health check JSON |
| `POST /mcp` | MCP transport for ChatGPT and compatible clients |

MCP tools exposed: `app_status`, `analyze_kalshi_market_url`
MCP prompt exposed: `event_market_workflow`
Optional tools (set `ENABLE_NOTE_TOOLS=true`): `remember_note`, `list_notes`, `search_notes`, `delete_note`

## Environment

```bash
# .env (copy from .env.example, gitignored)
OPENROUTER_API_KEY=sk-or-v1-...  # Required: OpenRouter model provider key
OPENROUTER_MODEL=openrouter/free # Optional: model override (default: openrouter/free)
PORT=3000                        # Optional: server port (default: 3000)
ENABLE_NOTE_TOOLS=false          # Optional: expose note storage MCP tools
APP_DATA_FILE=./data/notes.json  # Optional: note storage path
```

## Git

- Format: `<type>: <description>` (feat, fix, docs, refactor, chore)
- Never commit: API keys, `data/` contents, `.env`
