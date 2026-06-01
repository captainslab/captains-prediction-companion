# Usage

Every command you need to run CPC, copy-paste ready. All packet generators are
**read-only and place no trades.**

## First-time setup

```bash
git clone https://github.com/captainslab/captains-prediction-companion.git
cd captains-prediction-companion
npm run setup          # copies .env.example -> .env, creates data/
# Edit .env — set GEMINI_API_KEY at minimum
npm install
npm run doctor         # verify config, deps, Hermes CLI, server health
```

## Run the server

```bash
npm start              # start the MCP + dashboard server (default :3000)
npm run dev            # same, with --watch auto-restart
npm run demo           # boot, hit key endpoints, exit clean
```

Endpoints:

| Endpoint | Purpose |
|---|---|
| `GET /` | Browser dashboard |
| `GET /health`, `GET /healthz` | Health check JSON |
| `POST /mcp` | MCP transport (ChatGPT / compatible clients) |
| `GET /pipeline/status` | Pipeline status |
| `GET /pipeline/outputs/latest` | Latest stored board record |

## Generate decision packets

Each generator builds a full board for its market class. Add `--dry-run` to
render to stdout without writing state.

```bash
# MLB — moneyline + HR + K lanes
node scripts/packets/generate-mlb-daily.mjs --dry-run
node scripts/packets/generate-mlb-daily.mjs --date 2026-05-31

# NASCAR — multi-lane ceiling board (race days)
node scripts/packets/generate-nascar-sunday.mjs --dry-run

# Mentions / politics — exact-string proof markets
node scripts/packets/generate-mentions-daily.mjs --dry-run

# UFC — weekly; skips cleanly when no event
node scripts/packets/generate-ufc-weekly.mjs --dry-run
```

### Generator flags

| Flag | Meaning |
|---|---|
| `--date YYYY-MM-DD` | Target date (defaults to today, UTC) |
| `--dry-run` | Render to stdout, write nothing to `state/` |
| `--state-root <dir>` | Override the `state` root (useful for tests) |
| `--help`, `-h` | Usage |

### Where output lands

Without `--dry-run`, a generator writes under
`state/packets/<YYYY-MM-DD>/<type>/`:

| File | Contents |
|---|---|
| `<base>.txt` | The rendered decision board (the thing you read) |
| `<base>.meta.json` | char count, chunk count, `no_trades_placed: true`, timestamps |
| `<base>.chunk-N.txt` | Telegram-safe parts when the board is long |
| `<base>.inventory.txt` | Raw per-contract audit dump (**never** in the board) |

Inspect the latest packet path:

```bash
ls -t state/packets/*/*/*.txt | head -1
cat "$(ls -t state/packets/*/*/*.txt | head -1)"
```

Inspect the audit inventory:

```bash
ls -t state/packets/*/*/*.inventory.txt | head -1
```

## Keep docs in sync

```bash
npm run docs:update    # rewrite ONLY the marked README blocks
npm run docs:check     # CI-safe: exit 1 if README is stale, print fix command
```

`docs:update` regenerates the `CPC:UPDATES` / `CPC:STATUS` blocks from
`CHANGELOG.md` + `package.json`. It never touches any other README text and never
reads secrets or the network.

## Run the tests

```bash
npm test                                          # full suite (node:test)

# Targeted runs
node --test test/decision-packet-shape.test.mjs       # row schema + board
node --test test/discord-format.test.mjs              # Discord dry-run guards
node --test test/mlb-composite-neutrality.test.mjs    # market-neutrality lock
node --test test/mlb-decision-board.test.mjs
node --test test/nascar-decision-board.test.mjs
node --test test/mentions-decision-board.test.mjs
```

## Discord dry-run formatter

The formatter is offline (no network, no tokens). Use it programmatically:

```js
import { buildDiscordPost } from './scripts/shared/discord-format.mjs';

const { parts, channel, redactions, partCount } = buildDiscordPost({
  packetText,                 // a rendered sectioned board (NOT raw inventory)
  title: 'CPC MLB — 2026-05-31',
  channel: '#cpc-mlb',
  artifactPaths: ['state/packets/2026-05-31/mlb-daily/board.inventory.txt'],
});
```

It splits at the 2000-char Discord limit, scrubs secret-looking tokens, links
audit artifacts as paths only, and throws if handed a raw inventory dump. See
[DISCORD.md](./DISCORD.md).

## Extend a new market type

1. **Score** your contracts into a composite half:
   ```js
   const composite = {
     score, posture,                 // e.g. 'STRONG EVIDENCE LEAN'
     layersPresent, layersTotal,
     topEvidenceLayers, missingLayers,
     modelProbability,               // optional numeric fair prob
   };
   ```
2. **Build rows** — pass market price in the `market` half ONLY:
   ```js
   import { buildDecisionRow } from '../shared/decision-packet.mjs';
   const row = buildDecisionRow({
     marketTicker, sideTarget, marketType, settlementSummary,
     composite,
     market: { yes_bid, yes_ask, last_price, volume, open_interest },
     fair: { probability }, // or { low, high }
   });
   ```
3. **Render** the board and **split** the audit inventory:
   ```js
   import { renderSectionedPacket, buildInventoryArtifact } from '../shared/decision-packet.mjs';
   const board = renderSectionedPacket(rows, { auditArtifacts: [inventoryPath] });
   const inventory = buildInventoryArtifact({ marketType, date, eventTicker, inventoryLines });
   ```
4. Add a generator under `scripts/packets/` and a test under `test/`.

## Branch / push / PR workflow

```bash
git checkout -b feat/<topic>
# ... make changes ...
npm test
npm run docs:check
git diff --stat
git status --short

git add <explicit files>            # never `git add -A`
git commit -m "feat: <summary>"
# Push only when explicitly instructed:
# git push origin feat/<topic>
```

Open a PR using `.github/pull_request_template.md`.
