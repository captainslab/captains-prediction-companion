#!/usr/bin/env node
// NASCAR Stage 3 discovery dry-run CLI.
// Reads Stage 2 fixture envelopes and emits deterministic discovery JSON only.

import { pathToFileURL } from 'node:url';
import { runDiscoveryDryRun } from './lib/discovery.mjs';

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
    date: null,
    eventFormat: 'points',
    series: 'cup',
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--date') opts.date = argv[++i] ?? null;
    else if (arg === '--event-format') opts.eventFormat = argv[++i] ?? 'points';
    else if (arg === '--series') opts.series = argv[++i] ?? 'cup';
    else if (arg === '--fixtures-only') {
      // Explicitly accepted for parity with Stage 2. It is the only mode.
    } else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!VALID_EVENT_FORMATS.has(opts.eventFormat)) {
    throw new Error(`Invalid --event-format value: ${opts.eventFormat}`);
  }

  return opts;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/nascar/discovery-dry-run.mjs [--date YYYY-MM-DD] [--event-format points|all_star|clash|exhibition|heat|transfer|qualifying_transfer|cutdown] [--series cup|xfinity|trucks] [--fixtures-only]',
    '',
    'Stage 3 is fixtures-only and writes nothing. It emits normalized race discovery JSON.',
    'No picks, prices-as-recommendations, fair values, trades, stakes, orders, or execution fields.',
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

  const discovery = await runDiscoveryDryRun(opts);
  process.stdout.write(`${JSON.stringify(discovery, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(err => {
    process.stderr.write(`Discovery dry-run failed: ${err.message ?? err}\n`);
    process.exit(1);
  });
}
