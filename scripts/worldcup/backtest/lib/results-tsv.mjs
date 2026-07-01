// Pure parser for eloratings.net <year>_results.tsv rows. No network.
function pad2(n) { return String(n).padStart(2, '0'); }

export function parseResultsRow(line) {
  if (!line || !line.trim()) return null;
  const f = line.split('\t');
  if (f.length < 12) return null;
  const year = Number(f[0]); const month = Number(f[1]); const day = Number(f[2]);
  const homeGoals = Number(f[5]); const awayGoals = Number(f[6]);
  const eloChange = Number(f[9]);
  const homeEloPost = Number(f[10]); const awayEloPost = Number(f[11]);
  if (![year, month, day, homeGoals, awayGoals, eloChange, homeEloPost, awayEloPost].every(Number.isFinite)) return null;
  if (!f[3] || !f[4]) return null;
  return {
    date: `${year}-${pad2(month)}-${pad2(day)}`,
    homeCode: f[3], awayCode: f[4],
    homeGoals, awayGoals,
    typeCode: f[7] || null, venueCode: f[8] || null,
    eloChange, homeEloPost, awayEloPost,
    // PRE-match ratings (post -/+ change): the prediction basis, no look-ahead.
    homeElo: homeEloPost - eloChange,
    awayElo: awayEloPost + eloChange,
  };
}

export function parseResultsTsv(text) {
  return String(text).split('\n').map(parseResultsRow).filter(Boolean);
}
