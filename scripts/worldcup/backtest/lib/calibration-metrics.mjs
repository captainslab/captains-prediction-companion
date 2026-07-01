// Pure calibration metrics. No I/O.
const EPS = 1e-12;

export function brierMulticlass(probs, outcome) {
  const y = { pHome: outcome === 'home' ? 1 : 0, pDraw: outcome === 'draw' ? 1 : 0, pAway: outcome === 'away' ? 1 : 0 };
  return (probs.pHome - y.pHome) ** 2 + (probs.pDraw - y.pDraw) ** 2 + (probs.pAway - y.pAway) ** 2;
}

export function logLoss(probs, outcome) {
  const p = outcome === 'home' ? probs.pHome : outcome === 'draw' ? probs.pDraw : probs.pAway;
  return -Math.log(Math.min(1 - EPS, Math.max(EPS, p)));
}

export function reliabilityBins(points, bins = 10) {
  const acc = Array.from({ length: bins }, (_, i) => ({ bin: i, sumP: 0, sumHit: 0, n: 0 }));
  for (const { p, hit } of points) {
    const idx = Math.min(bins - 1, Math.max(0, Math.floor(p * bins)));
    acc[idx].sumP += p; acc[idx].sumHit += hit; acc[idx].n += 1;
  }
  return acc.map((b) => ({ bin: b.bin, predicted: b.n ? b.sumP / b.n : null, observed: b.n ? b.sumHit / b.n : null, n: b.n }));
}

export function eloGapBucket(gap) {
  const g = Math.abs(gap);
  if (g >= 400) return '400+';
  const lo = Math.floor(g / 50) * 50;
  return `${lo}-${lo + 50}`;
}
