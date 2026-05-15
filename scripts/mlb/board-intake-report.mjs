#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultDiscoveryDir, writeTextAtomic } from './file-io.mjs';

function parseArgs(argv) {
  const options = {
    date: null,
    discoveryDir: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--date') {
      options.date = argv[++index] ?? null;
    } else if (arg === '--discovery-dir') {
      options.discoveryDir = argv[++index] ?? null;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.date) {
    throw new Error('--date YYYY-MM-DD is required.');
  }

  return options;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/mlb/board-intake-report.mjs --date YYYY-MM-DD [--discovery-dir path]',
    '',
    'Reads existing discovery adapter JSON files only. Does not fetch live sources.',
  ].join('\n');
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function clean(value) {
  return String(value ?? '').trim();
}

function normalizeTitle(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function teamTokens(teamName) {
  return normalizeTitle(teamName)
    .split(' ')
    .filter(token => token.length >= 3);
}

function eventMatchesGame(eventTitle, game) {
  const title = normalizeTitle(eventTitle);
  const awayTokens = teamTokens(game.away_team);
  const homeTokens = teamTokens(game.home_team);
  const awayMatch = awayTokens.some(token => title.includes(token));
  const homeMatch = homeTokens.some(token => title.includes(token));
  return awayMatch && homeMatch;
}

function formatWarnings(values = []) {
  return values.length > 0 ? values.join('; ') : 'none';
}

function formatPitchers(game) {
  const away = game.probable_pitchers?.away ?? 'TBD';
  const home = game.probable_pitchers?.home ?? 'TBD';
  return `${away} / ${home}`;
}

function buildMatchingNotes(kalshiRecords, mlbGames) {
  const matchedKalshi = new Set();
  const matchedGames = new Set();
  const lines = [];

  for (const record of kalshiRecords) {
    const matches = mlbGames.filter(game => eventMatchesGame(record.event_title, game));
    if (matches.length > 0) {
      matchedKalshi.add(record.event_ticker ?? record.event_title);
      for (const game of matches) {
        matchedGames.add(game.game_pk);
      }
      lines.push(`- ${record.event_ticker ?? 'unknown ticker'} appears to match: ${matches.map(game => `${game.away_team} at ${game.home_team} (${game.game_pk})`).join(', ')}`);
    }
  }

  const unmatchedKalshi = kalshiRecords.filter(record => !matchedKalshi.has(record.event_ticker ?? record.event_title));
  const unmatchedGames = mlbGames.filter(game => !matchedGames.has(game.game_pk));

  if (lines.length === 0) {
    lines.push('- No obvious Kalshi event title to MLB game title matches found.');
  }

  lines.push('');
  lines.push('### Unmatched Kalshi Records');
  if (unmatchedKalshi.length === 0) {
    lines.push('- none');
  } else {
    for (const record of unmatchedKalshi) {
      lines.push(`- ${record.event_ticker ?? 'unknown ticker'}: ${record.event_title ?? 'untitled'}`);
    }
  }

  lines.push('');
  lines.push('### MLB Games With No Obvious Kalshi Record');
  if (unmatchedGames.length === 0) {
    lines.push('- none');
  } else {
    for (const game of unmatchedGames) {
      lines.push(`- ${game.game_pk}: ${game.away_team} at ${game.home_team}`);
    }
  }

  return lines;
}

function buildReport({ runDate, kalshi, mlb, generatedAtUtc }) {
  const kalshiRecords = Array.isArray(kalshi.records) ? kalshi.records : [];
  const mlbGames = Array.isArray(mlb.records) ? mlb.records : [];
  const lines = [
    `# MLB Board Intake Report - ${runDate}`,
    '',
    `- Generated UTC: ${generatedAtUtc}`,
    '- Discovery only.',
    '- No picks made.',
    '- No trades placed.',
    '',
    '## Source Health',
    '',
    `- Kalshi status: ${kalshi.status ?? 'unknown'}`,
    `- MLB official status: ${mlb.status ?? 'unknown'}`,
    `- Kalshi warning summary: ${formatWarnings(kalshi.warnings)}`,
    `- MLB warning summary: ${formatWarnings(mlb.warnings)}`,
    '',
    '## MLB Slate',
    '',
    '| game_pk | Away | Home | Start UTC | MLB status | Probable pitchers |',
    '|---:|---|---|---|---|---|',
  ];

  for (const game of mlbGames) {
    lines.push(
      `| ${game.game_pk ?? ''} | ${game.away_team ?? ''} | ${game.home_team ?? ''} | ${game.start_time_utc ?? ''} | ${game.mlb_status ?? ''} | ${formatPitchers(game)} |`,
    );
  }

  if (mlbGames.length === 0) {
    lines.push('|  |  |  |  | no MLB games found |  |');
  }

  lines.push('', '## Kalshi Discovered Records', '');

  for (const record of kalshiRecords) {
    const markets = Array.isArray(record.markets) ? record.markets : [];
    lines.push(`### ${record.event_ticker ?? 'unknown ticker'}`);
    lines.push('');
    lines.push(`- Event title: ${record.event_title ?? 'untitled'}`);
    lines.push(`- Market count: ${markets.length}`);
    lines.push('');
    lines.push('| Market title | Routed lane | Route status |');
    lines.push('|---|---|---|');
    if (markets.length === 0) {
      lines.push('| none captured |  |  |');
    } else {
      for (const market of markets) {
        lines.push(
          `| ${market.market_title ?? 'untitled'} | ${market.market_lane ?? ''} | ${market.route_status ?? ''} |`,
        );
      }
    }
    lines.push('');
  }

  if (kalshiRecords.length === 0) {
    lines.push('- No Kalshi records found.');
    lines.push('');
  }

  lines.push('## Matching Notes', '', ...buildMatchingNotes(kalshiRecords, mlbGames), '');
  lines.push('## Next Required Work Before True Daily Baseball Guide', '');
  lines.push('- Output writer.');
  lines.push('- Savant/Statcast adapter.');
  lines.push('- Weather adapter.');
  lines.push('- Liquidity/order book enrichment if not already present.');
  lines.push('- Actual morning scan composer.');
  lines.push('- No final picks until evidence gates exist.');
  lines.push('');
  lines.push('No picks made.');
  lines.push('No trades placed.');

  return lines.join('\n');
}

export function createBoardIntakeReport({ runDate, discoveryDir = defaultDiscoveryDir(runDate), now = new Date() }) {
  const kalshiPath = resolve(discoveryDir, 'kalshi_adapter.json');
  const mlbPath = resolve(discoveryDir, 'mlb_official_adapter.json');
  const outputPath = resolve(discoveryDir, 'board_intake_report.md');
  const kalshi = readJson(kalshiPath);
  const mlb = readJson(mlbPath);
  const report = buildReport({
    runDate,
    kalshi,
    mlb,
    generatedAtUtc: now.toISOString(),
  });
  writeTextAtomic(outputPath, report);
  return {
    run_date: runDate,
    output_path: outputPath,
    kalshi_status: kalshi.status ?? 'unknown',
    mlb_status: mlb.status ?? 'unknown',
    kalshi_records: Array.isArray(kalshi.records) ? kalshi.records.length : 0,
    mlb_games: Array.isArray(mlb.records) ? mlb.records.length : 0,
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

    const result = createBoardIntakeReport({
      runDate: options.date,
      discoveryDir: options.discoveryDir ?? defaultDiscoveryDir(options.date),
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exit(1);
  }
}
