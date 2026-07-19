#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { fetchKalshiReadonly } from './source-adapters/kalshi-readonly.mjs';
import { fetchMlbScheduleReadonly } from './source-adapters/mlb-official-readonly.mjs';
import { fetchBaseballSavantReadonly } from './source-adapters/baseball-savant-readonly.mjs';
import { fetchWeatherReadonly } from './source-adapters/weather-readonly.mjs';
import { fetchLiquidityReadonly } from './source-adapters/liquidity-readonly.mjs';
import { fetchSportsbookReadonly } from './source-adapters/sportsbook-readonly.mjs';
import { fetchContextReadonly } from './source-adapters/context-readonly.mjs';
import { fetchStatsReadonly } from './source-adapters/stats-readonly.mjs';
import { defaultDiscoveryDir, formatDateInTimeZone, writeJsonAtomic, writeTextAtomic } from './file-io.mjs';
import { pathToFileURL } from 'node:url';

const VALID_SOURCES = new Set(['kalshi', 'mlb', 'baseball_savant', 'savant', 'weather', 'liquidity', 'sportsbook', 'context', 'stats', 'all']);

function parseArgs(argv) {
  const options = {
    date: null,
    fixturesOnly: false,
    liveReadonly: false,
    source: 'all',
    out: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--date') {
      options.date = argv[++index] ?? null;
    } else if (arg === '--fixtures-only') {
      options.fixturesOnly = true;
    } else if (arg === '--live-readonly') {
      options.liveReadonly = true;
    } else if (arg === '--source') {
      options.source = argv[++index] ?? 'all';
    } else if (arg === '--out') {
      options.out = argv[++index] ?? null;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!VALID_SOURCES.has(options.source)) {
    throw new Error(`Invalid --source value: ${options.source}`);
  }

  if (!options.liveReadonly) {
    options.fixturesOnly = true;
  }

  return options;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/mlb/source-adapter-dry-run.mjs [--date YYYY-MM-DD] [--fixtures-only|--live-readonly] [--source kalshi|mlb|baseball_savant|weather|liquidity|sportsbook|context|stats|all] [--out path]',
    '',
    'Defaults:',
    '  --fixtures-only is used unless --live-readonly is provided.',
    '  --date defaults to today in America/Chicago.',
    '  --out defaults to state/mlb/YYYY-MM-DD/discovery.',
  ].join('\n');
}

