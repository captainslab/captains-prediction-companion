#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { routeMlbMarket } from './router-core.mjs';
import { runSourceAdapterDryRun } from './source-adapter-dry-run.mjs';
import { createBoardIntakeReport } from './board-intake-report.mjs';
import { runOutputWriterDryRun } from './output-writer-dry-run.mjs';

const VALID_COMMANDS = new Set(['help', 'router', 'discover', 'report', 'outputs', 'status', 'morning-scan', 'pregame-refresh']);
const VALID_SOURCES = new Set(['kalshi', 'mlb', 'baseball_savant', 'savant', 'weather', 'liquidity', 'all']);

function dateInChicago(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function discoveryDir(runDate, stateRoot = 'state') {
  return `${stateRoot}/mlb/${runDate}/discovery`;
}

function helpText() {
  return [
    'MLB terminal workspace wrapper',
    '',
    'Usage:',
    '  node scripts/mlb/mlb-workspace.mjs help',
    '  node scripts/mlb/mlb-workspace.mjs router --title "market title" [--rules "rules text"] [--json]',
    '  node scripts/mlb/mlb-workspace.mjs discover [--date YYYY-MM-DD] [--fixtures-only|--live-readonly] [--source kalshi|mlb|baseball_savant|weather|liquidity|all]',
    '  node scripts/mlb/mlb-workspace.mjs report --date YYYY-MM-DD [--discovery-dir path]',
    '  node scripts/mlb/mlb-workspace.mjs outputs --date YYYY-MM-DD [--discovery-dir path] [--out-dir path]',
    '  node scripts/mlb/mlb-workspace.mjs status --date YYYY-MM-DD',
    '  node scripts/mlb/mlb-workspace.mjs morning-scan [--date YYYY-MM-DD] [--fixtures-only|--live-readonly] [--state-root path]',
    '  node scripts/mlb/mlb-workspace.mjs pregame-refresh [--date YYYY-MM-DD] [--fixtures-only|--live-readonly] [--state-root path]',
    '  add --discovery-only to pregame-refresh to refresh adapters without rewriting slate outputs',
    '',
    'Examples:',
    '  node scripts/mlb/mlb-workspace.mjs router --title "Will the Alpha City Aces beat the Beta Town Bears?" --json',
    '  node scripts/mlb/mlb-workspace.mjs discover --date 2026-05-15 --fixtures-only --source all',
    '  node scripts/mlb/mlb-workspace.mjs discover --date 2026-05-15 --live-readonly --source all',
    '  node scripts/mlb/mlb-workspace.mjs report --date 2026-05-15',
    '  node scripts/mlb/mlb-workspace.mjs outputs --date 2026-05-15',
    '  node scripts/mlb/mlb-workspace.mjs status --date 2026-05-15',
    '  node scripts/mlb/mlb-workspace.mjs morning-scan --date 2026-05-15 --fixtures-only',
    '  node scripts/mlb/mlb-workspace.mjs morning-scan --date 2026-05-15 --live-readonly',
    '  node scripts/mlb/mlb-workspace.mjs pregame-refresh --date 2026-05-15 --fixtures-only',
    '',
    'Safety:',
    '  This wrapper is dry-run only. No picks made. No trades placed.',
    '  discover/morning-scan/pregame-refresh default to fixtures-only unless --live-readonly is explicit.',
    '',
    'Aliases:',
    '  mlb, baseball    → this workspace',
    '  mention, mentions → CaptainMentions workspace (separate)',
  ].join('\n');
}

function readValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parseRouterArgs(argv) {
  const options = { title: null, rules: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--title') {
      options.title = readValue(argv, index, arg);
      index += 1;
    } else if (arg === '--rules') {
      options.rules = readValue(argv, index, arg);
      index += 1;
    } else if (arg === '--json') {
      options.json = true;
    } else {
      throw new Error(`Unknown router argument: ${arg}`);
    }
  }
  return options;
}

function parseDiscoverArgs(argv) {
  const options = { date: null, fixturesOnly: false, liveReadonly: false, source: 'all' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--date') {
      options.date = readValue(argv, index, arg);
      index += 1;
    } else if (arg === '--fixtures-only') {
      options.fixturesOnly = true;
    } else if (arg === '--live-readonly') {
      options.liveReadonly = true;
    } else if (arg === '--source') {
      options.source = readValue(argv, index, arg);
      index += 1;
    } else {
      throw new Error(`Unknown discover argument: ${arg}`);
    }
  }
  if (!VALID_SOURCES.has(options.source)) {
    throw new Error(`Invalid --source value: ${options.source}`);
  }
  if (!options.liveReadonly) {
    options.fixturesOnly = true;
  }
  return options;
}

