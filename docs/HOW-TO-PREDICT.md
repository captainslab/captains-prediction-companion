# HOW-TO-PREDICT.md — CLI Agent Prediction Playbook

> **You received a Kalshi link. Execute this file top to bottom.**
> Fan agents out in parallel at every wave. Never run sequentially what can run simultaneously.

---

## BOOT — Run This Immediately on Any Link

Try scrapers in order until one returns clean content:

```bash
# 1. Firecrawl (primary)
firecrawl scrape "<KALSHI_URL>" --only-main-content -o .firecrawl/market.md

# 2. Jina — if Firecrawl is out of credits (no install needed)
curl -s "https://r.jina.ai/<KALSHI_URL>" -o .firecrawl/market.md

# 3. Crawl4AI — if Jina returns incomplete JS content
python3 -c "
import asyncio
from crawl4ai import AsyncWebCrawler
async def scrape():
    async with AsyncWebCrawler() as c:
        r = await c.arun('<KALSHI_URL>')
        print(r.markdown)
asyncio.run(scrape())
" > .firecrawl/market.md

# 4. trafilatura — for static pages / transcripts only
trafilatura -u "<KALSHI_URL>" --markdown -o .firecrawl/market.md
```

Full scraper reference: `docs/SCRAPERS.md`

Then read `.firecrawl/market.md` and extract these fields before doing anything else:

```
TITLE:              _______________________________________________
STRIKE:             _______________________________________________  (exact YES resolution condition)
RESOLUTION_SOURCE:  _______________________________________________  (transcript / scoreboard / official announcement)
ELIGIBLE_SPEAKER:   _______________________________________________  (if applicable)
EVENT_DATE:         _______________________________________________
LOCK_TIME:          _______________________________________________
YES_PRICE:          _______________  (e.g. 0.62)
NO_PRICE:           _______________
VOLUME:             _______________
```

**Hard stop before proceeding:**
- Market locked? → output `NO_TRADE: market locked` and stop.
- YES price = 0.99 or 0.01 with no volume? → output `NO_TRADE: stale penny-bait` and stop.
- Resolution source unavailable or unofficial? → output `NO_TRADE: unverifiable resolution source` and stop.

---

## WAVE 1 — Classify + Fetch (Parallel)

Dispatch both simultaneously:

**Agent A — Classify:**
```
Read .firecrawl/market.md. Answer one question only:

Does this market resolve on:
(A) A specific word or phrase being SPOKEN by a named person? → mentionsApp
(B) The outcome of a sports game, race, or fight?           → sportsApp
(C) A political event (election, vote, appointment, policy)? → politicsApp

Disambiguation:
- "Will X say Y at the event?"   → mentionsApp
- "Will X be confirmed/elected?" → politicsApp
- "Will Team A beat Team B?"     → sportsApp
- Resolution cites a transcript  → mentionsApp
- Resolution cites a scoreboard  → sportsApp
- Resolution cites a vote count  → politicsApp

Output exactly: PIPELINE: [mentionsApp | sportsApp | politicsApp]
Then: SUBTYPE: [see subtype list below]
```

Subtype reference:
- mentionsApp subtypes: `earningsMentionsApp` / `politicalMentionsApp` / `fedMentionsApp` / `sportsPresserApp` / `sportsAnnouncerApp` / `mediaInterviewApp`
- sportsApp subtypes: `nflMoneyline` / `nflSpread` / `nflTotal` / `nbaMoneyline` / `nbaSpread` / `nbaTotal` / `mlbMoneyline` / `mlbTotal` / `mlbHomeRunProp` / `mlbPitcherStrikeoutProp` / `ufcMoneyline` / `ufcMethod` / `nascarRaceWinner` / `nascarTop3` / `nascarSeriesChampion` / `ncaafbMoneyline` / `ncaabbMoneyline` / `ncaaBaseballMoneyline`
- politicsApp subtypes: `electionsFederal` / `electionsState` / `electionsChamberControl` / `geopoliticsPolicy` / `geopoliticsConflict` / `cabinetNomination` / `cabinetConfirmation`

**Agent B — Fetch market data:**
```
Fetch the following for the market in .firecrawl/market.md.
Run all fetches in parallel:

1. Current YES/NO prices and order book depth from Kalshi
2. Any related markets on the same event (siblings, series)
3. Recent news on this topic/event (last 48 hours)
   - Use: firecrawl search "<event name> <speaker or teams>" --limit 5
4. For sports markets: injury reports, lineup confirmations
5. For mentions markets: is the event still live or has it ended?

Output each result with a FRESHNESS timestamp.
Flag any source that returned stale or failed data.
```

