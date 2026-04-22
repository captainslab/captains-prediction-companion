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
- The server can call a model provider when wired in
- The server returns structured JSON for UI rendering

## Recovery rules

- Keep app identity in `package.json`, `README.md`, and `CONNECT_CHATGPT.md`
- Keep durable product decisions in this file
- Keep secrets out of git

## Pipeline model

V1 ships 3 prediction pipelines + shared infra. The 8-app breakdown from earlier specs is the target end state — not the build order.

```
gameApp (sport="NBA"|"NFL"|"NCAABB"|"NCAAFB"|"MLB")
  └── sport config controls: exponents, pace model, injury rules

propApp (propType="HR"|"K"|"playerPoints"|"playerReb")
  └── player-level distribution model

fightAndRacingApp (type="UFC"|"NASCAR")
  └── two separate scoring models inside one shell
```

**Why this split:** The Pythagorean win model, possession/scoring distribution, injury gate, and Kelly sizing are identical across NBA/NFL/NCAABB/NCAAFB/MLB — only the efficiency metrics and exponents differ. A `sport` config key handles that. Player props need a separate distribution model (batter/pitcher/player level, not team level). UFC has no score or clock; NASCAR has no analog in other sports — both are different enough to justify separation from `gameApp`, but similar enough in infra to share one shell for V1.

**Mentions and politics pipelines** are separate from all of the above because resolution is text-based (word appears in transcript), not outcome-based. See `docs/MENTIONSAPP.md`.

## mentionsApp model

`mentionsApp` is one pipeline with a subtype config — not 6 separate apps:

```
mentionsApp
  ├── subtype: "earningsMentionsApp"     ← Delta, Tesla, United…
  ├── subtype: "politicalMentionsApp"    ← Hegseth, Trump, any political figure
  ├── subtype: "fedMentionsApp"          ← Powell FOMC pressers
  ├── subtype: "sportsPresserApp"        ← Coach/player post-game
  ├── subtype: "sportsAnnouncerApp"      ← Live broadcast commentary
  └── subtype: "mediaInterviewApp"       ← TV hits, podcasts
```

The subtype flag controls only the context loader (eligible speaker + transcript source). The 8-step pipeline, probability engine, resolution auditor, and output packet are shared across all subtypes.

Full spec: `docs/MENTIONSAPP.md`

## Expansion path

- First: make the ChatGPT app reliable and recoverable
- Second: add a dashboard that reads the same structured contract
- Third: keep both surfaces on the same backend schema
