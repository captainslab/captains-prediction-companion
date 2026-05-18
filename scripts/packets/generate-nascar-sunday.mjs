#!/usr/bin/env node
// NASCAR Sunday packet generator. One packet per Kalshi NASCAR Cup race event.
// Filters to product_metadata.competition === 'NASCAR Cup Series' — drops
// Truck/Xfinity/Auto Parts events. Events are containers; markets are per-driver
// win contracts (and other lanes). No trades.

import { execFileSync } from 'node:child_process';
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
import {
  fetchKalshiEvents,
  filterByEventDate,
  filterNascarCupOnly,
  persistEventArtifacts,
  summarizeEvent,
  renderMarketBlocks,
  KALSHI_SOURCES,
} from './lib/kalshi-discovery.mjs';

const PACKET_TYPE = 'nascar-sunday';
const SUPPORTED_LANES = ['win', 'top3', 'top5', 'top10', 'top20', 'fastest_lap'];

function locateNascarArtifacts(stateRoot, date) {
  const root = resolve(stateRoot, 'nascar');
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
        if (e === date) {
          try {
            for (const f of readdirSync(p)) {
              const fp = join(p, f);
              if (statSync(fp).isFile() && (f.endsWith('.json') || f.endsWith('.md'))) hits.push(fp);
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

function tryRunWorkspaceFixturesOnly(date) {
  try {
    const out = execFileSync(
      process.execPath,
      ['scripts/nascar/nascar-workspace.mjs', '--date', date, '--fixtures-only'],
      { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 },
    );
    return { ok: true, output: out.toString('utf8').slice(0, 2000) };
  } catch (err) {
    return { ok: false, error: (err.stderr?.toString() || err.message || 'unknown').slice(0, 500) };
  }
}

function pickCeilingBoard(artifacts) {
  for (const fp of artifacts) {
    if (!fp.endsWith('.json')) continue;
    const data = readJsonIfExists(fp);
    if (!data) continue;
    const board = data.ceiling_board || data.ceilings || data.board || null;
    if (Array.isArray(board) && board.length) return { board, source: fp };
    if (board && typeof board === 'object') {
      const arr = Object.entries(board).map(([driver_name, ceiling]) => ({ driver_name, ceiling }));
      if (arr.length) return { board: arr, source: fp };
    }
  }
  return null;
}

function buildRacePacket({ date, event, sourcePath, artifacts, workspaceResult }) {
  const s = summarizeEvent(event);
  const block = renderMarketBlocks(event, { limit: 60 });
  const header = packetHeader({
    title: `Captain NASCAR — Sunday Morning Race Packet: ${s.title}`,
    date,
    packetType: PACKET_TYPE,
    sources: [sourcePath, KALSHI_SOURCES.nascar.page_url, ...artifacts],
  });
  const ceiling = pickCeilingBoard(artifacts);
  const lines = [];
  lines.push(`event_ticker: ${s.ticker}`);
  lines.push(`event_title: ${s.title}`);
  lines.push(`event_sub_title: ${s.sub_title || 'MISSING'}`);
  lines.push(`series_ticker: ${s.series}`);
  lines.push(`competition: ${event?.product_metadata?.competition || 'NASCAR Cup Series'}`);
  lines.push(`market_count: ${s.marketCount}`);
  lines.push(`close_time_utc: ${s.close}`);
  lines.push('');
  lines.push(`supported_market_lanes: ${SUPPORTED_LANES.join(', ')}`);
  lines.push('');
  lines.push('markets:');
  for (const l of block.lines) lines.push(l);
  lines.push('');
  lines.push('ceiling_board (format: [driver_name] [ceiling]):');
  if (ceiling && ceiling.board.length) {
    for (const row of ceiling.board) {
      lines.push(`  [${row.driver_name || 'MISSING'}] [${row.ceiling ?? 'MISSING'}]`);
    }
    lines.push(`  source: ${ceiling.source}`);
  } else {
    lines.push('  MISSING');
    if (workspaceResult) {
      lines.push(`  workspace_run_ok: ${workspaceResult.ok}`);
      if (!workspaceResult.ok) lines.push(`  workspace_error: ${workspaceResult.error}`);
    }
  }
  return {
    text: header + lines.join('\n') + packetFooter(),
    marketCount: block.marketCount,
    missingStrikeCount: block.missingStrikeCount,
    missingMarkets: block.missingMarkets,
  };
}

function buildEmptyPacket({ date, artifacts, workspaceResult, discovery, matchedCount }) {
  const header = packetHeader({
    title: 'Captain NASCAR — Sunday Morning Race-Market Packet',
    date,
    packetType: PACKET_TYPE,
    sources: [KALSHI_SOURCES.nascar.api_url, KALSHI_SOURCES.nascar.page_url, ...artifacts],
  });
  const lines = [];
  lines.push('kalshi_discovery:');
  lines.push(`  source_page: ${KALSHI_SOURCES.nascar.page_url}`);
  lines.push(`  source_api: ${KALSHI_SOURCES.nascar.api_url}`);
  lines.push(`  reachable: ${discovery.ok ? 'yes' : 'no'}`);
  lines.push(`  total_events: ${discovery.events.length}`);
  lines.push(`  cup_in_window_matched: ${matchedCount}`);
  if (discovery.error) lines.push(`  error: ${discovery.error}`);
  lines.push('');
  lines.push('status: MISSING');
  lines.push(`reason: no NASCAR Cup race derived event-date matches ${date} window and no local race artifacts present.`);
  if (workspaceResult) {
    lines.push(`workspace_run_ok: ${workspaceResult.ok}`);
    if (!workspaceResult.ok) lines.push(`workspace_error: ${workspaceResult.error}`);
  }
  return header + lines.join('\n') + packetFooter();
}

async function main() {
  const opts = parsePacketArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node scripts/packets/generate-nascar-sunday.mjs --date YYYY-MM-DD [--dry-run]');
    return;
  }
  const dir = ensurePacketDir(opts.stateRoot, opts.date, PACKET_TYPE);

  const discovery = await fetchKalshiEvents('nascar');
  const dateFilter = filterByEventDate(opts.date, { windowDays: 1, allowUndated: false });
  const cupEvents = discovery.events.filter(filterNascarCupOnly).filter(dateFilter);
  let persistedCount = 0;
  if (cupEvents.length) {
    const p = persistEventArtifacts({ stateRoot: opts.stateRoot, sport: 'nascar', date: opts.date, events: cupEvents });
    persistedCount = p.written.length;
  }

  let artifacts = locateNascarArtifacts(opts.stateRoot, opts.date);
  let workspaceResult = null;
  if (!artifacts.length) {
    workspaceResult = tryRunWorkspaceFixturesOnly(opts.date);
    artifacts = locateNascarArtifacts(opts.stateRoot, opts.date);
  }

  let totalMarketCount = 0;
  let missingMarketEventCount = 0;
  let missingStrikeTextCount = 0;
  const items = [];

  if (!cupEvents.length) {
    const txt = buildEmptyPacket({
      date: opts.date,
      artifacts,
      workspaceResult,
      discovery,
      matchedCount: 0,
    });
    const w = writeAudit(dir, `${opts.date}-nascar-sunday-MISSING`, txt, {
      event_count: 0,
      total_market_count: 0,
      missing_market_count: 0,
      missing_strike_text_count: 0,
      artifact_count: artifacts.length,
      workspace_attempt: workspaceResult,
      kalshi_discovery: { ok: discovery.ok, error: discovery.error, total: discovery.events.length, cup_matched: 0 },
    });
    items.push({ name: 'nascar-sunday-MISSING', ...w });
  } else {
    for (const ev of cupEvents) {
      const ticker = ev?.event_ticker;
      if (!ticker) continue;
      const sourcePath = resolve(opts.stateRoot, 'nascar', opts.date, 'kalshi-events', `${ticker.replace(/[^A-Z0-9_-]/gi, '_').slice(0, 80)}.json`);
      const built = buildRacePacket({ date: opts.date, event: ev, sourcePath, artifacts, workspaceResult });
      totalMarketCount += built.marketCount;
      if (built.missingMarkets) missingMarketEventCount += 1;
      missingStrikeTextCount += built.missingStrikeCount;
      const w = writeAudit(dir, `${opts.date}-${ticker}`, built.text, {
        event_ticker: ticker,
        market_count: built.marketCount,
        missing_markets: built.missingMarkets,
        missing_strike_text_count: built.missingStrikeCount,
        artifact_count: artifacts.length,
        workspace_attempt: workspaceResult,
        kalshi_source_api: KALSHI_SOURCES.nascar.api_url,
        kalshi_source_page: KALSHI_SOURCES.nascar.page_url,
      });
      items.push({ name: ticker, ...w });
    }
  }

  let exitCode = 0;
  if (cupEvents.length > 0 && totalMarketCount === 0) {
    console.error(`[${PACKET_TYPE}] FAIL: ${cupEvents.length} cup events but zero markets total.`);
    exitCode = 2;
  }

  console.log(printDryRunSummary({ packetType: PACKET_TYPE, date: opts.date, dir, items }));
  console.log(`[${PACKET_TYPE}] summary event_count=${cupEvents.length} total_market_count=${totalMarketCount} packets_written=${items.length} missing_market_count=${missingMarketEventCount} missing_strike_text_count=${missingStrikeTextCount} persisted=${persistedCount} artifacts=${artifacts.length} kalshi_total=${discovery.events.length}`);
  if (exitCode) process.exit(exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`[${PACKET_TYPE}] error: ${err.message}`);
    process.exit(1);
  });
}
