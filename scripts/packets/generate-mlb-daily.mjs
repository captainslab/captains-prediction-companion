#!/usr/bin/env node
// MLB daily packet generator (pre-final-lineup research).
// One packet per Kalshi MLB game event (KXMLBGAME). No trades.
//
// Events = container (the game). Markets = the tradable contracts (per-team
// winner, totals, etc.). Each market is emitted as its own block under the
// event, with strike text sourced from market fields — never ticker fragments.

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
import {
  fetchKalshiEvents,
  filterByEventDate,
  persistEventArtifacts,
  summarizeEvent,
  renderMarketBlocks,
  normalizeMarket,
  KALSHI_SOURCES,
} from './lib/kalshi-discovery.mjs';
import { buildEventDisplay, buildMarketDisplay } from './lib/mlb-teams.mjs';

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

/**
 * Read MLB workflow slate_manifest.json files and normalize to a flat list of
 * { game_id, matchup, start_utc, away, home } records. Tolerates missing/bad
 * files. Used by tests and as a fallback when no Kalshi events are available.
 */
export function extractGames(paths = []) {
  const out = [];
  for (const p of paths) {
    if (!p || !existsSync(p)) continue;
    let raw;
    try { raw = readFileSync(p, 'utf8'); } catch { continue; }
    let json;
    try { json = JSON.parse(raw); } catch { continue; }
    const games = Array.isArray(json?.games) ? json.games : [];
    for (const g of games) {
      if (!g) continue;
      out.push({
        game_id: g.game_pk ?? g.game_id ?? null,
        matchup: g.game || g.matchup
          || (g.teams ? `${g.teams.away ?? '?'} at ${g.teams.home ?? '?'}` : 'MISSING'),
        start_utc: g.start_time_utc || g.start_utc || null,
        away: g.teams?.away ?? g.away ?? null,
        home: g.teams?.home ?? g.home ?? null,
      });
    }
  }
  return out;
}

function buildKalshiGamePacket({ date, event, artifacts, primeAttempts, kalshiSummary, sourcePath }) {
  const s = summarizeEvent(event);
  const block = renderMarketBlocks(event, { limit: 40 });
  const header = packetHeader({
    title: 'Captain MLB — Daily Pre-Final-Lineup Packet',
    date,
    packetType: PACKET_TYPE,
    sources: [sourcePath, KALSHI_SOURCES.mlb.page_url, ...artifacts],
  });
  const lines = [];
  lines.push('research_prime:');
  if (primeAttempts.length) {
    for (const attempt of primeAttempts) {
      lines.push(`  - command: ${attempt.label}`);
      lines.push(`    status: ${attempt.ok ? 'ok' : 'MISSING'}`);
      if (!attempt.ok) lines.push(`    error: ${attempt.error || attempt.stderr || 'command failed'}`);
    }
  } else {
    lines.push('  - MISSING: no discovery command attempted');
  }
  lines.push('');
  if (kalshiSummary) {
    lines.push('kalshi_discovery:');
    lines.push(`  source_page: ${KALSHI_SOURCES.mlb.page_url}`);
    lines.push(`  source_api: ${KALSHI_SOURCES.mlb.api_url}`);
    lines.push(`  reachable: ${kalshiSummary.ok ? 'yes' : 'no'}`);
    lines.push(`  total_events: ${kalshiSummary.total}`);
    lines.push(`  window_matched: ${kalshiSummary.matched}`);
    if (kalshiSummary.error) lines.push(`  error: ${kalshiSummary.error}`);
    lines.push('');
  }
  lines.push(`event_ticker: ${s.ticker}`);
  lines.push(`event_title: ${s.title}`);
  lines.push(`event_sub_title: ${s.sub_title || 'MISSING'}`);
  const evDisp = buildEventDisplay(event);
  lines.push(`display_event_title: ${evDisp.display_event_title}`);
  lines.push(`display_name_status: ${evDisp.display_name_status}`);
  lines.push(`series_ticker: ${s.series}`);
  lines.push(`market_count: ${s.marketCount}`);
  lines.push(`close_time_utc: ${s.close}`);
  lines.push('');
  lines.push('markets:');
  for (const l of block.lines) lines.push(l);
  // Per-market display enrichment block, separate from raw market dump so the
  // raw Kalshi text emitted above is preserved verbatim for audit.
  const rawMarkets = Array.isArray(event?.markets) ? event.markets : [];
  if (rawMarkets.length) {
    lines.push('');
    lines.push('market_display:');
    for (const raw of rawMarkets) {
      const m = normalizeMarket(raw);
      const md = buildMarketDisplay(m, evDisp);
      lines.push(`  - market_ticker: ${m.ticker || 'MISSING'}`);
      lines.push(`    display_market_title: ${md.display_market_title}`);
      lines.push(`    display_yes_label: ${md.display_yes_label}`);
      lines.push(`    display_no_label: ${md.display_no_label}`);
      lines.push(`    display_name_status: ${md.display_name_status}`);
    }
  }
  lines.push('');
  lines.push('pre_final_caveats:');
  lines.push('  - lineups not finalized; pitching can scratch');
  lines.push('  - totals/ML board reflects pre-lineup snapshot only');
  lines.push('  - weather snapshots may drift before first pitch');
  return {
    text: header + lines.join('\n') + packetFooter(),
    marketCount: block.marketCount,
    missingStrikeCount: block.missingStrikeCount,
    missingMarkets: block.missingMarkets,
  };
}

