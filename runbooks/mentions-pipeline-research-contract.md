# Mentions Pipeline — Research Contract & Operator Runbook (for Hermes)

This runbook defines how the repaired mentions pipeline is driven end to end
by an orchestrator (Hermes routing Codex for research collection and Kimi for
synthesis), for any date. Repaired 2026-06-10; applies to all future runs.

## Pipeline stages and commands

```bash
# 1. Discovery + scoring + packet generation (one pass, read-only):
node scripts/packets/generate-mentions-daily.mjs --date YYYY-MM-DD --window-days 0
#    --window-days 0  -> strictly that date (daily packet). Default is 7.
#    --dry-run        -> preview without writing audit files.
```

Discovery resolves the Mentions series set from `/series?category=Mentions`
and walks the full open-event list client-side (the Kalshi `/events` endpoint
silently ignores a `category` filter — never rely on it). Events are persisted
to `state/mentions/<date>/kalshi-events/*.json`.

## Research drop point (Codex via Hermes)

The composite scorer only scores contracts that have research artifacts.
Without them every contract is BLOCKED with `layers=0/N` by design.

Drop JSON files in `state/mentions/<date>/research/`. Two accepted shapes:

```jsonc
// per event
{ "event_ticker": "KX...-26JUN10",
  "markets": {
    "<market_ticker>": {
      "mention_profile": "earnings_mentions | political_mentions | sports_announcer_mentions",
      "layer_records": {
        "<layer_key>": { "present": true, "score": 0-100,
                          "source_basis": "...", "source_path": "https://...",
                          "detail": null }
      },
      "source_ladder": {
        "prior_transcript_word_match": { "status": "used|proxy|undercounted|blocked|missing" },
        "recent_direct_quote_match":  { "status": "...", "source_path": "..." },
        "current_event_context":      { "status": "used", "source_path": "..." },
        "prompt_likelihood":          { "status": "used" },
        "formal_document_proxy":      { "status": "used" },          // earnings only
        "qualification_risk":         { "status": "used", "detail": { "level": "confirmed|low|medium|high|unknown" } }
      }
    }
  }
}
// or per market: { "market_ticker": "...", "layer_records": {...}, ... }
```

Layer keys per profile live in `scripts/mentions/profiles/*.mjs`. Use ONLY the
profile that matches the event type — the scorer renormalizes weights over the
layers actually present. Pricing fields are forbidden in layer records and
source-ladder entries; the core throws if they appear. Qualification levels
cap posture (medium/unknown -> LEAN, high -> WATCH), so unverified event
premises must be recorded honestly.

Re-running the generator after dropping research re-scores everything: that is
the research -> re-score loop. Contracts without research stay BLOCKED, which
is correct output, not failure.

## Discovery fallback (Firecrawl via Hermes)

If the Kalshi API is unreachable or returns nothing for the date, the
generator falls back to reading `state/mentions/<date>/kalshi-events/*.json`.
An agent (e.g. Codex with Firecrawl scraping kalshi.com/calendar/mentions) can
write raw event JSON there — each file must carry `event_ticker` and a nested
`markets` array using Kalshi field names (`ticker`, `title`, `yes_sub_title`,
`custom_strike`, `rules_primary`, `close_time`, ...). The summary line prints
`persisted_fallback=true` when this path is used.

## Contract labels

Per-contract display text resolves in `buildStrikeDisplay()`
(`scripts/packets/lib/kalshi-discovery.mjs`): mention markets carry the phrase
in `custom_strike` as an object (e.g. `{ "Word": "Stargate" }`); display-text
keys (word/phrase/text/label/name/title) are trusted verbatim, including short
all-caps phrases like "MVP". Opaque-identifier keys (e.g. `baseball_team`
UUIDs) are ignored. Never derive labels from ticker suffixes.

## Model-routing audit (as of 2026-06-10)

* Hermes integration: `src/hermesRuntime.js` resolves an external CLI from
  `HERMES_COMMAND`/`HERMES_CLI`; the scoring loop itself is model-agnostic and
  consumes whatever research artifacts are dropped per the contract above.
* "Codex" / "Kimi" model routes: NOT configured anywhere in this repo. Routing
  is external to the repo (Hermes-side). Gap: per-market-type routing intent
  (Codex = collection w/ Firecrawl, Kimi = synthesis/drafting) is convention,
  not code. Remediation: configure the routes in the Hermes deployment and
  have each drop-point file record `produced_by` in `research_meta`.
* "Alpha Hunter" / "Market Hunter" research paths: NOT present in this repo
  (zero references). If they exist as Hermes-side Firecrawl workflows, they
  should write into the research drop point; until then evidence collection
  relies on whatever researcher fills the contract. Impact: without them,
  source discovery breadth is limited to manual/agent web research.
* Firecrawl: referenced by skills metadata only; not invoked by pipeline code.
  Supported indirectly via the two file drop points above.

## Output artifacts (per run)

`state/packets/<date>/mentions-daily/`:
* `<date>-<EVENT>.txt` (+ `.chunk-N.txt`) — sectioned decision board
* `<date>-<EVENT>.meta.json` — counts, postures, pricing-excluded flag
* `<date>-<EVENT>.inventory.txt` (+ `.meta.json`) — raw audit inventory (never
  in the packet body)
* optional `<date>-mentions-daily-article.txt` (+ `.meta.json`) — polished
  subscriber article (synthesis stage, Kimi role)

No trades, no orders, no execution endpoints anywhere in this pipeline.
