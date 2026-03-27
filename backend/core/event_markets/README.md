# Event-market research pipeline

This package generalizes the research process across event markets.

The default usable flow is:

1. Market first: inspect the venue contract, resolution rules, prices, and depth
2. Perplexity second: discover the authoritative outside source
3. Scraper third: extract the exact evidence from the page or transcript
4. Decision layer last: convert evidence into probability, EV, and stake

The source stack defaults to:

- `Kalshi` or the market venue
- `Perplexity`
- `Playwright Scraper Skill`

The goal is cost control and usability:

- avoid paying for many specialized APIs
- use the market venue for pricing
- use Perplexity for source discovery
- use the scraper skill for public evidence extraction

Domain labels are normalized into a small taxonomy:

- `sports`
- `politics`
- `macro`
- `earnings`
- `mention`
- `general`

The reusable plan builder is `core.event_markets.pipeline.build_event_market_pipeline`.

The API exposes the same plan through `POST /pipeline/event-markets/plan` so the
frontend or a future ChatGPT app can request the standardized research flow
without re-implementing the source order logic.

OpenRouter is the primary LLM API for implication extraction and validation in
the production pipeline. If the per-step model env vars are not set, the app
falls back to the OpenRouter free router (`openrouter/free`) for both steps.

The API response is split into:

- `user_facing`: the compact card safe to render directly in the app UI
- `hidden.plan`: the reusable source-order and stage plan
- `hidden.workflow`: the explicit research stages and their inputs/outputs
- `hidden.output_contract`: the standardized visible JSON shape expected from the research and pricing layer
