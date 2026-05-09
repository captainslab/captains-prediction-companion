---
name: captain-mentions-research-system
description: Use when researching Captain mention markets as future-language proof markets with rules-first exact-string evidence, transcript/context updates, MixMCP, trade gates, live plans, and settlement proof.
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [captain, mentions, prediction-markets, exact-string, transcripts, mixmcp, firecrawl]
    related_skills: [mentions-market-picks, research-source-scraping, market-research-discovery-and-verification, kalshi-market-routing-and-board-state]
---

# Captain Mentions Research System

## Prime directive

Do not predict whether the topic matters.

Predict whether the eligible speaker says the exact resolving string, inside the event window, with accepted proof.

Use the market as the prior. Use transcript and context evidence as the update. Use MixMCP to dampen overreaction. Use Captain TV to trade only when edge survives.

## Master research order

For every mention market, work in this order:

1. Contract rules
2. Exact resolving word mechanics
3. Eligible speaker / event window
4. Primary transcript or video sources
5. Historical word-match evidence
6. Current context: why the word exists now
7. Prompt-force path
8. Speaker register and paraphrase risk
9. Market price as prior
10. MCP / MixMCP calibrated update
11. Captain TV / edge / LSP / max entry
12. Live trading plan
13. Settlement proof plan

## Market types

Identify the type first:

- NEWMENTION / PRESMENTION
- MENTION / POLMENTION
- EARNINGSMENTION
- SPORTSMEMENTION / SPORTSMENTION
- Trump/politician remarks
- creator/podcast/livestream/interview
- other event-specific variant

## Exact word rules

Counts by default:

- exact word / exact phrase
- plurals
- possessives
- open compounds
- hyphenated compounds
- homonyms
- homographs
- ordinal forms when number is part of strike
- reasonable transliteration variants

Does not count by default:

- synonyms
- homophones
- different roots
- tense / grammatical inflections
- closed compounds that swallow the word
- foreign-language equivalents unless rules allow

Examples:

- Immigrant -> Immigrants counts.
- Immigrant -> Immigration does not count.
- Fire -> Fire station counts.
- Fire -> Firetruck does not count.
- Write -> write counts.
- Write -> right does not count.

## Required internal artifacts

### A. Event Snapshot

```text
Event name:
Market type:
Date/time/time zone:
Platform/network:
Eligible speaker(s):
Event window:
Format:
Prepared remarks?
Q&A?
Moderator/host?
Broadcast segments?
Primary resolution source:
Board keywords:
Current YES prices:
NO¢ = 100 - YES¢:
Missing inputs:
```

### B. Primary Sources Table

```text
| Source Type | Publisher | Posted | Link | Notes |
|-------------|-----------|--------|------|-------|
| Transcript  |           |        |      |       |
| Video       |           |        |      |       |
| Rules       |           |        |      |       |
| Context     |           |        |      |       |
```

### C. Strike Evidence Log

```text
| Strike | Exact Match History | Segment | Speaker | Current Driver | Why Word Exists | Near-Miss Risk | Evidence Quality |
|--------|--------------------|---------|---------|----------------|-----------------|----------------|------------------|
```

### D. Market Prior / MCP / MixMCP Board

```text
| Strike | YES¢ | p_mkt | Evidence TV | p_mcp | alpha | Mix TV | Edge | Market Read | Pick Gate |
|--------|-----:|------:|------------:|------:|------:|-------:|-----:|-------------|-----------|
```

### E. Live Playbook

```text
| Strike | Side | Buy Signal | Kill Switch | De-risk Signal | LSP |
|--------|------|------------|-------------|----------------|----:|
```

## True value model

Captain TV uses:

```text
Pd = Door probability
Ph = Exact-string hit rate if the door opens
Pe = Eligibility / evidence risk
Ptrue = Pd * Ph * Pe
TV = round(100 * Ptrue)
```

Definitions:

