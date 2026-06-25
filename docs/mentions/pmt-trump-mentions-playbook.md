# PMT Trump Mentions Playbook

## Purpose

This document mines public full-video transcripts from PredictionMarketTrader's channel and turns them into a CPC-ready heuristic layer for Trump mention markets.

The goal is not to copy a style surface. The goal is to extract the repeatable rules PMT appears to use when handicapping Trump mention markets, then map those rules into CPC concepts that can later be wired into Trump mention packets.

The playbook also includes PMT's broader prediction-market guidance so CPC can learn general mentions trading heuristics, not only Trump-specific ones.

## Source Inventory

Channel scan:
- Full channel flat-playlist inventory: 219 uploads.
- Title-matched relevance slice: 165 uploads matched Trump, White House, rally, speech, press, signing, interview, live-trading, or general prediction-market strategy keywords.

Readable full-video transcript sample used for this playbook:

| Video | Role | Transcript | Why it matters |
|---|---|---|---|
| `yu--taGiDBQ` - `TRUMP G7 PRESS CONFERENCE` | Trump presser / summit-style event | Readable auto-captions | Format priors, current-news override, event comparison to prior G7 format |
| `lahki5GjV5A` - `TRUMP SIGNS SECURE AMERICA ACT` | White House / signing remarks | Readable auto-captions | Early timing, open-press/Q&A risk, topic family selection |
| `Ve5Ps_3YcAM` - `TRUMP FLORIDA RALLY` | Rally | Readable auto-captions | Venue/audience priors, rally-mode Trump, topic crowding, obvious-narrative caution |
| `wqYpjejFoEI` - `Making $800 Live Trading a Trump Mention Market` | Live Trump mention trade | Readable auto-captions | Live-event timing, Q&A path, earlier entry while the event is still unfolding |
| `rRuIgO84OF0` - `Inside the mind of a $600K Prediction Market Trader` | General trading philosophy | Readable auto-captions | Niche selection, edge discipline, transcript use, current-event overrides, data-heavy vs vibes-heavy lanes |
| `j0XPOxZ-ZPo` - `I Interviewed the Top Mention Market Trader on Kalshi` | General mentions trading philosophy | Readable auto-captions | One-niche focus, Trump-only focus early on, historical transcript use, exact wording, crowding awareness |
| `TOCgj28XJFM` - `Kalshi Explained (Step-by-Step Trading Guide)` | General market mechanics | Readable auto-captions | Contract rules, order book reading, maker/taker intuition, why rules matter |
| `kCafX_WhgxA` - `How to Profit on Prediction Markets` | General strategy | Readable auto-captions | Niche specialization, research habits, contract summary discipline, avoiding forced edges |
| `_zDTyxzaLfk` - `$400 -> $35K Predicting What People Would Say` | General mentions edge story | Readable auto-captions | Rule deep-dive, exact wording, learning from 100x mistakes, live mention-market intuition |

Skipped or low-value for this playbook:
- `kydYa1Im77Y` - `TRUMP RALLY TO END ALL RALLIES` had no readable captions from the local transcript path.
- Many other uploads are useful context, but the playbook below is grounded in the full transcript subset above rather than trying to treat the whole 219-video corpus as equally signal-rich.

Evidence support note:
- This playbook only uses public channel transcripts, public titles, and transcript availability checks.
- The inventory below proves transcript availability and sampling coverage only; it does not claim exhaustive heuristic extraction from every readable relevant upload.
- The safety auditor flagged a separate repo-level issue in an unrelated patch set: the repo contains existing MLB posture logic that uses market price structure. That is outside this research document and is not used here.
- No claim below should be read as PMT-said-so unless the transcript list or timestamp note supports it.

## PMT Trump Mental Model

PMT does not seem to handicap Trump mention markets as generic "will Trump say X" bets.

He appears to think in four layers:

1. Event format first.
2. Current news shock second.
3. Exact wording / settlement fit third.
4. Crowd behavior fourth.

For Trump, he treats the speaker as highly drift-prone. A first-term-style prior is not enough if today's event has a different audience, venue, or news backdrop.

General mentions lesson:
- Trump is a high-vibes speaker in PMT's framing, but not random.
- The best read comes from combining current-event context with speaker-specific phrasing history and event format.

## Event-Type Rules

### Rally

Rally handicapping is audience-led.

Observed rules:
- Venue and crowd determine the most likely topic families.
- Trump rally mode is different from press conference mode.
- PMT expects Trump to talk a lot, but not uniformly about every strike on the board.
- Obvious rally narratives can already be crowded, so consensus-heavy setups need caution.

Evidence:
- `Ve5Ps_3YcAM` - `TRUMP FLORIDA RALLY`:
  - ~01:10-03:35, 02:13-04:30, 03:41-05:20
  - PMT ties the expected wording to the Villages audience, social security, healthcare, Democrats/Biden, Iran, and rally-mode Trump.
- `Ve5Ps_3YcAM`:
  - 01:40-01:57, ~03:06-03:12, 03:44-04:04
  - He treats a consensus-heavy setup as a warning sign.

