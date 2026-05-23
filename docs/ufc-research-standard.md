# UFC Prediction Markets — Fundamentals-First Research Standard

**Version:** 1.0
**Sport:** UFC / MMA
**Scope:** All pre-fight Kalshi UFC markets
**Date:** 2026-05-23
**Status:** Authoritative — supersedes any prior UFC pick logic

---

## 0. Foundational Principle

Every UFC pick must be built on fighter-level evidence before price is consulted. Price confirms; price does not create. A market that moves in your direction without a fighter-evidence reason is noise. The only valid pick engine is the fight itself.

This standard is conservative by design. UFC has significant data gaps: incomplete fight records, short career samples, last-minute replacements, weight-cut failures, and deceptive styles. When data is thin, the correct answer is NO CLEAR PICK, LEAN, or WATCH. Never force a pick to fill a card.

---

## 1. Current Repo Inventory

### Existing UFC Files

| File | Description |
|---|---|
| `scripts/packets/generate-ufc-weekly.mjs` | Main UFC packet generator (310 lines). Generates weekly weekend event packets, calls shared decision-process layer, integrates with Kalshi discovery. Always outputs WATCH — fighter source adapters are not yet wired. |
| `channels/20260516-ufc-allen-costa-board.md` | Execution board for Allen vs Costa (UFC Fight Night Vegas 117, May 16 2026). Shows full fighter profiles, market analysis, Kalshi tickers, decision labels. |
| `channels/20260517-mvp-mma-netflix-guide.md` | Post-event settlement guide for MVP MMA Netflix special. |
| `state/ufc/` | Date-bucketed state artifacts: Kalshi events as JSON (e.g., `KXUFCFIGHT-26MAY16ALLCOS`). |

### Shared Infrastructure UFC Already Uses

| File | UFC Role |
|---|---|
| `scripts/packets/lib/kalshi-discovery.mjs` | Fetches UFC markets via `KALSHI_SOURCES.ufc` → `fetchKalshiEvents('ufc')`. Persists event JSON to `state/ufc/{date}/`. |
| `scripts/shared/decision-process.mjs` | Classifies UFC as `MARKET_TYPES.SPORTS_GAME`. Enforces 6-item SPORTS_GAME checklist. |
| `scripts/packets/lib/common.mjs` | Headers, footers, chunking, audit metadata — shared with MLB/NASCAR. |

### What Is Missing

UFC has no sport-level source adapters. The Kalshi market board exists. Fighter stats, injury status, and matchup context do not. As a result, the packet generator always sets `checked.evidence_supported_side = false` and outputs `WATCH`.

The 6-item SPORTS_GAME checklist requires `projected_participants`, `lineup_injury_news`, `venue_context`, `recent_form_matchup`, `market_board_context`, and `evidence_supported_side`. Currently only `projected_participants` and `market_board_context` can be satisfied (from the Kalshi feed). The other four require source adapters that do not yet exist.

---

## 2. Ranked Source Stack

| Rank | Source | Tier | Data covered | Markets helped | Access method | Automation difficulty | Reliability | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | **UFCStats.com** | Core | Round-by-round strikes, takedowns, control time, KDs, finish round/time, career stats, event metadata, judge scorecards | All markets | Static HTML, no auth, no robots.txt block | Easy — `ufcscraper` PyPI (Aug 2025) works | Hours post-event; very stable structure | De facto official stats DB. Primary quantitative backbone. |
| 2 | **BestFightOdds.com** | Specialty | Historical opening/closing odds for 12+ books back to 2008, per-fight odds movement timeline | Fight winner (market-implied probability), all markets as calibration | AJAX + Base64/Caesar-encoded XHR | Hard — `ufcscraper` handles it but cipher is a fragility | Near real-time, archive comprehensive | Best free historical odds. Encryption is single point of failure. |
| 3 | **MMADecisions.com** | Specialty | Judge scorecards, round scores, judge names, contested decision flags, media scorecards, per-fighter decision history | Goes distance, decision prop, KO/TKO prop (inverse) | Static HTML, no auth, no robots.txt | Easy — simple BS4 | Post-event, days lag | Unique: no other free source provides full UFC scorecard history. |
| 4 | **UFC.com Rankings** | Specialty | Official weekly rankings (all 19 divisions + P4P), champion designation, title fight status | Fight winner context, title fight flag | Static HTML, no auth, not blocked | Easy | Weekly update Wednesdays | Robots.txt blocks `/athletes/all?*` listing, not individual pages or `/rankings`. |
| 5 | **ESPN Hidden API** | Specialty | Live scoreboard, event card structure, fight order, fighter records as strings, athlete listing (1,810 fighters) | Fight winner context, card confirmation, live result | Undocumented JSON API, no auth required | Medium — multi-hop `$ref` resolution | Near-real-time, fastest result source | Unofficial; endpoints may silently disappear. Good for live event tracking. |
| 6 | **UFC.com Fighter Pages** | Specialty | Fighter physical stats, win method breakdown (KO/sub/decision counts), striking/TD accuracy, fight time average | Fight winner, method | Static HTML | Easy | Post-event, weekly | Backup/cross-ref to UFCStats. Less detail. |
| 7 | **The Odds API** | Specialty | Current + historical odds for 40+ sportsbooks (from 2020), clean REST API, API key | Fight winner moneyline only | Official REST API, API key | Easy | Real-time | Clean contract alternative to BestFightOdds. Only moneyline market; no props. |
| 8 | **FightMatrix.com** | Specialty | Pre-built Elo/CIRRS ratings, divisional and all-time rankings | Fight winner (modeled rating) | Static HTML, WordPress | Medium | Weekly | Useful if you don't want to compute Elo yourself. Aggregates Sherdog + Tapology. |
| 9 | **betmma.tips** | Backup | Historical UFC odds (9+ years), reach/height stats, betting tendency data | Fight winner, physical context | Static HTML | Easy | — | Simpler structure than BestFightOdds; confirmed working in community scrapers. |
| 10 | **OddsPortal MMA** | Backup | Historical results + odds, multi-promotion (UFC, Bellator, ONE, PFL, Rizin) | Fight winner | Static HTML | Medium | — | Good for multi-promotion historical odds breadth. |
| 11 | **SportsData.io** | Core (paid) | Everything: round-by-round stats, live scoring, historical back to UFC 1, betting markets (moneylines + total rounds + props from 2020), 20+ books, line movement | All markets | Official paid REST API | Easy | Real-time | Single-source replacement for the entire free stack. Custom/enterprise pricing. |
| 12 | **Sherdog.com** | Backup | Deep career records (all promotions globally, decades), cross-promotion history, fight times and methods | Fight winner (career arc), method | HTML, 403 without browser headers, bots blocked | Hard — requires proxy/Apify actor | Days lag | Unique for pre-UFC career context. One-time batch build only, not cron. |
| 13 | **MMA Fighting / MMA Junkie** | Manual-only | Breaking news, injury reports, replacement announcements, camp context | Flags/blockers only — no modeling inputs | CMS HTML | Easy to fetch; hard to structure | Fastest news cycle | Tier 4 news only. Cannot create picks. Triggers re-research. |
| 14 | **Tapology.com** | Avoid | Fight records (cross-promotion), community picks %, odds pulled from BestFightOdds | — | Static+JS, confirmed IP bans | Avoid — ToS explicitly bans scrapers + "AI applications" | Current | Legal exposure is real. Manual research only. |

