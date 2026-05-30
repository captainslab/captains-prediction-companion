#!/usr/bin/env node
// Analysis-only MLB composite backtest reporter.
//
// Reads saved composite refresh artifacts, joins them to discovery snapshots,
// fetches final scores from MLB Stats API, and reports performance without
// placing trades or changing production scoring logic.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  loadDynamicCompositeSlate,
  runComposite,
} from './late-slate-composite-refresh.mjs';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const opts = {
    date: null,
    stateRoot: 'state',
    out: null,
    jsonOut: null,
    includeHistorical: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--date') opts.date = argv[++i];
    else if (arg === '--state-root') opts.stateRoot = argv[++i];
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--json-out') opts.jsonOut = argv[++i];
    else if (arg === '--include-historical') opts.includeHistorical = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!opts.date && !opts.help) throw new Error('--date YYYY-MM-DD is required');
  return opts;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/mlb/composite-backtest-report.mjs --date YYYY-MM-DD [--out FILE]',
    '',
    'Options:',
    '  --include-historical   Include earlier dates with saved composite-refresh-compact.txt files.',
    '  --state-root DIR       Default: state',
    '  --json-out FILE        Write machine-readable report JSON. Defaults to OUT with .json extension.',
  ].join('\n');
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function pct(wins, total) {
  if (!total) return 'n/a';
  return `${(wins / total * 100).toFixed(1)}%`;
}

function money(value) {
  return value == null ? 'n/a' : value.toFixed(3);
}

function mdEscape(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function parseCompactRows(filePath) {
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  const rows = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^[★◆◇]/u.test(line)) continue;
    const match = line.match(/^[★◆◇]\s+([A-Z_ ]+?)\s+([A-Z0-9@]+)\s+→\s+(.+?)(?:\s+\((diff|signal):\s*([+-]?\d+)\))?$/u);
    if (!match) continue;
    const whyLine = lines[i + 1]?.trim().startsWith('↳')
      ? lines[i + 1].trim().replace(/^↳\s*/u, '')
      : '';
    rows.push({
      status: match[1].trim(),
      label: match[2].trim(),
      pickLabel: match[3].trim(),
      displayedMetricLabel: match[4] ?? null,
      displayedMetric: match[5] == null ? null : Number(match[5]),
      displayedDiff: match[4] === 'diff' && match[5] != null ? Number(match[5]) : null,
      why: whyLine,
      sourceTag: whyLine.match(/\[([^\]]+)\]/)?.[1] ?? null,
    });
  }

  return rows;
}

function marketFromPick(row, game) {
  const pick = row.pickLabel;
  if (/^NRFI\b/i.test(pick)) {
    return { marketType: 'nrfi', lane: 'nrfi', direction: 'nrfi', selection: 'NRFI', strike: null, side: null };
  }
  if (/^YRFI\b/i.test(pick)) {
    return { marketType: 'yrfi', lane: 'yrfi', direction: 'yrfi', selection: 'YRFI', strike: null, side: null };
  }
  const totalMatch = pick.match(/^(?:Total\s+)?(OVER|UNDER)(?:\s+(\d+(?:\.\d+)?))?$/i);
  if (totalMatch) {
    const direction = totalMatch[1].toLowerCase();
    return {
      marketType: 'game_total',
      lane: `total_${direction}`,
      direction,
      selection: direction.toUpperCase(),
      strike: totalMatch[2] == null ? null : Number(totalMatch[2]),
      side: null,
    };
  }
  if (/\bML$/i.test(pick)) {
    const teamName = pick.replace(/\s+ML$/i, '').trim();
    const side = teamName === game?.away_team ? 'away'
      : teamName === game?.home_team ? 'home'
        : null;
    return {
      marketType: 'moneyline',
      lane: side ? `moneyline_${side}` : 'moneyline',
      direction: side,
      selection: teamName,
      strike: null,
      side,
    };
  }
  const runLineMatch = pick.match(/^(.+?)\s+([+-]\d+(?:\.\d+)?)$/);
  if (runLineMatch) {
    const teamName = runLineMatch[1].trim();
    const side = teamName === game?.away_team ? 'away'
      : teamName === game?.home_team ? 'home'
        : null;
    return {
      marketType: 'run_line',
      lane: side ? `run_line_${side}` : 'run_line',
      direction: side,
      selection: teamName,
      strike: Number(runLineMatch[2]),
      side,
    };
  }
  return { marketType: 'unknown', lane: 'unknown', direction: null, selection: pick, strike: null, side: null };
}

