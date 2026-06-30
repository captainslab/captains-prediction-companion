// World Cup team baseline adapter.
// Builds a same-date, packet-safe team baseline from working public sources.
//
// Source candidates:
//   1. FIFA official calendar API (team directory + completed tournament scores)
//   2. World Football Elo TSV exports (team rating + global rank)
//   3. ESPN World Cup teams endpoint (directory fallback only)
//   4. Local same-date cached copy in state/worldcup/<date>/discovery/
//
// Hard rules:
//   - No credentials.
//   - Never fabricate FIFA rank/points when they are not available from a live
//     stable source.
//   - Derived fields must say they are derived and must downgrade
//     source_quality honestly when only partial source inputs are present.
//   - Prior-date baselines remain a separate diagnostic fallback owned by the
//     packet generator; this adapter does not treat them as current.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { DEFAULT_FIFA_API_URL, fetchStaticStructure, loadCachedStructure } from './static-structure.mjs';

export const DEFAULT_FIFA_RANKING_URL = 'https://inside.fifa.com/fifa-world-ranking/men';
export const DEFAULT_ELO_WORLD_URL = 'https://www.eloratings.net/World.tsv';
export const DEFAULT_ELO_TEAMS_URL = 'https://www.eloratings.net/en.teams.tsv';
export const DEFAULT_ESPN_TEAMS_URL = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/teams';

const CONFEDERATION_BY_CODE = Object.freeze({
  ALG: 'CAF',
  ARG: 'CONMEBOL',
  AUS: 'AFC',
  AUT: 'UEFA',
  BEL: 'UEFA',
  BIH: 'UEFA',
  BRA: 'CONMEBOL',
  CAN: 'CONCACAF',
  CPV: 'CAF',
  COL: 'CONMEBOL',
  COD: 'CAF',
  CRO: 'UEFA',
  CUW: 'CONCACAF',
  CZE: 'UEFA',
  CIV: 'CAF',
  ECU: 'CONMEBOL',
  EGY: 'CAF',
  ENG: 'UEFA',
  FRA: 'UEFA',
  GER: 'UEFA',
  GHA: 'CAF',
  HAI: 'CONCACAF',
  IRN: 'AFC',
  IRQ: 'AFC',
  JPN: 'AFC',
  JOR: 'AFC',
  KOR: 'AFC',
  MAR: 'CAF',
  MEX: 'CONCACAF',
  NED: 'UEFA',
  NZL: 'OFC',
  NOR: 'UEFA',
  PAN: 'CONCACAF',
  PAR: 'CONMEBOL',
  POR: 'UEFA',
  QAT: 'AFC',
  KSA: 'AFC',
  SCO: 'UEFA',
  SEN: 'CAF',
  RSA: 'CAF',
  ESP: 'UEFA',
  SWE: 'UEFA',
  SUI: 'UEFA',
  TUN: 'CAF',
  TUR: 'UEFA',
  USA: 'CONCACAF',
  URU: 'CONMEBOL',
  UZB: 'AFC',
});

const TEAM_KEY_ALIASES = Object.freeze({
  'bosnia herzegovina': 'bosnia and herzegovina',
  'cape verde': 'cabo verde',
  'congo dr': 'dr congo',
  'ivory coast': 'cote d ivoire',
  'iran': 'ir iran',
  'south korea': 'korea republic',
  'turkey': 'turkiye',
  'united states': 'usa',
});

