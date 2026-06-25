# CPC Output Language Standard

Customer-facing CPC packets and cards should read like a private research assistant, not a betting sheet, model audit, or trade prompt.

## Required Shape

Cards and stack rows should lead with:

- Big title: plain-English word, team, side, or outcome.
- Subtitle: plain-English market meaning.
- Plain English: one sentence explaining what the contract, game, or card asks.
- Settlement: one sentence explaining what must happen for YES, where applicable.
- Route: CPC route or family.
- CPC Read: neutral model-rating language, not raw internal enums.
- Evidence status: `complete`, `thin`, `provisional`, `blocked`, or `unavailable`.
- Base rate: sample size, hit rate, and tier when available.
- Price context: display-only and not used in CPC scoring.
- Ticker/market ID: present, but secondary.

Stack rows should also include:

- Rank or priority.
- Reason.
- Price context line.

## Banned Customer-Facing Phrases

Do not emit these phrases in customer-facing packet/card output:

- `EVIDENCE LEAN`
- `lean`
- `leans`
- `LEAN`
- `projected lean`
- `non-market evidence only`
- `Side / market`
- `Market board`
- `Call:`
- `NO CLEAR PICK`
- `cover probability`
- `betting edge`
- `wager`
- `bankroll`
- `stake`
- `pick`
- `fade`
- `best bet`
- raw ticker or team abbreviation as the headline when a human-readable name exists

Tests may contain these strings only when proving they are rejected or replaced. Internal enum names may still exist in scoring code, but renderers must translate them before customer output.

## Approved Language

Use:

- `CPC Read`
- `Model Read`
- `Research view`
- `Primary side`
- `rates higher`
- `grades stronger`
- `top-rated model side`
- `higher-rated term`
- `monitor only`
- `blocked — missing required evidence`
- `no rated view`
- `lower-rated by CPC`
- `Price context: display-only and not used in scoring`
- `Evidence status`
- `What this means`
- `Why it matters`

## Examples

Bad:

```text
New York Yankees at Boston Red Sox — EVIDENCE LEAN NYY
Call: EVIDENCE LEAN — NYY.
Side / market: NYY (non-market evidence only).
Why: non-market evidence and the projection model point the same way.
Market board: available for display-only audit.
```
Good:

```text
Yankees at Red Sox — CPC rates Yankees higher
CPC Read: Yankees rate higher than Red Sox.
Model Read: Yankees grade stronger on the current source-backed model.
Evidence status: provisional — lineups pending.
Price context: display-only and not used in scoring.
Ticker/market ID: KXMLBGAME-...
```

Mention-market target:

```text
Will Trump say "Tariff" during the covered event?
Plain English: this card asks whether the accepted word form "Tariff" appears during the covered event under Kalshi's rules.
Settlement: YES only if the covered event includes the accepted word form under Kalshi's rules.
Price context: display-only and was not used in CPC posture or scoring.
```
