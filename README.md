# Captains Prediction Companion

Captains Prediction Companion is the umbrella app surface for the trading bot, companion UI, and API-backed features.

The intended production deployment is same-origin:

Cloudflare DNS -> VPS -> Nginx -> frontend at `/` + `/api/*` proxy -> Node backend -> PostgreSQL

## What it does

- Accepts Kalshi market URLs
- Builds event-market and mention-market analysis plans
- Returns compact, user-facing market cards
- Exposes MCP tools over HTTP for ChatGPT and compatible clients
- Serves a browser UI at `GET /`

## Runtime surfaces

| Endpoint | Purpose |
|---|---|
| `GET /` | Browser dashboard UI |
| `GET /health` | Health check JSON |
| `GET /healthz` | Health check JSON |
| `POST /mcp` | MCP transport for ChatGPT / compatible clients |
| `GET /pipeline/status` | Pipeline status |
| `GET /pipeline/outputs/latest` | Latest persisted board record |

## Quick start

```bash
cp .env.example .env
npm install
npm start
```

Then open:
- `http://localhost:3000/` — browser dashboard
- `http://localhost:3000/health` — health check
- `http://localhost:3000/mcp` — MCP endpoint

## Environment

Required for the backend runtime:
- current model-provider API key

Common optional variables:
- `IMPLICATIONS_MODEL` — default model for the implications stage
- `VALIDATION_MODEL` — default model for the validation stage
- `EVENT_MARKET_ALPHA_MODEL` — model override for the alpha stage
- `PORT` — defaults to `3000`
- `ENABLE_NOTE_TOOLS` — enables note storage MCP tools (default: `false`)
- `APP_DATA_FILE`
- `PIPELINE_STATE_FILE`
- `PIPELINE_OUTPUT_FILE`
- `PIPELINE_SEED_URLS`
- `PIPELINE_CALENDAR_URL`
- `PIPELINE_CALENDAR_LIMIT`
- `HERMES_COMMAND`

Frontend environment for production:
- `BACKEND_URL=http://127.0.0.1:8000`
- `MCP_SERVER_URL=http://127.0.0.1:8000/mcp`

## Project structure

```
frontend/                 # Next.js app + same-origin /api proxy routes
src/                      # Node backend + MCP server
public/                   # Static assets for the backend-served dashboard shell
deploy/                   # VPS deployment examples
```

## ChatGPT integration

See [CONNECT_CHATGPT.md](./CONNECT_CHATGPT.md) for the MCP setup path.

## Deployment notes

See [docs/deployment-vps.md](./docs/deployment-vps.md).