function buildEmptyPacket({ date, artifacts, primeAttempts, kalshiSummary }) {
  const header = packetHeader({
    title: 'Captain MLB — Daily Pre-Final-Lineup Packet',
    date,
    packetType: PACKET_TYPE,
    sources: [KALSHI_SOURCES.mlb.api_url, KALSHI_SOURCES.mlb.page_url, ...artifacts],
  });
  const lines = [];
  lines.push('research_prime:');
  if (primeAttempts.length) {
    for (const attempt of primeAttempts) {
      lines.push(`  - command: ${attempt.label}`);
      lines.push(`    status: ${attempt.ok ? 'ok' : 'MISSING'}`);
      if (!attempt.ok) lines.push(`    error: ${attempt.error || attempt.stderr || 'command failed'}`);
    }
  } else {
    lines.push('  - MISSING: no discovery command attempted');
  }
  lines.push('');
  if (kalshiSummary) {
    lines.push('kalshi_discovery:');
    lines.push(`  source_page: ${KALSHI_SOURCES.mlb.page_url}`);
    lines.push(`  source_api: ${KALSHI_SOURCES.mlb.api_url}`);
    lines.push(`  reachable: ${kalshiSummary.ok ? 'yes' : 'no'}`);
    lines.push(`  total_events: ${kalshiSummary.total}`);
    lines.push(`  window_matched: ${kalshiSummary.matched}`);
    if (kalshiSummary.error) lines.push(`  error: ${kalshiSummary.error}`);
    lines.push('');
  }
  lines.push('status: MISSING');
  lines.push(`reason: no Kalshi MLB events with derived event-date ${date}.`);
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
  const artifacts = locateMlbArtifacts(opts.stateRoot, opts.date);

  const discovery = await fetchKalshiEvents('mlb');
  const dateFilter = filterByEventDate(opts.date, { windowDays: 0, allowUndated: false });
  const kalshiEvents = discovery.events.filter(dateFilter);

  let persistedCount = 0;
  if (kalshiEvents.length) {
    const p = persistEventArtifacts({ stateRoot: opts.stateRoot, sport: 'mlb', date: opts.date, events: kalshiEvents });
    persistedCount = p.written.length;
  }

  const kalshiSummary = {
    ok: discovery.ok,
    total: discovery.events.length,
    matched: kalshiEvents.length,
    error: discovery.error,
  };

  let totalMarketCount = 0;
  let missingMarketEventCount = 0;
  let missingStrikeTextCount = 0;
  const items = [];
  const primeMeta = primeAttempts.map(({ label, ok, status, stderr, error }) => ({ label, ok, status, stderr, error }));

  if (!kalshiEvents.length) {
    const txt = buildEmptyPacket({ date: opts.date, artifacts, primeAttempts, kalshiSummary });
    const w = writeAudit(dir, `${opts.date}-mlb-daily-MISSING`, txt, {
      event_count: 0,
      total_market_count: 0,
      missing_market_count: 0,
      missing_strike_text_count: 0,
      artifact_count: artifacts.length,
      kalshi_discovery: kalshiSummary,
      research_prime: primeMeta,
    });
    items.push({ name: 'mlb-daily-MISSING', ...w });
  } else {
    for (const ev of kalshiEvents) {
      const ticker = ev?.event_ticker;
      if (!ticker) continue;
      const sourcePath = resolve(opts.stateRoot, 'mlb', opts.date, 'kalshi-events', `${ticker.replace(/[^A-Z0-9_-]/gi, '_').slice(0, 80)}.json`);
      const built = buildKalshiGamePacket({ date: opts.date, event: ev, artifacts, primeAttempts, kalshiSummary, sourcePath });
      totalMarketCount += built.marketCount;
      if (built.missingMarkets) missingMarketEventCount += 1;
      missingStrikeTextCount += built.missingStrikeCount;
      const w = writeAudit(dir, `${opts.date}-${ticker}`, built.text, {
        event_ticker: ticker,
        market_count: built.marketCount,
        missing_markets: built.missingMarkets,
        missing_strike_text_count: built.missingStrikeCount,
        artifact_count: artifacts.length,
        kalshi_discovery: kalshiSummary,
        research_prime: primeMeta,
      });
      items.push({ name: ticker, ...w });
    }
  }

  let exitCode = 0;
  if (kalshiEvents.length > 0 && totalMarketCount === 0) {
    console.error(`[${PACKET_TYPE}] FAIL: ${kalshiEvents.length} events but zero markets total.`);
    exitCode = 2;
  }

  console.log(printDryRunSummary({ packetType: PACKET_TYPE, date: opts.date, dir, items }));
  console.log(`[${PACKET_TYPE}] summary event_count=${kalshiEvents.length} total_market_count=${totalMarketCount} packets_written=${items.length} missing_market_count=${missingMarketEventCount} missing_strike_text_count=${missingStrikeTextCount} persisted=${persistedCount} local_artifacts=${artifacts.length}`);
  if (exitCode) process.exit(exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`[${PACKET_TYPE}] error: ${err.message}`);
    process.exit(1);
  });
}
