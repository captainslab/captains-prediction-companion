# VPS Deployment Runbook for captainlabs.io

This repo supports a same-origin deployment on a VPS:

Cloudflare DNS -> VPS public IP -> Nginx -> frontend at `/` + `/api/*` proxy -> Node backend -> Postgres

## Verified repo shape
- Frontend: `frontend/` (Next.js app with custom `frontend/server.js`)
- Backend: `src/server.js` (Node HTTP + MCP server)
- Frontend API proxy: `frontend/app/api/[[...path]]/route.ts`
- Frontend MCP route: `frontend/app/api/mcp/analyze/route.ts`

## Exact build/start commands

Frontend:
```bash
cd frontend
npm install
npm run build
npm run start
```

Backend:
```bash
npm install
node src/server.js
```

Recommended production ports:
- frontend: `3000`
- backend: `8000`

## Exact environment variables

Backend:
- `PORT=8000`
- Hermes auth configured for the alpha stage's Gemini provider
- `EVENT_MARKET_ALPHA_PROVIDER=gemini` if you want to pin the alpha provider explicitly
- `EVENT_MARKET_ALPHA_MODEL=gemini-2.5-flash` if you want to override the alpha model
- `GEMINI_MODEL=` if you want a global Gemini fallback override
- `APP_DATA_FILE=/var/lib/captains/notes.json` (or another writable path)
- `PIPELINE_STATE_FILE=/var/lib/captains/pipeline-state.json`
- `PIPELINE_OUTPUT_FILE=/var/lib/captains/pipeline-card-outputs.json`
- `PIPELINE_SEED_URLS` if you want a seeded market queue
- `PIPELINE_CALENDAR_URL` and `PIPELINE_CALENDAR_LIMIT` if you want calendar seeding
- `HERMES_COMMAND` only if overriding the Hermes binary

Frontend:
- `PORT=3000`
- `BACKEND_URL=http://127.0.0.1:8000`
- `MCP_SERVER_URL=http://127.0.0.1:8000/mcp`

Notes:
- The frontend already uses same-origin `/api/*` from the browser.
- In production, Nginx should proxy `/api/*` to the frontend server on `3000`.
- The frontend server then proxies those routes to the backend.
- Only `/ws/*` should force `Upgrade` / `Connection: upgrade` headers. Do not force websocket headers on `/api/*`, or the frontend catch-all proxy can fail with `invalid connection header` when it forwards to the backend.

## Same-origin production flow

Recommended request flow for the browser:
- `https://captainlabs.io/` -> Nginx -> frontend server
- `https://captainlabs.io/api/*` -> Nginx -> frontend server -> backend `8000`
- `https://captainlabs.io/mcp` -> only if you explicitly proxy it; the browser app normally uses `/api/mcp/analyze`

## systemd

Use one unit for the backend and one for the frontend.
Keep them under `/etc/systemd/system/` on the VPS.

Example units are in:
- `deploy/systemd/captainlabs-api.service.example`
- `deploy/systemd/captainlabs-frontend.service.example`

The backend serves `/health` and `/healthz`.
The frontend app proxies same-origin `/api/*` to the backend, so `https://captainlabs.io/api/health` should return 200 once Nginx and both services are up.

## Nginx

Use a single HTTPS virtual host for `captainlabs.io` and optionally `www.captainlabs.io`.
Example config is in:
- `deploy/nginx/captainlabs.io.conf.example`

## Local verification before DNS cutover

1. Start backend on `8000`.
2. Start frontend on `3000` with `BACKEND_URL=http://127.0.0.1:8000` and `MCP_SERVER_URL=http://127.0.0.1:8000/mcp`.
3. Verify:
```bash
curl -i http://127.0.0.1:8000/health
curl -i http://127.0.0.1:3000/
curl -i http://127.0.0.1:3000/api/pipeline/status
curl -i http://127.0.0.1:3000/api/mcp/analyze
```
4. Confirm the browser loads the app without console errors.

## Cloudflare DNS records

Keep Cloudflare DNS-only until HTTPS works locally.

Typical records:
- `@` A -> VPS public IP, DNS only
- `www` CNAME -> `captainlabs.io`, DNS only

If you use a different host for the frontend, keep the browser-facing origin stable and proxy through Nginx.

## SSL with Certbot

After Nginx is working on HTTP and DNS resolves correctly:
```bash
sudo certbot --nginx -d captainlabs.io -d www.captainlabs.io
```

Then verify:
```bash
sudo nginx -t
sudo systemctl reload nginx
curl -I https://captainlabs.io/health
curl -I https://captainlabs.io/api/pipeline/status
```

## Port 443 conflicts

Before enabling HTTPS, verify nothing else is on 443:
```bash
sudo ss -ltnp | grep ':443\b' || true
```
If Tailscale or another service owns 443, move or disable the conflict before running Certbot/Nginx TLS.

## PASS criteria

Mark deployment PASS only if all are true:
- `https://captainlabs.io` loads
- `https://captainlabs.io/api/health` returns 200
- main pages load without errors
- deep links refresh correctly
- backend survives reboot under systemd
- SSL is valid
- `nginx -t` passes
- DNS resolves to the VPS
- no 443 conflict remains