- Pd: chance the topic or segment appears.
- Ph: chance the eligible speaker says the exact resolving string once the topic appears.
- Pe: chance the speaker, segment, and source count under the rules.

Trading math:

```text
NO¢ = 100 - YES¢
YES Edge = TV - YES¢
NO Edge = (100 - TV) - NO¢
LSP YES pick = TV
LSP NO pick = 100 - TV
Max Entry YES = TV - EdgeThreshold
Max Entry NO = (100 - TV) - EdgeThreshold
```

## MCP / MixMCP

MCP treats market-implied probability as the prior and asks the model/process to update with textual evidence. Do not forecast from scratch.

```text
p_mkt = YES price / 100
p_mcp = evidence-based posterior after rules + transcript + news/context + exact-word + register + event-structure review
p_mix = alpha * p_mkt + (1 - alpha) * p_mcp
Mix TV = round(100 * p_mix)
```

Default alpha:

- earnings: 0.70
- sports: 0.75-0.90
- speeches/interviews/hearings: 0.65-0.80 depending on evidence quality
- hard near-0 or near-100 prices: 0.90-0.95

Price-band alpha anchors:

```text
0-10 YES¢: alpha 0.90-0.95; hard anchor, lottery unless direct evidence
10-30 YES¢: alpha 0.80-0.90; require clear exact path
30-50 YES¢: alpha 0.70-0.80; context can matter
50-70 YES¢: alpha 0.60-0.70; best MCP zone
70-90 YES¢: alpha 0.75-0.85; market likely knows something
90-99 YES¢: alpha 0.90-0.95; avoid unless proof risk mispriced
```

## Why-this-word-exists module

For every strike, answer: why is this word on the board?

Possible drivers:

- core event theme
- official materials
- prior transcripts
- current news catalyst
- product or policy
- player/coach/venue/sponsor name
- host prompt
- recurring catchphrase
- legal/regulatory issue
- market-maker bait word

## Prompt-force analysis

Identify who/what can force the exact word.

- Earnings: analysts can force themes, but analyst-only does not count unless exec repeats.
- Trump/politician: reporter/host/moderator can force, but eligible speaker must repeat exact word.
- Sports: game script can force injury, replay, venue, milestone, sponsor, or endgame words.
- Creator: guest, title topic, superchat, sponsor, breaking news, or recurring bit can force.

## Register / paraphrase risk

Topic door can open and still fail if the speaker uses a substitute. If the speaker habitually uses the substitute, haircut Ph.

Examples:

- artificial intelligence -> AI
- tariff -> duties / import costs
- layoffs -> restructuring / efficiency
- inflation -> prices / cost of living
- immigrant -> migrant / illegal alien
- war -> conflict / operation
- crypto -> digital assets
- subscription -> recurring revenue
- affordable -> cheaper / lower cost
- buzzer -> horn

## Event-type branches

### Earnings mentions

Required steps:

1. Parse contract/rules.
2. Capture board strikes and YES prices.
3. Compute NO¢.
4. Pull current-quarter materials: earnings release, shareholder letter, slide deck, 8-K, prepared remarks if available.
5. Pull last 4 quarterly transcripts by default; expand to 6 if seasonal/volatile.
6. Run strict word match on every strike.
7. Separate exec/company speaker hits, analyst-only hits, and document-only hits.
8. Search company + word to find why the word is there.
9. Build transcript evidence block T.
10. Build news/context block N.
11. Run MCP.
12. Apply MixMCP.
13. Compute TV, edge, LSP, max entry.
14. Build live playbook.

Evidence labels:

- Prepared-locked: word appears in release/letter/deck and prior prepared remarks.
- Q&A-forced: analysts ask and executives repeat exact word.
- Analyst-only: bad evidence unless eligible company speaker repeats.
- Document-only: context only unless rules allow written materials.
- Rare/avoidable: topic exists, management usually uses another term.

