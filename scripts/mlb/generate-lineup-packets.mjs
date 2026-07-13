#!/usr/bin/env node
// MLB lineup-block packet generator — called periodically by cron (~5 min).
// Finds due lineup blocks, checks lineup status, generates per-game and
// block-level packets, writes artifacts, and updates the schedule file.
//
// Usage:
//   node scripts/mlb/generate-lineup-packets.mjs --date YYYY-MM-DD [options]
//
// No trades. No bankroll. No Telegram send by default.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { findDueBlocks, LINEUP_STATUS, resolveDowngrade } from './lib/lineup-blocks.mjs';
import { fetchMlbScheduleReadonly } from './source-adapters/mlb-official-readonly.mjs';
import { discoverAllSeries, joinGames } from './lib/series-discovery.mjs';
import {
  buildGameProjections,
  leagueRunsPerGame,
  loadStatsRecords,
  matchStatsRecord,
} from './lib/projection-engine.mjs';

// Packet renderer is written by a parallel agent — import lazily so a missing
// module produces a clear error only when actually needed, not at startup.
let _packetRenderer = null;
async function getPacketRenderer() {
  if (_packetRenderer) return _packetRenderer;
  try {
    _packetRenderer = await import('./lib/packet-renderer.mjs');
  } catch (err) {
    throw new Error(
      `[mlb-packets] Cannot import packet-renderer.mjs: ${err.message}\n` +
      'Ensure lib/packet-renderer.mjs has been written before running this script.',
    );
  }
  return _packetRenderer;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    date: null,
    stateRoot: 'state',
    block: null,
    graceMinutes: 5,
    lineupStatusOverride: null,
    dryRun: false,
    noRefresh: false,
    help: false,
  };

  const validLineupStatuses = new Set(Object.values(LINEUP_STATUS));

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--date') {
      opts.date = argv[++i];
    } else if (a === '--state-root') {
      opts.stateRoot = argv[++i];
    } else if (a === '--block') {
      opts.block = argv[++i];
    } else if (a === '--grace-minutes') {
      const v = Number(argv[++i]);
      if (Number.isNaN(v)) throw new Error(`--grace-minutes must be a number, got: ${argv[i]}`);
      opts.graceMinutes = v;
    } else if (a === '--lineup-status') {
      const v = argv[++i];
      if (!validLineupStatuses.has(v)) {
        throw new Error(
          `--lineup-status must be one of: ${[...validLineupStatuses].join('|')}, got: ${v}`,
        );
      }
      opts.lineupStatusOverride = v;
    } else if (a === '--dry-run') {
      opts.dryRun = true;
    } else if (a === '--no-refresh') {
      opts.noRefresh = true;
    } else if (a === '--help' || a === '-h') {
      opts.help = true;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }

  if (!opts.date) opts.date = new Date().toISOString().slice(0, 10);
  return opts;
}

// ---------------------------------------------------------------------------
// Schedule file helpers
// ---------------------------------------------------------------------------

function loadSchedule(stateRoot, date) {
  const path = resolve(stateRoot, 'mlb', date, 'lineup-block-schedule.json');
  if (!existsSync(path)) {
    throw new Error(
      `No lineup-block schedule found at ${path}.\n` +
      'Run the lineup-block scheduler first to generate this file (e.g. build-lineup-blocks.mjs).',
    );
  }
  return { path, schedule: JSON.parse(readFileSync(path, 'utf8')) };
}

function saveScheduleAtomic(path, schedule) {
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(schedule, null, 2), 'utf8');
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Exported: fetchLineupStatus
// ---------------------------------------------------------------------------

/**
 * Determine the lineup status for a given block by consulting the MLB Stats API.
 *
 * @param {object} block       - lineup block from the schedule
 * @param {string} date        - YYYY-MM-DD
 * @param {string} stateRoot   - base state directory
 * @param {object} opts        - { dryRun }
 * @returns {Promise<string>}  - one of LINEUP_STATUS values
 */
