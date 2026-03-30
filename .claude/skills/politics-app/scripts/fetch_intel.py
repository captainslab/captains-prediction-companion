#!/usr/bin/env python3
"""
fetch_intel.py — run worldmonitor intelligence fetch for a given market.

Requires: OPENROUTER_API_KEY in environment (uses perplexity/sonar-pro)

Usage:
  python fetch_intel.py --market-id KXELEC-2026 --title "Will Democrats win the Senate?"
  OPENROUTER_API_KEY=sk-... python fetch_intel.py --market-id X --title "..."
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../../../../"))

from backend.core.politics.worldmonitor.ingest import PoliticsIntelIngest
from backend.core.politics.worldmonitor.narrative import PoliticsNarrativeEngine


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--market-id", required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--description", default="")
    parser.add_argument("--target-entity", default="", help="The 'yes' side entity for polling aggregation")
    args = parser.parse_args()

    if not os.environ.get("OPENROUTER_API_KEY"):
        print(json.dumps({"error": "OPENROUTER_API_KEY not set — worldmonitor requires OpenRouter"}))
        sys.exit(1)

    ingest = PoliticsIntelIngest()
    intel = ingest.fetch(args.market_id, args.title, args.description)

    narrative_engine = PoliticsNarrativeEngine()
    narrative = narrative_engine.synthesize(intel, target_entity=args.target_entity)

    output = {
        "market_id": intel.market_id,
        "cache_hit": intel.cache_hit,
        "error": intel.error,
        "entity_count": len(intel.entities),
        "poll_count": len(intel.polls),
        "news_signal_count": len(intel.news_signals),
        "sources_used": intel.sources_used,
        "narrative_summary_preview": intel.narrative_summary[:200] if intel.narrative_summary else "",
        "market_consensus_price": intel.market_consensus_price,
        "narrative_context": {
            "implied_prob_low": round(narrative.implied_prob_low, 3),
            "implied_prob_mid": round(narrative.implied_prob_mid, 3),
            "implied_prob_high": round(narrative.implied_prob_high, 3),
            "dominant_frame": narrative.dominant_frame,
            "sentiment_net": round(narrative.sentiment_net, 3),
            "data_quality": narrative.data_quality,
            "data_gaps": narrative.data_gaps,
            "analyst_brief": narrative.analyst_brief,
        },
    }
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