### Press Conference

Press conferences are format-sensitive and question-driven.

Observed rules:
- PMT compares the event to analogous prior pressers rather than using a generic Trump prior.
- He watches current geopolitical/news developments right before the event.
- He expects the Q&A path to shape word selection.

Evidence:
- `yu--taGiDBQ` - `TRUMP G7 PRESS CONFERENCE`:
  - 00:31-02:04, 03:16-03:36, ~07:30-08:30
  - He anchors on the press-conference format, uses a similar 2019 G7 prior, and adjusts for oil/Iran/current-deal chatter.
- `yu--taGiDBQ`:
  - 00:51-01:40, ~01:33-02:17, 02:22-02:29
  - Current events are moving the expected word set before Trump even starts.

### White House / Signing Remarks

Signings and White House remarks are more formal, but they can still turn into long Q&A events.

Observed rules:
- Early timing is a real signal.
- Open-press signings can stretch into longer question periods.
- The likely topics are driven by the bill or event title, but Trump can still drift into broader rants.

Evidence:
- `lahki5GjV5A` - `TRUMP SIGNS SECURE AMERICA ACT`:
  - 00:19-01:17, ~02:26-04:28
  - PMT notes that the early morning time is unusual for Trump and expects a delayed, more open session.
- `lahki5GjV5A`:
  - ~04:13-04:28, 05:45-06:35
  - He maps the signing to border/security topics and notes the Q&A path can pull in Iran, border, and Biden-style rants.

### Formal Speech

Formal speeches are more structured than rallies, but they are still not fixed.

Observed rules:
- The speech topic family matters, but Trump can still wander.
- PMT checks whether the event is likely to stay in prepared remarks or slide into Q&A and live commentary.

Evidence:
- `wqYpjejFoEI` - `Making $800 Live Trading a Trump Mention Market`:
  - 00:31-02:08, ~03:19-04:30, 04:41-05:10
  - PMT uses the live setting to decide whether questions will extend the event and give the market more time to resolve.

### International Summit / G7 / NATO-Style Event

This is a comparable-prior problem, not a simple Trump-prior problem.

Observed rules:
- Use the closest same-format prior, not just the same speaker.
- Check whether the format is solo, bilateral, joint press conference, or a larger summit event.
- Geopolitical shock in the background can dominate the wording.

Evidence:
- `yu--taGiDBQ` - `TRUMP G7 PRESS CONFERENCE`:
  - 01:47-03:20, 03:24-03:36, ~07:30-08:30
  - PMT compares the event to a prior G7 press conference and treats the format as its own signal.
- `yu--taGiDBQ`:
  - 00:51-01:40 and ~01:33-02:17
  - Iran and oil move the setup immediately before the event.

### Live / Current-Event Shock

This is the most important Trump-specific modifier.

Observed rules:
- Fresh news can override old priors minutes before the event.
- PMT watches external market reactions and news flow in real time.
- He updates the expected word set when the backdrop changes.

Evidence:
- `yu--taGiDBQ`:
  - 00:51-01:40, ~01:33-02:17, ~07:30-08:30
  - Iran, oil, and the deal backdrop change what words are likely.
- `Ve5Ps_3YcAM`:
  - ~02:48-03:08, 02:39-03:20, 05:06-05:35
  - He repeatedly cross-checks live headlines and event context while reading the board.

## Trump-Specific Heuristics

These are the repeatable heuristics CPC should learn from PMT's Trump work:

- Exact wording beats broad topic. PMT repeatedly looks for the literal word family and the wording path, not just the theme.
- Fresh news can override old priors. If the backdrop changes, Trump's likely language changes.
- Event format changes word likelihood. Rally, signing, press conference, bilateral, and summit formats behave differently.
- Trump repeats certain phrases, but he can drift fast. Historical phrase frequency helps, but it is not enough alone.
- Audience and venue matter. Retirement crowd, border event, summit, or White House signing each create different expected topic families.
- Contract rules decide settlement fit. The question is not "is the topic relevant" but "does this exact wording satisfy the settlement text."
- Obvious narratives can be crowded. If the board already reflects the story, PMT treats it as a warning.
- NT / skip is valid. Thin edge, weak transcript support, or bad crowding should produce no trade, not a forced opinion.

## General Mentions Tactics PMT Uses Across All Lanes

These are not Trump-only. They apply to all mention markets.

- Pick a niche and stay in it.
  - `rRuIgO84OF0`, `j0XPOxZ-ZPo`, `kCafX_WhgxA`
  - PMT repeatedly says he focuses on one lane and ignores adjacent markets he does not know.
- Use transcripts and comparable history.
  - `rRuIgO84OF0`, `j0XPOxZ-ZPo`, `TOCgj28XJFM`
  - Historical transcripts are a core tool, not optional decoration.
- Read the contract rules before forming an opinion.
  - `TOCgj28XJFM`, `_zDTyxzaLfk`
  - The literal payout text matters more than the title.
