# MLB Output Schemas

Use this document to validate daily MLB workflow outputs written under:

`state/mlb/YYYY-MM-DD/`

Source of truth:

- `runbooks/mlb-prediction-process.md`
- `runbooks/mlb-market-router-spec.md`

This is a schema runbook only. Do not edit `src/`, create cron jobs, make live picks, or place trades from this document.

## Output Files

Required daily files:

1. `slate_manifest.json`
2. `source_registry.json`
3. `picks.json`
4. `run_log.md`
5. `daily-baseball-guide.md`

All examples use placeholder games only.

## Shared Enums

Use these exact enum values.

```json
{
  "market_lane": [
    "moneyline",
    "run_line",
    "game_total",
    "yrfi_nrfi",
    "home_run_hitter",
    "pitcher_strikeouts"
  ],
  "route_status": [
    "ROUTED",
    "AMBIGUOUS",
    "BLOCKED",
    "OUT_OF_SCOPE"
  ],
  "research_status": [
    "RESEARCH_EDGE",
    "LEAN",
    "PASS",
    "BLOCKED"
  ],
  "availability_status": [
    "KALSHI_AVAILABLE",
    "NOT_OFFERED_NOW",
    null
  ],
  "tradeability_status": [
    "PASS",
    "FAIL",
    "NOT_APPLICABLE"
  ],
  "final_status": [
    "CLEAR_PICK",
    "LEAN",
    "PASS",
    "WATCH_FOR_LISTING",
    "NOT_TRADEABLE",
    "BLOCKED"
  ],
  "source_status": [
    "ok",
    "degraded",
    "blocked",
    "skipped"
  ],
  "side": [
    "YES",
    "NO",
    "OVER",
    "UNDER",
    "TEAM",
    "PLAYER",
    null
  ],
  "side_hint": [
    "YES",
    "NO",
    "OVER",
    "UNDER",
    "TEAM",
    "PLAYER",
    null
  ],
  "market_lane_nullable": [
    "moneyline",
    "run_line",
    "game_total",
    "yrfi_nrfi",
    "home_run_hitter",
    "pitcher_strikeouts",
    null
  ]
}
```

Null is valid only in these cases:

- `availability_status: null` when Kalshi availability has not been assessed yet or is intentionally not applicable to a blocked/non-routed item.
- `side: null` when no side can be assigned because the candidate is blocked, unavailable, or not yet tradeable.
- `side_hint: null` in router output when the title/rules do not imply a side.
- `market_lane: null` only for router results with `route_status` of `AMBIGUOUS`, `BLOCKED`, or `OUT_OF_SCOPE`; routed picks must use one non-null lane.

## `slate_manifest.json` Schema

Purpose: inventory the daily MLB slate, Kalshi-listed markets, MLB game mappings, router results, missing props, and source timestamps.

Required top-level fields:

- `run_date`
- `generated_at_utc`
- `kalshi_calendar_url`
- `source_timestamps`
- `games`
- `router_results`
- `unmatched_or_excluded_markets`

Optional top-level fields:

