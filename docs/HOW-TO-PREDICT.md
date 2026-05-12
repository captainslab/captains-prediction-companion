# HOW-TO-PREDICT.md — CLI Agent Prediction Guide

> You received a Kalshi market link. This is your playbook.
> **Core rule: fan agents out in parallel whenever tasks are independent. Never run sequentially what can run simultaneously.**

---

## Agent Roster — Have These Ready

Before starting any prediction session, confirm these agents are available in your CLI session:

| Agent | Role | Required for |
|-------|------|-------------|
| `@companion-router` | Classify and normalize incoming market | All pipelines — always first |
| `@alphaagent` | Fetch prices, stats, transcripts, news, weather | All pipelines |
| `@mentions-researcher` | Transcript research, strike normalization, historical hit rates | mentionsApp |
| `@mentions-mcp-forecaster` | Bayesian probability via MixMCP | mentionsApp |
| `@oracle` | Fair value comparison and trade gate | All pipelines |
| `@decision-logic` | EV, Kelly sizing, trade posture | All pipelines |
| `@sports-pre-game` | Fair probability for game/race/fight markets | sportsApp |
| `@researcher` | Evidence gathering, repo facts, source verification | All pipelines |
| `@controller` | Scope-lock, task management, proof requirement | Complex or multi-market sessions |

**Minimum viable session:** `@companion-router` + `@alphaagent` + `@oracle` + `@decision-logic`

---

## Step 1 — Parallel Launch (Do This Immediately)

As soon as you receive a Kalshi link, dispatch these **simultaneously in one message**:

```
@companion-router  — classify the market, identify pipeline, extract strike/speaker/resolution source
@alphaagent        — fetch the market page: title, YES/NO prices, volume, lock time, resolution rules
```

Do not wait for one before starting the other. Both can run in parallel.

---

## Step 2 — Classify the Market

From `@companion-router` output, route to the correct pipeline:

| Resolution condition | Pipeline |
|----------------------|----------|
| Word/phrase **spoken** by a specific person | `mentionsApp` |
| Sports game / race / fight **outcome** | `sportsApp` |
| Political **event** (election, vote, appointment, policy) | `politicsApp` |

**Hard disambiguation rules:**
- "Will X say 'Y' at the briefing?" → `mentionsApp`
- "Will X be confirmed/elected/appointed?" → `politicsApp`
- "Will Team A beat Team B?" → `sportsApp`
- Contract cites a transcript → `mentionsApp`
- Contract cites a scoreboard or stats feed → `sportsApp`
- Contract cites a vote count or official announcement → `politicsApp`

---

## Step 3 — Pipeline Fan-Out

### mentionsApp Fan-Out

Dispatch these **simultaneously in one message** after classification:

```
@mentions-researcher  — fetch comparable transcripts, count historical mentions,
                        normalize strike aliases, identify eligible speaker patterns
@alphaagent           — pull current narrative context: is this topic trending?
                        Any breaking news that shifts the prior?
```

Then, once both return, dispatch **simultaneously**:

```
@mentions-mcp-forecaster  — run Poisson model (λ from historical counts),
                             apply narrative heat, output P(YES) with confidence
@oracle                   — compare fair P(YES) to current market price, flag edge cases
```

Then `@decision-logic` for posture and sizing.

