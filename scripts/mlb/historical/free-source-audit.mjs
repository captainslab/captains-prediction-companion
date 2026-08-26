#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchMlbScheduleReadonly } from '../source-adapters/mlb-official-readonly.mjs';
import { buildWikipediaGameSourceRecord } from '../source-adapters/wikipedia-historical-readonly.mjs';
import {
  loadSbrPublicDataset,
  sbrRecordsForDate,
  SBR_PUBLIC_RELEASE_PAGE,
} from '../source-adapters/sbr-public-dataset-readonly.mjs';

const DEFAULT_OUT = 'artifacts/mlb-free-historical-source-audit.json';

function parseIsoDate(value, label) {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new TypeError(`${label} must be YYYY-MM-DD.`);
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new TypeError(`${label} is not a valid date: ${value}`);
  }
  return text;
}

function addDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function dateRangeInclusive(start, end) {
  const first = parseIsoDate(start, 'start');
  const last = parseIsoDate(end, 'end');
  if (first > last) throw new RangeError(`start ${first} is after end ${last}.`);
  const dates = [];
  for (let cursor = first; cursor <= last; cursor = addDays(cursor, 1)) dates.push(cursor);
  return dates;
}

function normalizeTeam(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\bthe\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function gameKey(game) {
  return `${normalizeTeam(game.away_team)}|${normalizeTeam(game.home_team)}`;
}

function hasNumber(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value));
}

function startMs(value) {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : null;
}

function sportsbookCoverage(record) {
  if (hasNumber(record?.moneyline_book_count) || hasNumber(record?.game_total_book_count)) {
    const mlBooks = Number(record?.moneyline_book_count) || 0;
    const totalBooks = Number(record?.game_total_book_count) || 0;
    return {
      moneyline_two_sided: Boolean(record?.moneyline_two_sided),
      moneyline_no_vig: Boolean(record?.moneyline_no_vig),
      game_total_line: Boolean(record?.game_total_line),
      game_total_two_sided: Boolean(record?.game_total_two_sided),
      moneyline_book_count: mlBooks,
      game_total_book_count: totalBooks,
    };
  }

  const hasMoneyline = record?.away_moneyline != null && record?.home_moneyline != null;
  const hasNoVigMoneyline = hasNumber(record?.away_no_vig_fair) && hasNumber(record?.home_no_vig_fair);
  const hasTotalLine = hasNumber(record?.over_under);
  const hasTwoSidedTotal = record?.total_over_odds != null && record?.total_under_odds != null;
  return {
    moneyline_two_sided: hasMoneyline,
    moneyline_no_vig: hasNoVigMoneyline,
    game_total_line: hasTotalLine,
    game_total_two_sided: hasTotalLine && hasTwoSidedTotal,
    moneyline_book_count: hasMoneyline ? 1 : 0,
    game_total_book_count: hasTotalLine && hasTwoSidedTotal ? 1 : 0,
  };
}

function assignMatches(mlbRecords, sportsbookRecords) {
  const mlbByKey = new Map();
  const bookByKey = new Map();
  for (const game of mlbRecords) {
    const key = gameKey(game);
    if (!mlbByKey.has(key)) mlbByKey.set(key, []);
    mlbByKey.get(key).push(game);
  }
  for (const record of sportsbookRecords) {
    const key = gameKey(record);
    if (!key.includes('|') || key === '|') continue;
    if (!bookByKey.has(key)) bookByKey.set(key, []);
    bookByKey.get(key).push(record);
  }

  const assignments = new Map();
  const matchCounts = new Map();
  for (const [key, games] of mlbByKey.entries()) {
    const markets = bookByKey.get(key) ?? [];
    for (const game of games) matchCounts.set(game, markets.length);
    if (games.length === 1 && markets.length === 1) {
      assignments.set(games[0], markets[0]);
      continue;
    }
    if (games.length > 1 && games.length === markets.length) {
      const sortedGames = [...games].sort((a, b) => (startMs(a.start_time_utc) ?? 0) - (startMs(b.start_time_utc) ?? 0));
      const sortedMarkets = [...markets].sort((a, b) => (startMs(a.start_time_utc) ?? 0) - (startMs(b.start_time_utc) ?? 0));
      const allTimed = sortedGames.every(game => startMs(game.start_time_utc) !== null)
        && sortedMarkets.every(market => startMs(market.start_time_utc) !== null);
      if (allTimed) {
        for (let i = 0; i < sortedGames.length; i += 1) assignments.set(sortedGames[i], sortedMarkets[i]);
      }
    }
  }
  return { assignments, matchCounts };
}

