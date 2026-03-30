#!/usr/bin/env python3
"""Run baseball_game_app against a sample or provided input."""
import json, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../../../../"))
from backend.core.sports.apps.baseball_game_app import run
from backend.core.sports.companion_router import RouterInput

SAMPLE = RouterInput(
    source="kalshi", market_id="KXMLB-CHC-LAD-20260401",
    league="MLB", market_type="total", phase="pre_game",
    raw_metadata={
        "fip_home": 3.45, "fip_away": 4.12,
        "park_factor": 1.05, "wind_mph": 12, "wind_dir": "out",
        "temp_f": 62, "lineup_confirmed": True, "market_total": 8.5,
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
