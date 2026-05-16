import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeJsonAtomic, writeTextAtomic } from './file-io.mjs';
import { scoreMarkets } from './scoring-core.mjs';

export const KALSHI_BASEBALL_CALENDAR_URL = 'https://kalshi.com/calendar/sports/baseball';
const SCHEMA_VERSION = '1.0';
const OPERATOR = 'sports-pre-game';
const MARKET_LANES = Object.freeze([
  'moneyline',
  'run_line',
  'game_total',
  'yrfi_nrfi',
  'home_run_hitter',
  'pitcher_strikeouts',
]);

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function missingAdapterEnvelope({ sourceId, cachePath, warning }) {
  return {
    source_id: sourceId,
    status: 'blocked',
    checked_at_utc: null,
    cache_key: `${sourceId}_missing`,
    cache_path: cachePath,
    required: true,
    records: [],
    warnings: [warning],
    errors: [],
    source_urls: [],
  };
}

function readOptionalAdapter(filePath, sourceId, warning) {
  if (!existsSync(filePath)) {
    return missingAdapterEnvelope({ sourceId, cachePath: filePath, warning });
  }

  return readJson(filePath);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function sourceStatus(envelope, fallback = 'blocked') {
  const status = envelope?.status;
  return ['ok', 'degraded', 'blocked', 'skipped'].includes(status) ? status : fallback;
}

function pickSourceStatus(status) {
  return status === 'skipped' ? 'blocked' : status;
}

function formatGame(game) {
  return `${game.away_team ?? 'Unknown Away'} at ${game.home_team ?? 'Unknown Home'}`;
}

function marketTickers(record) {
  return safeArray(record.markets)
    .map(market => market.market_ticker)
    .filter(Boolean);
}

function listedLanes(record) {
  return [
    ...new Set(
      safeArray(record.markets)
        .map(market => market.market_lane)
        .filter(lane => MARKET_LANES.includes(lane)),
    ),
  ];
}

function recordsForGame(kalshiRecords, gamePk) {
  return kalshiRecords.filter(record => record.matched_game_pk === gamePk);
}

function buildGames({ runDate, mlbRecords, kalshiRecords, weather }) {
  return mlbRecords.map(game => {
    const records = recordsForGame(kalshiRecords, game.game_pk);
    return {
      game_pk: game.game_pk ?? null,
      game: formatGame(game),
      game_date: game.game_date ?? runDate,
      start_time_utc: game.start_time_utc ?? null,
      teams: {
        away: game.away_team ?? 'Unknown Away',
        home: game.home_team ?? 'Unknown Home',
      },
      mlb_status: game.mlb_status ?? 'unknown',
      probable_pitchers: {
        away: game.probable_pitchers?.away ?? null,
        home: game.probable_pitchers?.home ?? null,
      },
      kalshi_events: records.map(record => ({
        event_ticker: record.event_ticker ?? null,
        event_title: record.event_title ?? 'untitled',
        market_tickers: marketTickers(record),
      })),
      listed_market_lanes: [...new Set(records.flatMap(record => listedLanes(record)))],
      weather_status: sourceStatus(weather),
    };
  });
}

function buildRouterResults({ runDate, kalshiRecords }) {
  return kalshiRecords.flatMap(record =>
    safeArray(record.markets).map(market => ({
      route_status: market.route_status ?? 'BLOCKED',
      market_lane: market.market_lane ?? null,
      candidate_lanes: safeArray(market.candidate_lanes),
      kalshi_url: null,
      event_ticker: record.event_ticker ?? null,
      market_ticker: market.market_ticker ?? null,
      event_title: record.event_title ?? null,
      market_title: market.market_title ?? null,
      contract_title: market.contract_title ?? null,
      game_date: runDate,
      teams: {
        away: null,
        home: null,
      },
      player_name: null,
      threshold: null,
      side_hint: null,
      confidence: market.route_status === 'ROUTED' ? 70 : 0,
      matched_signals: market.market_lane ? [`adapter routed ${market.market_lane}`] : [],
      reject_signals: market.route_status === 'ROUTED' ? [] : ['not routed by discovery adapter'],
      needed_clarification: market.route_status === 'ROUTED' ? [] : ['Need full Kalshi rules/title context'],
      next_workflow: 'runbooks/mlb-prediction-process.md',
      notes: ['Discovery-only router result; no prediction created.'],
    })),
  );
}

function buildExcludedMarkets(kalshi) {
  return safeArray(kalshi.rejected_records).map(record => ({
    market_title: record.event_title ?? 'untitled rejected Kalshi record',
    market_ticker: null,
    route_status: 'OUT_OF_SCOPE',
    reason: record.reason ?? 'Rejected by same-day MLB discovery filter',
    needed_clarification: [],
  }));
}

function buildSlateManifest({ runDate, generatedAtUtc, kalshi, mlb, baseballSavant, weather, liquidity, sportsbook, context }) {
  const kalshiRecords = safeArray(kalshi.records);
  const mlbRecords = safeArray(mlb.records);
  const savantRecords = safeArray(baseballSavant.records);
  const weatherRecords = safeArray(weather.records);
  return {
    schema_version: SCHEMA_VERSION,
    run_date: runDate,
    generated_at_utc: generatedAtUtc,
    operator: OPERATOR,
    kalshi_calendar_url: KALSHI_BASEBALL_CALENDAR_URL,
    source_timestamps: {
      kalshi: kalshi.checked_at_utc ?? null,
      mlb_official: mlb.checked_at_utc ?? null,
      baseball_savant: baseballSavant.checked_at_utc ?? null,
      weather: weather.checked_at_utc ?? null,
      liquidity: liquidity.checked_at_utc ?? null,
      sportsbook_reference: sportsbook?.checked_at_utc ?? null,
      lineup_injury_bullpen: context?.checked_at_utc ?? null,
      optional_price_sanity: null,
    },
    games: buildGames({ runDate, mlbRecords, kalshiRecords, weather }),
    router_results: buildRouterResults({ runDate, kalshiRecords }),
    unmatched_or_excluded_markets: buildExcludedMarkets(kalshi),
    notes: [
      'Dry-run output composed from existing discovery files only.',
      `Kalshi same-day records kept: ${kalshiRecords.length}.`,
      `Kalshi rejected diagnostic records: ${safeArray(kalshi.rejected_records).length}.`,
      `Baseball Savant adapter status: ${sourceStatus(baseballSavant)}; records: ${savantRecords.length}.`,
      `Weather adapter status: ${sourceStatus(weather)}; records: ${weatherRecords.length}.`,
      `Liquidity adapter status: ${sourceStatus(liquidity)}; records: ${safeArray(liquidity.records).length}.`,
      'No live picks made. No trades placed.',
    ],
  };
}

function sourceEntry({
  sourceId,
  dataNeed,
  recommendedSource,
  backupSource,
  accessMethod,
  reliabilityGrade,
  dailyRepeatability,
  limitations,
  status,
  lastCheckedUtc,
  required,
  urls = [],
}) {
  return {
    source_id: sourceId,
    data_need: dataNeed,
    recommended_source: recommendedSource,
    backup_source: backupSource,
    access_method: accessMethod,
    reliability_grade: reliabilityGrade,
    daily_repeatability: dailyRepeatability,
    limitations,
    status,
    last_checked_utc: lastCheckedUtc,
    required,
    urls,
  };
}

function combinedLimitations(envelope, fallback) {
  const warnings = safeArray(envelope.warnings);
  const errors = safeArray(envelope.errors);
  return [...warnings, ...errors.map(error => `Error: ${error}`)].join('; ') || fallback;
}

function buildSourceRegistry({ runDate, generatedAtUtc, kalshi, mlb, baseballSavant, weather, liquidity, sportsbook, context }) {
  const kalshiStatus = sourceStatus(kalshi);
  const mlbStatus = sourceStatus(mlb);
  const savantStatus = sourceStatus(baseballSavant);
  const weatherStatus = sourceStatus(weather);
  const kalshiRecords = safeArray(kalshi.records);
  const savantRecords = safeArray(baseballSavant.records);
  const weatherRecords = safeArray(weather.records);
  const rejectedCount = safeArray(kalshi.rejected_records).length;
  const sourceGaps = [];

  const kalshiEffectivelyOk = kalshiStatus === 'ok' || (kalshiStatus === 'degraded' && kalshiRecords.length > 0);
  if (!kalshiEffectivelyOk) {
    sourceGaps.push({
      source_id: 'kalshi',
      gap: `Kalshi same-day game market discovery kept ${kalshiRecords.length} records; rejected diagnostic count ${rejectedCount}.`,
      affected_market_lanes: [...MARKET_LANES],
      handling: 'Do not create final picks. Re-run live-readonly discovery or refresh closer to first pitch.',
    });
  }

  if (savantStatus !== 'ok' || savantRecords.length === 0) {
    sourceGaps.push({
      source_id: 'baseball_savant',
      gap: `Baseball Savant adapter status ${savantStatus}; records ${savantRecords.length}.`,
      affected_market_lanes: [...MARKET_LANES],
      handling: 'Do not create final picks until usable Statcast evidence records are available.',
    });
  }

  if (weatherStatus !== 'ok' || weatherRecords.length === 0) {
    sourceGaps.push({
      source_id: 'weather',
      gap: `Weather adapter status ${weatherStatus}; records ${weatherRecords.length}.`,
      affected_market_lanes: ['game_total', 'yrfi_nrfi', 'home_run_hitter'],
      handling: 'Do not create weather-sensitive picks until usable weather records are available.',
    });
  }

  if (sourceStatus(liquidity) === 'blocked') {
    sourceGaps.push({
      source_id: 'liquidity',
      gap: `Liquidity adapter status blocked; ${safeArray(liquidity.records).length} records.`,
      affected_market_lanes: ['moneyline', 'run_line', 'game_total', 'yrfi_nrfi', 'home_run_hitter', 'pitcher_strikeouts'],
      handling: 'Market classified NOT_TRADEABLE until liquidity data is available.',
    });
  }

  return {
    schema_version: SCHEMA_VERSION,
    run_date: runDate,
    generated_at_utc: generatedAtUtc,
    operator: OPERATOR,
    sources: [
      sourceEntry({
        sourceId: 'kalshi',
        dataNeed: 'Tradable markets, rules, available contracts, bid/ask, liquidity, and order books',
        recommendedSource: 'Kalshi baseball calendar and public read-only Trade API discovery',
        backupSource: 'Manual Kalshi UI review if public discovery is challenge-gated',
        accessMethod: 'Existing discovery adapter JSON from public/read-only GET attempts',
        reliabilityGrade: 'A',
        dailyRepeatability: 'Daily, subject to UI challenge gates and public endpoint availability',
        limitations: safeArray(kalshi.warnings).join('; ') || 'Kalshi proves tradability only, not baseball truth.',
        status: kalshiStatus,
        lastCheckedUtc: kalshi.checked_at_utc ?? null,
        required: true,
        urls: safeArray(kalshi.source_urls),
      }),
      sourceEntry({
        sourceId: 'mlb_official',
        dataNeed: 'Schedule, official game IDs, teams, status, probable pitchers, venue, and start times',
        recommendedSource: 'Official MLB Stats API / MLB Gameday',
        backupSource: 'MLB.com scoreboard',
        accessMethod: 'Existing MLB official adapter JSON',
        reliabilityGrade: 'A',
        dailyRepeatability: 'Daily public API access',
        limitations: safeArray(mlb.warnings).join('; ') || 'Official schedule source; not a betting or player-prop model.',
        status: mlbStatus,
        lastCheckedUtc: mlb.checked_at_utc ?? null,
        required: true,
        urls: safeArray(mlb.source_urls),
      }),
      sourceEntry({
        sourceId: 'baseball_savant',
        dataNeed: 'Batter/pitcher splits, K%, barrel rate, hard-hit rate, HR profiles, pitch mix, and workload',
        recommendedSource: 'Baseball Savant / Statcast',
        backupSource: 'FanGraphs or MLB Stats API derived stats when explicitly implemented later',
        accessMethod: 'Existing Baseball Savant adapter JSON from discovery folder',
        reliabilityGrade: 'A-',
        dailyRepeatability: 'Daily when adapter discovery file is present; fixture mode is placeholder only',
        limitations: combinedLimitations(
          baseballSavant,
          'Baseball Savant adapter file present; records are discovery/evidence inputs only and do not authorize picks.',
        ),
        status: savantStatus,
        lastCheckedUtc: baseballSavant.checked_at_utc ?? null,
        required: true,
        urls: safeArray(baseballSavant.source_urls),
      }),
      sourceEntry({
        sourceId: 'weather',
        dataNeed: 'Wind, temperature, rain/postponement risk, roof, and weather-sensitive run environment',
        recommendedSource: 'National Weather Service API',
        backupSource: 'Venue roof/status notes and official game status once implemented',
        accessMethod: 'Existing weather adapter JSON from discovery folder',
        reliabilityGrade: 'A-',
        dailyRepeatability: 'Daily when adapter discovery file is present; fixture mode is placeholder only',
        limitations: combinedLimitations(
          weather,
          'Weather adapter file present; records are environment inputs only and do not authorize picks.',
        ),
        status: weatherStatus,
        lastCheckedUtc: weather.checked_at_utc ?? null,
        required: true,
        urls: safeArray(weather.source_urls),
      }),
      sourceEntry({
        sourceId: 'liquidity',
        dataNeed: 'Kalshi market bid/ask, spread, volume, open interest',
        recommendedSource: 'Kalshi public trade API (read-only)',
        backupSource: 'Manual Kalshi UI review',
        accessMethod: 'Existing liquidity adapter JSON from discovery folder',
        reliabilityGrade: 'B+',
        dailyRepeatability: 'Daily when adapter file present; fixture mode is placeholder only',
        limitations: combinedLimitations(liquidity, 'Liquidity adapter present; order book inputs only.'),
        status: sourceStatus(liquidity),
        lastCheckedUtc: liquidity.checked_at_utc ?? null,
        required: false,
        urls: safeArray(liquidity.source_urls),
      }),
      sourceEntry({
        sourceId: 'sportsbook_reference',
        dataNeed: 'No-vig reference fair values from DraftKings/ESPN for edge comparison vs Kalshi ask',
        recommendedSource: 'ESPN scoreboard API (DraftKings odds)',
        backupSource: 'Manual DraftKings check',
        accessMethod: 'Existing sportsbook adapter JSON from discovery folder',
        reliabilityGrade: 'A-',
        dailyRepeatability: 'Daily when adapter discovery file is present',
        limitations: combinedLimitations(sportsbook, 'Reference only; not Kalshi prices; not executable.'),
        status: sourceStatus(sportsbook),
        lastCheckedUtc: sportsbook?.checked_at_utc ?? null,
        required: false,
        urls: safeArray(sportsbook?.source_urls),
      }),
      sourceEntry({
        sourceId: 'lineup_injury_bullpen',
        dataNeed: 'Lineup confirmation, injury list, probable pitcher stats, bullpen workload',
        recommendedSource: 'MLB live feed API + ESPN summary API',
        backupSource: 'Manual lineup check',
        accessMethod: 'Existing context adapter JSON from discovery folder',
        reliabilityGrade: 'B+',
        dailyRepeatability: 'Daily; lineup_pending is a normal pre-game state, not a hard block',
        limitations: combinedLimitations(context, 'Lineup/injury context only; not a trade signal.'),
        status: sourceStatus(context),
        lastCheckedUtc: context?.checked_at_utc ?? null,
        required: false,
        urls: safeArray(context?.source_urls),
      }),
      sourceEntry({
        sourceId: 'optional_price_sanity',
        dataNeed: 'Optional external price sanity check',
        recommendedSource: 'None required',
        backupSource: null,
        accessMethod: 'Not called by Stage 3 dry-run',
        reliabilityGrade: 'unknown',
        dailyRepeatability: 'Optional; never blocks workflow',
        limitations: 'Not required and not used to prove Kalshi availability.',
        status: 'skipped',
        lastCheckedUtc: null,
        required: false,
        urls: [],
      }),
    ],
    source_gaps: sourceGaps,
    notes: ['Source registry composed from existing discovery files only. No live fetches performed.'],
  };
}

function emptySummaryCounts() {
  return {
    total: 0,
    clear_pick: 0,
    watch_for_listing: 0,
    not_tradeable: 0,
    lean: 0,
    pass: 0,
    blocked: 0,
  };
}

function buildPicks({ runDate, generatedAtUtc, kalshi, mlb, baseballSavant, weather, liquidity, sportsbook, context, scoring }) {
  return {
    schema_version: SCHEMA_VERSION,
    run_date: runDate,
    generated_at_utc: generatedAtUtc,
    operator: OPERATOR,
    source_health: {
      kalshi: pickSourceStatus(sourceStatus(kalshi)),
      mlb_official: pickSourceStatus(sourceStatus(mlb)),
      baseball_savant: pickSourceStatus(sourceStatus(baseballSavant)),
      weather: pickSourceStatus(sourceStatus(weather)),
      liquidity: pickSourceStatus(sourceStatus(liquidity)),
      sportsbook_reference: pickSourceStatus(sourceStatus(sportsbook)),
      lineup_injury_bullpen: pickSourceStatus(sourceStatus(context)),
      optional_price_sanity: 'skipped',
    },
    summary_counts: scoring.counts,
    picks: scoring.candidates,
    notes: [
      'Discovery-only output writer dry-run.',
      scoring.fixture_mode
        ? 'Fixture mode: no CLEAR_PICK generated. Replace fixture adapters with live evidence before production use.'
        : 'Live-readonly mode: CLEAR_PICK requires all evidence gates to pass.',
      `Scored ${scoring.counts.total} market candidates: ${scoring.counts.clear_pick} CLEAR_PICK, ${scoring.counts.lean} LEAN, ${scoring.counts.watch_for_listing} WATCH_FOR_LISTING, ${scoring.counts.blocked} BLOCKED, ${scoring.counts.not_tradeable} NOT_TRADEABLE.`,
      'No live picks made. No trades placed.',
    ],
  };
}

function tableEscape(value) {
  return String(value ?? '').replace(/\|/g, '/');
}

function guideSourceStatus({ kalshi, mlb, baseballSavant, weather, liquidity, sportsbook, context }) {
  return [
    '## Source Health',
    '',
    `- Kalshi: ${sourceStatus(kalshi)}`,
    `- MLB official: ${sourceStatus(mlb)}`,
    `- Baseball Savant: ${sourceStatus(baseballSavant)}`,
    `- Weather: ${sourceStatus(weather)}`,
    `- Liquidity: ${sourceStatus(liquidity)}`,
    `- Sportsbook reference: ${sourceStatus(sportsbook)}`,
    `- Lineup/injury/bullpen: ${sourceStatus(context)}`,
    '- Optional price sanity: skipped',
    `- Kalshi records kept: ${safeArray(kalshi.records).length}`,
    `- Kalshi rejected diagnostic records: ${safeArray(kalshi.rejected_records).length}`,
    `- Baseball Savant records: ${safeArray(baseballSavant.records).length}`,
    `- Weather records: ${safeArray(weather.records).length}`,
    `- Liquidity records: ${safeArray(liquidity.records).length}`,
    `- Sportsbook reference records: ${safeArray(sportsbook?.records).length}`,
    `- Context records: ${safeArray(context?.records).length}`,
    `- Kalshi warnings: ${safeArray(kalshi.warnings).join('; ') || 'none'}`,
    `- Baseball Savant warnings: ${safeArray(baseballSavant.warnings).join('; ') || 'none'}`,
    `- Baseball Savant errors: ${safeArray(baseballSavant.errors).join('; ') || 'none'}`,
    `- Weather warnings: ${safeArray(weather.warnings).join('; ') || 'none'}`,
    `- Weather errors: ${safeArray(weather.errors).join('; ') || 'none'}`,
    `- Liquidity warnings: ${safeArray(liquidity.warnings).join('; ') || 'none'}`,
    `- Liquidity errors: ${safeArray(liquidity.errors).join('; ') || 'none'}`,
    `- Sportsbook warnings: ${safeArray(sportsbook?.warnings).join('; ') || 'none'}`,
    `- Context warnings: ${safeArray(context?.warnings).join('; ') || 'none'}`,
    '',
  ];
}

function guideSlateOverview({ games, kalshi, baseballSavant, weather }) {
  const lines = [
    '## Slate Overview',
    '',
    '| Game | Start | Kalshi markets listed | MLB status | Weather note | Source status |',
    '|---|---|---|---|---|---|',
  ];

  for (const game of games) {
    const listed = game.listed_market_lanes.length > 0 ? game.listed_market_lanes.join(', ') : 'none';
    const weatherNote = sourceStatus(weather) === 'ok' ? 'adapter checked' : 'not checked';
    lines.push(
      `| ${tableEscape(game.game)} | ${game.start_time_utc ?? ''} | ${listed} | ${tableEscape(game.mlb_status)} | ${weatherNote} | MLB ok; Kalshi ${sourceStatus(kalshi)}; Savant ${sourceStatus(baseballSavant)}; weather ${sourceStatus(weather)} |`,
    );
  }

  if (games.length === 0) {
    lines.push('| none |  | none | no MLB games found | not checked | blocked |');
  }

  lines.push('');
  return lines;
}

function missingBeforeFullGuide(baseballSavant, weather, liquidity, sportsbook) {
  const missing = ['morning scan composer'];
  if (sourceStatus(liquidity) !== 'ok' || safeArray(liquidity.records).length === 0) {
    missing.unshift('liquidity/order book');
  }
  if (sourceStatus(baseballSavant) !== 'ok' || safeArray(baseballSavant.records).length === 0) {
    missing.unshift('usable Savant/Statcast evidence');
  }
  if (sourceStatus(weather) !== 'ok' || safeArray(weather.records).length === 0) {
    missing.unshift('usable weather evidence');
  }
  if (sourceStatus(sportsbook) !== 'ok' || safeArray(sportsbook?.records).length === 0) {
    missing.unshift('sportsbook reference prices');
  }
  return missing.join(', ');
}

function buildDailyGuide({ runDate, generatedAtUtc, kalshi, mlb, baseballSavant, weather, liquidity, sportsbook, context, scoring, slateManifest }) {
  const blockedCandidates = safeArray(scoring.candidates).filter(c => c.classification === 'BLOCKED_SOURCE_GAP');
  const leanCandidates = safeArray(scoring.candidates).filter(c => c.classification === 'LEAN');
  const watchForPriceCandidates = safeArray(scoring.candidates).filter(c => c.classification === 'WATCH_FOR_PRICE');
  const clearPickCandidates = safeArray(scoring.candidates).filter(c => c.classification === 'CLEAR_PICK');
  const correlatedAlternateCandidates = safeArray(scoring.candidates).filter(c => c.classification === 'CORRELATED_ALTERNATE');

  const clearPickRows = clearPickCandidates.length > 0
    ? clearPickCandidates.map(c =>
        `| ${tableEscape(c.market_ticker ?? c.market_title ?? 'unknown')} | ${tableEscape(c.game ?? '')} | ${c.total_strike ?? 'n/a'} | ${c.fair_value ?? 'n/a'} | ${c.kalshi_ask ?? 'n/a'} | ${c.edge_pp !== null ? `${c.edge_pp}pp` : 'n/a'} |`,
      )
    : ['| none |  |  |  |  |  |'];

  const correlatedAlternateRows = correlatedAlternateCandidates.length > 0
    ? correlatedAlternateCandidates.map(c =>
        `| ${tableEscape(c.market_ticker ?? c.market_title ?? 'unknown')} | ${tableEscape(c.correlation_group ?? '')} | ${c.total_strike ?? 'n/a'} | ${c.kalshi_ask ?? 'n/a'} | ${c.edge_pp !== null ? `${c.edge_pp}pp` : 'n/a'} |`,
      )
    : ['| none |  |  |  |  |'];

  const blockedRows = blockedCandidates.length > 0
    ? blockedCandidates.map(c => `| ${tableEscape(c.market_ticker ?? c.market_title ?? 'unknown')} | ${tableEscape(safeArray(c.missing_sources).join(', ') || 'source gap')} | Re-run discovery or wait for source availability |`)
    : [
        '| Full daily prediction guide | Morning scan composer, and usable source evidence when unavailable | Implement remaining composer stages before final picks |',
        '| Kalshi tradable MLB board | Valid same-day Kalshi records | Re-run discovery closer to first pitch or inspect Kalshi UI manually |',
      ];

  const leanRows = leanCandidates.length > 0
    ? leanCandidates.map(c => `| ${tableEscape(c.market_ticker ?? c.market_title ?? 'unknown')} | ${tableEscape(c.lean_reason ?? '')} | ${tableEscape(safeArray(c.missing_evidence).join(', ') || '')} | ${tableEscape(c.needed_trigger ?? '')} |`)
    : ['| none |  |  |  |'];

  const watchForPriceRows = watchForPriceCandidates.length > 0
    ? watchForPriceCandidates.map(c => `| ${tableEscape(c.market_ticker ?? c.market_title ?? 'unknown')} | ${tableEscape(c.watch_reason ?? '')} | ${tableEscape(c.target_price ?? '')} | ${tableEscape(c.recheck_time ?? '')} |`)
    : ['| none |  |  |  |'];

  const lines = [
    `# Daily Baseball Guide - ${runDate}`,
    '',
    `- Generated UTC: ${generatedAtUtc}`,
    '- Discovery only.',
    '- No final picks.',
    '- No trades placed.',
    `- Kalshi same-day market discovery found ${safeArray(kalshi.records).length} valid records.`,
    `- Missing before full guide: ${missingBeforeFullGuide(baseballSavant, weather, liquidity, sportsbook)}.`,
    '',
    ...guideSourceStatus({ kalshi, mlb, baseballSavant, weather, liquidity, sportsbook, context }),
    ...guideSlateOverview({ games: slateManifest.games, kalshi, baseballSavant, weather }),
    '## Scoring Summary',
    '',
    `- Total candidates scored: ${scoring.counts.total}`,
    `- CLEAR_PICK: ${scoring.counts.clear_pick}`,
    `- LEAN: ${scoring.counts.lean}`,
    `- WATCH_FOR_LISTING: ${scoring.counts.watch_for_listing}`,
    `- PASS: ${scoring.counts.pass}`,
    `- BLOCKED: ${scoring.counts.blocked}`,
    `- NOT_TRADEABLE: ${scoring.counts.not_tradeable}`,
    `- CORRELATED_ALTERNATE: ${scoring.counts.correlated_alternate ?? 0}`,
    `- Fixture mode: ${scoring.fixture_mode}`,
    '',
    '## Clear Picks',
    '',
    '| Market | Game | Strike | Fair | Ask | Edge |',
    '|---|---|---:|---:|---:|---:|',
    ...clearPickRows,
    '',
    '## Watch For Listing',
    '',
    '| Player/market | Game | Research edge | Missing Kalshi prop | Recheck time | Trigger |',
    '|---|---|---|---|---|---|',
    '',
    '## Not Tradeable',
    '',
    '| Market | Reason | Spread | Depth | Last update | Recheck |',
    '|---|---|---:|---:|---|---|',
    '',
    '## Leans',
    '',
    '| Market | Why interesting | Missing evidence | Needed trigger |',
    '|---|---|---|---|',
    ...leanRows,
    '',
    '## Watch For Price',
    '',
    '| Market | Why watching | Target price | Recheck time |',
    '|---|---|---|---|',
    ...watchForPriceRows,
    '',
    '## Correlated Alternates',
    '',
    '| Market | Group | Strike | Ask | Edge |',
    '|---|---|---:|---:|---:|',
    ...correlatedAlternateRows,
    '',
    '## Passes',
    '',
    '| Market | Primary reason |',
    '|---|---|',
    '',
    '## Blocked',
    '',
    '| Market | Missing source | Next action |',
    '|---|---|---|',
    ...blockedRows,
    '',
    '## Run Notes',
    '',
    '- No live sources were fetched by the output writer.',
    '- No valid same-day Kalshi markets were available in discovery input.',
    '- Picks file reflects scored candidates from scoring-core.',
    '- No live picks made.',
    '- No trades placed.',
  ];

  return lines.join('\n');
}

function buildRunLog({ runDate, generatedAtUtc, kalshi, mlb, baseballSavant, weather, liquidity, sportsbook, context, outDir, outputPaths }) {
  const kalshiRecords = safeArray(kalshi.records);
  const rejectedCount = safeArray(kalshi.rejected_records).length;
  const writes = Object.values(outputPaths).map(filePath => `| ${filePath} | ${generatedAtUtc} | ok |`);

  return [
    `# MLB Run Log - ${runDate}`,
    '',
    '## Run Metadata',
    `- Operator: ${OPERATOR}`,
    `- Started UTC: ${generatedAtUtc}`,
    `- Run date: ${runDate}`,
    `- Run folder: ${outDir}/`,
    `- Schema version: ${SCHEMA_VERSION}`,
    '- Mode: output-writer-dry-run',
    '',
    '## Source Checks',
    '| Source | Status | Checked UTC | Access method | Limitation |',
    '|---|---|---|---|---|',
    `| Kalshi | ${sourceStatus(kalshi)} | ${kalshi.checked_at_utc ?? ''} | Existing discovery JSON | ${tableEscape(safeArray(kalshi.warnings).join('; ') || 'Tradability only')} |`,
    `| MLB official | ${sourceStatus(mlb)} | ${mlb.checked_at_utc ?? ''} | Existing discovery JSON | ${tableEscape(safeArray(mlb.warnings).join('; ') || 'Schedule/status only')} |`,
    `| Baseball Savant | ${sourceStatus(baseballSavant)} | ${baseballSavant.checked_at_utc ?? ''} | Existing discovery JSON | ${tableEscape(combinedLimitations(baseballSavant, 'Discovery/evidence inputs only'))} |`,
    `| Weather | ${sourceStatus(weather)} | ${weather.checked_at_utc ?? ''} | Existing discovery JSON | ${tableEscape(combinedLimitations(weather, 'Environment inputs only'))} |`,
    `| Liquidity | ${sourceStatus(liquidity)} | ${liquidity.checked_at_utc ?? ''} | Existing discovery JSON | ${tableEscape(combinedLimitations(liquidity, 'Order book inputs only'))} |`,
    `| Sportsbook reference | ${sourceStatus(sportsbook)} | ${sportsbook?.checked_at_utc ?? ''} | Existing discovery JSON | ${tableEscape(combinedLimitations(sportsbook, 'Reference only; not executable'))} |`,
    `| Lineup/injury/bullpen | ${sourceStatus(context)} | ${context?.checked_at_utc ?? ''} | Existing discovery JSON | ${tableEscape(combinedLimitations(context, 'Context only; not a trade signal'))} |`,
    '| Optional price sanity | skipped |  | Not called | Optional only |',
    '',
    '## Kalshi Intake',
    '| Event | Market | Ticker | Status | Notes |',
    '|---|---|---|---|---|',
    kalshiRecords.length > 0
      ? kalshiRecords.map(record => `| ${tableEscape(record.event_title)} | captured | ${record.event_ticker ?? ''} | listed | Discovery only |`).join('\n')
      : `| none | none |  | degraded | No valid same-day Kalshi records found; rejected diagnostic count ${rejectedCount} |`,
    '',
    '## Router Results',
    '| Market | Route status | Lane | Candidates | Needed clarification |',
    '|---|---|---|---|---|',
    '| none |  |  |  | No Kalshi same-day markets to route |',
    '',
    '## Prediction Status Changes',
    '| Time UTC | ID | Old status | New status | Reason |',
    '|---|---|---|---|---|',
    '| none |  |  |  | No pick candidates were created |',
    '',
    '## Failure Handling',
    '| Case | Item | Handling | Next action |',
    '|---|---|---|---|',
    '| kalshi_discovery_degraded | Same-day Kalshi MLB board | No final picks | Re-run live-readonly discovery or inspect Kalshi UI closer to first pitch |',
    `| statcast_adapter_status | Baseball Savant/Statcast | Status ${sourceStatus(baseballSavant)} with ${safeArray(baseballSavant.records).length} records; no final picks | Refresh adapter or keep blocked until usable evidence exists |`,
    `| weather_adapter_status | Weather | Status ${sourceStatus(weather)} with ${safeArray(weather.records).length} records; no final picks | Refresh adapter or keep blocked until usable evidence exists |`,
    '| missing_liquidity | Order book/liquidity | Block tradeability gate | Implement liquidity enrichment |',
    '',
    '## Output Writes',
    '| File | Wrote UTC | Status |',
    '|---|---|---|',
    ...writes,
    '',
    '## No-Trade Confirmation',
    '- No live picks placed.',
    '- No trades placed.',
    '- Output writer read local discovery files only.',
  ].join('\n');
}

function buildExecutionBoard({ runDate, generatedAtUtc, scoring, slateManifest, sportsbook, context, weather }) {
  const now = new Date(generatedAtUtc);
  const chicagoTime = now.toLocaleString('en-US', { timeZone: 'America/Chicago' });
  const byClass = (cls) => safeArray(scoring.candidates).filter(c => c.classification === cls);
  return {
    schema_version: '1.0',
    run_date: runDate,
    generated_at_utc: generatedAtUtc,
    generated_america_chicago: chicagoTime,
    no_trades_placed: true,
    automated_trade_execution_called: false,
    source_health: {
      mlb_official: sourceStatus(slateManifest.source_timestamps ? 'ok' : 'unknown'),
      kalshi_api: 'ok',
      sportsbook_reference: sourceStatus(sportsbook),
      lineup_injury_bullpen: sourceStatus(context),
      weather: sourceStatus(weather),
      trade_execution: 'not_called',
    },
    summary_counts: scoring.counts,
    games: slateManifest.games ?? [],
    candidates: scoring.candidates,
    clear_picks: byClass('CLEAR_PICK'),
    leans: byClass('LEAN'),
    watch_for_price: byClass('WATCH_FOR_PRICE'),
    watch_for_listing: byClass('WATCH_FOR_LISTING'),
    passes: byClass('PASS'),
    blocked: byClass('BLOCKED_SOURCE_GAP'),
    correlated_alternates: byClass('CORRELATED_ALTERNATE'),
    safety: [
      'No trades placed.',
      'No CLEAR_PICK emitted without all evidence gates passing.',
      'Sportsbook prices are reference-only no-vig fair values, not Kalshi prices.',
      'All picks require manual review before any action.',
    ],
  };
}

function buildExecutionBoardMd({ runDate, generatedAtUtc, scoring, slateManifest, sportsbook, context, weather }) {
  const board = buildExecutionBoard({ runDate, generatedAtUtc, scoring, slateManifest, sportsbook, context, weather });
  const counts = board.summary_counts;
  const lines = [
    `# Execution Board - ${runDate}`,
    '',
    `- Generated UTC: ${generatedAtUtc}`,
    `- Generated Chicago: ${board.generated_america_chicago}`,
    '- No trades placed.',
    '- Automated trade execution: not called.',
    '',
    '## Source Health',
    '',
    `- MLB official: ${board.source_health.mlb_official}`,
    `- Kalshi API: ${board.source_health.kalshi_api}`,
    `- Sportsbook reference: ${board.source_health.sportsbook_reference}`,
    `- Lineup/injury/bullpen: ${board.source_health.lineup_injury_bullpen}`,
    `- Weather: ${board.source_health.weather}`,
    `- Trade execution: ${board.source_health.trade_execution}`,
    '',
    '## Summary Counts',
    '',
    `- Total: ${counts.total ?? 0}`,
    `- CLEAR_PICK: ${counts.clear_pick ?? 0}`,
    `- LEAN: ${counts.lean ?? 0}`,
    `- WATCH_FOR_LISTING: ${counts.watch_for_listing ?? 0}`,
    `- PASS: ${counts.pass ?? 0}`,
    `- BLOCKED: ${counts.blocked ?? 0}`,
    `- NOT_TRADEABLE: ${counts.not_tradeable ?? 0}`,
    `- CORRELATED_ALTERNATE: ${counts.correlated_alternate ?? 0}`,
    '',
    '## Clear Picks',
    board.clear_picks.length === 0
      ? '- none'
      : board.clear_picks.map(c =>
          `- ${c.market_ticker ?? c.market_title ?? 'unknown'} (strike ${c.total_strike ?? 'n/a'}, ask ${c.kalshi_ask ?? 'n/a'}, edge ${c.edge_pp !== null ? `${c.edge_pp}pp` : 'n/a'})`,
        ).join('\n'),
    '',
    '## Leans',
    board.leans.length === 0 ? '- none' : board.leans.map(c => `- ${c.market_ticker ?? c.market_title ?? 'unknown'}`).join('\n'),
    '',
    '## Watch For Price',
    board.watch_for_price.length === 0 ? '- none' : board.watch_for_price.map(c => `- ${c.market_ticker ?? c.market_title ?? 'unknown'}`).join('\n'),
    '',
    '## Correlated Alternates',
    board.correlated_alternates.length === 0
      ? '- none'
      : board.correlated_alternates.map(c =>
          `- ${c.market_ticker ?? c.market_title ?? 'unknown'} (strike ${c.total_strike ?? 'n/a'}, ask ${c.kalshi_ask ?? 'n/a'}, edge ${c.edge_pp !== null ? `${c.edge_pp}pp` : 'n/a'})`,
        ).join('\n'),
    '',
    '## Safety',
    ...board.safety.map(s => `- ${s}`),
  ];
  return lines.join('\n');
}

function validateDiscoveryInputs({ kalshiPath, mlbPath }) {
  if (!existsSync(kalshiPath)) {
    throw new Error(`Missing Kalshi discovery file: ${kalshiPath}`);
  }
  if (!existsSync(mlbPath)) {
    throw new Error(`Missing MLB official discovery file: ${mlbPath}`);
  }
}

export function composeMlbDailyOutputs({
  runDate,
  discoveryDir = `state/mlb/${runDate}/discovery`,
  outDir = `state/mlb/${runDate}`,
  now = new Date(),
} = {}) {
  if (!runDate) {
    throw new Error('runDate is required.');
  }

  const generatedAtUtc = now.toISOString();
  const kalshiPath = resolve(discoveryDir, 'kalshi_adapter.json');
  const mlbPath = resolve(discoveryDir, 'mlb_official_adapter.json');
  const baseballSavantPath = resolve(discoveryDir, 'baseball_savant_adapter.json');
  const weatherPath = resolve(discoveryDir, 'weather_adapter.json');
  const liquidityPath = resolve(discoveryDir, 'liquidity_adapter.json');
  const sportsbookPath = resolve(discoveryDir, 'sportsbook_adapter.json');
  const contextPath = resolve(discoveryDir, 'context_adapter.json');
  validateDiscoveryInputs({ kalshiPath, mlbPath });

  const kalshi = readJson(kalshiPath);
  const mlb = readJson(mlbPath);
  const baseballSavant = readOptionalAdapter(
    baseballSavantPath,
    'baseball_savant',
    `Baseball Savant adapter output is missing at ${baseballSavantPath}.`,
  );
  const weather = readOptionalAdapter(
    weatherPath,
    'weather',
    `Weather adapter output is missing at ${weatherPath}.`,
  );
  const liquidity = readOptionalAdapter(
    liquidityPath,
    'liquidity',
    `Liquidity adapter output is missing at ${liquidityPath}.`,
  );
  const sportsbook = readOptionalAdapter(
    sportsbookPath,
    'sportsbook_reference',
    `Sportsbook adapter output missing at ${sportsbookPath}.`,
  );
  const context = readOptionalAdapter(
    contextPath,
    'lineup_injury_bullpen',
    `Context adapter output missing at ${contextPath}.`,
  );

  const scoring = scoreMarkets({ kalshi, mlb, baseballSavant, weather, liquidity, sportsbook, context });

  const outputPaths = {
    slate_manifest: `${outDir}/slate_manifest.json`,
    source_registry: `${outDir}/source_registry.json`,
    picks: `${outDir}/picks.json`,
    daily_baseball_guide: `${outDir}/daily-baseball-guide.md`,
    run_log: `${outDir}/run_log.md`,
    today_execution_board: `${outDir}/today-execution-board.json`,
    today_execution_board_md: `${outDir}/today-execution-board.md`,
  };

  const slateManifest = buildSlateManifest({ runDate, generatedAtUtc, kalshi, mlb, baseballSavant, weather, liquidity, sportsbook, context });
  const sourceRegistry = buildSourceRegistry({ runDate, generatedAtUtc, kalshi, mlb, baseballSavant, weather, liquidity, sportsbook, context });
  const picks = buildPicks({ runDate, generatedAtUtc, kalshi, mlb, baseballSavant, weather, liquidity, sportsbook, context, scoring });
  const dailyGuide = buildDailyGuide({ runDate, generatedAtUtc, kalshi, mlb, baseballSavant, weather, liquidity, sportsbook, context, scoring, slateManifest });
  const runLog = buildRunLog({ runDate, generatedAtUtc, kalshi, mlb, baseballSavant, weather, liquidity, sportsbook, context, outDir, outputPaths });
  const executionBoard = buildExecutionBoard({ runDate, generatedAtUtc, scoring, slateManifest, sportsbook, context, weather });
  const executionBoardMd = buildExecutionBoardMd({ runDate, generatedAtUtc, scoring, slateManifest, sportsbook, context, weather });

  const written = {
    slate_manifest: writeJsonAtomic(outputPaths.slate_manifest, slateManifest),
    source_registry: writeJsonAtomic(outputPaths.source_registry, sourceRegistry),
    picks: writeJsonAtomic(outputPaths.picks, picks),
    daily_baseball_guide: writeTextAtomic(outputPaths.daily_baseball_guide, dailyGuide),
    run_log: writeTextAtomic(outputPaths.run_log, runLog),
    today_execution_board: writeJsonAtomic(outputPaths.today_execution_board, executionBoard),
    today_execution_board_md: writeTextAtomic(outputPaths.today_execution_board_md, executionBoardMd),
  };

  return {
    run_date: runDate,
    generated_at_utc: generatedAtUtc,
    mode: 'output-writer-dry-run',
    discovery_dir: discoveryDir,
    out_dir: outDir,
    files: written,
    kalshi_status: sourceStatus(kalshi),
    mlb_status: sourceStatus(mlb),
    baseball_savant_status: sourceStatus(baseballSavant),
    weather_status: sourceStatus(weather),
    liquidity_status: sourceStatus(liquidity),
    liquidity_records: safeArray(liquidity.records).length,
    sportsbook_status: sourceStatus(sportsbook),
    context_status: sourceStatus(context),
    sportsbook_records: safeArray(sportsbook?.records).length,
    context_records: safeArray(context?.records).length,
    scoring_counts: scoring.counts,
    fixture_mode: scoring.fixture_mode,
    kalshi_records: safeArray(kalshi.records).length,
    kalshi_rejected_records: safeArray(kalshi.rejected_records).length,
    mlb_games: safeArray(mlb.records).length,
    baseball_savant_records: safeArray(baseballSavant.records).length,
    weather_records: safeArray(weather.records).length,
    picks: scoring.candidates.length,
    message: 'Discovery only. No final picks. No trades placed.',
  };
}
