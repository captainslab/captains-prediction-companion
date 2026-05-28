# Captains Prediction Companion

Built this for myself. Sharing it because the game is better when the tools are open.

Paste a Kalshi market URL, get a structured prediction card — fair value, edge, confidence, reasoning. Runs as a local MCP server so it plugs straight into ChatGPT or any compatible client. Fork it, add your pipeline, make it yours.

Find me on Discord and X as **@CaptainMentions** — or open an issue at [captainslab](https://github.com/captainslab).

[![License: ISC](https://img.shields.io/badge/license-ISC-blue.svg)](https://opensource.org/licenses/ISC)
[![Node: >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![Issues](https://img.shields.io/github/issues/captainslab/captains-prediction-companion)](https://github.com/captainslab/captains-prediction-companion/issues)

---

## What it does

- Accepts Kalshi market URLs
- Builds event-market and mention-market analysis
- Returns compact prediction cards with fair-value, edge, and confidence
- Exposes MCP tools for ChatGPT and compatible clients
- Serves a browser dashboard at `GET /`

## How it works

```
  You / ChatGPT
       │
       │  POST /mcp
       ▼
  eventMarketTool
       │
       ├─────────────────────┐
       ▼                     ▼
  Kalshi API           Hermes + Gemini
  (market data)        (alpha / oracle)
       │                     │
       └──────────┬──────────┘
                  ▼
          Prediction Card JSON
          { fair_value, edge,
            confidence, reasoning }
```

The MCP server receives a market URL, fetches live odds from Kalshi, and runs it through a two-stage AI pipeline (alpha hypothesis → oracle validation). The result is a structured JSON card your client can display, log, or act on.

## Quick start

**Requires Node.js 18+**

```bash
git clone https://github.com/captainslab/captains-prediction-companion.git
cd captains-prediction-companion
npm run setup          # copies .env.example → .env, creates data/
# Edit .env — set GEMINI_API_KEY at minimum
npm install
npm start
```

Verify everything is working:

```bash
npm run doctor
```

Open in a browser:

- `http://localhost:3000/` — dashboard
- `http://localhost:3000/health` — health check JSON
- `http://localhost:3000/mcp` — MCP endpoint

## Environment variables

Copy `.env.example` to `.env` (done automatically by `npm run setup`).

### Required for market analysis

| Variable | Description |
|---|---|
| `GEMINI_API_KEY` | Google Gemini API key — get one at [ai.google.dev](https://ai.google.dev) |

### Optional: AI model settings

| Variable | Default | Description |
|---|---|---|
| `HERMES_PROVIDER` | `gemini` | AI provider for the alpha/oracle stages |
| `HERMES_COMMAND` | `hermes` | Path to the Hermes CLI binary |
| `EVENT_MARKET_ALPHA_PROVIDER` | `gemini` | Provider override for the alpha stage |
| `EVENT_MARKET_ALPHA_MODEL` | `gemini-2.5-flash` | Model override for the alpha stage |
| `GEMINI_MODEL` | — | Global Gemini model fallback |
| `IMPLICATIONS_MODEL` | — | Model override for the implications stage |
| `VALIDATION_MODEL` | — | Model override for the validation stage |

### Optional: Storage paths

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `APP_DATA_FILE` | `./data/notes.json` | Notes storage file |
| `CAPTAINLABS_STATE_FILE` | `./data/captainlabs-state.json` | App state file |
| `PIPELINE_STATE_FILE` | `./data/pipeline-state.json` | Pipeline state file |
| `PIPELINE_OUTPUT_FILE` | `./data/pipeline-card-outputs.json` | Pipeline output file |

### Optional: Pipeline seeding

| Variable | Description |
|---|---|
| `PIPELINE_SEED_URLS` | Comma or newline-separated Kalshi URLs to pre-seed the pipeline queue |
| `PIPELINE_CALENDAR_URL` | Kalshi calendar endpoint for auto-seeding |
| `PIPELINE_CALENDAR_LIMIT` | Max calendar events to load (default: `50`) |

### Optional: Features

| Variable | Default | Description |
|---|---|---|
| `ENABLE_NOTE_TOOLS` | `false` | Enable `remember_note / list_notes / search_notes / delete_note` MCP tools |

See `.env.example` for a fully annotated list of all variables.

## npm scripts

| Script | Purpose |
|---|---|
| `npm run setup` | First-run setup: creates `.env`, makes `data/` dir |
| `npm run doctor` | Checks config, deps, Hermes CLI, and live server health |
| `npm run demo` | Starts server, checks endpoints, then exits |
| `npm start` | Start the backend server |
| `npm run dev` | Start with `--watch` (auto-restart on file changes) |
| `npm test` | Run the test suite |

## Runtime endpoints

| Endpoint | Purpose |
|---|---|
| `GET /` | Browser dashboard |
| `GET /health` | Health check JSON |
| `GET /healthz` | Health check JSON |
| `POST /mcp` | MCP transport (ChatGPT / compatible clients) |
| `GET /pipeline/status` | Pipeline status |
| `GET /pipeline/outputs/latest` | Latest stored board record |

## ChatGPT / MCP integration

See [CONNECT_CHATGPT.md](./CONNECT_CHATGPT.md) for the MCP setup path.

## Production deployment

See [docs/deployment-vps.md](./docs/deployment-vps.md) for VPS + Nginx + systemd setup.

## Project structure

```
frontend/       Next.js dashboard app (same-origin /api proxy)
src/            Node backend + MCP server
public/         Static assets for the backend-served dashboard shell
scripts/        Prediction pipeline scripts (MLB, NASCAR, UFC, politics)
deploy/         VPS deployment examples (systemd, nginx)
docs/           Extended documentation
runbooks/       Operator workflow specs
```

## Troubleshooting

**`hermes: command not found` or analysis always returns `watch`**
The Hermes CLI is the AI backbone for market analysis. Without it the server starts and responds, but market analysis falls back to a `watch` posture. Set `HERMES_COMMAND` in `.env` to the full path of your Hermes binary.

**Hermes fails with auth errors or Gemini permission errors**
Set `GEMINI_API_KEY` in `.env` to a valid Google AI key ([ai.google.dev](https://ai.google.dev)). Hermes uses this key when `HERMES_PROVIDER=gemini`.

**Server starts but `/health` returns 404 or connection refused**
Check the port — default is `3000`. If `PORT` is set in `.env`, use that. Make sure nothing else is on the same port: `lsof -i :3000`.

**`npm run setup` or `npm install` fails**
Confirm Node.js 18+ is installed: `node --version`. Try `rm -rf node_modules && npm install` to reset.

**`npm run doctor` reports dependency errors**
Run `npm install`, then `npm run doctor` again.

**Analysis always returns `watch` even with keys set**
`watch` is the safe fallback when the oracle can't find verifiable source-backed evidence for a market. This is expected for markets with thin data. Check Hermes CLI access and `GEMINI_API_KEY`.

**Frontend build errors**
The frontend is a separate Next.js app. Run `cd frontend && npm install && npm run build` independently. See [docs/deployment-vps.md](./docs/deployment-vps.md).

## Build on this

This is the bones. Fork it and add whatever your game needs:

- **New sport pipeline** — MLB, NFL, NBA, UFC are all supported patterns. Add your sport in `scripts/` following the existing structure.
- **New exchange** — the Kalshi adapter is in `src/kalshiApi.js`. Polymarket, PredictIt, or any REST API can follow the same pattern.
- **Notification output** — Telegram notifier is next on the roadmap. Discord, Slack, or any webhook can use the same hook point.
- **New agent skills** — add a `.skills/` file and wire it into `AGENTS.md`. The agent layer is designed to be extended.
- **Better UI** — the frontend is a Next.js app in `frontend/`. The card JSON contract is stable — build whatever view you want on top of it.
- **New AI backend** — swap the Hermes provider via `HERMES_PROVIDER` and `HERMES_COMMAND`. Any CLI-based agent that returns JSON works.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for how to fork and contribute.

## What to send Captain if it breaks

Include all of the following:

1. **`npm run doctor` output** — paste the full output, not just the last line
2. **Your `.env` (API keys redacted)** — which variables are set vs. empty
3. **`node --version` and `npm --version`** output
4. **Full error output** — stack trace or error message from the terminal
5. **Exact commands you ran** — step by step from clone to error
6. **What you expected** — what should have happened
7. **Your platform** — macOS / Linux / Windows + WSL version

Find Captain on Discord and X: **@CaptainMentions**
Open an issue: [github.com/captainslab/captains-prediction-companion/issues](https://github.com/captainslab/captains-prediction-companion/issues)

## License

ISC