- `notes`
- `operator`
- `schema_version`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "mlb-slate-manifest.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "run_date",
    "generated_at_utc",
    "kalshi_calendar_url",
    "source_timestamps",
    "games",
    "router_results",
    "unmatched_or_excluded_markets"
  ],
  "properties": {
    "schema_version": {
      "type": "string"
    },
    "run_date": {
      "type": "string",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
    },
    "generated_at_utc": {
      "type": "string",
      "format": "date-time"
    },
    "operator": {
      "type": "string"
    },
    "kalshi_calendar_url": {
      "type": "string",
      "const": "https://kalshi.com/calendar/sports/baseball"
    },
    "source_timestamps": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "kalshi",
        "mlb_official",
        "baseball_savant",
        "weather"
      ],
      "properties": {
        "kalshi": {
          "type": ["string", "null"],
          "format": "date-time"
        },
        "mlb_official": {
          "type": ["string", "null"],
          "format": "date-time"
        },
        "baseball_savant": {
          "type": ["string", "null"],
          "format": "date-time"
        },
        "weather": {
          "type": ["string", "null"],
          "format": "date-time"
        },
        "optional_price_sanity": {
          "type": ["string", "null"],
          "format": "date-time"
        }
      }
    },
    "games": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/game"
      }
    },
    "router_results": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/router_result"
      }
    },
    "unmatched_or_excluded_markets": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/excluded_market"
      }
    },
    "notes": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "$defs": {
    "market_lane": {
      "enum": [
        "moneyline",
        "run_line",
        "game_total",
        "yrfi_nrfi",
        "home_run_hitter",
        "pitcher_strikeouts"
      ]
    },
    "route_status": {
      "enum": [
        "ROUTED",
        "AMBIGUOUS",
        "BLOCKED",
        "OUT_OF_SCOPE"
      ]
    },
    "game": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "game_pk",
        "game",
        "game_date",
        "start_time_utc",
        "teams",
        "mlb_status",
        "probable_pitchers",
        "kalshi_events",
        "listed_market_lanes",
        "weather_status"
      ],
      "properties": {
        "game_pk": {
          "type": ["integer", "null"]
        },
        "game": {
          "type": "string"
        },
        "game_date": {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
        },
        "start_time_utc": {
          "type": ["string", "null"],
          "format": "date-time"
        },
        "teams": {
          "type": "object",
          "additionalProperties": false,
          "required": ["away", "home"],
          "properties": {
            "away": {
              "type": "string"
            },
            "home": {
              "type": "string"
            }
          }
        },
        "mlb_status": {
          "type": "string"
        },
        "probable_pitchers": {
          "type": "object",
          "additionalProperties": false,
          "required": ["away", "home"],
          "properties": {
            "away": {
              "type": ["string", "null"]
            },
            "home": {
              "type": ["string", "null"]
            }
          }
        },
        "kalshi_events": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "event_ticker",
              "event_title",
              "market_tickers"
            ],
            "properties": {
              "event_ticker": {
                "type": ["string", "null"]
              },
              "event_title": {
                "type": "string"
              },
              "market_tickers": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            }
          }
        },
        "listed_market_lanes": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/market_lane"
          },
          "uniqueItems": true
        },
        "weather_status": {
          "enum": ["ok", "degraded", "blocked", "skipped"]
        }
      }
    },
    "router_result": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "route_status",
        "market_lane",
        "candidate_lanes",
        "market_title",
        "confidence",
        "matched_signals",
        "reject_signals",
        "needed_clarification",
        "next_workflow"
      ],
      "properties": {
        "route_status": {
          "$ref": "#/$defs/route_status"
        },
        "market_lane": {
          "anyOf": [
            {
              "$ref": "#/$defs/market_lane"
            },
            {
              "type": "null"
            }
          ]
        },
        "candidate_lanes": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/market_lane"
          }
        },
        "kalshi_url": {
          "type": ["string", "null"]
        },
        "event_ticker": {
          "type": ["string", "null"]
        },
        "market_ticker": {
          "type": ["string", "null"]
        },
        "event_title": {
          "type": ["string", "null"]
        },
        "market_title": {
          "type": ["string", "null"]
        },
        "contract_title": {
          "type": ["string", "null"]
        },
        "game_date": {
          "type": ["string", "null"]
        },
        "teams": {
          "type": "object",
          "additionalProperties": false,
          "required": ["away", "home"],
          "properties": {
            "away": {
              "type": ["string", "null"]
            },
            "home": {
              "type": ["string", "null"]
            }
          }
        },
        "player_name": {
          "type": ["string", "null"]
        },
        "threshold": {
          "type": ["number", "string", "null"]
        },
        "side_hint": {
          "enum": ["YES", "NO", "OVER", "UNDER", "TEAM", "PLAYER", null]
        },
        "confidence": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "matched_signals": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "reject_signals": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "needed_clarification": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "next_workflow": {
          "type": "string",
          "const": "runbooks/mlb-prediction-process.md"
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "excluded_market": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "market_title",
        "reason",
        "route_status"
      ],
      "properties": {
        "market_title": {
          "type": "string"
        },
        "market_ticker": {
          "type": ["string", "null"]
        },
        "route_status": {
          "$ref": "#/$defs/route_status"
        },
        "reason": {
          "type": "string"
        },
        "needed_clarification": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    }
  }
}
```

Example:

```json
{
  "schema_version": "1.0",
  "run_date": "2026-06-01",
  "generated_at_utc": "2026-06-01T14:00:00Z",
  "operator": "sports-pre-game",
  "kalshi_calendar_url": "https://kalshi.com/calendar/sports/baseball",
  "source_timestamps": {
    "kalshi": "2026-06-01T14:00:00Z",
    "mlb_official": "2026-06-01T14:01:00Z",
    "baseball_savant": "2026-06-01T14:03:00Z",
    "weather": "2026-06-01T14:05:00Z",
    "optional_price_sanity": null
  },
  "games": [
    {
      "game_pk": 100001,
      "game": "Alpha City Aces at Beta Town Bears",
      "game_date": "2026-06-01",
      "start_time_utc": "2026-06-01T23:05:00Z",
      "teams": {
        "away": "Alpha City Aces",
        "home": "Beta Town Bears"
      },
      "mlb_status": "Preview",
      "probable_pitchers": {
        "away": "Placeholder Pitcher A",
        "home": "Placeholder Pitcher B"
      },
      "kalshi_events": [
        {
          "event_ticker": "KXMLB-PLACEHOLDER-001",
          "event_title": "Alpha City Aces at Beta Town Bears",
          "market_tickers": ["KXMLB-PLACEHOLDER-001-WINNER"]
        }
      ],
      "listed_market_lanes": ["moneyline"],
      "weather_status": "ok"
    }
  ],
  "router_results": [
    {
      "route_status": "ROUTED",
      "market_lane": "moneyline",
      "candidate_lanes": ["moneyline"],
      "kalshi_url": null,
      "event_ticker": "KXMLB-PLACEHOLDER-001",
      "market_ticker": "KXMLB-PLACEHOLDER-001-WINNER",
      "event_title": "Alpha City Aces at Beta Town Bears",
      "market_title": "Will the Alpha City Aces beat the Beta Town Bears?",
      "contract_title": null,
      "game_date": "2026-06-01",
      "teams": {
        "away": "Alpha City Aces",
        "home": "Beta Town Bears"
      },
      "player_name": null,
      "threshold": null,
      "side_hint": "TEAM",
      "confidence": 92,
      "matched_signals": ["team-vs-team game outcome", "no spread", "no total"],
      "reject_signals": [],
      "needed_clarification": [],
      "next_workflow": "runbooks/mlb-prediction-process.md",
      "notes": []
    }
  ],
  "unmatched_or_excluded_markets": [],
  "notes": ["Placeholder example only; no live picks."]
}
```

## `source_registry.json` Schema

Purpose: record source health, access method, backups, repeatability, limitations, and source gaps.

Required top-level fields:

- `run_date`
- `generated_at_utc`
- `sources`
- `source_gaps`

Optional top-level fields:

- `schema_version`
- `operator`
- `notes`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "mlb-source-registry.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "run_date",
    "generated_at_utc",
    "sources",
    "source_gaps"
  ],
  "properties": {
    "schema_version": {
      "type": "string"
    },
    "run_date": {
      "type": "string",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
    },
    "generated_at_utc": {
      "type": "string",
      "format": "date-time"
    },
    "operator": {
      "type": "string"
    },
    "sources": {
      "type": "array",
      "minItems": 4,
      "items": {
        "$ref": "#/$defs/source"
      }
    },
    "source_gaps": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/source_gap"
      }
    },
    "notes": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "$defs": {
    "source_status": {
      "enum": ["ok", "degraded", "blocked", "skipped"]
    },
    "reliability_grade": {
      "enum": ["A", "A-", "B", "B-", "C", "unknown"]
    },
    "source": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "source_id",
        "data_need",
        "recommended_source",
        "backup_source",
        "access_method",
        "reliability_grade",
        "daily_repeatability",
        "limitations",
        "status",
        "last_checked_utc",
        "required"
      ],
      "properties": {
        "source_id": {
          "enum": [
            "kalshi",
            "mlb_official",
            "baseball_savant",
            "weather",
            "optional_price_sanity"
          ]
        },
        "data_need": {
          "type": "string"
        },
        "recommended_source": {
          "type": "string"
        },
        "backup_source": {
          "type": ["string", "null"]
        },
        "access_method": {
          "type": "string"
        },
        "reliability_grade": {
          "$ref": "#/$defs/reliability_grade"
        },
        "daily_repeatability": {
          "type": "string"
        },
        "limitations": {
          "type": "string"
        },
        "status": {
          "$ref": "#/$defs/source_status"
        },
        "last_checked_utc": {
          "type": ["string", "null"],
          "format": "date-time"
        },
        "required": {
          "type": "boolean"
        },
        "urls": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "source_gap": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "source_id",
        "gap",
        "affected_market_lanes",
        "handling"
      ],
      "properties": {
        "source_id": {
          "type": "string"
        },
        "gap": {
          "type": "string"
        },
        "affected_market_lanes": {
          "type": "array",
          "items": {
            "enum": [
              "moneyline",
              "run_line",
              "game_total",
              "yrfi_nrfi",
              "home_run_hitter",
              "pitcher_strikeouts"
            ]
          }
        },
        "handling": {
          "type": "string"
        }
      }
    }
  }
}
```

