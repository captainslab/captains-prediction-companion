// World Cup official-lineup fetcher.
//
// Purpose: materialize the matchday lineup cache that the packet generator
// reads via loadCachedMatchday(). Pulls OFFICIAL announced starting XIs from
// the ESPN fifa.world summary endpoint and writes a price-free, no-fabrication
// artifact to state/worldcup/<date>/matchday/<match_id>.json.
//
// Hard rules:
//   - No credentials, no odds/price fields ever copied through.
//   - lineup_status is set to lineup_confirmed ONLY when BOTH teams expose a
//     full announced XI (>= 11 flagged starters). Otherwise the match is
//     skipped and stays pre-lineup. Lineups are never invented.
//   - Structure match_id is mapped to the ESPN event id by team-name set
//     (date-scoped scoreboard), since the static structure carries no espn id.
//
// Usage:
//   node scripts/worldcup/source-adapters/fetch-official-lineups.mjs --date YYYY-MM-DD [--state-root state] [--dry-run]

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world';

function parseArgs(argv) {
  const opts = { date: new Date().toISOString().slice(0, 10), stateRoot: 'state', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') opts.date = argv[++i];
    else if (a === '--state-root') opts.stateRoot = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
  }
  return opts;
}

// Token set, lowercased, with the noise token "dr" dropped so "Congo DR" and
// "DR Congo" reconcile. Returns a stable sorted key.
function teamKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && t !== 'dr')
    .sort()
    .join('-');
}

function matchKey(home, away) {
  return [teamKey(home), teamKey(away)].sort().join('|');
}

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// Extract a price-free confirmed XI for one ESPN roster entry, or null.
function extractXI(rosterEntry) {
  const starters = (rosterEntry?.roster || []).filter((p) => p.starter);
  if (starters.length < 11) return null;
  return {
    formation: rosterEntry.formation ?? null,
    starting_xi: starters.map((p) => ({
      name: p.athlete?.displayName ?? p.athlete?.fullName ?? null,
      position: p.position?.abbreviation ?? p.position?.name ?? null,
      number: p.jersey ?? p.athlete?.jersey ?? null,
    })),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { date, stateRoot, dryRun } = opts;

  const structurePath = resolve(stateRoot, 'worldcup', date, 'discovery', 'static_structure.json');
  if (!existsSync(structurePath)) {
    console.error(`[lineups] no structure at ${structurePath}`);
    process.exit(1);
  }
  const structure = JSON.parse(readFileSync(structurePath, 'utf8'));
  const matches = (structure.matches || []).filter((m) => (m.kickoff_utc || '').slice(0, 10) === date
    || (m.kickoff_local || '').slice(0, 10) === date);

  // Build structure lookup by team-name set.
  const byKey = new Map();
  for (const m of structure.matches || []) byKey.set(matchKey(m.home_team, m.away_team), m);

  const yyyymmdd = date.replace(/-/g, '');
  const scoreboard = await getJson(`${ESPN_BASE}/scoreboard?dates=${yyyymmdd}`);
  const events = scoreboard.events || [];
  console.log(`[lineups] ${date}: ${events.length} ESPN events, ${matches.length} structure matches today`);

  const matchdayDir = resolve(stateRoot, 'worldcup', date, 'matchday');
  if (!dryRun) mkdirSync(matchdayDir, { recursive: true });

  const written = [];
  const skipped = [];
  for (const ev of events) {
    const comp = (ev.competitions || [])[0] || {};
    const competitors = comp.competitors || [];
    const homeC = competitors.find((c) => c.homeAway === 'home') || competitors[0];
    const awayC = competitors.find((c) => c.homeAway === 'away') || competitors[1];
    const espnHome = homeC?.team?.displayName ?? homeC?.team?.name;
    const espnAway = awayC?.team?.displayName ?? awayC?.team?.name;
    const struct = byKey.get(matchKey(espnHome, espnAway));
    if (!struct) { skipped.push(`${espnHome} vs ${espnAway} (no structure map)`); continue; }

    let summary;
    try {
      summary = await getJson(`${ESPN_BASE}/summary?event=${ev.id}`);
    } catch (e) {
      skipped.push(`${struct.home_team} vs ${struct.away_team} (summary fetch: ${e.message})`);
      continue;
    }
    const rosters = summary.rosters || [];
    // Map ESPN rosters to home/away by team id.
    const homeRoster = rosters.find((r) => r.homeAway === 'home')
      || rosters.find((r) => r.team?.id === homeC?.team?.id) || rosters[0];
    const awayRoster = rosters.find((r) => r.homeAway === 'away')
      || rosters.find((r) => r.team?.id === awayC?.team?.id) || rosters[1];
    const homeXI = extractXI(homeRoster);
    const awayXI = extractXI(awayRoster);

    if (!homeXI || !awayXI) {
      skipped.push(`${struct.home_team} vs ${struct.away_team} (XI not yet announced)`);
      continue;
    }

    const artifact = {
      schema: 'worldcup_matchday_lineup_v1',
      match_id: struct.match_id,
      fetched_utc: new Date().toISOString(),
      source: {
        provider: 'espn',
        league: 'fifa.world',
        event_id: String(ev.id),
        url: `${ESPN_BASE}/summary?event=${ev.id}`,
        event_state: comp.status?.type?.state ?? null,
        event_detail: comp.status?.type?.detail ?? null,
      },
      home: {
        team: struct.home_team,
        lineup_status: 'lineup_confirmed',
        lineup: { team_name: struct.home_team, ...homeXI },
      },
      away: {
        team: struct.away_team,
        lineup_status: 'lineup_confirmed',
        lineup: { team_name: struct.away_team, ...awayXI },
      },
    };

    const outPath = resolve(matchdayDir, `${struct.match_id}.json`);
    if (!dryRun) writeFileSync(outPath, JSON.stringify(artifact, null, 2), 'utf8');
    written.push(`${struct.home_team} (${homeXI.formation}) vs ${struct.away_team} (${awayXI.formation}) → ${outPath}`);
  }

  console.log(`[lineups] confirmed XIs written: ${written.length}`);
  for (const w of written) console.log(`  + ${w}`);
  console.log(`[lineups] skipped (pre-lineup / unmapped): ${skipped.length}`);
  for (const s of skipped) console.log(`  - ${s}`);
  if (dryRun) console.log('[lineups] DRY RUN — no files written');
}

main().catch((e) => { console.error(e); process.exit(1); });