function parseReportArgs(argv) {
  const options = { date: null, discoveryDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--date') {
      options.date = readValue(argv, index, arg);
      index += 1;
    } else if (arg === '--discovery-dir') {
      options.discoveryDir = readValue(argv, index, arg);
      index += 1;
    } else {
      throw new Error(`Unknown report argument: ${arg}`);
    }
  }
  if (!options.date) {
    throw new Error('report requires --date YYYY-MM-DD.');
  }
  return options;
}

function parseOutputsArgs(argv) {
  const options = { date: null, discoveryDir: null, outDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--date') {
      options.date = readValue(argv, index, arg);
      index += 1;
    } else if (arg === '--discovery-dir') {
      options.discoveryDir = readValue(argv, index, arg);
      index += 1;
    } else if (arg === '--out-dir') {
      options.outDir = readValue(argv, index, arg);
      index += 1;
    } else {
      throw new Error(`Unknown outputs argument: ${arg}`);
    }
  }
  if (!options.date) {
    throw new Error('outputs requires --date YYYY-MM-DD.');
  }
  return options;
}

function parseScanArgs(argv) {
  const options = { date: null, fixturesOnly: false, liveReadonly: false, discoveryOnly: false, stateRoot: 'state' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--date') {
      options.date = readValue(argv, index, arg);
      index += 1;
    } else if (arg === '--fixtures-only') {
      options.fixturesOnly = true;
    } else if (arg === '--live-readonly') {
      options.liveReadonly = true;
    } else if (arg === '--discovery-only') {
      options.discoveryOnly = true;
    } else if (arg === '--state-root') {
      options.stateRoot = readValue(argv, index, arg);
      index += 1;
    } else {
      throw new Error(`Unknown scan argument: ${arg}`);
    }
  }
  if (!options.liveReadonly) {
    options.fixturesOnly = true;
  }
  return options;
}

function parseStatusArgs(argv) {
  const options = { date: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--date') {
      options.date = readValue(argv, index, arg);
      index += 1;
    } else {
      throw new Error(`Unknown status argument: ${arg}`);
    }
  }
  return options;
}

