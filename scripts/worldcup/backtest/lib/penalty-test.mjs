// Penalty-layer test: does the higher-Elo team win shootouts more than ~50%?
// Pure — takes normalized shootout rows, returns the observed higher-Elo win rate.
export function evaluatePenaltyPrior(shootouts) {
  const n = shootouts.length;
  const wins = shootouts.filter((s) => s.higherEloWon).length;
  return { n, higherEloWinRate: n ? wins / n : null };
}
