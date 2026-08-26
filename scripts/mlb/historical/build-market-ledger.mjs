#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { fetchMlbScheduleReadonly } from '../source-adapters/mlb-official-readonly.mjs';
import {
  americanToProbability,
  loadSbrPublicDataset,
  sbrRecordsForDate,
  SBR_PUBLIC_RELEASE_PAGE,
} from '../source-adapters/sbr-public-dataset-readonly.mjs';

const DEFAULT_OUT = 'artifacts/mlb-historical-market-ledger.json';
const DEFAULT_JSONL_OUT = 'artifacts/mlb-historical-market-ledger.jsonl';
export const MIN_BOOKS = 3;
export const MAX_SELECTED_SIDE_LOGIT_RANGE = 0.20;

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round6(value) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? null
    : Math.round(value * 1e6) / 1e6;
}

function median(values) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

function logit(p) {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return null;
  return Math.log(p / (1 - p));
}

function normalizePair(a, b) {
  const sum = a + b;
  if (!(sum > 0)) return null;
  return { a: a / sum, b: b / sum };
}

export function multiplicativeDevig(oddsA, oddsB) {
  const qa = americanToProbability(oddsA);
  const qb = americanToProbability(oddsB);
  if (qa === null || qb === null) return null;
  const pair = normalizePair(qa, qb);
  if (!pair) return null;
  return { a: round6(pair.a), b: round6(pair.b) };
}

export function powerDevig(oddsA, oddsB) {
  const qa = americanToProbability(oddsA);
  const qb = americanToProbability(oddsB);
  if (qa === null || qb === null || qa <= 0 || qb <= 0 || qa >= 1 || qb >= 1) return null;

  const f = k => qa ** k + qb ** k - 1;
  let lo = 0.01;
  let hi = 20;
  if (!(f(lo) > 0) || !(f(hi) < 0)) return null;
  for (let i = 0; i < 100; i += 1) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  const k = (lo + hi) / 2;
  const pair = normalizePair(qa ** k, qb ** k);
  if (!pair) return null;
  return { a: round6(pair.a), b: round6(pair.b), k: round6(k) };
}

function shinProbability(q, total, z) {
  const oneMinusZ = 1 - z;
  if (!(oneMinusZ > 0) || !(total > 0)) return null;
  const inside = z * z + (4 * oneMinusZ * q * q) / total;
  if (inside < 0) return null;
  return (Math.sqrt(inside) - z) / (2 * oneMinusZ);
}

export function shinDevig(oddsA, oddsB) {
  const qa = americanToProbability(oddsA);
  const qb = americanToProbability(oddsB);
  if (qa === null || qb === null || qa <= 0 || qb <= 0) return null;
  const total = qa + qb;
  if (!(total > 1)) return null;

  const f = z => {
    const pa = shinProbability(qa, total, z);
    const pb = shinProbability(qb, total, z);
    return pa === null || pb === null ? null : pa + pb - 1;
  };
  let lo = 0;
  let hi = 0.999999;
  const flo = f(lo);
  const fhi = f(hi);
  if (flo === null || fhi === null || flo < 0 || fhi > 0) return null;
  for (let i = 0; i < 100; i += 1) {
    const mid = (lo + hi) / 2;
    const fm = f(mid);
    if (fm === null) return null;
    if (fm > 0) lo = mid;
    else hi = mid;
  }
  const z = (lo + hi) / 2;
  const pa = shinProbability(qa, total, z);
  const pb = shinProbability(qb, total, z);
  const pair = pa === null || pb === null ? null : normalizePair(pa, pb);
  if (!pair) return null;
  return { a: round6(pair.a), b: round6(pair.b), z: round6(z) };
}

export function devigPair(oddsA, oddsB) {
  const multiplicative = multiplicativeDevig(oddsA, oddsB);
  const power = powerDevig(oddsA, oddsB);
  const shin = shinDevig(oddsA, oddsB);
  if (!multiplicative || !power || !shin) return null;
  return { multiplicative, power, shin };
}

function pairFields(kind, phase) {
  if (kind === 'moneyline') {
    return phase === 'opening'
      ? ['opening_away_odds', 'opening_home_odds']
      : ['closing_away_odds', 'closing_home_odds'];
  }
  return phase === 'opening'
    ? ['opening_over_odds', 'opening_under_odds']
    : ['closing_over_odds', 'closing_under_odds'];
}