function nowIso() {
  return new Date().toISOString();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function parseNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeTeamKey(name) {
  let key = String(name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  if (TEAM_KEY_ALIASES[key]) key = TEAM_KEY_ALIASES[key];
  return key;
}

function mergeTeamRecord(existing, incoming) {
  if (!existing) return { ...incoming };
  return {
    ...existing,
    ...incoming,
    team_name: existing.team_name ?? incoming.team_name ?? null,
    team_code: existing.team_code ?? incoming.team_code ?? null,
  };
}

function dedupeTeams(teams = []) {
  const seen = new Map();
  for (const team of teams) {
    const key = normalizeTeamKey(team.team_name);
    if (!key) continue;
    seen.set(key, mergeTeamRecord(seen.get(key), team));
  }
  return [...seen.values()];
}

async function fetchText(url, fetchImpl = fetch, accept = 'text/plain') {
  const res = await fetchImpl(url, { headers: { Accept: accept } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function fetchJson(url, fetchImpl = fetch) {
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function buildTournamentStats(structure = null) {
  const stats = new Map();
  const ensure = (teamName) => {
    const key = normalizeTeamKey(teamName);
    if (!key) return null;
    if (!stats.has(key)) {
      stats.set(key, {
        team_name: teamName,
        matches_played: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        goals_for: 0,
        goals_against: 0,
      });
    }
    return stats.get(key);
  };

  for (const match of structure?.matches || []) {
    const homeGoals = parseNumber(match.home_goals);
    const awayGoals = parseNumber(match.away_goals);
    if (homeGoals == null || awayGoals == null) continue;
    const home = ensure(match.home_team);
    const away = ensure(match.away_team);
    if (!home || !away) continue;

    home.matches_played += 1;
    home.goals_for += homeGoals;
    home.goals_against += awayGoals;

    away.matches_played += 1;
    away.goals_for += awayGoals;
    away.goals_against += homeGoals;

    if (homeGoals > awayGoals) {
      home.wins += 1;
      away.losses += 1;
    } else if (awayGoals > homeGoals) {
      away.wins += 1;
      home.losses += 1;
    } else {
      home.draws += 1;
      away.draws += 1;
    }
  }

  const completed = [...stats.values()].filter((entry) => entry.matches_played > 0);
  const mean = (values, fallback) => {
    if (!values.length) return fallback;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  };

  return {
    by_team: stats,
    averages: {
      goals_for_per_match: mean(
        completed.map((entry) => entry.goals_for / entry.matches_played),
        1.25,
      ),
      goals_against_per_match: mean(
        completed.map((entry) => entry.goals_against / entry.matches_played),
        1.25,
      ),
      draw_rate: mean(
        completed.map((entry) => entry.draws / entry.matches_played),
        0.28,
      ),
    },
  };
}

function completedMatchCount(structure = null) {
  return (structure?.matches || []).filter((match) =>
    parseNumber(match.home_goals) != null && parseNumber(match.away_goals) != null,
  ).length;
}

function scale(value, inMin, inMax, outMin, outMax) {
  if (value == null) return null;
  if (!Number.isFinite(inMin) || !Number.isFinite(inMax) || inMax <= inMin) {
    return (outMin + outMax) / 2;
  }
  const ratio = (value - inMin) / (inMax - inMin);
  return outMin + clamp(ratio, 0, 1) * (outMax - outMin);
}

function deriveRichRecord({ team, elo, fifa, statLine, statAverages, eloRange, completedMatches }) {
  const quality = elo?.elo_rating != null
    ? round1(scale(elo.elo_rating, eloRange.min, eloRange.max, 42, 92))
    : null;

  const played = statLine?.matches_played ?? 0;
  const goalsForPerMatch = played > 0
    ? statLine.goals_for / played
    : statAverages.goals_for_per_match;
  const goalsAgainstPerMatch = played > 0
    ? statLine.goals_against / played
    : statAverages.goals_against_per_match;
  const drawRate = played > 0
    ? statLine.draws / played
    : statAverages.draw_rate;
  const attackForm = clamp(
    50 + ((goalsForPerMatch - statAverages.goals_for_per_match) * 12),
    30,
    75,
  );
  const defenseForm = clamp(
    50 + ((statAverages.goals_against_per_match - goalsAgainstPerMatch) * 12),
    30,
    75,
  );
  const styleSignal = clamp(
    50
      + ((goalsForPerMatch + goalsAgainstPerMatch - (statAverages.goals_for_per_match + statAverages.goals_against_per_match)) * 8)
      - ((drawRate - statAverages.draw_rate) * 20),
    35,
    65,
  );

  const attack = quality == null ? null : round1(clamp((quality * 0.78) + (attackForm * 0.22), 0, 100));
  const defense = quality == null ? null : round1(clamp((quality * 0.78) + (defenseForm * 0.22), 0, 100));
  const style = quality == null ? null : round1(clamp((quality * 0.20) + (styleSignal * 0.80), 0, 100));
  const setPieceAttack = attack == null || style == null
    ? null
    : round1(clamp((attack * 0.60) + (quality * 0.25) + (style * 0.15), 0, 100));
  const setPieceDefense = defense == null || style == null
    ? null
    : round1(clamp((defense * 0.60) + (quality * 0.25) + ((100 - style) * 0.15), 0, 100));
  const goalkeeper = defense == null
    ? null
    : round1(clamp((defense * 0.68) + (quality * 0.32), 0, 100));
  const chanceQuality = attack == null || style == null
    ? null
    : round1(clamp((attack * 0.68) + (quality * 0.20) + (style * 0.12), 0, 100));

  const hasTournamentContext = completedMatches > 0;
  const derivation = hasTournamentContext
    ? 'eloratings_world_tsv+worldcup_calendar_results_heuristics'
    : 'eloratings_world_tsv+worldcup_team_directory_heuristics';
  const sourceQuality = fifa?.fifa_rank != null || fifa?.fifa_points != null
    ? (hasTournamentContext ? 'high' : 'medium')
    : (elo?.elo_rating != null ? 'medium' : 'low');

  return {
    team_name: team.team_name,
    team_code: team.team_code ?? null,
    fifa_rank: fifa?.fifa_rank ?? null,
    fifa_points: fifa?.fifa_points ?? null,
    elo_rating: elo?.elo_rating ?? null,
    confederation: team.team_code ? (CONFEDERATION_BY_CODE[team.team_code] ?? null) : null,
    quality_score_0_100: quality,
    attack_rating: attack,
    defense_rating: defense,
    style,
    set_piece_rating: setPieceAttack,
    set_piece_defense: setPieceDefense,
    goalkeeper_rating: goalkeeper,
    chance_quality: chanceQuality,
    derivation,
    source_quality: sourceQuality,
  };
}

function buildTeamDirectory({ structure = null, fifaTeams = [], espnTeams = [] } = {}) {
  const fifaMap = new Map(dedupeTeams(fifaTeams).map((team) => [normalizeTeamKey(team.team_name), team]));
  const espnMap = new Map(dedupeTeams(espnTeams).map((team) => [normalizeTeamKey(team.team_name), team]));
  const structureTeams = dedupeTeams(
    [...new Set((structure?.matches || []).flatMap((match) => [match.home_team, match.away_team]))]
      .map((team_name) => ({ team_name, team_code: null })),
  );

  if (structureTeams.length) {
    return structureTeams.map((team) => {
      const key = normalizeTeamKey(team.team_name);
      const fifa = fifaMap.get(key);
      const espn = espnMap.get(key);
      return {
        team_name: team.team_name,
        team_code: fifa?.team_code ?? espn?.team_code ?? null,
      };
    });
  }

  const fallback = fifaTeams.length ? fifaTeams : espnTeams;
  return dedupeTeams(fallback);
}

export async function fetchFifaRanking({ url = DEFAULT_FIFA_RANKING_URL, fetchImpl = fetch } = {}) {
  try {
    const html = await fetchText(url, fetchImpl, 'text/html');
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.+?)<\/script>/s);
    if (!nextDataMatch) {
      return {
        ok: false,
        source_id: 'fifa_ranking',
        source_url: url,
        fetched_at: nowIso(),
        confidence: 'none',
        error: 'official ranking page did not expose a stable machine-readable table payload',
      };
    }

    const nextData = JSON.parse(nextDataMatch[1]);
    const table = nextData?.props?.pageProps?.rankingTable
      || nextData?.props?.pageProps?.ranking
      || nextData?.props?.pageProps?.initialRankingTable
      || [];
    const teams = Array.isArray(table)
      ? table.map((row) => {
          if (!row?.teamName) return null;
          return {
            team_name: row.teamName,
            team_code: row.code ?? null,
            fifa_rank: parseNumber(row.rank),
            fifa_points: parseNumber(row.points),
          };
        }).filter(Boolean)
      : [];
    if (!teams.length) {
      return {
        ok: false,
        source_id: 'fifa_ranking',
        source_url: url,
        fetched_at: nowIso(),
        confidence: 'none',
        error: 'official ranking page payload parsed but no ranking rows were exposed',
      };
    }

    return {
      ok: true,
      source_id: 'fifa_ranking',
      source_url: url,
      fetched_at: nowIso(),
      confidence: 'medium',
      teams,
      team_count: teams.length,
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export async function fetchFifaTeamDirectory({ url = DEFAULT_FIFA_API_URL, fetchImpl = fetch } = {}) {
  try {
    const data = await fetchJson(url, fetchImpl);
    const rows = Array.isArray(data?.Results) ? data.Results : (Array.isArray(data) ? data : []);
    const teams = dedupeTeams(rows.flatMap((match) => {
      const homeName = match?.Home?.TeamName?.[0]?.Description ?? null;
      const awayName = match?.Away?.TeamName?.[0]?.Description ?? null;
      return [
        homeName ? { team_name: homeName, team_code: match?.Home?.Abbreviation ?? null } : null,
        awayName ? { team_name: awayName, team_code: match?.Away?.Abbreviation ?? null } : null,
      ].filter(Boolean);
    }));
    return {
      ok: true,
      source_id: 'fifa_calendar_directory',
      source_url: url,
      fetched_at: nowIso(),
      confidence: teams.length ? 'high' : 'low',
      teams,
      team_count: teams.length,
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export async function fetchEspnWorldCupTeams({ url = DEFAULT_ESPN_TEAMS_URL, fetchImpl = fetch } = {}) {
  try {
    const data = await fetchJson(url, fetchImpl);
    const teams = dedupeTeams(
      (data?.sports?.[0]?.leagues?.[0]?.teams || []).map((entry) => ({
        team_name: entry?.team?.displayName ?? entry?.team?.name ?? null,
        team_code: entry?.team?.abbreviation ?? null,
      })),
    );
    return {
      ok: true,
      source_id: 'espn_worldcup_teams',
      source_url: url,
      fetched_at: nowIso(),
      confidence: teams.length ? 'medium' : 'low',
      teams,
      team_count: teams.length,
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export async function fetchEloRatings({
  worldUrl = DEFAULT_ELO_WORLD_URL,
  teamsUrl = DEFAULT_ELO_TEAMS_URL,
  fetchImpl = fetch,
} = {}) {
  try {
    const [worldTsv, teamTsv] = await Promise.all([
      fetchText(worldUrl, fetchImpl),
      fetchText(teamsUrl, fetchImpl),
    ]);

    const codeToName = new Map();
    for (const line of teamTsv.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [code, primaryName] = line.split('\t');
      if (!code || !primaryName || /_loc$/.test(code)) continue;
      codeToName.set(code, primaryName);
    }

    const teams = [];
    for (const line of worldTsv.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const fields = line.split('\t');
      const eloRank = parseNumber(fields[0]);
      const eloCode = fields[2] ?? null;
      const eloRating = parseNumber(fields[3]);
      const teamName = eloCode ? codeToName.get(eloCode) : null;
      if (!teamName || eloRank == null || eloRating == null) continue;
      teams.push({
        team_name: teamName,
        elo_code: eloCode,
        elo_rank: eloRank,
        elo_rating: eloRating,
      });
    }

    return {
      ok: true,
      source_id: 'eloratings_world_tsv',
      source_url: worldUrl,
      fetched_at: nowIso(),
      confidence: teams.length ? 'high' : 'low',
      teams,
      team_count: teams.length,
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export function loadCachedTeamBaseline(stateRoot, date) {
  const path = resolve(stateRoot, 'worldcup', date, 'discovery', 'team_baseline.json');
  if (!existsSync(path)) return { ok: false, error: 'cache miss' };
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return { ok: true, cached: true, ...data };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export async function fetchTeamBaseline({
  stateRoot,
  date,
  structure = null,
  fetchImpl = fetch,
  fifaRankingUrl = process.env.WORLDCUP_TEAM_BASELINE_FIFA_RANKING_URL || DEFAULT_FIFA_RANKING_URL,
  fifaCalendarUrl = process.env.WORLDCUP_TEAM_BASELINE_FIFA_CALENDAR_URL || DEFAULT_FIFA_API_URL,
  eloWorldUrl = process.env.WORLDCUP_TEAM_BASELINE_ELO_WORLD_URL || DEFAULT_ELO_WORLD_URL,
  eloTeamsUrl = process.env.WORLDCUP_TEAM_BASELINE_ELO_TEAMS_URL || DEFAULT_ELO_TEAMS_URL,
  espnTeamsUrl = process.env.WORLDCUP_TEAM_BASELINE_ESPN_TEAMS_URL || DEFAULT_ESPN_TEAMS_URL,
} = {}) {
  let resolvedStructure = structure;
  if (!resolvedStructure && stateRoot && date) {
    const cachedStructure = loadCachedStructure(stateRoot, date);
    if (cachedStructure.ok) resolvedStructure = cachedStructure;
  }
  if (!resolvedStructure && stateRoot && date) {
    const liveStructure = await fetchStaticStructure({ stateRoot, date });
    if (liveStructure.ok) resolvedStructure = liveStructure;
  }

  const [fifaRanking, fifaDirectory, elo, espnTeams] = await Promise.all([
    fetchFifaRanking({ url: fifaRankingUrl, fetchImpl }),
    fetchFifaTeamDirectory({ url: fifaCalendarUrl, fetchImpl }),
    fetchEloRatings({ worldUrl: eloWorldUrl, teamsUrl: eloTeamsUrl, fetchImpl }),
    fetchEspnWorldCupTeams({ url: espnTeamsUrl, fetchImpl }),
  ]);

  const targetTeams = buildTeamDirectory({
    structure: resolvedStructure,
    fifaTeams: fifaDirectory.ok ? fifaDirectory.teams : [],
    espnTeams: espnTeams.ok ? espnTeams.teams : [],
  });

  if (!targetTeams.length || !elo.ok || !elo.team_count) {
    const cached = stateRoot && date ? loadCachedTeamBaseline(stateRoot, date) : null;
    if (cached?.ok) return cached;
    return {
      ok: false,
      source_id: 'team_baseline',
      fetched_at: nowIso(),
      confidence: 'none',
      teams: [],
      team_count: 0,
      errors: [
        !targetTeams.length ? 'no World Cup team directory available' : null,
        elo.error ?? null,
        fifaDirectory.error ?? null,
        espnTeams.error ?? null,
      ].filter(Boolean),
    };
  }

  const stats = buildTournamentStats(resolvedStructure);
  const completedMatches = completedMatchCount(resolvedStructure);
  const eloByTeam = new Map(elo.teams.map((team) => [normalizeTeamKey(team.team_name), team]));
  const fifaByTeam = fifaRanking.ok
    ? new Map((fifaRanking.teams || []).map((team) => [normalizeTeamKey(team.team_name), team]))
    : new Map();
  const eloRatings = elo.teams
    .map((team) => team.elo_rating)
    .filter((value) => value != null);
  const eloRange = {
    min: Math.min(...eloRatings),
    max: Math.max(...eloRatings),
  };

  const teams = targetTeams.map((team) =>
    deriveRichRecord({
      team,
      elo: eloByTeam.get(normalizeTeamKey(team.team_name)) ?? null,
      fifa: fifaByTeam.get(normalizeTeamKey(team.team_name)) ?? null,
      statLine: stats.by_team.get(normalizeTeamKey(team.team_name)) ?? null,
      statAverages: stats.averages,
      eloRange,
      completedMatches,
    }),
  );

  const populated = teams.filter((team) => team.elo_rating != null && team.quality_score_0_100 != null);
  if (!populated.length) {
    const cached = stateRoot && date ? loadCachedTeamBaseline(stateRoot, date) : null;
    if (cached?.ok) return cached;
    return {
      ok: false,
      source_id: 'team_baseline',
      fetched_at: nowIso(),
      confidence: 'none',
      teams: [],
      team_count: 0,
      errors: ['team directory resolved, but no teams could be joined to live Elo ratings'],
    };
  }

  return {
    ok: true,
    source_id: fifaDirectory.ok
      ? 'fifa_calendar_directory+eloratings_world_tsv'
      : 'espn_worldcup_teams+eloratings_world_tsv',
    fetched_at: nowIso(),
    confidence: fifaRanking.ok ? 'high' : 'medium',
    team_count: teams.length,
    teams,
    source_notes: {
      fifa_ranking_status: fifaRanking.ok ? 'parsed' : 'unavailable',
      fifa_directory_status: fifaDirectory.ok ? 'parsed' : 'unavailable',
      espn_directory_status: espnTeams.ok ? 'parsed' : 'unavailable',
      elo_status: elo.ok ? 'parsed' : 'unavailable',
      completed_worldcup_matches_used: completedMatches,
    },
    warnings: [
      fifaRanking.ok ? null : 'fifa_rank and fifa_points are null because the current official ranking page did not expose a stable machine-readable table',
      completedMatches > 0 ? null : 'derived layers use Elo-only priors because no completed same-competition scores were available yet',
    ].filter(Boolean),
  };
}
