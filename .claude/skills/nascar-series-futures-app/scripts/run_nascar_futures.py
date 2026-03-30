#!/usr/bin/env python3
"""Run nascar_series_futures_app against a sample or provided input."""
import json, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../../../../"))
from backend.core.sports.apps.nascar_series_futures_app import run
from backend.core.sports.companion_router import RouterInput

SAMPLE = RouterInput(
    source="kalshi", market_id="KXNASCARCUPSERIES-NCS26",
    league="NASCAR_CUP", market_type="series_championship", phase="futures",
    raw_metadata={
        "points_rank": 2, "points_deficit": 45, "wins": 3,
        "playoff_eligible": True, "races_remaining": 18,
        "manufacturer": "Toyota",
    },
)

def main():
    inp = SAMPLE
    if not sys.stdin.isatty():
        data = json.load(sys.stdin)
        inp = RouterInput(**data)
    result = run(inp)
    print(json.dumps({
        "pipeline": result.pipeline,
        "fair_probability": result.fair_probability,
        "edge": round(result.edge, 4),
        "confidence": round(result.confidence, 4),
        "no_bet_flag": result.no_bet_flag,
        "notes": result.notes,
        "extra": result.extra,
    }, indent=2))

if __name__ == "__main__":
    main()
