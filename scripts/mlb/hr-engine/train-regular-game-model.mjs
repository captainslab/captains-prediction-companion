// Train the chronological regular-game HR/PA model from the ignored Statcast
// cache and emit a reviewable fitted artifact plus held-out calibration report.

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readCachedTerminalRows, DEFAULT_STATCAST_CACHE_DIR } from './statcast-ingest.mjs';
import { fitRegularGameModel } from './regular-game-model.mjs';

export const DEFAULT_MODEL_PATH = 'scripts/mlb/hr-engine/artifacts/regular-game-model-2025.json';
export const DEFAULT_REPORT_PATH = 'docs/mlb/HR_REGULAR_GAME_CALIBRATION_2025.md';

function atomicWrite(path, text) {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}`;
  writeFileSync(temporary, text, 'utf8');
  renameSync(temporary, absolute);
}

function decimal(value, digits = 8) {
  return Number(value).toFixed(digits);
}

export function renderCalibrationReport(artifact) {
  const split = artifact.data.chronological_split;
  const model = artifact.evaluation.model;
  const baseline = artifact.evaluation.league_base_rate_baseline;
  const verdict = artifact.evaluation.calibration_claim_supported
    ? 'SUPPORTED under the predeclared rule'
    : 'NOT SUPPORTED';
  const win = artifact.evaluation.beats_baseline_brier_and_log_loss ? 'YES' : 'NO';
  const lines = [
    '# CPC Regular-Game Anytime-HR Model: 2025 Held-Out Report',
    '',
    `Generated: ${artifact.generated_utc}`,
    '',
    '## Data and split',
    '',
    `- Source: ${artifact.data.source}.`,
    `- Row grain: ${artifact.data.row_grain}.`,
    `- Ingested terminal PA: ${artifact.data.terminal_pa}; HR: ${artifact.data.home_runs}; range: ${artifact.data.date_range.start} through ${artifact.data.date_range.end}.`,
    `- Statcast terminal-row HR/PA: ${decimal(artifact.data.statcast_hr_pa, 6)}. Supplied official cross-check: ${artifact.data.official_reference.home_runs}/${artifact.data.official_reference.plate_appearances} = ${decimal(artifact.data.official_reference.hr_pa, 6)}; the terminal-row denominator is ${artifact.data.official_reference.terminal_row_delta} higher and is retained rather than silently discarded.`,
    `- Train: ${split.train.start} through ${split.train.end} (${split.train.rows} rows).`,
    `- Validation: ${split.validation.start} through ${split.validation.end} (${split.validation.rows} rows).`,
    `- Test: ${split.test.start} through ${split.test.end} (${split.test.rows} rows).`,
    '- Splits are chronological. The test block is the latest block and was evaluated once after all choices were fixed.',
    '- Rolling batter, pitcher, park, and league features are frozen at the start of each slate date; same-date outcomes never enter a pregame feature row.',
    '',
    '## Fitting',
    '',
    `- Empirical-Bayes prior strength: ${artifact.hyperparameters.prior_strength}, selected by validation log loss from [${artifact.hyperparameters.prior_candidates.join(', ')}].`,
    `- L2 regularization: ${artifact.hyperparameters.regularization_lambda}, selected by validation log loss from [${artifact.hyperparameters.regularization_candidates.join(', ')}].`,
    '- Logistic coefficients and standardization parameters were fitted from training rows. No coefficient is hardcoded or LLM-authored.',
    '- Opportunity is a separate fitted lineup-slot PA model; it does not enter the per-PA contact-quality target.',
    '',
    '## Held-out metrics',
    '',
    '| Predictor | Brier score | Log loss | Mean prediction | Test HR/PA |',
    '|---|---:|---:|---:|---:|',
    `| Fitted HR/PA model | ${decimal(model.brier_score)} | ${decimal(model.log_loss)} | ${decimal(model.mean_prediction)} | ${decimal(model.observed_hr_pa)} |`,
    `| Constant official league-rate baseline (${decimal(baseline.probability, 6)}) | ${decimal(baseline.brier_score)} | ${decimal(baseline.log_loss)} | ${decimal(baseline.mean_prediction)} | ${decimal(baseline.observed_hr_pa)} |`,
    '',
    `Beats the constant baseline on both metrics: **${win}**.`,
    '',
    `Calibration claim: **${verdict}**. Rule: ${artifact.evaluation.calibration_support_rule}.`,
    '',
    artifact.evaluation.conclusion,
    '',
    '## Held-out calibration table',
    '',
    '| Decile | Prediction range | Predicted mean | Observed HR rate | n |',
    '|---:|---:|---:|---:|---:|',
  ];
  for (const row of model.calibration) {
    lines.push(`| ${row.bucket} | ${decimal(row.prediction_min, 6)}–${decimal(row.prediction_max, 6)} | ${decimal(row.predicted_mean, 6)} | ${decimal(row.observed_hr_rate, 6)} | ${row.n} |`);
  }
  lines.push(
    '',
    `Expected calibration error: ${decimal(model.expected_calibration_error)}.`,
    '',
    '## Game-level conversion',
    '',
    'For fitted per-PA probability `p` and lineup-slot PA count `N`, the packet reports `1 - (1 - p)^N` for at least one HR and `N × p` expected HR. This assumes PA outcomes are conditionally independent. The shared seeded Monte Carlo engine supplies the 0 / 1 / 2+ distribution.',
    '',
    '## Missing inputs and identity',
    '',
    'Roof, altitude, weather, and directional-fit gaps have explicit missingness indicators. Production matching is MLB-ID-first; unique normalized name matching is fallback-only, and ambiguous names block as `MODEL_INSUFFICIENT`.',
  );
  return lines.join('\n');
}

export function trainFromCache({
  cacheDir = DEFAULT_STATCAST_CACHE_DIR,
  season = 2025,
  start = `${season}-03-18`,
  end = `${season}-09-28`,
  generatedUtc = '2026-07-13T00:00:00.000Z',
  modelPath = DEFAULT_MODEL_PATH,
  reportPath = DEFAULT_REPORT_PATH,
} = {}) {
  const cached = readCachedTerminalRows({ cacheDir, season, start, end, requireComplete: true });
  const artifact = fitRegularGameModel(cached.rows, { generatedUtc });
  atomicWrite(modelPath, `${JSON.stringify(artifact, null, 2)}\n`);
  atomicWrite(reportPath, `${renderCalibrationReport(artifact)}\n`);
  return { artifact, cache: cached.summary, modelPath: resolve(modelPath), reportPath: resolve(reportPath) };
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cache-dir') opts.cacheDir = argv[++i];
    else if (arg === '--season') opts.season = Number(argv[++i]);
    else if (arg === '--start') opts.start = argv[++i];
    else if (arg === '--end') opts.end = argv[++i];
    else if (arg === '--generated-utc') opts.generatedUtc = argv[++i];
    else if (arg === '--model-path') opts.modelPath = argv[++i];
    else if (arg === '--report-path') opts.reportPath = argv[++i];
    else if (arg === '--help') opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node scripts/mlb/hr-engine/train-regular-game-model.mjs [--cache-dir PATH] [--model-path PATH] [--report-path PATH]');
    return;
  }
  const result = trainFromCache(opts);
  console.log(JSON.stringify({
    cache: result.cache,
    split: result.artifact.data.chronological_split,
    evaluation: result.artifact.evaluation,
    model_path: result.modelPath,
    report_path: result.reportPath,
  }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  }
}
