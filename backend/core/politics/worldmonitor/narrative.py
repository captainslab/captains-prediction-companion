"""
PoliticsNarrativeEngine — synthesizes worldmonitor intel into a structured narrative context.

Input:  PoliticsIntelReport (from ingest.py)
Output: NarrativeContext — structured summary ready for alpha engines

Responsibilities:
- Aggregate polling signals into a single implied probability range
- Identify dominant narrative frame (incumbent advantage, challenger momentum, etc.)
- Flag staleness or data gaps
- Produce a short analyst-style brief suitable for the alpha engines
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..models import PoliticsIntelReport, PollDataPoint


# ---------------------------------------------------------------------------
# Output model
# ---------------------------------------------------------------------------

@dataclass(slots=True)
class NarrativeContext:
    """Structured narrative context fed to alpha engines."""
    market_id: str
    implied_prob_low: float  = 0.0      # low end of polling-implied range
    implied_prob_high: float = 0.0      # high end
    implied_prob_mid: float  = 0.0      # midpoint
    dominant_frame: str = ""            # e.g. "incumbent_advantage", "challenger_momentum"
    sentiment_net: float = 0.0          # net news sentiment (-1 to +1)
    data_quality: str = "low"           # "low" | "medium" | "high"
    data_gaps: list[str] = field(default_factory=list)
    analyst_brief: str = ""             # 1-3 sentence summary
    poll_count: int = 0
    news_count: int = 0
    market_consensus: float | None = None


# ---------------------------------------------------------------------------
# Frame classifier
# ---------------------------------------------------------------------------

_FRAMES = {
    "incumbent_advantage": ("incumbent", "approval", "approval rating", "favorability"),
    "challenger_momentum": ("momentum", "surge", "closing gap", "narrowing", "rising"),
    "toss_up": ("toss-up", "toss up", "too close", "within margin", "dead heat"),
    "blowout": ("landslide", "dominant", "wide lead", "double digit", "overwhelming"),
    "scandal_drag": ("scandal", "indictment", "conviction", "controversy", "under fire"),
    "undecided_heavy": ("undecided", "uncommitted", "no preference", "third party"),
}

def _classify_frame(narrative: str) -> str:
    lower = narrative.lower()
    scores: dict[str, int] = {}
    for frame, keywords in _FRAMES.items():
        scores[frame] = sum(1 for kw in keywords if kw in lower)
    best = max(scores, key=lambda k: scores[k])
    return best if scores[best] > 0 else "unclear"


# ---------------------------------------------------------------------------
# Polling aggregator
# ---------------------------------------------------------------------------

def _aggregate_polls(
    polls: list[PollDataPoint],
    target_entity: str,
) -> tuple[float, float, float]:
    """
    Given polling data and a target candidate/option name, return
    (implied_prob_low, implied_prob_high, implied_prob_mid).
    """
    if not polls:
        return 0.0, 0.0, 0.0

    target_lower = target_entity.lower()
    matching = [
        p for p in polls
        if target_lower in p.candidate_or_option.lower()
    ]

    if not matching:
        # Fallback: treat highest polling candidate as the "yes" side
        values = [p.support_pct for p in polls]
        if not values:
            return 0.0, 0.0, 0.0
        v = max(values) / 100.0
        return max(0.0, v - 0.05), min(1.0, v + 0.05), v

    values = [p.support_pct / 100.0 for p in matching]
    mid = sum(values) / len(values)
    spread = max(values) - min(values) if len(values) > 1 else 0.04
    return max(0.0, mid - spread / 2), min(1.0, mid + spread / 2), mid


# ---------------------------------------------------------------------------
# Sentiment aggregator
# ---------------------------------------------------------------------------

def _net_sentiment(news_signals) -> float:
    if not news_signals:
        return 0.0
    mapping = {"positive": 1.0, "neutral": 0.0, "negative": -1.0}
    vals = [mapping.get(s.sentiment, 0.0) * s.relevance for s in news_signals]
    return sum(vals) / len(vals)


# ---------------------------------------------------------------------------
# Data quality scorer
# ---------------------------------------------------------------------------

def _data_quality(report: PoliticsIntelReport) -> tuple[str, list[str]]:
    gaps = []
    score = 0

    if report.polls:
        score += 2
    else:
        gaps.append("no_polling_data")

    if report.news_signals:
        score += 1
    else:
        gaps.append("no_news_signals")

    if report.market_consensus_price is not None:
        score += 1
    else:
        gaps.append("no_market_consensus")

    if report.narrative_summary:
        score += 1
    else:
        gaps.append("no_narrative")

    if score >= 4:
        return "high", gaps
    if score >= 2:
        return "medium", gaps
    return "low", gaps


# ---------------------------------------------------------------------------
# Main engine
# ---------------------------------------------------------------------------

class PoliticsNarrativeEngine:
    """
    Converts a PoliticsIntelReport into a structured NarrativeContext
    ready for consumption by alpha engines.
    """

    def synthesize(
        self,
        report: PoliticsIntelReport,
        target_entity: str = "",
    ) -> NarrativeContext:
        prob_low, prob_high, prob_mid = _aggregate_polls(report.polls, target_entity)
        sentiment = _net_sentiment(report.news_signals)
        frame = _classify_frame(report.narrative_summary)
        quality, gaps = _data_quality(report)

        # Build analyst brief
        brief_parts = []
        if prob_mid > 0:
            brief_parts.append(
                f"Polling implies {prob_mid:.0%} probability (range {prob_low:.0%}–{prob_high:.0%})."
            )
        if report.market_consensus_price is not None:
            brief_parts.append(
                f"Market consensus at {report.market_consensus_price:.0%}."
            )
        if frame != "unclear":
            brief_parts.append(f"Dominant frame: {frame.replace('_', ' ')}.")
        if not brief_parts:
            brief_parts.append("Insufficient data for narrative synthesis.")

        return NarrativeContext(
            market_id=report.market_id,
            implied_prob_low=prob_low,
            implied_prob_high=prob_high,
            implied_prob_mid=prob_mid,
            dominant_frame=frame,
            sentiment_net=sentiment,
            data_quality=quality,
            data_gaps=gaps,
            analyst_brief=" ".join(brief_parts),
            poll_count=len(report.polls),
            news_count=len(report.news_signals),
            market_consensus=report.market_consensus_price,
        )
