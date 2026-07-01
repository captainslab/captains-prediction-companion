// Deterministic train/test split by a stable hash of the record identity.
// No Math.random — same input always yields the same partition.
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 0xffffffff;
}

export function splitTrainTest(records, { testFraction = 0.3 } = {}) {
  const train = []; const test = [];
  for (const r of records) {
    (hashStr(`${r.date}|${r.homeElo}|${r.awayElo}`) < testFraction ? test : train).push(r);
  }
  return { train, test };
}