Example:

```json
{
  "schema_version": "1.0",
  "run_date": "2026-06-01",
  "generated_at_utc": "2026-06-01T14:10:00Z",
  "operator": "alphaagent",
  "sources": [
    {
      "source_id": "kalshi",
      "data_need": "Tradable markets, rules, prices, bid/ask, liquidity, and order books",
      "recommended_source": "Kalshi baseball calendar and Kalshi Trade API",
      "backup_source": "Manual Kalshi UI snapshot if API discovery fails",
      "access_method": "Calendar URL and Trade API market/orderbook endpoints",
      "reliability_grade": "A",
      "daily_repeatability": "Daily, subject to UI access and API availability",
      "limitations": "Kalshi proves tradability only, not baseball truth",
      "status": "ok",
      "last_checked_utc": "2026-06-01T14:00:00Z",
      "required": true,
      "urls": ["https://kalshi.com/calendar/sports/baseball"]
    },
    {
      "source_id": "optional_price_sanity",
      "data_need": "Optional external price sanity check",
      "recommended_source": "None required",
      "backup_source": null,
      "access_method": "Manual URL only when reliable and public",
      "reliability_grade": "unknown",
      "daily_repeatability": "Optional",
      "limitations": "Never proves Kalshi availability and never blocks workflow",
      "status": "skipped",
      "last_checked_utc": null,
      "required": false,
      "urls": []
    }
  ],
  "source_gaps": [],
  "notes": ["Placeholder example only."]
}
```

