"""
politics_app — alpha pipeline for outcome-resolution political markets.

Handles:
  - election_outcome
  - chamber_control
  - candidate_outcome
  - policy_outcome
  - geopolitical_event
  - political_event_context

Data flow:
  PoliticsRouterInput
    → PoliticsIntelIngest.fetch()         (worldmonitor layer)
    → PoliticsNarrativeEngine.synthesize() (context synthesis)
    → elections_alpha_engine OR geopolitics_alpha_engine
    → PoliticsReviewAnalyst.review()
    → PoliticsRouterOutput
"""

from __future__ import annotations

from ..config import (
    DEFAULT_WORLDMONITOR_CONFIG,
    DEFAULT_POLITICS_ALPHA_CONFIG,
    PoliticsMarketType,
    WorldMonitorConfig,
    PoliticsAlphaConfig,
)
from ..models import PoliticsRouterInput, PoliticsRouterOutput
from ..worldmonitor.ingest import PoliticsIntelIngest
from ..worldmonitor.narrative import PoliticsNarrativeEngine
from ..engines import elections_alpha, geopolitics_alpha
from ..review_analyst import PoliticsReviewAnalyst

# Election / outcome types → elections_alpha_engine
_ELECTIONS_ENGINE_TYPES = {
    PoliticsMarketType.ELECTION_OUTCOME,
    PoliticsMarketType.CHAMBER_CONTROL,
    PoliticsMarketType.CANDIDATE_OUTCOME,
    PoliticsMarketType.POLICY_OUTCOME,
}

# Geo / context types → geopolitics_alpha_engine
_GEO_ENGINE_TYPES = {
    PoliticsMarketType.GEOPOLITICAL_EVENT,
    PoliticsMarketType.POLITICAL_EVENT_CONTEXT,
}


def run(
    inp: PoliticsRouterInput,
    wm_config: WorldMonitorConfig = DEFAULT_WORLDMONITOR_CONFIG,
    alpha_config: PoliticsAlphaConfig = DEFAULT_POLITICS_ALPHA_CONFIG,
) -> PoliticsRouterOutput:
    """
    Full politics_app pipeline for outcome-resolution markets.
    """
    ingest = PoliticsIntelIngest(config=wm_config)
    narrative_engine = PoliticsNarrativeEngine()
    reviewer = PoliticsReviewAnalyst(config=alpha_config)

    # Step 1: fetch intelligence
    intel = ingest.fetch(
        market_id=inp.market_id,
        title=inp.title,
        description=inp.description,
    )

    # Step 2: synthesize narrative context
    # Attempt to derive the "yes" side entity from the market title
    target_entity = _extract_yes_entity(inp.title)
    narrative = narrative_engine.synthesize(intel, target_entity=target_entity)

    # Step 3: route to correct alpha engine
    market_type = inp.market_type
    if market_type in _ELECTIONS_ENGINE_TYPES:
        output = elections_alpha.run(inp, intel, narrative, config=alpha_config)
    elif market_type in _GEO_ENGINE_TYPES:
        output = geopolitics_alpha.run(inp, intel, narrative, config=alpha_config)
    else:
        output = PoliticsRouterOutput(
            pipeline="politics_app",
            market_type=market_type,
            no_bet_flag=True,
            no_bet_reason=f"unhandled_market_type_{market_type.value}",
            notes=[f"politics_app has no engine for type {market_type.value}"],
        )

    # Step 4: review
    return reviewer.review(inp, output)


def _extract_yes_entity(title: str) -> str:
    """
    Heuristic: extract the candidate/entity on the 'yes' side from the market title.
    E.g. "Will Trump win the 2026 Senate race?" → "Trump"
    """
    import re
    m = re.search(r"Will\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s+", title)
    if m:
        return m.group(1)
    # Try "X wins" pattern
    m = re.search(r"([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s+wins?\b", title, re.IGNORECASE)
    if m:
        return m.group(1)
    return ""
