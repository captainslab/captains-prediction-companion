# Politics swarm — `bin/` bridges

The branch executor (`scripts/politics/lib/branch-runner.mjs`) ships three
adapters. `cmdAdapter` shells out per branch, pipes the prompt envelope into
the command on stdin, and parses one JSON object from stdout. This directory
holds the operator-facing bridge scripts that adapter can run.

## `hermes-bridge.sh`

A thin POSIX-ish bash bridge. Reads the prompt from stdin, reads context from
env, prints exactly one JSON object to stdout, and logs everything else to
stderr. Non-zero exit surfaces in `meta.branchExecution[]` as `status: 'failed'`.

### Env vars

Set by `cmdAdapter`:

- `POLITICS_BRANCH`       — `official` | `xSignal` | `plausibility` | `skeptic` | `judgment`
- `POLITICS_MODEL`        — `inherit` or `grok` (already resolved by the runner's fallback)
- `POLITICS_INPUTS_ONLY`  — `1` for judgment, `0` otherwise

Set by the operator:

- `POLITICS_BRIDGE_MODE`  — `dry-run` (default) | `inherit` | `grok` | `auto`
  - `dry-run`: emits a deterministic, branch-contract-valid stub. No network,
    no LLM, no credentials touched. This is the proof path used by tests and
    by the one-command execute recipe below.
  - `inherit`: routes to a local Hermes `delegate` CLI subcommand if present.
    Phase 6 ships this route stubbed — it fails loudly with a non-zero exit
    so cmdAdapter records `failed`, rather than silently inventing data.
  - `grok`: routes to xAI/Grok if `XAI_API_KEY` (or `GROK_API_KEY` /
    `HERMES_XAI_KEY`) is set. Also stubbed in Phase 6 — credential is
    detected but **never read or transmitted**. Fails loudly.
  - `auto`: picks `grok` when `POLITICS_MODEL=grok`, otherwise `inherit`.

### One-command execute recipe (dry-run)

```sh
node scripts/politics/research-market.mjs \
  --market KXNEXTAG-29 \
  --url 'https://kalshi.com/markets/kxnextag/next-ag/KXNEXTAG-29' \
  --mode execute \
  --executor cmd \
  --executor-cmd "POLITICS_BRIDGE_MODE=dry-run scripts/politics/bin/hermes-bridge.sh" \
  --cache-dir state/politics/<date>/kxnextag-29.cache \
  --offline \
  --out state/politics/<date>/kxnextag-29.md
```

All Phase 1-5 guardrails remain active: integrity check, forbidden-language
scan, replay parity (`branches/*.json` written into the cache dir), and
`meta.branchExecution[]` reporting per-branch `ok|repaired|failed|timeout|
fallback-routed` status.

### Why dry-run is the proof path

Phase 6 intentionally does not invoke any paid LLM or Hermes subagent during
the proof run. The bridge's job is to prove the wiring: stdin→prompt,
env→routing, stdout→one JSON object, stderr→logs, exit code→failure
surfacing. Real `inherit`/`grok` routes are the Phase 7 surface.
