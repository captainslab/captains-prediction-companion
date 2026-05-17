#!/usr/bin/env node
// NASCAR Stage 5 one-command workspace dry-run CLI.
// Runs the existing fixtures-only path end-to-end:
// source adapters -> discovery composer -> ceiling board -> output writer.
// No live network. No credentials. No trades. No order placement.

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
    fixturesOnly: true,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--date') opts.date = argv[++i];
    else if (arg === '--event-format') opts.eventFormat = argv[++i];
    else if (arg === '--series') opts.series = argv[++i];
    else if (arg === '--state-root') opts.stateRoot = argv[++i];
    else if (arg === '--fixtures-only') opts.fixturesOnly = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!opts.date) throw new Error('Missing --date value');
  if (!VALID_EVENT_FORMATS.has(opts.eventFormat)) {
    throw new Error(`Invalid --event-format value: ${opts.eventFormat}`);
  }
  if (opts.fixturesOnly !== true) {
    throw new Error('NASCAR workspace only supports fixtures-only dry runs');
  }

  return opts;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/nascar/nascar-workspace.mjs --date YYYY-MM-DD [--event-format points|all_star|clash|exhibition|heat|transfer|qualifying_transfer|cutdown] [--fixtures-only]',
    '',
    'Defaults:',
    '  --fixtures-only true',
    '  --event-format points',
    '  --state-root state',
    '',
    'Runs source adapters -> discovery composer -> ceiling board -> output writer.',
    'No live network. No credentials. No trades. No order placement.',
  ].join('\n');
}

function summarize(result) {
  return {
    run_date: result.runDate,
    event_format: result.eventFormat,
    output_dir: result.outputDir,
    files: result.files,
    ceilings_count: result.ceilingBoard.ceilings.length,
    field_count: result.ceilingBoard.field_bucket?.longshot_driver_count ?? 0,
    special_event_override: result.ceilingBoard.special_event_override?.active === true,
    no_trades: true,
  };
}

export async function runNascarWorkspace({
  date = '2026-02-13',
  eventFormat = 'points',
  series = 'cup',
  stateRoot = 'state',
  fixturesOnly = true,
} = {}) {
  if (fixturesOnly !== true) {
    throw new Error('NASCAR workspace only supports fixtures-only dry runs');
  }
  if (!VALID_EVENT_FORMATS.has(eventFormat)) {
    throw new Error(`Invalid eventFormat value: ${eventFormat}`);
  }

  const result = await runOutputWriterDryRun({
    date,
    eventFormat,
    series,
    stateRoot,
  });
  return summarize(result);
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

  const summary = await runNascarWorkspace(opts);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(err => {
    process.stderr.write(`NASCAR workspace dry-run failed: ${err.message ?? err}\n`);
    process.exit(1);
  });
}