---

## WAVE 2 — Pipeline Research (Parallel by pipeline)

Wait for WAVE 1. Then dispatch the correct wave:

---

### WAVE 2A — mentionsApp

Dispatch both simultaneously:

**Agent A — Transcript frequency search:**
```
Market: [paste TITLE and STRIKE from boot]
Speaker: [paste ELIGIBLE_SPEAKER]
Event type: [earningsMentionsApp | politicalMentionsApp | fedMentionsApp | etc.]

1. Fetch comparable prior transcripts:
   - Earnings: last 4 quarters (required — all 4, not fewer)
     Search SEC EDGAR / Seeking Alpha for prior calls
   - Political / Fed: last 8–20 comparable appearances
   - Sports presser / media: last 3–5 comparable events
2. Count exact mentions of each strike string in every transcript
3. Map all aliases: what variations count vs. don't under the exact contract wording?
4. Identify prepared remarks vs. Q&A window — which path does each word travel?
5. Confirm the transcript source Kalshi will use for resolution

Output:
- HIT_RATE_TABLE: one row per keyword, one column per transcript checked
  Earnings format: | Keyword | Q1 YYYY | Q2 YYYY | Q3 YYYY | Q4 YYYY | Notes |
  ✓ (N) = said N times, X = not found
- LAMBDA: [mean mentions per comparable event, per keyword]
- ALIASES_COUNTED: [list]
- ALIASES_EXCLUDED: [list]
- EVENT_WINDOW_REMAINING: [prepared remarks / Q&A / none]
- RESOLUTION_SOURCE_CONFIRMED: [yes/no + source name]
```

**Agent B — Context search (MANDATORY — every event type, every run):**
```
Market: [paste TITLE, company/speaker, all strike keywords]

For each keyword on the board, answer: WHY is this word on the board?

1. Search company/speaker news last 90 days:
   curl -s "https://r.jina.ai/https://www.google.com/search?q=<company>+<keyword>+2025" -o .firecrawl/context-<keyword>.md
   OR: firecrawl search "<company> <keyword>" --limit 5

2. For each keyword determine:
   - What recent event, product launch, deal, regulatory action, or analyst question put this word in play?
   - Has the speaker used this word in recent press releases, interviews, or guidance?
   - Is this a prepared-remarks word (scripted/planned) or Q&A-only (analyst must ask)?
   - What would have to be true for this word NOT to appear?

Output per keyword:
- CONTEXT_DRIVER: one line — why it's on the board
- PATH: [prepared / Q&A / either]
- AVOIDANCE_RISK: [low / medium / high] + reason if medium or high
```

---

### WAVE 2B — sportsApp

Dispatch both simultaneously:

**Agent A — Stats and injury gate:**
```
Market: [paste TITLE, sport, teams/fighters/drivers]

Fetch all of the following in parallel:
1. Confirmed lineup / starter / fighter status (is the key player actually playing?)
2. Injury report — any key absences?
3. Weather conditions if outdoor (NFL, MLB, NASCAR)
   - Temperature, wind speed/direction, precipitation
4. Last 5 games/races stats for each side:
   - NFL: EPA, offensive/defensive efficiency, turnover rate
   - NBA: pace, offensive rating, defensive rating, rest days
   - MLB: starter ERA, K/9, WHIP, last 3 starts; bullpen ERA last 7 days
   - UFC: last 3 fights, finish rate, striking/grappling tendencies
   - NASCAR: last 3 races at this track type, qualifying speed, practice speed
5. Odds from 2+ sources for consensus check

GATE CHECK — output this first:
- KEY_PLAYER_CONFIRMED: [yes / no / unknown]
If KEY_PLAYER_CONFIRMED is "no" or "unknown" → stop and output POSTURE: WAIT
```

