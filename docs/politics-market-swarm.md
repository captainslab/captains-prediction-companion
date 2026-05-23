# Politics-Market Research Swarm

Research-only workflow for politics / personnel-appointment markets. Produces
a structured proof-based report. Does **not** size, trade, post, or recommend.

Test market for the first run:
`https://kalshi.com/markets/kxnextag/next-ag/KXNEXTAG-29`

## Entry point (Phase 2 — end-to-end)

```
node scripts/politics/research-market.mjs \
  --market KXNEXTAG-29 \
  --url    https://kalshi.com/markets/kxnextag/next-ag/KXNEXTAG-29 \
  --out    state/politics/<YYYY-MM-DD>/<market>.md \
  --cache-dir       state/politics/<YYYY-MM-DD>/<market>.cache \
  --branches-dir    state/politics/<YYYY-MM-DD>/<market>.cache/branches \
  --mode            live          # live | replay | envelopes-only
  --model-xsignal   grok          # optional: route X-Signal branch via Grok/xAI
  --model-skeptic   grok          # optional: route Skeptic branch via Grok/xAI
  [--offline]                     # reuse cache/fetch.json instead of network
```

What the orchestrator does:

1. Fetches `https://api.elections.kalshi.com/trade-api/v2/markets?event_ticker=<id>`
   and caches the raw payload to `<cache>/fetch.json`.
2. Auto-builds `market`, `settlement` (with acting/interim language), and
   `marketStructure` (board, OI, 24h vol) from the live response.
3. Writes `<cache>/envelopes.json` — one prompt envelope per non-auto-built
   branch (official, xSignal, plausibility, skeptic) with `model:` annotation
   so an operator/cron can dispatch them through the chosen provider.
4. Loads any branch JSON files present in `--branches-dir`
   (`official.json`, `xSignal.json`, `plausibility.json`, `skeptic.json`,
   optionally `judgment.json`) and merges them with the auto-built sections.
5. Validates the merged structure against `branch-contract.mjs`. One repair
   attempt is made; if it still fails, the orchestrator exits with code 3 and
   the report is NOT written.
6. Renders the report via the same pure renderer as Phase 1.
7. Runs a forbidden-language scan against the rendered markdown
   (`buy YES`, `place a trade`, `recommend buy/sell`, prescriptive bankroll
   sizing, X/Telegram posting). Disclaimer language is allowed. Exits code 5 on hit.
8. Writes the report and `<cache>/branches.merged.json` (for replay).

Exit codes: 0 ok, 2 bad args, 3 schema failure, 4 Kalshi blocker, 5 forbidden-language hit.

## Replay mode

```
node scripts/politics/research-market.mjs --market KXNEXTAG-29 \
  --mode replay --branches-dir <cache>/branches --out <out>.md
```

No network. Regenerates the report from cached branch JSONs and the previously
fetched market — useful for iterating on prompts or re-rendering after a fix
to `report-render.mjs` without burning API calls.

`--branches-json` (legacy single-file path) is still supported for back-compat.

## Branch JSON contract

`branches.json` is one object with these top-level keys (any missing key falls
back to a placeholder, never crashes):

```jsonc
{
  "market": {
    "id": "KXNEXTAG-29",
    "url": "https://kalshi.com/markets/kxnextag/next-ag/KXNEXTAG-29",
    "title": "Trump's next Attorney General",
    "asOf": "2026-05-21T00:00:00Z"
  },
  "settlement":    { "rules": "...", "ambiguities": ["..."], "actingInterim": "..." },
  "official":      { "facts":   [{ "date": "...", "claim": "...", "source": "...", "verified": true }] },
  "xSignal":       { "narratives": [{ "claim": "...", "tier": "rumor|reporter|official", "repeated": false }] },
  "marketStructure": {
    "board":     [{ "candidate": "Todd Blanche", "yesCents": 0, "noCents": 0, "vol": null, "oi": null }],
    "movement":  "...",
    "limitations": "..."
  },
  "plausibility": { "candidates": [{ "name": "...", "strengths": ["..."], "weaknesses": ["..."], "obstacles": ["..."] }] },
  "skeptic":      { "favoriteWrongReason": "...", "underpricedReason": "...", "settlementTraps": ["..."], "narrativeTraps": ["..."] },
  "judgment":     {
    "probabilityRange": null,
    "confidence":       "low|medium|high",
    "wouldChangeView":  ["..."],
    "monitorNext":      ["..."]
  },
  "meta": {
    "xSearchAvailable": true,
    "xSearchUsed":      true,
    "notChecked":       ["..."]
  }
}
```

## Report sections (fixed order)

1. TLDR — leader, best non-price reason, biggest uncertainty, confidence, no-trade disclaimer
2. Settlement Rules — what counts, what doesn't, acting/interim, ambiguities
3. Candidate Board — Blanche, Zeldin, Pirro, others
4. Official Evidence — verified facts only, with sources
5. X Signal — narratives w/ tier, rumor vs verified
6. Market Structure — prices, vol/OI, movement, why price alone is insufficient
7. Political Plausibility — strengths / weaknesses / obstacles per candidate
8. Skeptic Review — strongest reasons favorite is wrong, traps
9. Final Research Judgment — probability range (if supported), confidence,
   what would change view, what to monitor, **no trade recommendation**

