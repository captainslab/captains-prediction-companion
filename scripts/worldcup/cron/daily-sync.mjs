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
import { fileURLToPath } from 'node:url';

import { fetchStaticStructure, loadCachedStructure } from '../source-adapters/static-structure.mjs';
import { fetchTeamBaseline, loadCachedTeamBaseline } from '../source-adapters/team-baseline.mjs';
import { writeEloBaseline } from '../source-adapters/elo-ratings-fetch.mjs';
import { writeAdvancesMarkets } from '../source-adapters/advances-markets-fetch.mjs';

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

export async function runDailySync({
  date,
  stateRoot = 'state',
  dryRun = false,
  fetchStaticStructureImpl = fetchStaticStructure,
  fetchTeamBaselineImpl = fetchTeamBaseline,
  writeEloBaselineImpl = writeEloBaseline,
  writeAdvancesMarketsImpl = writeAdvancesMarkets,
  writeJsonImpl = writeJson,
  log = console,
} = {}) {
  const discoveryDir = resolve(stateRoot, 'worldcup', date, 'discovery');

  log.log(`[worldcup-sync] ${new Date().toISOString()} syncing ${date} (dry-run: ${dryRun})`);

  const structure = await fetchStaticStructureImpl({
    stateRoot,
    date,
    fifaUrl: process.env.WORLDCUP_STATIC_STRUCTURE_FIFA_URL,
    espnUrl: process.env.WORLDCUP_STATIC_STRUCTURE_ESPN_URL,
    openfootballUrl: process.env.WORLDCUP_STATIC_STRUCTURE_OPENFOOTBALL_URL,
  });
  if (!structure.ok || structure.match_count === 0) {
    // Keep an existing cache; only hard-fail when we have nothing at all.
    const cached = loadCachedStructure(stateRoot, date);
    if (cached.ok) {
      log.log(`[worldcup-sync] live structure unavailable; keeping existing cache (${cached.match_count ?? '?'} matches)`);
    } else {
      throw new Error(`no structure source available. Errors: ${(structure.errors || []).join('; ')}`);
    }
  } else if (!dryRun) {
    mkdirSync(discoveryDir, { recursive: true });
    writeJsonImpl(resolve(discoveryDir, 'static_structure.json'), structure);
    log.log(`[worldcup-sync] structure cached: ${structure.match_count} matches from ${structure.source_id}`);
  } else {
    log.log(`[worldcup-sync] DRY RUN — would cache ${structure.match_count} matches from ${structure.source_id}`);
  }

  const baseline = await fetchTeamBaselineImpl({
    stateRoot,
    date,
    structure: structure?.ok ? structure : null,
  });
  if (!baseline.ok || baseline.team_count === 0) {
    const cached = loadCachedTeamBaseline(stateRoot, date);
    if (cached.ok) {
      log.log(`[worldcup-sync] live baseline unavailable; keeping existing cache (${cached.team_count ?? '?'} teams)`);
    } else {
      log.log(`[worldcup-sync] WARNING: no team baseline available (composite will fail soft to MISSING layers)`);
    }
  } else if (!dryRun) {
    mkdirSync(discoveryDir, { recursive: true });
    writeJsonImpl(resolve(discoveryDir, 'team_baseline.json'), baseline);
    log.log(`[worldcup-sync] baseline cached: ${baseline.team_count} teams from ${baseline.source_id}`);
  } else {
    log.log(`[worldcup-sync] DRY RUN — would cache ${baseline.team_count} teams from ${baseline.source_id}`);
  }

  // Published Elo baseline (eloratings.net) — the advances model's rating spine.
  // Cached once per day; fail-soft so a fetch hiccup never blocks the sync.
  if (!dryRun) {
    try {
      const elo = await writeEloBaselineImpl(stateRoot, date, { retrievedAt: new Date().toISOString() });
      if (elo.ok) {
        log.log(`[worldcup-sync] elo baseline cached: ${elo.count} published ratings (eloratings.net)`);
      } else {
        log.log(`[worldcup-sync] WARNING: published Elo unavailable (${elo.error}); advances lanes block on missing Elo`);
      }
    } catch (error) {
      log.log(`[worldcup-sync] WARNING: published Elo fetch threw (${error.message}); advances lanes block on missing Elo`);
    }
  } else {
    log.log('[worldcup-sync] DRY RUN — would cache published Elo baseline from eloratings.net');
  }

  // KXWCADVANCE advances-market classification (Kalshi public series) — maps
  // today's knockout advances fixtures to FIFA match_ids. Fail-soft; no price kept.
  if (!dryRun) {
    try {
      const structForMap = structure?.ok ? structure : loadCachedStructure(stateRoot, date);
      const advances = await writeAdvancesMarketsImpl(stateRoot, date, structForMap?.matches || [], { retrievedAt: new Date().toISOString() });
      if (advances.ok) {
        log.log(`[worldcup-sync] advances markets cached: ${advances.count} knockout fixtures (KXWCADVANCE)`);
      } else {
        log.log(`[worldcup-sync] WARNING: advances-market discovery unavailable (${advances.error})`);
      }
    } catch (error) {
      log.log(`[worldcup-sync] WARNING: advances-market discovery threw (${error.message})`);
    }
  } else {
    log.log('[worldcup-sync] DRY RUN — would cache KXWCADVANCE advances classification');
  }

  log.log('[worldcup-sync] done');
}

async function main() {
  const { date, stateRoot, dryRun } = parseArgs(process.argv.slice(2));
  await runDailySync({ date, stateRoot, dryRun });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch(e => {
      console.error(`[worldcup-sync] FATAL: ${e.message}`);
      process.exit(1);
    });
}
