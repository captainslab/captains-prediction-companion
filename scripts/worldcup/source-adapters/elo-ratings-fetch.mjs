// Published national-team Elo fetcher — World Football Elo Ratings (eloratings.net).
//
// eloratings.net renders in the browser, but it serves the underlying data as
// server-side TSV with no JavaScript required:
//   - https://www.eloratings.net/World.tsv     current ranking (col2=rank, col3=code, col4=rating)
//   - https://www.eloratings.net/en.teams.tsv   code -> English team name
//
// This adapter fetches + parses those into a published-Elo snapshot. It NEVER
// authors or estimates a rating — every record is a real published value with
// source + retrieved_at. No price/odds/market data is touched here.

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export const ELO_WORLD_TSV = 'https://www.eloratings.net/World.tsv';
export const ELO_TEAMS_TSV = 'https://www.eloratings.net/en.teams.tsv';
export const ELO_SOURCE_ID = 'eloratings.net (World Football Elo Ratings)';

function parseTeamNames(text) {
  const map = {};
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    const [code, name] = line.split('\t');
    if (code && name) map[code.trim()] = name.trim();
  }
  return map;
}

export function parseWorldTsv(worldText, nameByCode) {
  const records = [];
  for (const line of String(worldText).split('\n')) {
    if (!line.trim()) continue;
    const f = line.split('\t');
    const code = (f[2] ?? '').trim();
    const rating = Number(f[3]);
    const rank = Number(f[1]);
    if (!code || !Number.isFinite(rating)) continue;
    const name = nameByCode[code];
    if (!name) continue;
    records.push({
      team_name: name,
      team_code: code,
      elo_rating: rating,
      rank: Number.isFinite(rank) ? rank : null,
      source: ELO_SOURCE_ID,
      source_url: ELO_WORLD_TSV,
    });
  }
  return records;
}

export async function fetchEloRatingsSnapshot({ retrievedAt = null, fetchImpl = fetch } = {}) {
  let worldRes;
  let teamsRes;
  try {
    [worldRes, teamsRes] = await Promise.all([fetchImpl(ELO_WORLD_TSV), fetchImpl(ELO_TEAMS_TSV)]);
  } catch (error) {
    return { ok: false, error: `fetch failed: ${error.message}` };
  }
  if (!worldRes.ok) return { ok: false, error: `World.tsv HTTP ${worldRes.status}` };
  if (!teamsRes.ok) return { ok: false, error: `en.teams.tsv HTTP ${teamsRes.status}` };
  const nameByCode = parseTeamNames(await teamsRes.text());
  const records = parseWorldTsv(await worldRes.text(), nameByCode).map((r) => ({ ...r, retrieved_at: retrievedAt }));
  if (!records.length) return { ok: false, error: 'no Elo records parsed' };
  return { ok: true, source_id: ELO_SOURCE_ID, source_url: ELO_WORLD_TSV, retrieved_at: retrievedAt, records };
}

export function buildEloBaseline(snapshot, { date = null, round = null } = {}) {
  return {
    // Published Elo is a per-team reference ratings table, not a per-match
    // source: its records are keyed by team, and fixtures join to it by team
    // name downstream. Mark it as a reference source so the send-time
    // source-health janitor does not demand a per-match join key
    // (FETCH_JOIN_KEY_MISSING) and hard-block delivery of otherwise-clean packets.
    source_type: 'reference',
    source_id: snapshot.source_id,
    source_url: snapshot.source_url,
    retrieved_at: snapshot.retrieved_at,
    round,
    date,
    records: snapshot.records,
  };
}

export async function writeEloBaseline(stateRoot, date, { retrievedAt = null, round = null } = {}) {
  const snap = await fetchEloRatingsSnapshot({ retrievedAt });
  if (!snap.ok) return snap;
  const baseline = buildEloBaseline(snap, { date, round });
  const path = resolve(stateRoot, 'worldcup', date, 'discovery', 'elo_baseline.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(baseline, null, 2));
  return { ok: true, path, count: snap.records.length };
}

// CLI: node scripts/worldcup/source-adapters/elo-ratings-fetch.mjs --date YYYY-MM-DD [--state-root state]
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const opts = { date: null, stateRoot: 'state' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--date') opts.date = argv[++i];
    else if (argv[i] === '--state-root') opts.stateRoot = argv[++i];
  }
  if (!opts.date) { console.error('usage: --date YYYY-MM-DD [--state-root state]'); process.exit(2); }
  const retrievedAt = new Date().toISOString();
  const result = await writeEloBaseline(opts.stateRoot, opts.date, { retrievedAt });
  if (!result.ok) { console.error('[elo] FAILED:', result.error); process.exit(1); }
  console.log(`[elo] wrote ${result.count} published Elo records -> ${result.path}`);
}
