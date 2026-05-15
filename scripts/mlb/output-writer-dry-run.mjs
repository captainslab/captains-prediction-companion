#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { composeMlbDailyOutputs } from './output-writer-core.mjs';

function parseArgs(argv) {
  const options = {
    date: null,
    discoveryDir: null,
    outDir: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--date') {
      options.date = argv[++index] ?? null;
    } else if (arg === '--discovery-dir') {
      options.discoveryDir = argv[++index] ?? null;
    } else if (arg === '--out-dir') {
      options.outDir = argv[++index] ?? null;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.help && !options.date) {
    throw new Error('--date YYYY-MM-DD is required.');
  }

  return options;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/mlb/output-writer-dry-run.mjs --date YYYY-MM-DD [--discovery-dir path] [--out-dir path]',
    '',
    'Reads existing discovery JSON files only.',
    'Writes slate_manifest.json, source_registry.json, picks.json, daily-baseball-guide.md, and run_log.md.',
    'Discovery only. No final picks. No trades placed.',
  ].join('\n');
}

export async function runOutputWriterDryRun(options = {}) {
  const runDate = options.date;
  return composeMlbDailyOutputs({
    runDate,
    discoveryDir: options.discoveryDir ?? `state/mlb/${runDate}/discovery`,
    outDir: options.outDir ?? `state/mlb/${runDate}`,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      process.exit(0);
    }

    const result = await runOutputWriterDryRun(options);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exit(1);
  }
}