## Constraints

- No trades, no sizing, no posting.
- X is signal only, never truth.
- Price alone is never the pick.
- One exploration round, then converge.
- Reusable files on disk; do not rely on session memory.
- Inference must be labeled `(INFER)`. Unknown must be labeled `(UNKNOWN)`.

## Re-running

```
node scripts/politics/research-market.mjs --market KXNEXTAG-29 \
  --url https://kalshi.com/markets/kxnextag/next-ag/KXNEXTAG-29 \
  --branches-json state/politics/2026-05-21/kxnextag-29.branches.json \
  --out          state/politics/2026-05-21/kxnextag-29.md
```

The renderer is pure: same `branches.json` ⇒ same report bytes. Tested in
`test/politics-market-swarm.test.mjs`.

## Phase 3: Judgment branch + operator dispatch flow

The orchestrator now writes a dedicated **judgment** envelope after merging the
research branches. The judgment branch reads ONLY the merged JSON — it cannot
introduce new facts, sources, prices, or candidates. It produces
`judgment.json` with: `strongestSignal`, `strongestCounter`,
`biggestSettlementAmbiguity`, `biggestUncertainty`, `confidence`,
`watchlistTriggers`, `wouldChangeView`, `citations`. These populate TLDR
and section 9 of the rendered report instead of `(UNKNOWN — branch not run)`.

### Model routing (Phase 3 default)

Main implementation/controller stays on the inherited Opus session. Only the
**xSignal** and **skeptic** branches default to `grok` routing because they
benefit from live X / contrarian search. If Grok routing is unavailable, the
operator falls back to the inherited provider and the branch metadata records
the fallback. Phase 3 does not block on Grok availability.

### Operator command flow

```
# 1. Generate live fetch + auto branches + envelopes + judgment-envelope.
DATE=$(date -u +%F)
CACHE=state/politics/$DATE/kxnextag-29.cache
node scripts/politics/research-market.mjs \
  --market KXNEXTAG-29 \
  --url    https://kalshi.com/markets/kxnextag/next-ag/KXNEXTAG-29 \
  --cache-dir $CACHE \
  --out       state/politics/$DATE/kxnextag-29.md

# 2. Dispatch each research branch via Hermes delegate_task (or any operator/
#    cron runner). Each subagent reads $CACHE/envelopes.json[i].prompt and
#    writes its output JSON to $CACHE/branches/<branch>.json.
#    The judgment branch reads $CACHE/judgment-envelope.json and writes
#    $CACHE/branches/judgment.json AFTER the research branches complete.

# 3. Replay/re-render the final report from the populated branch cache.
node scripts/politics/research-market.mjs \
  --market KXNEXTAG-29 \
  --url    https://kalshi.com/markets/kxnextag/next-ag/KXNEXTAG-29 \
  --branches-dir $CACHE/branches \
  --cache-dir    $CACHE \
  --out          state/politics/$DATE/kxnextag-29.md \
  --offline
```

`loadBranchesDir` auto-unwraps top-level keys that match the branch name, so a
judgment JSON of the form `{ "judgment": { ... } }` is accepted as written by
the prompt spec.

### Exit codes

- 0 ok
- 2 bad args
- 3 schema failure (after one repair attempt)
- 4 Kalshi blocker
- 5 forbidden-language hit in the rendered report (prescriptive trade/sizing/
  posting language)

### Guardrails preserved

- No trade recommendation, no sizing, no posting.
- X chatter stays labeled as signal; never promoted to fact.
- Judgment cannot introduce facts not already in merged JSON.
- Forbidden-language scan runs on every rendered report; failure exits 5.


## Phase 4: cross-branch integrity check

`scripts/politics/lib/integrity-check.mjs` runs after schema validation and
before render. It enforces invariants that schema validation alone cannot:

Errors (exit 6):
- `judgment.citations[*].branch` must name a real branch and that branch must
  exist non-empty in the merged JSON. The judgment cannot cite a branch that
  was never produced.

Warnings (rendered into the report's Meta section under "Integrity warnings",
also echoed to stderr; never block render):
- `official.facts[*].source` that classifies as `X_SOCIAL` — surfaces X
  chatter that snuck into the official branch instead of xSignal.
- `official.facts[*]` with `verified: true` but `UNKNOWN`-tier source —
  forces the operator to either verify with a tier-1 source or downgrade.

Replay mode also rehydrates `settlement` + `marketStructure` from
`cache/fetch.json` when present, so judgment citations to those branches
remain valid across re-renders.


## Phase 5: one-command branch executor

`--mode execute` runs all branches end-to-end through a pluggable adapter.

### Adapters

`scripts/politics/lib/branch-runner.mjs` ships three adapters:

