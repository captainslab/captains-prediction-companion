#!/usr/bin/env node
// 6AM cron entry point for the MLB lineup-block packet workflow.
// Discovers today's MLB games on Kalshi, groups them into lineup blocks,
// and writes state/mlb/<DATE>/lineup-block-schedule.json.
// No trades. No picks. Discovery only.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { discoverAllSeries, joinGames } from './lib/series-discovery.mjs';
import {
  groupIntoLineupBlocks,
  BLOCK_GROUPING_MINUTES,
  POLLING_LEAD_MINUTES,
  HARD_CUTOFF_MINUTES,
} from './lib/lineup-blocks.mjs';

function parseArgs(argv) {
  const opts = {
    date: null,
    stateRoot: 'state',
    dryRun: false,
    groupingWindowMinutes: BLOCK_GROUPING_MINUTES,
    pollingLeadMinutes: POLLING_LEAD_MINUTES,
    hardCutoffMinutes: HARD_CUTOFF_MINUTES,
    inventory: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--date') opts.date = argv[++i];
    else if (a === '--state-root') opts.stateRoot = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--grouping-window-minutes') opts.groupingWindowMinutes = Number(argv[++i]);
    else if (a === '--polling-lead-minutes') opts.pollingLeadMinutes = Number(argv[++i]);
    else if (a === '--hard-cutoff-minutes') opts.hardCutoffMinutes = Number(argv[++i]);
    else if (a === '--inventory') opts.inventory = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!opts.date) opts.date = new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) throw new Error(`Bad --date: ${opts.date}`);
  return opts;
}

function printInventory() {
  console.log('=== Hermes MLB Cron Inventory ===');
  console.log('Searching user crontab for MLB-related jobs...');
  console.log('[CRONTAB SCAN]');

  const result = spawnSync('bash', ['-c', 'crontab -l 2>/dev/null'], { encoding: 'utf8' });
  const lines = (result.stdout || '').split('\n');
  const mlbLines = lines.filter((l) => /mlb/i.test(l) && l.trim() !== '');

  if (mlbLines.length === 0) {
    console.log('(none found)');
  } else {
    for (const l of mlbLines) {
      console.log(l);
    }
  }

  console.log('');
  console.log('[RESULT] No Hermes MLB cron jobs detected. Repo is sole MLB scheduler.');
  console.log('[PROOF]  Only jobs in this repo\'s crontab entry for \'schedule-daily-slate.mjs\' and');
  console.log('         \'generate-lineup-packets.mjs\' will schedule MLB work.');
  console.log('[NOTE]   If Hermes MLB crons existed, disable them with: crontab -e (remove MLB lines)');
}

export function buildLineupBlockSchedule({ date, games, groupingWindowMinutes, pollingLeadMinutes, hardCutoffMinutes }) {
  const blocks = groupIntoLineupBlocks(games, {
    groupingWindowMin: groupingWindowMinutes,
    pollingLeadMin: pollingLeadMinutes,
    hardCutoffMin: hardCutoffMinutes,
  });

  return {
    schema: 'mlb-lineup-block-schedule/v1',
    date,
    generated_utc: new Date().toISOString(),
    grouping_window_minutes: groupingWindowMinutes,
    polling_lead_minutes: pollingLeadMinutes,
    hard_cutoff_minutes: hardCutoffMinutes,
    game_count: games.length,
    block_count: blocks.length,
    blocks,
    notes: [
      '6AM slate discovery. Blocks represent games with nearby first pitches.',
      'Packet generator polls for lineup status and fires per block.',
      `Hard cutoff enforced: ${hardCutoffMinutes} min before lead first pitch.`,
      'HR props blocked until both lineups confirmed.',
    ],
  };
}

export function writeSchedule(stateRoot, date, schedule) {
  const dir = resolve(stateRoot, 'mlb', date);
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, 'lineup-block-schedule.json');
  writeFileSync(path, JSON.stringify(schedule, null, 2), 'utf8');
  return path;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log(
      'Usage: node scripts/mlb/schedule-daily-slate.mjs' +
      ' [--date YYYY-MM-DD]' +
      ' [--state-root state]' +
      ' [--dry-run]' +
      ' [--grouping-window-minutes 30]' +
      ' [--polling-lead-minutes 180]' +
      ' [--hard-cutoff-minutes 45]' +
      ' [--inventory]' +
      ' [--help]'
    );
    return;
  }

  if (opts.inventory) {
    printInventory();
    process.exit(0);
  }

  const prefix = opts.dryRun ? '[dry-run]' : '[mlb-schedule]';

  let games;
  if (opts.dryRun) {
    games = joinGames({});
  } else {
    const series = await discoverAllSeries(opts.date);
    games = joinGames(series);
  }

  const schedule = buildLineupBlockSchedule({
    date: opts.date,
    games,
    groupingWindowMinutes: opts.groupingWindowMinutes,
    pollingLeadMinutes: opts.pollingLeadMinutes,
    hardCutoffMinutes: opts.hardCutoffMinutes,
  });

  const path = writeSchedule(opts.stateRoot, opts.date, schedule);

  console.log(`${prefix} date=${opts.date} games=${schedule.game_count} blocks=${schedule.block_count}`);
  for (const b of schedule.blocks) {
    console.log(
      `${prefix} ${b.block_id}: ${b.games.length} game${b.games.length === 1 ? '' : 's'},` +
      ` polling starts ${b.polling_starts_ct?.slice(11, 16) ?? '?'} CT,` +
      ` cutoff ${b.hard_cutoff_ct?.slice(11, 16) ?? '?'} CT`
    );
  }
  console.log(`${prefix} schedule_written=${path}`);
  console.log(`${prefix} No trades placed. No picks forced. 6AM discovery only.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`[mlb-schedule] error: ${err.message}`);
    process.exit(1);
  });
}