Earnings sources:

- Company Investor Relations
- earnings release/shareholder letter/slide deck
- 8-K / SEC EDGAR
- official company transcript if available
- backups: Seeking Alpha, Motley Fool, Quartr, roic.ai, Earnings Calls app

Common traps:

- AI vs artificial intelligence
- tariff vs duties / import costs
- layoffs vs restructuring / efficiency
- subscription vs recurring revenue
- crypto vs digital assets
- inflation vs pricing pressure
- ad tier vs advertising plan

### Trump mentions

Primary source: RollCall.com / Factba.se Trump transcript search/archive.

Source priority:

1. RollCall.com / Factba.se Trump transcript search
2. RollCall.com / Factba.se transcripts by event type
3. RollCall.com / Factba.se individual transcript pages
4. White House remarks / official event page
5. C-SPAN video
6. AP / NYT / Reuters / Bloomberg transcript or quote coverage
7. American Presidency Project
8. Campaign site / Truth Social / official releases
9. YouTube captions as backup only

Steps:

1. Parse contract rules.
2. Capture board and YES prices.
3. Convert YES¢ to p_mkt.
4. Pull last 5 same-format Trump remarks, last 5 same-topic remarks, and last 7-14 days of remarks.
5. Word-match each strike exactly.
6. Tag hit format: formal address, rally, roundtable, presser, interview, gaggle, ceremonial remarks.
7. Build current context: event theme, guest list, venue/state, current news, repeated riffs, policy cycle.
8. Identify Trump pivot paths.
9. Run MCP, MixMCP, TV, LSP, edge, max entry.
10. Build live playbook and correlation stacks.

Traps:

- rally-only phrase in formal speech
- topic comes up but exact word is replaced
- reporter says it, Trump does not repeat
- guest/other speaker says it
- name strike needs random shoutout
- foreign-policy cluster opens but exact country is skipped
- nickname instead of listed word

### Standard politician / content creator

Politician flow:

1. Parse rules.
2. Identify eligible speaker.
3. Identify format: speech, debate, hearing, presser, interview, town hall, rally.
4. Pull same-format transcripts.
5. Pull current event context.
6. Map likely prompt paths.
7. Word-match exact strikes.
8. Separate eligible speaker from moderator/reporter/opponent.
9. Score register risk.
10. Apply MCP / MixMCP.

Hearing/testimony special flow:

1. Committee title
2. Witness list
3. Prepared testimony
4. Chair/ranking member framing
5. Party attack lines
6. Prior related hearings
7. Exact speaker eligibility

Main trap: committee member says word but witness/eligible speaker does not.

Creator flow:

1. Parse rules.
2. Identify eligible speaker: host, guest, caller, panelist.
3. Pull last 5-10 same-format episodes.
4. Search exact board words in YouTube captions, title, description, show notes, podcast transcript.
5. Treat chat/superchat as weak prompt evidence only.
6. Identify guest-driven topics, sponsor/ad-read paths, catchphrases, recurring rants.
7. Apply MCP / MixMCP.

### Sports announcer mentions

Treat as broadcast mechanics, not just word frequency.

Steps:

1. Parse sports mention rules.
2. Confirm network/platform.
3. Confirm eligible broadcast crew: play-by-play, analyst, sideline, studio only if rules allow.
4. Check both team rosters.
5. Check coaches.
6. Check venue and sponsor branding.
7. Check injury report.
8. Check game notes/storylines.
9. Pull same-booth comparable games.
10. Generate/search captions if no transcript exists.
11. Segment-map word paths.
12. Apply MCP with stronger market anchoring.

Sports alpha: 0.75-0.90 because game script is volatile and transcript quality is weaker.

Segment map:

