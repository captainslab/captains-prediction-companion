#!/usr/bin/env python3
"""
validate_politics_config.py — validate PoliticsAlphaConfig and WorldMonitorConfig.

Usage:
  python validate_politics_config.py
"""

import json
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../../../../"))

from backend.core.politics.config import (
    DEFAULT_POLITICS_ALPHA_CONFIG,
    DEFAULT_WORLDMONITOR_CONFIG,
)


def validate_alpha_config(cfg) -> list[str]:
    errors = []
    if not (0 < cfg.min_edge_cents <= 20):
        errors.append(f"min_edge_cents={cfg.min_edge_cents} out of range (0, 20]")
    if not (0 < cfg.min_confidence < 1):
        errors.append(f"min_confidence={cfg.min_confidence} out of range (0, 1)")
    weight_sum = cfg.polling_weight + cfg.market_consensus_weight + cfg.news_sentiment_weight
    if abs(weight_sum - 1.0) > 0.001:
        errors.append(f"weights sum to {weight_sum:.3f}, expected 1.0")
    if cfg.recency_window_days < 1:
        errors.append(f"recency_window_days={cfg.recency_window_days} must be >= 1")
    return errors


def validate_wm_config(cfg) -> list[str]:
    errors = []
    if cfg.cache_ttl_seconds < 60:
        errors.append(f"cache_ttl_seconds={cfg.cache_ttl_seconds} is very short (<60s)")
    if not (0 < cfg.entity_clustering_threshold < 1):
        errors.append(f"entity_clustering_threshold={cfg.entity_clustering_threshold} out of (0, 1)")
    if cfg.max_sources_per_entity < 1:
        errors.append(f"max_sources_per_entity={cfg.max_sources_per_entity} must be >= 1")
    return errors


def main() -> None:
    results = {}

    alpha_errors = validate_alpha_config(DEFAULT_POLITICS_ALPHA_CONFIG)
    wm_errors = validate_wm_config(DEFAULT_WORLDMONITOR_CONFIG)

    results["alpha_config"] = {
        "valid": len(alpha_errors) == 0,
        "errors": alpha_errors,
        "config": {
            "min_edge_cents": DEFAULT_POLITICS_ALPHA_CONFIG.min_edge_cents,
            "min_confidence": DEFAULT_POLITICS_ALPHA_CONFIG.min_confidence,
            "polling_weight": DEFAULT_POLITICS_ALPHA_CONFIG.polling_weight,
            "market_consensus_weight": DEFAULT_POLITICS_ALPHA_CONFIG.market_consensus_weight,
            "news_sentiment_weight": DEFAULT_POLITICS_ALPHA_CONFIG.news_sentiment_weight,
        },
    }
    results["worldmonitor_config"] = {
        "valid": len(wm_errors) == 0,
        "errors": wm_errors,
        "config": {
            "cache_ttl_seconds": DEFAULT_WORLDMONITOR_CONFIG.cache_ttl_seconds,
            "fetch_polling_data": DEFAULT_WORLDMONITOR_CONFIG.fetch_polling_data,
            "fetch_news_sentiment": DEFAULT_WORLDMONITOR_CONFIG.fetch_news_sentiment,
            "fetch_prediction_market_consensus": DEFAULT_WORLDMONITOR_CONFIG.fetch_prediction_market_consensus,
            "perplexity_search_depth": DEFAULT_WORLDMONITOR_CONFIG.perplexity_search_depth,
        },
    }

    all_valid = all(r["valid"] for r in results.values())
    results["overall_valid"] = all_valid

    print(json.dumps(results, indent=2))
    sys.exit(0 if all_valid else 1)


if __name__ == "__main__":
    main()
