# Connect to ChatGPT

Use Captains Prediction Companion as a private ChatGPT app with Developer mode enabled.

## Current endpoint

- MCP: `https://YOUR_DEPLOYMENT_URL/mcp`
- Health: `https://YOUR_DEPLOYMENT_URL/healthz`

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

- `app_status`
- `event_market_plan`
- `event_market_workflow`

## Important

- The app is read-only by default.
- Note tools are only exposed if `ENABLE_NOTE_TOOLS=true` is set on the server.
- The MCP server returns a compact user-facing card and keeps the workflow memo internal.
- That keeps ChatGPT from classifying the app as a writable connector unless you intentionally turn that on later.

## Notes

- Keep the app in `Drafts` while testing.
- If you redeploy, replace the MCP endpoint with the new public HTTPS URL.
- ChatGPT cannot connect to `localhost` directly unless you are only testing locally in your own browser environment.
