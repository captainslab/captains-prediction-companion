# Connect to ChatGPT

Use Captains Prediction Companion as a private ChatGPT app with Developer mode enabled.
See `docs/CHATGPT_APP_READINESS.md` for the full private readiness checklist and
`docs/CPC_OUTPUT_LANGUAGE.md` for customer-facing card/packet language rules.

## Current endpoint

- MCP: `https://captainlabs.io/mcp`
- Health: `https://captainlabs.io/healthz`

## Steps

1. Open ChatGPT on the web.
2. Go to `Settings → Apps → Advanced settings`.
3. Turn on `Developer mode`.
4. Open `ChatGPT Apps settings`.
5. Click `Create app`.
6. Enter the MCP endpoint above.
7. Save the app.
8. Open a chat and choose the app while in Developer mode.

## Expected app surfaces

- `app_status` — compact status report
- `analyze_kalshi_market_url` — paste a Kalshi URL, get the full plan
- `mentions_research` — fresh mentions research for ANY family (Trump/Fed/sports/earnings), full
  rendered packet (fails closed, never cached, no sends)
- `earnings_mention_research` — manual single-event earnings-call mention path (full packet)
- `settled_event_history` — price-free settled base rates; `family=sports|earnings|general`
- `run_composite_model` — run the MLB composite model for a market URL, full board
- `mlb_sports_preview` — full MLB slate preview packet for a date
- `sports_preview` — latest banked preview packet for `sport=nascar|ufc|worldcup` (read-only)

## Important

- The app is read-only by default.
- Note tools are only exposed if `ENABLE_NOTE_TOOLS=true` is set on the server.
- Research tools return **full output** to ChatGPT: complete human-readable text plus the
  full structured object. Pass `compact: true` on any tool (or set `MCP_COMPACT_DEFAULT=true`
  on the server) to get the short card instead.
- `mentions_research` runs fresh every call and fails closed — it never serves a cached render.

## Deploy (captainlabs.io)

The server is plain Node + the MCP streamable-HTTP transport, so deploying is just
"run it behind the existing TLS reverse proxy":

1. Pull this repo onto the `captainlabs.io` host.
2. `npm ci` (only deps are `@modelcontextprotocol/sdk` and `zod`).
3. Run it locally with `npm start` (default `PORT=3000`).
4. For production, adapt `deploy/systemd/captainlabs-api.service.example`; it uses
   `PORT=8000`, matching the nginx upstream `127.0.0.1:8000` in
   `deploy/nginx/captainlabs.io.conf.example`.
5. nginx proxies `/` (incl. `/mcp` and `/healthz`) to the production node port, so once
   the service is up, `https://captainlabs.io/mcp` is live.
6. Verify: `curl https://captainlabs.io/healthz` should return `{"ok":true,...}`.

Then add `https://captainlabs.io/mcp` in ChatGPT as above.

## Notes

- Keep the app in `Drafts` while testing.
- If you redeploy, replace the MCP endpoint with the new public HTTPS URL.
- ChatGPT cannot connect to `localhost` directly unless you are only testing locally in your own browser environment.