function labelForRecord(record) {
  if (record?.label) return record.label;
  if (record?.away_team_abbrev && record?.home_team_abbrev) return `${record.away_team_abbrev}@${record.home_team_abbrev}`;
  return null;
}

function buildDiscoveryContext({ date, stateRoot }) {
  const dir = resolve(stateRoot, 'mlb', date, 'discovery');
  const required = [
    'mlb_official_adapter.json',
    'stats_adapter.json',
    'kalshi_adapter.json',
    'sportsbook_adapter.json',
    'context_adapter.json',
  ];
  const files = Object.fromEntries(required.map(name => [name, resolve(dir, name)]));
  for (const [name, filePath] of Object.entries(files)) {
    if (!existsSync(filePath)) throw new Error(`Missing ${name} for ${date}: ${filePath}`);
  }

  const mlb = readJson(files['mlb_official_adapter.json']);
  const stats = readJson(files['stats_adapter.json']);
  const kalshi = readJson(files['kalshi_adapter.json']);
  const sportsbook = readJson(files['sportsbook_adapter.json']);
  const context = readJson(files['context_adapter.json']);

  const gamesByPk = new Map();
  const gamesByLabel = new Map();
  for (const game of safeArray(mlb.records)) {
    gamesByPk.set(game.game_pk, game);
  }
  for (const stat of safeArray(stats.records)) {
    const game = gamesByPk.get(stat.game_pk) ?? stat;
    const label = labelForRecord(stat);
    if (label) gamesByLabel.set(label, { ...game, label });
  }

  const marketEventsByGame = new Map();
  for (const event of safeArray(kalshi.records)) {
    const gamePk = event.matched_game_pk;
    if (gamePk == null) continue;
    if (!marketEventsByGame.has(gamePk)) marketEventsByGame.set(gamePk, []);
    marketEventsByGame.get(gamePk).push(event);
  }

  const sportsbookByGame = new Map();
  for (const record of safeArray(sportsbook.records)) {
    const game = safeArray(mlb.records).find(g => g.away_team === record.away_team && g.home_team === record.home_team);
    if (game?.game_pk != null) sportsbookByGame.set(game.game_pk, record);
  }

  const contextByGame = new Map();
  for (const record of safeArray(context.records)) {
    if (record.game_pk != null) contextByGame.set(record.game_pk, record);
  }

  return {
    dir,
    files,
    gamesByLabel,
    marketEventsByGame,
    sportsbookByGame,
    contextByGame,
    kalshiSeries: [...new Set(safeArray(kalshi.records).map(r => r.series_ticker).filter(Boolean))].sort(),
    counts: {
      mlb_games: safeArray(mlb.records).length,
      stats_records: safeArray(stats.records).length,
      kalshi_events: safeArray(kalshi.records).length,
      sportsbook_records: safeArray(sportsbook.records).length,
      context_records: safeArray(context.records).length,
    },
  };
}

function buildCompositeByLabel({ date, stateRoot }) {
  const slate = loadDynamicCompositeSlate({ date, stateRoot, allowPendingLineups: true });
  const byLabel = new Map();
  for (const input of slate.inputs) {
    byLabel.set(input.label, { input, result: runComposite(input) });
  }
  return { byLabel, watchDetails: slate.watchDetails };
}

async function fetchFinalResults(date) {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=linescore,probablePitcher,team`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MLB Stats schedule fetch failed ${res.status} ${res.statusText}`);
  const json = await res.json();
  const byPk = new Map();
  for (const game of safeArray(json.dates?.[0]?.games)) {
    byPk.set(game.gamePk, {
      game_pk: game.gamePk,
      status: game.status?.detailedState ?? null,
      away_team: game.teams?.away?.team?.name ?? null,
      home_team: game.teams?.home?.team?.name ?? null,
      away_score: game.teams?.away?.score ?? null,
      home_score: game.teams?.home?.score ?? null,
      first_away_runs: game.linescore?.innings?.[0]?.away?.runs ?? null,
      first_home_runs: game.linescore?.innings?.[0]?.home?.runs ?? null,
    });
  }
  return { sourceUrl: url, byPk };
}

function findTotalMarket(events, strike) {
  for (const event of events) {
    for (const market of safeArray(event.markets)) {
      if (market.market_lane !== 'game_total') continue;
      if (Number(market.total_strike) === Number(strike)) return market;
      const titleStrike = market.contract_title?.match(/Over\s+(\d+(?:\.\d+)?)/i)?.[1];
      if (Number(titleStrike) === Number(strike)) return market;
    }
  }
  return null;
}