function holdForOdds(aOdds, bOdds) {
  const qa = americanToProbability(aOdds);
  const qb = americanToProbability(bOdds);
  return qa === null || qb === null ? null : qa + qb - 1;
}

export function buildBinaryConsensus(quotes = [], {
  kind = 'moneyline',
  phase = 'closing',
  minBooks = MIN_BOOKS,
  maxMethodLogitRange = MAX_SELECTED_SIDE_LOGIT_RANGE,
} = {}) {
  const [aField, bField] = pairFields(kind, phase);
  const byMethod = {
    multiplicative: { a: [], b: [] },
    power: { a: [], b: [] },
    shin: { a: [], b: [] },
  };
  const holds = [];
  const books = [];

  for (const quote of quotes) {
    const aOdds = finite(quote?.[aField]);
    const bOdds = finite(quote?.[bField]);
    if (aOdds === null || bOdds === null) continue;
    const result = devigPair(aOdds, bOdds);
    if (!result) continue;
    const book = String(quote?.sportsbook ?? '').trim().toLowerCase() || 'unknown';
    books.push(book);
    const hold = holdForOdds(aOdds, bOdds);
    if (hold !== null) holds.push(hold);
    for (const method of Object.keys(byMethod)) {
      byMethod[method].a.push(result[method].a);
      byMethod[method].b.push(result[method].b);
    }
  }

  const methodMedians = {};
  for (const [method, sides] of Object.entries(byMethod)) {
    methodMedians[method] = {
      a: round6(median(sides.a)),
      b: round6(median(sides.b)),
    };
  }

  const sideSummary = side => {
    const methodValues = Object.values(methodMedians).map(row => row[side]).filter(Number.isFinite);
    const logits = methodValues.map(logit).filter(Number.isFinite);
    const methodLogitRange = logits.length === methodValues.length && logits.length
      ? Math.max(...logits) - Math.min(...logits)
      : null;
    const fair = median(methodValues);
    const robust = books.length >= minBooks
      && methodValues.length === 3
      && Number.isFinite(methodLogitRange)
      && methodLogitRange <= maxMethodLogitRange;
    return {
      fair_probability: round6(fair),
      method_medians: Object.fromEntries(Object.entries(methodMedians).map(([method, row]) => [method, row[side]])),
      selected_side_method_logit_range: round6(methodLogitRange),
      devig_robust: robust,
    };
  };

  return {
    book_count: books.length,
    books: [...new Set(books)].sort(),
    median_hold: round6(median(holds)),
    min_books_required: minBooks,
    max_selected_side_logit_range: maxMethodLogitRange,
    a: sideSummary('a'),
    b: sideSummary('b'),
  };
}

