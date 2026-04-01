# Captains Prediction Companion

Captains Prediction Companion is a Node.js MCP-backed prediction-market assistant focused on **Kalshi event and mention markets**.

This repository's current application surface is a **backend-first MCP service**, not a full dashboard app.

## What the app currently does

- accepts Kalshi market URLs
- builds event-market and mention-market plans
- returns compact user-facing market cards
- exposes MCP tools over HTTP
- exposes a health endpoint for runtime checks

## Current runtime surface

- `GET /healthz` -> health check JSON
- `POST /mcp` -> MCP transport endpoint

At the moment, `GET /` does **not** serve a browser UI on `main`.

## Current project shape

- `src/server.js` runs the HTTP + MCP server
- `src/eventMarketTool.js` builds market plans
- `src/eventMarketPrompt.js` builds workflow prompts
- `src/llm/` contains market-card and mention-card logic

## Quick start

```bash
npm install
npm start
```

Then open or test:

- `http://localhost:3000/healthz`
- `http://localhost:3000/mcp`

## Environment notes

The checked-in `.env.example` still contains older Alphapoly-era values and should be replaced with a current app-specific version.

## Best next build step

If this repo stays the primary home for the app, the next clean product step is:

1. add `public/index.html`
2. serve it from `GET /`
3. add a small browser action that calls the existing market analysis path

## Repo reality check

The code in `main` is already aligned with the Captains Prediction Companion direction.
The main mismatch is **repo identity and stale docs**, not a completely separate product.