---

## 3. Recommended Source Stacks

### Best 3-Source Stack (Minimum Viable)

**UFCStats.com + BestFightOdds.com + MMADecisions.com**

UFCStats covers every in-cage metric for all seven market types. BestFightOdds provides historical and current market-implied probability from 12 sportsbooks back to 2008, enabling model calibration and edge confirmation. MMADecisions is the only free source for UFC judge scorecards — critical for goes-distance and decision prop markets and judge assignment awareness.

The `ufcscraper` PyPI package (verified, Aug 2025) handles both UFCStats and BestFightOdds in a single package. MMADecisions is simple BS4.

**Gaps:** No cross-promotion pre-UFC career history; no real-time injury/news signal; BestFightOdds encryption is a fragility point.

### Best 4-Source Stack

**UFCStats + BestFightOdds + MMADecisions + UFC.com Rankings**

Add UFC.com Rankings as the fourth source. Near-zero automation cost (static HTML, not blocked). Provides official weekly ranking position per fighter — direct input for fight-winner probability, title fight context, and fight significance framing. Also provides canonical champion designations and name normalization.

### Best 5-Source Stack

**UFCStats + BestFightOdds + MMADecisions + UFC.com Rankings + ESPN Hidden API**

ESPN's undocumented API adds real-time card status (fight order, broadcast info, live results) at zero auth cost. Its athlete listing endpoint (1,810 fighters) gives a fighter ID namespace for cross-referencing. ESPN updates in near-real-time during events — fastest source for fight results before UFCStats posts, giving the pipeline a live confirmation signal.

**Alternatives for the fifth slot:**
- Replace ESPN API with **Sherdog** (via proxy) for full pre-UFC career records — unique value for debut UFC fighters or those with significant Bellator/ONE history. Use as a one-time batch build, not cron.
- Replace BestFightOdds with **The Odds API** if a clean API contract is preferred over encryption handling — trade-off is no data before 2020 and no prop markets.

### Sources to Avoid for Cron

| Source | Reason |
|---|---|
| **Tapology** | Explicit ToS ban on "web bots, data scraping tools, AI applications." Confirmed IP-banning after bulk requests. Community scraper abandoned. Legal risk is real. |
| **Sherdog** | HTTP 403 on direct fetch; robots.txt blocks all bot user agents. Requires proxy rotation (Apify actor, $1/1,000 results). Suitable for one-time historical builds only. |
| **BestFightOdds (cron caution)** | Base64+Caesar encryption on XHR — works via `ufcscraper` but a cipher change breaks the pipeline silently. Monitor for breakage; keep a fallback (The Odds API or betmma.tips). |
| **UFC.com `/athletes/all?*`** | Explicitly disallowed by robots.txt. Individual athlete pages are fine; enumerate fighter URLs through event pages instead. |

---

## 4. Market-by-Market Research Checklist

### 4.1 Fight Winner

