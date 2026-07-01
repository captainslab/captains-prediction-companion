// Regulation calibration + out-of-sample constant tuning.
// Tunes on TRAIN (min log-loss), reports Brier/log-loss/reliability on the
// held-out TEST split. Baseline (default config) is reported alongside so any
// improvement — and overfit risk — is explicit.
import { predictRegulation } from './regulation-predict.mjs';
import { brierMulticlass, logLoss, reliabilityBins } from './calibration-metrics.mjs';
import { splitTrainTest } from './split.mjs';
import { DEFAULT_ADVANCES_CONFIG } from '../../lib/advances-model.mjs';

export function evaluateConfig(records, config) {
  let brier = 0; let ll = 0; const pts = [];
  for (const r of records) {
    const p = predictRegulation({ homeElo: r.homeElo, awayElo: r.awayElo, neutral: r.neutral, config });
    brier += brierMulticlass(p, r.outcome);
    ll += logLoss(p, r.outcome);
    pts.push({ p: p.pHome, hit: r.outcome === 'home' ? 1 : 0 });
  }
  const n = records.length || 1;
  return { brier: brier / n, logLoss: ll / n, n: records.length, reliability: reliabilityBins(pts) };
}

// baselineConfig is the reference the tuned winner is judged against on the
// held-out test split. It defaults to DEFAULT_ADVANCES_CONFIG for back-compat,
// but the recalibration CLI passes an explicit pinned legacy config so the
// comparison stays honest even after the production default is bumped.
export function tuneRegulation(records, grid = [DEFAULT_ADVANCES_CONFIG], baselineConfig = DEFAULT_ADVANCES_CONFIG) {
  const { train, test } = splitTrainTest(records);
  let best = null;
  for (const config of grid) {
    const m = evaluateConfig(train, config);
    if (!best || m.logLoss < best.trainLogLoss) best = { config, trainLogLoss: m.logLoss };
  }
  return {
    baseline: evaluateConfig(test, baselineConfig),
    best,
    test: evaluateConfig(test, best.config),
  };
}
