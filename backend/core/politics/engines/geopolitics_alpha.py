"""
GeopoliticsAlphaEngine — fair probability for geopolitical event markets.

Supported types:
  - geopolitical_event (war, ceasefire, sanctions, regime change, treaty, nuclear)
  - political_event_context (approval ratings, debate outcomes, referendums)

Geopolitical markets are inherently harder to price:
- Less reliable polling data
- High tail-risk and discontinuous outcomes
- Narrative/news is the primary signal (polls rarely exist)
- Wider confidence intervals → higher edge threshold

Pricing model:
  P_fair = w_consensus * P_consensus + w_news * P_news_implied + base_prior
  where:
    P_consensus   = cross-venue market consensus (strongest signal)
    P_news_implied = sentiment-derived proxy (weak)
    base_prior    = domain default (e.g. 0.15 for war escalation)
"""

from __future__ import annotations

from ..config import DEFAULT_POLITICS_ALPHA_CONFIG, PoliticsAlphaConfig, PoliticsMarketType
from ..models import PoliticsRouterInput, PoliticsRouterOutput, PoliticsIntelReport
from ..worldmonitor.narrative import NarrativeContext

# Default priors by keyword match (used when no polling or consensus available)
_DOMAIN_PRIORS: dict[str, float] = {
    "war":            0.15,
    "invasion":       0.12,
    "ceasefire":      0.35,
    "sanction":       0.40,
    "nuclear":        0.08,
    "regime change":  0.10,
    "coup":           0.08,
    "treaty":         0.25,
    "nato":           0.30,
    "approval":       0.45,
    "referendum":     0.45,
}

_GEO_EDGE_THRESHOLD_CENTS = 6.0   # higher bar than elections (noisier signal)


def _domain_prior(title: str) -> float:
    lower = title.lower()
    for keyword, prior in _DOMAIN_PRIORS.items():
        if keyword in lower:
            return prior
    return 0.30  # generic political event


def run(
    inp: PoliticsRouterInput,
    intel: PoliticsIntelReport,
    narrative: NarrativeContext,
    config: PoliticsAlphaConfig = DEFAULT_POLITICS_ALPHA_CONFIG,
) -> PoliticsRouterOutput:
    """
    Compute fair probability and edge for a geopolitical event market.
    """
    notes: list[str] = []
    market_type = inp.market_type

    prior = _domain_prior(inp.title)
    p_consensus = narrative.market_consensus
    sentiment = narrative.sentiment_net

    # Build fair probability
    if p_consensus is not None and narrative.data_quality in ("medium", "high"):
        # Blend consensus with prior (consensus dominates)
        p_fair = 0.70 * p_consensus + 0.30 * prior
        notes.append(f"using market consensus ({p_consensus:.0%}) blended with domain prior ({prior:.0%})")
    elif narrative.implied_prob_mid > 0:
        p_fair = 0.50 * narrative.implied_prob_mid + 0.50 * prior
        notes.append("no market consensus — blending polling mid with domain prior")
    else:
        # Sentiment-nudged prior only
        sentiment_adj = sentiment * 0.05
        p_fair = max(0.02, min(0.98, prior + sentiment_adj))
        notes.append("weak signal — using domain prior + sentiment nudge only")

    p_fair = max(0.02, min(0.98, p_fair))

    # Edge
    market_price = inp.current_price_yes
    if market_price is None:
        edge = 0.0
        recommendation = "watch"
        notes.append("no_market_price — edge not calculable")
    else:
        edge = p_fair - market_price
        edge_cents = abs(edge) * 100
        if edge_cents < _GEO_EDGE_THRESHOLD_CENTS:
            recommendation = "watch"
        elif edge > 0:
            recommendation = "bet_yes"
        else:
            recommendation = "bet_no"

    # Confidence — geopolitical markets are harder, ceiling lower
    confidence = _compute_confidence(narrative)

    if confidence < config.min_confidence:
        return PoliticsRouterOutput(
            pipeline="geopolitics_alpha_engine",
            market_type=market_type,
            fair_probability=p_fair,
            edge=edge,
            confidence=confidence,
            no_bet_flag=True,
            no_bet_reason="geopolitical_confidence_too_low",
            recommendation="watch",
            notes=notes + ["geopolitical markets require higher signal quality"],
            intel_report=intel,
        )

    if narrative.data_quality == "low":
        notes.append("low data quality — treat as indicative only")

    return PoliticsRouterOutput(
        pipeline="geopolitics_alpha_engine",
        market_type=market_type,
        fair_probability=p_fair,
        edge=edge,
        confidence=confidence,
        no_bet_flag=False,
        recommendation=recommendation,
        notes=notes,
        intel_report=intel,
        extra={
            "domain_prior": prior,
            "p_consensus": p_consensus,
            "dominant_frame": narrative.dominant_frame,
            "data_quality": narrative.data_quality,
            "analyst_brief": narrative.analyst_brief,
        },
    )


def _compute_confidence(narrative: NarrativeContext) -> float:
    # Geopolitical: lower ceiling, market consensus is key
    base = 0.40
    if narrative.market_consensus is not None:
        base += 0.15
    if narrative.data_quality == "high":
        base += 0.10
    elif narrative.data_quality == "medium":
        base += 0.05
    if narrative.news_count >= 3:
        base += 0.05
    return max(0.25, min(0.75, base))