**Required inputs (must be present before PICK or EVIDENCE_LEAN):**
- Both fighters officially confirmed on card — no late replacement flag unresolved
- Style classification for each fighter: primary weapon + realistic secondary threat
- Style matchup assessment: which fighter's offense targets the opponent's documented weakness
- Recent form: last 3–5 fights, results, method, opponent quality tier tagged (elite / solid UFC / UFC gatekeeper / regional-journeyman / unknown)
- Level-of-competition check: record built on elite opponents or padding? Tag every reviewed opponent
- Wrestling/grappling edge: who wins on the ground? Who can keep it standing?
- Striking differential: accuracy, volume, power (KO rate), defensive movement if available
- Durability: has the fighter been stopped? How? Chin issue, accumulated damage, gassed, or specific shot?
- Cardio and pace: documented fade patterns? When?
- Camp and preparation context: full camp vs short notice (<21 days), gym switch, significant weight class move

**Nice-to-have:**
- Head-to-head history if prior meeting exists
- Referee tendencies (early standup vs. grappling tolerance)
- Judging panel tendencies for the venue (for close fights where decision is plausible)
- Post-fight health/injury notes from official sources
- Promotional context (title shot next, contract year, retirement rumors from the fighter themselves)

**Mandatory threshold before PICK:**
- Both fighters confirmed active
- Minimum 3 career fights reviewed per fighter with opponent quality tagged
- Style matchup stated explicitly, not inferred from name alone
- At least one clear edge identified: striking, grappling, cardio, or matchup exploitation — not just "Fighter A is better"
- No unresolved late-replacement flag

**Missing data → LEAN/WATCH:**
- Fighter has fewer than 3 relevant recent fights available
- Opponent quality in recent record entirely unknown or untagged
- Camp context uncertain (gym switch unconfirmed, social injury rumors without Tier 1 source)
- Fighter making significant style or weight-class change with no fight data at the new class

**Missing data → NO CLEAR PICK:**
- Either fighter is a confirmed late replacement with <14 days notice
- Neither fighter has a verifiable fight record beyond stubs
- Active injury report from Tier 4 beat reporter with no Tier 1 resolution before fight night
- Style matchup cannot be assessed because one fighter has fewer than 2 recorded fights

---

### 4.2 Method of Victory (KO/TKO / Submission / Decision)

**Required inputs:**
- Finish rate for each fighter (career KO/TKO rate and sub rate as % of total wins) at UFC-level competition
- Opponent loss method distribution: KO/TKO, submission, decision, or never stopped
- Submission threat assessment: who initiates? What is the opponent's submission defense?
- KO/TKO threat assessment: who has documented knockout power? Who has been dropped or rocked?
- Chin and durability: documented vulnerability on feet vs. ground
- Fight pace: high-pace increases finish probability; stalling/clinch-heavy reduces it
- Style matchup for method: state the finish mechanism explicitly (e.g., "submission specialist vs. wrestler with weak bottom game")

**Nice-to-have:**
- Round-by-round finish timing
- Referee tendencies for early stoppages
- Fighter's documented pattern of surviving adversity

**Mandatory threshold before PICK:**
- Finish rates for both fighters across ≥5 career fights (or complete career if fewer, stated)
- Opponent finish vulnerability rated: never stopped / stopped once / stopped multiple times / stopped by this specific method
- A named mechanism statement: "the path to KO/TKO is X because Y" or "decision is likely because neither fighter has a finish threat against this style"

**Missing data → LEAN/WATCH:**
- Finish rate based entirely on regional competition with no UFC-level fights available
- Only one fighter has adequate method data

**Missing data → NO CLEAR PICK:**
- Both fighters have fewer than 3 fights available
- Only method data available is from before a major style change with no post-transition competition data

---

### 4.3 Goes Distance / Does Not Go Distance

**Required inputs:**
- Combined finish rate of both fighters with competition quality tagged
- Durability: not just finish rate but specific stop-at-any-time vulnerability
- Cardio and pace sustainability: documented fade patterns
- Grappling control style: control-heavy wrestlers are a goes-distance signal
- Rounds scheduled: 3-round vs. 5-round (5-round gives more finish opportunities but also more time to normalize)
- Weight class finish tendency as contextual modifier (see Section 7)
- Both fighters' most recent fights: distance or finish?

**Mandatory threshold before PICK:**
- Finish rates for both fighters with competition quality tagged
- Explicit durability assessment for each fighter
- Scheduled round count confirmed

**Missing data → LEAN/WATCH:**
- One fighter's recent fights are entirely stoppages of journeyman opponents, making rate unreliable
- One fighter coming off long layoff with no conditioning data

**Missing data → NO CLEAR PICK:**
- Late replacement with unknown conditioning or fight style
- No reliable fight record accessible for review

---

### 4.4 Round Total (Over/Under Rounds)

**Required inputs:**
- Finish timing history for both fighters: which round do finishes occur? Early (R1–2), mid (R2–3), or late (R3+)?
- Cardio signals: dramatic R2 fade is a predictor of later finish; early blitz is a predictor of R1 finish
- Grappling control time: control-heavy styles push fights deeper regardless of finish probability
- Scheduled round count mapped to the specific total threshold
- Style pace: cautious opener vs. pressure-first documented

**Mandatory threshold before PICK:**
- Finish timing data from ≥4 career fights per fighter
- Cardio and pace profile stated for each fighter
- Scheduled round count confirmed

**Missing data → LEAN/WATCH:**
- Finish timing data based on fewer than 3 fights against mismatched opponents
- Late replacement with unknown conditioning pace

