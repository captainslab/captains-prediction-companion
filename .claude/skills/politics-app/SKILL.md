---
name: Politics App
description: Alpha pipeline for political prediction markets — elections, chamber control, policy outcomes, geopolitical events. Worldmonitor-backed intelligence ingest. Sibling mentions_app handles mention-resolution markets.
triggers:
  - "analyze political market"
  - "election market"
  - "chamber control"
  - "will X win the election"
  - "geopolitical prediction"
  - "policy outcome"
  - "will congress pass"
  - "will trump mention"
  - "mention market"
  - "said the word"
---

# Politics App + Mentions App

## Routing Rule (HARD)

| Resolution criterion | App |
|---|---|
| Did X SAY Y in venue Z? (linguistic) | `mentions_app` |
| Who wins / what happens / outcome | `politics_app` |

**Never route a mention-resolution market to politics_app.**
**Never route an election/outcome market to mentions_app.**

## politics_app — Outcome Markets

Handles: `election_outcome`, `chamber_control`, `candidate_outcome`, `policy_outcome`, `geopolitical_event`, `political_event_context`

### Data Flow

```
PoliticsRouterInput
  → PoliticsIntelIngest (worldmonitor layer — Perplexity backed)
  → PoliticsNarrativeEngine (synthesize polling + news → NarrativeContext)
  → ElectionsAlphaEngine OR GeopoliticsAlphaEngine
  → PoliticsReviewAnalyst
  → PoliticsRouterOutput
```

### Engine Dispatch

| Market type | Engine |
|---|---|
| election_outcome, chamber_control, candidate_outcome, policy_outcome | `elections_alpha` |
| geopolitical_event, political_event_context | `geopolitics_alpha` |

### Key Thresholds

| Parameter | Value |
|---|---|
| min_edge_cents | 4¢ (elections), 6¢ (geopolitics) |
| min_confidence | 0.50 |
| polling_weight | 0.45 |
| market_consensus_weight | 0.35 |
| news_sentiment_weight | 0.20 |
| recency_window_days | 7 |

### No-bet Gates

- `data_quality == "low"` → no bet
- `confidence < 0.50` → no bet
- Missing polling + missing consensus → no bet (geopolitics only falls back to prior)

## mentions_app — Mention-Resolution Markets

Handles: any market resolving on whether an exact phrase/word was said.

### Pricing Model

```
P_fair = venue_prior + recency_boost + market_anchor_pull
```

| Venue | Prior |
|---|---|
| State of the Union | 0.70 |
| Rally | 0.60 |
| Debate | 0.55 |
| Press conference | 0.50 |
| Interview | 0.45 |
| Tweet | 0.35 |

- **Recency boost**: +8pp if phrase appears in recent news narrative
- **Market anchor pull**: 25% pull toward current market price (max ±15pp)

### No-bet Gates

- Missing both `exact_phrase` and `venue` → no bet
- Edge < 3¢ → watch

## worldmonitor Layer

worldmonitor is **upstream intelligence only**. It does NOT price or route.

```
PoliticsIntelIngest.fetch()
  → _build_polling_query()     → Perplexity sonar-pro
  → _build_news_query()        → Perplexity sonar-pro
  → _build_consensus_query()   → Perplexity sonar-pro
  → _build_narrative_query()   → Perplexity sonar-pro
  → PoliticsIntelReport
```

Cache: in-memory, TTL=1800s (30 min), key=sha256(market_id)[:16]
Stale-on-failure: enabled by default

## Scripts

| Script | Purpose |
|---|---|
| `scripts/classify_politics.py` | Classify market type + jurisdiction from title/description |
| `scripts/route_political_market.py` | Route a market JSON → politics_app or mentions_app |
| `scripts/fetch_intel.py` | Run worldmonitor fetch for a given market ID + title |
| `scripts/validate_politics_config.py` | Validate PoliticsAlphaConfig and WorldMonitorConfig |

## Standard Output

```python
PoliticsRouterOutput(
    pipeline="elections_alpha_engine",
    market_type=PoliticsMarketType.ELECTION_OUTCOME,
    fair_probability=0.62,
    edge=0.07,          # 7¢ edge
    confidence=0.68,
    no_bet_flag=False,
    recommendation="bet_yes",
    notes=["polling implies 60-64% range", "dominant_frame: challenger_momentum"],
    extra={
        "p_poll": 0.61,
        "p_consensus": 0.64,
        "data_quality": "medium",
        "analyst_brief": "Polling implies 62% probability..."
    }
)
```
