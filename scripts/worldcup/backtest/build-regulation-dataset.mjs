// Build a regulation calibration dataset from eloratings results TSV text.
// Each record carries PRE-match Elo (from the parser), neutral flag, and the
// observed regulation W/D/L outcome. No network, no price data.
import { parseResultsTsv } from './lib/results-tsv.mjs';
import { isNeutral } from './lib/neutral.mjs';

export function buildRegulationDataset(tsvTexts) {
  const records = [];
  for (const text of tsvTexts) {
    for (const row of parseResultsTsv(text)) {
      const outcome = row.homeGoals > row.awayGoals ? 'home' : row.homeGoals < row.awayGoals ? 'away' : 'draw';
      records.push({ date: row.date, homeElo: row.homeElo, awayElo: row.awayElo, neutral: isNeutral(row), outcome });
    }
  }
  return { records };
}