## `picks.json` Schema

Purpose: machine-readable pick sheet with research status, Kalshi availability, tradeability, final status, pricing, sizing caps, evidence, and failure handling.

Required top-level fields:

- `run_date`
- `generated_at_utc`
- `source_health`
- `picks`

Optional top-level fields:

- `schema_version`
- `operator`
- `summary_counts`
- `notes`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "mlb-picks.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "run_date",
    "generated_at_utc",
    "source_health",
    "picks"
  ],
  "properties": {
    "schema_version": {
      "type": "string"
    },
    "run_date": {
      "type": "string",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
    },
    "generated_at_utc": {
      "type": "string",
      "format": "date-time"
    },
    "operator": {
      "type": "string"
    },
    "source_health": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "kalshi",
        "mlb_official",
        "baseball_savant",
        "weather",
        "optional_price_sanity"
      ],
      "properties": {
        "kalshi": {
          "enum": ["ok", "degraded", "blocked"]
        },
        "mlb_official": {
          "enum": ["ok", "degraded", "blocked"]
        },
        "baseball_savant": {
          "enum": ["ok", "degraded", "blocked"]
        },
        "weather": {
          "enum": ["ok", "degraded", "blocked"]
        },
        "optional_price_sanity": {
          "enum": ["ok", "skipped", "degraded", "blocked"]
        }
      }
    },
    "summary_counts": {
      "type": "object",
      "additionalProperties": {
        "type": "integer",
        "minimum": 0
      }
    },
    "picks": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/pick"
      }
    },
    "notes": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "$defs": {
    "market_lane": {
      "enum": [
        "moneyline",
        "run_line",
        "game_total",
        "yrfi_nrfi",
        "home_run_hitter",
        "pitcher_strikeouts"
      ]
    },
    "pick": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id",
        "game_pk",
        "game",
        "start_time_utc",
        "market_lane",
        "research_status",
        "availability_status",
        "tradeability_status",
        "final_status",
        "side",
        "fair_probability",
        "market_probability",
        "edge_probability_points",
        "confidence",
        "primary_evidence",
        "risk_notes",
        "source_urls"
      ],
      "properties": {
        "id": {
          "type": "string"
        },
        "game_pk": {
          "type": ["integer", "null"]
        },
        "game": {
          "type": "string"
        },
        "start_time_utc": {
          "type": ["string", "null"],
          "format": "date-time"
        },
        "market_lane": {
          "$ref": "#/$defs/market_lane"
        },
        "kalshi_event_ticker": {
          "type": ["string", "null"]
        },
        "kalshi_market_ticker": {
          "type": ["string", "null"]
        },
        "kalshi_contract_name": {
          "type": ["string", "null"]
        },
        "research_status": {
          "enum": ["RESEARCH_EDGE", "LEAN", "PASS", "BLOCKED"]
        },
        "availability_status": {
          "enum": ["KALSHI_AVAILABLE", "NOT_OFFERED_NOW", null]
        },
        "tradeability_status": {
          "enum": ["PASS", "FAIL", "NOT_APPLICABLE"]
        },
        "final_status": {
          "enum": [
            "CLEAR_PICK",
            "LEAN",
            "PASS",
            "WATCH_FOR_LISTING",
            "NOT_TRADEABLE",
            "BLOCKED"
          ]
        },
        "side": {
          "enum": ["YES", "NO", "OVER", "UNDER", "TEAM", "PLAYER", null]
        },
        "threshold": {
          "type": ["number", "string", "null"]
        },
        "fair_probability": {
          "type": ["number", "null"],
          "minimum": 0,
          "maximum": 1
        },
        "market_probability": {
          "type": ["number", "null"],
          "minimum": 0,
          "maximum": 1
        },
        "edge_probability_points": {
          "type": ["number", "null"]
        },
        "yes_bid": {
          "type": ["number", "null"],
          "minimum": 0,
          "maximum": 1
        },
        "yes_ask": {
          "type": ["number", "null"],
          "minimum": 0,
          "maximum": 1
        },
        "spread": {
          "type": ["number", "null"],
          "minimum": 0,
          "maximum": 1
        },
        "last_trade_ts": {
          "type": ["string", "null"],
          "format": "date-time"
        },
        "visible_depth_at_entry": {
          "type": ["number", "null"],
          "minimum": 0
        },
        "confidence": {
          "type": ["integer", "null"],
          "minimum": 0,
          "maximum": 100
        },
        "quarter_kelly_fraction": {
          "type": ["number", "null"],
          "minimum": 0
        },
        "max_entry_price": {
          "type": ["number", "null"],
          "minimum": 0,
          "maximum": 1
        },
        "max_size_bankroll_pct": {
          "type": ["number", "null"],
          "minimum": 0
        },
        "primary_evidence": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "risk_notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "next_recheck_utc": {
          "type": ["string", "null"],
          "format": "date-time"
        },
        "source_urls": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "router_result_id": {
          "type": ["string", "null"]
        }
      }
    }
  }
}
```

Example:

```json
{
  "schema_version": "1.0",
  "run_date": "2026-06-01",
  "generated_at_utc": "2026-06-01T16:30:00Z",
  "operator": "sports-pre-game",
  "source_health": {
    "kalshi": "ok",
    "mlb_official": "ok",
    "baseball_savant": "ok",
    "weather": "ok",
    "optional_price_sanity": "skipped"
  },
  "summary_counts": {
    "CLEAR_PICK": 0,
    "WATCH_FOR_LISTING": 1,
    "NOT_TRADEABLE": 1,
    "LEAN": 0,
    "PASS": 0,
    "BLOCKED": 0
  },
  "picks": [
    {
      "id": "20260601_100001_home_run_hitter_placeholder_player",
      "game_pk": 100001,
      "game": "Alpha City Aces at Beta Town Bears",
      "start_time_utc": "2026-06-01T23:05:00Z",
      "market_lane": "home_run_hitter",
      "kalshi_event_ticker": "KXMLB-PLACEHOLDER-001",
      "kalshi_market_ticker": null,
      "kalshi_contract_name": null,
      "research_status": "RESEARCH_EDGE",
      "availability_status": "NOT_OFFERED_NOW",
      "tradeability_status": "NOT_APPLICABLE",
      "final_status": "WATCH_FOR_LISTING",
      "side": "PLAYER",
      "threshold": "hits a home run",
      "fair_probability": 0.12,
      "market_probability": null,
      "edge_probability_points": null,
      "yes_bid": null,
      "yes_ask": null,
      "spread": null,
      "last_trade_ts": null,
      "visible_depth_at_entry": null,
      "confidence": 72,
      "quarter_kelly_fraction": null,
      "max_entry_price": null,
      "max_size_bankroll_pct": null,
      "primary_evidence": ["Placeholder hitter power profile supports research edge"],
      "risk_notes": ["Exact Kalshi player prop not listed yet"],
      "next_recheck_utc": "2026-06-01T22:05:00Z",
      "source_urls": [],
      "router_result_id": "router-placeholder-hr-001"
    }
  ],
  "notes": ["Placeholder example only; no live picks."]
}
```

## `run_log.md` Structure Schema

Purpose: chronological proof log for source checks, routing decisions, rechecks, blocked items, and output writes.

Required sections:

1. `# MLB Run Log - YYYY-MM-DD`
2. `## Run Metadata`
3. `## Source Checks`
4. `## Kalshi Intake`
5. `## Router Results`
6. `## Prediction Status Changes`
7. `## Failure Handling`
8. `## Output Writes`
9. `## No-Trade Confirmation`

