# Changelog

All notable changes to Captains Prediction Companion are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased] — decision-packet refactor + docs system (2026-05-31)

### Added
- Shared sectioned decision-packet renderer (`scripts/shared/decision-packet.mjs`): one row schema + board layout used by every market type (MLB, NASCAR, mentions/politics)
- Six-section packet body: TLDR BOARD → Top Edge → Watchlist/Trigger → Fades → Blocked/Needs Source → Audit Artifacts
- Audit-only raw inventory split: `buildInventoryArtifact()` keeps per-contract dumps out of the main board and in a separate `*.inventory.txt`
- Discord dry-run formatter (`scripts/shared/discord-format.mjs`): offline, 2000-char-safe splitting, secret scrubbing, raw-inventory refusal — no network, no token reads
- Deterministic docs updater (`scripts/docs/update-readme-updates.mjs`) + `npm run docs:update` / `docs:check`
- README auto-generated `CPC:UPDATES` and `CPC:STATUS` blocks (sourced from CHANGELOG + package.json)
- Documentation set: `docs/ARCHITECTURE.md`, `docs/USAGE.md`, `docs/PACKETS.md`, `docs/DISCORD.md`, `docs/SECURITY_PRIVACY.md`, `docs/AGENT_GUIDE.md`
- `cpc-repo-upgrader` reusable operator (`docs/operators/cpc-repo-upgrader/SKILL.md`)
- GitHub PR template and repo-upgrade issue template (`.github/`)

### Changed
- Decision packets are market-neutral: composite scoring half and market-price half are strictly separated; edge is model-fair vs market-implied only
- `fair_value` (sportsbook-derived) renamed to `market_reference_prob` to pin composite market-neutrality
- Packet generation routes through the active Hermes default model/provider/reasoning
- MLB, NASCAR, and mentions/politics packet boards refactored onto the shared sectioned renderer

### Tests
- Decision-packet shape, market-neutrality, and Discord dry-run guard suites added
- Full suite: 507/507 passing on `node --test`

### Known limitations
- Live Discord/webhook send is intentionally not implemented (dry-run only)
- MLB composite still depends on a stats source adapter for full-slate coverage (see `AGENTS.md` handoff)
- No live order placement or bankroll automation by design

### Backlog
- Wire stats-readonly adapter for full MLB slate composite coverage
- Optional check-only GitHub Action for `docs:check`
- Telegram/Discord live delivery behind explicit authorization

---

## [Unreleased] — public-alpha prep (2026-05-25)

### Added
- `scripts/setup.mjs` — first-run bootstrap: copies `.env.example` → `.env`, creates `data/`
- `scripts/doctor.mjs` — config, deps, Hermes CLI, and live server health check in one command
- `scripts/demo.mjs` — boots the server, hits key endpoints, exits clean
- `npm run setup / doctor / demo` wired into `package.json`
- `.skills/` directory with 5 skill files covering Telegram notifier and sport pipeline patterns
- `CONTRIBUTING.md` — fork-first contribution guide; contact via `@CaptainMentions`
- `.env.example` expanded to cover every runtime variable with inline annotations

### Changed
- README complete rewrite: quickstart, full env-var table, troubleshooting section, "build on this" guide
- `AGENTS.md` extended with CPC agent identity, skill inventory, and no-touch zones
- `src/captainLabsStore.js` seed user anonymized (was a real name, now `Demo User`)
- `test/ufc-cron-packet.test.mjs` hardcoded absolute path replaced with dynamic `import.meta`
- `.gitignore` — `logs/` added, paste artifacts removed

---

## [0.10.0] — NASCAR Coca-Cola 600 prediction engine (2026-05-23 – 2026-05-24)

### Added
- Full NASCAR prediction pipeline for the Coca-Cola 600 (`scripts/nascar/`)
- Wikipedia snapshot source adapter with practice/qualifying data
- Multi-lane ceiling board: win / top-5 / top-10 / top-20 lanes per driver
- Per-driver evidence ledger with reasoning-backed ceiling scores
- Season speed signal row: stage points + most-laps-led (2026 ledger)
- `#33 lockout` rule and `rules_set` grid-weight cut applied to active field pool
- Fundamentals gating: PICK requires 3+ layers, EVIDENCE_LEAN requires 2+; pit crew is non-critical

### Changed
- Candidate pool expanded from Cup-points top-20 to full active field (all starters)
- 4-lane ceiling board collapsed into a single final ceiling per driver
- Weighted fundamentals gate: pit crew lane can reach LEAN/EVIDENCE_LEAN independently

---

## [0.9.0] — MLB & UFC cron packet workflows (2026-05-18 – 2026-05-23)

### Added
- MLB cron packet workflow: lineup-block pre-lock report, scheduled packet generators
- Phase A market-internal pick engine: de-vig + ladder consistency, soft-LEAN ML tier
- MLB daily article publisher: one article per game + a comprehensive slate article with TLDR
- MLB execution board: correlation grouping, primary-pick selector, combo visibility, lane diagnostics
- `PRE_LINEUP_PICK` classification tier for pre-lineup markets
- UFC weekly cron packet guardrails
- Verified UFC Allen vs Costa execution board
- Poisson CDF fix for MLB total scoring

