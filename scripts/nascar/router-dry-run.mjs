#!/usr/bin/env node
// NASCAR Stage 1 router dry-run CLI. Writes files only; never trades.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { assertNoTradeDecisionStatus, routeNascarMarket } from './lib/router.mjs';

function parseArgs(argv) {
  const options = { title: null, rules: null, json: false, out: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--title') options.title = argv[++i] ?? null;
    else if (arg === '--rules') options.rules = argv[++i] ?? null;
    else if (arg === '--json') options.json = true;
    else if (arg === '--out') options.out = argv[++i] ?? null;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/nascar/router-dry-run.mjs --title "market title" [--rules "rules text"] [--json] [--out path]',
    '',
    'Examples:',
    '  node scripts/nascar/router-dry-run.mjs --title "Will Driver A win the Cup Series race at Daytona?" --json',
    '  node scripts/nascar/router-dry-run.mjs --title "Driver A to finish in the top 5 at Bristol" --json',
    '  node scripts/nascar/router-dry-run.mjs --title "Who will win the 2026 NASCAR Cup Series championship? (KXNASCARCUPSERIES-NCS26)" --json',
  ].join('\n');
}

function writeOutput(filePath, result) {
  const abs = resolve(filePath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return abs;
}

function formatText(result) {
  const lane = result.market_lane ?? 'none';
  const candidates = result.candidate_lanes.length > 0 ? result.candidate_lanes.join(', ') : 'none';
  const clarification =
    result.needed_clarification.length > 0 ? result.needed_clarification.join('; ') : 'none';
  const reject = result.reject_signals.length > 0 ? result.reject_signals.join('; ') : 'none';
  return [
    `route_status: ${result.route_status}`,
    `market_lane: ${lane}`,
    `market_scope: ${result.market_scope ?? 'none'}`,
    `candidate_lanes: ${candidates}`,
    `driver_name: ${result.driver_name ?? 'none'}`,
    `confidence: ${result.confidence}`,
    `reject_signals: ${reject}`,
    `needed_clarification: ${clarification}`,
    'No picks. No prices. No trades.',
  ].join('\n');
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    process.exit(0);
  }
  if (!options.title && !options.rules) {
    throw new Error('Provide --title (and optional --rules).');
  }

  const result = routeNascarMarket({
    market_title: options.title,
    rules_summary: options.rules,
  });

  // Hard guarantee: never emit a trade-decision status from the CLI either.
  assertNoTradeDecisionStatus(result);

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
