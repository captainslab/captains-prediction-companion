"""
ElectionsAlphaEngine — fair probability and edge for election outcome markets.

Supported types:
  - election_outcome (who wins a general/primary election)
  - chamber_control  (which party controls Senate/House/etc.)
  - candidate_outcome (nomination, candidacy, drop-out)

Inputs: PoliticsIntelReport + NarrativeContext + PoliticsRouterInput
Output: PoliticsRouterOutput

Pricing model:
  P_fair = w_poll * P_poll + w_consensus * P_consensus + w_sentiment * P_sentiment_adj
  where:
    P_poll       = polling-implied probability (mid from NarrativeContext)
    P_consensus  = market consensus price (cross-venue avg)
    P_sentiment  = sentiment adjustment (±0-4pp)
    weights      = from PoliticsAlphaConfig
"""

from __future__ import annotations

from ..config import DEFAULT_POLITICS_ALPHA_CONFIG, PoliticsAlphaConfig, PoliticsMarketType
from ..models import PoliticsRouterInput, PoliticsRouterOutput
from ..worldmonitor.narrative import NarrativeContext
from ..models import PoliticsIntelReport


def run(
    inp: PoliticsRouterInput,
    intel: PoliticsIntelReport,
    narrative: NarrativeContext,
    config: PoliticsAlphaConfig = DEFAULT_POLITICS_ALPHA_CONFIG,
) -> PoliticsRouterOutput:
    """
    Compute fair probability and edge for an election/chamber/candidate market.
    """
    notes: list[str] = []
    market_type = inp.market_type

    # --- No-bet gates ---
    if narrative.data_quality == "low":
        return PoliticsRouterOutput(
            pipeline="elections_alpha_engine",
            market_type=market_type,
            no_bet_flag=True,
            no_bet_reason="data_quality_too_low",
            notes=["worldmonitor returned low-quality data — no polling or consensus available"],
        )

    # --- Build component probabilities ---
    p_poll = narrative.implied_prob_mid
    p_consensus = narrative.market_consensus or p_poll

    # Sentiment adjustment: ±4pp max
    sentiment_adj = narrative.sentiment_net * 0.04
    p_sentiment_adj = max(0.0, min(1.0, p_poll + sentiment_adj))

    # Weighted blend
    cfg = config
    p_fair = (
        cfg.polling_weight * p_poll
        + cfg.market_consensus_weight * p_consensus
        + cfg.news_sentiment_weight * p_sentiment_adj
    )
    p_fair = max(0.01, min(0.99, p_fair))

    # --- Edge calculation ---
    market_price = inp.current_price_yes
    if market_price is None:
        notes.append("no_market_price — edge not calculable")
        edge = 0.0
        recommendation = "watch"
    else:
        edge = p_fair - market_price
        edge_cents = abs(edge) * 100
        if edge_cents < cfg.min_edge_cents:
            recommendation = "watch"
        elif edge > 0:
            recommendation = "bet_yes"
        else:
            recommendation = "bet_no"

    # --- Confidence ---
    confidence = _compute_confidence(narrative, config)

    # Confidence no-bet gate
    if confidence < cfg.min_confidence:
        return PoliticsRouterOutput(
            pipeline="elections_alpha_engine",
            market_type=market_type,
            fair_probability=p_fair,
            edge=edge,
            confidence=confidence,
            no_bet_flag=True,
            no_bet_reason="confidence_below_threshold",
            recommendation="watch",
            notes=notes + [f"confidence {confidence:.2f} < threshold {cfg.min_confidence:.2f}"],
            intel_report=intel,
        )

    # Frame-based notes
    if narrative.dominant_frame == "toss_up":
        notes.append("market framed as toss-up — model uncertainty high")
    if narrative.dominant_frame == "scandal_drag":
        notes.append("scandal drag detected — downside risk for subject")
    if "no_polling_data" in narrative.data_gaps:
        notes.append("no polling data — estimate driven by market consensus + sentiment only")

    return PoliticsRouterOutput(
        pipeline="elections_alpha_engine",
        market_type=market_type,
        fair_probability=p_fair,
        edge=edge,
        confidence=confidence,
        no_bet_flag=False,
        recommendation=recommendation,
        notes=notes,
        intel_report=intel,
        extra={
            "p_poll": p_poll,
            "p_consensus": p_consensus,
            "p_sentiment_adj": p_sentiment_adj,
            "dominant_frame": narrative.dominant_frame,
            "data_quality": narrative.data_quality,
            "data_gaps": narrative.data_gaps,
            "analyst_brief": narrative.analyst_brief,
        },
    )


def _compute_confidence(narrative: NarrativeContext, config: PoliticsAlphaConfig) -> float:
    base = 0.55
    if narrative.data_quality == "high":
        base += 0.15
    elif narrative.data_quality == "medium":
        base += 0.05
    # Wider polling range = lower confidence
    spread = narrative.implied_prob_high - narrative.implied_prob_low
    base -= spread * 0.3
    # Multiple sources = higher confidence
    if narrative.poll_count >= 3:
        base += 0.05
    if narrative.market_consensus is not None:
        base += 0.05
    return max(0.30, min(0.90, base))
