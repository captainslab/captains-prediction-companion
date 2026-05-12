# BUILDSTATUS.md — Implementation Build Order

Current state and build sequence for all pipelines.

## Build Order

| # | Component | Status | Notes |
|---|-----------|--------|-------|
| 1 | Shared advanced modules (CLV, consensus, injury gate, Monte Carlo, calibration, no-bet) | 🔲 Planned | Foundation; build before any pipeline |
| 2 | `footballGameApp` | 🔲 Planned | `footballEfficiencySkill` |
| 3 | `basketballGameApp` | 🔲 Planned | `basketballTempoRotationSkill` |
| 4 | `baseballGameApp` | 🔲 Planned | `baseballPitcherWeatherSkill` (parent) |
| 5 | `mlbStrikeoutPropApp` | 🔲 Planned | `mlbStrikeoutPropSkill` |
| 6 | `mlbHomeRunPropApp` | 🔲 Planned | `mlbHomeRunPropSkill` |
| 7 | `nascarRaceApp` + `nascarSeriesFuturesApp` | 🔲 Planned | Active Kalshi futures; priority |
| 8 | `ufcFightApp` | 🔲 Planned | `ufcStyleMatchupSkill` |
| 9 | `mentionsApp` (all 6 lanes) | ✅ Operational | Earnings mentions live (Hims Q1 proof) |
| 10 | `politicsApp` (all 5 components) | 🔲 Planned | After sports pipeline |

## Status Key

- ✅ Operational — live and proven
- 🔧 In Progress — actively being built
- 🔲 Planned — designed, not started

## External Repository Harvest Targets

Repos to integrate patterns, data, or components from:

| Repo | What to take |
|------|-------------|
| `pmxt-dev/pmxt` | Unified API across Kalshi, Polymarket, Limitless, Myriad |
| `Jon-Becker/prediction-market-analysis` | 36GB Polymarket/Kalshi dataset; backtesting |
| `TauricResearch/TradingAgents` | Planner/executor/reviewer role separation patterns |
| `virattt/ai-hedge-fund` | Bull/bear/risk pre-trade argumentation patterns |
| `NoFxAiOS/nofx` | Safe-mode guardrails, circuit-breakers, autonomous monitoring |
| `koala73/worldmonitor` | Geopolitical/news aggregation, event clustering, narrative heat |
| `onyx-dot-app/onyx` | Self-hosted retrieval, research, RAG, knowledge indexing |

## Operational Rules

- Audit before building — check what exists before adding new code
- Preserve working code; extend incrementally
- Favor integration and normalization over reinvention
- Keep diffs tight and scoped
- Stop at logical checkpoints
