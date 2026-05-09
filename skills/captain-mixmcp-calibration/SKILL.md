---
name: captain-mixmcp-calibration
description: Use when applying market-conditioned prompting/MixMCP to mention markets so the market price is treated as a prior, evidence creates a posterior, and the final TV is dampened before trade gates.
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [mixmcp, mcp, calibration, mention-markets, brier, market-prior]
    related_skills: [captain-mentions-research-system, mentions-market-picks]
---

# Captain MixMCP Calibration

## Purpose

Apply MCP/MixMCP to Captain mention markets.

The rule: do not forecast from scratch. Start with the market-implied probability as prior, update with transcript/context evidence, then dampen the update before producing trade TV.

## Inputs

For each strike:

- YES price in cents
- evidence posterior `p_mcp`
- event type
- evidence quality
- price band
- rule/source ambiguity
- edge threshold by event type

## Formulas

```text
p_mkt = YES¢ / 100
p_mix = alpha * p_mkt + (1 - alpha) * p_mcp
Mix TV = round(100 * p_mix)
NO¢ = 100 - YES¢
YES Edge = Mix TV - YES¢
NO Edge = (100 - Mix TV) - NO¢
LSP YES = Mix TV
LSP NO = 100 - Mix TV
Max Entry YES = Mix TV - EdgeThreshold
Max Entry NO = (100 - Mix TV) - EdgeThreshold
```

## Alpha selection

Start with event-type alpha:

```text
Earnings: 0.70
Speech/interview: 0.70-0.80
Hearing/testimony: 0.70-0.80
Rally/remarks: 0.70-0.85
Sports broadcast: 0.75-0.90
Creator/podcast/livestream: 0.75-0.85
```

Adjust by price band:

```text
0-10 YES¢: 0.90-0.95
10-30 YES¢: 0.80-0.90
30-50 YES¢: 0.70-0.80
50-70 YES¢: 0.60-0.70
70-90 YES¢: 0.75-0.85
90-99 YES¢: 0.90-0.95
```

Adjust up when:

- source quality is weak
- market is near 0 or 100
- transcript sample is thin
- sports/game-script volatility is high
- rules or alias boundary is ambiguous
- evidence posterior is driven mostly by vibes/context

Adjust down when:

- official source/rules are clear
- transcript sample is strong
- exact word history is consistent
- current event materials directly contain the word
- eligible speaker is likely to read prepared text containing the word

## Evidence posterior `p_mcp`

Build `p_mcp` from:

- contract rules
- transcript exact-match hit rate
- current news/context driver
- prompt-force map
- register/paraphrase risk
- event structure
- eligibility/source risk

Do not let `p_mcp` equal topic probability. It must be settlement probability.

## Trade gate

Default minimum edge thresholds:

```text
Earnings Call: 10¢
Speech / Interview: 12¢
Hearing / Testimony: 12¢
Rally / Remarks: 12¢
Sports Broadcast: 15¢
```

State mapping:

- TRADE: edge exceeds threshold and evidence quality is medium/high.
- WATCH LIVE: edge is close or depends on live segment/prompt path.
- NO TRADE: edge fails threshold or wording is too replaceable.
- FADE SPIKE: expected live overreaction to topic-adjacent but exact-word-shaky path.
- NEEDS PROOF: rules/source/prices missing.

## Output row

```text
Strike:
YES¢:
p_mkt:
Evidence TV:
p_mcp:
alpha:
Mix TV:
YES Edge:
NO Edge:
Pick Gate:
LSP:
Max Entry:
Reason:
```

## Backtest log row

```text
Date | Event | Strike | YES¢ | p_mkt | Evidence TV | p_mcp | alpha | Mix TV | Pick | Result | Brier
```

Brier:

```text
forecast = Mix TV / 100
outcome = 1 for YES, 0 for NO
Brier = (forecast - outcome)^2
```

## Common pitfalls

1. Replacing market prior with vibes.
2. Treating topic probability as p_mcp.
3. Using too low alpha on 0-10 or 90-99 cent markets.
4. Ignoring source/rule ambiguity when selecting alpha.
5. Calling a pick when the current price is missing.
6. Computing edge from last price when bid/ask shows no real entry.

## Verification checklist

- [ ] p_mkt calculated from YES¢.
- [ ] p_mcp is settlement probability, not topic probability.
- [ ] alpha justified by event type, price band, and evidence quality.
- [ ] Mix TV and edge math checked.
- [ ] output state follows edge threshold and hard skip rules.
