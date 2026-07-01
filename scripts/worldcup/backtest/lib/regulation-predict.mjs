// Regulation W/D/L prediction over the REAL advances model (no logic fork).
// Home advantage is applied inside eloToLambdas via config.homeAdvantageElo;
// on a neutral site that term is forced to 0.
import { eloToLambdas, poissonMatrix, regulationWDL, DEFAULT_ADVANCES_CONFIG } from '../../lib/advances-model.mjs';

export function predictRegulation({ homeElo, awayElo, neutral = false, config = DEFAULT_ADVANCES_CONFIG }) {
  const effectiveConfig = neutral ? { ...config, homeAdvantageElo: 0 } : config;
  const lam = eloToLambdas(homeElo, awayElo, { config: effectiveConfig });
  const matrix = poissonMatrix(lam.lambdaTeam, lam.lambdaOpp);
  const wdl = regulationWDL(matrix.matrix, true);
  // regulationWDL rounds each class to 3 dp; re-normalize so the triple sums to
  // exactly 1 (calibration metrics assume a proper distribution).
  const total = wdl.pWin + wdl.pDraw + wdl.pLoss || 1;
  return { pHome: wdl.pWin / total, pDraw: wdl.pDraw / total, pAway: wdl.pLoss / total };
}