function normalizedTeam(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\bthe\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function gameKey(game) {
  return `${normalizedTeam(game.away_team)}|${normalizedTeam(game.home_team)}`;
}

function startMs(value) {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : null;
}

export function matchMlbGamesToSbr(mlbRecords = [], sbrRecords = []) {
  const gamesByKey = new Map();
  const marketsByKey = new Map();
  for (const game of mlbRecords) {
    const key = gameKey(game);
    if (!gamesByKey.has(key)) gamesByKey.set(key, []);
    gamesByKey.get(key).push(game);
  }
  for (const market of sbrRecords) {
    const key = gameKey(market);
    if (!marketsByKey.has(key)) marketsByKey.set(key, []);
    marketsByKey.get(key).push(market);
  }

  const matched = [];
  const excluded = [];
  for (const [key, games] of gamesByKey.entries()) {
    const markets = marketsByKey.get(key) ?? [];
    if (games.length === 1 && markets.length === 1) {
      matched.push({ game: games[0], market: markets[0] });
      continue;
    }
    if (games.length > 1 && games.length === markets.length) {
      const sortedGames = [...games].sort((a, b) => (startMs(a.start_time_utc) ?? 0) - (startMs(b.start_time_utc) ?? 0));
      const sortedMarkets = [...markets].sort((a, b) => (startMs(a.start_time_utc) ?? 0) - (startMs(b.start_time_utc) ?? 0));
      const timed = sortedGames.every(row => startMs(row.start_time_utc) !== null)
        && sortedMarkets.every(row => startMs(row.start_time_utc) !== null);
      if (timed) {
        for (let i = 0; i < sortedGames.length; i += 1) matched.push({ game: sortedGames[i], market: sortedMarkets[i] });
        continue;
      }
    }
    for (const game of games) {
      excluded.push({
        game_pk: game.game_pk ?? null,
        game_date: game.game_date ?? null,
        away_team: game.away_team ?? null,
        home_team: game.home_team ?? null,
        reason: markets.length ? 'AMBIGUOUS_SBR_MATCH' : 'NO_SBR_MATCH',
        sbr_match_count: markets.length,
      });
    }
  }
  return { matched, excluded };
}

function lineKey(value) {
  const n = finite(value);
  return n === null ? null : n.toFixed(3);
}

export function selectPrimaryTotalLine(totalQuotes = []) {
  const valid = totalQuotes.filter(quote => (
    finite(quote?.closing_total) !== null
    && finite(quote?.closing_over_odds) !== null
    && finite(quote?.closing_under_odds) !== null
  ));
  if (!valid.length) return null;
  const allLines = valid.map(quote => Number(quote.closing_total));
  const center = median(allLines);
  const groups = new Map();
  for (const quote of valid) {
    const key = lineKey(quote.closing_total);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(quote);
  }
  const ranked = [...groups.entries()].map(([key, quotes]) => ({
    line: Number(key),
    quotes,
    book_count: quotes.length,
  })).sort((a, b) => (
    b.book_count - a.book_count
    || Math.abs(a.line - center) - Math.abs(b.line - center)
    || a.line - b.line
  ));
  return ranked[0];
}

function partitionForDate(date) {
  if (date >= '2024-03-20' && date <= '2024-06-30') return 'B';
  if (date >= '2024-07-01' && date <= '2024-09-29') return 'C';
  return 'CUSTOM';
}

function baseRow(game, sbr, sourceSha) {
  return {
    schema_version: 1,
    game_pk: game.game_pk ?? null,
    game_date: game.game_date ?? null,
    partition: partitionForDate(game.game_date ?? ''),
    start_time_utc: game.start_time_utc ?? null,
    away_team: game.away_team ?? null,
    home_team: game.home_team ?? null,
    distribution_id: `game_runs_${game.game_pk ?? `${game.game_date}_${normalizedTeam(game.away_team)}_${normalizedTeam(game.home_team)}`}`,
    quote_clock: 'ARCHIVED_CLOSE',
    historical_source: 'SBR_PUBLIC_DATASET',
    historical_source_url: SBR_PUBLIC_RELEASE_PAGE,
    historical_source_sha256: sourceSha,
    quote_semantics: sbr.quote_semantics ?? null,
    paid_service_used: false,
    d_partition_touched: false,
  };
}

function devigStatus(summary) {
  if (!summary) return 'NO_TWO_SIDED_QUOTES';
  if (summary.book_count < MIN_BOOKS) return 'INSUFFICIENT_BOOKS';
  if (!summary.devig_robust) return 'DEVIG_SENSITIVE';
  return 'PASS';
}

function sideRow({ base, family, marketLine = null, side, selection, close, open, closeBookCount, openBookCount }) {
  const closeSide = close?.[side] ?? null;
  const openSide = open?.[side] ?? null;
  const closeStatus = devigStatus(closeSide ? { ...closeSide, book_count: closeBookCount } : null);
  const openingComparable = Boolean(openSide?.devig_robust && openBookCount >= MIN_BOOKS);
  return {
    ...base,
    family,
    market_line: marketLine,
    side,
    selection,
    close_book_count: closeBookCount,
    close_books: close?.books ?? [],
    close_median_hold: close?.median_hold ?? null,
    market_reference_prob: closeSide?.fair_probability ?? null,
    market_reference_methods: closeSide?.method_medians ?? null,
    selected_side_method_logit_range: closeSide?.selected_side_method_logit_range ?? null,
    max_selected_side_logit_range: MAX_SELECTED_SIDE_LOGIT_RANGE,
    min_books_required: MIN_BOOKS,
    devig_status: closeStatus,
    benchmark_eligible: closeStatus === 'PASS',
    opening_same_line_book_count: openBookCount,
    opening_same_line_reference_prob: openingComparable ? openSide?.fair_probability ?? null : null,
    opening_same_line_methods: openingComparable ? openSide?.method_medians ?? null : null,
    open_to_close_probability_move: openingComparable && Number.isFinite(closeSide?.fair_probability)
      ? round6(closeSide.fair_probability - openSide.fair_probability)
      : null,
    clv_capability: openingComparable ? 'OPEN_TO_CLOSE_SAME_LINE_REFERENCE_ONLY' : 'NO_COMPARABLE_OPENING_REFERENCE',
    true_t_minus_30_available: false,
  };
}

export function buildMarketLedgerRows({ game, sbr, sourceSha = 'test' }) {
  const base = baseRow(game, sbr, sourceSha);
  const rows = [];

  const closeMoneyline = buildBinaryConsensus(sbr.moneyline_quotes ?? [], { kind: 'moneyline', phase: 'closing' });
  const openMoneyline = buildBinaryConsensus(sbr.moneyline_quotes ?? [], { kind: 'moneyline', phase: 'opening' });
  rows.push(sideRow({
    base,
    family: 'winner',
    side: 'a',
    selection: game.away_team ?? sbr.away_team ?? 'away',
    close: closeMoneyline,
    open: openMoneyline,
    closeBookCount: closeMoneyline.book_count,
    openBookCount: openMoneyline.book_count,
  }));
  rows.at(-1).side = 'away';
  rows.push(sideRow({
    base,
    family: 'winner',
    side: 'b',
    selection: game.home_team ?? sbr.home_team ?? 'home',
    close: closeMoneyline,
    open: openMoneyline,
    closeBookCount: closeMoneyline.book_count,
    openBookCount: openMoneyline.book_count,
  }));
  rows.at(-1).side = 'home';

  const primary = selectPrimaryTotalLine(sbr.total_quotes ?? []);
  if (primary) {
    const closeTotal = buildBinaryConsensus(primary.quotes, { kind: 'total', phase: 'closing' });
    const openSameLineQuotes = (sbr.total_quotes ?? []).filter(quote => (
      lineKey(quote.opening_total) === lineKey(primary.line)
      && finite(quote.opening_over_odds) !== null
      && finite(quote.opening_under_odds) !== null
    ));
    const openTotal = buildBinaryConsensus(openSameLineQuotes, { kind: 'total', phase: 'opening' });
    rows.push(sideRow({
      base,
      family: 'game_total',
      marketLine: primary.line,
      side: 'a',
      selection: 'OVER',
      close: closeTotal,
      open: openTotal,
      closeBookCount: closeTotal.book_count,
      openBookCount: openTotal.book_count,
    }));
    rows.at(-1).side = 'over';
    rows.push(sideRow({
      base,
      family: 'game_total',
      marketLine: primary.line,
      side: 'b',
      selection: 'UNDER',
      close: closeTotal,
      open: openTotal,
      closeBookCount: closeTotal.book_count,
      openBookCount: openTotal.book_count,
    }));
    rows.at(-1).side = 'under';
  }

  return rows;
}

function dateRangeInclusive(start, end) {
  const dates = [];
  for (let d = new Date(`${start}T00:00:00Z`); d <= new Date(`${end}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

async function mapLimit(values, limit, fn) {
  const output = new Array(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(Number(limit) || 1, values.length || 1)) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      output[index] = await fn(values[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

export async function runHistoricalMarketLedger({
  start,
  end,
  out = DEFAULT_OUT,
  jsonlOut = DEFAULT_JSONL_OUT,
  concurrency = 4,
  datasetPath = process.env.MLB_SBR_DATASET_PATH || null,
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) {
  const dates = dateRangeInclusive(start, end);
  const sbr = await loadSbrPublicDataset({ datasetPath, fetchImpl, now });
  const days = await mapLimit(dates, concurrency, async runDate => {
    const mlb = await fetchMlbScheduleReadonly({
      runDate,
      outputDir: `state/mlb/${runDate}/historical-market-ledger`,
      fixturesOnly: false,
      fetchImpl,
      now,
    });
    const sourceRecords = sbrRecordsForDate(sbr.dataset, runDate);
    const { matched, excluded } = matchMlbGamesToSbr(mlb.records ?? [], sourceRecords);
    return {
      run_date: runDate,
      mlb_status: mlb.status,
      sbr_record_count: sourceRecords.length,
      matched,
      excluded,
    };
  });

  const rows = days.flatMap(day => day.matched.flatMap(({ game, market }) => buildMarketLedgerRows({
    game,
    sbr: market,
    sourceSha: sbr.content_sha256,
  })));
  const excludedGames = days.flatMap(day => day.excluded);
  const winnerRows = rows.filter(row => row.family === 'winner');
  const totalRows = rows.filter(row => row.family === 'game_total');
  const eligible = rows.filter(row => row.benchmark_eligible);
  const uniqueEligibleGames = new Set(eligible.map(row => row.game_pk).filter(v => v != null));
  const sourceFailureDays = days.filter(day => day.mlb_status === 'blocked').map(day => day.run_date);

  const report = {
    schema_version: 1,
    generated_at_utc: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    scope: { start: dates[0], end: dates.at(-1), policy: 'FREE_PUBLIC_ONLY' },
    frozen_rules: {
      minimum_books: MIN_BOOKS,
      devig_methods: ['multiplicative', 'power', 'shin'],
      selected_side_method_logit_range_max: MAX_SELECTED_SIDE_LOGIT_RANGE,
      total_line_selection: 'MOST_BOOKS_THEN_NEAREST_MEDIAN_THEN_LOWER_LINE',
      market_clock: 'ARCHIVED_CLOSE',
      true_t_minus_30_available: false,
      d_partition_touched: false,
    },
    source: {
      market_reference: 'ArnavSaraogi/mlb-odds-scraper public SportsBookReview release dataset',
      release_url: SBR_PUBLIC_RELEASE_PAGE,
      sha256: sbr.content_sha256,
      cache_path: sbr.cache_path,
      paid_services: false,
    },
    coverage: {
      matched_games: days.reduce((sum, day) => sum + day.matched.length, 0),
      excluded_games: excludedGames.length,
      ledger_rows: rows.length,
      winner_rows: winnerRows.length,
      game_total_rows: totalRows.length,
      benchmark_eligible_rows: eligible.length,
      benchmark_eligible_games: uniqueEligibleGames.size,
      source_failure_days: sourceFailureDays.length,
    },
    exclusions: excludedGames,
    rows,
  };

  const outputPath = resolve(out);
  const jsonlPath = resolve(jsonlOut);
  await mkdir(dirname(outputPath), { recursive: true });
  await mkdir(dirname(jsonlPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(jsonlPath, rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  return { outputPath, jsonlPath, report };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--partition') {
      const p = String(argv[++i] ?? '').toUpperCase();
      if (p === 'B') Object.assign(args, { start: '2024-03-20', end: '2024-06-30' });
      else if (p === 'C') Object.assign(args, { start: '2024-07-01', end: '2024-09-29' });
      else if (p === 'BC') Object.assign(args, { start: '2024-03-20', end: '2024-09-29' });
      else throw new TypeError('--partition must be B, C, or BC.');
    } else if (token === '--start') args.start = argv[++i];
    else if (token === '--end') args.end = argv[++i];
    else if (token === '--out') args.out = argv[++i];
    else if (token === '--jsonl-out') args.jsonlOut = argv[++i];
    else if (token === '--dataset') args.datasetPath = argv[++i];
    else if (token === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new TypeError(`Unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/mlb/historical/build-market-ledger.mjs --partition BC',
    '',
    'Builds the frozen B/C historical market-reference ledger using only free/public sources.',
    'Winner and primary game-total rows require >=3 books and de-vig agreement across',
    `multiplicative, power, and Shin methods within ${MAX_SELECTED_SIDE_LOGIT_RANGE.toFixed(2)} logit.`,
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
    const { outputPath, jsonlPath, report } = await runHistoricalMarketLedger(args);
    console.log(JSON.stringify({
      status: report.coverage.source_failure_days ? 'DEGRADED' : 'OK',
      output: outputPath,
      jsonl_output: jsonlPath,
      coverage: report.coverage,
      source_sha256: report.source.sha256,
    }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  }
}
