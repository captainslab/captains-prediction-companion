// Prior-composite baseline fallback.
//
// Team composites (normalized Elo / attack / defense, 0-100) are computed per
// discovery run and cached at state/worldcup/<date>/discovery/team_baseline.json.
// When the target date has no baseline (and a live fetch is unavailable), the
// pre-lock board should still carry a model read using each team's LAST
// AVAILABLE composite — the most recent prior baseline — clearly labeled as
// provisional. This never fabricates ratings; it reuses real prior composites.

import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Returns { sourceDate, path, baseline } for the most recent team_baseline.json
// strictly before `date`, or null if none exists. ISO YYYY-MM-DD strings sort
// lexicographically, so string comparison is correct here.
export function findLatestPriorBaseline(stateRoot, date) {
  const wcRoot = resolve(stateRoot, 'worldcup');
  let dirs;
  try {
    dirs = readdirSync(wcRoot);
  } catch {
    return null;
  }
  const candidates = dirs
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < date)
    .sort()
    .reverse();
  for (const d of candidates) {
    const path = resolve(wcRoot, d, 'discovery', 'team_baseline.json');
    if (!existsSync(path)) continue;
    try {
      const baseline = JSON.parse(readFileSync(path, 'utf8'));
      if (baseline && Array.isArray(baseline.teams) && baseline.teams.length > 0) {
        return { sourceDate: d, path, baseline };
      }
    } catch {
      // corrupt cache — keep looking further back
    }
  }
  return null;
}