- `fakeAdapter(handlers, { canRoute })` — in-process map; used by tests.
- `cacheAdapter(branchesDir)` — reads pre-existing `branches/*.json` from disk.
  Lets the executor replay an operator-dispatched run end-to-end with zero
  network or LLM cost. Always returns `canRouteTo() === true`.
- `cmdAdapter(cmd, { canRoute })` — shells out to `cmd` per branch. Prompt is
  piped on stdin; the command must emit a JSON branch payload on stdout.
  `POLITICS_BRANCH`, `POLITICS_MODEL`, and `POLITICS_INPUTS_ONLY` are set in env
  so the wrapper can route to Hermes `delegate_task`, an OpenRouter call, or
  any other LLM runtime without changing this file.

### CLI

    node scripts/politics/research-market.mjs \
      --market KXNEXTAG-29 \
      --url 'https://kalshi.com/markets/kxnextag/next-ag/KXNEXTAG-29' \
      --mode execute \
      --executor cache \
      --executor-branches-dir state/politics/<date>/<mkt>.cache/branches \
      --cache-dir state/politics/<date>/<mkt>.cache \
      --offline \
      --out state/politics/<date>/<mkt>.md

For the `cmd` executor:

    --executor cmd \
    --executor-cmd 'path/to/my-hermes-bridge.sh' \
    --executor-can-route grok \
    --concurrency 4 --timeout-ms 90000

### Status records

Per-branch results land in `merged.meta.branchExecution[]`:

    { branch, status, model, requestedModel, ms, error?, repairUsed?, note? }

`status` is one of: `ok`, `repaired`, `failed`, `timeout`, `fallback-routed`.
`fallback-routed` is recorded as an additional record alongside the actual
ok/repaired record for that branch — the runner emits it first so the
downgrade is visible in the meta even when the branch ultimately succeeds.

### Ordering guarantee

Research branches (`official`, `xSignal`, `plausibility`, `skeptic`) run in
parallel up to `concurrency`. Judgment is only dispatched **after** all four
research branches resolve with a non-null value — otherwise the judgment
envelope is skipped, and Phase 4 integrity will catch any dangling citations.

### Robustness

Each branch output is parsed as JSON with one repair retry: triple-backtick
fences are stripped, and the outermost `{...}`/`[...]` is salvaged. A repaired
parse surfaces as `status: 'repaired'` (not silent).

### Replay parity

When `--cache-dir` is set, execute mode writes `branches/<key>.json` into
`cacheDir/branches/`. A subsequent `--mode replay --branches-dir <that dir>`
reproduces the report bit-for-bit (minus `asOf` timestamps), so an executed
run is always re-runnable without re-dispatching the LLM.

### Guardrails

All Phase 1-4 guardrails remain active in execute mode: no trades, no sizing,
no posting, X chatter is signal only, price alone is never a pick, cross-branch
integrity check runs before render, and the forbidden-language scan runs on
the rendered markdown.


## Phase 6: real Hermes/Grok bridge

`scripts/politics/bin/hermes-bridge.sh` is the thin, dependency-free bridge
that `cmdAdapter` shells out to. It honors the cmdAdapter contract exactly:
stdin = prompt envelope, stdout = exactly one JSON object, stderr = logs,
non-zero exit = `status: 'failed'` in `meta.branchExecution[]`.

### Modes

Set `POLITICS_BRIDGE_MODE`:

- `dry-run` (default) — deterministic, branch-contract-valid stub JSON for
  every branch. No network. No LLM. No credentials touched. This is the
  proof path used by tests and CI.
- `inherit` — routes to a local Hermes `delegate` CLI subcommand if present.
  Phase 6 ships this stubbed; if invoked it fails loudly with a non-zero
  exit instead of inventing data.
- `grok` — routes to xAI/Grok if `XAI_API_KEY` / `GROK_API_KEY` /
  `HERMES_XAI_KEY` is set. Credential is detected by presence only and is
  **never read or transmitted** in Phase 6 — the route fails loudly so
  cmdAdapter records `failed`.
- `auto` — picks `grok` when `POLITICS_MODEL=grok`, else `inherit`.

### One-command execute via bridge (dry-run)

    node scripts/politics/research-market.mjs \
      --market KXNEXTAG-29 \
      --url 'https://kalshi.com/markets/kxnextag/next-ag/KXNEXTAG-29' \
      --mode execute \
      --executor cmd \
      --executor-cmd "POLITICS_BRIDGE_MODE=dry-run scripts/politics/bin/hermes-bridge.sh" \
      --cache-dir state/politics/<date>/<mkt>.cache \
      --offline \
      --out state/politics/<date>/<mkt>.md

### Guardrails preserved

All Phase 1-5 guardrails stay live in bridge runs: integrity check,
forbidden-language scan, source-tier separation, replay parity (the runner
still writes `branches/*.json` into `cacheDir/branches/`), and full
`meta.branchExecution[]` per-branch status reporting.

See `scripts/politics/bin/README.md` for env vars and operator details.
