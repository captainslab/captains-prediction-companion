#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchMlbScheduleReadonly } from '../source-adapters/mlb-official-readonly.mjs';
import { fetchSportsbookReadonly } from '../source-adapters/sportsbook-readonly.mjs';
import { buildWikipediaGameSourceRecord } from '../source-adapters/wikipedia-historical-readonly.mjs';

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

function sportsbookCoverage(record) {
  const hasMoneyline = record?.away_moneyline != null && record?.home_moneyline != null;
  const hasNoVigMoneyline = hasNumber(record?.away_no_vig_fair) && hasNumber(record?.home_no_vig_fair);
  const hasTotalLine = hasNumber(record?.over_under);
  const hasTwoSidedTotal = record?.total_over_odds != null && record?.total_under_odds != null;
  return {
    moneyline_two_sided: hasMoneyline,
    moneyline_no_vig: hasNoVigMoneyline,
    game_total_line: hasTotalLine,
    game_total_two_sided: hasTotalLine && hasTwoSidedTotal,
  };
}

export function matchHistoricalEvents(mlbRecords = [], sportsbookRecords = []) {
  const sportsbookByKey = new Map();
  for (const record of sportsbookRecords) {
    const key = gameKey(record);
    if (!key.includes('|') || key === '|') continue;
    if (!sportsbookByKey.has(key)) sportsbookByKey.set(key, []);
    sportsbookByKey.get(key).push(record);
  }

  return mlbRecords.map(game => {
    const matches = sportsbookByKey.get(gameKey(game)) ?? [];
    const market = matches.length === 1 ? matches[0] : null;
    const wikipedia = buildWikipediaGameSourceRecord(game);
    return {
      game_pk: game.game_pk ?? null,
      game_date: game.game_date ?? null,
      start_time_utc: game.start_time_utc ?? null,
      away_team: game.away_team ?? null,
      home_team: game.home_team ?? null,
      mlb_status: game.mlb_status ?? null,
      mapping_status: matches.length === 1 ? 'MATCHED' : (matches.length === 0 ? 'NO_SPORTSBOOK_MATCH' : 'AMBIGUOUS_SPORTSBOOK_MATCH'),
      sportsbook_match_count: matches.length,
      provider: market?.provider ?? null,
      details: market?.details ?? null,
      ...(market ? sportsbookCoverage(market) : {
        moneyline_two_sided: false,
        moneyline_no_vig: false,
        game_total_line: false,
        game_total_two_sided: false,
      }),
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
  const totalLine = count(row => row.game_total_line);
  const totalTwoSided = count(row => row.game_total_two_sided);
  const providers = {};
  for (const row of rows) {
    if (!row.provider) continue;
    providers[row.provider] = (providers[row.provider] ?? 0) + 1;
  }
  return {
    games: total,
    mapped_games: mapped,
    mapped_pct: pct(mapped, total),
    moneyline_two_sided_games: moneyline,
    moneyline_two_sided_pct: pct(moneyline, total),
    moneyline_no_vig_games: moneylineNoVig,
    moneyline_no_vig_pct: pct(moneylineNoVig, total),
    game_total_line_games: totalLine,
    game_total_line_pct: pct(totalLine, total),
    game_total_two_sided_games: totalTwoSided,
    game_total_two_sided_pct: pct(totalTwoSided, total),
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

export async function auditDate({ runDate, fetchImpl = globalThis.fetch, now = new Date() }) {
  const outputDir = `state/mlb/${runDate}/historical-audit`;
  const [mlbEnvelope, sportsbookEnvelope] = await Promise.all([
    fetchMlbScheduleReadonly({ runDate, outputDir, fixturesOnly: false, fetchImpl, now }),
    fetchSportsbookReadonly({ runDate, outputDir, fixturesOnly: false, fetchImpl, now }),
  ]);
  const rows = matchHistoricalEvents(mlbEnvelope.records ?? [], sportsbookEnvelope.records ?? []);
  return {
    run_date: runDate,
    mlb_status: mlbEnvelope.status,
    sportsbook_status: sportsbookEnvelope.status,
    mlb_errors: mlbEnvelope.errors ?? [],
    sportsbook_errors: sportsbookEnvelope.errors ?? [],
    mlb_source_urls: mlbEnvelope.source_urls ?? [],
    sportsbook_source_urls: sportsbookEnvelope.source_urls ?? [],
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
} = {}) {
  const dates = dateRangeInclusive(start, end);
  const daily = await mapLimit(dates, Number(concurrency) || 4, date => auditDate({ runDate: date, fetchImpl, now }));
  const rows = daily.flatMap(day => day.rows);
  const sourceFailures = daily.filter(day => day.mlb_status === 'blocked' || day.sportsbook_status === 'blocked');
  const report = {
    schema_version: 1,
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
      market_reference: 'ESPN public MLB scoreboard odds payload',
      wikipedia: 'Canonical team-season schedule/final-score cross-check URLs',
      paid_services: false,
    },
    coverage: summarizeCoverage(rows),
    source_failure_days: sourceFailures.map(day => ({
      run_date: day.run_date,
      mlb_status: day.mlb_status,
      sportsbook_status: day.sportsbook_status,
      mlb_errors: day.mlb_errors,
      sportsbook_errors: day.sportsbook_errors,
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
    '  node scripts/mlb/historical/free-source-audit.mjs --start 2024-03-20 --end 2024-09-29',
    '',
    'Options:',
    '  --partition B|C|BC       Frozen pre-D construction windows',
    `  --out PATH               Default: ${DEFAULT_OUT}`,
    '  --concurrency N          Concurrent date fetches; default 4',
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
      source_failure_days: report.source_failure_days.length,
    }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  }
}
