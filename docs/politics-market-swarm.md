# Politics-Market Research Swarm

Research-only workflow for politics / personnel-appointment markets. Produces
a structured proof-based report. Does **not** size, trade, post, or recommend.

Test market for the first run:
`https://kalshi.com/markets/kxnextag/next-ag/KXNEXTAG-29`

## Entry point

```
node scripts/politics/research-market.mjs \
  --market KXNEXTAG-29 \
  --url    https://kalshi.com/markets/kxnextag/next-ag/KXNEXTAG-29 \
  --out    state/politics/<YYYY-MM-DD>/<market>.md \
  [--branches-json path/to/branches.json]
```

`--branches-json` supplies the merged subagent outputs (the contract is
described below). When omitted, the script renders a scaffold report with
TODO placeholders so an operator can fill the branches in by hand or via a
follow-up subagent fan-out — the renderer is the same in either path, which
is what the tests pin.

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