function formatRouterText(result) {
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

function runRouter(argv) {
  const options = parseRouterArgs(argv);
  const result = routeMlbMarket({
    market_title: options.title,
    rules_summary: options.rules,
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatRouterText(result));
  }
}

async function runDiscover(argv) {
  const options = parseDiscoverArgs(argv);
  const result = await runSourceAdapterDryRun(options);
  console.log(JSON.stringify(result, null, 2));
}

function runReport(argv) {
  const options = parseReportArgs(argv);
  const result = createBoardIntakeReport({
    runDate: options.date,
    discoveryDir: options.discoveryDir ?? discoveryDir(options.date),
  });
  console.log(JSON.stringify(result, null, 2));
}

async function runOutputs(argv) {
  const options = parseOutputsArgs(argv);
  const result = await runOutputWriterDryRun(options);
  console.log(JSON.stringify(result, null, 2));
}

async function runMorningScan(argv) {
  const options = parseScanArgs(argv);
  const runDate = options.date ?? dateInChicago();
  const mode = options.liveReadonly ? 'live-readonly' : 'fixtures-only';
  const discDir = discoveryDir(runDate);

  console.log(`[morning-scan] date=${runDate} mode=${mode}`);

  // Step 1: discover all sources
  const discoverResult = await runSourceAdapterDryRun({
    date: runDate,
    fixturesOnly: !options.liveReadonly,
    liveReadonly: options.liveReadonly,
    source: 'all',
  });
  console.log(`[morning-scan] discover: kalshi=${discoverResult.kalshi_status} mlb=${discoverResult.mlb_status} savant=${discoverResult.baseball_savant_status} weather=${discoverResult.weather_status}`);

  // Step 2: board intake report
  createBoardIntakeReport({ runDate, discoveryDir: discDir });
  console.log(`[morning-scan] report: ok`);

  // Step 3: outputs (includes scoring)
  const outputResult = await runOutputWriterDryRun({ date: runDate });
  console.log(`[morning-scan] outputs: picks=${outputResult.picks} scoring=${JSON.stringify(outputResult.scoring_counts ?? {})}`);

  console.log(`[morning-scan] complete. No picks placed. No trades placed.`);
  return {
    run_date: runDate,
    mode,
    discover: discoverResult,
    outputs: outputResult,
    message: 'Morning scan complete. Discovery only. No trades placed.',
  };
}

export async function runPregameRefresh(argv) {
  const options = parseScanArgs(argv);
  const runDate = options.date ?? dateInChicago();
  const mode = options.liveReadonly ? 'live-readonly' : 'fixtures-only';
  const discDir = discoveryDir(runDate, options.stateRoot);

  console.log(`[pregame-refresh] date=${runDate} mode=${mode}`);

  const discoverResult = await runSourceAdapterDryRun({
    date: runDate,
    fixturesOnly: !options.liveReadonly,
    liveReadonly: options.liveReadonly,
    source: 'all',
    out: discDir,
  });
  console.log(`[pregame-refresh] discover: kalshi=${discoverResult.kalshi_status} mlb=${discoverResult.mlb_status}`);

  createBoardIntakeReport({ runDate, discoveryDir: discDir });

  if (options.discoveryOnly) {
    console.log(`[pregame-refresh] discovery-only: skipping slate output writer`);
    return {
      run_date: runDate,
      mode,
      discover: discoverResult,
      outputs: null,
      message: 'Pregame discovery refresh complete. Slate outputs were not written.',
    };
  }

  const outputResult = await runOutputWriterDryRun({
    date: runDate,
    discoveryDir: discDir,
    outDir: `${options.stateRoot}/mlb/${runDate}`,
  });
  console.log(`[pregame-refresh] outputs: picks=${outputResult.picks}`);

  console.log(`[pregame-refresh] complete. No picks placed. No trades placed.`);
  return {
    run_date: runDate,
    mode,
    discover: discoverResult,
    outputs: outputResult,
    message: 'Pregame refresh complete. Discovery only. No trades placed.',
  };
}

function statusRows(runDate) {
  const discoveryFiles = [
    'discovery/kalshi_adapter.json',
    'discovery/mlb_official_adapter.json',
    'discovery/baseball_savant_adapter.json',
    'discovery/weather_adapter.json',
    'discovery/liquidity_adapter.json',
    'discovery/discovery_summary.md',
    'discovery/board_intake_report.md',
    'discovery/kalshi_rejected_records.json',
  ];
  const outputFiles = [
    'slate_manifest.json',
    'source_registry.json',
    'picks.json',
    'daily-baseball-guide.md',
    'run_log.md',
  ];

  return [
    ...discoveryFiles.map(fileName => ({ section: 'Discovery', fileName })),
    ...outputFiles.map(fileName => ({ section: 'Outputs', fileName })),
  ].map(({ section, fileName }) => {
    const filePath = `state/mlb/${runDate}/${fileName}`;
    return {
      section,
      file: filePath,
      exists: existsSync(filePath),
      absolute_path: resolve(filePath),
    };
  });
}

function runStatus(argv) {
  const options = parseStatusArgs(argv);
  const runDate = options.date ?? dateInChicago();
  const rows = statusRows(runDate);

  console.log(`MLB workspace status - ${runDate}`);
  let currentSection = null;
  for (const row of rows) {
    if (row.section !== currentSection) {
      currentSection = row.section;
      console.log(`${currentSection}:`);
    }
    console.log(`${row.exists ? 'EXISTS' : 'MISSING'} ${row.file}`);
  }
  console.log('No picks made. No trades placed.');
}

async function main(argv) {
  const command = argv[0] ?? 'help';
  const rest = argv.slice(1);

  if (!VALID_COMMANDS.has(command)) {
    throw new Error(`Unknown command: ${command}`);
  }

  if (command === 'help') {
    console.log(helpText());
  } else if (command === 'router') {
    runRouter(rest);
  } else if (command === 'discover') {
    await runDiscover(rest);
  } else if (command === 'report') {
    runReport(rest);
  } else if (command === 'outputs') {
    await runOutputs(rest);
  } else if (command === 'status') {
    runStatus(rest);
  } else if (command === 'morning-scan') {
    const result = await runMorningScan(rest);
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'pregame-refresh') {
    const result = await runPregameRefresh(rest);
    console.log(JSON.stringify(result, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('');
    console.error(helpText());
    process.exit(1);
  }
}
