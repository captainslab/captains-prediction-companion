// Per-game section renderer for pre-lock window reports.
// Shows game metadata only — no market prices, no pricing model.
// Real picks come exclusively from the composite evidence model
// (evidence-ledger.mjs / late-slate-composite-refresh.mjs).

const NO_PICK_ANALYSIS = {
  final: {
    decision_status: 'NO CLEAR PICK',
    decision: 'NO CLEAR PICK',
    reason: 'Composite model data not yet available for this game.',
    best_angle: 'none',
    decision_process: {},
  },
  sections: {
    ml:      { decision: 'NO CLEAR PICK', reason: '' },
    spread:  { decision: 'NO CLEAR PICK', reason: '' },
    total:   { decision: 'NO CLEAR PICK', reason: '' },
    ceiling: {},
    hr:      { perPlayer: [] },
    ks_away: { perPitcher: [] },
    ks_home: { perPitcher: [] },
    yfri:    { decision: 'NO CLEAR PICK', reason: '' },
  },
};

export function renderGameSection(game) {
  const away = game.away ?? '?';
  const home = game.home ?? '?';
  const time = game.start_ct ?? game.start_utc ?? '?';
  const lines = [];

  lines.push(`${away} @ ${home}  |  ${time}`);

  const prob = game.probable_pitchers ?? game.probable_starters;
  if (prob) {
    const ap = prob.away ?? prob.away_pitcher ?? null;
    const hp = prob.home ?? prob.home_pitcher ?? null;
    if (ap || hp) lines.push(`Starters: ${ap ?? 'TBD'} vs ${hp ?? 'TBD'}`);
  }

  lines.push('Composite model: pending — no pick for this game.');

  return { text: lines.join('\n'), analysis: NO_PICK_ANALYSIS };
}
