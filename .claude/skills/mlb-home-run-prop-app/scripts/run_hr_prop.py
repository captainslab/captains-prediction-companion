#!/usr/bin/env python3
"""Run mlb_home_run_prop_app against a sample or provided input."""
import json, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../../../../"))
from backend.core.sports.apps.mlb_home_run_prop_app import run
from backend.core.sports.companion_router import RouterInput

SAMPLE = RouterInput(
    source="kalshi", market_id="KXMLB-OHTANI-HR-20260401",
    league="MLB", market_type="prop_hr", phase="pre_game",
    raw_metadata={
        "lineup_confirmed": True, "barrel_rate": 0.112,
        "opp_fip": 3.85, "hr_park_factor": 1.08,
        "projected_pas": 4, "batter_hand": "L", "pitcher_hand": "R",
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
        "no_bet_reason": getattr(result, "no_bet_reason", ""),
        "notes": result.notes,
        "extra": result.extra,
    }, indent=2))

if __name__ == "__main__":
    main()
