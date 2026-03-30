#!/usr/bin/env python3
"""Run mlb_strikeout_prop_app against a sample or provided input."""
import json, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../../../../"))
from backend.core.sports.apps.mlb_strikeout_prop_app import run
from backend.core.sports.companion_router import RouterInput

SAMPLE = RouterInput(
    source="kalshi", market_id="KXMLB-SKUBAL-K-20260401",
    league="MLB", market_type="prop_k", phase="pre_game",
    raw_metadata={
        "lineup_confirmed": True, "k_per_bf": 0.285,
        "swstr_pct": 0.142, "opp_k_pct": 0.238,
        "projected_bf": 24, "market_line": 6.5,
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
