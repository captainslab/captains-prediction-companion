import { createHash } from 'node:crypto';
import { lookupMlbTeam } from '../../packets/lib/mlb-teams.mjs';

const WIKIPEDIA_BASE_URL = 'https://en.wikipedia.org/wiki/';
const WIKIPEDIA_API_URL = 'https://en.wikipedia.org/w/api.php';
const MIN_SUPPORTED_SEASON = 2015;

const MONTH_NUMBER = Object.freeze({
  January: '01',
  February: '02',
  March: '03',
  April: '04',
  May: '05',
  June: '06',
  July: '07',
  August: '08',
  September: '09',
  October: '10',
  November: '11',
  December: '12',
});

const TEAM_NICKNAME = Object.freeze({
  'Arizona Diamondbacks': 'Diamondbacks',
  'Atlanta Braves': 'Braves',
  'Baltimore Orioles': 'Orioles',
  'Boston Red Sox': 'Red Sox',
  'Chicago Cubs': 'Cubs',
  'Chicago White Sox': 'White Sox',
  'Cincinnati Reds': 'Reds',
  'Cleveland Guardians': 'Guardians',
  'Cleveland Indians': 'Indians',
  'Colorado Rockies': 'Rockies',
  'Detroit Tigers': 'Tigers',
  'Houston Astros': 'Astros',
  'Kansas City Royals': 'Royals',
  'Los Angeles Angels': 'Angels',
  'Los Angeles Dodgers': 'Dodgers',
  'Miami Marlins': 'Marlins',
  'Milwaukee Brewers': 'Brewers',
  'Minnesota Twins': 'Twins',
  'New York Mets': 'Mets',
  'New York Yankees': 'Yankees',
  Athletics: 'Athletics',
  'Oakland Athletics': 'Athletics',
  'Philadelphia Phillies': 'Phillies',
  'Pittsburgh Pirates': 'Pirates',
  'San Diego Padres': 'Padres',
  'San Francisco Giants': 'Giants',
  'Seattle Mariners': 'Mariners',
  'St. Louis Cardinals': 'Cardinals',
  'Tampa Bay Rays': 'Rays',
  'Texas Rangers': 'Rangers',
  'Toronto Blue Jays': 'Blue Jays',
  'Washington Nationals': 'Nationals',
});

function normalizeSeason(value) {
  const season = Number(value);
  if (!Number.isInteger(season) || season < MIN_SUPPORTED_SEASON || season > 2100) {
    throw new TypeError(`Unsupported MLB season: ${value}`);
  }
  return season;
}

function normalizeTeamInput(team) {
  const raw = String(team ?? '').trim();
  if (!raw) throw new TypeError('MLB team is required.');
  return lookupMlbTeam(raw) ?? raw;
}