function findMarketPrice({ market, game, events }) {
  if (!game) return { price: null, ticker: null, priceField: null, note: 'game_missing' };
  const gameEvents = events.get(game.game_pk) ?? [];

  if (market.marketType === 'moneyline') {
    for (const event of gameEvents) {
      for (const candidate of safeArray(event.markets)) {
        if (candidate.market_lane !== 'moneyline') continue;
        if (candidate.team_side === market.side || candidate.team_name === market.selection) {
          return {
            price: candidate.yes_ask ?? null,
            ticker: candidate.market_ticker ?? null,
            priceField: 'yes_ask',
            note: candidate.yes_ask == null ? 'moneyline_yes_ask_missing' : null,
          };
        }
      }
    }
    return { price: null, ticker: null, priceField: null, note: 'moneyline_market_missing' };
  }

  if (market.marketType === 'game_total') {
    if (market.strike == null) {
      return { price: null, ticker: null, priceField: null, note: 'total_strike_missing' };
    }
    const totalMarket = findTotalMarket(gameEvents, market.strike);
    if (!totalMarket) return { price: null, ticker: null, priceField: null, note: 'total_market_missing' };
    if (market.direction === 'over') {
      return {
        price: totalMarket.yes_ask ?? null,
        ticker: totalMarket.market_ticker ?? null,
        priceField: 'yes_ask',
        note: totalMarket.yes_ask == null ? 'total_yes_ask_missing' : null,
      };
    }
    return {
      price: totalMarket.no_ask ?? null,
      ticker: totalMarket.market_ticker ?? null,
      priceField: 'no_ask',
      note: totalMarket.no_ask == null ? 'total_no_ask_missing' : null,
    };
  }

  if (market.marketType === 'nrfi' || market.marketType === 'yrfi') {
    const hasFirstInningEvent = gameEvents.some(event => event.series_ticker === 'KXMLBRFI' || /first inning|1st inning|RFI/i.test(event.event_title ?? ''));
    return {
      price: null,
      ticker: null,
      priceField: null,
      note: hasFirstInningEvent ? 'first_inning_price_mapping_missing' : 'first_inning_market_missing',
    };
  }

  return { price: null, ticker: null, priceField: null, note: 'unsupported_market_type' };
}

function evaluateOutcome({ market, game, final }) {
  if (!final || final.status !== 'Final') return { result: 'missing_final', win: null, finalText: 'missing' };
  const away = final.away_score;
  const home = final.home_score;
  const total = away + home;
  const firstInningRuns = (final.first_away_runs ?? 0) + (final.first_home_runs ?? 0);
  const finalText = `${away}-${home}, 1st ${final.first_away_runs ?? '?'}-${final.first_home_runs ?? '?'}`;

  if (market.marketType === 'moneyline') {
    const winnerSide = away > home ? 'away' : home > away ? 'home' : null;
    return { result: winnerSide === market.side ? 'win' : 'loss', win: winnerSide === market.side, finalText };
  }

  if (market.marketType === 'game_total') {
    if (market.strike == null) return { result: 'missing_strike', win: null, finalText };
    if (total === market.strike) return { result: 'push', win: null, finalText };
    const win = market.direction === 'over' ? total > market.strike : total < market.strike;
    return { result: win ? 'win' : 'loss', win, finalText };
  }

  if (market.marketType === 'nrfi') {
    const win = firstInningRuns === 0;
    return { result: win ? 'win' : 'loss', win, finalText };
  }

  if (market.marketType === 'yrfi') {
    const win = firstInningRuns > 0;
    return { result: win ? 'win' : 'loss', win, finalText };
  }

  if (market.marketType === 'run_line') {
    const margin = market.side === 'away' ? away - home : home - away;
    const adjustedMargin = margin + (market.strike ?? 0);
    if (adjustedMargin === 0) return { result: 'push', win: null, finalText };
    const win = adjustedMargin > 0;
    return { result: win ? 'win' : 'loss', win, finalText };
  }

  return { result: 'unsupported', win: null, finalText };
}