- pregame/open: venue, weather, records, stakes, sponsor, star players
- early game: injuries, matchups, coaches, form
- replay/review: penalty, foul, catch, no good, challenge
- injury timeout: medical terms, questionable players, return status
- halftime: stats, storylines, schedule
- endgame: timeout, clock, buzzer, horn, foul, free throw
- blowout: bench, rookies, rest, next schedule

## Trade discipline

The system is trade-first, not prediction-first. NO TRADE is valid.

Minimum edge thresholds:

```text
Earnings Call: 10¢
Speech / Interview: 12¢
Hearing / Testimony: 12¢
Rally / Remarks: 12¢
Sports Broadcast: 15¢
```

Hard skips:

- YES 95-99¢: usually NT unless proof risk is mispriced.
- YES under 10¢: usually NT unless real live spike path.
- Narrow/replaceable wording: require larger edge.
- Analyst-only / moderator-only / guest-only: usually NT unless rules allow.
- Topic likely but exact word shaky: usually NT or watch live.
- Correlated cluster: cap exposure.

Output states:

- TRADE
- WATCH LIVE
- NO TRADE
- FADE SPIKE
- NEEDS PROOF

## Correlation stacks

Group correlated strikes for exposure control.

Examples:

- Earnings AI stack: AI / data center / capex / cloud
- Earnings consumer stack: Prime / advertising / subscription / holiday
- Macro stack: tariff / inflation / China / supply chain
- Border stack: border / immigrant / illegal alien / fentanyl
- Culture stack: DEI / woke / transgender / Title IX
- Foreign policy stack: Iran / Israel / terrorist / hostage
- Sports injury stack: questionable / knee / return / trainer
- Sports venue stack: sponsor / arena / city / weather

## Live trading framework

For every best pick define:

- entry zone
- LSP
- buy signal
- de-risk signal
- kill switch
- how it loses

## Settlement proof plan

Track post-event proof separately:

```text
| Strike | Claimed Result | Proof Source | Timestamp | Speaker | Exact Text | Confidence |
|--------|----------------|--------------|-----------|---------|------------|------------|
```

Proof hierarchy:

1. Official transcript
2. Accepted source agency transcript
3. Full video with timestamp
4. Network transcript
5. YouTube captions only as lead
6. Social clips only as backup

## Backtesting / calibration

Log forecasts:

```text
| Date | Event | Strike | YES¢ | p_mkt | Evidence TV | p_mcp | Mix TV | Pick | Result | Brier |
|------|-------|--------|-----:|------:|------------:|------:|-------:|------|--------|------:|
```

Brier = (forecast probability - outcome)^2.

Monthly review:

```text
| Event Type | N | Market Brier | Evidence TV Brier | MCP Brier | MixMCP Brier | Best alpha |
|------------|--:|-------------:|------------------:|----------:|-------------:|-----------:|
```

## Final internal output packet

Before producing any public guide, produce:

1. Event Snapshot
2. Contract / Rule Mechanics
3. Primary Sources
4. Transcript Collection Plan
5. Strict Word-Match Grid
6. Context Driver Log
7. Why This Word Exists Log
8. Prompt-Force Map
9. Paraphrase / Dodge Map
10. Market Prior Board
11. Evidence TV Board
12. MCP Forecast Board
13. MixMCP Final TV Board
14. Trade Gate
15. Live Playbook
16. Correlation Stacks
17. Settlement Proof Plan
18. Backtest / Calibration Log

## Verification checklist

- [ ] Exact user-provided link preserved.
- [ ] Contract rules checked before probability work.
- [ ] Eligible speaker/event window/source identified.
- [ ] Exact word mechanics and aliases listed.
- [ ] Current market prices captured or labeled missing.
- [ ] Historical exact-word evidence separated from current context.
- [ ] Prompt-force and paraphrase risk mapped.
- [ ] p_mkt, p_mcp, alpha, p_mix, TV, edge, LSP, max entry calculated.
- [ ] Output state chosen with hard skip rules enforced.
- [ ] Live plan and settlement proof plan included for any trade/watch.
