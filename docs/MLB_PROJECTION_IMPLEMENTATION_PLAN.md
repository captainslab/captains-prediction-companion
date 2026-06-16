# MLB Projection Implementation Plan

This document is the execution plan for MLB projections in CPC. It is intentionally narrow: it defines the modeling roadmap, data-risk posture, and validation gates without changing runtime code, delivery behavior, or market handling.

## Non-Negotiable Constraints

- Price isolation stays intact: market prices are allowed only for offline EV, CLV, and closing-line audit work.
- Market price, open interest, spread shape, and line movement are never allowed to become scoring features, ranking features, posture inputs, or upgrade signals.
- No-trade and no-send remain the default policy for this workstream.
- The plan does not authorize changes to Hermes, UFC, cron, Telegram, credentials, providers, Kalshi auth, generated artifacts, or sent ledgers.

## Modeling Principles

- One baseball engine should power MLB moneyline, spread, and total outputs.
- YRFI, K, and HR should reuse shared pitcher, lineup, park, weather, and bullpen features instead of rebuilding separate foundation models.
- One thin vertical slice should ship before the rest of the foundation is expanded.
- A failing source-health or lineup gate blocks progression rather than being patched over with price signals.

## Market Efficiency And Edge Bar

The closing line is the benchmark, not an afterthought.

- Measure closing-line value, calibration against the close, and error metrics such as Brier score and log loss versus the closing benchmark.
- The minimum actionable edge should be set explicitly and treated as a gate, not a slogan.
- Starting edge zones:
  - Props and YRFI on thinner markets are the primary target surface.
  - ML, spread, and total are mostly validation or small-edge surfaces unless CPC proves durable close-beating performance there.
- Practical interpretation:
  - `0.0 to 0.5 pp` edge: noise or watch-only.
  - `0.5 to 1.5 pp` edge: validation zone, useful for model checking and narrow interest.
  - `>= 1.5 pp` edge: candidate zone for thin markets, assuming source-health and lineup certainty are strong.
  - For ML, spread, and total, keep the bar higher in practice until closing-line audits show repeatable advantage.

If a market family does not beat the close over time, it does not graduate into a production recommendation path.

## Engine Spine Decision

The production spine is an inning-level base/out simulator.

- The simulator should generate coherent moneyline, spread, total, and YRFI outputs from the same game state transitions.
- This is the production foundation, not a sidecar or a validation-only toy.
- Bivariate negative binomial or CMP-style models belong in the backtest stack as marginal sanity checks and comparator baselines.
- Use those count models to sanity-check aggregate run distributions, not to replace the inning-level simulator.

## Talent Layer V1

Talent layer v1 should start from public projection inputs.

- Ingest public projection sources and public stat feeds first.
- Use those inputs to assemble a usable talent layer for starter, bullpen, lineup, park, and platoon context.
- Do not rebuild PECOTA/ZiPS-style internal talent modeling first.
- A custom hierarchical Bayes talent stack is later research, after reliability and calibration are proven with public inputs.

## Operational Data Risk

The plan must treat data reliability as first-class risk, not implementation noise.

- Confirmed lineups and starters are mandatory for the thin vertical slice.
- Late scratches, lineup drift, and starter changes must be modeled as live risk, not assumed away.
- Statcast and MLB blocking must be anticipated as source risk.
- VPS IP limits, provider throttling, proxy fallback, and cache fallback must be part of the design.
- Every run should emit source-health artifacts that capture provider, freshness, latency, coverage, fallback path, and block reason.
- Fail-closed gates should stop upgrades when lineup certainty, starter certainty, or source-health is insufficient.

## Runtime Constraints

This plan assumes a 16GB VPS class environment.

- Fitting and parameter selection happen offline or nightly.
- Packet generation may only do cheap forward simulation, scoring assembly, and deterministic rendering.
- No MCMC, no heavy inference, and no full re-fit at packet time.
- If runtime cost grows, reduce packet-time work rather than moving more training into the hot path.

## Sequencing

The roadmap replaces broad foundation-first language with a vertical-slice sequence.

### Phase 0: Packet truthfulness and coverage matrix

- Define exactly what the packet can truthfully say for each market family.
- Separate confirmed model outputs from blocked, watch-only, and missing-source states.
- Make coverage visible before trying to optimize accuracy.

### Phase 1: Data reliability audit

- Audit all MLB inputs for confirmed lineups, starters, late scratches, weather, park data, bullpen coverage, and source-health behavior.
- Validate provider fallback, proxy fallback, cache fallback, and failure handling.
- Record where the pipeline must fail closed instead of degrading silently.

### Phase 2: One E2E market slice with market-free model plus closing-line audit

- Build one thin vertical slice end to end.
- Use a market-free model path for that slice.
- Audit the output against the closing line so the model is judged by calibration and CLV, not by internal confidence.

### Phase 3: Simulator spine for ML, spread, and total

- Expand the inning-level simulator into the shared production spine.
- Produce ML, spread, and total from the same simulation state.
- Keep count-model comparators available as backtest-only sanity checks.

### Phase 4: YRFI official model

- Promote YRFI from shared-feature output into an official market model.
- Require lineup confirmation and source-health gating.

### Phase 5: K model

- Add the strikeout model on top of the shared engine and starter context.
- Keep workload, pitch count, and opponent profile as first-class inputs.

### Phase 6: HR model

- Add the home-run model after the shared spine and K model are stable.
- Use batter power, pitcher HR allowance, park, weather, and lineup slot context.

### Phase 7: Calibration, monitoring, and offline EV layer

- Add calibration reporting, monitoring, and offline EV analysis.
- Use close-based auditing to decide whether any market family is genuinely durable.
- Keep the EV layer offline so it never contaminates scoring or posture logic.

## Naming Cleanup

- Rename the ambiguous `home_runs_distribution` term.
- Prefer `team_runs_distribution` when the distribution is team-side or inning-path driven.
- Prefer `total_runs_distribution` when the object is explicitly game-total oriented.
- Use one name consistently per layer so the code and docs do not imply the wrong scope.

## AI Residue Cleanup

Before this plan is considered clean, remove obvious AI residue from the related docs.

- Delete leaked citation markers.
- Remove tracking query strings from any copied URLs.
- Keep the prose human-readable and source-grounded rather than artifact-heavy.

## Readiness Criteria

This plan is ready for implementation only when:

- The data-reliability audit has a documented fail-closed path.
- One thin vertical slice is working end to end.
- Closing-line audits show the model is being measured against the right benchmark.
- Price isolation is still intact.
- No protected repository surface has been modified.