Optional sections:

- `## Recheck Schedule`
- `## Manual Notes`
- `## Structure Test`

Required metadata fields:

- `Operator`
- `Started UTC`
- `Run date`
- `Run folder`
- `Schema version`

Example:

```markdown
# MLB Run Log - 2026-06-01

## Run Metadata
- Operator: sports-pre-game
- Started UTC: 2026-06-01T14:00:00Z
- Run date: 2026-06-01
- Run folder: state/mlb/2026-06-01/
- Schema version: 1.0

## Source Checks
| Source | Status | Checked UTC | Access method | Limitation |
|---|---|---|---|---|
| Kalshi | ok | 2026-06-01T14:00:00Z | Calendar/API | Tradability only |

## Kalshi Intake
| Event | Market | Ticker | Status | Notes |
|---|---|---|---|---|
| Alpha City Aces at Beta Town Bears | Game winner | KXMLB-PLACEHOLDER-001-WINNER | listed | Placeholder |

## Router Results
| Market | Route status | Lane | Candidates | Needed clarification |
|---|---|---|---|---|
| Will Aces beat Bears? | ROUTED | moneyline | moneyline |  |

## Prediction Status Changes
| Time UTC | ID | Old status | New status | Reason |
|---|---|---|---|---|
| 2026-06-01T16:30:00Z | 20260601_100001_home_run_hitter_placeholder_player |  | WATCH_FOR_LISTING | Research edge; Kalshi prop not listed |

## Failure Handling
| Case | Item | Handling | Next action |
|---|---|---|---|
| missing_kalshi_prop | Placeholder Player HR | WATCH_FOR_LISTING | Recheck at 2026-06-01T22:05:00Z |

## Output Writes
| File | Wrote UTC | Status |
|---|---|---|
| picks.json | 2026-06-01T16:30:00Z | ok |

## No-Trade Confirmation
- No live picks placed.
- No trades placed.
```