**Agent B — Fair probability model:**
```
Market: [paste TITLE, sport, market type]
Use the correct skill:

NFL / NCAAFB    → footballEfficiencySkill
  Inputs: EPA differential, efficiency ratings, QB status, weather (wind >15mph degrades passing)
  Pythagorean exponent: 1.83

NBA / NCAABB    → basketballTempoRotationSkill
  Inputs: pace differential, offensive/defensive efficiency, rest days (back-to-back = -3 pts),
  travel burden, foul trouble in live markets
  Pythagorean exponent: 13.9

MLB / NCAAB     → baseballPitcherWeatherSkill
  Inputs: starter quality (ERA, FIP, K/9), lineup handedness splits,
  bullpen depth, park factor, wind (>10mph out = +0.3 runs total)

UFC             → ufcStyleMatchupSkill
  Inputs: striking volume/accuracy, takedown efficiency/defense,
  grappling control time, form last 3 fights, thin-data discount

NASCAR          → nascarPracticeTrackSkill
  Inputs: single-lap practice speed, 5-lap and 10-lap averages,
  tire falloff rate, track type history, season form

MLB HR prop     → mlbHomeRunPropSkill
  Inputs: barrel rate, hard-hit rate, launch angle, 20-game power form,
  pitcher HR allowance, park factor, wind direction/speed

MLB K prop      → mlbStrikeoutPropSkill
  Inputs: K/BF, SwStr%, CSW%, pitch count projection, workload,
  opposing lineup K tendencies

Build FAIR_PROB for the specific bet (moneyline win / cover / over-under).
Show your model inputs and calculation.
```

---

### WAVE 2C — politicsApp

Dispatch both simultaneously:

**Agent A — Intelligence fetch:**
```
Market: [paste TITLE, actors, region]

Fetch in parallel:
1. worldmonitor feed — run: npm run dev (localhost:5173), search for entity/region
   Extract: headlines (last 48h), event clusters, urgency heat, entity tags
   Alert keywords to flag: war, invasion, nuclear, sanctions, confirmed, nominated
2. For elections subtype only:
   - Current polling averages (RealClearPolitics or FiveThirtyEight)
   - State-level breakdown if applicable
   - Economic indicator context (approval rating, GDP trend)
3. Recent news convergence: are multiple independent sources pointing the same direction?

Output:
- URGENCY_HEAT: [high / medium / low]
- DOMINANT_THEME: [one line]
- CONVERGENCE_SIGNAL: [yes/no + evidence]
- POLLING_AVERAGE: [if elections — current % with source and date]
```

**Agent B — Base rates and analogues:**
```
Market: [paste TITLE and SUBTYPE]

Research:
1. What is the historical base rate for this type of event?
   - Senate confirmation: ~85% of nominated cabinet picks get confirmed
   - Incumbent reelection by office type: [look up]
   - Policy passage rate for similar legislation: [look up]
2. Find 2–3 analogous past prediction markets and their outcomes
3. What was the market-implied probability for those analogues at the same stage?

Output:
- BASE_RATE: [0.00–1.00 with source]
- ANALOGUES: [list of (event, outcome, market_prob_at_same_stage)]
```

---

## WAVE 3 — Price + Posture (Always Parallel)

Dispatch both simultaneously regardless of pipeline:

**Agent A — Fair value:**
```
Inputs from WAVE 2:
[paste relevant outputs]

1. Build FAIR_PROB:
   - mentionsApp: P(YES) = 1 − e^(−λ), adjusted for narrative heat
     λ = LAMBDA from transcript research × heat multiplier (high=1.3, medium=1.0, low=0.7)
   - sportsApp: use model output from WAVE 2B Agent B directly
   - politicsApp: weight base rate 60% + polling/intel signal 40%; adjust for convergence

2. Extract MARKET_PROB from current YES price (= YES price directly on Kalshi)

3. Calculate:
   EDGE = FAIR_PROB − MARKET_PROB
   PAYOUT = 1 / YES_PRICE  (if buying YES)
           or 1 / NO_PRICE  (if buying NO)
   EV = (FAIR_PROB × PAYOUT) − 1   [positive = edge on YES]
      or ((1−FAIR_PROB) × (1/NO_PRICE)) − 1  [for NO side]

Output: FAIR_PROB, MARKET_PROB, EDGE, EV_YES, EV_NO
```

