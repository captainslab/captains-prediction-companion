# Captains Prediction Companion (CPC)

**An auditable, price-isolated decision-intelligence system for prediction
markets, currently centered on Kalshi.**

CPC turns a market, event, or daily slate into a source-backed decision packet.
It determines what settlement requires, gathers and grades the available
evidence, applies market-specific research and models, estimates fair value when
the evidence supports it, and shows how that independent view compares with the
market. Each packet exposes confidence limits, missing inputs, source freshness,
blockers, and supporting audit evidence.

Unlike a generic market summarizer, CPC keeps market price, bid/ask, volume, open
interest, liquidity, and movement out of model scoring, ranking, posture,
confidence, and upgrades. Those values appear only as comparison context after
the independent view is formed. When critical evidence is missing or stale, CPC
fails closed instead of manufacturing a pick.

CPC operates through a private ChatGPT app, Node MCP server, browser dashboard,
and automated packet pipelines. Current workflows cover MLB moneylines, home
runs, and strikeouts; World Cup matches, totals, team totals, and advancement;
NASCAR; UFC; and exact-string mention and political markets. NFL and NCAA
football pipelines are planned for rollout as the 2026 football season
approaches, using CPC's shared evidence, price-isolation, source-health,
decision-packet, and fail-closed standards.

Delivery is built into the operating system. Telegram packets pass a
deterministic Packet Janitor that checks structure, source health, stale or
expired inputs, price leakage, and duplicate-send uncertainty before delivery.
Discord provides offline formatting, secret scrubbing, raw-inventory refusal, 15
named webhook routes, dry-run-by-default delivery, and a GET-only server
inventory utility. Both delivery paths remain downstream of research and never
feed back into model scoring.

CPC is research-only. It never places trades, submits orders, or automates
bankroll execution.

