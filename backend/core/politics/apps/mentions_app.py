"""
mentions_app — alpha pipeline for mention-resolution markets.

Handles markets that resolve on WHETHER a specific phrase/word was SAID
in a defined venue (debate, speech, press conference, rally, interview).

Examples:
  "Will Trump say 'tariff' during the State of the Union?"
  "Will Biden mention Ukraine in tonight's debate?"
  "Does the Fed chair say 'pause' at the FOMC press conference?"

This app is a SIBLING of politics_app, not a child.
It shares the worldmonitor ingest layer for context but prices
linguistically, not electorally.

Pricing model:
  P_fair is driven by:
    1. Base rate — how often has this speaker used this phrase?
    2. Venue prior — press conference vs rally vs debate vs SOTU
    3. Recent news signal — is the topic currently salient?
    4. Market price as anchor (with discount for mention market biases)
"""

from __future__ import annotations

import re

from ..config import DEFAULT_WORLDMONITOR_CONFIG, WorldMonitorConfig
from ..models import MentionMarketInput, MentionMarketOutput
from ..worldmonitor.ingest import PoliticsIntelIngest

# ---------------------------------------------------------------------------
# Venue priors — base probability that a topic gets mentioned
# in this type of venue
# ---------------------------------------------------------------------------

_VENUE_PRIORS: dict[str, float] = {
    "state of the union":   0.70,
    "sotu":                 0.70,
    "press conference":     0.50,
    "debate":               0.55,
    "rally":                0.60,
    "interview":            0.45,
    "speech":               0.50,
    "hearing":              0.40,
    "tweet":                0.35,
    "remarks":              0.45,
}

_DEFAULT_VENUE_PRIOR = 0.45

# ---------------------------------------------------------------------------
# Recency signal — if topic is "in the news" boost base by this
# ---------------------------------------------------------------------------

_RECENCY_BOOST = 0.08


def _get_venue_prior(venue: str) -> float:
    lower = venue.lower()
    for key, prior in _VENUE_PRIORS.items():
        if key in lower:
            return prior
    return _DEFAULT_VENUE_PRIOR


def _topic_in_recent_news(phrase: str, news_summary: str) -> bool:
    return phrase.lower() in news_summary.lower() if phrase else False


# ---------------------------------------------------------------------------
# Main run function
# ---------------------------------------------------------------------------

def run(
    inp: MentionMarketInput,
    wm_config: WorldMonitorConfig = DEFAULT_WORLDMONITOR_CONFIG,
) -> MentionMarketOutput:
    """
    Full mentions_app pipeline.
    """
    # Fetch worldmonitor context (for news recency signal)
    ingest = PoliticsIntelIngest(config=wm_config)
    intel = ingest.fetch(
        market_id=inp.market_id,
        title=inp.title,
        description=f"speaker={inp.speaker} phrase={inp.exact_phrase} venue={inp.venue}",
    )

    # Base: venue prior
    base = _get_venue_prior(inp.venue)
    notes: list[str] = [f"venue_prior={base:.2f} for '{inp.venue or 'unknown venue'}'"]

    # Recency boost
    topic_salient = _topic_in_recent_news(inp.exact_phrase, intel.narrative_summary)
    if topic_salient:
        base = min(0.95, base + _RECENCY_BOOST)
        notes.append(f"recency_boost +{_RECENCY_BOOST:.0%} (phrase found in recent narrative)")

    # Market price as soft anchor (±15pp max pull)
    market_price = inp.current_price_yes
    if market_price is not None:
        anchor_pull = (market_price - base) * 0.25   # 25% pull toward market
        p_fair = max(0.02, min(0.98, base + anchor_pull))
        notes.append(f"market_price={market_price:.0%} anchor_pull={anchor_pull:+.2f}")
    else:
        p_fair = base

    # Edge
    if market_price is not None:
        edge_cents = (p_fair - market_price) * 100
        if abs(edge_cents) >= 3:
            recommendation = "bet_yes" if edge_cents > 0 else "bet_no"
        else:
            recommendation = "watch"
    else:
        edge_cents = 0.0
        recommendation = "watch"

    # Confidence
    confidence = _compute_confidence(inp, intel, topic_salient)

    # No-bet: if no phrase or no venue, confidence is structurally limited
    no_bet = False
    no_bet_reason = ""
    if not inp.exact_phrase and not inp.venue:
        no_bet = True
        no_bet_reason = "missing_phrase_and_venue"

    watch_for = _build_watch_for(inp, intel)

    return MentionMarketOutput(
        pipeline="mentions_app",
        fair_yes=p_fair,
        confidence="high" if confidence > 0.70 else ("medium" if confidence > 0.50 else "low"),
        recommendation=recommendation if not no_bet else "watch",
        reasoning=_build_reasoning(inp, p_fair, base, topic_salient),
        watch_for=watch_for,
        no_bet_flag=no_bet,
        no_bet_reason=no_bet_reason,
        notes=notes,
    )


def _compute_confidence(inp: MentionMarketInput, intel, topic_salient: bool) -> float:
    base = 0.50
    if inp.exact_phrase:
        base += 0.10
    if inp.venue:
        base += 0.10
    if inp.speaker:
        base += 0.05
    if topic_salient:
        base += 0.08
    if intel.error:
        base -= 0.10
    return max(0.25, min(0.85, base))


def _build_reasoning(inp: MentionMarketInput, p_fair: float, prior: float, salient: bool) -> str:
    parts = []
    if inp.speaker:
        parts.append(f"{inp.speaker}")
    if inp.exact_phrase:
        parts.append(f"saying '{inp.exact_phrase}'")
    if inp.venue:
        parts.append(f"at {inp.venue}")
    subject = " ".join(parts) or "this mention"
    salient_note = " Topic is currently salient in news." if salient else ""
    return f"Fair probability for {subject} estimated at {p_fair:.0%} (venue prior {prior:.0%}).{salient_note}"


def _build_watch_for(inp: MentionMarketInput, intel) -> list[str]:
    items = []
    if inp.resolution_window:
        items.append(f"event window: {inp.resolution_window}")
    if inp.speaker:
        items.append(f"monitor {inp.speaker} statements before market closes")
    if inp.exact_phrase:
        items.append(f"confirm resolution rules: exact phrase '{inp.exact_phrase}' required")
    return items[:3]