function bucketFor({ market, lane, row }) {
  const metricValue = market.marketType === 'moneyline' || market.marketType === 'run_line'
    ? lane?.differential ?? row.displayedDiff
    : lane?.score ?? null;

  if (metricValue == null) return { metricName: 'missing', metricValue: null, bucket: 'missing' };

  if (market.marketType === 'moneyline') {
    if (metricValue >= 25) return { metricName: 'score_diff', metricValue, bucket: 'ML diff >=25' };
    if (metricValue >= 15) return { metricName: 'score_diff', metricValue, bucket: 'ML diff 15-24' };
    if (metricValue >= 8) return { metricName: 'score_diff', metricValue, bucket: 'ML diff 8-14' };
    return { metricName: 'score_diff', metricValue, bucket: 'ML diff <8' };
  }

  if (market.marketType === 'run_line') {
    if (metricValue >= 32) return { metricName: 'score_diff', metricValue, bucket: 'RL diff >=32' };
    if (metricValue >= 22) return { metricName: 'score_diff', metricValue, bucket: 'RL diff 22-31' };
    if (metricValue >= 15) return { metricName: 'score_diff', metricValue, bucket: 'RL diff 15-21' };
    return { metricName: 'score_diff', metricValue, bucket: 'RL diff <15' };
  }

  if (market.marketType === 'game_total') {
    if (metricValue >= 76) return { metricName: 'signal_score', metricValue, bucket: 'Total signal >=76' };
    if (metricValue >= 66) return { metricName: 'signal_score', metricValue, bucket: 'Total signal 66-75' };
    if (metricValue >= 56) return { metricName: 'signal_score', metricValue, bucket: 'Total signal 56-65' };
    return { metricName: 'signal_score', metricValue, bucket: 'Total signal <56' };
  }

  if (market.marketType === 'nrfi' || market.marketType === 'yrfi') {
    if (metricValue >= 74) return { metricName: 'signal_score', metricValue, bucket: 'RFI signal >=74' };
    if (metricValue >= 64) return { metricName: 'signal_score', metricValue, bucket: 'RFI signal 64-73' };
    if (metricValue >= 54) return { metricName: 'signal_score', metricValue, bucket: 'RFI signal 54-63' };
    return { metricName: 'signal_score', metricValue, bucket: 'RFI signal <54' };
  }

  return { metricName: 'unknown', metricValue, bucket: 'unknown' };
}

function sourceFor({ market, row }) {
  const tag = row.sourceTag ?? 'unknown_source';
  if (market.marketType === 'moneyline') return `moneyline_side_composite:${tag}`;
  if (market.marketType === 'game_total') return `total_signal:${tag}`;
  if (market.marketType === 'nrfi' || market.marketType === 'yrfi') return `first_inning_proxy_from_total_signal:${tag}`;
  return `unknown:${tag}`;
}

function summarize(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!groups.has(key)) {
      groups.set(key, { key, n: 0, wins: 0, losses: 0, pushes: 0, priced: 0, missingPrice: 0, pnl: 0 });
    }
    const g = groups.get(key);
    g.n += 1;
    if (row.win === true) g.wins += 1;
    else if (row.win === false) g.losses += 1;
    else g.pushes += 1;
    if (row.price == null) g.missingPrice += 1;
    else {
      g.priced += 1;
      g.pnl += row.pnl ?? 0;
    }
  }
  return [...groups.values()].sort((a, b) => String(a.key).localeCompare(String(b.key)));
}

function summaryTable(groups, keyLabel) {
  const lines = [
    `| ${keyLabel} | Picks | W-L-P | Win rate | Priced | Missing price | Unit PnL |`,
    '|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const g of groups) {
    lines.push(`| ${mdEscape(g.key)} | ${g.n} | ${g.wins}-${g.losses}-${g.pushes} | ${pct(g.wins, g.wins + g.losses)} | ${g.priced} | ${g.missingPrice} | ${money(g.pnl)} |`);
  }
  return lines.join('\n');
}

function compactRecord(g) {
  if (!g) return 'no rows';
  return `${g.n} picks, ${g.wins}-${g.losses}-${g.pushes}, ${pct(g.wins, g.wins + g.losses)} win rate, priced ${g.priced}/${g.n}, unit PnL ${money(g.pnl)}`;
}

function recommendationScope({ includeHistorical, analyses, baseDate }) {
  return includeHistorical && analyses.length > 1
    ? `${analyses[0].date} through ${baseDate}`
    : baseDate;
}

function defaultJsonPath(outPath) {
  if (!outPath) return null;
  return /\.md$/i.test(outPath) ? outPath.replace(/\.md$/i, '.json') : `${outPath}.json`;
}

