# CPC Regular-Game Anytime-HR Model: 2025 Held-Out Report

Generated: 2026-07-13T00:00:00.000Z

## Data and split

- Source: Baseball Savant Statcast terminal PA rows.
- Row grain: one non-empty events row per terminal plate appearance.
- Ingested terminal PA: 183245; HR: 5650; range: 2025-03-18 through 2025-09-28.
- Statcast terminal-row HR/PA: 0.030833. Supplied official cross-check: 5650/182926 = 0.030887; the terminal-row denominator is 319 higher and is retained rather than silently discarded.
- Train: 2025-03-18 through 2025-08-03 (126676 rows).
- Validation: 2025-08-04 through 2025-08-31 (28521 rows).
- Test: 2025-09-01 through 2025-09-28 (28048 rows).
- Splits are chronological. The test block is the latest block and was evaluated once after all choices were fixed.
- Rolling batter, pitcher, park, and league features are frozen at the start of each slate date; same-date outcomes never enter a pregame feature row.

## Fitting

- Empirical-Bayes prior strength: 256, selected by validation log loss from [8, 16, 32, 64, 128, 256].
- L2 regularization: 0.05, selected by validation log loss from [0, 0.0005, 0.005, 0.05].
- Logistic coefficients and standardization parameters were fitted from training rows. No coefficient is hardcoded or LLM-authored.
- Opportunity is a separate fitted lineup-slot PA model; it does not enter the per-PA contact-quality target.

## Held-out metrics

| Predictor | Brier score | Log loss | Mean prediction | Test HR/PA |
|---|---:|---:|---:|---:|
| Fitted HR/PA model | 0.03069235 | 0.13983796 | 0.03279581 | 0.03176697 |
| Constant official league-rate baseline (0.030890) | 0.03075860 | 0.14084441 | 0.03089000 | 0.03176697 |

Beats the constant baseline on both metrics: **YES**.

Calibration claim: **SUPPORTED under the predeclared rule**. Rule: beats baseline on Brier and log loss; absolute mean gap <= 0.005; ECE <= 0.01.

Held-out evidence supports describing this fitted model as calibrated under the stated rule.

## Held-out calibration table

| Decile | Prediction range | Predicted mean | Observed HR rate | n |
|---:|---:|---:|---:|---:|
| 1 | 0.015958–0.026705 | 0.024695 | 0.017832 | 2804 |
| 2 | 0.026706–0.028498 | 0.027679 | 0.022460 | 2805 |
| 3 | 0.028498–0.029824 | 0.029178 | 0.027094 | 2805 |
| 4 | 0.029824–0.031083 | 0.030464 | 0.031373 | 2805 |
| 5 | 0.031083–0.032238 | 0.031658 | 0.033155 | 2805 |
| 6 | 0.032238–0.033504 | 0.032850 | 0.027817 | 2804 |
| 7 | 0.033504–0.034959 | 0.034208 | 0.031373 | 2805 |
| 8 | 0.034959–0.036808 | 0.035836 | 0.035294 | 2805 |
| 9 | 0.036808–0.039652 | 0.038109 | 0.040285 | 2805 |
| 10 | 0.039652–0.061354 | 0.043280 | 0.050980 | 2805 |

Expected calibration error: 0.00348564.

## Game-level conversion

For fitted per-PA probability `p` and lineup-slot PA count `N`, the packet reports `1 - (1 - p)^N` for at least one HR and `N × p` expected HR. This assumes PA outcomes are conditionally independent. The shared seeded Monte Carlo engine supplies the 0 / 1 / 2+ distribution.

## Missing inputs and identity

Roof, altitude, weather, and directional-fit gaps have explicit missingness indicators. Production matching is MLB-ID-first; unique normalized name matching is fallback-only, and ambiguous names block as `MODEL_INSUFFICIENT`.
