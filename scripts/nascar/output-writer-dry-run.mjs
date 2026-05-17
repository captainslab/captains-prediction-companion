#!/usr/bin/env node
// NASCAR Stage 4 output writer dry-run CLI.
// Fixtures-only. No live network. No credentials. No trading.
import { pathToFileURL } from 'node:url';
import { runOutputWriterDryRun } from './lib/output-writer.mjs';

const VALID_EVENT_FORMATS = new Set([
  'points',
  'all_star',
  'clash',
  'exhibition',
  'heat',
  'transfer',
  'qualifying_transfer',
  'cutdown',
]);

function parseArgs(argv) {
  const opts = {
    date: '2026-02-13',
    eventFormat: 'points',
    series: 'cup',
    stateRoot: 'state',
    fixturesOnly: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--date') opts.date = argv[++i];
    else if (a === '--event-format') opts.eventFormat = argv[++i];
    else if (a === '--series') opts.series = argv[++i];
    else if (a === '--state-root') opts.stateRoot = argv[++i];
    else if (a === '--fixtures-only') opts.fixturesOnly = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!VALID_EVENT_FORMATS.has(opts.eventFormat)) {
    throw new Error(`Invalid --event-format value: ${opts.eventFormat}`);
  }
  return opts;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/nascar/output-writer-dry-run.mjs --date YYYY-MM-DD [--event-format points|all_star|...] [--series cup|xfinity|trucks] [--state-root state] [--fixtures-only]',
    '',
    'Stage 4 is fixtures-only. No live network. No credentials. No trading.',
  ].join('\n');
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
  const result = await runOutputWriterDryRun({
    date: opts.date,
    eventFormat: opts.eventFormat,
    series: opts.series,
    stateRoot: opts.stateRoot,
  });
  const summary = {
    run_date: result.runDate,
    event_format: result.eventFormat,
    output_dir: result.outputDir,
    files: result.files,
    ceilings: result.ceilingBoard.ceilings.length,
    field_drivers: result.ceilingBoard.field_bucket?.longshot_driver_count ?? 0,
    special_event_override: result.ceilingBoard.special_event_override?.active === true,
    mode: 'fixtures-only',
    no_trades: true,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(err => {
    process.stderr.write(`Output writer dry-run failed: ${err.message ?? err}\n`);
    process.exit(1);
  });
}
