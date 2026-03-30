"""
PoliticsIntelIngest — Perplexity-backed intelligence fetcher.

Responsibilities:
- Build targeted search queries from market title + description
- Call Perplexity (via OpenRouter pplx/* routing) for each query type
- Return raw result bundles for downstream clustering and synthesis
- Cache by market_id with configurable TTL
- Degrade gracefully: return partial report if some queries fail
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import dataclass, field
from typing import Any

from ..config import WorldMonitorConfig, DEFAULT_WORLDMONITOR_CONFIG
from ..models import PoliticsIntelReport, NewsSignal, PollDataPoint, PoliticalEntity

# ---------------------------------------------------------------------------
# Query builders
# ---------------------------------------------------------------------------

def _build_polling_query(title: str, entities: list[str]) -> str:
    names = ", ".join(entities) if entities else title
    return f"latest polling data {names} 2026 site:realclearpolitics.com OR fivethirtyeight.com OR 538.com OR nytimes.com polls"


def _build_news_query(title: str) -> str:
    return f"breaking news analysis {title} last 7 days political developments"


def _build_consensus_query(title: str) -> str:
    return f"prediction market odds {title} Kalshi Polymarket PredictIt consensus price 2026"


def _build_narrative_query(title: str, entities: list[str]) -> str:
    names = " ".join(entities[:2]) if entities else title
    return f"political context narrative {names} election forecast analyst expert opinion 2026"


# ---------------------------------------------------------------------------
# Simple in-memory cache
# ---------------------------------------------------------------------------

@dataclass
class _CacheEntry:
    report: PoliticsIntelReport
    fetched_at: float


_INTEL_CACHE: dict[str, _CacheEntry] = {}


def _cache_key(market_id: str) -> str:
    return hashlib.sha256(market_id.encode()).hexdigest()[:16]


def _get_cached(market_id: str, ttl: int) -> PoliticsIntelReport | None:
    key = _cache_key(market_id)
    entry = _INTEL_CACHE.get(key)
    if entry and (time.monotonic() - entry.fetched_at) < ttl:
        report = entry.report
        object.__setattr__(report, "cache_hit", True) if hasattr(report, "__dataclass_fields__") else None
        report.cache_hit = True
        return report
    return None


def _set_cached(market_id: str, report: PoliticsIntelReport) -> None:
    _INTEL_CACHE[_cache_key(market_id)] = _CacheEntry(report=report, fetched_at=time.monotonic())


# ---------------------------------------------------------------------------
# Perplexity caller (OpenRouter pplx/* routing)
# ---------------------------------------------------------------------------

def _call_perplexity(query: str, max_tokens: int = 600) -> dict[str, Any] | None:
    """
    Call Perplexity via OpenRouter.
    Returns parsed JSON response or None on failure.

    Model: perplexity/sonar-pro (research-grade, citations included)
    Fallback: perplexity/sonar
    """
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    if not api_key:
        return None

    try:
        import urllib.request

        payload = json.dumps({
            "model": "perplexity/sonar-pro",
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are a political intelligence analyst. "
                        "Return factual, sourced information only. "
                        "Include source names and recency in your answer. "
                        "Be concise and structured."
                    ),
                },
                {"role": "user", "content": query},
            ],
            "max_tokens": max_tokens,
            "temperature": 0.1,
        }).encode()

        req = urllib.request.Request(
            "https://openrouter.ai/api/v1/chat/completions",
            data=payload,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "HTTP-Referer": "https://captains-companion.local",
                "X-Title": "CaptainsCompanion-WorldMonitor",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode())
    except Exception:
        return None


def _extract_text(response: dict[str, Any] | None) -> str:
    if not response:
        return ""
    try:
        return response["choices"][0]["message"]["content"]
    except (KeyError, IndexError):
        return ""


# ---------------------------------------------------------------------------
# Entity extractor (lightweight heuristic — no external NER dependency)
# ---------------------------------------------------------------------------

_KNOWN_CANDIDATES = {
    "trump", "biden", "harris", "desantis", "haley", "newsom",
    "ocasio-cortez", "aoc", "pelosi", "mcconnell", "schumer",
    "johnson", "romney", "pence", "obama",
}

def _extract_entity_hints(title: str, description: str) -> list[str]:
    """Quick heuristic entity extraction from market text."""
    text = (title + " " + description).lower()
    found = [name for name in _KNOWN_CANDIDATES if name in text]
    # Also grab capitalized tokens as candidate entity names
    import re
    caps = re.findall(r"\b[A-Z][a-z]{2,}\b", title + " " + description)
    combined = list(dict.fromkeys(found + [c.lower() for c in caps]))
    return combined[:6]


# ---------------------------------------------------------------------------
# Main ingest class
# ---------------------------------------------------------------------------

class PoliticsIntelIngest:
    """
    Fetches and assembles a PoliticsIntelReport for a politics market.

    Usage:
        ingest = PoliticsIntelIngest()
        report = ingest.fetch(market_id="KXELEC2026-SEN", title="...", description="...")
    """

    def __init__(self, config: WorldMonitorConfig = DEFAULT_WORLDMONITOR_CONFIG) -> None:
        self.config = config

    def fetch(
        self,
        market_id: str,
        title: str,
        description: str = "",
    ) -> PoliticsIntelReport:
        # Check cache first
        cached = _get_cached(market_id, self.config.cache_ttl_seconds)
        if cached:
            return cached

        entity_hints = _extract_entity_hints(title, description)
        entities: list[PoliticalEntity] = [
            PoliticalEntity(name=e, entity_type="candidate") for e in entity_hints
        ]

        polls: list[PollDataPoint] = []
        news_signals: list[NewsSignal] = []
        narrative_summary = ""
        market_consensus: float | None = None
        sources_used: list[str] = []
        errors: list[str] = []

        # --- Polling data ---
        if self.config.fetch_polling_data:
            q = _build_polling_query(title, entity_hints)
            resp = _call_perplexity(q, max_tokens=400)
            text = _extract_text(resp)
            if text:
                polls = _parse_polls_from_text(text, entity_hints)
                sources_used.append("perplexity/polling")
            else:
                errors.append("polling_fetch_failed")

        # --- News sentiment ---
        if self.config.fetch_news_sentiment:
            q = _build_news_query(title)
            resp = _call_perplexity(q, max_tokens=400)
            text = _extract_text(resp)
            if text:
                news_signals = _parse_news_from_text(text)
                sources_used.append("perplexity/news")
            else:
                errors.append("news_fetch_failed")

        # --- Market consensus price ---
        if self.config.fetch_prediction_market_consensus:
            q = _build_consensus_query(title)
            resp = _call_perplexity(q, max_tokens=200)
            text = _extract_text(resp)
            if text:
                market_consensus = _parse_consensus_price(text)
                if market_consensus is not None:
                    sources_used.append("perplexity/market_consensus")

        # --- Narrative synthesis ---
        q = _build_narrative_query(title, entity_hints)
        resp = _call_perplexity(q, max_tokens=self.config.narrative_max_tokens)
        text = _extract_text(resp)
        if text:
            narrative_summary = text[:800]
            sources_used.append("perplexity/narrative")
        else:
            errors.append("narrative_fetch_failed")

        report = PoliticsIntelReport(
            market_id=market_id,
            entities=entities,
            polls=polls,
            news_signals=news_signals,
            narrative_summary=narrative_summary,
            market_consensus_price=market_consensus,
            data_freshness_hours=0.0,
            sources_used=sources_used,
            cache_hit=False,
            error="; ".join(errors) if errors else None,
        )

        _set_cached(market_id, report)
        return report


# ---------------------------------------------------------------------------
# Lightweight parsers (heuristic — no NLP libs required)
# ---------------------------------------------------------------------------

def _parse_polls_from_text(text: str, entity_hints: list[str]) -> list[PollDataPoint]:
    """Extract poll data points from Perplexity narrative text."""
    import re
    results = []
    # Look for patterns like "Trump 47%, Harris 44%" or "47% Trump"
    pct_pattern = re.compile(
        r"([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?)\s+(\d{1,3}(?:\.\d)?)\s*%|"
        r"(\d{1,3}(?:\.\d)?)\s*%\s+([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?)"
    )
    for m in pct_pattern.finditer(text):
        if m.group(1) and m.group(2):
            name, pct = m.group(1), float(m.group(2))
        elif m.group(3) and m.group(4):
            pct, name = float(m.group(3)), m.group(4)
        else:
            continue
        if 0 < pct <= 100:
            results.append(PollDataPoint(
                source="perplexity_extracted",
                date="2026",
                candidate_or_option=name,
                support_pct=pct,
            ))
    return results[:10]


def _parse_news_from_text(text: str) -> list[NewsSignal]:
    """Extract news signals from Perplexity narrative text."""
    import re
    signals = []
    # Split on sentence boundaries and score sentiment naively
    sentences = re.split(r"(?<=[.!?])\s+", text)
    positive_words = {"win", "lead", "ahead", "surge", "gain", "strong", "favor"}
    negative_words = {"lose", "trail", "behind", "drop", "weak", "scandal", "crisis"}

    for sent in sentences[:8]:
        lower = sent.lower()
        pos = sum(1 for w in positive_words if w in lower)
        neg = sum(1 for w in negative_words if w in lower)
        sentiment = "positive" if pos > neg else ("negative" if neg > pos else "neutral")
        signals.append(NewsSignal(
            headline=sent[:120],
            source="perplexity_extracted",
            date="2026",
            sentiment=sentiment,
            relevance=0.6,
        ))
    return signals


def _parse_consensus_price(text: str) -> float | None:
    """Extract a consensus probability from prediction market text."""
    import re
    # Look for patterns like "65 cents", "65%", "0.65"
    pct = re.search(r"(\d{1,3}(?:\.\d{1,2})?)\s*(?:%|cents?|¢)", text)
    dec = re.search(r"\b0\.\d{2,3}\b", text)
    if pct:
        val = float(pct.group(1))
        if val > 1:
            val /= 100
        if 0 < val < 1:
            return val
    if dec:
        val = float(dec.group(0))
        if 0 < val < 1:
            return val
    return None