export function matchHistoricalEvents(mlbRecords = [], sportsbookRecords = []) {
  const { assignments, matchCounts } = assignMatches(mlbRecords, sportsbookRecords);
  return mlbRecords.map(game => {
    const market = assignments.get(game) ?? null;
    const count = matchCounts.get(game) ?? 0;
    const wikipedia = buildWikipediaGameSourceRecord(game);
    const coverage = market ? sportsbookCoverage(market) : {
      moneyline_two_sided: false,
      moneyline_no_vig: false,
      game_total_line: false,
      game_total_two_sided: false,
      moneyline_book_count: 0,
      game_total_book_count: 0,
    };
    return {
      game_pk: game.game_pk ?? null,
      game_date: game.game_date ?? null,
      start_time_utc: game.start_time_utc ?? null,
      away_team: game.away_team ?? null,
      home_team: game.home_team ?? null,
      mlb_status: game.mlb_status ?? null,
      mapping_status: market ? 'MATCHED' : (count === 0 ? 'NO_SPORTSBOOK_MATCH' : 'AMBIGUOUS_SPORTSBOOK_MATCH'),
      sportsbook_match_count: count,
      provider: market?.provider ?? null,
      providers: market?.providers ?? (market?.provider ? [market.provider] : []),
      details: market?.details ?? null,
      quote_semantics: market?.quote_semantics ?? null,
      ...coverage,
      wikipedia_source_url: wikipedia.canonical_url,
      wikipedia_source_key: wikipedia.source_key,
      historical_truth_note: 'Wikipedia team-season source is a schedule/final-score cross-check only; inning truth remains fail-closed.',
    };
  });
}

function pct(num, den) {
  return den > 0 ? Math.round((10000 * num) / den) / 100 : null;
}

export function summarizeCoverage(rows = []) {
  const total = rows.length;
  const count = predicate => rows.filter(predicate).length;
  const mapped = count(row => row.mapping_status === 'MATCHED');
  const moneyline = count(row => row.moneyline_two_sided);
  const moneylineNoVig = count(row => row.moneyline_no_vig);
  const moneyline3 = count(row => Number(row.moneyline_book_count) >= 3);
  const totalLine = count(row => row.game_total_line);
  const totalTwoSided = count(row => row.game_total_two_sided);
  const total3 = count(row => Number(row.game_total_book_count) >= 3);
  const providers = {};
  for (const row of rows) {
    for (const provider of row.providers ?? []) {
      if (!provider) continue;
      providers[provider] = (providers[provider] ?? 0) + 1;
    }
  }
  return {
    games: total,
    mapped_games: mapped,
    mapped_pct: pct(mapped, total),
    moneyline_two_sided_games: moneyline,
    moneyline_two_sided_pct: pct(moneyline, total),
    moneyline_no_vig_games: moneylineNoVig,
    moneyline_no_vig_pct: pct(moneylineNoVig, total),
    moneyline_3plus_books_games: moneyline3,
    moneyline_3plus_books_pct: pct(moneyline3, total),
    game_total_line_games: totalLine,
    game_total_line_pct: pct(totalLine, total),
    game_total_two_sided_games: totalTwoSided,
    game_total_two_sided_pct: pct(totalTwoSided, total),
    game_total_3plus_books_games: total3,
    game_total_3plus_books_pct: pct(total3, total),
    sportsbook_providers: providers,
  };
}