**Missing data → NO CLEAR PICK:**
- Fewer than 3 fights with timing data for either fighter
- Threshold is at ambiguous round boundary with no timing data available

---

### 4.5 Exact Round / Round Group

**Default: NO CLEAR PICK**

All round total requirements apply, plus:

**Required inputs for any pick:**
- Specific round finish concentration: not just "finishes early" — evidence that a fighter consistently finishes in a narrow window (≥3 finishes in the same 90-second range of the same round)
- Named mechanism: what specifically produces a finish in that round?
- Opponent vulnerability in the specific window: documented evidence of danger in the same timing window

**Anti-shortcut rule:** "Finishes spread across R1, R2, and R3" = NO CLEAR PICK. A vague finish tendency does not justify an exact-round pick. Do not pick exact round or round group markets because price looks interesting. Price cannot substitute for specific timing concentration.

Round group (e.g., R1–R2) has a slightly lower bar than exact round, but still requires evidence the fight will not reach the named boundary. Treat it as less extreme than exact round, not as a default fallback.

---

### 4.6 KO/TKO Prop

**Required inputs:**
- KO/TKO rate for the fighter most likely to finish by KO/TKO (name this fighter explicitly)
- KO/TKO vulnerability of the opponent (has the opponent been stopped by strikes? How?)
- Power assessment: documented knockdowns, near-finishes, strikes that forced turtling
- Style matchup for striking: does the setup create sustained exchanges, or does grappling neutralize KO/TKO probability?
- Durability of both fighters: if both are durable and grappling-dominant, KO/TKO probability is structurally low

**Mandatory threshold before PICK:**
- KO/TKO rate clearly above weight-class average for at least one fighter at UFC-level competition
- Opponent confirmed to have documented KO/TKO vulnerability OR confirmed neither fighter has been stopped (for NO KO/TKO direction)
- Mechanism stated: "KO/TKO is likely because A lands power shots from outside and B has been dropped/stopped twice by right hands"

**Missing data → NO CLEAR PICK:**
- Both fighters have zero UFC-level stoppages
- KO/TKO data is entirely from regional opponents of unknown quality
- Style matchup produces dominant grappling control that neutralizes striking threat

---

### 4.7 Submission Prop

**Required inputs:**
- Submission rate for the fighter most likely to submit (name this fighter explicitly)
- Submission defense of the opponent: has the opponent tapped? Been forced to scramble out of danger?
- Submission threat type: specific documented moves (RNC, guillotine, armbar, triangle) — a RNC specialist against someone who stays standing is a low submission threat
- Grappling control probability: can the submission threat actually get the fight to the mat?
- Defensive grappling of the opponent: takedown defense and scramble ability directly reduce submission probability

**Mandatory threshold before PICK:**
- Submission rate at or above weight-class average in UFC-level competition
- Clear grappling path to the ground exists
- Opponent has a submission vulnerability (has been tapped or has documented near-submissions)

**Missing data → NO CLEAR PICK:**
- Submission threat has not submitted a UFC opponent (regional submissions only)
- Opponent has never been submitted and has excellent takedown defense
- Submission rate is below weight-class average with no clear mechanism

---

### 4.8 Decision Prop

**Required inputs:**
- Decision rate for both fighters: % of fights going to scorecards
- Combined finish threat: if both fighters have high finish rates, decision probability is structurally low
- Control-heavy style: wrestlers, clinch fighters, pace-control fighters increase decision probability
- Durability: fighters who have never been stopped increase decision probability even facing a finisher
- Cardio: can both fighters sustain output at decision pace?

**Mandatory threshold before PICK:**
- Decision rate clearly documented for both fighters
- Combined finish threat is demonstrably low (for YES) or demonstrably high (for NO)
- Explicit rationale stated: mechanism for why judges see all rounds

**Missing data → NO CLEAR PICK:**
- Decision rate data based on fewer than 3 fights
- Neither fighter's style is clearly assessed

---

### 4.9 Fighter-Specific Props

Fighter-specific props combine two or more conditions (e.g., "Fighter A wins by submission in R2"). They carry the highest bar of all UFC markets.

**Required inputs:**
- Every condition in the prop must independently pass its own evidence gate (winner, method, round)
- A compound probability must be estimated: P(wins) × P(by this method) × P(in this round). That combined probability must show meaningful edge over price
- The mechanism connecting all conditions must be stated and coherent

**Missing data → NO CLEAR PICK:**
- Any single condition fails its own evidence gate
- The compound mechanism is speculative ("he usually wins by KO and sometimes early, so first-round KO might be good value" is not evidence)

---

## 5. UFC Source Hierarchy

### Tier 1 — Official/Primary (can anchor a PICK)
- UFC.com official event page — card, bout order, status, weight class, title flag
- UFC official social / press release — confirmed replacements, cancellations, weigh-in results
- Athletic Commission official weigh-in results — weights, missed cuts, pass/fail
- UFC Fightmetric / official stats platform — official per-fight record
- ESPN MMA / official broadcaster — outcomes, methods, times

Tier 1 sources anchor the factual record. Any claim requiring certainty (fighter status, official result, replacement confirmation) must route through Tier 1. A PICK cannot be made against an unresolved Tier 1 question.

### Tier 2 — Trusted Stats (can support a PICK combined with Tier 1)
- Tapology.com (manual only — cannot automate, but deeply accurate)
- Sherdog.com (manual or batch only)
- UFCStats.com (automated core)
- MMADecisions.com (automated)
- Sherdog / MMA Junkie fighter profile physical stats

