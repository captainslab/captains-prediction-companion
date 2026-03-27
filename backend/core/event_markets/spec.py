"""Workflow and output contract for generic event-market research."""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from typing import Any

from core.event_markets.models import EventMarketContext, EventMarketPipelinePlan
from core.event_markets.sources import canonicalize_market_venue, normalize_event_domain


@dataclass(slots=True)
class EventMarketWorkflowStage:
    """One explicit stage in the event-market workflow."""

    stage: str
    purpose: str
    input_focus: str
    output_focus: str


@dataclass(slots=True)
class EventMarketWorkflowSpec:
    """Reusable workflow definition for event-market research."""

    name: str
    stages: tuple[EventMarketWorkflowStage, ...]
    source_order: tuple[str, ...]
    decision_rule: str
    notes: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class EventMarketOutputField:
    """One output field in the standard result shape."""

    name: str
    kind: str
    required: bool
    description: str


@dataclass(slots=True)
class EventMarketOutputSpec:
    """Standard output shape for the event-market pipeline."""

    name: str
    sections: tuple[tuple[str, tuple[EventMarketOutputField, ...]], ...]
    notes: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "sections": [
                {
                    "section": section_name,
                    "fields": [asdict(field) for field in fields],
                }
                for section_name, fields in self.sections
            ],
            "notes": self.notes,
        }


@dataclass(slots=True)
class EventMarketSummary:
    """Compact summary block rendered directly in user-facing surfaces."""

    headline: str
    recommendation: str
    one_line_reason: str


@dataclass(slots=True)
class EventMarketUserFacingOutput:
    """Compact event-market card safe to render directly in the UI."""

    source: dict[str, Any]
    event_domain: str
    event_type: str
    market_type: str
    status: str
    confidence: str
    summary: EventMarketSummary
    next_action: str | None
    context: dict[str, Any]
    market_view: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


SPORTS_EVENT_TYPES = {"ncaamb_game", "mlb_game", "nfl_game", "nba_game"}
MARKET_TYPE_DEFAULT_RECOMMENDATIONS = {
    "mention": "watch",
    "moneyline": "watch",
    "spread": "watch",
    "total": "watch",
    "player_prop": "watch",
}
EVENT_TYPE_TO_DOMAIN = {
    "earnings_call": "corporate",
    "ncaamb_game": "sports",
    "mlb_game": "sports",
    "nfl_game": "sports",
    "nba_game": "sports",
    "speech": "politics",
    "interview": "media",
    "hearing": "politics",
    "press_conference": "politics",
}


def build_event_market_workflow_spec(
    context: EventMarketContext,
    plan: EventMarketPipelinePlan,
) -> EventMarketWorkflowSpec:
    """Build the explicit workflow definition for the given market."""
    domain = context.domain or "general"
    notes = (
        f"Market venue: {plan.venue}. "
        f"Domain: {domain}. "
        "Kalshi or the chosen venue is the market source, Perplexity is the research source, and the scraper skill is the evidence source."
    )

    stages = (
        EventMarketWorkflowStage(
            stage="intake",
            purpose="Identify the market, venue, domain, and contract boundary.",
            input_focus="market title, market id, venue, question, domain",
            output_focus="canonical market context",
        ),
        EventMarketWorkflowStage(
            stage="market",
            purpose="Read the venue itself before looking anywhere else.",
            input_focus="contract wording, resolution rules, price, order book",
            output_focus="venue-grounded market snapshot",
        ),
        EventMarketWorkflowStage(
            stage="research",
            purpose="Use Perplexity to find the authoritative outside source.",
            input_focus="what source actually settles the dispute",
            output_focus="ranked source tree and source summary",
        ),
        EventMarketWorkflowStage(
            stage="evidence",
            purpose="Use the scraper skill to extract the exact supporting facts.",
            input_focus="official pages, transcripts, filings, schedules, scoreboards",
            output_focus="verbatim or structured evidence",
        ),
        EventMarketWorkflowStage(
            stage="pricing",
            purpose="Convert the evidence into fair probability and edge.",
            input_focus="market probability vs. fair probability",
            output_focus="EV, confidence, and stake cap",
        ),
        EventMarketWorkflowStage(
            stage="decision",
            purpose="Apply no-bet filters and produce a final action.",
            input_focus="confidence, stale data, CLV, execution risk",
            output_focus="buy_yes, buy_no, or pass",
        ),
        EventMarketWorkflowStage(
            stage="logging",
            purpose="Store the market source tree and final decision for reuse.",
            input_focus="all intermediate outputs",
            output_focus="audit-ready decision record",
        ),
    )

    return EventMarketWorkflowSpec(
        name="event-market-research",
        stages=stages,
        source_order=plan.source_order,
        decision_rule=plan.decision_rule,
        notes=notes,
    )


