// World Cup static tournament structure adapter.
// Normalizes fixtures, groups, venues, and kickoff times into a stable JSON schema.
//
// Source candidates (in order of preference):
//   1. FIFA official schedule API (free, no auth). WC2026 is idCompetition=17,
//      idSeason=285023 (verified 2026-06-09; 255711 was Qatar 2022).
//   2. ESPN public scoreboard API (free, no auth):
//      https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=YYYYMMDD
//      NOTE: ESPN groups by US-local date; we re-filter by kickoff_utc downstream.
//   3. openfootball/worldcup GitHub repo: 2026 data lives at 2026--usa/ as .txt
//      (no cup.json for 2026), so the JSON fetcher fails soft to the next source.
//   4. Local cached copy in state/worldcup/<date>/discovery/
//
// Hard rules:
//   - No credentials required.
//   - Fail soft: if a source is unavailable, try the next. If all fail, return MISSING.
//   - Never fabricate fixtures, kickoff times, or group assignments.
//   - Include source_url, fetched_at, and confidence for every record.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const STAGE = Object.freeze({
  GROUP: 'group',
  ROUND_OF_32: 'round_of_32',
  ROUND_OF_16: 'round_of_16',
  QUARTER: 'quarter_final',
  SEMI: 'semi_final',
  THIRD_PLACE: 'third_place',
  FINAL: 'final',
});

export const DEFAULT_FIFA_API_URL =
  'https://api.fifa.com/api/v3/calendar/matches?idSeason=285023&idCompetition=17&language=en&count=500';

export const DEFAULT_ESPN_SCOREBOARD_URL =
  'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard';

export const DEFAULT_OPENFOOTBALL_URL =
  'https://raw.githubusercontent.com/openfootball/worldcup/master/2026--usa/cup.json';

const GROUPS = Object.freeze(['A','B','C','D','E','F','G','H','I','J','K','L']);

function nowIso() { return new Date().toISOString(); }

function normalizeFifaMatch(m) {
  if (!m || !m.IdMatch) return null;
  const home = m.Home?.TeamName?.[0]?.Description;
  const away = m.Away?.TeamName?.[0]?.Description;
  if (!home || !away) return null;
  const dateUtc = m.Date ? new Date(m.Date).toISOString() : null;
  const stage = inferStageFromFifa(m);
  return {
    match_id: String(m.IdMatch),
    home_team: home,
    away_team: away,
    group: m.GroupName?.[0]?.Description ?? null,
    stage,
    round: m.RoundNumber ?? null,
    venue: m.Stadium?.Name?.[0]?.Description ?? null,
    city: m.Stadium?.CityName?.[0]?.Description ?? null,
    kickoff_utc: dateUtc,
    kickoff_local: m.LocalDate ? new Date(m.LocalDate).toISOString() : dateUtc,
    timezone: m.Timezone ?? 'America/New_York',
    status: m.MatchStatus?.Name?.[0]?.Description ?? 'SCHEDULED',
    home_goals: m.Home?.Score ?? null,
    away_goals: m.Away?.Score ?? null,
  };
}

function inferStageFromFifa(m) {
  const g = m.GroupName?.[0]?.Description;
  if (g && GROUPS.includes(g)) return STAGE.GROUP;
  const rn = m.RoundNumber;
  if (rn === 3) return STAGE.ROUND_OF_32;
  if (rn === 4) return STAGE.ROUND_OF_16;
  if (rn === 5) return STAGE.QUARTER;
  if (rn === 6) return STAGE.SEMI;
  if (rn === 7) return STAGE.THIRD_PLACE;
  if (rn === 8) return STAGE.FINAL;
  return null;
}

function normalizeOpenfootballMatch(m, groupName) {
  if (!m || !m.team1 || !m.team2) return null;
  const dateUtc = m.date ? new Date(`${m.date}T${m.time ?? '00:00'}:00Z`).toISOString() : null;
  return {
    match_id: `${m.team1.code ?? m.team1.name}-${m.team2.code ?? m.team2.name}-${m.date ?? 'unknown'}`,
    home_team: m.team1.name,
    away_team: m.team2.name,
    group: groupName ?? null,
    stage: groupName ? STAGE.GROUP : inferKnockoutStageFromOpenfootball(m),
    round: null,
    venue: m.stadium ?? null,
    city: m.city ?? null,
    kickoff_utc: dateUtc,
    kickoff_local: dateUtc,
    timezone: m.timezone ?? 'America/New_York',
    status: 'SCHEDULED',
    home_goals: m.score?.ft?.[0] ?? null,
    away_goals: m.score?.ft?.[1] ?? null,
  };
}

function inferKnockoutStageFromOpenfootball(m) {
  if (!m) return null;
  const round = m.round ?? '';
  if (round.includes('Round of 32')) return STAGE.ROUND_OF_32;
  if (round.includes('Round of 16')) return STAGE.ROUND_OF_16;
  if (round.includes('Quarter')) return STAGE.QUARTER;
  if (round.includes('Semi')) return STAGE.SEMI;
  if (round.includes('3rd') || round.includes('Third')) return STAGE.THIRD_PLACE;
  if (round.includes('Final') && !round.includes('3rd') && !round.includes('Third')) return STAGE.FINAL;
  return null;
}

