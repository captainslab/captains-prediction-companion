#!/usr/bin/env node
// Morning MLB slate-check.
// Pulls every relevant Kalshi MLB series for a target date, joins them by
// game key, joins official MLB start times, computes per-game T-60/T-55 windows, and writes
// state/mlb/<DATE>/slate-run-plan.json. No trades. No picks.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  MLB_SERIES,
  discoverAllSeries,
  joinGames,
  ctClockFromUtc,
} from './lib/series-discovery.mjs';
import { fetchMlbScheduleReadonly } from './source-adapters/mlb-official-readonly.mjs';
import { buildEventScheduleContract } from '../shared/event-schedule-contract.mjs';

function parseArgs(argv) {
  const opts = { date: null, stateRoot: 'state', prelockMinutes: 55, clusterWithin: 0 };
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

function teamKey(away, home) {
  return `${String(away ?? '').trim().toLowerCase()}|${String(home ?? '').trim().toLowerCase()}`;
}

function closestOfficialRecord(game, officialRecords, used = new Set()) {
  const candidates = (officialRecords || []).filter((record) =>
    !used.has(record) && teamKey(record.away_team, record.home_team) === teamKey(game.away_full, game.home_full));
  if (!candidates.length) return null;
  const gameStart = Date.parse(game.start_utc ?? '');
  return candidates.sort((a, b) => {
    const da = Math.abs(Date.parse(a.start_time_utc) - gameStart);
    const db = Math.abs(Date.parse(b.start_time_utc) - gameStart);
    return (Number.isFinite(da) ? da : Number.MAX_SAFE_INTEGER) - (Number.isFinite(db) ? db : Number.MAX_SAFE_INTEGER);
  })[0];
}

export function mergeOfficialGames(discoveredGames, officialRecords) {
  const games = [...discoveredGames];
  const used = new Set();
  for (const game of discoveredGames) {
    const official = closestOfficialRecord(game, officialRecords, used);
    if (official) used.add(official);
  }
  for (const record of officialRecords || []) {
    if (used.has(record)) continue;
    games.push({
      game_key: `MLB-${record.game_pk}`,
      away: null,
      home: null,
      away_full: record.away_team,
      home_full: record.home_team,
      start_utc: record.start_time_utc,
      start_ct: ctClockFromUtc(record.start_time_utc),
      series: {},
      official_only: true,
    });
    used.add(record);
  }
  return games.sort((a, b) => String(a.start_utc ?? '').localeCompare(String(b.start_utc ?? '')));
}

export function buildPerGameWindows(games, officialRecords, prelockMinutes = 55) {
  const used = new Set();
  return games.map((game, index) => {
    const official = closestOfficialRecord(game, officialRecords, used);
    if (official) used.add(official);
    const eventStartUtc = official?.start_time_utc ?? null;
    if (!eventStartUtc || !Number.isFinite(Date.parse(eventStartUtc))) return null;
    const dueUtc = new Date(Date.parse(eventStartUtc) - prelockMinutes * 60_000).toISOString();
    const schedule = buildEventScheduleContract({
      eventFamily: 'mlb',
      eventTicker: game.game_key,
      eventKey: game.game_key,
      eventStartUtc,
      authority: 'official_mlb_schedule',
      sourceUrl: 'https://statsapi.mlb.com/api/v1/schedule',
      retrievedAtUtc: official.checked_at_utc ?? null,
      status: 'pending',
      idempotencyKey: `mlb:${official.game_pk ?? game.game_key}:${dueUtc}`,
      rawStartField: eventStartUtc,
      prepareOffsetMinutes: 60,
      reportOffsetMinutes: prelockMinutes,
      sourceStatus: 'fresh',
      metadata: {
        game_pk: official.game_pk ?? null,
        game_keys: [game.game_key],
        lead_first_pitch_utc: eventStartUtc,
        lead_first_pitch_ct: game.start_ct,
      },
    });
    return {
      cluster_id: `G${String(index + 1).padStart(2, '0')}`,
      game_pk: official.game_pk ?? null,
      game_key: game.game_key,
      ...schedule,
      event_start_authority: schedule.authority,
      event_start_source_url: schedule.source_url,
      event_start_retrieved_utc: schedule.retrieved_at_utc,
      event_start_raw: schedule.raw_start_field,
      event_start_freshness: schedule.source_status,
      report_at_ct: null,
      retry_at_utc: [new Date(Date.parse(dueUtc) + 5 * 60_000).toISOString(), new Date(Date.parse(dueUtc) + 10 * 60_000).toISOString()],
      retry_index: 0,
      lead_first_pitch_utc: schedule.event_start_utc,
      lead_first_pitch_ct: game.start_ct,
    };
  }).filter(Boolean);
}

export async function buildSlatePlan({ date, prelockMinutes = 55, clusterWithin = 0, officialRecords = [] }) {
  const series = await discoverAllSeries(date);
  const games = mergeOfficialGames(joinGames(series), officialRecords);
  const reportWindows = buildPerGameWindows(games, officialRecords, prelockMinutes);
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
    cluster_count: reportWindows.length,
    games: games.map((g) => ({
      game_key: g.game_key,
      matchup: g.away_full && g.home_full
        ? `${g.away_full} at ${g.home_full}` : `${g.away ?? '?'} at ${g.home ?? '?'}`,
      away: g.away, home: g.home,
      away_full: g.away_full, home_full: g.home_full,
      first_pitch_utc: reportWindows.find((w) => w.game_key === g.game_key)?.lead_first_pitch_utc ?? null,
      first_pitch_ct: g.start_ct,
      market_coverage: coverage[g.game_key],
      series_events: Object.fromEntries(Object.entries(g.series).map(([k, v]) => [
        k, { event_ticker: v.event_ticker, market_count: v.market_count, priced: v.priced },
      ])),
    })),
    report_windows: reportWindows,
    notes: [
      'Slate check is observation-only. It does not force picks.',
      'Individual game packets run 55 minutes before each official first pitch.',
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
    console.log('Usage: node scripts/mlb/slate-check.mjs --date YYYY-MM-DD [--state-root state] [--prelock-minutes 55]');
    return;
  }
  const discoveryDir = resolve(opts.stateRoot, 'mlb', opts.date, 'discovery');
  const official = await fetchMlbScheduleReadonly({
    runDate: opts.date,
    outputDir: discoveryDir,
    fixturesOnly: false,
  });
  if (official.status !== 'ok' || !official.records.length) {
    throw new Error(`official MLB schedule unavailable: ${official.errors?.join('; ') || official.status}`);
  }
  mkdirSync(discoveryDir, { recursive: true });
  writeFileSync(resolve(discoveryDir, 'mlb_official_adapter.json'), JSON.stringify(official, null, 2));
  const plan = await buildSlatePlan({
    date: opts.date,
    prelockMinutes: opts.prelockMinutes,
    clusterWithin: opts.clusterWithin,
    officialRecords: official.records.map((record) => ({ ...record, checked_at_utc: official.checked_at_utc })),
  });
  const path = writePlan(opts.stateRoot, opts.date, plan);
  const cov = (sid) => plan.games.filter((g) => g.market_coverage[sid].status === 'OK').length;
  console.log(`[mlb-slate-check] date=${opts.date} games=${plan.game_count} windows=${plan.report_windows.length}`);
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
