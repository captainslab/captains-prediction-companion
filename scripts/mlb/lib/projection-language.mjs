// MLB projection-first packet language.
//
// Turns the price-isolated projection contracts (projection-contracts.mjs) into
// human-readable lines that state what the MODEL projects — projected runs,
// win probability, first-inning-run (YRFI) probability, strikeout counts, and
// home-run risk — and NEVER an over/under market-line pick or a trade call.
//
// House rules preserved:
//   - "No trades placed. No bankroll sizing. Research only."
//   - Blocked families say so explicitly; they do not borrow a board line.
//   - No market price, odds, or board shape is rendered by these helpers.
//
// Pure ESM. No I/O.

import { distributionFloorMean } from './projection-contracts.mjs';

export const NO_TRADE_FOOTER = 'No trades placed. No bankroll sizing. Research only.';

function pct(p, digits = 0) {
  if (typeof p !== 'number' || !Number.isFinite(p)) return null;
  return `${(p * 100).toFixed(digits)}%`;
}

function statusTag(proj) {
  if (proj.status === 'provisional') {
    const reasons = [];
    if (proj.lineup_status && proj.lineup_status !== 'confirmed') reasons.push('lineup unconfirmed');
    if (proj.weather_status && proj.weather_status !== 'complete') reasons.push('weather incomplete');
    return ` [provisional${reasons.length ? ' — ' + reasons.join(', ') : ''}]`;
  }
  return '';
}

// Blocked line — explicit, never a fabricated or board-derived pick.
function blockedLine(label, proj) {
  const why = (proj.blocked_reasons || []).join(', ') || 'required inputs missing';
  return `${label} — BLOCKED_MODEL_LAYER_MISSING: ${why}. No projection issued.`;
}

// ---- Moneyline (derived win probability, not a market line) ----------------
export function describeMoneyline(proj, { home_team = 'Home', away_team = 'Away' } = {}) {
  if (proj.status === 'blocked') return blockedLine('Win probability', proj);
  const ph = proj.outputs?.moneyline_home;
  if (typeof ph !== 'number') return `Win probability — not modeled${statusTag(proj)}.`;
  const pa = 1 - ph;
  return `Projected win probability — ${home_team} ${pct(ph, 1)}, ${away_team} ${pct(pa, 1)} `
    + `(model score distribution, not a market line)${statusTag(proj)}.`;
}

// ---- Spread / run line (cover probability) ---------------------------------
export function describeRunline(proj, { home_team = 'Home' } = {}) {
  if (proj.status === 'blocked') return blockedLine('Market run-line', proj);
  const pc = proj.outputs?.runline_home_minus_1_5;
  if (typeof pc !== 'number') return `Market run-line cover probability — not modeled${statusTag(proj)}.`;
  return `Market run-line — ${home_team} -1.5 cover probability ${pct(pc, 1)} `
    + `(market context; derived from the same score model)${statusTag(proj)}.`;
}

// ---- Total runs (projected runs + rung probability, never "take the over") --
export function describeTotal(proj) {
  if (proj.status === 'blocked') return blockedLine('Total runs', proj);
  const dist = proj.outputs?.total_runs_distribution;
  const mean = distributionFloorMean(dist);
  const overKey = Object.keys(proj.outputs || {}).find((k) => k.startsWith('total_over_'));
  const parts = [];
  if (mean != null) parts.push(`projected ~${mean.toFixed(1)} total runs`);
  if (overKey) {
    const line = overKey.replace('total_over_', '').replace('_', '.');
    parts.push(`P(total > ${line}) ${pct(proj.outputs[overKey], 1)}`);
  }
  if (!parts.length) return `Total runs — not modeled${statusTag(proj)}.`;
  return `Projected total — ${parts.join('; ')} (run-environment projection, not an over/under call)${statusTag(proj)}.`;
}

// ---- Team runs (projected runs scored) -------------------------------------
export function describeTeamRuns(proj, side, teamName = side) {
  if (proj.status === 'blocked') return blockedLine(`Projected runs (${teamName})`, proj);
  const dist = proj.outputs?.team_runs_distribution?.[side];
  const mean = distributionFloorMean(dist);
  if (mean == null) return `Projected runs (${teamName}) — not modeled${statusTag(proj)}.`;
  return `Projected runs — ${teamName} ~${mean.toFixed(1)} (run-scoring distribution)${statusTag(proj)}.`;
}

