// Composite p_advance spot-check on identifiable knockout ties. Calls the REAL
// computeAdvance and scores Brier of p_advance (home perspective) vs the actual
// advancer. A sanity check only — knockout ties with a known advancer are scarce.
import { computeAdvance, DEFAULT_ADVANCES_CONFIG } from '../../lib/advances-model.mjs';

export function spotCheckAdvance(ties, config = DEFAULT_ADVANCES_CONFIG) {
  let brier = 0;
  for (const t of ties) {
    const adv = computeAdvance({
      eloTeam: t.homeElo, eloOpp: t.awayElo,
      bracket: { team_is_home: !t.neutral, stage: 'knockout', match_id: null },
      lineup: { confirmed: false }, config,
    });
    const p = adv.status === 'READY' ? adv.p_advance : 0.5;
    const y = t.advanced === 'home' ? 1 : 0;
    brier += (p - y) ** 2;
  }
  return { n: ties.length, brier: ties.length ? brier / ties.length : null };
}
