#!/usr/bin/env node
// NASCAR Stage 2 source adapter dry-run CLI.
// Fixtures-only by default. No live network. No credentials. No trading.
import { pathToFileURL } from 'node:url';
import {
  defaultDiscoveryDir,
  formatDateInTimeZone,
  writeJsonAtomic,
  isoNow,
} from './lib/cache.mjs';
import { fetchKalshiRaceReadonly } from './lib/source-adapters/kalshi-race-fixture.mjs';
import { fetchNascarOfficialReadonly } from './lib/source-adapters/nascar-official-fixture.mjs';
import { fetchPracticeQualifyingReadonly } from './lib/source-adapters/practice-qualifying-fixture.mjs';
import { fetchLiquidityReadonly } from './lib/source-adapters/liquidity-fixture.mjs';

const VALID_SOURCES = new Set(['kalshi', 'nascar', 'practice', 'liquidity', 'all']);

function parseArgs(argv) {
  const options = {
    date: null,
    source: 'all',
    out: null,
    eventFormat: 'points',
    series: 'cup',
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--date') options.date = argv[++i] ?? null;
    else if (arg === '--source') options.source = argv[++i] ?? 'all';
    else if (arg === '--out') options.out = argv[++i] ?? null;
    else if (arg === '--event-format') options.eventFormat = argv[++i] ?? 'points';
    else if (arg === '--series') options.series = argv[++i] ?? 'cup';
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!VALID_SOURCES.has(options.source)) {
    throw new Error(`Invalid --source value: ${options.source}`);
  }
  return options;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/nascar/source-adapter-dry-run.mjs [--date YYYY-MM-DD] [--source kalshi|nascar|practice|liquidity|all] [--event-format points|all_star|clash|exhibition|heat|qualifying_transfer|cutdown] [--series cup|xfinity|trucks] [--out path] [--json]',
    '',
    'Defaults:',
    '  --source all',
    '  --event-format points',
    '  --series cup',
    '  --date today in America/Chicago',
    '  --out state/nascar/<date>/discovery',
    '',
    'Stage 2 is fixtures-only. No live network. No credentials. No trading.',
  ].join('\n');
}

function shouldRun(requested, source) {
  return requested === 'all' || requested === source;
}

export async function runSourceAdapterDryRun(opts = {}) {
  const runDate = opts.date ?? formatDateInTimeZone(new Date(), 'America/Chicago');
  const outputDir = opts.out ?? defaultDiscoveryDir(runDate);
  const checked_at_utc = isoNow();

  const envelopes = {};

  if (shouldRun(opts.source ?? 'all', 'kalshi')) {
    envelopes.kalshi_race = await fetchKalshiRaceReadonly({
      outputDir,
      fixturesOnly: true,
      now: new Date(checked_at_utc),
      event_format: opts.eventFormat ?? 'points',
    });
  }
  if (shouldRun(opts.source ?? 'all', 'nascar')) {
    envelopes.nascar_official = await fetchNascarOfficialReadonly({
      outputDir,
      fixturesOnly: true,
      now: new Date(checked_at_utc),
      event_format: opts.eventFormat ?? 'points',
      series: opts.series ?? 'cup',
    });
  }
  if (shouldRun(opts.source ?? 'all', 'practice')) {
    envelopes.practice_qualifying = await fetchPracticeQualifyingReadonly({
      outputDir,
      fixturesOnly: true,
      now: new Date(checked_at_utc),
    });
  }
  if (shouldRun(opts.source ?? 'all', 'liquidity')) {
    envelopes.liquidity = await fetchLiquidityReadonly({
      outputDir,
      fixturesOnly: true,
      now: new Date(checked_at_utc),
    });
  }

  const summary = {
    run_date: runDate,
    checked_at_utc,
    mode: 'fixtures-only',
    event_format: opts.eventFormat ?? 'points',
    series: opts.series ?? 'cup',
    output_dir: outputDir,
    sources: Object.fromEntries(
      Object.entries(envelopes).map(([id, env]) => [
        id,
        {
          source_id: env.source_id,
          status: env.status,
          record_count: Array.isArray(env.records) ? env.records.length : 0,
          warnings: env.warnings?.length ?? 0,
          errors: env.errors?.length ?? 0,
        },
      ]),
    ),
  };

  return { runDate, outputDir, envelopes, summary };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${usage()}\n`);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const { outputDir, envelopes, summary } = await runSourceAdapterDryRun(opts);

  if (opts.out !== null || opts.json !== true) {
    for (const [id, env] of Object.entries(envelopes)) {
      const fileName = `${id}_adapter.json`;
      writeJsonAtomic(`${outputDir}/${fileName}`, env);
    }
    writeJsonAtomic(`${outputDir}/source_adapter_summary.json`, summary);
  }

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(err => {
    process.stderr.write(`Source adapter dry-run failed: ${err.message ?? err}\n`);
    process.exit(1);
  });
}