export async function fetchFifaCalendar(url = DEFAULT_FIFA_API_URL) {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const data = await res.json();
    const matches = (data?.Results || data || [])
      .map(normalizeFifaMatch)
      .filter(Boolean);
    return {
      ok: true,
      source_id: 'fifa_api',
      source_url: url,
      fetched_at: nowIso(),
      confidence: 'high',
      matches,
      match_count: matches.length,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function normalizeEspnEvent(ev) {
  if (!ev || !ev.id) return null;
  const comp = ev.competitions?.[0];
  const competitors = comp?.competitors || [];
  const home = competitors.find(c => c.homeAway === 'home');
  const away = competitors.find(c => c.homeAway === 'away');
  if (!home?.team?.displayName || !away?.team?.displayName) return null;
  const kickoffUtc = ev.date ? new Date(ev.date).toISOString() : null;
  const note = comp?.notes?.[0]?.headline ?? ev.season?.slug ?? '';
  return {
    match_id: `espn-${ev.id}`,
    home_team: home.team.displayName,
    away_team: away.team.displayName,
    group: inferGroupFromEspnNote(note),
    stage: inferStageFromEspnNote(note),
    round: null,
    venue: comp?.venue?.fullName ?? null,
    city: comp?.venue?.address?.city ?? null,
    kickoff_utc: kickoffUtc,
    kickoff_local: kickoffUtc,
    timezone: null,
    status: ev.status?.type?.name === 'STATUS_FINAL' ? 'FINISHED' : 'SCHEDULED',
    home_goals: ev.status?.type?.completed ? Number(home.score ?? null) : null,
    away_goals: ev.status?.type?.completed ? Number(away.score ?? null) : null,
  };
}

function inferGroupFromEspnNote(note) {
  const m = /Group\s+([A-L])\b/i.exec(note || '');
  return m ? m[1].toUpperCase() : null;
}

function inferStageFromEspnNote(note) {
  const n = note || '';
  if (/Group\s+[A-L]/i.test(n)) return STAGE.GROUP;
  if (/Round of 32/i.test(n)) return STAGE.ROUND_OF_32;
  if (/Round of 16/i.test(n)) return STAGE.ROUND_OF_16;
  if (/Quarter/i.test(n)) return STAGE.QUARTER;
  if (/Semi/i.test(n)) return STAGE.SEMI;
  if (/Third|3rd/i.test(n)) return STAGE.THIRD_PLACE;
  if (/Final/i.test(n)) return STAGE.FINAL;
  return null;
}

export async function fetchEspnScoreboard({ url = DEFAULT_ESPN_SCOREBOARD_URL, date } = {}) {
  try {
    // ESPN dates= is windowed by US-local day; widen by one day each side and
    // let the caller filter on kickoff_utc.
    let full = url;
    if (date) {
      const d = new Date(`${date}T00:00:00Z`);
      const fmt = (x) => x.toISOString().slice(0, 10).replaceAll('-', '');
      const from = new Date(d.getTime() - 86400000);
      const to = new Date(d.getTime() + 86400000);
      full = `${url}?dates=${fmt(from)}-${fmt(to)}`;
    }
    const res = await fetch(full, { headers: { Accept: 'application/json' } });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const data = await res.json();
    const matches = (data?.events || []).map(normalizeEspnEvent).filter(Boolean);
    return {
      ok: true,
      source_id: 'espn_scoreboard',
      source_url: full,
      fetched_at: nowIso(),
      confidence: 'medium',
      matches,
      match_count: matches.length,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function fetchOpenfootballCalendar(url = DEFAULT_OPENFOOTBALL_URL) {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const data = await res.json();
    const matches = [];
    // openfootball format: { groups: [{ name, matches: [...] }], knockout: { round_of_32: [...], ... } }
    for (const g of data?.groups || []) {
      for (const m of g.matches || []) {
        const nm = normalizeOpenfootballMatch(m, g.name);
        if (nm) matches.push(nm);
      }
    }
    for (const [stageKey, roundMatches] of Object.entries(data?.knockout || {})) {
      for (const m of roundMatches || []) {
        const nm = normalizeOpenfootballMatch(m, null);
        if (nm) {
          nm.stage = stageKey;
          matches.push(nm);
        }
      }
    }
    return {
      ok: true,
      source_id: 'openfootball',
      source_url: url,
      fetched_at: nowIso(),
      confidence: 'medium',
      matches,
      match_count: matches.length,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function loadCachedStructure(stateRoot, date) {
  const p = resolve(stateRoot, 'worldcup', date, 'discovery', 'static_structure.json');
  if (!existsSync(p)) return { ok: false, error: 'cache miss' };
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'));
    return { ok: true, cached: true, ...data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Fetch static tournament structure with fallback chain.
 * Returns normalized matches array + metadata. Never throws.
 */
export async function fetchStaticStructure({ stateRoot, date, fifaUrl, espnUrl, openfootballUrl } = {}) {
  // 1. Try FIFA API (official, primary)
  const fifa = await fetchFifaCalendar(fifaUrl);
  if (fifa.ok && fifa.match_count > 0) return fifa;

  // 2. Try ESPN public scoreboard (trusted public sports fallback)
  const espn = await fetchEspnScoreboard({ url: espnUrl, date });
  if (espn.ok && espn.match_count > 0) return espn;

  // 3. Try openfootball (open dataset; 2026 JSON may not exist — fails soft)
  const ofb = await fetchOpenfootballCalendar(openfootballUrl);
  if (ofb.ok && ofb.match_count > 0) return ofb;

  // 4. Try local cache
  const cached = loadCachedStructure(stateRoot, date);
  if (cached.ok) return cached;

  return {
    ok: false,
    source_id: 'none',
    fetched_at: nowIso(),
    confidence: 'none',
    matches: [],
    match_count: 0,
    errors: [fifa.error, espn.error, ofb.error, cached.error].filter(Boolean),
  };
}