**Agent B — Trade posture:**
```
Inputs: FAIR_PROB, EDGE, EV_YES, EV_NO, KEY_PLAYER_CONFIRMED

Apply these rules in order — first match wins:

1. KEY_PLAYER_CONFIRMED = no/unknown                    → POSTURE: WAIT
2. Market locked or already resolved                    → POSTURE: NO_TRADE
3. Price moved >10% since WAVE 1 fetch                 → POSTURE: NO_TRADE
4. Resolution source unconfirmed                        → POSTURE: NO_TRADE
5. EV_YES > threshold AND within limits                 → POSTURE: TRADE_YES
6. EV_NO > threshold AND within limits                  → POSTURE: TRADE_NO
7. Edge exists but order book is thin (<$500 volume)   → POSTURE: PLACE_PASSIVE_ORDER
8. Conflicting sources or ambiguous resolution          → POSTURE: ESCALATE
9. All else                                             → POSTURE: NO_TRADE

EV thresholds: pre-event ≥ 0.02 | live ≥ 0.05 | futures ≥ 0.03

Kelly stake: f* = (b×p − q) / b  where b=payout−1, p=FAIR_PROB, q=1−FAIR_PROB
Production stake = f*/4
Cap: never exceed 0.02 per bet, 0.10 per league/pipeline per day

Output: POSTURE, STAKE_CAP, which cap applied (if any)
```

---

## FINAL OUTPUT — Fill and Return

```
═══════════════════════════════════════════════════════
CAPTAIN PREDICTION PACKET
═══════════════════════════════════════════════════════
MARKET:           
PIPELINE:         [mentionsApp | sportsApp | politicsApp]
SUBTYPE:          

FAIR_PROB:        
MARKET_PROB:      
EDGE:             
EV:               

POSTURE:          [TRADE_YES | TRADE_NO | PLACE_PASSIVE_ORDER | WAIT | ESCALATE | NO_TRADE]
STAKE_CAP:        

PRIMARY_SIGNAL:   
SUPPORTING:
  -
  -
  -
NO_BET_REASON:    [blank if TRADE_YES or TRADE_NO]
CONFIDENCE:       [0.0–1.0]
RESOLUTION_NOTES: 
═══════════════════════════════════════════════════════
```

---

## Mentions Edge Cases — Instant Decisions

| What you observe | Do this |
|-----------------|---------|
| Speaker said the word live, event ongoing | FAIR_PROB → 0.99. POSTURE: TRADE_YES |
| Event ended, word never said | FAIR_PROB → 0.01. POSTURE: TRADE_NO |
| "Beijing" in transcript, contract says "China" | ESCALATE — do not assume equivalence |
| Prepared remarks done, Q&A still running | Do NOT close out. Event is not over |
| Video shows word spoken, official transcript not posted yet | POSTURE: WAIT |
| Moderator or interviewer says the strike term | Does NOT resolve YES. Exclude from count |
| Speaker reads viewer/audience question containing strike | Check contract. Usually does not count |
| YES=0.99 or NO=0.99 with <$100 volume | POSTURE: NO_TRADE — settlement lag trap |

---

## Full Fan-Out Map (Single Reference)

```
ON LINK RECEIVED
  │
  ├─ WAVE 0: firecrawl scrape → extract boot fields → hard stop checks
  │
  ├─ WAVE 1 (parallel):
  │    Agent A: Classify → PIPELINE + SUBTYPE
  │    Agent B: Fetch → prices, news, live status
  │
  ├─ WAVE 2 (parallel, by pipeline):
  │    mentionsApp:  Agent A: transcript research + counts
  │                  Agent B: narrative heat + news
  │    sportsApp:    Agent A: stats + injury gate
  │                  Agent B: fair probability model
  │    politicsApp:  Agent A: worldmonitor + polling
  │                  Agent B: base rates + analogues
  │
  ├─ WAVE 3 (always parallel):
  │    Agent A: fair value → FAIR_PROB, EDGE, EV
  │    Agent B: trade posture → POSTURE, STAKE_CAP
  │
  └─ FINAL: fill and return output packet
```

---

## Agent Roles Quick Reference

| Agent | Waves | What they do |
|-------|-------|-------------|
| *(you / orchestrator)* | 0 | Run firecrawl scrape, extract boot fields, hard stop check |
| `@companion-router` | 1A | Classify pipeline and subtype |
| `@alphaagent` | 1B, 2A, 2C-A | All external data fetches |
| `@mentions-researcher` | 2A-A | Transcript research, strike normalization |
| `@mentions-mcp-forecaster` | 3A (mentions) | Poisson model, P(YES) |
| `@sports-pre-game` | 2B-B | Fair probability modeling |
| `@researcher` | 2C-B | Base rates, analogues |
| `@oracle` | 3A | Fair value comparison, edge cases |
| `@decision-logic` | 3B | EV, Kelly, trade posture |
| `@controller` | Any | Scope-lock if session gets complex |