## `daily-baseball-guide.md` Structure Schema

Purpose: human-readable daily guide for review, not publication by default.

Required sections:

1. `# Daily Baseball Guide - YYYY-MM-DD`
2. `## Source Health`
3. `## Slate Overview`
4. `## Clear Picks`
5. `## Watch For Listing`
6. `## Not Tradeable`
7. `## Leans`
8. `## Passes`
9. `## Blocked`
10. `## Run Notes`

Required table columns:

- Slate Overview: `Game`, `Start`, `Kalshi markets listed`, `MLB status`, `Weather note`, `Source status`
- Clear Picks: `Market`, `Side`, `Fair`, `Kalshi price`, `Edge`, `Confidence`, `Max entry`, `Cap`, `Why`
- Watch For Listing: `Player/market`, `Game`, `Research edge`, `Missing Kalshi prop`, `Recheck time`, `Trigger`
- Not Tradeable: `Market`, `Reason`, `Spread`, `Depth`, `Last update`, `Recheck`
- Leans: `Market`, `Why interesting`, `Missing evidence`, `Needed trigger`
- Passes: `Market`, `Primary reason`
- Blocked: `Market`, `Missing source`, `Next action`

Example:

```markdown
# Daily Baseball Guide - 2026-06-01

## Source Health
- Kalshi: ok
- MLB official: ok
- Baseball Savant: ok
- Weather: ok
- Optional price sanity: skipped

## Slate Overview
| Game | Start | Kalshi markets listed | MLB status | Weather note | Source status |
|---|---|---|---|---|---|
| Alpha City Aces at Beta Town Bears | 2026-06-01T23:05:00Z | moneyline | Preview | Outdoor, checked | ok |

## Clear Picks
| Market | Side | Fair | Kalshi price | Edge | Confidence | Max entry | Cap | Why |
|---|---|---:|---:|---:|---:|---:|---:|---|

## Watch For Listing
| Player/market | Game | Research edge | Missing Kalshi prop | Recheck time | Trigger |
|---|---|---|---|---|---|
| Placeholder Player HR | Alpha City Aces at Beta Town Bears | RESEARCH_EDGE | Exact player HR prop not listed | 2026-06-01T22:05:00Z | Recheck after lineup confirmation |

## Not Tradeable
| Market | Reason | Spread | Depth | Last update | Recheck |
|---|---|---:|---:|---|---|

## Leans
| Market | Why interesting | Missing evidence | Needed trigger |
|---|---|---|---|

## Passes
| Market | Primary reason |
|---|---|

## Blocked
| Market | Missing source | Next action |
|---|---|---|

## Run Notes
- No live picks placed.
- No trades placed.
- Source limitations: none in placeholder example.
```

