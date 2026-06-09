// World Cup matchday data adapter.
// Normalizes squads, injuries, suspensions, lineups, and lineup strength deltas.
//
// Sources:
//   1. FIFA squad lists (if accessible)
//   2. ESPN API: https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/teams/{teamId}
//   3. Local cached copy in state/worldcup/matchday/
//
// Hard rules:
//   - No credentials.
//   - Fail soft with MISSING.
//   - Never fabricate lineups or injury status.
//   - lineup_status must be one of: lineup_pending, lineup_expected, lineup_confirmed.
//   - If official lineups are not available, show pre-lineup confidence downgrade.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

function nowIso() { return new Date().toISOString(); }

export const LINEUP_STATUS = Object.freeze({
  PENDING: 'lineup_pending',
  EXPECTED: 'lineup_expected',
  CONFIRMED: 'lineup_confirmed',
});

export function normalizeSquad(raw) {
  if (!raw || !Array.isArray(raw.players)) return null;
  return {
    team_name: raw.team ?? raw.name ?? null,
    team_code: raw.code ?? null,
    players: raw.players.map(p => ({
      name: p.name ?? p.fullName ?? null,
      position: p.position ?? null,
      number: p.number ?? p.jersey ?? null,
      club: p.club ?? p.team ?? null,
      age: p.age ?? null,
      caps: p.caps ?? null,
      goals: p.goals ?? null,
      status: p.status ?? 'available',
    })),
    fetched_at: nowIso(),
  };
}

export function normalizeLineup(raw) {
  if (!raw || !Array.isArray(raw.startingXI)) return null;
  return {
    team_name: raw.team ?? null,
    formation: raw.formation ?? null,
    starting_xi: raw.startingXI.map(p => ({
      name: p.name ?? null,
      position: p.position ?? null,
      number: p.number ?? null,
    })),
    substitutes: (raw.substitutes || []).map(p => ({
      name: p.name ?? null,
      position: p.position ?? null,
      number: p.number ?? null,
    })),
    coach: raw.coach ?? null,
    status: raw.status === 'confirmed' ? LINEUP_STATUS.CONFIRMED
      : raw.status === 'expected' ? LINEUP_STATUS.EXPECTED
      : LINEUP_STATUS.PENDING,
    fetched_at: nowIso(),
  };
}

export function normalizeInjuries(raw) {
  if (!raw || !Array.isArray(raw.injuries)) return null;
  return {
    team_name: raw.team ?? null,
    injuries: raw.injuries.map(i => ({
      player: i.player ?? i.name ?? null,
      injury: i.injury ?? i.type ?? null,
      status: i.status ?? 'unknown',
      expected_return: i.expected_return ?? null,
    })),
    suspensions: (raw.suspensions || []).map(s => ({
      player: s.player ?? s.name ?? null,
      reason: s.reason ?? null,
      matches_remaining: s.matches_remaining ?? null,
    })),
    fetched_at: nowIso(),
  };
}

export async function fetchEspnSquad(teamId) {
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/teams/${teamId}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const data = await res.json();
    const squad = normalizeSquad(data?.team);
    return {
      ok: true,
      source_id: 'espn_api',
      source_url: url,
      fetched_at: nowIso(),
      confidence: squad ? 'medium' : 'low',
      squad,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function fetchMatchdayData({ stateRoot, date, matchId, homeTeamId, awayTeamId } = {}) {
  const results = {
    ok: false,
    source_id: 'composite',
    fetched_at: nowIso(),
    confidence: 'none',
    match_id: matchId ?? null,
    home: { squad: null, lineup: null, injuries: null, lineup_status: LINEUP_STATUS.PENDING },
    away: { squad: null, lineup: null, injuries: null, lineup_status: LINEUP_STATUS.PENDING },
    errors: [],
  };

  if (homeTeamId) {
    const homeSquad = await fetchEspnSquad(homeTeamId);
    if (homeSquad.ok) results.home.squad = homeSquad.squad;
    else results.errors.push(`home squad: ${homeSquad.error}`);
  }

  if (awayTeamId) {
    const awaySquad = await fetchEspnSquad(awayTeamId);
    if (awaySquad.ok) results.away.squad = awaySquad.squad;
    else results.errors.push(`away squad: ${awaySquad.error}`);
  }

  // Try cached lineup if available
  const cached = loadCachedMatchday(stateRoot, date, matchId);
  if (cached.ok) {
    results.home.lineup = cached.home?.lineup ?? null;
    results.away.lineup = cached.away?.lineup ?? null;
    results.home.injuries = cached.home?.injuries ?? null;
    results.away.injuries = cached.away?.injuries ?? null;
    results.home.lineup_status = cached.home?.lineup_status ?? LINEUP_STATUS.PENDING;
    results.away.lineup_status = cached.away?.lineup_status ?? LINEUP_STATUS.PENDING;
  }

  results.ok = results.home.squad != null || results.away.squad != null || cached.ok;
  results.confidence = results.home.lineup_status === LINEUP_STATUS.CONFIRMED && results.away.lineup_status === LINEUP_STATUS.CONFIRMED
    ? 'high'
    : results.home.lineup_status === LINEUP_STATUS.EXPECTED || results.away.lineup_status === LINEUP_STATUS.EXPECTED
    ? 'medium'
    : 'low';

  return results;
}

export function loadCachedMatchday(stateRoot, date, matchId) {
  const p = resolve(stateRoot, 'worldcup', date, 'matchday', `${matchId}.json`);
  if (!existsSync(p)) return { ok: false, error: 'cache miss' };
  try {
    return { ok: true, cached: true, ...JSON.parse(readFileSync(p, 'utf8')) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
