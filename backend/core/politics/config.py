"""
Politics market configuration — canonical types, aliases, routing weights.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

# ---------------------------------------------------------------------------
# Political market subtypes
# ---------------------------------------------------------------------------

class PoliticsMarketType(str, Enum):
    # outcome-resolution → politics_app
    ELECTION_OUTCOME       = "election_outcome"         # who wins an election
    CHAMBER_CONTROL        = "chamber_control"          # which party controls Senate/House
    CANDIDATE_OUTCOME      = "candidate_outcome"        # primary, nomination, candidacy
    POLICY_OUTCOME         = "policy_outcome"           # will a bill pass / executive action
    GEOPOLITICAL_EVENT     = "geopolitical_event"       # war, treaty, sanctions, regime change
    POLITICAL_EVENT_CONTEXT = "political_event_context" # debate perf, approval ratings, polls

    # linguistic-resolution → mentions_app (NEVER politics_app)
    MENTION_RESOLUTION     = "mention_resolution"       # did X say Y in venue Z?

    UNKNOWN                = "unknown"


# Phrase patterns that signal mention-resolution (route to mentions_app)
MENTION_SIGNAL_PHRASES: tuple[str, ...] = (
    "mention", "mentions", "say", "says", "said",
    "phrase", "word", "utter", "quote", "speech",
    "remarks", "interview", "transcript", "press conference",
    "debate mention", "rally mention", "tweet mention",
)

# Phrase patterns that signal election/outcome resolution
ELECTION_SIGNAL_PHRASES: tuple[str, ...] = (
    "win", "wins", "winner", "elect", "elected", "election",
    "primary", "nomination", "nominee", "candidate",
    "presidency", "president", "governor", "senate", "house",
    "majority", "control", "flip", "seat",
)

POLICY_SIGNAL_PHRASES: tuple[str, ...] = (
    "pass", "passes", "sign", "signed", "veto", "vetoed",
    "bill", "legislation", "executive order", "enacted",
    "repealed", "impeach", "impeachment",
)

GEOPOLITICAL_SIGNAL_PHRASES: tuple[str, ...] = (
    "war", "invasion", "ceasefire", "sanction", "sanctions",
    "treaty", "regime", "coup", "nuclear", "nato", "un resolution",
    "diplomatic", "alliance", "conflict",
)


# ---------------------------------------------------------------------------
# Supported political jurisdictions
# ---------------------------------------------------------------------------

class Jurisdiction(str, Enum):
    US_FEDERAL    = "US_FEDERAL"
    US_STATE      = "US_STATE"
    EU            = "EU"
    UK            = "UK"
    GLOBAL        = "GLOBAL"
    UNKNOWN       = "UNKNOWN"


US_FEDERAL_SIGNALS = ("president", "congress", "senate", "house", "supreme court",
                      "white house", "federal", "us election", "american")

# ---------------------------------------------------------------------------
# worldmonitor config
# ---------------------------------------------------------------------------

@dataclass
class WorldMonitorConfig:
    """Configuration for the worldmonitor intelligence ingest layer."""
    # Perplexity search depth per query
    perplexity_search_depth: str = "detailed"           # "basic" | "detailed"
    max_sources_per_entity: int = 5
    entity_clustering_threshold: float = 0.72           # cosine sim threshold for merging
    narrative_max_tokens: int = 600
    cache_ttl_seconds: int = 1800                       # 30 min default
    stale_on_failure: bool = True

    # What to fetch
    fetch_polling_data: bool = True
    fetch_news_sentiment: bool = True
    fetch_prediction_market_consensus: bool = True
    fetch_social_signal: bool = False                   # opt-in only (noisy)


@dataclass
class PoliticsAlphaConfig:
    """Alpha engine thresholds for politics markets."""
    min_edge_cents: float = 4.0                         # higher bar than sports (less data)
    min_confidence: float = 0.50
    recency_window_days: int = 7                        # how fresh polling data must be
    polling_weight: float = 0.45
    market_consensus_weight: float = 0.35
    news_sentiment_weight: float = 0.20
    futures_horizon_days_max: int = 365                 # refuse ultra-long futures > 1yr


DEFAULT_WORLDMONITOR_CONFIG = WorldMonitorConfig()
DEFAULT_POLITICS_ALPHA_CONFIG = PoliticsAlphaConfig()
