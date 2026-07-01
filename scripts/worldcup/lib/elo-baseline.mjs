// Cached Elo baseline loader for World Cup advances markets.
//
// Reads a published Elo snapshot from state/worldcup/<date>/discovery/
// elo_baseline.json. No live scraping or network fetches happen here.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function normalizeText(value) {
  const text = String(value ?? '').trim();
  return text.length ? text : null;
}

// Canonical team key: fold diacritics, lowercase, strip non-alphanumerics, then
// collapse known FIFA<->eloratings name variants so e.g. "Côte d'Ivoire" matches
// eloratings' "Ivory Coast". Extend TEAM_ALIASES as new variants surface.
const TEAM_ALIASES = {
  cotedivoire: 'ivorycoast',
  korearepublic: 'koreasouth',
  republicofkorea: 'koreasouth',
  southkorea: 'koreasouth',
  northkorea: 'koreanorth',
  iriran: 'iran',
  unitedstates: 'usa',
  unitedstatesofamerica: 'usa',
  czechrepublic: 'czechia',
  turkiye: 'turkey',
  capeverde: 'caboverde',
  bosniaandherzegovina: 'bosnia',
};
export function teamKey(name) {
  const folded = String(name ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!folded) return null;
  return TEAM_ALIASES[folded] ?? folded;
}

function normalizeNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeRecord(record = {}) {
  const teamName = normalizeText(record.team_name ?? record.team ?? record.name);
  if (!teamName) return null;
  return {
    team_name: teamName,
    team_code: normalizeText(record.team_code ?? record.code ?? record.abbreviation),
    elo_rating: normalizeNumber(record.elo_rating ?? record.elo ?? record.value),
    source: normalizeText(record.source ?? record.source_title ?? record.source_id),
    retrieved_at: normalizeText(record.retrieved_at ?? record.fetched_at ?? record.observed_at),
    published_at: normalizeText(record.published_at ?? null),
    rank: normalizeNumber(record.rank ?? record.elo_rank),
    notes: record.notes ?? null,
  };
}

export function loadCachedEloBaseline(stateRoot, date) {
  const path = resolve(stateRoot, 'worldcup', date, 'discovery', 'elo_baseline.json');
  if (!existsSync(path)) {
    return { ok: false, error: 'cache miss', path };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const records = Array.isArray(parsed.records)
      ? parsed.records
      : Array.isArray(parsed.teams)
        ? parsed.teams
        : [];
    const teams = records.map(normalizeRecord).filter(Boolean);
    if (!teams.length) {
      return { ok: false, error: 'empty elo baseline cache', path };
    }
    return {
      ok: true,
      cached: true,
      path,
      source_id: parsed.source_id ?? parsed.source ?? 'elo_baseline',
      retrieved_at: parsed.retrieved_at ?? parsed.generated_at ?? null,
      round: parsed.round ?? parsed.stage ?? null,
      date: parsed.date ?? date ?? null,
      teams,
      records: teams,
    };
  } catch (error) {
    return { ok: false, error: error.message, path };
  }
}

export function findCachedEloRecord(baseline, teamName) {
  const needle = teamKey(teamName);
  if (!needle) return null;
  const records = Array.isArray(baseline?.records) ? baseline.records : Array.isArray(baseline?.teams) ? baseline.teams : [];
  return records.find((record) => teamKey(record?.team_name) === needle || teamKey(record?.team_code) === needle) ?? null;
}

