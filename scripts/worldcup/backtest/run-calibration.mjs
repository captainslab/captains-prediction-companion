#!/usr/bin/env node
// Calibration report orchestrator. Assembles the regulation calibration (tuned
// out-of-sample) and the penalty-layer test into one report. Pure buildReport()
// for tests; a CLI fetches real eloratings years + shootout history and writes
// state/worldcup/backtest/calibration_report.json. Sets NOTHING in the live model.
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { tuneRegulation } from './lib/calibrate-regulation.mjs';
import { evaluatePenaltyPrior } from './lib/penalty-test.mjs';
import { DEFAULT_ADVANCES_CONFIG, LEGACY_ADVANCES_CONFIG } from '../lib/advances-model.mjs';
import { fetchResultsYear } from './fetch-results.mjs';
import { buildRegulationDataset } from './build-regulation-dataset.mjs';

export function buildReport({ records, grid = [DEFAULT_ADVANCES_CONFIG], shootouts = [], baselineConfig = DEFAULT_ADVANCES_CONFIG }) {
  const regulation = tuneRegulation(records, grid, baselineConfig);
  return {
    regulation,
    decision: decideProduction(regulation),
    penalty: evaluatePenaltyPrior(shootouts),
    sample_sizes: { regulation: records.length, shootouts: shootouts.length },
  };
}

// A small default grid around the current constants (train picks the winner).
export const DEFAULT_GRID = [
  DEFAULT_ADVANCES_CONFIG,
  { ...DEFAULT_ADVANCES_CONFIG, eloGoalSupremacyDivisor: 500 },
  { ...DEFAULT_ADVANCES_CONFIG, eloGoalSupremacyDivisor: 700 },
  { ...DEFAULT_ADVANCES_CONFIG, homeAdvantageElo: 60 },
  { ...DEFAULT_ADVANCES_CONFIG, baselineTotalGoals: 2.6 },
];

// Widened calibration search over the VENUE-INDEPENDENT generative constants:
// supremacy sharpness (eloGoalSupremacyDivisor) and scoring level
// (baselineTotalGoals). homeAdvantageElo is fixed at 0 on purpose: the World Cup
// advances production path (computeAdvance) applies homeAdvantageElo
// unconditionally with NO neutral-site guard, and knockout ties are played at
// neutral venues — so any non-zero home term would inject a spurious advantage
// into neutral advance probabilities. Home advantage is therefore a non-neutral
// artifact that must not transfer to the neutral production model. penaltyPrior
// is NOT searched — the penalty layer has no shootout sample here, so it stays
// fixed at 0.5. Callers that want to study home advantage on non-neutral data
// can pass an explicit homeElos array.
export function buildWideGrid({
  divisors = [200, 250, 300, 350, 400, 500, 600],
  totals = [2.4, 2.6, 2.8, 3.0],
  homeElos = [0],
} = {}) {
  const grid = [];
  for (const eloGoalSupremacyDivisor of divisors) {
    for (const baselineTotalGoals of totals) {
      for (const homeAdvantageElo of homeElos) {
        grid.push({
          ...DEFAULT_ADVANCES_CONFIG,
          eloGoalSupremacyDivisor,
          baselineTotalGoals,
          homeAdvantageElo,
        });
      }
    }
  }
  return grid;
}

// Out-of-sample production gate. The tuned config (train-selected) is adopted
// ONLY if it beats the baseline default on the HELD-OUT test split by both
// log-loss (strictly lower) and Brier (no worse). Otherwise production keeps the
// baseline default — a train-set winner that fails to generalize is rejected.
export function decideProduction(regulation) {
  const baseLL = regulation.baseline.logLoss;
  const baseBrier = regulation.baseline.brier;
  const tunedLL = regulation.test.logLoss;
  const tunedBrier = regulation.test.brier;
  const beatsOOS = tunedLL < baseLL && tunedBrier <= baseBrier;
  return {
    beats_baseline_oos: beatsOOS,
    baseline: { logLoss: baseLL, brier: baseBrier },
    tuned: { logLoss: tunedLL, brier: tunedBrier, config: regulation.best.config },
    delta: { logLoss: tunedLL - baseLL, brier: tunedBrier - baseBrier },
    recommended_config: beatsOOS ? regulation.best.config : DEFAULT_ADVANCES_CONFIG,
  };
}

function parseArgs(argv) {
  const opts = { from: null, to: null, stateRoot: 'state' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') opts.from = Number(argv[++i]);
    else if (a === '--to') opts.to = Number(argv[++i]);
    else if (a === '--state-root') opts.stateRoot = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!opts.from) throw new Error('--from <year> is required');
  if (!opts.to) opts.to = opts.from;
  return opts;
}

async function main() {
  const { from, to, stateRoot } = parseArgs(process.argv.slice(2));
  const texts = [];
  for (let year = from; year <= to; year++) {
    try {
      texts.push(await fetchResultsYear(year));
      console.log(`[wc-calibration] fetched ${year}_results.tsv`);
    } catch (error) {
      console.log(`[wc-calibration] WARNING: ${year} unavailable (${error.message})`);
    }
  }
  const { records } = buildRegulationDataset(texts);
  // Scope the production recommendation to the neutral-venue subset: World Cup
  // knockout ties (the advances-model production distribution) are played at
  // neutral sites, so the model's constants must be calibrated on neutral data.
  const neutral = records.filter((r) => r.neutral);
  const grid = buildWideGrid();
  // Pin the baseline to the legacy divisor=600 config so the tuned-vs-baseline
  // comparison stays reproducible after the production default is bumped.
  const report = buildReport({ records: neutral, grid, shootouts: [], baselineConfig: LEGACY_ADVANCES_CONFIG });
  report.generated_for = { from, to };
  report.grid_size = grid.length;
  report.calibration_scope = 'neutral_venue_only';
  report.sample_sizes.regulation_all = records.length;
  report.sample_sizes.regulation_neutral = neutral.length;

  const dir = resolve(stateRoot, 'worldcup', 'backtest');
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, 'calibration_report.json');
  writeFileSync(path, JSON.stringify(report, null, 2));

  const { baseline, best, test } = report.regulation;
  const { beats_baseline_oos, recommended_config } = report.decision;
  console.log(`[wc-calibration] all=${records.length} neutral=${neutral.length} matches ${from}-${to}, grid=${grid.length} configs (neutral-scoped)`);
  console.log(`[wc-calibration] baseline test logLoss=${baseline.logLoss?.toFixed(4)} brier=${baseline.brier?.toFixed(4)}`);
  console.log(`[wc-calibration] tuned    test logLoss=${test.logLoss?.toFixed(4)} brier=${test.brier?.toFixed(4)} (divisor=${best.config.eloGoalSupremacyDivisor}, homeElo=${best.config.homeAdvantageElo}, goals=${best.config.baselineTotalGoals})`);
  console.log(`[wc-calibration] beats_baseline_oos=${beats_baseline_oos} → recommended: divisor=${recommended_config.eloGoalSupremacyDivisor}, homeElo=${recommended_config.homeAdvantageElo}, goals=${recommended_config.baselineTotalGoals}, penaltyPrior=${recommended_config.penaltyPrior}`);
  console.log(`[wc-calibration] report written: ${path}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then(() => process.exit(0)).catch(e => {
    console.error(`[wc-calibration] FATAL: ${e.message}`);
    process.exit(1);
  });
}
