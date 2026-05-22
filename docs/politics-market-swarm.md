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

