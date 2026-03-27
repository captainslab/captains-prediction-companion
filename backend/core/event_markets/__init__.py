"""Generic event-market research pipeline."""

from core.event_markets.models import (
    EventMarketContext,
    EventMarketPipelinePlan,
    EventMarketPipelineStep,
)
from core.event_markets.pipeline import (
    build_event_market_pipeline,
    build_event_market_plan_payload,
)
from core.event_markets.spec import (
    EventMarketOutputSpec,
    EventMarketUserFacingOutput,
    EventMarketWorkflowSpec,
    build_event_market_output_spec,
    build_event_market_user_facing_output,
    build_event_market_workflow_spec,
)
from core.event_markets.sources import (
    DEFAULT_EVENT_MARKET_SOURCE_STACK,
    canonicalize_market_venue,
    build_market_source_order,
    normalize_event_domain,
)

__all__ = [
    "DEFAULT_EVENT_MARKET_SOURCE_STACK",
    "EventMarketContext",
    "EventMarketOutputSpec",
    "EventMarketUserFacingOutput",
    "EventMarketPipelinePlan",
    "EventMarketPipelineStep",
    "EventMarketWorkflowSpec",
    "build_event_market_pipeline",
    "build_event_market_plan_payload",
    "build_event_market_output_spec",
    "build_event_market_user_facing_output",
    "build_market_source_order",
    "build_event_market_workflow_spec",
    "canonicalize_market_venue",
    "normalize_event_domain",
]
