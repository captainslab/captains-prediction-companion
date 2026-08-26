import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

export const SBR_PUBLIC_RELEASE_API = 'https://api.github.com/repos/ArnavSaraogi/mlb-odds-scraper/releases/tags/dataset';
export const SBR_PUBLIC_RELEASE_PAGE = 'https://github.com/ArnavSaraogi/mlb-odds-scraper/releases/tag/dataset';
export const DEFAULT_SBR_CACHE_PATH = 'artifacts/cache/mlb-sbr-public-dataset.json';

function isoNow(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function americanToProbability(value) {
  const odds = finite(value);
  if (odds === null || odds === 0) return null;
  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
}

function round6(value) {
  return value === null || value === undefined ? null : Math.round(value * 1e6) / 1e6;
}

function noVigPair(awayOdds, homeOdds) {
  const awayRaw = americanToProbability(awayOdds);
  const homeRaw = americanToProbability(homeOdds);
  if (awayRaw === null || homeRaw === null) return null;
  const denom = awayRaw + homeRaw;
  if (!(denom > 0)) return null;
  return {
    away_raw: round6(awayRaw),
    home_raw: round6(homeRaw),
    away_no_vig_multiplicative: round6(awayRaw / denom),
    home_no_vig_multiplicative: round6(homeRaw / denom),
  };
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanTeam(value) {
  return String(value ?? '').trim() || null;
}

function cleanBook(value) {
  return String(value ?? '').trim().toLowerCase() || null;
}

export function pickSbrDatasetAsset(releasePayload = {}) {
  const assets = safeArray(releasePayload.assets)
    .filter(asset => asset?.browser_download_url && asset?.name)
    .map(asset => ({
      name: String(asset.name),
      size: Number(asset.size) || 0,
      browser_download_url: String(asset.browser_download_url),
      content_type: asset.content_type ?? null,
      id: asset.id ?? null,
    }));

  const preferred = assets
    .filter(asset => /\.json(?:\.gz)?$/i.test(asset.name))
    .sort((a, b) => b.size - a.size);
  if (preferred.length) return preferred[0];

  const fallback = assets
    .filter(asset => /\.(?:json|gz|zip)$/i.test(asset.name))
    .sort((a, b) => b.size - a.size);
  return fallback[0] ?? null;
}

function decodeDatasetBytes(buffer, assetName = '') {
  if (/\.json\.gz$/i.test(assetName) || /\.gz$/i.test(assetName)) {
    return gunzipSync(buffer).toString('utf8');
  }
  if (/\.zip$/i.test(assetName)) {
    throw new Error(`SBR public dataset asset ${assetName} is ZIP-compressed; ZIP is intentionally unsupported without an additional dependency.`);
  }
  return buffer.toString('utf8');
}

async function fileExists(path) {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

export async function loadSbrPublicDataset({
  datasetPath = process.env.MLB_SBR_DATASET_PATH || null,
  cachePath = DEFAULT_SBR_CACHE_PATH,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  forceRefresh = false,
} = {}) {
  const checkedAtUtc = isoNow(now);
  const resolvedPath = resolve(datasetPath || cachePath);
  let text;
  let asset = null;
  let sourceMode = datasetPath ? 'operator_path' : 'cache';

  if (!forceRefresh && await fileExists(resolvedPath)) {
    text = await readFile(resolvedPath, 'utf8');
  } else {
    if (datasetPath) {
      throw new Error(`MLB_SBR_DATASET_PATH does not exist or is empty: ${resolvedPath}`);
    }
    if (typeof fetchImpl !== 'function') {
      throw new Error('No fetch implementation available for SBR public dataset download.');
    }

    const releaseResponse = await fetchImpl(SBR_PUBLIC_RELEASE_API, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'captains-prediction-companion-mlb-historical/1.0',
      },
    });
    if (!releaseResponse.ok) {
      throw new Error(`GitHub release API returned HTTP ${releaseResponse.status}.`);
    }
    const release = await releaseResponse.json();
    asset = pickSbrDatasetAsset(release);
    if (!asset) {
      throw new Error('No JSON-like asset found on the public SBR MLB dataset release.');
    }

    const assetResponse = await fetchImpl(asset.browser_download_url, {
      headers: { 'user-agent': 'captains-prediction-companion-mlb-historical/1.0' },
    });
    if (!assetResponse.ok) {
      throw new Error(`SBR public dataset asset returned HTTP ${assetResponse.status}.`);
    }
    const bytes = Buffer.from(await assetResponse.arrayBuffer());
    text = decodeDatasetBytes(bytes, asset.name);
    await mkdir(dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, text, 'utf8');
    sourceMode = 'downloaded_release_asset';
  }

  let dataset;
  try {
    dataset = JSON.parse(text);
  } catch (error) {
    throw new Error(`SBR public dataset JSON parse failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!dataset || typeof dataset !== 'object' || Array.isArray(dataset)) {
    throw new TypeError('SBR public dataset root must be an object keyed by YYYY-MM-DD.');
  }

  return {
    source_id: 'sbr_public_dataset',
    status: 'ok',
    checked_at_utc: checkedAtUtc,
    required: false,
    historical_only: true,
    source_mode: sourceMode,
    cache_path: resolvedPath,
    release_api_url: SBR_PUBLIC_RELEASE_API,
    release_page_url: SBR_PUBLIC_RELEASE_PAGE,
    asset,
    content_sha256: createHash('sha256').update(text).digest('hex'),
    date_count: Object.keys(dataset).length,
    dataset,
  };
}

function normalizeMoneylineQuote(row = {}) {
  const sportsbook = cleanBook(row.sportsbook);
  const opening = row.openingLine ?? {};
  const closing = row.currentLine ?? {};
  const awayOpen = finite(opening.awayOdds);
  const homeOpen = finite(opening.homeOdds);
  const awayClose = finite(closing.awayOdds);
  const homeClose = finite(closing.homeOdds);
  const noVig = noVigPair(awayClose, homeClose);
  return {
    sportsbook,
    opening_away_odds: awayOpen,
    opening_home_odds: homeOpen,
    closing_away_odds: awayClose,
    closing_home_odds: homeClose,
    ...(noVig ?? {
      away_raw: null,
      home_raw: null,
      away_no_vig_multiplicative: null,
      home_no_vig_multiplicative: null,
    }),
  };
}

function normalizeTotalsQuote(row = {}) {
  const sportsbook = cleanBook(row.sportsbook);
  const opening = row.openingLine ?? {};
  const closing = row.currentLine ?? {};
  return {
    sportsbook,
    opening_total: finite(opening.total),
    opening_over_odds: finite(opening.overOdds),
    opening_under_odds: finite(opening.underOdds),
    closing_total: finite(closing.total),
    closing_over_odds: finite(closing.overOdds),
    closing_under_odds: finite(closing.underOdds),
  };
}

function validTwoSidedMoneyline(quote) {
  return quote.closing_away_odds !== null && quote.closing_home_odds !== null;
}

function validTwoSidedTotal(quote) {
  return quote.closing_total !== null && quote.closing_over_odds !== null && quote.closing_under_odds !== null;
}

export function normalizeSbrGame(game = {}, runDate) {
  const view = game.gameView ?? {};
  const moneylineQuotes = safeArray(game.odds?.moneyline).map(normalizeMoneylineQuote);
  const totalQuotes = safeArray(game.odds?.totals).map(normalizeTotalsQuote);
  const moneylineBooks = moneylineQuotes.filter(validTwoSidedMoneyline);
  const totalBooks = totalQuotes.filter(validTwoSidedTotal);
  const providers = [...new Set([
    ...moneylineBooks.map(quote => quote.sportsbook),
    ...totalBooks.map(quote => quote.sportsbook),
  ].filter(Boolean))].sort();

  return {
    source_id: 'sbr_public_dataset',
    query_type: 'historical_sportsbook_archive',
    game_date: runDate,
    start_time_utc: view.startDate ?? null,
    away_team: cleanTeam(view.awayTeam?.fullName),
    home_team: cleanTeam(view.homeTeam?.fullName),
    away_abbrev: cleanTeam(view.awayTeam?.shortName),
    home_abbrev: cleanTeam(view.homeTeam?.shortName),
    away_score: finite(view.awayTeamScore),
    home_score: finite(view.homeTeamScore),
    game_status: view.gameStatusText ?? null,
    venue: view.venueName ?? null,
    game_type: view.gameType ?? null,
    provider: 'SBR_PUBLIC_DATASET',
    providers,
    moneyline_book_count: moneylineBooks.length,
    game_total_book_count: totalBooks.length,
    moneyline_two_sided: moneylineBooks.length > 0,
    moneyline_no_vig: moneylineBooks.some(quote => quote.away_no_vig_multiplicative !== null && quote.home_no_vig_multiplicative !== null),
    game_total_line: totalQuotes.some(quote => quote.closing_total !== null),
    game_total_two_sided: totalBooks.length > 0,
    moneyline_quotes: moneylineQuotes,
    total_quotes: totalQuotes,
    source_urls: [SBR_PUBLIC_RELEASE_PAGE],
    quote_semantics: 'Release describes opening and closing odds; JSON currentLine is treated as the archived closing field for coverage measurement.',
  };
}

export function sbrRecordsForDate(dataset, runDate) {
  return safeArray(dataset?.[runDate]).map(game => normalizeSbrGame(game, runDate));
}