// ---- CPC projected spread (model-side projected-run margin) -----------------
export function describeProjectedSpread(
  awayRuns,
  homeRuns,
  {
    away_team = 'Away',
    home_team = 'Home',
    status = 'official',
    blocked_reasons = [],
  } = {},
) {
  const proj = { status, blocked_reasons };
  if (status === 'blocked') return blockedLine('CPC projected spread', proj);
  if (!Number.isFinite(awayRuns) || !Number.isFinite(homeRuns)) {
    return `CPC projected spread — not modeled${statusTag(proj)}.`;
  }
  if (awayRuns === homeRuns) {
    return `CPC projected spread — pick'em / even line (${away_team} and ${home_team} both project ${awayRuns.toFixed(1)} runs)${statusTag(proj)}.`;
  }
  const favorite = awayRuns > homeRuns ? away_team : home_team;
  const margin = Math.abs(awayRuns - homeRuns).toFixed(1);
  return `CPC projected spread — ${favorite} -${margin} (model projected-run margin; no market signal used)${statusTag(proj)}.`;
}

// ---- YRFI (first-inning run probability) -----------------------------------
export function describeYrfi(proj) {
  if (proj.status === 'blocked') return blockedLine('First-inning run (YRFI)', proj);
  const p = proj.outputs?.yrfi_prob;
  if (typeof p !== 'number') return `First-inning run (YRFI) probability — not modeled${statusTag(proj)}.`;
  return `Projected first-inning run (YRFI) probability ${pct(p, 0)} `
    + `/ no-run (NRFI) ${pct(1 - p, 0)}${statusTag(proj)}.`;
}

// ---- Pitcher strikeouts (projected count) ----------------------------------
export function describeKs(proj, pitcherName = 'Starter') {
  if (proj.status === 'blocked') return blockedLine(`Strikeouts — ${pitcherName}`, proj);
  const dist = proj.outputs?.distribution;
  const mean = distributionFloorMean(dist);
  const derived = proj.outputs?.derived_probs || {};
  const parts = [];
  if (mean != null) parts.push(`projected ~${mean.toFixed(1)} K`);
  for (const [k, v] of Object.entries(derived)) {
    const line = k.replace('over_', '').replace('_', '.');
    parts.push(`P(≥ ${line} K) ${pct(v, 0)}`);
  }
  if (!parts.length) return `Strikeouts — ${pitcherName}: not modeled${statusTag(proj)}.`;
  return `Projected strikeouts — ${pitcherName}: ${parts.join(', ')} (count projection, not an over/under call)${statusTag(proj)}.`;
}

// ---- Batter home run (HR risk) ---------------------------------------------
export function describeHr(proj, batterName = 'Batter') {
  if (Array.isArray(proj?.outputs)) {
    const ready = proj.outputs.filter((row) => row?.status === 'ready' && row?.outputs);
    if (!ready.length) return blockedLine('Anytime-HR model', proj);
    const summaries = ready.slice(0, 5).map((row) => {
      const name = row.player?.player_name ?? (row.player?.mlb_id ? `MLB ${row.player.mlb_id}` : 'Batter');
      return `${name} ${pct(row.outputs.probability_at_least_one_hr, 1)} (per-PA ${pct(row.outputs.per_pa_probability, 2)}, expected PA ${Number(row.outputs.expected_pa).toFixed(2)})`;
    });
    const evidence = ready.every((row) => row.audit?.calibration_claim_supported)
      ? 'held-out calibration supported'
      : 'uncalibrated label retained';
    return `Projected anytime-HR risk — ${summaries.join('; ')} (${evidence}; market-free model).`;
  }
  if (proj.status === 'blocked') return blockedLine(`HR risk — ${batterName}`, proj);
  const p = proj.outputs?.p_at_least_one_hr ?? proj.outputs?.probability_at_least_one_hr;
  if (typeof p !== 'number') return `HR risk — ${batterName}: not modeled${statusTag(proj)}.`;
  return `Projected HR risk — ${batterName}: ${pct(p, 0)} to hit ≥ 1 home run (rare-event projection)${statusTag(proj)}.`;
}

// Convenience: assemble a projection-first block + the no-trade footer.
export function renderProjectionBlock(lines = []) {
  return [...lines.filter(Boolean), NO_TRADE_FOOTER].join('\n');
}
