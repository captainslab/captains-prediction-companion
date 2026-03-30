"""
politics_app_router — classifies incoming political markets and dispatches to the correct app.

Routing rule (hard):
  mention-resolution  (did X say Y?)         → mentions_app
  outcome-resolution  (who wins / what happens) → politics_app

The router DOES NOT price. It classifies, validates, and routes.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .config import (
    Jurisdiction,
    PoliticsMarketType,
    MENTION_SIGNAL_PHRASES,
    ELECTION_SIGNAL_PHRASES,
    POLICY_SIGNAL_PHRASES,
    GEOPOLITICAL_SIGNAL_PHRASES,
    US_FEDERAL_SIGNALS,
)
from .models import PoliticsRouterInput, PoliticsRouterOutput, MentionMarketInput


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------

def _count_signals(text: str, signals: tuple[str, ...]) -> int:
    lower = text.lower()
    return sum(1 for s in signals if s in lower)


def classify_market_type(title: str, description: str = "") -> tuple[PoliticsMarketType, float]:
    """
    Returns (market_type, confidence).
    confidence 0-1; anything below 0.5 should be treated as UNKNOWN.
    """
    text = (title + " " + description).lower()

    mention_hits = _count_signals(text, MENTION_SIGNAL_PHRASES)
    election_hits = _count_signals(text, ELECTION_SIGNAL_PHRASES)
    policy_hits = _count_signals(text, POLICY_SIGNAL_PHRASES)
    geo_hits = _count_signals(text, GEOPOLITICAL_SIGNAL_PHRASES)

    # Hard gate: explicit mention/phrase markers → mention_resolution
    strong_mention = any(
        phrase in text
        for phrase in ("mention", "mentions", "say the word", "said the word",
                       "use the phrase", "utter", "exact phrase")
    )
    if strong_mention and mention_hits >= 1:
        return PoliticsMarketType.MENTION_RESOLUTION, 0.92

    total = mention_hits + election_hits + policy_hits + geo_hits
    if total == 0:
        return PoliticsMarketType.UNKNOWN, 0.30

    if election_hits >= 2:
        conf = min(0.95, 0.50 + election_hits * 0.10)
        return PoliticsMarketType.ELECTION_OUTCOME, conf

    if policy_hits >= 2:
        conf = min(0.90, 0.50 + policy_hits * 0.10)
        return PoliticsMarketType.POLICY_OUTCOME, conf

    if geo_hits >= 2:
        conf = min(0.90, 0.50 + geo_hits * 0.10)
        return PoliticsMarketType.GEOPOLITICAL_EVENT, conf

    # "control" + legislative body → chamber_control
    if re.search(r"(senate|house|congress).{0,30}(control|majority|flip)", text):
        return PoliticsMarketType.CHAMBER_CONTROL, 0.88

    # Candidate / primary markers
    if re.search(r"(nominate|nominee|primary|candidacy|run for|drop out)", text):
        return PoliticsMarketType.CANDIDATE_OUTCOME, 0.80

    if mention_hits >= 1 and election_hits == 0:
        return PoliticsMarketType.MENTION_RESOLUTION, 0.65

    if election_hits >= 1:
        return PoliticsMarketType.ELECTION_OUTCOME, 0.65

    return PoliticsMarketType.UNKNOWN, 0.35


def classify_jurisdiction(title: str, description: str = "") -> Jurisdiction:
    text = (title + " " + description).lower()
    if any(s in text for s in US_FEDERAL_SIGNALS):
        return Jurisdiction.US_FEDERAL
    if re.search(r"\b(eu|european union|parliament|merkel|macron|scholz)\b", text):
        return Jurisdiction.EU
    if re.search(r"\b(uk|britain|british|parliament|labour|tory|tories)\b", text):
        return Jurisdiction.UK
    if re.search(r"\b(state|governor|ballot|proposition|recall)\b", text):
        return Jurisdiction.US_STATE
    return Jurisdiction.UNKNOWN


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

class PoliticsAppRouter:
    """
    Dispatcher for political markets.
    Classifies → validates → returns routing decision.

    The router does NOT call alpha engines — it returns which app to invoke
    plus the normalized input for that app.
    """

    def route(self, inp: PoliticsRouterInput) -> "PoliticsRouteResult":
        market_type, confidence = classify_market_type(inp.title, inp.description)
        jurisdiction = classify_jurisdiction(inp.title, inp.description)

        # Hard route: mention-resolution → mentions_app
        if market_type == PoliticsMarketType.MENTION_RESOLUTION:
            return PoliticsRouteResult(
                target_app="mentions_app",
                market_type=market_type,
                jurisdiction=jurisdiction,
                classification_confidence=confidence,
                normalized_input=inp,
            )

        # Unclassifiable
        if market_type == PoliticsMarketType.UNKNOWN or confidence < 0.45:
            return PoliticsRouteResult(
                target_app="unknown",
                market_type=market_type,
                jurisdiction=jurisdiction,
                classification_confidence=confidence,
                normalized_input=inp,
                reject_reason="classification_confidence_too_low",
            )

        return PoliticsRouteResult(
            target_app="politics_app",
            market_type=market_type,
            jurisdiction=jurisdiction,
            classification_confidence=confidence,
            normalized_input=inp,
        )


@dataclass(slots=True)
class PoliticsRouteResult:
    """Output of the politics router."""
    target_app: str                     # "politics_app" | "mentions_app" | "unknown"
    market_type: PoliticsMarketType
    jurisdiction: Jurisdiction
    classification_confidence: float
    normalized_input: PoliticsRouterInput
    reject_reason: str = ""


_ROUTER_SINGLETON: PoliticsAppRouter | None = None


def get_politics_router() -> PoliticsAppRouter:
    global _ROUTER_SINGLETON
    if _ROUTER_SINGLETON is None:
        _ROUTER_SINGLETON = PoliticsAppRouter()
    return _ROUTER_SINGLETON
