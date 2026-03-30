"""
Typed models for the politics prediction market pipeline.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .config import Jurisdiction, PoliticsMarketType


# ---------------------------------------------------------------------------
# worldmonitor output models
# ---------------------------------------------------------------------------

@dataclass(slots=True)
class PoliticalEntity:
    """A named actor, party, or jurisdiction relevant to a market."""
    name: str
    entity_type: str                    # "candidate" | "party" | "country" | "body"
    aliases: list[str] = field(default_factory=list)
    relevance_score: float = 0.0        # 0-1, how central to the market


@dataclass(slots=True)
class PollDataPoint:
    """Single polling snapshot."""
    source: str
    date: str                           # ISO 8601
    candidate_or_option: str
    support_pct: float
    sample_size: int | None = None
    margin_of_error: float | None = None


@dataclass(slots=True)
class NewsSignal:
    """Synthesized news signal for a political entity or event."""
    headline: str
    source: str
    date: str
    sentiment: str                      # "positive" | "negative" | "neutral"
    relevance: float                    # 0-1
    url: str | None = None


@dataclass(slots=True)
class PoliticsIntelReport:
    """
    Output of the worldmonitor intelligence ingest layer.
    Fed to alpha engines as context — not a pricing output.
    """
    market_id: str
    entities: list[PoliticalEntity] = field(default_factory=list)
    polls: list[PollDataPoint] = field(default_factory=list)
    news_signals: list[NewsSignal] = field(default_factory=list)
    narrative_summary: str = ""
    market_consensus_price: float | None = None     # cross-venue avg if available
    data_freshness_hours: float = 0.0
    sources_used: list[str] = field(default_factory=list)
    cache_hit: bool = False
    error: str | None = None


# ---------------------------------------------------------------------------
# Router I/O models
# ---------------------------------------------------------------------------

@dataclass(slots=True)
class PoliticsRouterInput:
    """Normalized input to the politics app router."""
    source: str                         # "kalshi" | "polymarket" | "manual"
    market_id: str
    title: str
    description: str = ""
    market_type: PoliticsMarketType = PoliticsMarketType.UNKNOWN
    jurisdiction: Jurisdiction = Jurisdiction.UNKNOWN
    resolution_date: str | None = None
    current_price_yes: float | None = None
    raw_metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class PoliticsRouterOutput:
    """Standard output from any politics app."""
    pipeline: str
    market_type: PoliticsMarketType = PoliticsMarketType.UNKNOWN
    fair_probability: float = 0.0
    edge: float = 0.0
    confidence: float = 0.0
    no_bet_flag: bool = False
    no_bet_reason: str = ""
    recommendation: str = "watch"       # "bet_yes" | "bet_no" | "watch" | "pass"
    notes: list[str] = field(default_factory=list)
    intel_report: PoliticsIntelReport | None = None
    extra: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Mention market models (mentions_app)
# ---------------------------------------------------------------------------

@dataclass(slots=True)
class MentionMarketInput:
    """Input for mention-resolution markets."""
    source: str
    market_id: str
    title: str
    exact_phrase: str = ""              # the required phrase, if extractable
    speaker: str = ""                   # e.g. "Trump", "Biden"
    venue: str = ""                     # e.g. "State of the Union", "press conference"
    resolution_window: str = ""         # e.g. "during debate on 2026-04-15"
    current_price_yes: float | None = None
    raw_metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class MentionMarketOutput:
    """Output from mentions_app."""
    pipeline: str = "mentions_app"
    fair_yes: float = 0.0
    confidence: str = "low"             # "low" | "medium" | "high"
    recommendation: str = "watch"
    reasoning: str = ""
    watch_for: list[str] = field(default_factory=list)
    no_bet_flag: bool = False
    no_bet_reason: str = ""
    notes: list[str] = field(default_factory=list)
