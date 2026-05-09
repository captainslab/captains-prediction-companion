---
name: mentions-market-picks
description: Use when turning a Kalshi mentions board/link and research plan into evidence-backed YES/NO/watch picks without forcing trades.
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [kalshi, mentions, prediction-markets, picks, transcripts, firecrawl]
    related_skills: [controller-scope-gate, research-source-scraping, market-research-discovery-and-verification, kalshi-market-routing-and-board-state]
---

# Mentions Market Picks

## Purpose

Convert a user-provided mentions market research plan plus an exact Kalshi mentions link into a disciplined pick packet.

This skill is for operator use inside Captains Prediction Companion. It complements `docs/MENTIONSAPP.md` and `prompts/hermes-kalshi-mention-research.md`.

## Use when

- the user sends a mentions market board or contract link
- the user sends a mentions market research plan
- the task is to produce picks, ranked edges, or pass/watch decisions
- the analysis depends on transcript/phrase verification

## Do not use when

- the user has not provided the exact market/event link
- the task is a generic prediction market explanation
- the market is not phrase/mention/transcript based
- the request requires app runtime code changes rather than analysis

## Required inputs

- exact market or board URL
- market title or event name if visible
- current YES/NO prices or bid/ask, if the market site is inaccessible
- research plan, if supplied by the user
- any known resolution text/rules

If current prices are not retrievable, label prices as `missing` and ask the user for the visible bid/ask before issuing a trade pick. Research can continue, but price-sensitive picks must not be finalized.

## Agent split

### controller

- locks scope to the exact link
- distinguishes board URL from selected child contract
- blocks substitute markets
- requires proof before a pick
- downgrades to watch/pass when evidence is incomplete

### mentions-researcher

- extracts rules, eligible speaker, event window, and source-of-truth
- uses Firecrawl for official source discovery/scraping
- builds comparable transcript/library evidence
- produces phrase hit/miss and alias-boundary packet
- does not make picks

### oracle

- receives only the research packet plus market prices
- estimates fair YES probability/range
- compares fair value to market
- outputs YES edge, NO edge, watch, or avoid
- states entry limit, confidence, and invalidation trigger

## Workflow

1. Anchor
   - Copy the exact URL into the report.
   - Identify platform and whether URL is board-level or contract-level.
   - Do not analyze a nearby board or example market.

2. Resolution parse
   - Who must say the phrase?
   - What event counts?
   - What source resolves the market?
   - What transcript/video/source is official?
   - What variants/synonyms are explicitly included?
   - What variants are excluded or ambiguous?

3. Market inventory
   - For board links, list child contracts/strikes before picking.
   - For contract links, identify selected phrase and ticker.
   - Capture YES bid/ask/last/volume if available.

4. Source research
   - Use Firecrawl for discovery and scraping.
   - Prefer official transcript, official video/replay, SEC/IR material, agency page, or platform rules.
   - Use secondary sources only as navigation aids.
   - Store throwaway scrape outputs under `.firecrawl/` or `/tmp/firecrawl-*`.

5. Comparable base rate
   - Earnings: last 6 quarters minimum when available.
   - Fed: last 8 comparable pressers.
   - Political/agency briefings: last 20 comparable appearances when feasible.
   - Sports/media: comparable recent event transcripts/replays.
   - Count hit rate, frequency, recency, prepared vs Q&A/location.

6. Alias and rule friction
   - Treat bundled Kalshi variants as included.
   - Treat unbundled variants as strict literal unless rules say otherwise.
   - Discount probability when transcript source or alias boundary is unclear.

7. Probability and pick
   - Start with comparable hit rate.
   - Adjust for live narrative/catalyst.
   - Adjust for event format and time remaining.
   - Adjust down for rule/source ambiguity.
   - Compare fair range to market price.
   - Only issue a pick if edge survives spread/liquidity/rule risk.

8. Final gate
   - No official source/rules -> watch or avoid.
   - No price -> research-only, ask for price.
   - Thin/wide market -> smaller edge threshold or avoid.
   - Unresolved alias boundary -> watch unless price compensates.

## Pick thresholds

Use these as defaults unless the user's plan specifies stricter thresholds:

- Strong YES: fair low bound is at least 8 points above YES ask and evidence strength is medium/high.
- Lean YES: fair midpoint is at least 6 points above YES ask, but one material uncertainty remains.
- Strong NO: fair high bound is at least 8 points below YES bid or NO ask implies 8+ points edge.
- Lean NO: fair midpoint is at least 6 points below market YES price, but one material uncertainty remains.
- Watch: evidence is real but price, source, or timing is not actionable yet.
- Avoid: rules/source/alias boundary is too unclear or market is too illiquid/wide.

## Required output

Return terminal-friendly text in this shape:

Market:
Exact link:
Board or contract:
Selected strike:
Current market:
Resolution source:
Eligible speaker/event:
Rule/alias boundary:
Evidence checked:
Comparable hit rate:
YES case:
NO case:
Edge cases:
Fair YES range:
Market vs fair:
Pick:
Confidence:
Entry limit:
Invalidation:
Watch triggers:
Next source check:

For board-level slates, add a ranked table/list:

1. Strike — market YES — fair YES — edge — pick — confidence — key reason
2. ...

## Common pitfalls

1. Making a price pick from a research packet with no live price.
2. Treating secondary articles or social chatter as settlement proof.
3. Counting synonyms that the contract does not include.
4. Ignoring Q&A, analyst questions, or eligible speaker scope.
5. Giving a board-level recommendation before inventorying child contracts.
6. Using generic no-evidence language instead of concrete source gaps.
7. Overweighting narrative heat when historical transcript hit rate is low.
8. Forgetting that a live transcript can change during/after an event.

## Verification checklist

- [ ] exact URL preserved
- [ ] board vs contract state identified
- [ ] selected strike/ticker identified if making a pick
- [ ] official rules/source checked or gap stated
- [ ] phrase variants and alias boundary stated
- [ ] prices are live or explicitly user-provided
- [ ] fair range compared to bid/ask, not just last price
- [ ] pick downgraded to watch/avoid when evidence is incomplete
