import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildReportData,
  defaultJsonPath,
  evaluateOutcome,
  parseCompactRows,
} from '../scripts/mlb/composite-backtest-report.mjs';
import {
  buildMoneylineOnlyData,
  renderMoneylineOnlyReport,
  validateMoneylineRows,
} from '../scripts/mlb/moneyline-only-report.mjs';

function fakeAnalysis({ date, rows, missing = [] }) {
  return {
    date,
    compactPath: `/state/mlb/${date}/composite-refresh-compact.txt`,
    finalsSourceUrl: `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}`,
    discovery: {
      files: {
        'mlb_official_adapter.json': `/state/mlb/${date}/discovery/mlb_official_adapter.json`,
        'stats_adapter.json': `/state/mlb/${date}/discovery/stats_adapter.json`,
        'kalshi_adapter.json': `/state/mlb/${date}/discovery/kalshi_adapter.json`,
        'sportsbook_adapter.json': `/state/mlb/${date}/discovery/sportsbook_adapter.json`,
        'context_adapter.json': `/state/mlb/${date}/discovery/context_adapter.json`,
      },
      counts: {
        mlb_games: 3,
        stats_records: 3,
        kalshi_events: 6,
        sportsbook_records: 3,
        context_records: 3,
      },
    },
    rows,
    missing,
    watchDetails: [],
  };
}

test('parseCompactRows preserves lane metric labels separately', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mlb-backtest-compact-'));
  const file = join(dir, 'composite-refresh-compact.txt');
  try {
    writeFileSync(file, [
      '◆ EVIDENCE_LEAN ATL@CIN    →  Atlanta Braves ML  (diff: +19)',
      '  ↳ ATL 72 vs CIN 53 [mlb_sabermetrics]',
      '◇ LEAN          SD@WSH     →  NRFI (no runs in 1st)  (signal: 58)',
      '  ↳ SD 60 vs WSH 58 [mlb_sabermetrics]',
      '',
    ].join('\n'));

    const rows = parseCompactRows(file);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].displayedMetricLabel, 'diff');
    assert.equal(rows[0].displayedDiff, 19);
    assert.equal(rows[1].displayedMetricLabel, 'signal');
    assert.equal(rows[1].displayedMetric, 58);
    assert.equal(rows[1].displayedDiff, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildReportData keeps ML, NRFI, and totals in separate performance buckets', () => {
  const rows = [
    {
      date: '2026-05-29',
      label: 'ATL@CIN',
      marketType: 'moneyline',
      bucket: 'ML diff 15-24',
      source: 'moneyline_side_composite:mlb_sabermetrics',
      win: true,
      price: 0.58,
      pnl: 0.42,
    },
    {
      date: '2026-05-29',
      label: 'SD@WSH',
      marketType: 'nrfi',
      bucket: 'RFI signal 54-63',
      source: 'first_inning_proxy_from_total_signal:mlb_sabermetrics',
      win: false,
      price: null,
      pnl: null,
    },
    {
      date: '2026-05-29',
      label: 'KC@TEX',
      marketType: 'game_total',
      bucket: 'Total signal 56-65',
      source: 'total_signal:mlb_sabermetrics',
      win: false,
      price: 0.52,
      pnl: -0.52,
    },
  ];
  const data = buildReportData({
    baseDate: '2026-05-29',
    includeHistorical: true,
    analyses: [
      fakeAnalysis({
        date: '2026-05-29',
        rows,
        missing: ['2026-05-29 SD@WSH nrfi: first_inning_market_missing'],
      }),
    ],
  });

  assert.deepEqual(Object.keys(data.summaries.base.by_market_type).sort(), ['game_total', 'moneyline', 'nrfi']);
  assert.equal(data.summaries.base.by_market_type.moneyline.picks, 1);
  assert.equal(data.summaries.base.by_market_type.nrfi.missing_price, 1);
  assert.equal(data.summaries.base.by_diff_or_signal_bucket['ML diff 15-24'].wins, 1);
  assert.equal(data.summaries.base.by_signal_source['total_signal:mlb_sabermetrics'].losses, 1);
  assert.equal(data.safety.no_trades_placed, true);
  assert.equal(data.safety.market_data_policy, 'post_hoc_backtest_only_not_pick_selection');
  assert.match(data.proposed_code_config_changes[0], /Do not pass Kalshi market availability/);
  assert.deepEqual(data.missing_data_and_blockers, ['2026-05-29 SD@WSH nrfi: first_inning_market_missing']);
});

