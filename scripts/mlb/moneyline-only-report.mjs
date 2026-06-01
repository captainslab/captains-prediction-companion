#!/usr/bin/env node
// Moneyline-only MLB composite reporting lane.
//
// This is a filter on already-selected composite outputs. It does not change
// composite scoring, pick selection, or execution behavior. Market prices are
// retained only as post-hoc report metadata.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  analyzeDate,
  defaultJsonPath,
  summarize,
} from './composite-backtest-report.mjs';

function parseArgs(argv) {
  const opts = {
    date: null,
    stateRoot: 'state',
    out: null,
    jsonOut: null,
    allowMissingPrices: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--date') opts.date = argv[++i];
    else if (arg === '--state-root') opts.stateRoot = argv[++i];
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--json-out') opts.jsonOut = argv[++i];
    else if (arg === '--allow-missing-prices') opts.allowMissingPrices = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!opts.date && !opts.help) throw new Error('--date YYYY-MM-DD is required');
  return opts;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/mlb/moneyline-only-report.mjs --date YYYY-MM-DD [--out FILE]',
    '',
    'Options:',
    '  --state-root DIR          Default: state',
    '  --json-out FILE           Write machine-readable report JSON. Defaults to OUT with .json extension.',
    '  --allow-missing-prices    Allow moneyline rows without post-hoc price metadata.',
  ].join('\n');
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

function moneylineRows(rows) {
  return rows.filter(row => row.marketType === 'moneyline');
}

function researchOnlyRows(rows) {
  return rows
    .filter(row => row.marketType !== 'moneyline')
    .map(row => ({
      ...row,
      productionLaneStatus: 'research_only_excluded_from_moneyline_lane',
    }));
}

function validateMoneylineRows(rows, { allowMissingPrices = false } = {}) {
  const missing = rows.filter(row => row.price == null || !row.ticker);
  if (missing.length > 0 && !allowMissingPrices) {
    const labels = missing.map(row => `${row.date} ${row.label} ${row.pick}: ${row.priceNote ?? 'moneyline_price_missing'}`).join('; ');
    throw new Error(`Moneyline report requires post-hoc moneyline price metadata; missing ${labels}`);
  }
}

function buildMoneylineOnlyData({ analysis, allowMissingPrices = false }) {
  const moneylines = moneylineRows(analysis.rows).map(row => ({
    ...row,
    productionLaneStatus: 'moneyline_report_only',
    backtestAvailable: row.result !== 'missing_final' && row.win != null,
  }));
  validateMoneylineRows(moneylines, { allowMissingPrices });

  const researchOnly = researchOnlyRows(analysis.rows);
  const missingData = [
    ...analysis.missing.filter(item => /\bmoneyline\b/i.test(item)),
    ...moneylines
      .filter(row => row.price == null || !row.ticker)
      .map(row => `${row.date} ${row.label} ${row.pick}: ${row.priceNote ?? 'moneyline_price_missing'}`),
  ];

  return {
    schema_version: 'mlb_moneyline_only_report_v1',
    date: analysis.date,
    source: {
      composite_artifact: analysis.compactPath,
      result_source: analysis.finalsSourceUrl,
      discovery_files: analysis.discovery.files,
    },
    safety: {
      no_trades_placed: true,
      automated_betting_enabled: false,
      upstream_scoring_changed: false,
      pick_selection_changed: false,
      market_data_policy: 'post_hoc_price_metadata_only_not_model_input',
    },
    moneyline_rows: moneylines,
    research_only_excluded_rows: researchOnly,
    summaries: {
      moneyline_by_bucket: summaryObject(summarize(moneylines, row => row.bucket)),
      moneyline_by_signal_source: summaryObject(summarize(moneylines, row => row.source)),
    },
    counts: {
      total_composite_rows: analysis.rows.length,
      moneyline_rows: moneylines.length,
      research_only_excluded_rows: researchOnly.length,
      excluded_by_market_type: summaryObject(summarize(researchOnly, row => row.marketType)),
    },
    missing_data_and_blockers: [...new Set(missingData)].sort(),
  };
}

function renderSummaryTable(groups, keyLabel) {
  const lines = [
    `| ${keyLabel} | Picks | W-L-P | Win rate | Priced | Missing price | Unit PnL |`,
    '|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const g of groups) {
    lines.push(`| ${mdEscape(g.key)} | ${g.n} | ${g.wins}-${g.losses}-${g.pushes} | ${pct(g.wins, g.wins + g.losses)} | ${g.priced} | ${g.missingPrice} | ${money(g.pnl)} |`);
  }
  return lines.join('\n');
}

