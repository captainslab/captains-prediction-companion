#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { routeMlbMarket } from './router-core.mjs';

function parseArgs(argv) {
  const options = {
    title: null,
    rules: null,
    json: false,
    out: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--title') {
      options.title = argv[++index] ?? null;
    } else if (arg === '--rules') {
      options.rules = argv[++index] ?? null;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--out') {
      options.out = argv[++index] ?? null;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/mlb/router-dry-run.mjs --title "market title" [--rules "rules text"] [--json] [--out path]',
    '',
    'Examples:',
    '  node scripts/mlb/router-dry-run.mjs --title "Will the Alpha City Aces beat the Beta Town Bears?" --json',
    '  node scripts/mlb/router-dry-run.mjs --title "Aces vs Bears over 1.5" --json',
  ].join('\n');
}

function writeOutput(filePath, result) {
  const absolutePath = resolve(filePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return absolutePath;
}

function formatText(result) {
  const lane = result.market_lane ?? 'none';
  const candidates = result.candidate_lanes.length > 0 ? result.candidate_lanes.join(', ') : 'none';
  const clarification =
    result.needed_clarification.length > 0 ? result.needed_clarification.join('; ') : 'none';

  return [
    `route_status: ${result.route_status}`,
    `market_lane: ${lane}`,
    `candidate_lanes: ${candidates}`,
    `confidence: ${result.confidence}`,
    `needed_clarification: ${clarification}`,
    'No picks made. No trades placed.',
  ].join('\n');
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    process.exit(0);
  }

  const result = routeMlbMarket({
    market_title: options.title,
    rules_summary: options.rules,
  });

  if (options.out) {
    const outputPath = writeOutput(options.out, result);
    result.notes = [...result.notes, `Wrote dry-run router output to ${outputPath}`];
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatText(result));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage());
  process.exit(1);
}
