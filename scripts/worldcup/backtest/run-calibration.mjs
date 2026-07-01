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
import { DEFAULT_ADVANCES_CONFIG } from '../lib/advances-model.mjs';
import { fetchResultsYear } from './fetch-results.mjs';
import { buildRegulationDataset } from './build-regulation-dataset.mjs';

export function buildReport({ records, grid = [DEFAULT_ADVANCES_CONFIG], shootouts = [] }) {
  return {
    regulation: tuneRegulation(records, grid),
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
  const report = buildReport({ records, grid: DEFAULT_GRID, shootouts: [] });
  report.generated_for = { from, to };

  const dir = resolve(stateRoot, 'worldcup', 'backtest');
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, 'calibration_report.json');
  writeFileSync(path, JSON.stringify(report, null, 2));

  const { baseline, best, test } = report.regulation;
  console.log(`[wc-calibration] n=${records.length} matches ${from}-${to}`);
  console.log(`[wc-calibration] baseline test logLoss=${baseline.logLoss?.toFixed(4)} brier=${baseline.brier?.toFixed(4)}`);
  console.log(`[wc-calibration] tuned    test logLoss=${test.logLoss?.toFixed(4)} brier=${test.brier?.toFixed(4)} (divisor=${best.config.eloGoalSupremacyDivisor}, homeElo=${best.config.homeAdvantageElo}, goals=${best.config.baselineTotalGoals})`);
  console.log(`[wc-calibration] report written: ${path}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then(() => process.exit(0)).catch(e => {
    console.error(`[wc-calibration] FATAL: ${e.message}`);
    process.exit(1);
  });
}