test('evaluateOutcome handles plus and minus run-line picks', () => {
  const final = {
    status: 'Final',
    away_score: 4,
    home_score: 5,
    first_away_runs: 0,
    first_home_runs: 0,
  };

  assert.equal(evaluateOutcome({
    market: { marketType: 'run_line', side: 'away', strike: 1.5 },
    final,
  }).result, 'win');

  assert.equal(evaluateOutcome({
    market: { marketType: 'run_line', side: 'away', strike: 1 },
    final,
  }).result, 'push');

  assert.equal(evaluateOutcome({
    market: { marketType: 'run_line', side: 'home', strike: -1.5 },
    final,
  }).result, 'loss');
});

test('defaultJsonPath writes next to markdown report', () => {
  assert.equal(defaultJsonPath('state/mlb/2026-05-29/composite-backtest-report.md'), 'state/mlb/2026-05-29/composite-backtest-report.json');
  assert.equal(defaultJsonPath('state/mlb/2026-05-29/composite-backtest-report'), 'state/mlb/2026-05-29/composite-backtest-report.json');
});

test('moneyline-only report excludes NRFI and totals from production lane', () => {
  const analysis = fakeAnalysis({
    date: '2026-05-29',
    rows: [
      {
        date: '2026-05-29',
        label: 'ATL@CIN',
        marketType: 'moneyline',
        pick: 'Atlanta Braves ML',
        status: 'EVIDENCE_LEAN',
        bucket: 'ML diff 15-24',
        metricValue: 19,
        source: 'moneyline_side_composite:mlb_sabermetrics',
        result: 'win',
        win: true,
        price: 0.58,
        ticker: 'KXMLBGAME-26MAY29-ATLCIN-ATL',
        pnl: 0.42,
        finalText: '8-3, 1st 1-0',
        lineupStatus: 'lineup_pending',
      },
      {
        date: '2026-05-29',
        label: 'SD@WSH',
        marketType: 'nrfi',
        pick: 'NRFI (no runs in 1st)',
        status: 'LEAN',
        bucket: 'RFI signal 54-63',
        source: 'first_inning_proxy_from_total_signal:mlb_sabermetrics',
        result: 'loss',
        win: false,
        price: null,
        ticker: null,
        pnl: null,
        finalText: '7-5, 1st 1-2',
      },
      {
        date: '2026-05-29',
        label: 'KC@TEX',
        marketType: 'game_total',
        pick: 'UNDER 7.5',
        status: 'LEAN',
        bucket: 'Total signal 56-65',
        source: 'total_signal:mlb_sabermetrics',
        result: 'loss',
        win: false,
        price: 0.52,
        ticker: 'KXMLBSPREAD-26MAY29-KCTEX-TOTAL',
        pnl: -0.52,
        finalText: '1-9, 1st 0-4',
      },
    ],
  });

  const data = buildMoneylineOnlyData({ analysis });
  assert.equal(data.moneyline_rows.length, 1);
  assert.equal(data.moneyline_rows[0].marketType, 'moneyline');
  assert.deepEqual(data.research_only_excluded_rows.map(row => row.marketType), ['nrfi', 'game_total']);
  assert.equal(data.counts.research_only_excluded_rows, 2);
  assert.equal(data.safety.market_data_policy, 'post_hoc_price_metadata_only_not_model_input');

  const report = renderMoneylineOnlyReport(data);
  const productionSection = report.slice(report.indexOf('## Moneyline Production Lane'), report.indexOf('## Moneyline Summary By Edge Bucket'));
  const exclusionsSection = report.slice(report.indexOf('## Research-Only Exclusions'), report.indexOf('## Missing Data And Blockers'));
  assert.match(productionSection, /Atlanta Braves ML/);
  assert.doesNotMatch(productionSection, /NRFI|UNDER 7\.5/);
  assert.match(exclusionsSection, /NRFI/);
  assert.match(exclusionsSection, /UNDER 7\.5/);
  assert.match(report, /No automated betting enabled/);
});

test('moneyline-only report rejects missing moneyline price metadata by default', () => {
  const rows = [
    {
      date: '2026-05-29',
      label: 'ATL@CIN',
      marketType: 'moneyline',
      pick: 'Atlanta Braves ML',
      price: null,
      ticker: null,
      priceNote: 'moneyline_yes_ask_missing',
    },
  ];

  assert.throws(
    () => validateMoneylineRows(rows),
    /requires post-hoc moneyline price metadata/,
  );
  assert.doesNotThrow(() => validateMoneylineRows(rows, { allowMissingPrices: true }));
});