### Fixed
- MLB lineup block packet text now written correctly
- MLB fundamentals-first packet renderer scope audit
- MLB combo classification safety
- Kalshi event/market normalization in packet pipeline
- Research data primed before packet generation

---

## [0.8.0] — Politics prediction swarm (2026-05-21 – 2026-05-22)

### Added
- 5-phase politics prediction swarm (`scripts/politics-swarm/`)
  - Phase 1: research-only swarm, first KXNEXTAG-29 report
  - Phase 2: live Kalshi fetch, branch dispatch, schema validation, replay mode, Grok routing
  - Phase 3: Judgment branch + operator dispatch flow
  - Phase 4: cross-branch integrity check + replay hydration
  - Phase 5: pluggable branch executor + execute mode
- Market decision process guardrails doc

---

## [0.7.0] — NASCAR dry-run workspace (2026-05-17)

### Added
- NASCAR dry-run workspace: `Stage 1` router → `Stage 2` source adapters → `Stage 3` discovery composer → ceiling board → output writer
- Runbook planning foundation: lanes, top-20 default pool, FIELD bucket, `special_event_override`
- Driver ceiling output model spec
- One-command dry-run entry point

---

## [0.6.0] — MLB workspace + mentions pipeline (2026-05-09 – 2026-05-16)

### Added
- MLB workspace dry-run adapters and full output pipeline
- CaptainMentions master system prompt and upgraded formatter SOUL
- 4-quarter transcript matching + mandatory context search for all mentions
- Scraper fallback stack: Jina → Crawl4AI → trafilatura → html2text
- Verified hit rate table added to article SOURCES section
- Sports prediction pipeline spec and agents; politics pipeline merged in
- CLI prediction guide and WorldMonitor integration doc
- MMA MVP Netflix guide
- MLB execution board: readability and actionability improvements
- MLB combo visibility and lane diagnostics

### Changed
- HOW-TO-PREDICT rewritten as an executable plug-and-play playbook

### Fixed
- MLB total scoring with Poisson CDF
- MLB combo classification safety
- `.gitignore` cleanup; runtime artifact files ignored

---

## [0.5.0] — Hermes Gemini provider + oracle agents (2026-04-22 – 2026-04-24)

### Added
- Oracle prediction markets agent
- Researcher agent upgraded for evidence-first market research
- Hermes Gemini provider as the default alpha transport
- Calendar-based seed loader with env fallback
- Pipeline service and production run routes
- `/pipeline/outputs/latest` endpoint for the latest stored board record
- Operator workspace and end-to-end Kalshi MCP tool test
- VPS deployment docs and systemd + Nginx service examples for captainlabs.io
- Cached market sources and pipeline outputs endpoint

### Changed
- Model defaults made provider-neutral; `HERMES_PROVIDER` env var controls the backend
- Hermes research prompts tightened; official source packets wired
- Same-origin Nginx API proxy fixed

---

## [0.4.0] — GitHub Actions CI + Copilot setup (2026-04-07 – 2026-04-09)

### Added
- Claude Code Review workflow (GitHub Actions)
- Claude PR Assistant workflow (GitHub Actions)
- Copilot setup steps workflow
- Copilot instructions at repo level
- Auto-assign new issues to Copilot coding agent

---

## [0.3.0] — Repo identity, dashboard, and pipeline architecture (2026-04-01 – 2026-04-08)

### Added
- Dashboard UI wired at `GET /` with a clean landing page
- ARCHITECTURE.md with V1 architecture specs
- MENTIONSAPP.md pipeline spec
- Deployment workflow doc

### Changed
- Stale repo identity files replaced with current CaptainLabs identity
- CLAUDE.md updated with universal routing rule and V1 architecture map
- Alphapoly trading bot content removed; Claude tooling cleaned up

---

## [0.2.0] — Market pipeline, mention board, and alpha stage (2026-03-27)

### Added
- Mention board runner with two-sided ranking
- App runner registration and `run_market.py` CLI entry point
- Companion router, event-type app registry, and alpha pipeline stubs
- OpenRouter alpha stage for mention contracts
- Phone-safe companion market page
- Deterministic MCP market card view
- Event market user-facing card enriched from Kalshi API
- Dedicated Kalshi URL analysis tool
- Shared alpha agent, scrapers, and mentions runtime support

### Fixed
- Kalshi mention boards classified from event metadata correctly
- Politics mention boards classified as speech events
- Alpha edge required before directional calls (no-edge mention cards clarified)
- Kalshi URL auto-focus and contract selection stabilized
- Event market app responses forced through tool output

---

## [0.1.0] — Initial release (2026-03-27)

### Added
- Captains Prediction Companion starter: Node.js MCP server accepting Kalshi market URLs
- Prediction card output: fair value, edge, confidence, reasoning
- MCP transport at `POST /mcp` for ChatGPT and compatible clients
- OpenRouter provider defaults normalized
