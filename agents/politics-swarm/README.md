# politics-swarm

Reusable research swarm for politics / personnel-appointment prediction markets
(e.g. Kalshi "Trump's next Attorney General"). Sits alongside the existing
`politicsApp` pipeline (`politicsAppRouter`, `electionsAlphaEngine`, etc.) but
is *research-only* — it produces a structured proof-based report. It does
**not** size bets, place trades, post, or recommend action.

Companion to `docs/politics-market-swarm.md` (workflow spec) and
`scripts/politics/research-market.mjs` (orchestrator).

## Branches

Each branch is run as an isolated subagent with a hard scope boundary. The
branch output is a JSON blob in the contract described in
`scripts/politics/lib/report-render.mjs`.

| # | Branch                          | Scope                                                | Disallowed                                       | Proof output                                                   |
|---|---------------------------------|------------------------------------------------------|--------------------------------------------------|----------------------------------------------------------------|
| 1 | settlement-rules-analyst        | Kalshi rules / settlement text only                  | Political prediction, candidate likelihood       | Quoted rule text, ambiguity list, acting/interim treatment     |
| 2 | official-evidence-researcher    | Official + on-record reporting only                  | X chatter, anonymous claims, vibes               | Dated facts w/ source URL, verified vs unverified split        |
| 3 | x-signal-analyst                | X Search / xAI live discussion                       | Treating X as fact, picking winners              | Top narratives, source-quality tier, repeated-rumor flags      |
| 4 | market-structure-analyst        | Kalshi prices, volume, OI, movement                  | Calling price "truth"                            | Current board, movement notes, price-only limitations          |
| 5 | political-plausibility-analyst  | Process logic, faction map, precedent                | Treating inference as fact (must label INFER)    | Strengths / weaknesses / process obstacles per candidate       |
| 6 | skeptic-red-team                | Attack the favorite, find traps                      | Inventing alt fan-fiction                        | Disconfirming evidence, narrative + settlement traps           |
| 7 | aggregator-judge                | Merge, dedupe, separate fact vs inference            | Adding new claims not present in branch outputs  | Final report (sections 1-9)                                    |

## Source hierarchy (top wins)

1. Kalshi market rules / settlement language
2. Official government / DOJ / White House / Senate
3. Direct on-record statements
4. High-quality reporting
5. Political plausibility analysis
6. Market structure and price movement
7. X Search / social chatter

## Hard rules

- No trade recommendation.
- No bankroll sizing.
- No posting (X, Telegram, anywhere).
- No treating X chatter as fact.
- No "price says X therefore X" reasoning.
- Verified facts, market signal, X chatter, inference, and unknowns must be
  visually separated in the final report.
