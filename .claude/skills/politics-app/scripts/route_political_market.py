#!/usr/bin/env python3
"""
route_political_market.py — route a market JSON to politics_app or mentions_app.

Usage:
  python route_political_market.py --market-id KXELEC-2026 --title "Will Democrats win the Senate?"
  echo '{"market_id": "...", "title": "...", "source": "kalshi"}' | python route_political_market.py

Output JSON:
  {
    "target_app": "politics_app",
    "market_type": "election_outcome",
    "jurisdiction": "US_FEDERAL",
    "classification_confidence": 0.88,
    "reject_reason": ""
  }
"""

import argparse
import json
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../../../../"))

from backend.core.politics.router import get_politics_router
from backend.core.politics.models import PoliticsRouterInput


def main() -> None:
    parser = argparse.ArgumentParser(description="Route a political market")
    parser.add_argument("--market-id", type=str, default="UNKNOWN")
    parser.add_argument("--title", type=str)
    parser.add_argument("--description", type=str, default="")
    parser.add_argument("--source", type=str, default="manual")
    parser.add_argument("--price-yes", type=float, default=None)
    args = parser.parse_args()

    if not args.title and not sys.stdin.isatty():
        data = json.load(sys.stdin)
        title = data.get("title", "")
        description = data.get("description", "")
        market_id = data.get("market_id", "UNKNOWN")
        source = data.get("source", "manual")
        price_yes = data.get("current_price_yes")
    else:
        title = args.title or ""
        description = args.description
        market_id = args.market_id
        source = args.source
        price_yes = args.price_yes

    if not title:
        print(json.dumps({"error": "title is required"}))
        sys.exit(1)

    inp = PoliticsRouterInput(
        source=source,
        market_id=market_id,
        title=title,
        description=description,
        current_price_yes=price_yes,
    )

    router = get_politics_router()
    result = router.route(inp)

    output = {
        "target_app": result.target_app,
        "market_type": result.market_type.value,
        "jurisdiction": result.jurisdiction.value,
        "classification_confidence": round(result.classification_confidence, 3),
        "reject_reason": result.reject_reason,
    }
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