function shouldRunSource(requested, source) {
  return requested === 'all' || requested === source || (requested === 'savant' && source === 'baseball_savant');
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeBatterId(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? String(numeric) : text;
}

function addBatterId(target, value) {
  const candidate = value && typeof value === 'object'
    ? value.mlb_id ?? value.batter_id ?? value.player_id ?? value.id
    : value;
  const normalized = normalizeBatterId(candidate);
  if (normalized) target.add(normalized);
}

export function collectTargetBatterIds({ contextEnvelope, statsEnvelope, mlbEnvelope } = {}) {
  const target = new Set();
  for (const envelope of [contextEnvelope, statsEnvelope, mlbEnvelope]) {
    for (const record of safeArray(envelope?.records)) {
      const sources = [record, record?.context].filter(source => source && typeof source === 'object');
      for (const source of sources) {
        for (const field of [
          'away_batting_order',
          'home_batting_order',
          'batting_order',
          'away_lineup',
          'home_lineup',
          'lineup',
          'hr_batters',
          'hr_evidence',
        ]) {
          for (const value of safeArray(source[field])) addBatterId(target, value);
        }
      }
    }
  }
  return target;
}

function makeSkippedEnvelope(sourceId, runDate, outputDir) {
  const checkedAtUtc = new Date().toISOString();
  const fileNameBySource = {
    kalshi: 'kalshi_adapter',
    mlb_official: 'mlb_official_adapter',
    baseball_savant: 'baseball_savant_adapter',
    weather: 'weather_adapter',
    liquidity: 'liquidity_adapter',
    mlb_stats: 'stats_adapter',
  };
  return {
    source_id: sourceId,
    status: 'skipped',
    checked_at_utc: checkedAtUtc,
    cache_key: `${sourceId}_skipped_${checkedAtUtc}`,
    cache_path: `${outputDir}/${fileNameBySource[sourceId] ?? `${sourceId}_adapter`}.json`,
    required: sourceId !== 'optional_price_sanity',
    records: [],
    warnings: [`Source skipped by CLI --source setting for ${runDate}.`],
    errors: [],
    source_urls: [],
  };
}

function readExistingOrSkipped({ sourceId, filePath, runDate, outputDir }) {
  if (existsSync(filePath)) {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  }

  return {
    ...makeSkippedEnvelope(sourceId, runDate, outputDir),
    warnings: [`Source not requested and no existing adapter file found for ${runDate}.`],
  };
}

function buildSummary({ runDate, checkedAtUtc, mode, kalshiEnvelope, mlbEnvelope, baseballSavantEnvelope, weatherEnvelope, liquidityEnvelope, sportsbookEnvelope, contextEnvelope, statsEnvelope }) {
  const kalshiCount = safeArray(kalshiEnvelope.records).length;
  const kalshiRejectedCount = Array.isArray(kalshiEnvelope.rejected_records)
    ? kalshiEnvelope.rejected_records.length
    : 0;
  const mlbCount = safeArray(mlbEnvelope.records).length;
  const baseballSavantCount = safeArray(baseballSavantEnvelope.records).length;
  const weatherCount = safeArray(weatherEnvelope.records).length;
  const liquidityCount = safeArray(liquidityEnvelope.records).length;
  const sportsbookCount = safeArray(sportsbookEnvelope?.records).length;
  const contextCount = safeArray(contextEnvelope?.records).length;
  const statsCount = safeArray(statsEnvelope?.records).length;
  const warnings = [
    ...safeArray(kalshiEnvelope.warnings),
    ...safeArray(mlbEnvelope.warnings),
    ...safeArray(baseballSavantEnvelope.warnings),
    ...safeArray(weatherEnvelope.warnings),
    ...safeArray(liquidityEnvelope.warnings),
    ...safeArray(sportsbookEnvelope?.warnings),
    ...safeArray(contextEnvelope?.warnings),
    ...safeArray(statsEnvelope?.warnings),
  ];
  const errors = [
    ...safeArray(kalshiEnvelope.errors),
    ...safeArray(mlbEnvelope.errors),
    ...safeArray(baseballSavantEnvelope.errors),
    ...safeArray(weatherEnvelope.errors),
    ...safeArray(liquidityEnvelope.errors),
    ...safeArray(sportsbookEnvelope?.errors),
    ...safeArray(contextEnvelope?.errors),
    ...safeArray(statsEnvelope?.errors),
  ];

  return [
    `# MLB Source Adapter Discovery - ${runDate}`,
    '',
    `- Checked UTC: ${checkedAtUtc}`,
    `- Mode: ${mode}`,
    `- Kalshi source status: ${kalshiEnvelope.status}`,
    `- MLB source status: ${mlbEnvelope.status}`,
    `- Baseball Savant source status: ${baseballSavantEnvelope.status}`,
    `- Weather source status: ${weatherEnvelope.status}`,
    `- Liquidity source status: ${liquidityEnvelope.status}`,
    `- Sportsbook reference status: ${sportsbookEnvelope?.status ?? 'skipped'}`,
    `- Lineup/injury/bullpen status: ${contextEnvelope?.status ?? 'skipped'}`,
    `- MLB stats source status: ${statsEnvelope?.status ?? 'skipped'}`,
    `- Kalshi records found: ${kalshiCount}`,
    `- Kalshi rejected records: ${kalshiRejectedCount}`,
    `- MLB games found: ${mlbCount}`,
    `- Baseball Savant records found: ${baseballSavantCount}`,
    `- Weather records found: ${weatherCount}`,
    `- Liquidity records found: ${liquidityCount}`,
    `- Sportsbook reference records found: ${sportsbookCount}`,
    `- Context records found: ${contextCount}`,
    `- MLB stats records found: ${statsCount}`,
    '',
    'This is discovery only.',
    'No picks made.',
    'No trades placed.',
    '',
    '## Warnings',
    ...(warnings.length > 0 ? warnings.map(warning => `- ${warning}`) : ['- none']),
    '',
    '## Errors',
    ...(errors.length > 0 ? errors.map(error => `- ${error}`) : ['- none']),
    '',
  ].join('\n');
}

export async function runSourceAdapterDryRun(options = {}) {
  const runDate = options.date ?? formatDateInTimeZone();
  const outputDir = options.out ?? defaultDiscoveryDir(runDate);
  const fixturesOnly = options.liveReadonly ? false : options.fixturesOnly !== false;
  const mode = fixturesOnly ? 'fixtures-only' : 'live-readonly';
  const checkedAtUtc = new Date().toISOString();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? new Date();
  const requestedSource = options.source ?? 'all';
  const runKalshi = shouldRunSource(requestedSource, 'kalshi');
  const runMlb = shouldRunSource(requestedSource, 'mlb');
  const runBaseballSavant = shouldRunSource(requestedSource, 'baseball_savant');
  const runWeather = shouldRunSource(requestedSource, 'weather');
  const runLiquidity = shouldRunSource(requestedSource, 'liquidity');
  const runSportsbook = shouldRunSource(requestedSource, 'sportsbook');
  const runContext = shouldRunSource(requestedSource, 'context');
  const runStats = shouldRunSource(requestedSource, 'stats');

  const kalshiPath = `${outputDir}/kalshi_adapter.json`;
  const mlbPath = `${outputDir}/mlb_official_adapter.json`;
  const baseballSavantPath = `${outputDir}/baseball_savant_adapter.json`;
  const weatherPath = `${outputDir}/weather_adapter.json`;
  const liquidityPath = `${outputDir}/liquidity_adapter.json`;
  const sportsbookPath = `${outputDir}/sportsbook_adapter.json`;
  const contextPath = `${outputDir}/context_adapter.json`;
  const statsPath = `${outputDir}/stats_adapter.json`;
  const summaryPath = `${outputDir}/discovery_summary.md`;
  const rejectedPath = `${outputDir}/kalshi_rejected_records.json`;

  const mlbEnvelope = runMlb
    ? await fetchMlbScheduleReadonly({ runDate, outputDir, fixturesOnly, fetchImpl, now })
    : readExistingOrSkipped({
        sourceId: 'mlb_official',
        filePath: mlbPath,
        runDate,
        outputDir,
      });

  const kalshiEnvelope = runKalshi
    ? await fetchKalshiReadonly({
        runDate,
        outputDir,
        fixturesOnly,
        fetchImpl,
        now,
        officialMlbGames: safeArray(mlbEnvelope.records),
      })
    : readExistingOrSkipped({
        sourceId: 'kalshi',
        filePath: kalshiPath,
        runDate,
        outputDir,
      });

  const sportsbookEnvelope = runSportsbook
    ? await fetchSportsbookReadonly({ runDate, outputDir, fixturesOnly, fetchImpl, now })
    : readExistingOrSkipped({ sourceId: 'sportsbook_reference', filePath: sportsbookPath, runDate, outputDir });

  const sportsbookRecordsForContext = safeArray(sportsbookEnvelope?.records);
  const contextEnvelope = runContext
    ? await fetchContextReadonly({
        outputDir,
        fixturesOnly,
        fetchImpl,
        now,
        mlbGames: safeArray(mlbEnvelope.records),
        sportsbookRecords: sportsbookRecordsForContext,
      })
    : readExistingOrSkipped({ sourceId: 'lineup_injury_bullpen', filePath: contextPath, runDate, outputDir });

  const statsEnvelope = runStats
    ? await fetchStatsReadonly({
        runDate,
        outputDir,
        fixturesOnly,
        fetchImpl,
        now,
        mlbGames: safeArray(mlbEnvelope.records),
      })
    : readExistingOrSkipped({ sourceId: 'mlb_stats', filePath: statsPath, runDate, outputDir });

  const targetBatterIds = collectTargetBatterIds({ contextEnvelope, statsEnvelope, mlbEnvelope });

  const baseballSavantEnvelope = runBaseballSavant
    ? await fetchBaseballSavantReadonly({
        runDate,
        outputDir,
        fixturesOnly,
        fetchImpl,
        now,
        mlbGames: safeArray(mlbEnvelope.records),
        targetBatterIds,
      })
    : readExistingOrSkipped({
        sourceId: 'baseball_savant',
        filePath: baseballSavantPath,
        runDate,
        outputDir,
      });

  const weatherEnvelope = runWeather
    ? await fetchWeatherReadonly({
        runDate,
        outputDir,
        fixturesOnly,
        fetchImpl,
        now,
        mlbGames: safeArray(mlbEnvelope.records),
      })
    : readExistingOrSkipped({
        sourceId: 'weather',
        filePath: weatherPath,
        runDate,
        outputDir,
      });

  const kalshiTickers = safeArray(kalshiEnvelope.records)
    .flatMap(r => safeArray(r.markets).map(m => m.market_ticker).filter(Boolean));

  const liquidityEnvelope = runLiquidity
    ? await fetchLiquidityReadonly({ runDate, outputDir, fixturesOnly, fetchImpl, now, kalshiTickers })
    : readExistingOrSkipped({
        sourceId: 'liquidity',
        filePath: liquidityPath,
        runDate,
        outputDir,
      });

  const finalKalshiEnvelope = { ...kalshiEnvelope, cache_path: kalshiPath };
  const finalMlbEnvelope = { ...mlbEnvelope, cache_path: mlbPath };
  const finalBaseballSavantEnvelope = { ...baseballSavantEnvelope, cache_path: baseballSavantPath };
  const finalWeatherEnvelope = { ...weatherEnvelope, cache_path: weatherPath };
  const finalLiquidityEnvelope = { ...liquidityEnvelope, cache_path: liquidityPath };
  const rejectedRecords = Array.isArray(finalKalshiEnvelope.rejected_records)
    ? finalKalshiEnvelope.rejected_records
    : [];

  if (runKalshi) {
    writeJsonAtomic(kalshiPath, finalKalshiEnvelope);
  }
  if (runMlb) {
    writeJsonAtomic(mlbPath, finalMlbEnvelope);
  }
  if (runBaseballSavant) {
    writeJsonAtomic(baseballSavantPath, finalBaseballSavantEnvelope);
  }
  if (runWeather) {
    writeJsonAtomic(weatherPath, finalWeatherEnvelope);
  }
  if (runLiquidity) {
    writeJsonAtomic(liquidityPath, finalLiquidityEnvelope);
  }
  if (runSportsbook) {
    writeJsonAtomic(sportsbookPath, { ...sportsbookEnvelope, cache_path: sportsbookPath });
  }
  if (runContext) {
    writeJsonAtomic(contextPath, { ...contextEnvelope, cache_path: contextPath });
  }
  if (runStats) {
    writeJsonAtomic(statsPath, { ...statsEnvelope, cache_path: statsPath });
  }
  if (runKalshi && rejectedRecords.length > 0) {
    writeJsonAtomic(rejectedPath, rejectedRecords);
  }
  writeTextAtomic(
    summaryPath,
    buildSummary({
      runDate,
      checkedAtUtc,
      mode,
      kalshiEnvelope: finalKalshiEnvelope,
      mlbEnvelope: finalMlbEnvelope,
      baseballSavantEnvelope: finalBaseballSavantEnvelope,
      weatherEnvelope: finalWeatherEnvelope,
      liquidityEnvelope: finalLiquidityEnvelope,
      sportsbookEnvelope,
      contextEnvelope,
      statsEnvelope,
    }),
  );

  return {
    run_date: runDate,
    checked_at_utc: checkedAtUtc,
    mode,
    output_dir: outputDir,
    files: {
      ...(runKalshi ? { kalshi_adapter: kalshiPath } : {}),
      ...(runMlb ? { mlb_official_adapter: mlbPath } : {}),
      ...(runBaseballSavant ? { baseball_savant_adapter: baseballSavantPath } : {}),
      ...(runWeather ? { weather_adapter: weatherPath } : {}),
      ...(runLiquidity ? { liquidity_adapter: liquidityPath } : {}),
      ...(runSportsbook ? { sportsbook_adapter: sportsbookPath } : {}),
      ...(runContext ? { context_adapter: contextPath } : {}),
      ...(runStats ? { stats_adapter: statsPath } : {}),
      discovery_summary: summaryPath,
      ...(runKalshi && rejectedRecords.length > 0 ? { kalshi_rejected_records: rejectedPath } : {}),
    },
    kalshi_status: finalKalshiEnvelope.status,
    mlb_status: finalMlbEnvelope.status,
    baseball_savant_status: finalBaseballSavantEnvelope.status,
    weather_status: finalWeatherEnvelope.status,
    liquidity_status: finalLiquidityEnvelope.status,
    sportsbook_status: sportsbookEnvelope?.status ?? 'skipped',
    context_status: contextEnvelope?.status ?? 'skipped',
    stats_status: statsEnvelope?.status ?? 'skipped',
    kalshi_records: safeArray(finalKalshiEnvelope.records).length,
    kalshi_rejected_records: rejectedRecords.length,
    mlb_games: safeArray(finalMlbEnvelope.records).length,
    baseball_savant_records: safeArray(finalBaseballSavantEnvelope.records).length,
    weather_records: safeArray(finalWeatherEnvelope.records).length,
    liquidity_records: safeArray(finalLiquidityEnvelope.records).length,
    sportsbook_records: safeArray(sportsbookEnvelope?.records).length,
    context_records: safeArray(contextEnvelope?.records).length,
    stats_records: safeArray(statsEnvelope?.records).length,
    message: 'Discovery only. No picks made. No trades placed.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      process.exit(0);
    }

    const result = await runSourceAdapterDryRun(options);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exit(1);
  }
}