async function mapLimit(values, limit, fn) {
  const output = new Array(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, values.length || 1)) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      output[index] = await fn(values[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

export async function auditDate({ runDate, sportsbookRecords = [], fetchImpl = globalThis.fetch, now = new Date() }) {
  const outputDir = `state/mlb/${runDate}/historical-audit`;
  const mlbEnvelope = await fetchMlbScheduleReadonly({ runDate, outputDir, fixturesOnly: false, fetchImpl, now });
  const rows = matchHistoricalEvents(mlbEnvelope.records ?? [], sportsbookRecords);
  return {
    run_date: runDate,
    mlb_status: mlbEnvelope.status,
    sportsbook_status: sportsbookRecords.length ? 'ok' : 'degraded',
    mlb_errors: mlbEnvelope.errors ?? [],
    sportsbook_errors: [],
    mlb_source_urls: mlbEnvelope.source_urls ?? [],
    sportsbook_source_urls: [SBR_PUBLIC_RELEASE_PAGE],
    coverage: summarizeCoverage(rows),
    rows,
  };
}

export async function runHistoricalFreeSourceAudit({
  start,
  end,
  out = DEFAULT_OUT,
  concurrency = 4,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  datasetPath = process.env.MLB_SBR_DATASET_PATH || null,
  forceRefreshDataset = false,
} = {}) {
  const dates = dateRangeInclusive(start, end);
  const sbr = await loadSbrPublicDataset({
    datasetPath,
    fetchImpl,
    now,
    forceRefresh: forceRefreshDataset,
  });
  const daily = await mapLimit(dates, Number(concurrency) || 4, date => auditDate({
    runDate: date,
    sportsbookRecords: sbrRecordsForDate(sbr.dataset, date),
    fetchImpl,
    now,
  }));
  const rows = daily.flatMap(day => day.rows);
  const sourceFailures = daily.filter(day => day.mlb_status === 'blocked');
  const sportsbookMissingDays = daily.filter(day => day.sportsbook_status !== 'ok').map(day => day.run_date);
  const report = {
    schema_version: 2,
    generated_at_utc: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    scope: {
      start: dates[0],
      end: dates.at(-1),
      days: dates.length,
      policy: 'FREE_PUBLIC_ONLY',
    },
    purpose: 'Measure pre-D public historical MLB moneyline/game-total coverage without changing CPC model or publication thresholds.',
    source_policy: {
      mlb_schedule_truth: 'MLB Stats API',
      market_reference: 'ArnavSaraogi/mlb-odds-scraper public SportsBookReview release dataset',
      market_reference_release: SBR_PUBLIC_RELEASE_PAGE,
      market_reference_cache_path: sbr.cache_path,
      market_reference_sha256: sbr.content_sha256,
      market_reference_date_count: sbr.date_count,
      wikipedia: 'Canonical team-season schedule/final-score cross-check URLs',
      paid_services: false,
      espn_historical_odds_result: 'REJECTED_AS_PRIMARY_AFTER_2024_BC_AUDIT_RETURNED_ZERO_ODDS',
    },
    coverage: summarizeCoverage(rows),
    sportsbook_missing_days: sportsbookMissingDays,
    source_failure_days: sourceFailures.map(day => ({
      run_date: day.run_date,
      mlb_status: day.mlb_status,
      mlb_errors: day.mlb_errors,
    })),
    missing_market_families_not_claimed_by_this_audit: [
      'team_totals',
      'yrfi_nrfi',
      'pitcher_k',
      'batter_hit',
      'batter_rbi',
      'batter_hr',
    ],
    rows,
    daily: daily.map(({ rows: _rows, ...day }) => day),
  };

  const outputPath = resolve(out);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { outputPath, report };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--start') args.start = argv[++i];
    else if (token === '--end') args.end = argv[++i];
    else if (token === '--out') args.out = argv[++i];
    else if (token === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (token === '--dataset') args.datasetPath = argv[++i];
    else if (token === '--refresh-dataset') args.forceRefreshDataset = true;
    else if (token === '--partition') {
      const partition = String(argv[++i] ?? '').toUpperCase();
      if (partition === 'B') Object.assign(args, { start: '2024-03-20', end: '2024-06-30' });
      else if (partition === 'C') Object.assign(args, { start: '2024-07-01', end: '2024-09-29' });
      else if (partition === 'BC') Object.assign(args, { start: '2024-03-20', end: '2024-09-29' });
      else throw new TypeError('--partition must be B, C, or BC.');
    } else if (token === '--help' || token === '-h') args.help = true;
    else throw new TypeError(`Unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/mlb/historical/free-source-audit.mjs --partition BC',
    '  node scripts/mlb/historical/free-source-audit.mjs --partition BC --dataset /path/to/mlb_odds.json',
    '',
    'Options:',
    '  --partition B|C|BC       Frozen pre-D construction windows',
    `  --out PATH               Default: ${DEFAULT_OUT}`,
    '  --concurrency N          Concurrent MLB date fetches; default 4',
    '  --dataset PATH           Use an existing public SBR dataset JSON instead of downloading',
    '  --refresh-dataset        Re-download the public release asset into the CPC cache',
  ].join('\n');
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
      process.exit(0);
    }
    if (!args.start || !args.end) throw new TypeError('Provide --partition B|C|BC or both --start and --end.');
    const { outputPath, report } = await runHistoricalFreeSourceAudit(args);
    console.log(JSON.stringify({
      status: report.source_failure_days.length ? 'DEGRADED' : 'OK',
      output: outputPath,
      coverage: report.coverage,
      sportsbook_missing_days: report.sportsbook_missing_days.length,
      source_failure_days: report.source_failure_days.length,
      market_reference_sha256: report.source_policy.market_reference_sha256,
    }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  }
}
