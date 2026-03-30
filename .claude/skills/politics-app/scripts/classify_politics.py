#!/usr/bin/env python3
"""
classify_politics.py — classify a political market's type and jurisdiction.

Usage:
  python classify_politics.py --title "Will Trump win the 2026 Senate race?"
  python classify_politics.py --title "Will Biden say 'Ukraine' in tonight's debate?"
  echo '{"title": "...", "description": "..."}' | python classify_politics.py
"""

import argparse
import json
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../../../../"))

from backend.core.politics.router import classify_market_type, classify_jurisdiction


def main() -> None:
    parser = argparse.ArgumentParser(description="Classify a political market")
    parser.add_argument("--title", type=str, help="Market title")
    parser.add_argument("--description", type=str, default="", help="Market description")
    args = parser.parse_args()

    # Support piped JSON
    if not args.title and not sys.stdin.isatty():
        data = json.load(sys.stdin)
        title = data.get("title", "")
        description = data.get("description", "")
    else:
        title = args.title or ""
        description = args.description

    if not title:
        print(json.dumps({"error": "title is required"}))
        sys.exit(1)

    market_type, confidence = classify_market_type(title, description)
    jurisdiction = classify_jurisdiction(title, description)

    target_app = "mentions_app" if market_type.value == "mention_resolution" else (
        "politics_app" if market_type.value != "unknown" else "unknown"
    )

    result = {
        "title": title,
        "market_type": market_type.value,
        "jurisdiction": jurisdiction.value,
        "classification_confidence": round(confidence, 3),
        "target_app": target_app,
    }
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