## Validation Rules

Apply these rules after JSON Schema validation.

1. File location
   - All five files must be under `state/mlb/YYYY-MM-DD/`.
   - `run_date` must match the folder date.
2. Router result consistency
   - `route_status: "ROUTED"` requires exactly one non-null `market_lane`.
   - `AMBIGUOUS`, `BLOCKED`, and `OUT_OF_SCOPE` router results must use `market_lane: null`.
   - Ambiguous router results do not enter `picks.json`; write them to `slate_manifest.json` and `run_log.md`.
3. Pick status consistency
   - `CLEAR_PICK` requires `research_status: "RESEARCH_EDGE"`, `availability_status: "KALSHI_AVAILABLE"`, and `tradeability_status: "PASS"`.
   - `WATCH_FOR_LISTING` requires `research_status: "RESEARCH_EDGE"`, `availability_status: "NOT_OFFERED_NOW"`, `tradeability_status: "NOT_APPLICABLE"`, and non-null `next_recheck_utc`.
   - `NOT_TRADEABLE` requires `availability_status: "KALSHI_AVAILABLE"` and `tradeability_status: "FAIL"`.
   - `BLOCKED` requires at least one `risk_notes` entry naming the missing or contradictory data.
4. Price fields
   - `yes_bid`, `yes_ask`, `spread`, `market_probability`, and `last_trade_ts` may be null only when the exact Kalshi market is not available or source access is blocked.
   - If `yes_bid` and `yes_ask` are both present, `spread` must equal `yes_ask - yes_bid` within rounding tolerance.
