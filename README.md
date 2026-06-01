# Captains Prediction Companion (CPC)

**A research-only operating system for prediction markets.** Paste a market, get a
structured decision packet — fair value, edge, confidence, and the reasoning
behind it — built market-neutral and delivered as a clean, mobile-readable board.

Runs as a local MCP server so it plugs straight into ChatGPT or any compatible
client. Fork it, add a pipeline, make it yours.

Find Captain on Discord and X as **@CaptainMentions** — or open an issue at
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
| Run it | `npm run setup && npm install && npm start` |
| Generate a decision packet | `node scripts/packets/generate-mlb-daily.mjs --dry-run` |
| See what a packet looks like | [docs/PACKETS.md](./docs/PACKETS.md) |
| Run every command | [docs/USAGE.md](./docs/USAGE.md) |
| Check what's safe to touch | [docs/SECURITY_PRIVACY.md](./docs/SECURITY_PRIVACY.md) |
| Operate the repo as an agent | [docs/AGENT_GUIDE.md](./docs/AGENT_GUIDE.md) |

## Latest Updates

<!-- CPC:UPDATES:START -->

**Latest: [Unreleased] — decision-packet refactor + docs system (2026-05-31)**

- Added: Shared sectioned decision-packet renderer (`scripts/shared/decision-packet.mjs`): one row schema + board layout used by every market type (MLB, NASCAR, mentions/politics)
- Added: Six-section packet body: TLDR BOARD → Top Edge → Watchlist/Trigger → Fades → Blocked/Needs Source → Audit Artifacts
- Added: Audit-only raw inventory split: `buildInventoryArtifact()` keeps per-contract dumps out of the main board and in a separate `*.inventory.txt`
- Added: Discord dry-run formatter (`scripts/shared/discord-format.mjs`): offline, 2000-char-safe splitting, secret scrubbing, raw-inventory refusal — no network, no token reads
- Added: Deterministic docs updater (`scripts/docs/update-readme-updates.mjs`) + `npm run docs:update` / `docs:check`
- Added: README auto-generated `CPC:UPDATES` and `CPC:STATUS` blocks (sourced from CHANGELOG + package.json)
- Added: Documentation set: `docs/ARCHITECTURE.md`, `docs/USAGE.md`, `docs/PACKETS.md`, `docs/DISCORD.md`, `docs/SECURITY_PRIVACY.md`, `docs/AGENT_GUIDE.md`
- Added: `cpc-repo-upgrader` reusable operator (`docs/operators/cpc-repo-upgrader/SKILL.md`)
- _…and 29 more — see [CHANGELOG.md](./CHANGELOG.md)_

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
| Supported packets | MLB · NASCAR · mentions / politics |
| Discord output | Dry-run formatter only (offline, no live send) |

_Auto-generated from `package.json` + `CHANGELOG.md` by `npm run docs:update`. Do not edit by hand._

<!-- CPC:STATUS:END -->

---

## What CPC is

CPC turns a prediction market into a **decision packet**: a compact, sectioned
board that puts the model's view and the market's price side by side so a human
can spot edge in under a minute.

It solves three problems:

1. **Signal vs. price confusion** — most tools let the market price leak into the
   "model." CPC keeps them strictly separated (see below).
2. **Wall-of-text research** — raw contract dumps belong in an audit file, not in
   your face. CPC renders a clean board and links the audit separately.
3. **One-off scripts per sport** — CPC ships a single shared decision-packet
   renderer used by every market type, so a new pipeline inherits the format for
   free.

### Supported market types

| Type | Generator | Notes |
|---|---|---|
| MLB games | `scripts/packets/generate-mlb-daily.mjs` | ML + HR + K lanes |
| NASCAR races | `scripts/packets/generate-nascar-sunday.mjs` | Multi-lane ceiling board |
| Mentions / politics | `scripts/packets/generate-mentions-daily.mjs` | Exact-string proof markets |
| UFC (weekly) | `scripts/packets/generate-ufc-weekly.mjs` | Skipped when no event |

## How composite scoring works

Each contract is scored by a **composite evidence ledger** — a weighted set of
fundamentals layers (form, matchup, venue/park, lineup/injury, etc.). The
composite produces a model posture and, where possible, a numeric fair
probability. The board then computes:

```
edge = model_fair_probability  −  market_implied_probability   (in pp)
```

### Market prices are for edge detection — never for scoring

This is the hard rule the whole system is built around:

> **Market price, bid/ask, volume, and open interest live ONLY in the `market`
> half of a decision row. They are NEVER read back into composite scoring.**

The composite half arrives already-scored from the domain model. Edge is the
*comparison* of the two halves — model fair vs. market implied — and is always
model-vs-market, never market-vs-market. This is enforced in
`scripts/shared/decision-packet.mjs` and covered by neutrality tests.

## What a decision packet is

A decision packet is a ranked, sectioned board. Every market type renders the
same six sections:

```
TLDR BOARD            one-line counts + headline edge
1. TOP EDGE           model fair beats market by a strong margin
2. WATCHLIST          thin edge / incomplete evidence + trigger to act
3. FADES              market implied runs above model fair
4. BLOCKED            settlement- or model-critical input missing
5. AUDIT ARTIFACTS    paths to the raw inventory (never inline)
```

Full anatomy and examples: [docs/PACKETS.md](./docs/PACKETS.md).

## Quick start

**Requires Node.js 18+ (developed on Node 22).**