function summaryObject(groups) {
  return Object.fromEntries(groups.map(g => [
    g.key,
    {
      picks: g.n,
      wins: g.wins,
      losses: g.losses,
      pushes: g.pushes,
      win_rate: pct(g.wins, g.wins + g.losses),
      priced: g.priced,
      missing_price: g.missingPrice,
      unit_pnl: Number(g.pnl.toFixed(3)),
    },
  ]));
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function buildRecommendations({ rows, analyses, includeHistorical, baseDate }) {
  const recGroups = new Map(summarize(rows, r => r.marketType).map(g => [g.key, g]));
  const scopeLabel = recommendationScope({ includeHistorical, analyses, baseDate });
  return [
    {
      action: 'keep_study',
      market_type: 'moneyline',
      summary: compactRecord(recGroups.get('moneyline')),
      reason: `Strongest priced signal in this sample (${scopeLabel}); promising but still small-sample evidence.`,
    },
    {
      action: 'cut_or_hold_for_rebuild',
      market_type: 'nrfi_yrfi',
      summary: compactRecord(recGroups.get('nrfi')),
      reason: 'Weak/noisy for profit analysis until first-inning-specific data and KXMLBRFI prices exist. Missing market data may mark the signal unpriced, but must not change the model-selected signal.',
    },
    {
      action: 'do_not_promote',
      market_type: 'game_total',
      summary: compactRecord(recGroups.get('game_total')),
      reason: 'Insufficient and poor current evidence; one historical total row is missing its strike and the only priced total row lost.',
    },
    {
      action: 'treat_as_research_only',
      market_type: 'all_2026_05_29_rows',
      summary: 'May 29 context adapter shows lineup_pending for evaluated games.',
      reason: 'May 29 results are pre-lineup research, not production-ready picks.',
    },
  ];
}

function buildReportData({ baseDate, analyses, includeHistorical }) {
  const allRows = analyses.flatMap(a => a.rows);
  const base = analyses.find(a => a.date === baseDate) ?? analyses.at(-1);
  const baseRows = base?.rows ?? [];
  const allMissing = uniqueSorted(analyses.flatMap(a => a.missing));
  const files = uniqueSorted(analyses.flatMap(a => [
    a.compactPath,
    ...Object.values(a.discovery.files),
  ]));
  const recRows = includeHistorical && analyses.length > 1 ? allRows : baseRows;

  return {
    schema_version: 'mlb_composite_backtest_v1',
    base_date: baseDate,
    include_historical: includeHistorical,
    dates_analyzed: analyses.map(a => a.date),
    safety: {
      no_trades_placed: true,
      production_scoring_changed_by_report: false,
      market_data_policy: 'post_hoc_backtest_only_not_pick_selection',
    },
    files_analyzed: files,
    result_sources: Object.fromEntries(analyses.map(a => [a.date, a.finalsSourceUrl])),
    date_coverage: analyses.map(a => ({
      date: a.date,
      composite_rows: a.rows.length,
      watch_pending_games: a.watchDetails.length,
      missing_data_notes: a.missing.length,
      ...a.discovery.counts,
    })),
    rows: {
      base: baseRows,
      historical: includeHistorical ? allRows : [],
    },
    summaries: {
      base: {
        by_market_type: summaryObject(summarize(baseRows, r => r.marketType)),
        by_diff_or_signal_bucket: summaryObject(summarize(baseRows, r => r.bucket)),
        by_signal_source: summaryObject(summarize(baseRows, r => r.source)),
      },
      historical: includeHistorical ? {
        by_market_type: summaryObject(summarize(allRows, r => r.marketType)),
        by_diff_or_signal_bucket: summaryObject(summarize(allRows, r => r.bucket)),
        by_signal_source: summaryObject(summarize(allRows, r => r.source)),
      } : null,
    },
    missing_data_and_blockers: allMissing,
    recommendations: buildRecommendations({ rows: recRows, analyses, includeHistorical, baseDate }),
    proposed_code_config_changes: [
      'Do not pass Kalshi market availability, prices, odds, liquidity, bid/ask, or volume into runComposite or composeMultiLaneCeilingBoard for pick selection. Keep those fields in backtest/audit joins only.',
      'Use tp.differential for moneyline/run-line display and tp.score as signal for totals/NRFI/YRFI display.',
      'Add a downstream publish/backtest eligibility flag such as profit_backtestable=false for NRFI/YRFI until KXMLBRFI prices and dedicated first-inning features are present. This flag must not alter the model-selected signal.',
      'Keep writing machine-readable composite backtest JSON next to the Markdown report before any threshold tuning.',
    ],
  };
}

async function analyzeDate({ date, stateRoot }) {
  const stateDir = resolve(stateRoot, 'mlb', date);
  const compactPath = resolve(stateDir, 'composite-refresh-compact.txt');
  if (!existsSync(compactPath)) throw new Error(`Missing saved composite file: ${compactPath}`);

  const discovery = buildDiscoveryContext({ date, stateRoot });
  const composite = buildCompositeByLabel({ date, stateRoot });
  const finals = await fetchFinalResults(date);
  const compactRows = parseCompactRows(compactPath);
  const analyzed = [];
  const missing = [];

  for (const row of compactRows) {
    const game = discovery.gamesByLabel.get(row.label);
    if (!game) missing.push(`${date} ${row.label}: game mapping missing`);
    const market = marketFromPick(row, game);
    const computed = composite.byLabel.get(row.label);
    const lane = computed?.result?.board?.lanes?.[market.lane] ?? null;
    const final = game ? finals.byPk.get(game.game_pk) : null;
    const priceInfo = findMarketPrice({ market, game, events: discovery.marketEventsByGame });
    const outcome = evaluateOutcome({ market, game, final });
    const bucket = bucketFor({ market, lane, row });
    const source = sourceFor({ market, row });
    const price = priceInfo.price;
    const pnl = price == null || outcome.win == null
      ? null
      : outcome.win ? +(1 - price).toFixed(4) : +(-price).toFixed(4);
    const displayMetricMismatch = row.displayedDiff != null
      && lane
      && lane.differential == null
      && lane.score != null;

    if (priceInfo.note) missing.push(`${date} ${row.label} ${market.marketType}: ${priceInfo.note}`);
    if (!final || final.status !== 'Final') missing.push(`${date} ${row.label}: final score missing or not final`);
    if (displayMetricMismatch) missing.push(`${date} ${row.label}: compact displayed diff ${row.displayedDiff}, but ${market.marketType} lane uses score ${lane.score}`);

    analyzed.push({
      date,
      label: row.label,
      game_pk: game?.game_pk ?? null,
      game: game ? `${game.away_team} at ${game.home_team}` : 'missing',
      status: row.status,
      pick: row.pickLabel,
      marketType: market.marketType,
      lane: market.lane,
      selection: market.selection,
      metricName: bucket.metricName,
      metricValue: bucket.metricValue,
      bucket: bucket.bucket,
      compactDisplayedDiff: row.displayedDiff,
      finalText: outcome.finalText,
      result: outcome.result,
      win: outcome.win,
      price,
      priceField: priceInfo.priceField,
      ticker: priceInfo.ticker,
      priceNote: priceInfo.note,
      pnl,
      source,
      sourceTag: row.sourceTag,
      why: row.why,
      lineupStatus: discovery.contextByGame.get(game?.game_pk)?.lineup_status ?? null,
      sportsbookOu: discovery.sportsbookByGame.get(game?.game_pk)?.over_under ?? null,
    });
  }

  return {
    date,
    compactPath,
    discovery,
    finalsSourceUrl: finals.sourceUrl,
    rows: analyzed,
    missing: [...new Set(missing)],
    watchDetails: composite.watchDetails,
  };
}

function dateDirs({ stateRoot, throughDate }) {
  const root = resolve(stateRoot, 'mlb');
  return readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name) && d.name <= throughDate)
    .map(d => d.name)
    .filter(date => existsSync(resolve(root, date, 'composite-refresh-compact.txt')))
    .sort();
}