Find Captain on Discord and X as **@CaptainMentions** or open an issue at
[captainslab](https://github.com/captainslab).

[![License: ISC](https://img.shields.io/badge/license-ISC-blue.svg)](https://opensource.org/licenses/ISC)
[![Node: >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![Tests: node:test](https://img.shields.io/badge/tests-node%3Atest-success.svg)](#run-the-tests)
[![Trading: read-only](https://img.shields.io/badge/trading-read--only-critical.svg)](#privacy--security)

---

## 60-second tour

| You want to… | Do this |
|---|---|
| Understand the system | Read [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) |
| Connect ChatGPT | Read [CONNECT_CHATGPT.md](./CONNECT_CHATGPT.md) |
| Run it locally | `npm install && npm run setup && npm start` |
| Generate an MLB packet | `node scripts/packets/generate-mlb-daily.mjs --dry-run` |
| Generate a World Cup packet | `node scripts/worldcup/generate-matchday-packet.mjs --dry-run` |
| See what a packet looks like | Read [docs/PACKETS.md](./docs/PACKETS.md) |
| Inventory a Discord server safely | `node scripts/discord/inventory-discord.mjs` |
| Preview or send to Discord | Read [docs/DISCORD.md](./docs/DISCORD.md) |
| Preview Telegram delivery safely | `node scripts/packets/send-packets-telegram.mjs --date YYYY-MM-DD --type mlb-daily --dry-run` |
| Understand Telegram delivery gates | Read [docs/PACKET_JANITOR.md](./docs/PACKET_JANITOR.md) |
| Run every command | Read [docs/USAGE.md](./docs/USAGE.md) |
| Check what is safe to touch | Read [docs/SECURITY_PRIVACY.md](./docs/SECURITY_PRIVACY.md) |
| Operate the repo as an agent | Read [docs/AGENT_GUIDE.md](./docs/AGENT_GUIDE.md) |

## Latest Updates

<!-- CPC:UPDATES:START -->

**Latest: [Unreleased] — public-alpha hardening, Discord delivery, and multi-sport expansion (2026-07-10)**

- Added: World Cup matchday pipeline with same-date team baselines, lineup gates, Elo→Poisson advances model, held-out calibration/backtest, and gate-respecting Telegram delivery
- Added: Discord delivery layer with 15 named Captain's Crew routes, env-only webhooks, dry-run by default, and explicit `--send` live mode
- Added: GET-only Discord guild inventory snapshot for categories, channels, roles, and webhook metadata; no sends and no secret output
- Added: NASCAR live Perplexity research layer with source-health disclosure and fail-closed missing-research handling
- Added: Scraper-first mentions discovery with deterministic category fallback, per-source deadlines, and degraded-source artifacts
- Added: Fail-closed Perplexity entity attachment contracts for mention-event and mentions-daily packets
- Changed: Price isolation hardened across alpha prompts, board ordering, ranking, posture, and MLB primary selection; market values remain display/audit-only
- Changed: MLB actionable posture now requires a model-backed `fair_value`; reference-price-only gaps render model output only when a stats-backed projection exists
- _…and 40 more — see [CHANGELOG.md](./CHANGELOG.md)_

_Auto-generated from `CHANGELOG.md` by `npm run docs:update`. Do not edit by hand._

<!-- CPC:UPDATES:END -->

## Project Status

<!-- CPC:STATUS:START -->

| Field | Status |
|---|---|
| Package version | `1.0.0` |
| Latest changelog | `Unreleased` |
| Node requirement | `>=18` (developed on Node 22) |
| Trading posture | Read-only — **no orders, no bankroll automation** |
| Composite scoring | Market-neutral — market price is **never** a composite input |
| Supported packets | MLB · World Cup · NASCAR · mentions / politics · UFC |
| Discord delivery | 15 named webhook routes — dry-run by default; live only with explicit `--send` |
| Discord inventory | GET-only guild snapshot — no sends and no secret output |

_Auto-generated from `package.json` + `CHANGELOG.md` by `npm run docs:update`. Do not edit by hand._

<!-- CPC:STATUS:END -->

---

## What CPC is

CPC turns a prediction market into a **decision packet**: a compact, sectioned
board that puts the model's view and the market's price side by side so a human
can spot a useful read, a source gap, or a blocked setup in under a minute.

It solves four problems:

1. **Signal vs. price confusion** — market prices do not enter model input,
   scoring, ranking, posture, or confidence.
2. **Wall-of-text research** — raw contract dumps belong in an audit file, not
   in the customer-facing board.
3. **One-off scripts per sport** — shared packet and decision-process layers let
   new pipelines inherit the same output contract.
4. **False confidence under missing data** — source-health, lineup, model, and
   settlement gaps fail closed instead of being promoted into picks.

### Supported market types

| Type | Generator | Notes |
|---|---|---|
| MLB games | `scripts/packets/generate-mlb-daily.mjs` | Projection-first ML, HR, and K lanes with model-backed posture gates |
| World Cup matchdays | `scripts/worldcup/generate-matchday-packet.mjs` | Match, totals/team totals, and advances lanes with lineup and baseline gates |
| NASCAR races | `scripts/packets/generate-nascar-sunday.mjs` | Multi-lane ceiling board plus live research and source-health disclosure |
| Mentions / politics | `scripts/packets/generate-mentions-daily.mjs` | Exact-string proof markets with scraper-first discovery and attachment contracts |
| UFC (weekly) | `scripts/packets/generate-ufc-weekly.mjs` | Packet-only weekly guardrails; skipped when no event |

## How composite scoring works

Each contract is scored by a **composite evidence ledger** — a weighted set of
fundamentals layers such as form, matchup, venue, lineup, injuries, and source
quality. The composite produces a model posture and, where possible, a numeric
fair probability. The board then computes:

```
edge = model_fair_probability  −  market_implied_probability   (in pp)
```

### Market prices are for comparison, never scoring

This is the hard rule the whole system is built around:

> **Market price, bid/ask, volume, and open interest live ONLY in the `market`
> half of a decision row. They are NEVER read back into composite scoring.**

The composite half arrives already scored from the domain model. Edge is the
comparison of the two halves — model fair vs. market implied — and is always
model-vs-market, never market-vs-market. This boundary is enforced across the
shared decision-packet layer, alpha prompts, ranking, posture, and packet tests.

## What a decision packet is

A decision packet is a ranked, sectioned board. Shared packet families use this
core layout:

```
TLDR BOARD            one-line counts + headline read
1. TOP EDGE           model fair beats market by a strong margin
2. WATCHLIST          thin edge / incomplete evidence + trigger to act
3. FADES              market implied runs above model fair
4. BLOCKED            settlement-, source-, lineup-, or model-critical input missing
5. AUDIT ARTIFACTS    paths to supporting artifacts (never raw inventory inline)
```

Full anatomy and examples: [docs/PACKETS.md](./docs/PACKETS.md).

## Quick start

**Requires Node.js 18+ (developed on Node 22).**

```bash
git clone https://github.com/captainslab/captains-prediction-companion.git
cd captains-prediction-companion
npm install
npm run setup          # copies .env.example -> .env, creates data/
# Edit .env and set the provider credentials required by the workflow you use
npm start
```

Verify:

```bash
npm run doctor         # config, deps, Hermes CLI, live server health
```

Open in a browser:

- `http://localhost:3000/` — dashboard
- `http://localhost:3000/health` — health check JSON
- `http://localhost:3000/mcp` — MCP endpoint

## Generate a packet

All generators are **read-only and place no trades.** Run with `--dry-run` when
supported to render or validate without a live delivery step:

```bash
node scripts/packets/generate-mlb-daily.mjs --dry-run
node scripts/worldcup/generate-matchday-packet.mjs --dry-run
node scripts/packets/generate-nascar-sunday.mjs --dry-run
node scripts/packets/generate-mentions-daily.mjs --dry-run
```

Generated packets and supporting artifacts are written under date-scoped
`state/` directories. Raw contract inventory stays in separate audit artifacts
and is never inserted into the customer-facing board.

Full command reference: [docs/USAGE.md](./docs/USAGE.md).

## Run the tests

```bash
npm test                                           # full suite (node:test)
node --test test/decision-packet-shape.test.mjs   # shared packet shape
node --test test/discord-delivery.test.mjs        # Discord route/send guards
node --test test/discord-inventory.test.mjs       # GET-only inventory guards
```

## Keep docs in sync

The README "Latest Updates" and "Project Status" blocks are generated from
`CHANGELOG.md` + `package.json`:

```bash
npm run docs:update     # rewrite only the marked README blocks
npm run docs:check      # CI-safe: fail if README is stale
```

`docs:update` touches **only** the text between the `CPC:UPDATES` / `CPC:STATUS`
markers. Everything else in the README is preserved byte-for-byte.

## Telegram and Discord delivery

Delivery is downstream of packet construction. Neither destination can alter
evidence, scoring, ranking, posture, confidence, or fair value.

### Telegram packet delivery

`scripts/packets/send-packets-telegram.mjs` delivers CPC packets as a short
notice plus the rendered `.txt` document. Before any network request, the
deterministic Packet Janitor validates the packet and returns `SEND_ALLOWED`,
`SEND_ALLOWED_AFTER_REPAIR`, `JANITOR_WARNING`, or `JANITOR_BLOCKED`.

The Telegram path:

- checks packet structure, source health, stale-source disclosure, price leakage,
  missing evidence, and contradictory score/posture
- blocks expired pre-game packets before they reach Telegram
- excludes `*.inventory.txt` and `*.meta.json` audit artifacts from delivery
- uses an idempotency ledger so reruns do not resend the same packet
- applies at most one deterministic packaging repair and never rewrites evidence,
  picks, scores, or rationale
- supports dry-run proof showing exactly what would send or block

```bash
node scripts/packets/send-packets-telegram.mjs \
  --date YYYY-MM-DD \
  --type mlb-daily \
  --dry-run
```

See [docs/PACKET_JANITOR.md](./docs/PACKET_JANITOR.md) for the complete delivery
gate, verdicts, repair limits, source-health checks, and audit artifacts.

### Discord delivery and inventory

CPC separates Discord support into formatting, delivery, and inventory:

- `scripts/shared/discord-format.mjs` is pure and offline. It splits messages
  under Discord's 2000-character limit, scrubs secret-shaped text, preserves the
  canonical packet sections, and refuses raw inventory artifacts.
- `scripts/packets/send-discord-packet.mjs` supports 15 named Captain's Crew
  routes. Dry-run is the default. A network send happens only with explicit
  `--send` and an env-only webhook URL.
- `scripts/discord/inventory-discord.mjs` is GET-only. It snapshots categories,
  channels, roles, and webhook metadata without sending messages or writing
  token or webhook values.

```bash
# Read-only guild inventory. Requires DISCORD_BOT_TOKEN + DISCORD_GUILD_ID.
node scripts/discord/inventory-discord.mjs

# Preview one rendered packet. No network by default.
node scripts/packets/send-discord-packet.mjs \
  --packet state/packets/<date>/<type>/<packet>.txt \
  --route operator-dry-runs \
  --dry-run
```

See [docs/DISCORD.md](./docs/DISCORD.md) for route names, environment variables,
inventory behavior, and live-send safeguards.

## Where audit artifacts go

| Artifact | Location |
|---|---|
| Rendered packet board | `state/packets/<date>/<type>/*.txt` |
| Packet metadata | `state/packets/<date>/<type>/*.meta.json` |
| Raw contract inventory (audit only) | `state/packets/<date>/<type>/*.inventory.txt` |
| Discord guild inventory | `state/discord/inventory.json` and `state/discord/inventory.md` |
| Per-run research state | `state/<sport>/<date>/` |

`state/`, `data/`, `.runtime/`, and `scratch/` are runtime/working areas, not
documentation or source of truth. New date-scoped runs are gitignored.

## No trades, no orders

CPC is **research-only**. No script in this repo places an order, manages a
bankroll, or executes a trade. Every delivery path is downstream of packet
construction and never feeds back into model scoring.

See [docs/SECURITY_PRIVACY.md](./docs/SECURITY_PRIVACY.md).

## Extend a new market type

1. Score contracts into a composite half (`{ score, posture, layersPresent,
   layersTotal, topEvidenceLayers, missingLayers, modelProbability? }`).
2. Build rows with `buildDecisionRow()` from `scripts/shared/decision-packet.mjs`
   and keep market values in the `market` half only.
3. Render with `renderSectionedPacket()` and write audit inventory separately.
4. Add a generator under the relevant pipeline directory and focused tests under
   `test/`.

Step-by-step: [docs/USAGE.md](./docs/USAGE.md) → "Extend a new market type".

## Privacy & Security

CPC is built secrets-out and read-only by default:

- **Secrets** — `.env`, `.runtime`, webhook URLs, bot tokens, API keys, and
  private keys are never printed, logged, or committed. Tooling reports only
  presence, never values.
- **Trading** — no live orders, no bankroll automation, no execution.
- **Discord** — formatting is offline; delivery is dry-run by default and live
  only with explicit `--send` plus an env-only webhook; inventory is GET-only.
- **Data** — `state/`, `data/`, `.runtime/`, and `scratch/` are runtime areas,
  never source of truth; raw inventory belongs in audit artifacts.
- **Agents** — check `git status` first, use exact-file staging, run tests, show
  proof, and do not merge unreviewed changes.

Full screen + agent preflight checklist: [docs/SECURITY_PRIVACY.md](./docs/SECURITY_PRIVACY.md).

## Documentation map

| Doc | What is in it |
|---|---|
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | System shape, data flow, neutrality boundary |
| [docs/USAGE.md](./docs/USAGE.md) | Command reference |
| [docs/PACKETS.md](./docs/PACKETS.md) | Decision-packet anatomy and section examples |
| [docs/DISCORD.md](./docs/DISCORD.md) | Formatter, 15-route delivery adapter, inventory, and safety gates |
| [docs/PACKET_JANITOR.md](./docs/PACKET_JANITOR.md) | Telegram pre-send validation, safe repairs, blocking rules, and delivery proof |
| [docs/SECURITY_PRIVACY.md](./docs/SECURITY_PRIVACY.md) | Secrets, data, trading, delivery, and agent rules |
| [docs/AGENT_GUIDE.md](./docs/AGENT_GUIDE.md) | How an agent should operate this repo |
| [CHANGELOG.md](./CHANGELOG.md) | Full version history |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | How to fork and contribute |
| [CONNECT_CHATGPT.md](./CONNECT_CHATGPT.md) | MCP / ChatGPT setup path |
| [docs/deployment-vps.md](./docs/deployment-vps.md) | VPS + Nginx + systemd |

## Project structure

```
frontend/       Next.js dashboard app (same-origin /api proxy)
src/            Node backend, MCP server, app tools, and shared services
scripts/
  packets/      Packet generators and delivery CLIs
  shared/       Decision packet, decision process, Discord format/send helpers
  discord/      GET-only Discord inventory tooling
  worldcup/     Matchday, advances, baseline, lineup, and backtest pipeline
  mlb/          MLB scoring, projections, discovery, and article support
  nascar/       NASCAR source adapters, live research, and ceiling model
  mentions/     Mentions discovery, routing, research, and watcher pipeline
  politics/     Politics-specific research and packet support
  docs/         Deterministic README updater (`docs:update` / `docs:check`)
test/           node:test suite and deterministic fixtures
docs/           Extended documentation
deploy/         VPS deployment examples (systemd, nginx)
agents/         Operator role definitions
```

## Troubleshooting

**`hermes: command not found` or analysis always returns `watch`** — the Hermes
CLI is the AI backbone. Set `HERMES_COMMAND` in `.env` to the full path of your
Hermes binary.

**Hermes fails with auth/Gemini errors** — set `GEMINI_API_KEY` in `.env`
([ai.google.dev](https://ai.google.dev)).

**`/health` returns 404 / connection refused** — check the port (default `3000`).
Use `lsof -i :3000` to see what is bound.

**`npm install` fails** — confirm Node 18+ (`node --version`); try
`rm -rf node_modules && npm install`.

**Analysis always returns `watch` with keys set** — `watch` is the safe fallback
when the oracle cannot find verifiable evidence. Expected for thin markets.

**Discord inventory exits `BLOCKED`** — set `DISCORD_BOT_TOKEN` and
`DISCORD_GUILD_ID`; the bot needs read-only `View Channels` and `Manage Webhooks`
access for a complete snapshot.

## What to send Captain if it breaks

1. `npm run doctor` output (full, not just the last line)
2. Which `.env` variables are set vs. empty (**values redacted**)
3. `node --version` and `npm --version`
4. Full error output / stack trace
5. Exact commands run, clone → error
6. What you expected
7. Platform (macOS / Linux / Windows + WSL)

Find Captain on Discord and X: **@CaptainMentions** ·
[Open an issue](https://github.com/captainslab/captains-prediction-companion/issues)

## License

ISC
