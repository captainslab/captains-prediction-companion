// World Cup opponent-adjusted matchup adapter.
// Normalizes head-to-head and style-fit data into a stable JSON schema.
//
// This is the critical opponent-adjustment layer. It must score Team A relative
// to Team B (and vice versa), not in isolation.
//
// Sources:
//   1. FIFA match history API (if accessible)
//   2. openfootball historical results
//   3. Local cached copy in state/worldcup/matchup/
//
// Hard rules:
//   - No credentials.
//   - Fail soft with MISSING.
//   - Never fabricate H2H records or style ratings.
//   - All fields are opponent-relative (e.g. team_attack_vs_opponent_defense).

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

function nowIso() { return new Date().toISOString(); }

export function buildOpponentMatchup({ homeTeam, awayTeam, teamBaselines = {}, historicalH2H = [] }) {
  if (!homeTeam || !awayTeam) {
    return {
      ok: false,
      source_id: 'computed',
      fetched_at: nowIso(),
      confidence: 'none',
      error: 'homeTeam and awayTeam are required',
    };
  }

  const homeBase = teamBaselines[homeTeam] || {};
  const awayBase = teamBaselines[awayTeam] || {};

  // Opponent-adjusted scoring: each team's strength is measured against the opponent's weakness.
  const h2h = historicalH2H.filter(m =>
    (m.home === homeTeam && m.away === awayTeam) ||
    (m.home === awayTeam && m.away === homeTeam)
  );

  const h2hHomeWins = h2h.filter(m =>
    (m.home === homeTeam && m.home_goals > m.away_goals) ||
    (m.away === homeTeam && m.away_goals > m.home_goals)
  ).length;

  const h2hTotal = h2h.length;

  return {
    ok: true,
    source_id: 'computed',
    fetched_at: nowIso(),
    confidence: h2hTotal >= 3 ? 'medium' : 'low',
    match_id: `${homeTeam}-${awayTeam}`,
    home_team: homeTeam,
    away_team: awayTeam,
    home: {
      attack_vs_opponent_defense: {
        present: homeBase.attack_rating != null && awayBase.defense_rating != null,
        score: homeBase.attack_rating != null && awayBase.defense_rating != null
          ? Math.round((homeBase.attack_rating - awayBase.defense_rating + 100) / 2)
          : null,
        basis: `${homeTeam} attack_rating vs ${awayTeam} defense_rating`,
      },
      defense_vs_opponent_attack: {
        present: homeBase.defense_rating != null && awayBase.attack_rating != null,
        score: homeBase.defense_rating != null && awayBase.attack_rating != null
          ? Math.round((homeBase.defense_rating - awayBase.attack_rating + 100) / 2)
          : null,
        basis: `${homeTeam} defense_rating vs ${awayTeam} attack_rating`,
      },
      style_fit: {
        present: homeBase.style != null && awayBase.style != null,
        score: homeBase.style != null && awayBase.style != null
          ? Math.round((homeBase.style - awayBase.style + 100) / 2)
          : null,
        basis: `${homeTeam} style vs ${awayTeam} style`,
      },
      set_piece_vs_opponent: {
        present: homeBase.set_piece_rating != null && awayBase.set_piece_defense != null,
        score: homeBase.set_piece_rating != null && awayBase.set_piece_defense != null
          ? Math.round((homeBase.set_piece_rating - awayBase.set_piece_defense + 100) / 2)
          : null,
        basis: `${homeTeam} set_piece_rating vs ${awayTeam} set_piece_defense`,
      },
      goalkeeper_vs_opponent_chance_quality: {
        present: homeBase.goalkeeper_rating != null && awayBase.chance_quality != null,
        score: homeBase.goalkeeper_rating != null && awayBase.chance_quality != null
          ? Math.round((homeBase.goalkeeper_rating - awayBase.chance_quality + 100) / 2)
          : null,
        basis: `${homeTeam} goalkeeper_rating vs ${awayTeam} chance_quality`,
      },
      h2h_advantage: {
        present: h2hTotal > 0,
        score: h2hTotal > 0
          ? Math.round((h2hHomeWins / h2hTotal) * 100)
          : null,
        basis: `H2H record: ${h2hHomeWins}/${h2hTotal} wins for ${homeTeam}`,
      },
    },
    away: {
      attack_vs_opponent_defense: {
        present: awayBase.attack_rating != null && homeBase.defense_rating != null,
        score: awayBase.attack_rating != null && homeBase.defense_rating != null
          ? Math.round((awayBase.attack_rating - homeBase.defense_rating + 100) / 2)
          : null,
        basis: `${awayTeam} attack_rating vs ${homeTeam} defense_rating`,
      },
      defense_vs_opponent_attack: {
        present: awayBase.defense_rating != null && homeBase.attack_rating != null,
        score: awayBase.defense_rating != null && homeBase.attack_rating != null
          ? Math.round((awayBase.defense_rating - homeBase.attack_rating + 100) / 2)
          : null,
        basis: `${awayTeam} defense_rating vs ${homeTeam} attack_rating`,
      },
      style_fit: {
        present: awayBase.style != null && homeBase.style != null,
        score: awayBase.style != null && homeBase.style != null
          ? Math.round((awayBase.style - homeBase.style + 100) / 2)
          : null,
        basis: `${awayTeam} style vs ${homeTeam} style`,
      },
      set_piece_vs_opponent: {
        present: awayBase.set_piece_rating != null && homeBase.set_piece_defense != null,
        score: awayBase.set_piece_rating != null && homeBase.set_piece_defense != null
          ? Math.round((awayBase.set_piece_rating - homeBase.set_piece_defense + 100) / 2)
          : null,
        basis: `${awayTeam} set_piece_rating vs ${homeTeam} set_piece_defense`,
      },
      goalkeeper_vs_opponent_chance_quality: {
        present: awayBase.goalkeeper_rating != null && homeBase.chance_quality != null,
        score: awayBase.goalkeeper_rating != null && homeBase.chance_quality != null
          ? Math.round((awayBase.goalkeeper_rating - homeBase.chance_quality + 100) / 2)
          : null,
        basis: `${awayTeam} goalkeeper_rating vs ${homeTeam} chance_quality`,
      },
      h2h_advantage: {
        present: h2hTotal > 0,
        score: h2hTotal > 0
          ? Math.round(((h2hTotal - h2hHomeWins) / h2hTotal) * 100)
          : null,
        basis: `H2H record: ${h2hTotal - h2hHomeWins}/${h2hTotal} wins for ${awayTeam}`,
      },
    },
    h2h_total_matches: h2hTotal,
    h2h_recent: h2h.slice(-5),
  };
}

export function loadCachedMatchup(stateRoot, date, matchId) {
  const p = resolve(stateRoot, 'worldcup', date, 'matchup', `${matchId}.json`);
  if (!existsSync(p)) return { ok: false, error: 'cache miss' };
  try {
    return { ok: true, cached: true, ...JSON.parse(readFileSync(p, 'utf8')) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
