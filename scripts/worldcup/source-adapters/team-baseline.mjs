// World Cup team baseline adapter.
// Normalizes team quality, form, and squad data into a stable JSON schema.
//
// Sources (no-key/public):
//   1. FIFA Men's World Ranking (scraped from fifa.com/fifaworldcup/ranking)
//   2. Elo ratings from clubelo.com (if accessible)
//   3. Transfermarkt squad values (read-only, no API key)
//   4. Local cached copy in state/worldcup/team-baseline/
//
// Hard rules:
//   - No credentials.
//   - Fail soft with MISSING.
//   - Never fabricate rankings, form, or squad values.
//   - Include source_url, fetched_at, confidence.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_FIFA_RANKING_URL = 'https://www.fifa.com/fifaworldcup/ranking';
const DEFAULT_ELO_URL = 'http://clubelo.com/';

function nowIso() { return new Date().toISOString(); }

function normalizeFifaRankingRow(row) {
  if (!row || !row.team) return null;
  return {
    team_name: row.team,
    team_code: row.code ?? null,
    fifa_rank: row.rank ?? null,
    fifa_points: row.points ?? null,
    confederation: row.confederation ?? null,
    source_quality: row.rank ? 'high' : 'low',
  };
}

function normalizeEloRow(row) {
  if (!row || !row.country) return null;
  return {
    team_name: row.country,
    team_code: row.code ?? null,
    elo_rating: row.rating ?? null,
    elo_rank: row.rank ?? null,
    source_quality: row.rating ? 'high' : 'low',
  };
}

export async function fetchFifaRanking(url = DEFAULT_FIFA_RANKING_URL) {
  try {
    const res = await fetch(url, { headers: { Accept: 'text/html' } });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const html = await res.text();
    // FIFA ranking page has JSON in a script tag or data attribute; try to extract.
    const jsonMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{.*?\});/s);
    if (!jsonMatch) {
      return { ok: false, error: 'no JSON payload in FIFA ranking page' };
    }
    const data = JSON.parse(jsonMatch[1]);
    const rows = (data?.ranking || data?.teams || [])
      .map(normalizeFifaRankingRow)
      .filter(Boolean);
    return {
      ok: true,
      source_id: 'fifa_ranking',
      source_url: url,
      fetched_at: nowIso(),
      confidence: 'medium',
      teams: rows,
      team_count: rows.length,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function fetchEloRatings(url = DEFAULT_ELO_URL) {
  try {
    const res = await fetch(url, { headers: { Accept: 'text/html' } });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const html = await res.text();
    // ClubElo has a CSV or JSON endpoint; try /api/ or /ranking/.
    // Fallback: mark as unavailable.
    return {
      ok: false,
      source_id: 'clubelo',
      source_url: url,
      fetched_at: nowIso(),
      confidence: 'none',
      error: 'ClubElo scraping not yet implemented; use cached data or manual seed.',
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function loadCachedTeamBaseline(stateRoot, date) {
  const p = resolve(stateRoot, 'worldcup', date, 'discovery', 'team_baseline.json');
  if (!existsSync(p)) return { ok: false, error: 'cache miss' };
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'));
    return { ok: true, cached: true, ...data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Fetch team baseline data with fallback chain.
 */
export async function fetchTeamBaseline({ stateRoot, date } = {}) {
  const fifa = await fetchFifaRanking();
  if (fifa.ok && fifa.team_count > 0) return fifa;

  const elo = await fetchEloRatings();
  if (elo.ok && elo.team_count > 0) return elo;

  const cached = loadCachedTeamBaseline(stateRoot, date);
  if (cached.ok) return cached;

  return {
    ok: false,
    source_id: 'none',
    fetched_at: nowIso(),
    confidence: 'none',
    teams: [],
    team_count: 0,
    errors: [fifa.error, elo.error, cached.error].filter(Boolean),
  };
}