function renderMoneylineOnlyReport(data) {
  const lines = [];
  lines.push(`# MLB Moneyline-Only Composite Report - ${data.date}`);
  lines.push('');
  lines.push('Scope: moneyline-only reporting lane filtered from completed composite outputs. No trades placed.');
  lines.push('');
  lines.push('## Safety');
  lines.push('- No automated betting enabled.');
  lines.push('- Upstream composite scoring and pick selection unchanged.');
  lines.push('- Market prices are post-hoc report metadata only, not model input.');
  lines.push('- NRFI/YRFI and totals are excluded from this production lane and remain research-only.');
  lines.push('');
  lines.push('## Files analyzed');
  lines.push(`- \`${data.source.composite_artifact}\``);
  for (const filePath of Object.values(data.source.discovery_files)) lines.push(`- \`${filePath}\``);
  lines.push('');
  lines.push('## Result source');
  lines.push(`- ${data.source.result_source}`);
  lines.push('');
  lines.push('## Moneyline Production Lane');
  lines.push('| Label | Pick | Status | Edge bucket | Diff | Price | Ticker | Final | Result | Backtest PnL | Signal source | Notes |');
  lines.push('|---|---|---|---|---:|---:|---|---|---|---:|---|---|');
  for (const row of data.moneyline_rows) {
    const notes = [
      row.lineupStatus ? `lineup=${row.lineupStatus}` : null,
      row.backtestAvailable ? 'backtest_available=true' : 'backtest_available=false',
    ].filter(Boolean).join('; ');
    lines.push(`| ${row.label} | ${mdEscape(row.pick)} | ${row.status} | ${mdEscape(row.bucket)} | ${row.metricValue ?? 'n/a'} | ${row.price ?? 'n/a'} | ${row.ticker ?? 'n/a'} | ${row.finalText} | ${row.result} | ${money(row.pnl)} | ${mdEscape(row.source)} | ${mdEscape(notes)} |`);
  }
  lines.push('');
  lines.push('## Moneyline Summary By Edge Bucket');
  lines.push(renderSummaryTable(summarize(data.moneyline_rows, row => row.bucket), 'Edge bucket'));
  lines.push('');
  lines.push('## Moneyline Summary By Signal Source');
  lines.push(renderSummaryTable(summarize(data.moneyline_rows, row => row.source), 'Signal source'));
  lines.push('');
  lines.push('## Research-Only Exclusions');
  lines.push('| Label | Market type | Pick | Status | Signal bucket | Reason |');
  lines.push('|---|---|---|---|---|---|');
  for (const row of data.research_only_excluded_rows) {
    lines.push(`| ${row.label} | ${row.marketType} | ${mdEscape(row.pick)} | ${row.status} | ${mdEscape(row.bucket)} | research_only_excluded_from_moneyline_lane |`);
  }
  lines.push('');
  lines.push('## Missing Data And Blockers');
  if (data.missing_data_and_blockers.length === 0) {
    lines.push('- None for moneyline production-lane rows.');
  } else {
    for (const item of data.missing_data_and_blockers) lines.push(`- ${item}`);
  }
  lines.push('');
  lines.push('## Output Counts');
  lines.push(`- total_composite_rows=${data.counts.total_composite_rows}`);
  lines.push(`- moneyline_rows=${data.counts.moneyline_rows}`);
  lines.push(`- research_only_excluded_rows=${data.counts.research_only_excluded_rows}`);
  lines.push('- No trades placed.');
  return lines.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    return;
  }

  const analysis = await analyzeDate({ date: opts.date, stateRoot: opts.stateRoot });
  const data = buildMoneylineOnlyData({ analysis, allowMissingPrices: opts.allowMissingPrices });
  const markdown = renderMoneylineOnlyReport(data);

  if (opts.out) {
    const outPath = resolve(opts.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${markdown}\n`, 'utf8');
    console.log(`moneyline_report_written=${outPath}`);
  } else {
    console.log(markdown);
  }

  const jsonOut = opts.jsonOut ?? (opts.out ? defaultJsonPath(opts.out) : null);
  if (jsonOut) {
    const jsonPath = resolve(jsonOut);
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(jsonPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    console.log(`moneyline_json_written=${jsonPath}`);
  }

  console.log(`date=${data.date}`);
  console.log(`moneyline_rows=${data.counts.moneyline_rows}`);
  console.log(`research_only_excluded_rows=${data.counts.research_only_excluded_rows}`);
  for (const g of summarize(data.moneyline_rows, row => row.bucket)) {
    console.log(`moneyline_bucket=${g.key} picks=${g.n} record=${g.wins}-${g.losses}-${g.pushes} priced=${g.priced} missing_price=${g.missingPrice} pnl=${money(g.pnl)}`);
  }
  console.log('No trades placed.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(err => {
    console.error(`[moneyline-only-report] error: ${err.message}`);
    process.exit(1);
  });
}

export {
  buildMoneylineOnlyData,
  moneylineRows,
  renderMoneylineOnlyReport,
  researchOnlyRows,
  validateMoneylineRows,
};