- Separate prepared remarks from Q&A.
  - `yu--taGiDBQ`, `lahki5GjV5A`, `wqYpjejFoEI`
  - The live question path often changes the board.
- Treat current events as a first-order input.
  - `rRuIgO84OF0`, `yu--taGiDBQ`, `Ve5Ps_3YcAM`
  - Old priors can be overrun by breaking news.
- Avoid forced action when the edge is thin.
  - `rRuIgO84OF0`, `kCafX_WhgxA`
  - PMT is explicit that pass/no-trade is part of the process.
- Recognize lane differences.
  - `rRuIgO84OF0`
  - He frames earnings as more data-heavy, Trump as more vibes-heavy, and announcer markets as hybrid or location-sensitive.

## CPC Implementation Map

### Proposed Fields

Reuse existing route and synthesis fields first:
- `researchProvenance.research_route`
- `route_basis`
- `route_entity`
- `route_horizon`
- `terms[].research_term_note`
- `terms[].research_reason`
- `terms[].proof_pct`
- `terms[].handicap_pct`
- `terms[].kalshi_native_pct`
- `terms[].kalshi_native_n`
- `summary.source_backed_count`
- `summary.proximity_only_count`
- `synthesis_rules.no_trade`

If Trump-specific priors need explicit transport, add:
- `recent_language_prior`
- `event_format_prior`
- `live_timing_prior`
- `overpriced_story_warning`
- `audience_context`
- `current_news_shock`

### Proposed Route / Lane Logic

Likely touch points:
- `scripts/mentions/mention-route-resolver.mjs`
  - Keep Trump events on `trump_*` routes and preserve venue/format distinctions.
- `scripts/mentions/source-priority-registry.mjs`
  - Ensure Trump/White House source lanes stay prioritized when the event is Trump-specific.
- `scripts/mentions/lexical-gate.mjs`
  - Use the gate to fail closed when there is no evaluable evidence.
- `scripts/mentions/source-ladder.mjs`
  - Add or preserve recent-language and current-event context as explicit advisory strata.
- `scripts/mentions/mention-composite-core.mjs`
  - Keep scoreable evidence separate from gates and narrative warnings.
- `scripts/packets/generate-mentions-daily.mjs`
  - Thread Trump heuristics into the synthesis input, not the score math.
- `scripts/mentions/render-mention-packet.mjs`
  - Render the Trump heuristics as prose context, not as score inputs.

### Proposed Scoring Influence

Do not let the new layer become a hidden price proxy.

Recommended behavior:
- Event format can adjust evidence weighting.
- Current-event shock can upgrade or downgrade the expected word family.
- Recent-language prior can change settlement-fit confidence.
- Consensus / crowded-story warning should remain advisory only.
- NT remains a valid output when the edge is weak.

### Proposed Rendering Changes

If/when wired into packets, the Trump layer should show up as:
- a `SOURCE-BACKED CONTEXT` block in the proof artifact
- evidence / provenance lines on each Trump term card
- a clearly labeled `NT` or no-edge note when the setup is crowded or weak
- settlement-fit notes that explain why the exact wording does or does not match

### Proposed Tests

Add or extend tests that prove:
- Trump route classification still lands on the correct `trump_*` branch.
- Event-format priors do not mutate `cpc_score`.
- Current-event context can change the narrative but not inject price logic.
- `NT` is produced when evidence is thin or only timing exists.
- No price-shaped fields enter routing, scoring, or rendering.

Candidate test files:
- `test/mention-route-taxonomy.test.mjs`
- `test/mentions-route-integration.test.mjs`
- `test/mentions-render-router.test.mjs`
- `test/mentions-lexical-gate.test.mjs`
- `test/mentions-dead-layer-neutralization.test.mjs`
- `test/mentions-source-research.test.mjs`

## Do-Not-Use Rules

- Market prices never drive score, posture, or ranking.
- No fake transcript confidence.
- No forced pick when edge is thin.
- No bid/ask, volume, OI, liquidity, spreads, or price movement as evidence for the Trump mention model.
- No hidden link from "story strength" to a price proxy.
- No code path should turn a narrative warning into a score input.

## Open Questions / Missing Transcript Gaps

- `kydYa1Im77Y` has no readable captions from the local transcript path.
- The corpus is large enough that some older Trump clips will need manual transcript retrieval if they are to be added to the heuristic set.
- This is a focused first-pass mining set, not a claim that every readable relevant upload was mined to exhaustion.
- A first wiring pass still needs a decision on where `overpriced_story_warning` should live: source ladder, redteam output, or proof artifact only.
- PMT's broader strategy videos support the general playbook, but the Trump-specific layer still needs more same-format comparables for some event classes.

## Next Recommended Code Phase

1. Add a Trump heuristic object to the research artifact and thread it through the mentions synthesis input.
2. Extend the route/prompt layer so Trump event format, audience context, and current-news shock are visible to the analyst prompt without touching price logic.
3. Render the new context as advisory prose only.
4. Add tests proving:
   - no price data enters the layer,
   - NT still works,
   - Trump format priors do not alter score math.

That is the correct next phase after the playbook is validated.
