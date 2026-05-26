import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const MLB_STATS_API_BASE = 'https://statsapi.mlb.com/api/v1';
export const ESPN_MLB_SCOREBOARD_BASE = 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard';
export const ESPN_MLB_ATHLETE_SPLITS_BASE = 'https://site.api.espn.com/apis/common/v3/sports/baseball/mlb/athletes';

function isoNow(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace('%', ''));
  return Number.isFinite(n) ? n : null;
}

function round(value, places = 3) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function makeEnvelope({
  status,
  checkedAtUtc,
  cachePath,
  records = [],
  warnings = [],
  errors = [],
  sourceUrls = [],
}) {
  return {
    source_id: 'mlb_stats',
    status,
    checked_at_utc: checkedAtUtc,
    cache_key: `mlb_stats_${checkedAtUtc}`,
    cache_path: cachePath,
    required: true,
    records,
    warnings,
    errors,
    source_urls: sourceUrls,
  };
}

function readMlbGamesFromDiscovery(filePath) {
  const absolutePath = resolve(filePath);
  if (!existsSync(absolutePath)) {
    return { records: [], warning: `MLB official discovery file not found at ${filePath}.` };
  }

  try {
    const payload = JSON.parse(readFileSync(absolutePath, 'utf8'));
    return { records: safeArray(payload.records), warning: null };
  } catch (error) {
    return {
      records: [],
      warning: `Could not parse MLB official discovery file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function buildMlbStatsScheduleUrl(runDate) {
  const url = new URL(`${MLB_STATS_API_BASE}/schedule`);
  url.searchParams.set('sportId', '1');
  url.searchParams.set('date', runDate);
  url.searchParams.set('hydrate', 'probablePitcher,team,venue(timezone)');
  return url.toString();
}

export function buildPitcherSeasonStatsUrl(playerId, season) {
  const url = new URL(`${MLB_STATS_API_BASE}/people/${playerId}/stats`);
  url.searchParams.set('stats', 'season');
  url.searchParams.set('group', 'pitching');
  url.searchParams.set('season', season);
  return url.toString();
}

export function buildPitcherAdvancedStatsUrl(playerId, season) {
  const url = new URL(`${MLB_STATS_API_BASE}/people/${playerId}/stats`);
  url.searchParams.set('stats', 'seasonAdvanced');
  url.searchParams.set('group', 'pitching');
  url.searchParams.set('season', season);
  return url.toString();
}

export function buildPersonUrl(playerId) {
  return `${MLB_STATS_API_BASE}/people/${playerId}`;
}

export function buildTeamHittingStatsUrl(teamId, season) {
  const url = new URL(`${MLB_STATS_API_BASE}/teams/${teamId}/stats`);
  url.searchParams.set('stats', 'season');
  url.searchParams.set('group', 'hitting');
  url.searchParams.set('season', season);
  return url.toString();
}

export function buildTeamHittingSplitUrl(teamId, season, sitCode) {
  const url = new URL(`${MLB_STATS_API_BASE}/teams/${teamId}/stats`);
  url.searchParams.set('stats', 'statSplits');
  url.searchParams.set('group', 'hitting');
  url.searchParams.set('season', season);
  url.searchParams.set('sitCodes', sitCode);
  return url.toString();
}

export function buildTeamBullpenStatsUrl(teamId, season) {
  const url = new URL(`${MLB_STATS_API_BASE}/teams/${teamId}/stats`);
  url.searchParams.set('stats', 'statSplits');
  url.searchParams.set('group', 'pitching');
  url.searchParams.set('season', season);
  url.searchParams.set('sitCodes', 'rp');
  return url.toString();
}

export function buildStandingsUrl(season) {
  const url = new URL(`${MLB_STATS_API_BASE}/standings`);
  url.searchParams.set('leagueId', '103,104');
  url.searchParams.set('season', season);
  url.searchParams.set('standingsTypes', 'regularSeason');
  url.searchParams.set('hydrate', 'team');
  return url.toString();
}

// ---- Extended URL builders (FIP / wOBA proxy / splits / ESPN) -------------

export function buildPitcherSabermetricsUrl(playerId, season) {
  const url = new URL(`${MLB_STATS_API_BASE}/people/${playerId}/stats`);
  url.searchParams.set('stats', 'sabermetrics');
  url.searchParams.set('group', 'pitching');
  url.searchParams.set('season', season);
  return url.toString();
}

export function buildTeamHittingSeasonUrl(teamId, season) {
  const url = new URL(`${MLB_STATS_API_BASE}/teams/${teamId}/stats`);
  url.searchParams.set('stats', 'season');
  url.searchParams.set('group', 'hitting');
  url.searchParams.set('season', season);
  url.searchParams.set('sportId', '1');
  return url.toString();
}

export function buildPitcherVsTeamUrl(playerId, opposingTeamId, season, span = 'vsTeam') {
  const url = new URL(`${MLB_STATS_API_BASE}/people/${playerId}/stats`);
  url.searchParams.set('stats', span);
  url.searchParams.set('group', 'pitching');
  url.searchParams.set('season', season);
  url.searchParams.set('opposingTeamId', String(opposingTeamId));
  return url.toString();
}

export function buildEspnScoreboardUrl(dateYmd) {
  const url = new URL(ESPN_MLB_SCOREBOARD_BASE);
  url.searchParams.set('dates', dateYmd);
  return url.toString();
}

export function buildEspnPitcherSplitsUrl(athleteId, season) {
  const url = new URL(`${ESPN_MLB_ATHLETE_SPLITS_BASE}/${athleteId}/splits`);
  url.searchParams.set('category', 'pitching');
  url.searchParams.set('season', season);
  return url.toString();
}

export function buildPeopleSearchUrl(fullName) {
  const url = new URL(`${MLB_STATS_API_BASE}/people/search`);
  url.searchParams.set('names', fullName);
  url.searchParams.set('sportIds', '1');
  return url.toString();
}

function normalizeSchedulePayload(payload = {}) {
  return safeArray(payload.dates).flatMap(dateEntry =>
    safeArray(dateEntry.games).map(game => ({
      game_pk: game.gamePk ?? null,
      game_date: game.officialDate ?? null,
      start_time_utc: game.gameDate ?? null,
      away_team: game.teams?.away?.team?.name ?? null,
      home_team: game.teams?.home?.team?.name ?? null,
      away_team_id: game.teams?.away?.team?.id ?? null,
      home_team_id: game.teams?.home?.team?.id ?? null,
      away_team_abbrev: game.teams?.away?.team?.abbreviation ?? null,
      home_team_abbrev: game.teams?.home?.team?.abbreviation ?? null,
      probable_pitchers: {
        away: game.teams?.away?.probablePitcher?.fullName ?? null,
        home: game.teams?.home?.probablePitcher?.fullName ?? null,
        away_id: game.teams?.away?.probablePitcher?.id ?? null,
        home_id: game.teams?.home?.probablePitcher?.id ?? null,
      },
      venue: game.venue?.name ?? null,
      venue_timezone: game.venue?.timeZone?.id ?? null,
      mlb_status: game.status?.detailedState ?? game.status?.abstractGameState ?? null,
    })),
  );
}

function firstStat(payload = {}) {
  if (payload === null || payload === undefined) return null;
  return safeArray(payload.stats)
    .flatMap(statGroup => safeArray(statGroup.splits))
    .map(split => split.stat)
    .find(Boolean) ?? null;
}

// ---- Extended derivations: FIP, wOBA proxy, splits, ESPN -----------------

function parseInningsPitched(ip) {
  if (ip === null || ip === undefined || ip === '') return null;
  const s = String(ip);
  const m = s.match(/^(\d+)(?:\.(\d))?$/);
  if (!m) {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  const whole = Number(m[1]);
  const frac = m[2] ? Number(m[2]) : 0;
  // MLB IP encodes outs as .1=1/3, .2=2/3
  return whole + (frac / 3);
}

export function computeFipFromSeasonStat(stat, constant = 3.10) {
  if (!stat) return null;
  const hr = toNumber(stat.homeRuns);
  const bb = toNumber(stat.baseOnBalls);
  const hbp = toNumber(stat.hitByPitch ?? stat.hitBatsmen);
  const so = toNumber(stat.strikeOuts);
  const ip = parseInningsPitched(stat.inningsPitched);
  if ([hr, bb, hbp, so].some(v => v === null) || !ip || ip <= 0) return null;
  return ((13 * hr) + 3 * (bb + hbp) - 2 * so) / ip + constant;
}

export function extractPitcherSabermetrics(payload) {
  const stat = firstStat(payload);
  if (!stat) return null;
  const fip = toNumber(stat.fip);
  if (fip === null) return null;
  return {
    fip: round(fip, 2),
    xfip: toNumber(stat.xfip),
    fipMinus: toNumber(stat.fipMinus),
    eraMinus: toNumber(stat.eraMinus),
    war: toNumber(stat.war),
  };
}

export async function getPitcherSabermetrics(fetchImpl, mlbId, season) {
  if (!mlbId || !season) return null;
  const url = buildPitcherSabermetricsUrl(mlbId, season);
  try {
    const payload = await fetchJson(fetchImpl, url);
    const data = extractPitcherSabermetrics(payload);
    if (!data) return null;
    return { ...data, season: String(season), source_path: 'mlb_sabermetrics', source_url: url };
  } catch {
    return null;
  }
}

export async function getPitcherSeasonComputedFip(fetchImpl, mlbId, season) {
  if (!mlbId || !season) return null;
  const url = buildPitcherSeasonStatsUrl(mlbId, season);
  try {
    const payload = await fetchJson(fetchImpl, url);
    const stat = firstStat(payload);
    const fip = computeFipFromSeasonStat(stat);
    if (fip === null) return null;
    return {
      fip: round(fip, 2),
      xfip: null, fipMinus: null, eraMinus: null, war: null,
      season: String(season),
      source_path: 'computed_from_season',
      source_url: url,
    };
  } catch {
    return null;
  }
}

export async function getPitcherFipBestEffort(fetchImpl, mlbId, currentSeason, fallbackSeason = null) {
  if (!mlbId) return null;
  const seasons = [currentSeason];
  if (fallbackSeason && fallbackSeason !== currentSeason) seasons.push(fallbackSeason);
  for (const season of seasons) {
    const sabr = await getPitcherSabermetrics(fetchImpl, mlbId, season);
    if (sabr) return sabr;
    const computed = await getPitcherSeasonComputedFip(fetchImpl, mlbId, season);
    if (computed) return computed;
  }
  return null;
}

export function extractTeamWobaProxy(payload) {
  const stat = firstStat(payload);
  if (!stat) return null;
  const obp = toNumber(stat.obp);
  const slg = toNumber(stat.slg);
  if (obp === null || slg === null) return null;
  return {
    obp,
    slg,
    ops: toNumber(stat.ops),
    babip: toNumber(stat.babip),
    woba_proxy: round(0.69 * obp + 0.31 * slg, 4),
  };
}

export async function getTeamWobaProxy(fetchImpl, teamId, season) {
  if (!teamId || !season) return null;
  const url = buildTeamHittingSeasonUrl(teamId, season);
  try {
    const payload = await fetchJson(fetchImpl, url);
    const data = extractTeamWobaProxy(payload);
    if (!data) return null;
    return { ...data, season: String(season), source_path: 'mlb_team_hitting_proxy', source_url: url };
  } catch {
    return null;
  }
}

export function extractPitcherVsTeamStat(payload) {
  const stat = firstStat(payload);
  if (!stat) return null;
  return {
    era: toNumber(stat.era),
    ip: parseInningsPitched(stat.inningsPitched),
    baa: toNumber(stat.avg),
    k: toNumber(stat.strikeOuts),
    bb: toNumber(stat.baseOnBalls),
  };
}

export async function getPitcherVsTeam(fetchImpl, mlbId, opposingTeamId, season) {
  if (!mlbId || !opposingTeamId || !season) return null;
  // Try season first
  const seasonUrl = buildPitcherVsTeamUrl(mlbId, opposingTeamId, season, 'vsTeam');
  let seasonData = null;
  try {
    const payload = await fetchJson(fetchImpl, seasonUrl);
    seasonData = extractPitcherVsTeamStat(payload);
  } catch { /* ignore */ }
  if (seasonData && seasonData.ip != null && seasonData.ip >= 10) {
    return { ...seasonData, span: 'season', source_path: 'mlb_vsTeam_season', source_url: seasonUrl };
  }
  // Fallback to 5y span
  const fiveUrl = buildPitcherVsTeamUrl(mlbId, opposingTeamId, season, 'vsTeam5Y');
  try {
    const payload = await fetchJson(fetchImpl, fiveUrl);
    const data = extractPitcherVsTeamStat(payload);
    if (data && (data.era != null || (data.ip != null && data.ip > 0))) {
      return { ...data, span: '5y', source_path: 'mlb_vsTeam5Y', source_url: fiveUrl };
    }
  } catch { /* ignore */ }
  if (seasonData && (seasonData.era != null || (seasonData.ip != null && seasonData.ip > 0))) {
    return { ...seasonData, span: 'season', source_path: 'mlb_vsTeam_season', source_url: seasonUrl };
  }
  return null;
}

function buildEspnSplitRow(labels, statsRow) {
  const out = {};
  for (let i = 0; i < labels.length; i += 1) {
    const lbl = String(labels[i] ?? '').toLowerCase();
    out[lbl] = statsRow[i] ?? null;
  }
  return out;
}

export function extractEspnVenueSplit(payload, venueName) {
  if (!payload || !venueName) return null;
  const categories = safeArray(payload.splitCategories);
  const byArena = categories.find(c => String(c?.name ?? '').toLowerCase() === 'byarena');
  if (!byArena) return null;
  const labels = safeArray(payload.labels ?? byArena.labels);
  const needle = String(venueName).toLowerCase();
  for (const split of safeArray(byArena.splits)) {
    const display = String(split?.displayName ?? '').toLowerCase();
    if (!display) continue;
    if (display.includes(needle) || needle.includes(display)) {
      const row = buildEspnSplitRow(labels, safeArray(split.stats));
      const era = toNumber(row.era);
      const ip = toNumber(row.ip);
      const gs = toNumber(row.gs);
      if (era === null && ip === null && gs === null) continue;
      return { era, ip, gs, source_path: 'espn_byArena' };
    }
  }
  return null;
}

export async function getPitcherAtVenue(fetchImpl, espnAthleteId, venueName, season) {
  if (!espnAthleteId) return { era: null, ip: null, gs: null, source_path: null, reason: 'no_espn_id' };
  if (!venueName) return { era: null, ip: null, gs: null, source_path: null, reason: 'no_venue_name' };
  const url = buildEspnPitcherSplitsUrl(espnAthleteId, season);
  try {
    const payload = await fetchJson(fetchImpl, url);
    const match = extractEspnVenueSplit(payload, venueName);
    if (!match) return { era: null, ip: null, gs: null, source_path: null, reason: 'venue_not_in_byArena' };
    return { ...match, source_url: url };
  } catch (error) {
    return { era: null, ip: null, gs: null, source_path: null, reason: `espn_fetch_failed:${error instanceof Error ? error.message : String(error)}` };
  }
}

export function extractEspnProbables(payload) {
  const events = safeArray(payload?.events);
  const out = [];
  for (const event of events) {
    const comp = safeArray(event.competitions)[0];
    if (!comp) continue;
    const competitors = safeArray(comp.competitors);
    const sides = { away: null, home: null };
    for (const c of competitors) {
      const ha = String(c.homeAway ?? '').toLowerCase();
      const probable = safeArray(c.probables)[0];
      const team = c.team ?? {};
      sides[ha === 'home' ? 'home' : 'away'] = {
        team_name: team.displayName ?? team.name ?? null,
        team_abbrev: team.abbreviation ?? null,
        pitcher_name: probable?.athlete?.fullName ?? null,
        espn_athlete_id: probable?.athlete?.id ? String(probable.athlete.id) : null,
        hand: probable?.athlete?.position?.abbreviation ?? null,
      };
    }
    out.push({ event_id: event.id ?? null, date: event.date ?? null, ...sides });
  }
  return out;
}

export async function recoverProbablesFromEspn(fetchImpl, dateYmd) {
  if (!fetchImpl || !dateYmd) return [];
  const compact = String(dateYmd).replace(/-/g, '');
  const url = buildEspnScoreboardUrl(compact);
  try {
    const payload = await fetchJson(fetchImpl, url);
    return extractEspnProbables(payload);
  } catch {
    return [];
  }
}

export async function resolveMlbIdByName(fetchImpl, fullName) {
  if (!fetchImpl || !fullName) return null;
  const url = buildPeopleSearchUrl(fullName);
  try {
    const payload = await fetchJson(fetchImpl, url);
    const people = safeArray(payload?.people);
    const exact = people.find(p => String(p.fullName ?? '').toLowerCase() === String(fullName).toLowerCase());
    const pick = exact ?? people[0];
    return pick?.id ?? null;
  } catch {
    return null;
  }
}

function normalizeStandings(payload = {}) {
  const byId = new Map();
  const byName = new Map();
  for (const row of safeArray(payload.records).flatMap(record => safeArray(record.teamRecords))) {
    const teamId = row.team?.id ?? null;
    const lastTen = safeArray(row.records?.splitRecords).find(split => split.type === 'lastTen');
    const normalized = {
      team_id: teamId,
      team_name: row.team?.name ?? null,
      wins: toNumber(row.wins ?? row.leagueRecord?.wins),
      losses: toNumber(row.losses ?? row.leagueRecord?.losses),
      gamesPlayed: toNumber(row.gamesPlayed),
      runDiff: toNumber(row.runDifferential),
      runsScored: toNumber(row.runsScored),
      runsAllowed: toNumber(row.runsAllowed),
      last10: lastTen ? `${lastTen.wins}-${lastTen.losses}` : null,
    };
    if (teamId !== null) byId.set(teamId, normalized);
    if (normalized.team_name) byName.set(normalized.team_name, normalized);
  }
  return { byId, byName };
}

function normalizePitcher({ side, name, playerId, personPayload, seasonPayload, advancedPayload, fipResult = null, vsTeamResult = null, atVenueResult = null, espnAthleteId = null, recoveredFromEspn = false }) {
  if (!playerId) {
    return {
      name: name ?? null,
      mlb_id: null,
      id: null,
      unavailable_reason: 'no probable starter MLB player id',
      fip: null,
      fip_source: null,
      fip_reason: 'no_mlb_id',
      vs_opponent: { era: null, ip: null, span: null, source_path: null, reason: 'no_mlb_id' },
      at_park: { era: null, gs: null, ip: null, source_path: null, reason: atVenueResult?.reason ?? 'no_mlb_id' },
      espn_athlete_id: espnAthleteId,
      recovered_from_espn: recoveredFromEspn,
    };
  }

  const stat = firstStat(seasonPayload);
  const advanced = firstStat(advancedPayload);
  const battersFaced = toNumber(stat?.battersFaced ?? advanced?.battersFaced);
  const strikeOuts = toNumber(stat?.strikeOuts);
  const walks = toNumber(stat?.baseOnBalls);
  const gamesStarted = toNumber(stat?.gamesStarted);
  const qualityStarts = toNumber(advanced?.qualityStarts);

  const fipValue = fipResult?.fip ?? null;
  const fipSource = fipResult?.source_path ?? null;
  const fipSeason = fipResult?.season ?? null;

  const vsOpponent = vsTeamResult
    ? {
        era: vsTeamResult.era ?? null,
        ip: vsTeamResult.ip ?? null,
        baa: vsTeamResult.baa ?? null,
        span: vsTeamResult.span ?? null,
        source_path: vsTeamResult.source_path ?? null,
        reason: null,
      }
    : { era: null, ip: null, baa: null, span: null, source_path: null, reason: 'no_split_data' };

  const atPark = atVenueResult
    ? {
        era: atVenueResult.era ?? null,
        gs: atVenueResult.gs ?? null,
        ip: atVenueResult.ip ?? null,
        source_path: atVenueResult.source_path ?? null,
        reason: atVenueResult.reason ?? null,
      }
    : { era: null, gs: null, ip: null, source_path: null, reason: 'not_attempted' };

  const unavailableFields = [];
  if (fipValue === null) unavailableFields.push('fip');
  if (vsOpponent.era === null) unavailableFields.push('vs_opponent_era');
  if (atPark.era === null) unavailableFields.push('pitcher_at_park_era');

  return {
    side,
    name: name ?? personPayload?.people?.[0]?.fullName ?? null,
    mlb_id: playerId,
    id: playerId,
    hand: personPayload?.people?.[0]?.pitchHand?.code ?? null,
    era: toNumber(stat?.era),
    fip: fipValue,
    fip_source: fipSource,
    fip_season: fipSeason,
    fip_reason: fipValue === null ? 'no_sabermetrics_and_compute_failed' : null,
    whip: toNumber(stat?.whip),
    k_per_9: toNumber(stat?.strikeoutsPer9Inn ?? advanced?.strikeoutsPer9),
    bb_per_9: toNumber(stat?.walksPer9Inn ?? advanced?.baseOnBallsPer9),
    k_pct: battersFaced ? round(strikeOuts / battersFaced, 4) : null,
    bb_pct: battersFaced ? round(walks / battersFaced, 4) : null,
    kPct: battersFaced ? round(strikeOuts / battersFaced, 4) : null,
    bbPct: battersFaced ? round(walks / battersFaced, 4) : null,
    strikeouts: strikeOuts,
    walks,
    batters_faced: battersFaced,
    innings_pitched: stat?.inningsPitched ?? null,
    games_started: gamesStarted,
    recentStarts: gamesStarted,
    quality_starts: qualityStarts,
    recentQualityStarts: qualityStarts,
    vs_opponent: vsOpponent,
    at_park: atPark,
    espn_athlete_id: espnAthleteId,
    recovered_from_espn: recoveredFromEspn,
    unavailable_fields: unavailableFields,
  };
}

function normalizeTeamStats({ teamId, teamName, seasonPayload, vsLeftPayload, vsRightPayload, standingsRow, wobaProxy = null }) {
  const stat = firstStat(seasonPayload);
  const vsLeft = firstStat(vsLeftPayload);
  const vsRight = firstStat(vsRightPayload);

  const obp = toNumber(stat?.obp);
  const slg = toNumber(stat?.slg);
  const wobaProxyValue = wobaProxy?.woba_proxy ?? (obp != null && slg != null ? round(0.69 * obp + 0.31 * slg, 4) : null);
  const wobaSource = wobaProxy?.source_path ?? (wobaProxyValue !== null ? 'mlb_team_hitting_proxy' : null);

  return {
    team_id: teamId ?? standingsRow?.team_id ?? null,
    team_name: teamName ?? standingsRow?.team_name ?? null,
    wins: standingsRow?.wins ?? null,
    losses: standingsRow?.losses ?? null,
    gamesPlayed: standingsRow?.gamesPlayed ?? toNumber(stat?.gamesPlayed),
    runDiff: standingsRow?.runDiff ?? null,
    run_diff: standingsRow?.runDiff ?? null,
    runs_scored: standingsRow?.runsScored ?? toNumber(stat?.runs),
    runs_allowed: standingsRow?.runsAllowed ?? null,
    last10: standingsRow?.last10 ?? null,
    ops: toNumber(stat?.ops),
    obp,
    slg,
    woba: null,
    woba_proxy: wobaProxyValue,
    woba_proxy_source: wobaSource,
    woba_proxy_reason: wobaProxyValue === null ? 'no_obp_slg' : null,
    avg: toNumber(stat?.avg),
    vs_lhp_ops: toNumber(vsLeft?.ops),
    vs_rhp_ops: toNumber(vsRight?.ops),
    unavailable_fields: wobaProxyValue === null ? ['woba', 'woba_proxy'] : ['woba'],
  };
}

function normalizeBullpen({ teamId, teamName, payload }) {
  const stat = firstStat(payload);
  if (!stat) {
    return {
      team_id: teamId,
      team_name: teamName,
      era: null,
      whip: null,
      recentLoadPct: null,
      unavailable_reason: 'no MLB relief-pitching split returned',
    };
  }

  return {
    team_id: teamId,
    team_name: teamName,
    era: toNumber(stat.era),
    whip: toNumber(stat.whip),
    recentLoadPct: null,
    innings_pitched: stat.inningsPitched ?? null,
    games_pitched: toNumber(stat.gamesPitched ?? stat.gamesPlayed),
    source_split: 'team pitching statSplits sitCodes=rp',
    unavailable_fields: ['recentLoadPct'],
  };
}

function labelForGame(game) {
  if (game.away_team_abbrev && game.home_team_abbrev) return `${game.away_team_abbrev}@${game.home_team_abbrev}`;
  const abbrev = name => String(name ?? '')
    .split(/\s+/)
    .map(part => part[0])
    .join('')
    .slice(0, 3)
    .toUpperCase();
  return `${abbrev(game.away_team)}@${abbrev(game.home_team)}`;
}

function fixtureRecords({ checkedAtUtc, runDate }) {
  return [
    {
      query_type: 'mlb_stats_game_fundamentals',
      game_pk: 100001,
      game_date: runDate,
      game: 'Alpha City Aces at Beta Town Bears',
      label: 'ACA@BTB',
      away_team: 'Alpha City Aces',
      home_team: 'Beta Town Bears',
      checked_at_utc: checkedAtUtc,
      away_pitcher: {
        name: 'Placeholder Pitcher A',
        mlb_id: 1,
        id: 1,
        hand: 'R',
        era: 3.5,
        fip: null,
        whip: 1.18,
        k_per_9: 8.8,
        k_pct: 0.24,
        bb_pct: 0.07,
        kPct: 0.24,
        bbPct: 0.07,
      },
      home_pitcher: {
        name: 'Placeholder Pitcher B',
        mlb_id: 2,
        id: 2,
        hand: 'L',
        era: 4.2,
        fip: null,
        whip: 1.31,
        k_per_9: 7.4,
        k_pct: 0.2,
        bb_pct: 0.09,
        kPct: 0.2,
        bbPct: 0.09,
      },
      away_team_ops: 0.735,
      home_team_ops: 0.705,
      away_team_woba: null,
      home_team_woba: null,
      away_team_stats: { wins: 10, losses: 8, gamesPlayed: 18, runDiff: 12, ops: 0.735, woba: null, last10: '6-4' },
      home_team_stats: { wins: 8, losses: 10, gamesPlayed: 18, runDiff: -9, ops: 0.705, woba: null, last10: '4-6' },
      away_bullpen: { era: 3.9, whip: 1.25, recentLoadPct: null },
      home_bullpen: { era: 4.4, whip: 1.33, recentLoadPct: null },
      away_lineup_handedness: { vsLhpOps: 0.72, vsRhpOps: 0.74 },
      home_lineup_handedness: { vsLhpOps: 0.69, vsRhpOps: 0.71 },
      unavailable_fields: ['fip', 'woba', 'recent_bullpen_load'],
      source_urls: [],
    },
  ];
}

export function fixtureStatsEnvelope({
  runDate,
  checkedAtUtc = '2026-05-15T14:00:00.000Z',
  outputDir,
}) {
  return makeEnvelope({
    status: 'ok',
    checkedAtUtc,
    cachePath: `${outputDir}/stats_adapter.json`,
    records: fixtureRecords({ checkedAtUtc, runDate }),
    warnings: ['Fixture mode: no live MLB Stats API source was called.'],
    sourceUrls: [buildMlbStatsScheduleUrl(runDate)],
  });
}

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      'user-agent': 'captains-prediction-companion-mlb-dry-run/1.0',
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

export async function fetchStatsReadonly({
  runDate,
  outputDir,
  fixturesOnly = true,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  mlbGames = null,
  mlbDiscoveryPath = `${outputDir}/mlb_official_adapter.json`,
} = {}) {
  const checkedAtUtc = isoNow(now);
  const season = String(runDate ?? '').slice(0, 4);
  const cachePath = `${outputDir}/stats_adapter.json`;
  if (fixturesOnly) {
    return fixtureStatsEnvelope({ runDate, checkedAtUtc, outputDir });
  }

  const warnings = [
    'wOBA is not exposed by MLB Stats; using Tango proxy 0.69*OBP+0.31*SLG when OBP/SLG are available.',
    'Bullpen recent load is not exposed by the checked no-auth MLB Stats endpoints; recentLoadPct is left null.',
  ];
  const fallbackSeason = season && /^\d{4}$/.test(season) ? String(Number(season) - 1) : null;
  const errors = [];
  const sourceUrls = [];

  let games = safeArray(mlbGames);
  if (games.length === 0) {
    const discovery = readMlbGamesFromDiscovery(mlbDiscoveryPath);
    games = discovery.records;
    if (discovery.warning) warnings.push(discovery.warning);
  }

  if (typeof fetchImpl !== 'function') {
    return makeEnvelope({
      status: 'blocked',
      checkedAtUtc,
      cachePath,
      records: [],
      warnings,
      errors: ['No fetch implementation available for live-readonly MLB Stats request.'],
      sourceUrls,
    });
  }

  const scheduleUrl = buildMlbStatsScheduleUrl(runDate);
  const standingsUrl = buildStandingsUrl(season);
  sourceUrls.push(scheduleUrl, standingsUrl);

  let scheduleGames = [];
  try {
    const schedulePayload = await fetchJson(fetchImpl, scheduleUrl);
    scheduleGames = normalizeSchedulePayload(schedulePayload);
  } catch (error) {
    warnings.push(`MLB schedule hydration for team IDs failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  let standings = { byId: new Map(), byName: new Map() };
  try {
    const standingsPayload = await fetchJson(fetchImpl, standingsUrl);
    standings = normalizeStandings(standingsPayload);
  } catch (error) {
    warnings.push(`MLB standings fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (games.length === 0) games = scheduleGames;
  const scheduleByPk = new Map(scheduleGames.map(game => [game.game_pk, game]));
  const scheduleByTeams = new Map(scheduleGames.map(game => [`${game.away_team}|${game.home_team}`, game]));
  const mergedGames = games.map(game => ({
    ...(scheduleByTeams.get(`${game.away_team}|${game.home_team}`) ?? {}),
    ...(scheduleByPk.get(game.game_pk) ?? {}),
    ...game,
    probable_pitchers: {
      ...(scheduleByPk.get(game.game_pk)?.probable_pitchers ?? {}),
      ...(game.probable_pitchers ?? {}),
    },
  }));

  const pitcherCache = new Map();
  const teamCache = new Map();
  const bullpenCache = new Map();
  const fipCache = new Map();
  const wobaProxyCache = new Map();
  const vsTeamCache = new Map();
  const atVenueCache = new Map();
  const espnScoreboardCache = new Map();
  const espnAthleteSplitsCache = new Map();
  const espnIdByMlbId = new Map();
  const mlbIdResolveCache = new Map();

  async function getEspnScoreboard(dateYmd) {
    if (!dateYmd) return [];
    if (espnScoreboardCache.has(dateYmd)) return espnScoreboardCache.get(dateYmd);
    const compact = String(dateYmd).replace(/-/g, '');
    const url = buildEspnScoreboardUrl(compact);
    sourceUrls.push(url);
    let probables = [];
    try {
      const payload = await fetchJson(fetchImpl, url);
      probables = extractEspnProbables(payload);
    } catch (error) {
      warnings.push(`ESPN scoreboard fetch failed for ${dateYmd}: ${error instanceof Error ? error.message : String(error)}`);
    }
    espnScoreboardCache.set(dateYmd, probables);
    return probables;
  }

  function matchEspnGame(probables, awayTeam, homeTeam) {
    const a = String(awayTeam ?? '').toLowerCase();
    const h = String(homeTeam ?? '').toLowerCase();
    return probables.find(p => {
      const pa = String(p.away?.team_name ?? '').toLowerCase();
      const ph = String(p.home?.team_name ?? '').toLowerCase();
      return pa && ph && (pa === a || pa.includes(a) || a.includes(pa))
                       && (ph === h || ph.includes(h) || h.includes(ph));
    }) ?? null;
  }

  async function resolveMlbIdCached(fullName) {
    if (!fullName) return null;
    if (mlbIdResolveCache.has(fullName)) return mlbIdResolveCache.get(fullName);
    sourceUrls.push(buildPeopleSearchUrl(fullName));
    const id = await resolveMlbIdByName(fetchImpl, fullName);
    mlbIdResolveCache.set(fullName, id);
    return id;
  }

  async function pitcherData(playerId, name) {
    if (!playerId) return { person: null, seasonStats: null, advancedStats: null };
    if (pitcherCache.has(playerId)) return pitcherCache.get(playerId);

    const urls = {
      person: buildPersonUrl(playerId),
      seasonStats: buildPitcherSeasonStatsUrl(playerId, season),
      advancedStats: buildPitcherAdvancedStatsUrl(playerId, season),
    };
    sourceUrls.push(urls.person, urls.seasonStats, urls.advancedStats);
    const value = {};
    for (const [key, url] of Object.entries(urls)) {
      try {
        value[key] = await fetchJson(fetchImpl, url);
      } catch (error) {
        value[key] = null;
        warnings.push(`Pitcher ${name ?? playerId} ${key} fetch failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    pitcherCache.set(playerId, value);
    return value;
  }

  async function pitcherFip(playerId) {
    if (!playerId) return null;
    if (fipCache.has(playerId)) return fipCache.get(playerId);
    const result = await getPitcherFipBestEffort(fetchImpl, playerId, season, fallbackSeason);
    if (result?.source_url) sourceUrls.push(result.source_url);
    fipCache.set(playerId, result);
    return result;
  }

  async function pitcherVsTeam(playerId, opposingTeamId) {
    if (!playerId || !opposingTeamId) return null;
    const key = `${playerId}|${opposingTeamId}`;
    if (vsTeamCache.has(key)) return vsTeamCache.get(key);
    const result = await getPitcherVsTeam(fetchImpl, playerId, opposingTeamId, season);
    if (result?.source_url) sourceUrls.push(result.source_url);
    vsTeamCache.set(key, result);
    return result;
  }

  async function pitcherAtVenue(playerId, espnAthleteId, venueName) {
    if (!venueName) return { era: null, ip: null, gs: null, source_path: null, reason: 'no_venue_name' };
    const key = `${playerId ?? 'x'}|${espnAthleteId ?? 'x'}|${venueName}`;
    if (atVenueCache.has(key)) return atVenueCache.get(key);
    if (!espnAthleteId) {
      const stub = { era: null, ip: null, gs: null, source_path: null, reason: 'no_espn_id' };
      atVenueCache.set(key, stub);
      return stub;
    }
    if (espnAthleteSplitsCache.has(espnAthleteId)) {
      // already fetched; extract from payload
      const cached = espnAthleteSplitsCache.get(espnAthleteId);
      const match = cached ? extractEspnVenueSplit(cached, venueName) : null;
      const out = match ?? { era: null, ip: null, gs: null, source_path: null, reason: 'venue_not_in_byArena' };
      atVenueCache.set(key, out);
      return out;
    }
    const url = buildEspnPitcherSplitsUrl(espnAthleteId, season);
    sourceUrls.push(url);
    let payload = null;
    try {
      payload = await fetchJson(fetchImpl, url);
    } catch (error) {
      const out = { era: null, ip: null, gs: null, source_path: null, reason: `espn_fetch_failed:${error instanceof Error ? error.message : String(error)}` };
      espnAthleteSplitsCache.set(espnAthleteId, null);
      atVenueCache.set(key, out);
      return out;
    }
    espnAthleteSplitsCache.set(espnAthleteId, payload);
    const match = extractEspnVenueSplit(payload, venueName);
    const out = match
      ? { ...match, source_url: url }
      : { era: null, ip: null, gs: null, source_path: null, reason: 'venue_not_in_byArena' };
    atVenueCache.set(key, out);
    return out;
  }

  async function teamData(teamId, teamName) {
    if (!teamId) return { season: null, vsLeft: null, vsRight: null };
    if (teamCache.has(teamId)) return teamCache.get(teamId);

    const urls = {
      season: buildTeamHittingStatsUrl(teamId, season),
      vsLeft: buildTeamHittingSplitUrl(teamId, season, 'vl'),
      vsRight: buildTeamHittingSplitUrl(teamId, season, 'vr'),
    };
    sourceUrls.push(urls.season, urls.vsLeft, urls.vsRight);
    const value = {};
    for (const [key, url] of Object.entries(urls)) {
      try {
        value[key] = await fetchJson(fetchImpl, url);
      } catch (error) {
        value[key] = null;
        warnings.push(`Team ${teamName ?? teamId} ${key} fetch failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    teamCache.set(teamId, value);
    return value;
  }

  async function teamWoba(teamId) {
    if (!teamId) return null;
    if (wobaProxyCache.has(teamId)) return wobaProxyCache.get(teamId);
    const result = await getTeamWobaProxy(fetchImpl, teamId, season);
    if (result?.source_url) sourceUrls.push(result.source_url);
    wobaProxyCache.set(teamId, result);
    return result;
  }

  async function bullpenData(teamId, teamName) {
    if (!teamId) return null;
    if (bullpenCache.has(teamId)) return bullpenCache.get(teamId);
    const url = buildTeamBullpenStatsUrl(teamId, season);
    sourceUrls.push(url);
    let value = null;
    try {
      value = await fetchJson(fetchImpl, url);
    } catch (error) {
      warnings.push(`Team ${teamName ?? teamId} bullpen fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    bullpenCache.set(teamId, value);
    return value;
  }

  const records = [];
  for (const game of mergedGames) {
    const awayTeamId = game.away_team_id ?? standings.byName.get(game.away_team)?.team_id ?? null;
    const homeTeamId = game.home_team_id ?? standings.byName.get(game.home_team)?.team_id ?? null;
    let awayPitcherId = game.probable_pitchers?.away_id ?? null;
    let homePitcherId = game.probable_pitchers?.home_id ?? null;
    let awayPitcherName = game.probable_pitchers?.away ?? null;
    let homePitcherName = game.probable_pitchers?.home ?? null;
    let awayHand = game.probable_pitchers?.away_hand ?? null;
    let homeHand = game.probable_pitchers?.home_hand ?? null;
    let awayEspnId = null;
    let homeEspnId = null;
    let awayRecovered = false;
    let homeRecovered = false;

    // ESPN scoreboard: always pull (for venue splits AND probable recovery)
    const espnDate = game.game_date ?? runDate;
    const espnProbables = await getEspnScoreboard(espnDate);
    const espnMatch = matchEspnGame(espnProbables, game.away_team, game.home_team);
    if (espnMatch) {
      awayEspnId = espnMatch.away?.espn_athlete_id ?? null;
      homeEspnId = espnMatch.home?.espn_athlete_id ?? null;
      // Probable recovery: only fill gaps in name/handedness; resolve mlb_id by name if missing
      if (!awayPitcherName && espnMatch.away?.pitcher_name) {
        awayPitcherName = espnMatch.away.pitcher_name;
        awayHand = awayHand ?? espnMatch.away.hand ?? null;
        awayRecovered = true;
      }
      if (!homePitcherName && espnMatch.home?.pitcher_name) {
        homePitcherName = espnMatch.home.pitcher_name;
        homeHand = homeHand ?? espnMatch.home.hand ?? null;
        homeRecovered = true;
      }
      if (!awayPitcherId && awayPitcherName) {
        const resolved = await resolveMlbIdCached(awayPitcherName);
        if (resolved) awayPitcherId = resolved;
        else warnings.push(`ESPN recovered away starter ${awayPitcherName} but MLB id unresolved (${game.away_team} @ ${game.home_team}).`);
      }
      if (!homePitcherId && homePitcherName) {
        const resolved = await resolveMlbIdCached(homePitcherName);
        if (resolved) homePitcherId = resolved;
        else warnings.push(`ESPN recovered home starter ${homePitcherName} but MLB id unresolved (${game.away_team} @ ${game.home_team}).`);
      }
    }
    if (awayPitcherId && awayEspnId) espnIdByMlbId.set(awayPitcherId, awayEspnId);
    if (homePitcherId && homeEspnId) espnIdByMlbId.set(homePitcherId, homeEspnId);

    if (!awayPitcherId || !homePitcherId) {
      warnings.push(`Missing probable starter id for ${game.away_team} at ${game.home_team}.`);
    }
    if (!awayTeamId || !homeTeamId) {
      warnings.push(`Missing MLB team id for ${game.away_team} at ${game.home_team}.`);
    }

    const venueName = game.venue?.name ?? game.venue ?? null;

    const [
      awayPitcherRaw, homePitcherRaw,
      awayTeamRaw, homeTeamRaw,
      awayBullpenRaw, homeBullpenRaw,
      awayFip, homeFip,
      awayWoba, homeWoba,
      awayVsOpp, homeVsOpp,
      awayAtPark, homeAtPark,
    ] = await Promise.all([
      pitcherData(awayPitcherId, awayPitcherName),
      pitcherData(homePitcherId, homePitcherName),
      teamData(awayTeamId, game.away_team),
      teamData(homeTeamId, game.home_team),
      bullpenData(awayTeamId, game.away_team),
      bullpenData(homeTeamId, game.home_team),
      pitcherFip(awayPitcherId),
      pitcherFip(homePitcherId),
      teamWoba(awayTeamId),
      teamWoba(homeTeamId),
      pitcherVsTeam(awayPitcherId, homeTeamId),
      pitcherVsTeam(homePitcherId, awayTeamId),
      pitcherAtVenue(awayPitcherId, awayEspnId, venueName),
      pitcherAtVenue(homePitcherId, homeEspnId, venueName),
    ]);

    const awayTeamStats = normalizeTeamStats({
      teamId: awayTeamId,
      teamName: game.away_team,
      seasonPayload: awayTeamRaw.season,
      vsLeftPayload: awayTeamRaw.vsLeft,
      vsRightPayload: awayTeamRaw.vsRight,
      standingsRow: standings.byId.get(awayTeamId) ?? standings.byName.get(game.away_team),
      wobaProxy: awayWoba,
    });
    const homeTeamStats = normalizeTeamStats({
      teamId: homeTeamId,
      teamName: game.home_team,
      seasonPayload: homeTeamRaw.season,
      vsLeftPayload: homeTeamRaw.vsLeft,
      vsRightPayload: homeTeamRaw.vsRight,
      standingsRow: standings.byId.get(homeTeamId) ?? standings.byName.get(game.home_team),
      wobaProxy: homeWoba,
    });

    const gameUrls = sourceUrls.slice();
    const baseUnavailable = ['woba', 'pitcher_vs_lineup_ops', 'recent_bullpen_load'];
    if (awayFip?.fip == null && homeFip?.fip == null) baseUnavailable.push('fip');
    if (awayAtPark?.era == null && homeAtPark?.era == null) baseUnavailable.push('pitcher_at_park_splits');
    if (awayVsOpp?.era == null && homeVsOpp?.era == null) baseUnavailable.push('pitcher_vs_opponent_splits');

    records.push({
      query_type: 'mlb_stats_game_fundamentals',
      game_pk: game.game_pk ?? null,
      game_date: game.game_date ?? runDate,
      start_time_utc: game.start_time_utc ?? null,
      game: `${game.away_team ?? 'Unknown Away'} at ${game.home_team ?? 'Unknown Home'}`,
      label: labelForGame(game),
      away_team: game.away_team ?? null,
      home_team: game.home_team ?? null,
      away_team_id: awayTeamId,
      home_team_id: homeTeamId,
      away_team_abbrev: game.away_team_abbrev ?? null,
      home_team_abbrev: game.home_team_abbrev ?? null,
      venue: game.venue ?? null,
      checked_at_utc: checkedAtUtc,
      source_id: 'mlb_stats',
      away_pitcher: normalizePitcher({
        side: 'away',
        name: awayPitcherName,
        playerId: awayPitcherId,
        personPayload: awayPitcherRaw.person,
        seasonPayload: awayPitcherRaw.seasonStats,
        advancedPayload: awayPitcherRaw.advancedStats,
        fipResult: awayFip,
        vsTeamResult: awayVsOpp,
        atVenueResult: awayAtPark,
        espnAthleteId: awayEspnId,
        recoveredFromEspn: awayRecovered,
      }),
      home_pitcher: normalizePitcher({
        side: 'home',
        name: homePitcherName,
        playerId: homePitcherId,
        personPayload: homePitcherRaw.person,
        seasonPayload: homePitcherRaw.seasonStats,
        advancedPayload: homePitcherRaw.advancedStats,
        fipResult: homeFip,
        vsTeamResult: homeVsOpp,
        atVenueResult: homeAtPark,
        espnAthleteId: homeEspnId,
        recoveredFromEspn: homeRecovered,
      }),
      away_team_ops: awayTeamStats.ops,
      home_team_ops: homeTeamStats.ops,
      away_team_woba: awayTeamStats.woba,
      home_team_woba: homeTeamStats.woba,
      away_team_woba_proxy: awayTeamStats.woba_proxy,
      home_team_woba_proxy: homeTeamStats.woba_proxy,
      away_team_stats: awayTeamStats,
      home_team_stats: homeTeamStats,
      away_bullpen: normalizeBullpen({ teamId: awayTeamId, teamName: game.away_team, payload: awayBullpenRaw }),
      home_bullpen: normalizeBullpen({ teamId: homeTeamId, teamName: game.home_team, payload: homeBullpenRaw }),
      away_lineup_handedness: {
        vsLhpOps: awayTeamStats.vs_lhp_ops,
        vsRhpOps: awayTeamStats.vs_rhp_ops,
        rhbPct: null,
        lhbPct: null,
      },
      home_lineup_handedness: {
        vsLhpOps: homeTeamStats.vs_lhp_ops,
        vsRhpOps: homeTeamStats.vs_rhp_ops,
        rhbPct: null,
        lhbPct: null,
      },
      unavailable_fields: baseUnavailable,
      source_urls: gameUrls,
    });
  }

  const usableRecords = records.filter(record =>
    record.away_pitcher?.era !== null
    && record.home_pitcher?.era !== null
    && record.away_team_stats?.ops !== null
    && record.home_team_stats?.ops !== null,
  );

  return makeEnvelope({
    status: records.length === 0 ? 'blocked' : usableRecords.length === records.length ? 'ok' : 'degraded',
    checkedAtUtc,
    cachePath,
    records,
    warnings,
    errors,
    sourceUrls: [...new Set(sourceUrls)],
  });
}
