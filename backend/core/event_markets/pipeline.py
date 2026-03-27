"""Generic event-market research pipeline."""

from __future__ import annotations

from core.event_markets.config import EventMarketPipelineConfig
from core.event_markets.models import (
    EventMarketContext,
    EventMarketPipelinePlan,
    EventMarketPipelineStep,
)
from core.event_markets.spec import (
    build_event_market_output_spec,
    build_event_market_user_facing_output,
    build_event_market_workflow_spec,
)
from core.event_markets.sources import (
    build_market_source_order,
    canonicalize_market_venue,
    normalize_event_domain,
)

DECISION_RULE = (
    "Market first, Perplexity second, scraper third, decision layer last."
)


def build_event_market_pipeline(
    context: EventMarketContext,
    *,
    config: EventMarketPipelineConfig | None = None,
) -> EventMarketPipelinePlan:
    """
    Build the reusable process for any event market.

    The process is intentionally simple:
    1. Read the market venue itself.
    2. Use Perplexity to discover the authoritative outside source.
    3. Use the scraper skill to extract exact evidence from that source.
    4. Convert the evidence into probability, EV, and stake.
    """
    config = config or EventMarketPipelineConfig()

    venue = canonicalize_market_venue(context.venue) or config.default_source_stack[0]
    domain = normalize_event_domain(context.domain) or "general"
    source_order = build_market_source_order(
        venue,
        default_source_stack=config.default_source_stack,
    )

    decision_notes = (
        "Kalshi is the market source when the venue is Kalshi. "
        "Perplexity is used to discover the authoritative outside source. "
        "The scraper skill is used only for exact evidence extraction from public pages."
    )

    steps = (
        EventMarketPipelineStep(
            stage="market",
            source=source_order[0],
            purpose="Fetch contract wording, resolution rules, current price, and order-book context.",
            notes="Treat the market as the pricing venue, not the truth source.",
        ),
        EventMarketPipelineStep(
            stage="research",
            source=source_order[1],
            purpose="Find the authoritative outside source and summarize the relevant facts.",
            notes="Use only when the source is unclear, changing, or needs ranking.",
        ),
        EventMarketPipelineStep(
            stage="evidence",
            source=source_order[2],
            purpose="Scrape the exact public page, transcript, filing, or schedule for evidence.",
            notes="Use the scraper skill when direct page extraction is cheaper than a vendor API.",
        ),
        EventMarketPipelineStep(
            stage="decision",
            source="decision_layer",
            purpose="Convert the evidence into probability, EV, and a stake or pass decision.",
            notes="Keep edge calculations separate from source discovery.",
        ),
    )

    metadata = {
        "market_id": context.market_id,
        "title": context.title,
        "question": context.question,
        "market_type": context.market_type,
        "market_subtype": context.market_subtype,
        "url": context.url,
        "resolution_source": context.resolution_source,
    }
    if context.metadata:
        metadata["context"] = dict(context.metadata)

    notes = context.metadata.get("notes", "") if context.metadata else ""
    if notes:
        notes = f"{notes} "
    notes += decision_notes

    return EventMarketPipelinePlan(
        venue=venue,
        domain=domain,
        source_order=source_order,
        steps=steps,
        primary_source=source_order[0],
        research_source=source_order[1],
        evidence_source=source_order[2],
        decision_rule=DECISION_RULE,
        notes=notes,
        metadata=metadata,
    )


def build_event_market_plan_payload(context: EventMarketContext) -> dict[str, object]:
    """Build the visible card and hidden workflow payload for a market."""
    plan = build_event_market_pipeline(context)
    workflow = build_event_market_workflow_spec(context, plan)
    output_contract = build_event_market_output_spec()
    user_facing = build_event_market_user_facing_output(context)
    return {
        "user_facing": user_facing.to_dict(),
        "hidden": {
            "plan": plan.to_dict(),
            "workflow": workflow.to_dict(),
            "output_contract": output_contract.to_dict(),
        },
    }