export async function fetchLineupStatus(block, date, stateRoot, opts = {}) {
  try {
    const outputDir = resolve(stateRoot, 'mlb', date);
    const envelope = await fetchMlbScheduleReadonly({
      runDate: date,
      outputDir,
      fixturesOnly: Boolean(opts.dryRun),
    });

    if (!envelope || !Array.isArray(envelope.records) || envelope.records.length === 0) {
      return LINEUP_STATUS.PENDING;
    }

    // Build a set of team names that appear in this block's games (lowercase).
    const blockTeamNames = new Set();
    for (const g of block.games || []) {
      if (g.away_full) blockTeamNames.add(g.away_full.toLowerCase());
      if (g.home_full) blockTeamNames.add(g.home_full.toLowerCase());
      if (g.away) blockTeamNames.add(g.away.toLowerCase());
      if (g.home) blockTeamNames.add(g.home.toLowerCase());
    }

    // Filter schedule records to those matching games in this block.
    const matchedRecords = envelope.records.filter((r) => {
      const away = (r.away_team || '').toLowerCase();
      const home = (r.home_team || '').toLowerCase();
      return blockTeamNames.has(away) || blockTeamNames.has(home);
    });

    if (matchedRecords.length === 0) return LINEUP_STATUS.PENDING;

    // Count confirmed probable pitchers across matched games.
    let confirmedCount = 0;
    let totalSlots = 0;
    for (const r of matchedRecords) {
      const pp = r.probable_pitchers || {};
      totalSlots += 2; // away + home slot per game
      if (pp.away) confirmedCount += 1;
      if (pp.home) confirmedCount += 1;
    }

    if (confirmedCount === 0) return LINEUP_STATUS.PENDING;
    if (confirmedCount >= totalSlots) return LINEUP_STATUS.BOTH_CONFIRMED;
    return LINEUP_STATUS.ONE_CONFIRMED;
  } catch (_err) {
    // Safe fallback — never crash the run due to status fetch failure.
    return LINEUP_STATUS.PENDING;
  }
}

// ---------------------------------------------------------------------------
// Exported: buildPacketMeta
// ---------------------------------------------------------------------------

/**
 * Build the .meta.json object for a rendered block packet.
 *
 * @param {object} p
 * @returns {object}
 */
export function buildPacketMeta({
  date,
  blockId,
  lineupStatus,
  downgrade,
  games,
  perGamePackets,
  blockTxtPath,
  dryRun,
}) {
  const blockText = perGamePackets.reduce((acc, p) => acc + (p.text || ''), '');
  const charCount = blockText.length;
  const hasPicks = perGamePackets.some(
    (p) => p.bestLaneDecision === 'CLEAR' || p.bestLaneDecision === 'LEAN',
  );

  return {
    schema: 'mlb-lineup-packet/v1',
    date,
    block_id: blockId,
    lineup_status: lineupStatus,
    downgrade,
    game_count: games.length,
    game_keys: games.map((g) => g.game_key),
    char_count: charCount,
    has_picks: hasPicks,
    hr_model: perGamePackets.map((packet) => ({
      game_key: packet.gameKey,
      status: packet.hrProjection?.model_status ?? 'MODEL_INSUFFICIENT',
      ready_players: (packet.hrProjection?.outputs ?? []).filter((row) => row.status === 'ready').length,
      blocked_reasons: packet.hrProjection?.blocked_reasons ?? [],
    })),
    dry_run: dryRun,
    generated_utc: new Date().toISOString(),
  };
}

export function packetTextPayload(packet) {
  if (typeof packet === 'string') return packet;
  if (packet && typeof packet.text === 'string') return packet.text;
  return '';
}

// ---------------------------------------------------------------------------
// Schedule record → lineup notes + starters helper
// ---------------------------------------------------------------------------

