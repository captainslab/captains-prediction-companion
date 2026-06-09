#!/usr/bin/env node
// World Cup daily sync cron job.
//
// Usage:
//   node scripts/worldcup/cron/daily-sync.mjs [--date YYYY-MM-DD] [--state-root state] [--dry-run]
//
// Fetches tournament structure + team baselines and caches them under
// state/worldcup/<date>/discovery/. Script-owned data sync only.
// No LLM. No send_message. No trades.
//
// Exit codes: 0 = ok (including "no matches today"), 1 = all sources failed.

import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import { fetchStaticStructure, loadCachedStructure } from '../source-adapters/static-structure.mjs';
import { fetchTeamBaseline, loadCachedTeamBaseline } from '../source-adapters/team-baseline.mjs';

function parseArgs(argv) {
  const opts = { date: null, stateRoot: 'state', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') opts.date = argv[++i];
    else if (a === '--state-root') opts.stateRoot = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!opts.date) opts.date = new Date().toISOString().slice(0, 10);
  return opts;
}

function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
}

async function main() {
  const { date, stateRoot, dryRun } = parseArgs(process.argv.slice(2));
  const discoveryDir = resolve(stateRoot, 'worldcup', date, 'discovery');

  console.log(`[worldcup-sync] ${new Date().toISOString()} syncing ${date} (dry-run: ${dryRun})`);

  const structure = await fetchStaticStructure({ stateRoot, date });
  if (!structure.ok || structure.match_count === 0) {
    // Keep an existing cache; only hard-fail when we have nothing at all.
    const cached = loadCachedStructure(stateRoot, date);
    if (cached.ok) {
      console.log(`[worldcup-sync] live structure unavailable; keeping existing cache (${cached.match_count ?? '?'} matches)`);
    } else {
      console.error(`[worldcup-sync] ERROR: no structure source available. Errors: ${(structure.errors || []).join('; ')}`);
      process.exit(1);
    }
  } else if (!dryRun) {
    mkdirSync(discoveryDir, { recursive: true });
    writeJson(resolve(discoveryDir, 'static_structure.json'), structure);
    console.log(`[worldcup-sync] structure cached: ${structure.match_count} matches from ${structure.source_id}`);
  } else {
    console.log(`[worldcup-sync] DRY RUN — would cache ${structure.match_count} matches from ${structure.source_id}`);
  }

  const baseline = await fetchTeamBaseline({ stateRoot, date });
  if (!baseline.ok || baseline.team_count === 0) {
    const cached = loadCachedTeamBaseline(stateRoot, date);
    if (cached.ok) {
      console.log(`[worldcup-sync] live baseline unavailable; keeping existing cache (${cached.team_count ?? '?'} teams)`);
    } else {
      console.log(`[worldcup-sync] WARNING: no team baseline available (composite will fail soft to MISSING layers)`);
    }
  } else if (!dryRun) {
    mkdirSync(discoveryDir, { recursive: true });
    writeJson(resolve(discoveryDir, 'team_baseline.json'), baseline);
    console.log(`[worldcup-sync] baseline cached: ${baseline.team_count} teams from ${baseline.source_id}`);
  } else {
    console.log(`[worldcup-sync] DRY RUN — would cache ${baseline.team_count} teams from ${baseline.source_id}`);
  }

  console.log(`[worldcup-sync] done`);
}

main().catch(e => {
  console.error(`[worldcup-sync] FATAL: ${e.message}`);
  process.exit(1);
});
