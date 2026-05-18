#!/usr/bin/env node
// MLB daily packet generator (pre-final-lineup research).
// Primes the existing MLB discovery/output workflow before building packets. No trades.

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
  runPacketCommand,
} from './lib/common.mjs';

const PACKET_TYPE = 'mlb-daily';

export function primeMlbResearch(date, options = {}) {
  const runner = options.runner;
  const cwd = options.cwd ?? process.cwd();
  const commands = [
    ['node', ['scripts/mlb/mlb-workspace.mjs', 'discover', '--date', date, '--live-readonly', '--source', 'all']],
    ['node', ['scripts/mlb/mlb-workspace.mjs', 'outputs', '--date', date]],
  ];
  const attempts = [];
  for (const [command, args] of commands) {
    const result = runPacketCommand(command, args, { cwd, runner });
    attempts.push(result);
    if (!result.ok) break;
  }
  return attempts;
}

export function locateMlbArtifacts(stateRoot, date) {
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

function artifactPriority(filePath) {
  if (filePath.endsWith('/slate_manifest.json')) return 0;
  if (filePath.endsWith('/picks.json')) return 1;
  if (filePath.endsWith('/source_registry.json')) return 2;
  if (filePath.endsWith('/mlb_official_adapter.json')) return 3;
  return 9;
}

function normalizeGameShape(game = {}) {
  const teams = game.teams && typeof game.teams === 'object' ? game.teams : {};
  return {
    ...game,
    game_id: game.game_id || game.game_pk || game.gamePk || game.id || null,
    matchup:
      game.matchup ||
      game.game ||
      (game.away_team && game.home_team ? `${game.away_team} @ ${game.home_team}` : null) ||
      (teams.away && teams.home ? `${teams.away} @ ${teams.home}` : null),
    away_team: game.away_team || teams.away || null,
    home_team: game.home_team || teams.home || null,
    start_utc: game.start_utc || game.start_time_utc || game.gameDate || game.start_time || null,
    park: game.park || game.venue || null,
    market_board: game.market_board || game.markets || game.kalshi_events || game.listed_market_lanes || null,
  };
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

export function extractGames(artifacts) {
  const games = [];
  for (const fp of artifacts) {
    const data = readJsonIfExists(fp);
    if (!data) continue;
    const candidates =
      data.games ||
      data.fixtures ||
      data.schedule ||
      data.records ||
      data.slate?.games ||
      (Array.isArray(data) ? data : null);
    if (Array.isArray(candidates)) {
      for (const g of candidates) games.push(normalizeGameShape(g));
    } else if (data.game_id || data.game_pk || data.gamePk || data.matchup || data.game || data.home_team) {
      games.push(normalizeGameShape(data));
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

function buildPacket({ date, game, artifacts, primeAttempts }) {
  const header = packetHeader({
    title: 'Captain MLB — Daily Pre-Final-Lineup Packet',
    date,
    packetType: PACKET_TYPE,
    sources: artifacts.length ? artifacts : [],
  });
  const lines = [];
  lines.push('research_prime:');
  if (primeAttempts.length) {
    for (const attempt of primeAttempts) {
      lines.push(`  - command: ${attempt.label}`);
      lines.push(`    status: ${attempt.ok ? 'ok' : 'MISSING'}`);
      if (!attempt.ok) {
        lines.push(`    error: ${attempt.error || attempt.stderr || 'command failed'}`);
      }
    }
  } else {
    lines.push('  - MISSING: no discovery command attempted');
  }
  lines.push('');
  if (!game) {
    lines.push('status: MISSING');
    lines.push('reason: MLB discovery/output workflow was attempted, but no game records were found under state/mlb/**/<date>/.');
    lines.push('next_step: inspect `node scripts/mlb/mlb-workspace.mjs status --date ' + date + '` and discovery command stderr above.');
  } else {
    lines.push('game_count: 1');
    lines.push('');
    lines.push('game:');
    lines.push(summarizeGame(game));
    lines.push('');
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
  const primeAttempts = primeMlbResearch(opts.date);
  const artifacts = locateMlbArtifacts(opts.stateRoot, opts.date).sort(
    (left, right) => artifactPriority(left) - artifactPriority(right) || left.localeCompare(right),
  );
  const games = extractGames(artifacts);
  const items = [];
  const primeMeta = primeAttempts.map(({ label, ok, status, stderr, error }) => ({ label, ok, status, stderr, error }));
  if (!games.length) {
    const txt = buildPacket({ date: opts.date, game: null, artifacts, primeAttempts });
    const w = writeAudit(dir, `${opts.date}-mlb-daily-MISSING`, txt, {
      game_count: 0,
      artifact_count: artifacts.length,
      research_prime: primeMeta,
    });
    items.push({ name: 'mlb-daily-MISSING', ...w });
  } else {
    for (const game of games) {
      const gameId = game.game_id || game.id || game.gamePk || game.matchup || 'game';
      const txt = buildPacket({ date: opts.date, game, artifacts, primeAttempts });
      const w = writeAudit(dir, `${opts.date}-${gameId}`, txt, {
        game_count: 1,
        total_game_count: games.length,
        game_id: gameId,
        artifact_count: artifacts.length,
        research_prime: primeMeta,
      });
      items.push({ name: String(gameId), ...w });
    }
  }
  console.log(printDryRunSummary({ packetType: PACKET_TYPE, date: opts.date, dir, items }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`[${PACKET_TYPE}] error: ${err.message}`);
    process.exit(1);
  });
}