Tier 1 + Tier 2 combined is the minimum for a PICK. Tier 2 alone — without Tier 1 status confirmation — supports only a LEAN unless the market is low-stakes and Tier 1 is unavailable.

### Tier 3 — Historical Record and Context (supports analysis, cannot produce a pick alone)
- FightMatrix Elo ratings
- MMA Payout / historical finish-rate aggregates
- MMA Mania / MMA Junkie fight previews
- Fighter coach/manager interviews (archived, clearly sourced)
- Academic / data analyst UFC stat aggregations

Tier 3 fills stylistic detail and historical context. Can elevate a LEAN toward a PICK when combined with strong Tier 1–2 evidence. Cannot independently produce a PICK.

### Tier 4 — Beat Reporters (conditional — triggers review, cannot create a pick)
- MMA Junkie / The Athletic / ESPN MMA / MMA Fighting reporters (real-name byline)

Can: confirm a replacement or cancellation (triggers BLOCKED or NO CLEAR PICK); flag a potential injury requiring Tier 1 follow-up; provide documented camp context when the reporter has a track record on this fighter.

Cannot: create a PICK direction; establish fighter statistics; override Tier 1 official information.

Beat reporter information is news, not evidence. It triggers re-research, not conclusions.

### Tier 5 — Social/Rumor (triggers review only, no other role)
- Fighter social media posts
- MMA Twitter/X speculation, whisper networks
- Fan/capper community opinion
- Anonymous "insider" leaks — not usable

Tier 5 can flag a situation for Tier 1 verification. It cannot confirm any fact. It cannot create a pick direction. If Tier 5 contradicts Tier 1, Tier 1 controls.

### Tier 6 — Market/Odds Board (confirms edge, never creates it)
- Kalshi UFC markets (price, volume, open interest, spread, bid/ask)
- Sportsbook odds (DraftKings, FanDuel, BetMGM, offshore)
- BestFightOdds, The Odds API — market consensus reference
- Sharp action signals / steam / line movement

Tier 6 establishes the tradable contract's existence and pricing. Consulted after the evidence package is built to confirm that modeled probability diverges from market-implied probability in the expected direction.

**Tier 6 cannot create, establish, or justify a pick direction.** See Section 6 for full rules.

---

## 6. Anti-Price-Only Rules

### Rule 1 — Price/Volume/OI/Line Movement Alone = MARKET_ONLY

The following produce MARKET_ONLY status, which is never PICK or EVIDENCE_LEAN:

- The only reason to consider a pick is significant line movement without an identified fighter-evidence reason
- Sharp bettor reportedly on one side (social/rumor tier)
- Open interest or volume concentration is the primary evidence
- Price is "too high" or "too low" compared to another book — arbitrage is not a fundamentals signal
- Price on a parlay leg looks attractive — each leg must pass independently
- Market-implied probability diverges from "what I expected" without a fighter model supporting the expectation

MARKET_ONLY is a dead end. It cannot be upgraded.

### Rule 2 — Market Data Can Confirm but Not Create Edge

After the evidence package is built, market price may be consulted to:
- Confirm that fundamentals-based edge exists at the current price (model: 65%, market: 55% → edge confirmed)
- Size the opportunity: tight market on a strong pick warrants less exposure
- Identify that the market has already priced in the edge (model: 65%, market: 64% → no trade, analysis was correct)

Market price cannot:
- Create an edge where fighter evidence is absent
- Validate a pick direction when fighter evidence is ambiguous
- Upgrade a LEAN to a PICK
- Override a NO CLEAR PICK produced by missing data

### Rule 3 — When Fundamentals Conflict with Price, Fundamentals Control

If fundamentals favor Fighter A but market heavily favors Fighter B:
- If fundamentals are strong, this is a potential PICK in the fundamentals direction
- If the price discrepancy is large enough to suggest missing information, escalate to WATCH, run a new source check, investigate the fighter-level signal before acting
- Do not bet against your own model because the market looks smarter. If you cannot find the fighter-level reason for the market's direction, either you are missing something (→ WATCH) or the market is wrong (→ potential edge)

Never downgrade a PICK to a PASS because price moved against you without finding a fighter-level reason.

### Rule 4 — When Incomplete Data Forces Downgrade

- If required inputs for a market are missing, the market cannot exceed LEAN regardless of price signal
- Strong price signal does not substitute for missing fighter data
- Fewer than 3 reviewed fights → fight winner capped at LEAN
- Style not classified → no method market can exceed LEAN
- Opponent quality unassessable → fight winner capped at LEAN

Incomplete data is not a reason to pick in the direction the data implies. It is a reason to wait or skip.

### Rule 5 — Mandatory NO CLEAR PICK Conditions

- **Late replacement:** fighter confirmed with <14 days notice → all that fighter's markets are NO CLEAR PICK
- **Missed weight cut:** fighter missed weight → all markets involving that fighter reevaluated; if miss >5 lbs or fighter showed visible distress at weigh-in → NO CLEAR PICK until explicit reassessment
- **Canceled/postponed bout:** all markets blocked
- **Unresolved injury rumor from Tier 4, no Tier 1 denial, <48 hours to event:** NO CLEAR PICK
- **Style and record for either fighter cannot be assessed from any available source:** NO CLEAR PICK on all markets
- **Active rule-set ambiguity (unknown commission, custom round structure):** NO CLEAR PICK until confirmed