**Mentions research checklist (for @mentions-researcher):**
- [ ] Exact strike string extracted
- [ ] All aliases and plurals mapped (what counts, what doesn't)
- [ ] Eligible speaker confirmed (not just any participant)
- [ ] Comparable transcripts fetched (same speaker, same event type)
- [ ] Historical mention counts tabulated
- [ ] Prepared remarks vs Q&A window identified
- [ ] Transcript source confirmed as official and accepted by contract

Reference: `docs/MENTIONSAPP.md`, `runbooks/captain-mentions-research-system.md`

---

### sportsApp Fan-Out

Dispatch these **simultaneously in one message** after classification:

```
@alphaagent       — fetch: current odds/prices, injury/lineup reports,
                    weather (if outdoor), recent team/player stats
@sports-pre-game  — identify sport, market type, route to modeling skill:
                    NFL/NCAAFB    → footballEfficiencySkill (EPA, efficiency, QB, weather)
                    NBA/NCAABB    → basketballTempoRotationSkill (pace, efficiency, rest, travel)
                    MLB/NCAAB     → baseballPitcherWeatherSkill (starter, bullpen, park, weather)
                    UFC           → ufcStyleMatchupSkill (striking, grappling, form, style)
                    NASCAR        → nascarPracticeTrackSkill (practice speed, tire, track history)
                    MLB HR prop   → mlbHomeRunPropSkill (barrel rate, park, wind, pitcher)
                    MLB K prop    → mlbStrikeoutPropSkill (K/BF, CSW%, workload, opponent K%)
```

Then, once both return, dispatch **simultaneously**:

```
@oracle         — fair probability vs Kalshi implied probability, edge check
@decision-logic — EV calculation, Kelly sizing, trade posture
```

**Injury/lineup gate:** If key player/starter is unconfirmed → posture is `WAIT`. Do not price until confirmed.

Reference: `docs/SPORTSAPP.md`

---

### politicsApp Fan-Out

Dispatch these **simultaneously in one message** after classification:

```
@alphaagent   — pull worldmonitor feed: headlines, entity tags, event clusters,
                urgency heat for relevant actors/regions;
                pull polling averages if elections subtype
@researcher   — historical base rates for this race/event type,
                analogous past markets and their outcomes
```

Then, once both return, dispatch **simultaneously**:

```
@oracle         — build narrative state (dominant themes, convergence signals, sudden shifts),
                  construct fair probability via appropriate engine:
                  elections   → electionsAlphaEngine (polling + base rates + economic indicators)
                  geopolitics → geopoliticsAlphaEngine (event clusters + narrative heat + urgency)
                  cabinet     → electionsAlphaEngine with appointment-context adjustments
@decision-logic — EV, Kelly, trade posture
```

Reference: `docs/POLITICSAPP.md`, `docs/WORLDMONITORINTEGRATION.md`

---

## Step 4 — Trade Posture

`@decision-logic` produces one of six postures:

| Posture | Condition |
|---------|-----------|
| `TRADE_YES` | Positive EV above threshold, within exposure limits, buy YES |
| `TRADE_NO` | Positive EV on NO side above threshold, buy NO |
| `PLACE_PASSIVE_ORDER` | Edge exists but market is wide or illiquid — enter limit at fair value |
| `WAIT` | Edge is real but critical info is unconfirmed (injury, lineup, transcript not posted) |
| `ESCALATE` | Ambiguous resolution, unusual signal, or conflicting sources — flag for review |
| `NO_TRADE` | Hard block: stale market, price already moved post-news, circuit breaker hit |

**EV thresholds:**
- Pre-event: ≥ 2%
- Live/in-play: ≥ 5%
- Futures: ≥ 3%

**Kelly:** f* = (bp − q) / b — always use f*/4 in production

---

## Step 5 — Standard Output Block

Every prediction session ends with this block. No exceptions.

```
MARKET:           [Full Kalshi market title]
PIPELINE:         [mentionsApp | sportsApp | politicsApp]
SUBTYPE:          [earningsMentionsApp | nflSpread | electionsApp | etc.]

FAIR_PROB:        [0.00–1.00]
MARKET_PROB:      [0.00–1.00]  ← implied from current YES price
EDGE:             [fair_prob − market_prob, signed]
EV:               [(fair_prob × payout) − price]

POSTURE:          [TRADE_YES | TRADE_NO | PLACE_PASSIVE_ORDER | WAIT | ESCALATE | NO_TRADE]
STAKE_CAP:        [e.g. 0.02 = 2% of bankroll]

PRIMARY_SIGNAL:   [one-line: the most important finding driving the price]
SUPPORTING:
  - [evidence item 1]
  - [evidence item 2]
NO_BET_REASON:    [if WAIT/NO_TRADE — why]
CONFIDENCE:       [0.0–1.0]
RESOLUTION_NOTES: [any contract edge cases or ambiguities]
```

---

## Hard Stops — Check Before Outputting

- [ ] Market is still open and not yet locked
- [ ] Price is live and liquid (not a stale 0.99/0.01 penny-bait)
- [ ] Resolution source is confirmed official
- [ ] Eligible speaker / key player identified with certainty
- [ ] Price hasn't moved >10% since you fetched (already reacted to news you're reading)
- [ ] Strike string fully normalized for mentions markets

**Auto-output `NO_TRADE` if any of these fail.**

---

## Mentions Edge Cases (mentionsApp only)

| Situation | Action |
|-----------|--------|
| Word clearly said mid-event | YES → ~0.99; avoid NO |
| Event ended, word never said | NO → ~0.01; avoid YES |
| Alias ambiguity ("Beijing" ≠ "China") | Flag; do not assume |
| Prepared remarks over, Q&A remaining | Event not over — do not price as done |
| Video suggests word said, transcript not posted | `WAIT` — do not act on video alone |
| Moderator says the term, not the named speaker | Does not resolve YES |
| Speaker reads question containing strike term | Check contract wording carefully |
| 0.99/0.01 with no volume | Likely settlement lag trap — check before acting |

---

## Fan-Out Summary (Quick Reference)

```
STEP 1 (always parallel):
  @companion-router + @alphaagent

STEP 2 — mentionsApp (parallel):
  @mentions-researcher + @alphaagent (narrative)
  → then: @mentions-mcp-forecaster + @oracle (parallel)
  → then: @decision-logic

STEP 2 — sportsApp (parallel):
  @alphaagent (stats/injuries) + @sports-pre-game (modeling)
  → then: @oracle + @decision-logic (parallel)

STEP 2 — politicsApp (parallel):
  @alphaagent (worldmonitor + polls) + @researcher (base rates)
  → then: @oracle + @decision-logic (parallel)
```

---

## Reference Docs

| Doc | Covers |
|-----|--------|
| `docs/MENTIONSAPP.md` | Full mentions pipeline |
| `docs/SPORTSAPP.md` | Full sports pipeline, skill registry, math models |
| `docs/POLITICSAPP.md` | Full politics pipeline, worldmonitor integration |
| `docs/WORLDMONITORINTEGRATION.md` | worldmonitor sources, feeds, output schema |
| `docs/BUILDSTATUS.md` | What's operational vs planned |
| `runbooks/captain-mentions-research-system.md` | Step-by-step mentions research |
| `agents/*/SOUL.md` | Per-agent role definitions |