function cleanWikiMarkup(value) {
  return String(value ?? '')
    .replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(/<ref\b[^/>]*\/>/gi, '')
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, '$1')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/'''?/g, '')
    .replace(/&nbsp;|\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDash(value) {
  return String(value ?? '').replace(/[−–—]/g, '-');
}

function parseMonthDay(dateText, season) {
  const match = cleanWikiMarkup(dateText).match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\b/);
  if (!match) return null;
  const month = MONTH_NUMBER[match[1]];
  const day = String(Number(match[2])).padStart(2, '0');
  return `${season}-${month}-${day}`;
}

function parseDoubleheaderGame(dateText) {
  const match = cleanWikiMarkup(dateText).match(/\(([12])\)\s*$/);
  return match ? Number(match[1]) : null;
}

function parseScore(scoreText) {
  const normalized = normalizeDash(cleanWikiMarkup(scoreText));
  const match = normalized.match(/\b(\d{1,2})-(\d{1,2})(?:\s*\((\d{1,2})\))?/);
  if (!match) return null;
  return {
    team_runs: Number(match[1]),
    opponent_runs: Number(match[2]),
    innings: match[3] ? Number(match[3]) : 9,
  };
}

function teamNickname(team, season) {
  const historical = wikipediaTeamNameForSeason(team, season);
  return TEAM_NICKNAME[historical] ?? historical.split(' ').at(-1);
}

function sameLooseText(left, right) {
  const norm = value => String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const a = norm(left);
  const b = norm(right);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function splitWikiTableCells(rowBlock) {
  const body = rowBlock
    .replace(/^\s*\|-[^\n]*\n?/, '')
    .replace(/^\s*\|/gm, '')
    .replace(/\n/g, ' ');
  return body.split(/\|\|/).map(cleanWikiMarkup).filter(Boolean);
}

function makeEnvelope({ status, checkedAtUtc, cachePath, records = [], warnings = [], errors = [], sourceUrls = [] }) {
  return {
    source_id: 'wikipedia_historical',
    status,
    checked_at_utc: checkedAtUtc,
    cache_key: `wikipedia_historical_${checkedAtUtc}`,
    cache_path: cachePath,
    required: false,
    historical_only: true,
    records,
    warnings,
    errors,
    source_urls: sourceUrls,
  };
}

export function wikipediaTeamNameForSeason(team, seasonValue) {
  const season = normalizeSeason(seasonValue);
  const current = normalizeTeamInput(team);

  if (current === 'Athletics' || current === 'Oakland Athletics') {
    return season >= 2025 ? 'Athletics' : 'Oakland Athletics';
  }
  if (current === 'Cleveland Guardians' || current === 'Cleveland Indians') {
    return season >= 2022 ? 'Cleveland Guardians' : 'Cleveland Indians';
  }
  return current;
}

export function buildWikipediaSeasonPageTitle({ team, season }) {
  const year = normalizeSeason(season);
  return `${year} ${wikipediaTeamNameForSeason(team, year)} season`;
}

export function buildWikipediaSeasonUrl({ team, season }) {
  const title = buildWikipediaSeasonPageTitle({ team, season });
  return `${WIKIPEDIA_BASE_URL}${encodeURIComponent(title.replace(/ /g, '_'))}`;
}

export function buildWikipediaParseApiUrl({ team, season, prop = 'wikitext' }) {
  const url = new URL(WIKIPEDIA_API_URL);
  url.searchParams.set('action', 'parse');
  url.searchParams.set('page', buildWikipediaSeasonPageTitle({ team, season }));
  url.searchParams.set('prop', prop);
  url.searchParams.set('redirects', '1');
  url.searchParams.set('format', 'json');
  url.searchParams.set('formatversion', '2');
  return url.toString();
}

export function buildWikipediaGameSourceRecord(game = {}) {
  const gameDate = String(game.game_date ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(gameDate)) {
    throw new TypeError(`game_date must be YYYY-MM-DD, received: ${game.game_date}`);
  }
  const season = normalizeSeason(game.season ?? gameDate.slice(0, 4));
  const awayTeam = wikipediaTeamNameForSeason(game.away_team, season);
  const homeTeam = wikipediaTeamNameForSeason(game.home_team, season);
  const gameNumber = game.game_number == null ? null : Number(game.game_number);
  if (gameNumber != null && ![1, 2].includes(gameNumber)) {
    throw new TypeError(`game_number must be 1, 2, or null; received: ${game.game_number}`);
  }

  const homeUrl = buildWikipediaSeasonUrl({ team: homeTeam, season });
  const awayUrl = buildWikipediaSeasonUrl({ team: awayTeam, season });
  const sourceUrls = [...new Set([homeUrl, awayUrl])];
  const naturalKey = game.game_pk != null
    ? String(game.game_pk)
    : `${gameDate}_${awayTeam}_${homeTeam}_${gameNumber ?? 0}`;

  return {
    source_id: 'wikipedia_historical',
    source_role: 'historical_schedule_and_final_score_crosscheck',
    game_pk: game.game_pk ?? null,
    season,
    game_date: gameDate,
    game_number: gameNumber,
    away_team: awayTeam,
    home_team: homeTeam,
    canonical_url: homeUrl,
    alternate_url: awayUrl === homeUrl ? null : awayUrl,
    source_urls: sourceUrls,
    source_key: `wikipedia_mlb_${createHash('sha256').update(naturalKey).digest('hex').slice(0, 20)}`,
    line_score_available: false,
    first_inning_truth_available: false,
  };
}

export function extractWikipediaGameLogRows(wikitext, { season, sourceTeam }) {
  const year = normalizeSeason(season);
  const historicalSourceTeam = wikipediaTeamNameForSeason(sourceTeam, year);
  const blocks = String(wikitext ?? '').split(/(?=\n?\|-[^\n]*\n)/g);
  const rows = [];

  for (const block of blocks) {
    if (!/\|\|/.test(block)) continue;
    const cells = splitWikiTableCells(block);
    if (cells.length < 4) continue;

    const dateIndex = cells.findIndex(cell => parseMonthDay(cell, year));
    if (dateIndex < 0) continue;
    const scoreIndex = cells.findIndex((cell, index) => index > dateIndex && parseScore(cell));
    if (scoreIndex < 0) continue;
    const opponentIndex = dateIndex + 1;
    if (opponentIndex >= cells.length) continue;

    const score = parseScore(cells[scoreIndex]);
    if (!score) continue;
    const dateText = cells[dateIndex];
    const opponentText = cells[opponentIndex];
    const isAway = /^@\s*/.test(opponentText);

    rows.push({
      source_team: historicalSourceTeam,
      game_date: parseMonthDay(dateText, year),
      game_number: parseDoubleheaderGame(dateText),
      opponent: opponentText.replace(/^@\s*/, '').trim(),
      is_away: isAway,
      team_runs: score.team_runs,
      opponent_runs: score.opponent_runs,
      innings: score.innings,
      raw_cells: cells,
    });
  }

  return rows;
}

export function matchWikipediaGameLogRow({ rows, game, sourceTeam }) {
  const gameDate = String(game.game_date ?? '').trim();
  const season = normalizeSeason(game.season ?? gameDate.slice(0, 4));
  const sourceHistorical = wikipediaTeamNameForSeason(sourceTeam, season);
  const awayHistorical = wikipediaTeamNameForSeason(game.away_team, season);
  const homeHistorical = wikipediaTeamNameForSeason(game.home_team, season);
  const sourceIsAway = sourceHistorical === awayHistorical;
  const sourceIsHome = sourceHistorical === homeHistorical;
  if (!sourceIsAway && !sourceIsHome) {
    throw new TypeError(`sourceTeam ${sourceTeam} is not one of the game teams.`);
  }

  const opponent = sourceIsAway ? homeHistorical : awayHistorical;
  const opponentNickname = teamNickname(opponent, season);
  const wantedGameNumber = game.game_number == null ? null : Number(game.game_number);

  const candidates = rows.filter(row => (
    row.game_date === gameDate
    && row.is_away === sourceIsAway
    && sameLooseText(row.opponent, opponentNickname)
    && (wantedGameNumber == null || row.game_number === wantedGameNumber)
  ));

  if (candidates.length !== 1) return null;
  return candidates[0];
}

export function wikipediaGameTruthFromRow({ row, game, sourceTeam }) {
  if (!row) return null;
  const season = normalizeSeason(game.season ?? String(game.game_date).slice(0, 4));
  const sourceHistorical = wikipediaTeamNameForSeason(sourceTeam, season);
  const awayHistorical = wikipediaTeamNameForSeason(game.away_team, season);
  const sourceIsAway = sourceHistorical === awayHistorical;

  const awayRuns = sourceIsAway ? row.team_runs : row.opponent_runs;
  const homeRuns = sourceIsAway ? row.opponent_runs : row.team_runs;
  return {
    game_pk: game.game_pk ?? null,
    game_date: game.game_date,
    game_number: game.game_number ?? row.game_number ?? null,
    away_team: wikipediaTeamNameForSeason(game.away_team, season),
    home_team: wikipediaTeamNameForSeason(game.home_team, season),
    away_runs: awayRuns,
    home_runs: homeRuns,
    winner: awayRuns === homeRuns ? null : (awayRuns > homeRuns ? 'away' : 'home'),
    innings: row.innings,
    line_score_available: false,
    first_inning_truth_available: false,
    yrfi: null,
    nrfi: null,
  };
}

export async function fetchWikipediaSeasonReadonly({
  team,
  season,
  outputDir,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  includeWikitext = false,
} = {}) {
  const checkedAtUtc = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const sourceUrl = buildWikipediaSeasonUrl({ team, season });
  const apiUrl = buildWikipediaParseApiUrl({ team, season });
  const cachePath = `${outputDir}/wikipedia_historical_adapter.json`;

  if (typeof fetchImpl !== 'function') {
    return makeEnvelope({
      status: 'blocked', checkedAtUtc, cachePath,
      errors: ['No fetch implementation available for Wikipedia historical request.'],
      sourceUrls: [sourceUrl, apiUrl],
    });
  }

  try {
    const response = await fetchImpl(apiUrl, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': 'captains-prediction-companion-mlb-historical/1.0',
      },
    });
    if (!response.ok) {
      return makeEnvelope({
        status: 'blocked', checkedAtUtc, cachePath,
        errors: [`Wikipedia API returned HTTP ${response.status}.`],
        sourceUrls: [sourceUrl, apiUrl],
      });
    }

    const payload = await response.json();
    if (payload?.error || !payload?.parse) {
      return makeEnvelope({
        status: 'blocked', checkedAtUtc, cachePath,
        errors: [payload?.error?.info ?? 'Wikipedia parse response did not contain a page.'],
        sourceUrls: [sourceUrl, apiUrl],
      });
    }

    const wikitext = typeof payload.parse.wikitext === 'string' ? payload.parse.wikitext : '';
    const record = {
      team: wikipediaTeamNameForSeason(team, season),
      season: normalizeSeason(season),
      page_title: payload.parse.title ?? buildWikipediaSeasonPageTitle({ team, season }),
      page_id: payload.parse.pageid ?? null,
      revision_id: payload.parse.revid ?? null,
      canonical_url: sourceUrl,
      api_url: apiUrl,
      content_sha256: createHash('sha256').update(wikitext).digest('hex'),
      wikitext_bytes: Buffer.byteLength(wikitext, 'utf8'),
      ...(includeWikitext ? { wikitext } : {}),
    };

    return makeEnvelope({
      status: 'ok', checkedAtUtc, cachePath,
      records: [record],
      warnings: ['Historical-only source. Standard team-season pages validate schedule/final-score rows but do not provide a reliable inning-by-inning line score.'],
      sourceUrls: [sourceUrl, apiUrl],
    });
  } catch (error) {
    return makeEnvelope({
      status: 'blocked', checkedAtUtc, cachePath,
      errors: [error instanceof Error ? error.message : String(error)],
      sourceUrls: [sourceUrl, apiUrl],
    });
  }
}