### Rule 6 — News/Social Trigger Rules

When a Tier 4 beat reporter publishes fighter or fight information:
1. Flag all markets for that fight as WATCH/PENDING
2. Search for Tier 1 confirmation or denial in the next research cycle
3. If Tier 1 confirms → update market status per confirmed information
4. If no confirmation within 24 hours before event and rumor materially affects the pick → downgrade to LEAN or NO CLEAR PICK
5. A beat report alone never upgrades a pick. It can only trigger review or downgrade.

When a Tier 5 fighter social post suggests an issue:
1. Flag as WATCH
2. Do not create a pick from this signal alone
3. Monitor for Tier 1 or Tier 4 corroboration
4. If no corroboration arrives and fight proceeds normally → noise

---

## 7. UFC Report / Packet Required Fields

Every UFC market evaluation must produce a complete packet. No pick is valid without one. A single fight can produce multiple packets — one per market type. Do not combine markets in a single packet. Separate packets enforce separate evidence standards.

```
═══════════════════════════════════════════════════
UFC PREDICTION PACKET
═══════════════════════════════════════════════════

EVENT_NAME:
EVENT_DATE:
EVENT_UTC_TIMESTAMP:
CARD_TIER: [main card | prelim | early prelim]
BOUT_ORDER: [main event | co-main | bout N]
BOUT_STATUS: [confirmed | replacement flagged | injury watch | canceled]

FIGHTER_A:
FIGHTER_B:
WEIGHT_CLASS:
ROUNDS_SCHEDULED: [3 | 5]
TITLE_FIGHT: [yes | no]

MARKET_TYPE: [fight winner | KO-TKO | submission | decision | goes distance | round total | exact round | round group | fighter prop]
MARKET_TICKER: [Kalshi ticker]
CONTRACT_TERMS: [exact resolution language from the contract]

═══════════════════════════════════════════════════
SOURCES CHECKED
═══════════════════════════════════════════════════

TIER_1_OFFICIAL:
  - [source and what was confirmed]

TIER_2_STATS:
  - [source and what was pulled]

TIER_3_CONTEXT: [if used]
  - [source and purpose]

TIER_4_NEWS: [if triggered]
  - [reporter, outlet, date, claim]
  - [Tier 1 confirmation status: confirmed | denied | pending]

TIER_5_SOCIAL: [if triggered]
  - [source, content, action taken]

TIER_6_MARKET:
  - Kalshi price YES: ___ NO: ___
  - Spread: ___
  - Volume: ___
  - Last trade: ___

═══════════════════════════════════════════════════
MISSING INPUTS
═══════════════════════════════════════════════════

MISSING_TIER_1:
MISSING_TIER_2:
MISSING_REQUIRED_INPUTS: [each required input that could not be populated]
IMPACT_OF_MISSING: [how gaps affected research status]

═══════════════════════════════════════════════════
RESEARCH COMPLETENESS
═══════════════════════════════════════════════════

FIGHTER_A_RECORD_REVIEWED: [yes | partial | no] — [fight count + competition quality]
FIGHTER_B_RECORD_REVIEWED: [yes | partial | no] — [fight count + competition quality]
STYLE_CLASSIFIED_A: [yes | no]
STYLE_CLASSIFIED_B: [yes | no]
STYLE_MATCHUP_ASSESSED: [yes | no]
GRAPPLING_EDGE_ASSESSED: [yes | no]
STRIKING_DIFFERENTIAL_ASSESSED: [yes | no]
DURABILITY_ASSESSED_A: [yes | no]
DURABILITY_ASSESSED_B: [yes | no]
CARDIO_ASSESSED: [yes | no]
CAMP_CONTEXT_CLEAR: [yes | partial | no]
COMPETITION_QUALITY_TAGGED: [yes | partial | no]
FINISH_RATES_PULLED: [yes | partial | no] — [sample size + competition level]
FINISH_TIMING_DATA: [yes | partial | no] — [sample size]

COMPLETENESS_GRADE: [full | partial | insufficient]

═══════════════════════════════════════════════════
EVIDENCE SUMMARY
═══════════════════════════════════════════════════

PRIMARY_EDGE:
  [One sentence naming the specific advantage being bet on]

MECHANISM:
  [How the fight gets to the predicted outcome — step-by-step scenario]

SUPPORTING_SIGNALS:
  - [signal 1]
  - [signal 2]
  - [signal 3]

COUNTER_SIGNALS:
  - [what would have to go wrong for this pick to lose]

═══════════════════════════════════════════════════
PICK AND CONFIDENCE
═══════════════════════════════════════════════════

RESEARCH_STATUS: [PICK | EVIDENCE_LEAN | LEAN | NO CLEAR PICK | BLOCKED | WATCH | MARKET_ONLY]
DIRECTION: [Fighter A | Fighter B | YES | NO | OVER | UNDER]
FAIR_PROBABILITY: [0.00–1.00]
MARKET_PROBABILITY: [0.00–1.00 — derived from price, not from belief]
EDGE_PP: [fair minus market, in percentage points]
CONFIDENCE: [0.0–1.0]

═══════════════════════════════════════════════════
ANTI-PRICE JUSTIFICATION
═══════════════════════════════════════════════════

PRICE_CONSULTED_AFTER_RESEARCH: [yes | no — if no, explain]
PICK_DRIVEN_BY_FUNDAMENTALS: [yes | no]
PRICE_ROLE: [confirms edge | neutral | not applicable]
PRICE_ONLY_SIGNALS_REJECTED: [list any price signals seen but not used to drive the pick]
STATEMENT: "This pick is based on [primary evidence]. Price was consulted after the evidence
package was assembled to confirm edge. Price alone would not have produced this pick."

═══════════════════════════════════════════════════
NO-PICK REASON (if applicable)
═══════════════════════════════════════════════════

NO_PICK_REASON:
  - [specific missing data element]
  - [or the market condition that prevents a pick]
  - [or the flag that forces NO CLEAR PICK]

═══════════════════════════════════════════════════
FLAGS
═══════════════════════════════════════════════════

LATE_REPLACEMENT: [yes — fighter name, days notice | no]
FAILED_WEIGHT_CUT: [yes — fighter name, amount over | no]
MISSED_WEIGHT_EFFECT_ON_PICK: [re-evaluated on [date] | not applicable]
CANCELED_BOUT: [yes | no]
INJURY_RUMOR: [yes — source tier, claim, Tier 1 status | no]
WEIGHT_CLASS_CHANGE: [yes — fighter, prior class, new class | no]
SHORT_NOTICE_CARD_NOTE: [if multiple replacements on card]
OTHER_FLAGS:

PACKET_GENERATED_AT_UTC:
NEXT_RECHECK_UTC: [set when WATCH or PENDING]
═══════════════════════════════════════════════════
```

