#!/usr/bin/env python3
"""Compute Kelly sizing for a given edge, confidence, and odds."""
import argparse, json, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../../../../"))
from backend.core.sports.kelly import KellyBankrollManager, compute_ev

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--edge", type=float, required=True, help="Edge as decimal (e.g. 0.05 = 5¢)")
    parser.add_argument("--confidence", type=float, default=0.60)
    parser.add_argument("--odds", type=float, default=-110, help="American odds")
    parser.add_argument("--bankroll", type=float, default=1000.0)
    parser.add_argument("--live", action="store_true", help="Apply live scaling (×0.5)")
    args = parser.parse_args()

    mgr = KellyBankrollManager(bankroll=args.bankroll)
    units = mgr.size_bet(args.edge, args.confidence, args.odds)
    if args.live:
        units *= 0.5
    ev = compute_ev(args.edge, args.odds)

    print(json.dumps({
        "edge": args.edge,
        "edge_cents": round(args.edge * 100, 2),
        "confidence": args.confidence,
        "odds": args.odds,
        "bankroll": args.bankroll,
        "kelly_units": round(units, 4),
        "kelly_dollars": round(units * args.bankroll, 2),
        "ev_cents": round(ev, 2),
        "live_scaled": args.live,
    }, indent=2))

if __name__ == "__main__":
    main()
