# Captains Prediction Companion Architecture

## Product shape

- ChatGPT-first prediction companion
- Remote MCP server as the primary integration point
- Dashboard is a later expansion path, not the starting point

## Core surfaces

- `app_status`
- `event_market_plan`
- `event_market_workflow`

## Output contract

- Visible output is a compact card only
- Hidden output keeps:
  - workflow memo
  - source tree
  - reasoning framework
  - validation details

## Execution model

- ChatGPT sends a market link or market brief to the MCP server
- The server parses and classifies the market
- The server can call a model provider such as OpenRouter when wired in
- The server returns structured JSON for UI rendering

## Recovery rules

- Keep app identity in `package.json`, `README.md`, and `CONNECT_CHATGPT.md`
- Keep durable product decisions in this file
- Keep secrets out of git

## Expansion path

- First: make the ChatGPT app reliable and recoverable
- Second: add a dashboard that reads the same structured contract
- Third: keep both surfaces on the same backend schema