function renderReport({ baseDate, analyses, includeHistorical }) {
  const allRows = analyses.flatMap(a => a.rows);
  const base = analyses.find(a => a.date === baseDate) ?? analyses.at(-1);
  const allMissing = uniqueSorted(analyses.flatMap(a => a.missing));
  const files = analyses.flatMap(a => [
    a.compactPath,
    ...Object.values(a.discovery.files),
  ]);

  const lines = [];
  lines.push(`# MLB Composite Backtest Report - ${baseDate}`);
  lines.push('');
  lines.push(`Scope: saved composite top-pick artifacts${includeHistorical ? ` through ${baseDate}` : ` for ${baseDate}`}. No trades placed.`);
  lines.push('');
  lines.push('## Files analyzed');
  for (const filePath of [...new Set(files)]) lines.push(`- \`${filePath}\``);
  lines.push('');
  lines.push('## Result sources');
  for (const analysis of analyses) lines.push(`- ${analysis.date}: ${analysis.finalsSourceUrl}`);
  lines.push('');
  lines.push('## Date coverage');
  lines.push('| Date | Composite rows | Watch/pending games | Missing data notes | MLB games | Stats records | Kalshi events | Sportsbook records |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const analysis of analyses) {
    lines.push(`| ${analysis.date} | ${analysis.rows.length} | ${analysis.watchDetails.length} | ${analysis.missing.length} | ${analysis.discovery.counts.mlb_games} | ${analysis.discovery.counts.stats_records} | ${analysis.discovery.counts.kalshi_events} | ${analysis.discovery.counts.sportsbook_records} |`);
  }
  lines.push('');
  lines.push(`## ${baseDate} pick/result table`);
  const tableRows = (base?.rows ?? []);
  lines.push('| Label | Market type | Pick | Status | Metric | Bucket | Final | Result | Price | PnL | Signal source | Notes |');
  lines.push('|---|---|---|---|---:|---|---|---|---:|---:|---|---|');
  for (const row of tableRows) {
    const notes = [
      row.priceNote,
      row.lineupStatus ? `lineup=${row.lineupStatus}` : null,
      row.compactDisplayedDiff != null && row.metricName === 'signal_score' ? `compact_diff=${row.compactDisplayedDiff}` : null,
    ].filter(Boolean).join('; ');
    lines.push(`| ${row.label} | ${row.marketType} | ${mdEscape(row.pick)} | ${row.status} | ${row.metricValue ?? 'n/a'} | ${mdEscape(row.bucket)} | ${row.finalText} | ${row.result} | ${row.price ?? 'n/a'} | ${money(row.pnl)} | ${mdEscape(row.source)} | ${mdEscape(notes)} |`);
  }
  lines.push('');

  lines.push(`## ${baseDate} summaries`);
  lines.push('');
  lines.push('### By Market Type');
  lines.push(summaryTable(summarize(tableRows, r => r.marketType), 'Market type'));
  lines.push('');
  lines.push('### By Diff/Signal Bucket');
  lines.push(summaryTable(summarize(tableRows, r => r.bucket), 'Bucket'));
  lines.push('');
  lines.push('### By Signal Source');
  lines.push(summaryTable(summarize(tableRows, r => r.source), 'Signal source'));
  lines.push('');

  if (includeHistorical && analyses.length > 1) {
    lines.push('## Historical extension');
    lines.push('');
    lines.push(`Dates included: ${analyses.map(a => a.date).join(', ')}`);
    lines.push('');
    lines.push('### Historical Pick/Result Table');
    lines.push('| Date | Label | Market type | Pick | Status | Metric | Bucket | Final | Result | Price | PnL | Signal source | Notes |');
    lines.push('|---|---|---|---|---|---:|---|---|---|---:|---:|---|---|');
    for (const row of allRows) {
      const notes = [
        row.priceNote,
        row.lineupStatus ? `lineup=${row.lineupStatus}` : null,
        row.compactDisplayedDiff != null && row.metricName === 'signal_score' ? `compact_diff=${row.compactDisplayedDiff}` : null,
      ].filter(Boolean).join('; ');
      lines.push(`| ${row.date} | ${row.label} | ${row.marketType} | ${mdEscape(row.pick)} | ${row.status} | ${row.metricValue ?? 'n/a'} | ${mdEscape(row.bucket)} | ${row.finalText} | ${row.result} | ${row.price ?? 'n/a'} | ${money(row.pnl)} | ${mdEscape(row.source)} | ${mdEscape(notes)} |`);
    }
    lines.push('');
    lines.push('### By Market Type');
    lines.push(summaryTable(summarize(allRows, r => r.marketType), 'Market type'));
    lines.push('');
    lines.push('### By Diff/Signal Bucket');
    lines.push(summaryTable(summarize(allRows, r => r.bucket), 'Bucket'));
    lines.push('');
    lines.push('### By Signal Source');
    lines.push(summaryTable(summarize(allRows, r => r.source), 'Signal source'));
    lines.push('');
  }

  lines.push('## Missing data and blockers');
  if (allMissing.length === 0) {
    lines.push('- None detected.');
  } else {
    for (const item of allMissing) lines.push(`- ${item}`);
  }
  lines.push('');

  lines.push('## Recommendations');
  const recRows = includeHistorical && analyses.length > 1 ? allRows : tableRows;
  const recGroups = new Map(summarize(recRows, r => r.marketType).map(g => [g.key, g]));
  const scopeLabel = recommendationScope({ includeHistorical, analyses, baseDate });
  lines.push(`- Keep/study MLB moneyline composite as the strongest priced signal in this sample (${scopeLabel}): ${compactRecord(recGroups.get('moneyline'))}. Treat it as promising but still small-sample evidence.`);
  lines.push(`- Treat NRFI/YRFI as weak/noisy for profit analysis until first-inning-specific data and KXMLBRFI prices exist: ${compactRecord(recGroups.get('nrfi'))}. Missing market data may mark the signal unpriced; it must not change the model-selected signal.`);
  lines.push(`- Do not adjust or promote total thresholds from this evidence: ${compactRecord(recGroups.get('game_total'))}. One historical total row is missing its strike in the saved compact artifact, and the only priced total row lost.`);
  lines.push('- Treat all May 29 results as pre-lineup research, not production-ready picks, because the saved context adapter shows lineup_pending for the evaluated games.');
  lines.push('');

  lines.push('## Exact proposed code/config changes');
  lines.push('- Do not pass Kalshi market availability, prices, odds, liquidity, bid/ask, or volume into `runComposite` or `composeMultiLaneCeilingBoard` for pick selection. Keep those fields in backtest/audit joins only.');
  lines.push('- In `topPickLine`, show `tp.differential` for moneyline/run-line lanes and `tp.score` as `signal` for totals/NRFI/YRFI; do not print `board.score_differential` for every lane.');
  lines.push('- Add a downstream publish/backtest eligibility flag such as `profit_backtestable=false` for NRFI/YRFI until KXMLBRFI prices and dedicated first-inning features are present. This flag must not alter the model-selected signal.');
  lines.push('- Keep persisting machine-readable composite backtest JSON next to this Markdown report before threshold tuning, with market type kept separate from status buckets.');
  lines.push('');

  lines.push('## Safety');
  lines.push('- No trades placed.');
  lines.push('- No production scoring logic changed by this report.');
  lines.push('- PnL is one-contract-at-captured-ask bookkeeping only where a Kalshi ask/no_ask was present.');
  return lines.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    return;
  }

  const dates = opts.includeHistorical
    ? dateDirs({ stateRoot: opts.stateRoot, throughDate: opts.date })
    : [opts.date];

  const analyses = [];
  for (const date of dates) {
    analyses.push(await analyzeDate({ date, stateRoot: opts.stateRoot }));
  }

  const report = renderReport({ baseDate: opts.date, analyses, includeHistorical: opts.includeHistorical });
  const reportData = buildReportData({ baseDate: opts.date, analyses, includeHistorical: opts.includeHistorical });
  if (opts.out) {
    const outPath = resolve(opts.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, report, 'utf8');
    console.log(`report_written=${outPath}`);
  } else {
    console.log(report);
  }
  const jsonOut = opts.jsonOut ?? (opts.out ? defaultJsonPath(opts.out) : null);
  if (jsonOut) {
    const jsonPath = resolve(jsonOut);
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(jsonPath, `${JSON.stringify(reportData, null, 2)}\n`, 'utf8');
    console.log(`json_written=${jsonPath}`);
  }

  const base = analyses.find(a => a.date === opts.date) ?? analyses.at(-1);
  const marketGroups = summarize(base.rows, r => r.marketType);
  const allGroups = summarize(analyses.flatMap(a => a.rows), r => r.marketType);
  console.log(`dates_analyzed=${analyses.map(a => a.date).join(',')}`);
  console.log(`base_rows=${base.rows.length}`);
  console.log(`all_rows=${analyses.flatMap(a => a.rows).length}`);
  for (const g of marketGroups) {
    console.log(`market_type=${g.key} picks=${g.n} record=${g.wins}-${g.losses}-${g.pushes} priced=${g.priced} missing_price=${g.missingPrice} pnl=${money(g.pnl)}`);
  }
  if (opts.includeHistorical) {
    for (const g of allGroups) {
      console.log(`historical_market_type=${g.key} picks=${g.n} record=${g.wins}-${g.losses}-${g.pushes} priced=${g.priced} missing_price=${g.missingPrice} pnl=${money(g.pnl)}`);
    }
  }
  if (base.missing.length > 0) console.log(`missing_items=${base.missing.length}`);
  console.log('No trades placed.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(err => {
    console.error(`[composite-backtest] error: ${err.message}`);
    process.exit(1);
  });
}

export {
  analyzeDate,
  buildReportData,
  defaultJsonPath,
  evaluateOutcome,
  marketFromPick,
  parseCompactRows,
  renderReport,
  summarize,
};