### Confidence Score Guidance

| Score | Interpretation | Allowed output |
|---|---|---|
| 0.85–1.00 | Strong evidence package, clear edge, no unresolved flags | PICK |
| 0.70–0.84 | Solid evidence, minor gaps, clear direction | EVIDENCE_LEAN (upgradeable to PICK if Kalshi spread/liquidity acceptable) |
| 0.50–0.69 | Meaningful evidence, material gaps, direction exists but not actionable alone | LEAN |
| 0.30–0.49 | Thin evidence, high uncertainty | LEAN or NO CLEAR PICK |
| 0.00–0.29 | Insufficient data or contradictory signals | NO CLEAR PICK or BLOCKED |

Confidence score does not independently produce a PICK. The evidence package must pass each market's mandatory data threshold first. The score is a summary, not a gate-bypass.

---

## 8. Research Cadence

| Phase | Timing | Actions |
|---|---|---|
| Card release | 4–6 weeks out | Inventory all bouts. Pull preliminary fight records. Tag late bookings, replacements, mismatches. No picks. Output: PRELIMINARY ROSTER. |
| Pre-fight week | 7–2 days out | Kalshi markets typically open. Capture market structure, rules, contract terms. Begin full research packets for main card + key prelims. Assign preliminary statuses. Monitor Tier 4 for camp/injury/weight news. |
| Weigh-in day | Day before event | Confirm official weigh-in results from Tier 1. Failed weight cut → immediate reassessment of all affected markets. Pull-out/replacement → NO CLEAR PICK for replacement's markets. Finalize all packets. Do not finalize picks before weigh-in completes. |
| Fight day | Up to bout time | Final confirmation both fighters present and cleared. Late Tier 4 news → WATCH status. Refresh market prices, confirm spread/liquidity. No new research after this point — unresolved questions are NO CLEAR PICK, not guesses. |

---

## 9. Weight Class Finish Rate Reference

Use as calibration only — not a substitute for fighter-specific data.

| Weight class | UFC finish rate (approx.) | Primary finish method |
|---|---|---|
| Heavyweight | 60–70% | KO/TKO dominant |
| Light heavyweight | 55–65% | KO/TKO dominant |
| Middleweight | 50–60% | KO/TKO, some submission |
| Welterweight | 45–55% | Mixed |
| Lightweight | 45–55% | Mixed, submission elevated |
| Featherweight | 40–50% | Mixed |
| Bantamweight | 35–45% | Mixed, lower finish rate |
| Flyweight | 30–40% | Decision dominant |
| Women's divisions | 30–50% by class | Lower than equivalent men's class |

A 50% finish rate means different things at heavyweight vs. flyweight. Always contextualize fighter finish rates against their weight class average.

---

## 10. Status Definitions

| Status | Meaning |
|---|---|
| PICK | Full evidence package present, all mandatory thresholds met, clear edge identified, no unresolved flags |
| EVIDENCE_LEAN | Solid evidence, minor gaps, directional, upgradeable to PICK with price confirmation and clean Kalshi contract |
| LEAN | Evidence exists but material gaps remain; not actionable alone; useful for tracking |
| NO CLEAR PICK | Data insufficient, flags unresolved, or market type requires specific evidence that is absent |
| BLOCKED | Required Tier 1 source unavailable, or hard flag (late replacement, failed weight cut, cancellation) in place |
| WATCH | Pending information that could change the status; not yet pickable; set next recheck time |
| MARKET_ONLY | Price/market signals observed; no fighter evidence supports a pick; ineligible for trading |

---

## 11. Implementation Recommendation

### Files Likely to Change Later