```bash
git clone https://github.com/captainslab/captains-prediction-companion.git
cd captains-prediction-companion
npm run setup          # copies .env.example -> .env, creates data/
# Edit .env — set GEMINI_API_KEY at minimum
npm install
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

All generators are **read-only and place no trades.** Run any of them with
`--dry-run` to render to stdout without writing state:

```bash
node scripts/packets/generate-mlb-daily.mjs --dry-run
node scripts/packets/generate-nascar-sunday.mjs --dry-run
node scripts/packets/generate-mentions-daily.mjs --dry-run
```

Without `--dry-run`, packets are written under
`state/packets/<YYYY-MM-DD>/<type>/` as a `.txt` board, a `.meta.json`, and (for
long boards) `.chunk-N.txt` parts. Raw contract inventory is written to a
separate `*.inventory.txt` audit file — never inside the board.

Full command reference: [docs/USAGE.md](./docs/USAGE.md).

## Run the tests

```bash
npm test                                      # full suite (node:test)
node --test test/decision-packet-shape.test.mjs   # one file
node --test test/discord-format.test.mjs          # Discord dry-run guards
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

## Discord dry-run formatting

CPC ships an **offline** Discord formatter (`scripts/shared/discord-format.mjs`).
It transforms a rendered board into Discord-ready message parts — splitting at
the 2000-char limit, scrubbing secret-looking tokens, and refusing to post a raw
inventory dump. It **never** opens a network connection or reads a token. Live
sending is a separate, explicitly-authorized step. See [docs/DISCORD.md](./docs/DISCORD.md).

## Where audit artifacts go

| Artifact | Location |
|---|---|
| Rendered packet board | `state/packets/<date>/<type>/*.txt` |
| Packet metadata | `state/packets/<date>/<type>/*.meta.json` |
| Raw contract inventory (audit only) | `state/packets/<date>/<type>/*.inventory.txt` |
| Per-run research state | `state/<sport>/<date>/` |

`state/`, `data/`, `.runtime/`, and `scratch/` are runtime/working areas — **not
documentation or source of truth.** New date-scoped runs are gitignored.

## No trades, no orders

CPC is **research-only**. No script in this repo places an order, manages a
bankroll, or executes a trade. Every generator carries a
`No trades placed by this workflow.` footer, and that boundary is a hard rule —
see [docs/SECURITY_PRIVACY.md](./docs/SECURITY_PRIVACY.md).

## Extend a new market type

1. Score your contracts into a composite half (`{ score, posture, layersPresent,
   layersTotal, topEvidenceLayers, missingLayers, modelProbability? }`).
2. Build rows with `buildDecisionRow()` from `scripts/shared/decision-packet.mjs`
   — pass market price in the `market` half only.
3. Render with `renderSectionedPacket()` and write the audit inventory with
   `buildInventoryArtifact()`.
4. Add a generator under `scripts/packets/` and a test under `test/`.

Step-by-step: [docs/USAGE.md](./docs/USAGE.md) → "Extend a new market type".

## Privacy & Security

CPC is built secrets-out and read-only by default:

- **Secrets** — `.env`, `.runtime`, webhook URLs, bot tokens, API keys, and
  private keys are never printed, logged, or committed. Tooling reports only
  *presence*, never values.
- **Trading** — no live orders, no bankroll automation, no execution.
- **Discord** — dry-run formatter is offline; live send requires explicit
  authorization and an env-only webhook URL.
- **Data** — `state/`, `data/`, `.runtime/`, `scratch/` are runtime areas, never
  source-of-truth; raw inventory belongs in audit artifacts.
- **Agents** — check `git status` first, avoid broad refactors, run tests, show
  proof, never push without approval.

Full screen + agent preflight checklist: [docs/SECURITY_PRIVACY.md](./docs/SECURITY_PRIVACY.md).

## Documentation map

| Doc | What's in it |
|---|---|
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | System shape, data flow, neutrality boundary |
| [docs/USAGE.md](./docs/USAGE.md) | Every command, copy-paste ready |
| [docs/PACKETS.md](./docs/PACKETS.md) | Decision-packet anatomy + section examples |
| [docs/DISCORD.md](./docs/DISCORD.md) | Discord dry-run formatter contract & safety |
| [docs/SECURITY_PRIVACY.md](./docs/SECURITY_PRIVACY.md) | Secrets, data, trading, agent rules |
| [docs/AGENT_GUIDE.md](./docs/AGENT_GUIDE.md) | How an agent should operate this repo |
| [CHANGELOG.md](./CHANGELOG.md) | Full version history |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | How to fork and contribute |
| [CONNECT_CHATGPT.md](./CONNECT_CHATGPT.md) | MCP / ChatGPT setup path |
| [docs/deployment-vps.md](./docs/deployment-vps.md) | VPS + Nginx + systemd |

## Project structure

```
frontend/       Next.js dashboard app (same-origin /api proxy)
src/            Node backend + MCP server
scripts/
  packets/      Packet generators (MLB, NASCAR, mentions, UFC)
  shared/       Shared decision-packet renderer, decision-process, Discord format
  docs/         Deterministic docs updater (docs:update / docs:check)
  mlb/ nascar/ mentions/ politics/   per-pipeline scoring + adapters
test/           node:test suite
docs/           Extended documentation (this map)
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
`lsof -i :3000` to see what's bound.

**`npm install` fails** — confirm Node 18+ (`node --version`); try
`rm -rf node_modules && npm install`.

**Analysis always returns `watch` with keys set** — `watch` is the safe fallback
when the oracle can't find verifiable evidence. Expected for thin markets.

## What to send Captain if it breaks

1. `npm run doctor` output (full, not just the last line)
2. Which `.env` variables are set vs. empty (**keys redacted**)
3. `node --version` and `npm --version`
4. Full error output / stack trace
5. Exact commands run, clone → error
6. What you expected
7. Platform (macOS / Linux / Windows + WSL)

Find Captain on Discord and X: **@CaptainMentions** ·
[Open an issue](https://github.com/captainslab/captains-prediction-companion/issues)

## License

ISC