function findScheduleRecordForGame(scheduleRecords, game) {
  const awayNames = new Set(
    [game.away, game.away_full].filter(Boolean).map((s) => s.toLowerCase()),
  );
  const homeNames = new Set(
    [game.home, game.home_full].filter(Boolean).map((s) => s.toLowerCase()),
  );

  let bestRecord = null;
  for (const r of scheduleRecords) {
    const rAway = (r.away_team || '').toLowerCase();
    const rHome = (r.home_team || '').toLowerCase();
    const awayMatch = awayNames.has(rAway);
    const homeMatch = homeNames.has(rHome);
    if (awayMatch && homeMatch) {
      return r;
    }
    if ((awayMatch || homeMatch) && !bestRecord) bestRecord = r;
  }
  return bestRecord;
}

function modelFreshnessFromMlbStatus(status) {
  const raw = String(status ?? '').trim().toLowerCase();
  if (!raw) return 'pregame';
  if (raw.includes('final')) return 'final';
  if (
    raw.includes('live')
    || raw.includes('in progress')
    || raw.includes('warmup')
    || raw.includes('delayed')
    || raw.includes('review')
    || raw.includes('suspended')
  ) {
    return 'live';
  }
  return 'pregame';
}

function lineupStatusForProjection(lineupStatus) {
  return lineupStatus === LINEUP_STATUS.BOTH_CONFIRMED ? 'confirmed' : 'unconfirmed';
}

/**
 * Derive lineup notes string and starters object from MLB schedule records
 * matched to a specific game (by team name fuzzy match).
 *
 * @param {Array}  scheduleRecords   - from mlb-official-readonly envelope
 * @param {object} game              - joined game object with .away / .home / .away_full / .home_full
 * @returns {{ lineupNotes: string, starters: { away: string|null, home: string|null } }}
 */
function deriveStartersForGame(scheduleRecords, game) {
  const bestRecord = findScheduleRecordForGame(scheduleRecords, game);

  if (!bestRecord) {
    return {
      lineupNotes: 'Lineup data not available for this game.',
      starters: { away: null, home: null },
    };
  }

  const pp = bestRecord.probable_pitchers || {};
  const awayPitcher = pp.away || null;
  const homePitcher = pp.home || null;

  const awayLabel = awayPitcher ? `${awayPitcher} confirmed` : 'TBD';
  const homeLabel = homePitcher ? `${homePitcher} confirmed` : 'TBD';
  const lineupNotes = `Away pitcher: ${awayLabel} / Home pitcher: ${homeLabel}`;

  return {
    lineupNotes,
    starters: { away: awayPitcher, home: homePitcher },
  };
}

