#!/usr/bin/env python3
"""Run ufc_fight_app against a sample or provided input."""
import json, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../../../../"))
from backend.core.sports.apps.ufc_fight_app import run
from backend.core.sports.companion_router import RouterInput

SAMPLE = RouterInput(
    source="kalshi", market_id="KXUFC-309-JONES-ASPINALL",
    league="UFC", market_type="moneyline", phase="pre_game",
    raw_metadata={
        "str_acc_a": 0.56, "str_acc_b": 0.48,
        "str_def_a": 0.63, "str_def_b": 0.55,
        "td_acc_a": 0.42, "td_acc_b": 0.38,
        "td_def_a": 0.78, "td_def_b": 0.65,
        "finish_rate_a": 0.74, "finish_rate_b": 0.62,
        "reach_diff": 3.0, "weight_class": "heavyweight",
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
