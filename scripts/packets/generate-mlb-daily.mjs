#!/usr/bin/env node
// MLB daily packet generator (pre-final-lineup research).
// Reads existing MLB workspace artifacts if present. No network. No trades. No execution.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parsePacketArgs,
  ensurePacketDir,
  writeAudit,
  packetHeader,
  packetFooter,
  printDryRunSummary,
  readJsonIfExists,
} from './lib/common.mjs';

const PACKET_TYPE = 'mlb-daily';

function locateMlbArtifacts(stateRoot, date) {
  // Best-effort scan for state/mlb/**/<date>/*.json.
  const root = resolve(stateRoot, 'mlb');
  if (!existsSync(root)) return [];
  const hits = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try { entries = readdirSync(cur); } catch { continue; }
    for (const e of entries) {
      const p = join(cur, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) {
        if (e === date || p.endsWith(`/${date}`)) {
          // collect json files
          try {
            for (const f of readdirSync(p)) {
              const fp = join(p, f);
              if (statSync(fp).isFile() && f.endsWith('.json')) hits.push(fp);
            }
          } catch {}
        } else {
          stack.push(p);
        }
      }
    }
  }
  return hits;
}

function summarizeGame(game) {
  const id = game.game_id || game.id || game.gamePk || 'MISSING';
  const matchup =
    game.matchup ||
    (game.away_team && game.home_team ? `${game.away_team} @ ${game.home_team}` : 'MISSING');
  const startUtc = game.start_utc || game.gameDate || game.start_time || 'MISSING';
  const pitchers =
    game.probable_pitchers ||
    (game.away_pitcher || game.home_pitcher
      ? { away: game.away_pitcher || 'MISSING', home: game.home_pitcher || 'MISSING' }
      : 'MISSING');
  const weather = game.weather || 'MISSING';
  const park = game.park || game.venue || 'MISSING';
  const lineupStatus = game.lineup_status || 'PRE-FINAL (not yet posted)';
  const board = game.market_board || game.markets || 'MISSING';

  const lines = [
    `- game_id: ${id}`,
    `  matchup: ${matchup}`,
    `  start_utc: ${startUtc}`,
    `  probable_pitchers: ${typeof pitchers === 'string' ? pitchers : JSON.stringify(pitchers)}`,
    `  lineup_status: ${lineupStatus}`,
    `  park: ${typeof park === 'string' ? park : JSON.stringify(park)}`,
    `  weather: ${typeof weather === 'string' ? weather : JSON.stringify(weather)}`,
    `  market_board: ${typeof board === 'string' ? board : JSON.stringify(board)}`,
    `  caveat: pre-final lineup; pitchers and lineups subject to change.`,
  ];
  return lines.join('\n');
}

function extractGames(artifacts) {
  const games = [];
  for (const fp of artifacts) {
    const data = readJsonIfExists(fp);
    if (!data) continue;
    const candidates =
      data.games || data.fixtures || data.schedule || (Array.isArray(data) ? data : null);
    if (Array.isArray(candidates)) {
      for (const g of candidates) games.push(g);
    } else if (data.game_id || data.matchup || data.home_team) {
      games.push(data);
    }
  }
  // Dedup by id+matchup
  const seen = new Set();
  return games.filter((g) => {
    const k = `${g.game_id || g.id || g.gamePk || ''}|${g.matchup || g.away_team || ''}|${g.home_team || ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function buildPacket({ date, games, artifacts }) {
  const header = packetHeader({
    title: 'Captain MLB — Daily Pre-Final-Lineup Packet',
    date,
    packetType: PACKET_TYPE,
    sources: artifacts.length ? artifacts : [],
  });
  const lines = [];
  if (!games.length) {
    lines.push('status: MISSING');
    lines.push('reason: no MLB fixtures discovered under state/mlb/**/<date>/');
    lines.push('next_step: run `node scripts/mlb/mlb-workspace.mjs discover --date ' + date + ' --fixtures-only --source all`');
  } else {
    lines.push(`game_count: ${games.length}`);
    lines.push('');
    lines.push('games:');
    for (const g of games) {
      lines.push(summarizeGame(g));
      lines.push('');
    }
    lines.push('pre_final_caveats:');
    lines.push('  - lineups not finalized; pitching can scratch');
    lines.push('  - totals/ML board reflects pre-lineup snapshot only');
    lines.push('  - weather snapshots may drift before first pitch');
  }
  return header + lines.join('\n') + packetFooter();
}

async function main() {
  const opts = parsePacketArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node scripts/packets/generate-mlb-daily.mjs --date YYYY-MM-DD [--dry-run]');
    return;
  }
  const dir = ensurePacketDir(opts.stateRoot, opts.date, PACKET_TYPE);
  const artifacts = locateMlbArtifacts(opts.stateRoot, opts.date);
  const games = extractGames(artifacts);
  const txt = buildPacket({ date: opts.date, games, artifacts });
  const w = writeAudit(dir, `${opts.date}-mlb-daily`, txt, { game_count: games.length, artifact_count: artifacts.length });
  console.log(printDryRunSummary({ packetType: PACKET_TYPE, date: opts.date, dir, items: [{ name: 'mlb-daily', ...w }] }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`[${PACKET_TYPE}] error: ${err.message}`);
    process.exit(1);
  });
}
