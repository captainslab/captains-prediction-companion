#!/usr/bin/env node
// Morning MLB slate-check.
// Pulls every relevant Kalshi MLB series for a target date, joins them by
// game key, computes 60-min pre-lock report windows, and writes
// state/mlb/<DATE>/slate-run-plan.json. No trades. No picks.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  MLB_SERIES,
  discoverAllSeries,
  joinGames,
  clusterWindows,
} from './lib/series-discovery.mjs';

function parseArgs(argv) {
  const opts = { date: null, stateRoot: 'state', prelockMinutes: 60, clusterWithin: 10 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--date') opts.date = argv[++i];
    else if (a === '--state-root') opts.stateRoot = argv[++i];
    else if (a === '--prelock-minutes') opts.prelockMinutes = Number(argv[++i]);
    else if (a === '--cluster-within') opts.clusterWithin = Number(argv[++i]);
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!opts.date) opts.date = new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) throw new Error(`Bad --date: ${opts.date}`);
  return opts;
}

export function summarizeMarketCoverage(game) {
  const cov = {};
  for (const sid of Object.keys(MLB_SERIES)) {
    const s = game.series[sid];
    if (!s) {
      cov[sid] = { status: 'MISSING', reason: 'no event for this game in series' };
    } else if (!s.priced) {
      cov[sid] = {
        status: 'UNQUOTED',
        event_ticker: s.event_ticker,
        market_count: s.market_count,
      };
    } else {
      cov[sid] = {
        status: 'OK',
        event_ticker: s.event_ticker,
        market_count: s.market_count,
      };
    }
  }
  return cov;
}

export async function buildSlatePlan({ date, prelockMinutes, clusterWithin }) {
  const series = await discoverAllSeries(date);
  const games = joinGames(series);
  const clusters = clusterWindows(games, { prelockMinutes, withinMinutes: clusterWithin });
  const coverage = {};
  for (const g of games) coverage[g.game_key] = summarizeMarketCoverage(g);
  const seriesHealth = Object.fromEntries(Object.entries(series).map(([k, v]) => [
    k, { series: v.series, label: v.label, ok: v.ok, error: v.error,
        total: v.total, matched: v.matched },
  ]));
  return {
    schema: 'mlb-slate-run-plan/v1',
    date,
    generated_utc: new Date().toISOString(),
    prelock_minutes: prelockMinutes,
    cluster_within_minutes: clusterWithin,
    series_health: seriesHealth,
    game_count: games.length,
    cluster_count: clusters.length,
    games: games.map((g) => ({
      game_key: g.game_key,
      matchup: g.away_full && g.home_full
        ? `${g.away_full} at ${g.home_full}` : `${g.away ?? '?'} at ${g.home ?? '?'}`,
      away: g.away, home: g.home,
      away_full: g.away_full, home_full: g.home_full,
      first_pitch_utc: g.start_utc,
      first_pitch_ct: g.start_ct,
      market_coverage: coverage[g.game_key],
      series_events: Object.fromEntries(Object.entries(g.series).map(([k, v]) => [
        k, { event_ticker: v.event_ticker, market_count: v.market_count, priced: v.priced },
      ])),
    })),
    report_windows: clusters.map((c) => ({
      cluster_id: c.cluster_id,
      lead_first_pitch_utc: c.lead_utc,
      lead_first_pitch_ct: c.lead_ct,
      report_at_utc: c.report_at_utc,
      report_at_ct: c.report_at_ct,
      game_keys: c.game_keys,
      idempotency_key: `mlb:${date}:${c.cluster_id}:${c.report_at_utc}`,
      status: 'pending',
    })),
    notes: [
      'Slate check is observation-only. It does not force picks.',
      'Pre-lock reports run 60 minutes before each first-pitch cluster (default).',
      'Missing or unquoted markets are flagged but do not block the slate.',
    ],
  };
}

export function writePlan(stateRoot, date, plan) {
  const dir = resolve(stateRoot, 'mlb', date);
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, 'slate-run-plan.json');
  writeFileSync(path, JSON.stringify(plan, null, 2), 'utf8');
  return path;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node scripts/mlb/slate-check.mjs --date YYYY-MM-DD [--state-root state] [--prelock-minutes 60] [--cluster-within 10]');
    return;
  }
  const plan = await buildSlatePlan({
    date: opts.date,
    prelockMinutes: opts.prelockMinutes,
    clusterWithin: opts.clusterWithin,
  });
  const path = writePlan(opts.stateRoot, opts.date, plan);
  const cov = (sid) => plan.games.filter((g) => g.market_coverage[sid].status === 'OK').length;
  console.log(`[mlb-slate-check] date=${opts.date} games=${plan.game_count} clusters=${plan.cluster_count}`);
  console.log(`[mlb-slate-check] coverage_ok ml=${cov('ml')} spread=${cov('spread')} total=${cov('total')} hr=${cov('hr')} ks=${cov('ks')} rfi=${cov('rfi')}`);
  for (const sid of Object.keys(MLB_SERIES)) {
    const sh = plan.series_health[sid];
    if (!sh.ok) console.log(`[mlb-slate-check] WARN series=${sh.series} unreachable error=${sh.error}`);
  }
  console.log(`[mlb-slate-check] plan_written=${path}`);
  console.log('[mlb-slate-check] No trades placed. No picks forced.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`[mlb-slate-check] error: ${err.message}`);
    process.exit(1);
  });
}