5. Probability fields
   - Probability values must be decimals from 0 to 1.
   - Percent display belongs in markdown guide files, not JSON.
6. Source health
   - Required source outage must appear in `source_registry.json.source_gaps`.
   - Any pick affected by a required blocked source must be `BLOCKED`, `PASS`, or `LEAN`; it cannot be `CLEAR_PICK`.
7. No-pick safety
   - The schemas do not authorize order placement.
   - No file may claim a live trade was placed by this workflow.

## Failure Handling Rules

### Missing Kalshi Props

When baseball research finds edge but the exact Kalshi prop is not listed:

- In `picks.json`:
  - `research_status`: `RESEARCH_EDGE`
  - `availability_status`: `NOT_OFFERED_NOW`
  - `tradeability_status`: `NOT_APPLICABLE`
  - `final_status`: `WATCH_FOR_LISTING`
  - `next_recheck_utc`: required
- In `daily-baseball-guide.md`, list under `Watch For Listing`.
- In `run_log.md`, log the missing prop and recheck time.
- Do not mark as `PASS` solely because Kalshi does not list the prop yet.

### Weak Liquidity

When the exact Kalshi market exists but spread, depth, freshness, or order book quality fails:

- In `picks.json`:
  - `availability_status`: `KALSHI_AVAILABLE`
  - `tradeability_status`: `FAIL`
  - `final_status`: `NOT_TRADEABLE`
  - include `yes_bid`, `yes_ask`, `spread`, `visible_depth_at_entry`, and `last_trade_ts` when available
- In `daily-baseball-guide.md`, list under `Not Tradeable`.
- In `run_log.md`, state the failed liquidity gate.
- Do not mark as `CLEAR_PICK`.

### Source Outages

When a required source is unavailable:

- In `source_registry.json`, set that source `status` to `degraded` or `blocked`.
- Add a `source_gaps` entry with affected lanes and handling.
- In `picks.json`, affected candidates must be `BLOCKED` unless the missing source is non-material to that lane.
- In `daily-baseball-guide.md`, list affected markets under `Blocked`.
- In `run_log.md`, record the source outage, timestamp, and retry path.

### Ambiguous Router Results

When the router cannot resolve exactly one lane:

- In `slate_manifest.json`, include the router result with `route_status: "AMBIGUOUS"`, `market_lane: null`, `candidate_lanes`, and `needed_clarification`.
- In `run_log.md`, list the ambiguous market under `Router Results`.
- Do not add the item to `picks.json`.
- Do not guess a lane.

## Schema Headings Checklist

- `slate_manifest.json` Schema
- `source_registry.json` Schema
- `picks.json` Schema
- `run_log.md` Structure Schema
- `daily-baseball-guide.md` Structure Schema
