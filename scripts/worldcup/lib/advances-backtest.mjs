// Lightweight backtest helper for the World Cup advances model.

import { computeAdvance } from './advances-model.mjs';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function bucketLabel(p) {
  const lower = Math.floor(clamp(p, 0, 0.999) * 10) / 10;
  const upper = Number((lower + 0.1).toFixed(1));
  return `${lower.toFixed(1)}-${upper.toFixed(1)}`;
}

function actualAdvanceValue(match = {}) {
  if (typeof match.actual_advance === 'number') return clamp(match.actual_advance, 0, 1);
  if (typeof match.advanced === 'boolean') return match.advanced ? 1 : 0;
  if (match.advanced_team === 'team') return 1;
  if (match.advanced_team === 'opponent') return 0;
  return null;
}

export function backtestAdvances(matches = []) {
  const rows = [];
  const buckets = new Map();
  let sumSq = 0;
  let complete = true;

  for (const match of matches) {
    const prediction = computeAdvance({
      eloTeam: match.eloTeam,
      eloOpp: match.eloOpp,
      bracket: match.bracket,
      lineup: match.lineup,
      evidence: match.evidence,
    });
    const actual = actualAdvanceValue(match);
    if (prediction.status !== 'READY' || actual === null) complete = false;

    const p = prediction.p_advance;
    const error = p === null || actual === null ? null : (p - actual) ** 2;
    if (error !== null) sumSq += error;

    const label = bucketLabel(p ?? 0.5);
    if (!buckets.has(label)) {
      buckets.set(label, { bucket: label, count: 0, sum_p: 0, sum_actual: 0 });
    }
    const bucket = buckets.get(label);
    bucket.count += 1;
    bucket.sum_p += p ?? 0;
    bucket.sum_actual += actual ?? 0;

    rows.push({
      match_id: match.match_id ?? null,
      team: match.team_name ?? null,
      opponent: match.opp_name ?? null,
      prediction,
      actual,
      brier: error,
    });
  }

  const bucketRows = [...buckets.values()].map((bucket) => ({
    bucket: bucket.bucket,
    count: bucket.count,
    mean_p_advance: bucket.count ? bucket.sum_p / bucket.count : null,
    mean_actual: bucket.count ? bucket.sum_actual / bucket.count : null,
  }));

  return {
    calibration_status: complete ? 'V1_PROVISIONAL' : 'V1_PROVISIONAL',
    sample_size: rows.length,
    brier_score: rows.length ? sumSq / rows.length : null,
    buckets: bucketRows.sort((a, b) => a.bucket.localeCompare(b.bucket)),
    rows,
  };
}