function deriveModelFreshnessForGame(scheduleRecords, game) {
  const bestRecord = findScheduleRecordForGame(scheduleRecords, game);
  return modelFreshnessFromMlbStatus(bestRecord?.mlb_status ?? null);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log([
      'Usage: node scripts/mlb/generate-lineup-packets.mjs [options]',
      '',
      'Options:',
      '  --date YYYY-MM-DD       Target date (default: today UTC)',
      '  --state-root <dir>      State directory root (default: state)',
      '  --block <LB01>          Target a specific block (skips due-window check)',
      '  --grace-minutes <n>     Grace period after hard cutoff in minutes (default: 5)',
      '  --lineup-status <s>     Override lineup status: both_confirmed|one_confirmed|pending',
      '  --dry-run               Use fixture data instead of live MLB Stats API',
      '  --no-refresh            Use cached series/game data (skip Kalshi discovery)',
      '  --help                  Show this message',
    ].join('\n'));
    return;
  }

  const { date, stateRoot, graceMinutes, dryRun, noRefresh } = opts;
  const graceMs = graceMinutes * 60_000;
  const nowMs = Date.now();

  // 1. Load schedule.
  const { path: schedulePath, schedule } = loadSchedule(stateRoot, date);
  const allBlocks = schedule.blocks || [];

  if (allBlocks.length === 0) {
    console.log(`[mlb-packets] date=${date} — no blocks in schedule. Nothing to do.`);
    return;
  }

  // 2. Find due blocks.
  let dueBlocks;
  if (opts.block) {
    // Explicit block target — skip due-window check.
    const targeted = allBlocks.find((b) => b.block_id === opts.block);
    if (!targeted) {
      const ids = allBlocks.map((b) => b.block_id).join(', ');
      throw new Error(`Block ${opts.block} not found in schedule. Available: ${ids}`);
    }
    dueBlocks = [targeted];
  } else {
    dueBlocks = findDueBlocks(allBlocks, nowMs, graceMs);
  }

  const totalDue = dueBlocks.length;
  let rendered = 0;
  let skipped = 0;
  const summaryLines = [];

  if (totalDue === 0) {
    console.log(`[mlb-packets] date=${date} due=0 rendered=0 skipped=0`);
    console.log('[mlb-packets] No trades placed. No Telegram send.');
    return;
  }

  // 3. Fetch game data once for the whole run (unless --no-refresh).
  let allGames = [];
  if (!noRefresh) {
    try {
      const series = await discoverAllSeries(date);
      allGames = joinGames(series);
    } catch (err) {
      console.error(`[mlb-packets] warn: series discovery failed — ${err.message}`);
      // Continue; per-block handling will skip gracefully.
    }
  }

  // 4. Load renderer (will throw with a clear message if missing).
  const renderer = await getPacketRenderer();
  const { renderPerGamePacket, renderBlockPacket, renderCompactSlate } = renderer;

  const statsRecords = loadStatsRecords(stateRoot, date);
  const leagueRPG = leagueRunsPerGame(statsRecords);
  const projectionsFor = (game, lineupStatus) => {
    const record = matchStatsRecord(statsRecords, {
      eventTicker: game.series?.ml?.event_ticker ?? '',
      awayName: game.away_full ?? game.away ?? '',
      homeName: game.home_full ?? game.home ?? '',
    });
    if (!record) return null;
    return buildGameProjections({
      record,
      leagueRPG,
      as_of: `${date}T00:00:00Z`,
      lineup_status: lineupStatusForProjection(lineupStatus),
      weather_status: game.weather_status ?? null,
    });
  };

  // 5. Process each due block.
  for (const block of dueBlocks) {
    const blockId = block.block_id;

    // 5a. Determine lineup status.
    let lineupStatus;
    if (opts.lineupStatusOverride) {
      lineupStatus = opts.lineupStatusOverride;
    } else {
      lineupStatus = await fetchLineupStatus(block, date, stateRoot, { dryRun });
    }

    // 5b. Hard cutoff enforcement: if past cutoff and still PENDING, force FULL downgrade.
    const hardCutoffMs = Date.parse(block.hard_cutoff_utc);
    const pastCutoff = nowMs >= hardCutoffMs;
    if (pastCutoff && lineupStatus === LINEUP_STATUS.PENDING && !opts.lineupStatusOverride) {
      console.log(
        `[mlb-packets] ${blockId}: hard cutoff reached at ${block.hard_cutoff_utc} — proceeding with FULL downgrade (no lineups).`,
      );
    }

    const downgrade = resolveDowngrade(lineupStatus);

    // 5c. Filter game data to this block.
    const blockGameKeys = new Set(block.game_keys || []);
    const blockGames = allGames.filter((g) => blockGameKeys.has(g.game_key));

    if (blockGames.length === 0) {
      console.error(
        `[mlb-packets] ${blockId}: no games resolved for game_keys=[${[...blockGameKeys].join(', ')}] — skipping.`,
      );
      skipped += 1;
      continue;
    }

    // 5d. Fetch schedule records once per block for lineup notes.
    let scheduleRecords = [];
    try {
      const outputDir = resolve(stateRoot, 'mlb', date);
      const envelope = await fetchMlbScheduleReadonly({
        runDate: date,
        outputDir,
        fixturesOnly: Boolean(dryRun),
      });
      scheduleRecords = (envelope && Array.isArray(envelope.records)) ? envelope.records : [];
    } catch (_err) {
      // Non-fatal — lineup notes will be generic.
    }

    // 5e. Generate per-game packets.
    const perGamePackets = [];
    for (const game of blockGames) {
      const { lineupNotes, starters } = deriveStartersForGame(scheduleRecords, game);
      const modelFreshness = deriveModelFreshnessForGame(scheduleRecords, game);
      const projections = projectionsFor(game, lineupStatus);
      let packet;
      try {
        packet = await renderPerGamePacket(game, {
          lineupStatus,
          lineupNotes,
          starters,
          venueWeather: null,
          projections,
          modelFreshness,
        });
      } catch (err) {
        console.error(`[mlb-packets] ${blockId}: renderPerGamePacket failed for ${game.game_key} — ${err.message}`);
        skipped += 1;
        packet = null;
      }
      if (packet) perGamePackets.push(packet);
    }

    if (perGamePackets.length === 0) {
      console.error(`[mlb-packets] ${blockId}: all per-game renders failed — skipping block.`);
      skipped += 1;
      continue;
    }

    // 5f. Generate block packet.
    let blockPacket;
    try {
      blockPacket = await renderBlockPacket(block, perGamePackets);
    } catch (err) {
      console.error(`[mlb-packets] ${blockId}: renderBlockPacket failed — ${err.message}`);
      skipped += 1;
      continue;
    }

    // 5g. Write artifacts.
    const outDir = resolve(stateRoot, 'mlb', date, 'packets', blockId);
    mkdirSync(outDir, { recursive: true });

    const base = `${date}-${blockId}`;

    // Per-game packets.
    for (let i = 0; i < perGamePackets.length; i++) {
      const p = perGamePackets[i];
      const gameKey = blockGames[i]?.game_key ?? `game${i}`;
      const gameTxtPath = resolve(outDir, `${base}-${gameKey}.txt`);
      writeFileSync(gameTxtPath, p.text || '', 'utf8');
    }

    // Block packet (full).
    const blockTxtPath = resolve(outDir, `${base}-block.txt`);
    writeFileSync(blockTxtPath, packetTextPayload(blockPacket), 'utf8');

    // Compact artifact — single Telegram message, picks + 2-sentence why.
    const compactText = renderCompactSlate ? renderCompactSlate(block, perGamePackets) : null;
    const compactTxtPath = compactText ? resolve(outDir, `${base}-compact.txt`) : null;
    if (compactText && compactTxtPath) {
      writeFileSync(compactTxtPath, compactText, 'utf8');
    }

    // Meta.
    const metaPath = resolve(outDir, `${base}.meta.json`);
    const meta = buildPacketMeta({
      date,
      blockId,
      lineupStatus,
      downgrade,
      games: blockGames,
      perGamePackets,
      blockTxtPath,
      dryRun,
    });
    writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');

    // 5h. Update block status in schedule (mutate in place, then atomic write).
    for (const b of allBlocks) {
      if (b.block_id === blockId) {
        b.packet_status = 'rendered';
        b.lineup_status = lineupStatus;
        b.last_rendered_utc = new Date().toISOString();
        b.last_artifact = blockTxtPath;
        if (compactTxtPath) b.compact_artifact = compactTxtPath;
      }
    }
    saveScheduleAtomic(schedulePath, schedule);

    rendered += 1;
    const charCount = meta.char_count;
    summaryLines.push({ blockId, lineupStatus, downgrade, gameCount: blockGames.length, charCount, blockTxtPath });
  }

  // 6. Print summary.
  console.log(`[mlb-packets] date=${date} due=${totalDue} rendered=${rendered} skipped=${skipped}`);
  for (const s of summaryLines) {
    console.log(
      `[mlb-packets] ${s.blockId}: lineup=${s.lineupStatus} downgrade=${s.downgrade} games=${s.gameCount} chars=${s.charCount}`,
    );
    console.log(`[mlb-packets] ${s.blockId} block_packet=${s.blockTxtPath}`);
  }
  console.log('[mlb-packets] No trades placed. No Telegram send.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`[mlb-packets] error: ${err.message}`);
    process.exit(1);
  });
}