| File | Change needed |
|---|---|
| `scripts/packets/generate-ufc-weekly.mjs` | Wire source adapter results into `checked` fields (lines 30–61). Currently all forced to `false`/`true` manually. |
| `scripts/shared/decision-process.mjs` | No structural change needed. UFC already registered as `MARKET_TYPES.SPORTS_GAME` with full 6-item checklist. |
| `scripts/packets/lib/kalshi-discovery.mjs` | No change needed. UFC already registered in `KALSHI_SOURCES`. |

### Files to Create Later

| File | Purpose |
|---|---|
| `scripts/ufc/source-adapters/fighter-stats-readonly.mjs` | Pull UFCStats.com via `ufcscraper`. Return fighter record, finish rates, round timing, career strikes/TDs. |
| `scripts/ufc/source-adapters/injury-status-readonly.mjs` | Scrape UFC.com fighter status page, ESPN API for card status. Detect late replacements, weight misses. |
| `scripts/ufc/source-adapters/rankings-readonly.mjs` | Pull UFC.com `/rankings`. Weekly cadence. |
| `scripts/ufc/source-adapters/odds-readonly.mjs` | BestFightOdds (via `ufcscraper`) or The Odds API. Returns market-implied probabilities, not pick signals. |
| `scripts/ufc/source-adapters/scorecards-readonly.mjs` | MMADecisions.com. Returns judge scorecard history and per-fighter decision tendency. |
| `scripts/ufc/source-adapter-dry-run.mjs` | Orchestrator — mirrors `scripts/mlb/source-adapter-dry-run.mjs`. Calls all adapters, writes to `state/ufc/{date}/discovery/`. |

### Tests to Add Later

| Test file | Covers |
|---|---|
| `test/ufc-source-adapters.test.mjs` | Each adapter returns expected envelope shape: `{ ok, records, warnings, errors, cache_key, source_urls }` |
| `test/ufc-decision-process.test.mjs` | SPORTS_GAME checklist: all 6 items required for EVIDENCE_LEAN; missing `evidence_supported_side` caps at WATCH |
| `test/ufc-packet-renderer.test.mjs` | Packet renders correctly with missing vs. complete source data |

### How to Preserve the Shared Decision-Process Layer

The shared `decision-process.mjs` does not need modification. UFC is already registered. Source adapters must write their outputs into the `checked` object using the existing key names:

- `checked.projected_participants` — set from Kalshi event + Tier 1 card confirmation
- `checked.lineup_injury_news` — set from injury-status adapter (Tier 1 + Tier 4 sweep)
- `checked.venue_context` — set from Kalshi event or ESPN API card metadata
- `checked.recent_form_matchup` — set from fighter-stats adapter (fight records pulled, styles assessed)
- `checked.market_board_context` — already set from Kalshi discovery
- `checked.evidence_supported_side` — set only when style matchup + finish-rate analysis are complete and unambiguous; never set on price signals

### How to Avoid Breaking MLB, Mentions, NASCAR, Politics

- Add `scripts/ufc/` as a new directory — nothing to move or rename
- The UFC packet generator is already isolated at `scripts/packets/generate-ufc-weekly.mjs`
- Shared files (`decision-process.mjs`, `kalshi-discovery.mjs`, `common.mjs`) are not modified — UFC source adapters call into them, they don't change them
- Run existing test suite before and after any UFC adapter work: `npm test` covers decision-process, MLB, and NASCAR

### Recommended Next `/goal` Prompt

```
Implement UFC Phase A — source adapters.

Create:
  scripts/ufc/source-adapters/fighter-stats-readonly.mjs
  scripts/ufc/source-adapter-dry-run.mjs
  test/ufc-source-adapters.test.mjs

The fighter-stats adapter should call UFCStats.com using the ufcscraper
PyPI package (or equivalent Node.js fetch of static HTML) to return:
  - Fighter record (W/L/D/NC) with method breakdown
  - Per-fight history: opponent, result, method, round, time, date
  - Career finish rates (KO/TKO, submission, decision) as percentages
  - Average control time and significant strike volume (career)

Envelope shape: { ok, records, warnings, errors, cache_key, source_urls }

Wire the dry-run orchestrator to call fighter-stats-readonly for both
fighters in each Kalshi UFC event and write results to
state/ufc/{date}/discovery/{event_ticker}.json.

Do not modify:
  scripts/shared/decision-process.mjs
  scripts/packets/lib/kalshi-discovery.mjs
  scripts/packets/lib/common.mjs
  Any MLB, NASCAR, politics, mentions, or trading files.

After the adapter is wired, update generate-ufc-weekly.mjs to read
discovery artifacts and set checked.recent_form_matchup = true when
both fighters have ≥3 reviewed fights with opponent quality tagged.
```

---

## 12. Single-Line Anti-Price Commitment

Every packet must include this statement, tailored to the specific pick:

> "This market was evaluated by building the evidence package before consulting price. The pick direction was determined by fighter-level evidence. Price was checked only to confirm that market-implied probability diverges from modeled probability in the expected direction. Price movement, volume, open interest, and line movement played no role in determining the pick direction and cannot independently support this pick."

If that statement cannot be made truthfully, the market is MARKET_ONLY.

---

*A card with zero clean PICK-status markets is a valid outcome. Forcing a pick to fill the card is the single most common failure mode this standard is designed to prevent.*