def _clean_text(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip()
    return cleaned or None


def _combined_context_text(context: EventMarketContext) -> str:
    values = [
        context.domain,
        context.market_type,
        context.market_subtype,
        context.title,
        context.question,
        context.metadata.get("event_name") if context.metadata else None,
        context.metadata.get("program") if context.metadata else None,
    ]
    cleaned = [_clean_text(value) for value in values if isinstance(value, str)]
    return " ".join(cleaned).lower()


def _metadata_value(metadata: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = metadata.get(key)
        if value is None:
            continue
        if isinstance(value, str):
            cleaned = _clean_text(value)
            if cleaned is not None:
                return cleaned
            continue
        return value
    return None


def _extract_matchup(text: str | None) -> tuple[str | None, str | None]:
    if not text:
        return None, None
    pattern = re.compile(
        r"(?P<away>[A-Za-z0-9 .&'-]+?)\s+(?:vs\.?|at)\s+(?P<home>[A-Za-z0-9 .&'-]+)",
        re.IGNORECASE,
    )
    match = pattern.search(text)
    if not match:
        return None, None
    away = _clean_text(match.group("away"))
    home = _clean_text(match.group("home"))
    return away, home


def _extract_target_phrase(*values: str | None) -> str | None:
    patterns = (
        re.compile(r'"([^"]+)"'),
        re.compile(r"'([^']+)'"),
        re.compile(r"\bsay\s+([A-Za-z0-9 .&/-]+?)(?:\?|$)", re.IGNORECASE),
        re.compile(
            r"\bmention(?:ing|ed)?\s+([A-Za-z0-9 .&/-]+?)(?:\?|$)",
            re.IGNORECASE,
        ),
    )
    for value in values:
        if not value:
            continue
        for pattern in patterns:
            match = pattern.search(value)
            if match:
                return _clean_text(match.group(1))
    return None


def _infer_market_type(context: EventMarketContext) -> str:
    domain_hint = normalize_event_domain(context.domain)
    combined = _combined_context_text(context)

    if any(token in combined for token in ("mention", "phrase", "say ", "said ")):
        return "mention"
    if any(token in combined for token in ("player prop", "player_prop", "props", "stat")):
        return "player_prop"
    if any(token in combined for token in ("spread", "cover")):
        return "spread"
    if any(token in combined for token in ("total", "over ", "under ")):
        return "total"
    if domain_hint == "sports" and any(
        token in combined for token in ("moneyline", "win", "winner")
    ):
        return "moneyline"
    return "general"


def _infer_event_type(context: EventMarketContext) -> str:
    domain_hint = normalize_event_domain(context.domain)
    combined = _combined_context_text(context)

    if domain_hint == "earnings" or any(
        token in combined
        for token in ("earnings", "quarterly results", "earnings call", "q1", "q2", "q3", "q4")
    ):
        return "earnings_call"
    if domain_hint == "sports" or "sports_" in combined:
        if any(token in combined for token in ("ncaamb", "ncaa", "march madness", "college basketball")):
            return "ncaamb_game"
        if any(token in combined for token in ("mlb", "baseball", "first pitch")):
            return "mlb_game"
        if any(token in combined for token in ("nfl", "football", "kickoff")):
            return "nfl_game"
        if any(token in combined for token in ("nba", "basketball", "tipoff")):
            return "nba_game"
    if any(token in combined for token in ("hearing", "committee", "witness")):
        return "hearing"
    if any(token in combined for token in ("press conference", "presser", "briefing")):
        return "press_conference"
    if any(token in combined for token in ("interview", "host", "program")):
        return "interview"
    if any(token in combined for token in ("speech", "remarks", "address", "rally")):
        return "speech"
    return "general"


def _infer_event_domain(event_type: str, context: EventMarketContext) -> str:
    domain_hint = normalize_event_domain(context.domain)
    if event_type in EVENT_TYPE_TO_DOMAIN:
        if event_type in {"speech", "press_conference", "hearing"} and domain_hint == "mention":
            return "media"
        return EVENT_TYPE_TO_DOMAIN[event_type]
    if domain_hint == "sports":
        return "sports"
    if domain_hint == "earnings":
        return "corporate"
    if domain_hint == "politics":
        return "politics"
    if domain_hint == "mention":
        return "media"
    return "general"


def _build_context(event_type: str, context: EventMarketContext) -> dict[str, Any]:
    metadata = dict(context.metadata or {})
    matchup_away, matchup_home = _extract_matchup(context.title or context.question)
    teams = metadata.get("teams") if isinstance(metadata.get("teams"), dict) else {}
    away = _metadata_value(metadata, "away_team", "away") or teams.get("away") or matchup_away
    home = _metadata_value(metadata, "home_team", "home") or teams.get("home") or matchup_home

    if event_type == "earnings_call":
        return {
            "company": _metadata_value(metadata, "company", "issuer"),
            "event_name": _metadata_value(metadata, "event_name") or context.title,
            "start_time": _metadata_value(metadata, "start_time", "call_start_time"),
            "quarter": _metadata_value(metadata, "quarter", "reporting_quarter"),
        }
    if event_type == "ncaamb_game":
        return {
            "teams": {"away": away, "home": home},
            "venue": _metadata_value(metadata, "venue"),
            "tipoff": _metadata_value(metadata, "tipoff", "start_time"),
            "tournament_stage": _metadata_value(metadata, "tournament_stage"),
            "broadcast": {"network": _metadata_value(metadata, "broadcast_network", "network")},
        }
    if event_type == "mlb_game":
        return {
            "teams": {"away": away, "home": home},
            "venue": _metadata_value(metadata, "venue"),
            "first_pitch": _metadata_value(metadata, "first_pitch", "start_time"),
            "weather_summary": _metadata_value(metadata, "weather_summary"),
            "broadcast": {
                "network": _metadata_value(metadata, "broadcast_network", "network"),
                "announcers": metadata.get("announcers", []),
            },
        }
    if event_type == "nfl_game":
        return {
            "teams": {"away": away, "home": home},
            "venue": _metadata_value(metadata, "venue"),
            "kickoff": _metadata_value(metadata, "kickoff", "start_time"),
            "weather_summary": _metadata_value(metadata, "weather_summary"),
            "broadcast": {"network": _metadata_value(metadata, "broadcast_network", "network")},
        }
    if event_type == "nba_game":
        return {
            "teams": {"away": away, "home": home},
            "venue": _metadata_value(metadata, "venue"),
            "tipoff": _metadata_value(metadata, "tipoff", "start_time"),
            "broadcast": {"network": _metadata_value(metadata, "broadcast_network", "network")},
        }
    if event_type == "speech":
        return {
            "speaker": _metadata_value(metadata, "speaker"),
            "event_name": _metadata_value(metadata, "event_name") or context.title,
            "start_time": _metadata_value(metadata, "start_time"),
            "venue": _metadata_value(metadata, "venue"),
            "platform": _metadata_value(metadata, "platform"),
        }
    if event_type == "interview":
        return {
            "speaker": _metadata_value(metadata, "speaker"),
            "program": _metadata_value(metadata, "program") or context.title,
            "start_time": _metadata_value(metadata, "start_time"),
            "platform": _metadata_value(metadata, "platform"),
            "host": _metadata_value(metadata, "host"),
        }
    if event_type == "hearing":
        return {
            "witness": _metadata_value(metadata, "witness"),
            "committee": _metadata_value(metadata, "committee"),
            "start_time": _metadata_value(metadata, "start_time"),
            "venue": _metadata_value(metadata, "venue"),
        }
    if event_type == "press_conference":
        return {
            "speaker": _metadata_value(metadata, "speaker"),
            "event_name": _metadata_value(metadata, "event_name") or context.title,
            "start_time": _metadata_value(metadata, "start_time"),
            "venue": _metadata_value(metadata, "venue"),
            "platform": _metadata_value(metadata, "platform"),
        }
    return {
        "event_name": _metadata_value(metadata, "event_name") or context.title,
        "start_time": _metadata_value(metadata, "start_time"),
        "venue": _metadata_value(metadata, "venue"),
    }


def _default_mention_watch_for(event_type: str, target_phrase: str | None) -> list[str]:
    phrase = target_phrase or "the target phrase"
    if event_type == "earnings_call":
        return [
            f"prepared remarks use {phrase}",
            f"analysts force {phrase} into Q&A",
            "management pivots to substitute wording",
        ]
    if event_type in SPORTS_EVENT_TYPES:
        return [
            f"pregame coverage uses {phrase}",
            f"in-game commentary repeats {phrase}",
            "the broadcast crew avoids the exact wording",
        ]
    return [
        f"the speaker uses {phrase} in opening remarks",
        f"the moderator or host prompts {phrase}",
        "the exact wording is replaced by synonyms",
    ]


def _build_market_view(
    market_type: str,
    event_type: str,
    context: EventMarketContext,
) -> dict[str, Any]:
    metadata = dict(context.metadata or {})
    recommendation = MARKET_TYPE_DEFAULT_RECOMMENDATIONS.get(market_type, "pass")
    confidence = "medium" if market_type != "general" else "low"

    if market_type == "mention":
        target_phrase = _metadata_value(metadata, "target_phrase", "phrase") or _extract_target_phrase(
            context.title, context.question
        )
        return {
            "target_phrase": target_phrase,
            "rules_summary": _metadata_value(metadata, "rules_summary")
            or "Confirm the exact phrase, allowed speaker set, and venue counting rules before pricing.",
            "mention_paths": metadata.get("mention_paths", {}),
            "trade_view": {
                "best_side": recommendation,
                "market_yes": None,
                "fair_yes": None,
                "edge_cents": None,
            },
            "watch_for": metadata.get("watch_for")
            or _default_mention_watch_for(event_type, target_phrase),
        }
    if market_type == "moneyline":
        return {
            "moneyline": {
                "lean": recommendation,
                "confidence": confidence,
                "reason": "The game is classified, but the app still needs live prices and matchup inputs before taking a side.",
            },
            "game_factors": metadata.get("game_factors", []),
            "price_view": {
                "market_implied": None,
                "fair_implied": None,
                "edge_cents": None,
                "best_action": recommendation,
            },
        }
    if market_type == "spread":
        return {
            "spread": {
                "line": _metadata_value(metadata, "line", "spread_line"),
                "lean": recommendation,
                "confidence": confidence,
                "reason": "The spread is mapped, but the app still needs the current line and a fair margin estimate.",
            },
            "margin_factors": metadata.get("margin_factors", []),
            "price_view": {
                "market_yes": None,
                "fair_yes": None,
                "edge_cents": None,
                "best_action": recommendation,
            },
        }
    if market_type == "total":
        return {
            "total": {
                "line": _metadata_value(metadata, "line", "total_line"),
                "lean": recommendation,
                "confidence": confidence,
                "reason": "The totals market is mapped, but the app still needs the posted number and a scoring estimate.",
            },
            "scoring_factors": metadata.get("scoring_factors", []),
            "price_view": {
                "market_yes": None,
                "fair_yes": None,
                "edge_cents": None,
                "best_action": recommendation,
            },
        }
    if market_type == "player_prop":
        return {
            "player_prop": {
                "player": _metadata_value(metadata, "player"),
                "stat_type": _metadata_value(metadata, "stat_type"),
                "line": _metadata_value(metadata, "line", "prop_line"),
                "lean": recommendation,
                "confidence": confidence,
                "reason": "The player prop is mapped, but the app still needs projection inputs and live pricing.",
            },
            "projection": {
                "fair_value": None,
                "expected_stat": None,
            },
            "price_view": {
                "market_yes": None,
                "fair_yes": None,
                "edge_cents": None,
                "best_action": recommendation,
            },
        }
    return {
        "status_note": "The market type is not mapped to a user-facing market view yet.",
    }


def _build_status(event_type: str, market_type: str, market_view: dict[str, Any]) -> str:
    if market_type == "general":
        return "market_unmapped"
    if event_type == "general":
        return "insufficient_context"
    if market_type == "mention" and not market_view.get("target_phrase"):
        return "insufficient_context"
    return "needs_pricing"


def _build_confidence(status: str) -> str:
    if status == "needs_pricing":
        return "medium"
    return "low"


def _build_recommendation(market_type: str, status: str) -> str:
    if status in {"insufficient_context", "market_unmapped", "rules_conflict"}:
        return "pass"
    return MARKET_TYPE_DEFAULT_RECOMMENDATIONS.get(market_type, "pass")


def _build_headline(
    status: str,
    market_type: str,
    event_type: str,
    context: EventMarketContext,
) -> str:
    if status == "market_unmapped":
        return "The market needs a manual classification pass before the app can price it."
    if status == "insufficient_context":
        return "The market needs more event detail before the app can score it."
    if market_type == "mention":
        return "The contract is mapped as a mention market and is ready for pricing."
    if market_type == "moneyline":
        return "The contract is mapped as a game winner market and is ready for pricing."
    if market_type == "spread":
        return "The contract is mapped as a spread market and is ready for pricing."
    if market_type == "total":
        return "The contract is mapped as a totals market and is ready for pricing."
    if market_type == "player_prop":
        return "The contract is mapped as a player prop and is ready for pricing."
    if event_type != "general" and context.title:
        return f"{context.title} is classified and ready for pricing."
    return "The event market is classified and ready for pricing."


def _build_one_line_reason(status: str, market_type: str) -> str:
    if status == "market_unmapped":
        return "The market type is not supported by the current event-market card."
    if status == "insufficient_context":
        return "The app can parse the venue, but it still lacks enough event detail to build an actionable card."
    if market_type == "mention":
        return "The phrase path is mapped, but exact pricing and edge still need to be computed."
    return "The event and market types are classified, but fair value and edge are still missing."


def _build_next_action(status: str, market_type: str, event_type: str) -> str | None:
    if status == "market_unmapped":
        return "review_market_rules"
    if status == "insufficient_context":
        return "confirm_event_context"
    if market_type == "mention" and event_type in SPORTS_EVENT_TYPES:
        return "confirm_broadcast_crew"
    if market_type == "mention":
        return "review_market_rules"
    return "fetch_live_prices"


def build_event_market_user_facing_output(
    context: EventMarketContext,
) -> EventMarketUserFacingOutput:
    """Build the compact event-market card shown to end users."""
    source = {
        "platform": canonicalize_market_venue(context.venue) or context.venue,
        "url": context.url,
        "market_id": context.market_id,
    }
    event_type = _infer_event_type(context)
    event_domain = _infer_event_domain(event_type, context)
    market_type = _infer_market_type(context)
    market_view = _build_market_view(market_type, event_type, context)
    status = _build_status(event_type, market_type, market_view)
    recommendation = _build_recommendation(market_type, status)
    summary = EventMarketSummary(
        headline=_build_headline(status, market_type, event_type, context),
        recommendation=recommendation,
        one_line_reason=_build_one_line_reason(status, market_type),
    )
    return EventMarketUserFacingOutput(
        source=source,
        event_domain=event_domain,
        event_type=event_type,
        market_type=market_type,
        status=status,
        confidence=_build_confidence(status),
        summary=summary,
        next_action=_build_next_action(status, market_type, event_type),
        context=_build_context(event_type, context),
        market_view=market_view,
    )


def build_event_market_output_spec() -> EventMarketOutputSpec:
    """Build the user-facing output schema for the event-market pipeline."""
    sections = (
        (
            "source",
            (
                EventMarketOutputField(
                    name="platform",
                    kind="string",
                    required=True,
                    description="Market venue or platform name.",
                ),
                EventMarketOutputField(
                    name="url",
                    kind="string",
                    required=False,
                    description="Original market URL when provided.",
                ),
                EventMarketOutputField(
                    name="market_id",
                    kind="string",
                    required=False,
                    description="Venue-specific market identifier when available.",
                ),
            ),
        ),
        (
            "classification",
            (
                EventMarketOutputField(
                    name="event_domain",
                    kind="enum[sports, corporate, politics, media, general]",
                    required=True,
                    description="Broad event bucket derived from the event type.",
                ),
                EventMarketOutputField(
                    name="event_type",
                    kind="string",
                    required=True,
                    description="Specific event classification such as earnings_call, nfl_game, or press_conference.",
                ),
                EventMarketOutputField(
                    name="market_type",
                    kind="string",
                    required=True,
                    description="Market mechanic such as mention, moneyline, spread, total, or player_prop.",
                ),
                EventMarketOutputField(
                    name="status",
                    kind="enum[ready, needs_pricing, waiting, insufficient_context, market_unmapped, rules_conflict]",
                    required=True,
                    description="Analysis readiness status, separate from any trade direction.",
                ),
                EventMarketOutputField(
                    name="confidence",
                    kind="enum[low, medium, high]",
                    required=True,
                    description="Confidence in the current card quality, not the event outcome itself.",
                ),
            ),
        ),
        (
            "summary",
            (
                EventMarketOutputField(
                    name="headline",
                    kind="string",
                    required=True,
                    description="Compact headline safe to render directly in the app UI.",
                ),
                EventMarketOutputField(
                    name="recommendation",
                    kind="string",
                    required=True,
                    description="Market-type-aware recommendation such as watch, buy_yes, home, or over.",
                ),
                EventMarketOutputField(
                    name="one_line_reason",
                    kind="string",
                    required=True,
                    description="Single-sentence plain-English rationale without workflow leakage.",
                ),
            ),
        ),
        (
            "action",
            (
                EventMarketOutputField(
                    name="next_action",
                    kind="string",
                    required=False,
                    description="Operational next step such as fetch_live_prices or review_market_rules.",
                ),
            ),
        ),
        (
            "context",
            (
                EventMarketOutputField(
                    name="context",
                    kind="object",
                    required=True,
                    description="Event-specific facts block whose fields vary by event_type.",
                ),
            ),
        ),
        (
            "market_view",
            (
                EventMarketOutputField(
                    name="market_view",
                    kind="object",
                    required=True,
                    description="Market-type-specific analysis block whose fields vary by market_type.",
                ),
            ),
        ),
    )

    return EventMarketOutputSpec(
        name="event-market-output",
        sections=sections,
        notes=(
            "Expose only the compact card in user-facing surfaces. Keep workflow, source-order notes, and planning details internal."
        ),
    )
