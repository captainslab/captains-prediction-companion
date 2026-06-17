// UFC evidence ledger: 11-layer fighter composite.
// Market prices are never score inputs.

export const LAYER_DEFS = Object.freeze([
  { key: 'striking_offense', weight: 0.13, label: 'SLpM, accuracy, output' },
  { key: 'striking_defense', weight: 0.11, label: 'SApM, strike defense' },
  { key: 'grappling_offense', weight: 0.11, label: 'TD average, TD accuracy, sub output' },
  { key: 'grappling_defense', weight: 0.11, label: 'TD defense, get-up ability' },
  { key: 'opponent_adjusted_striking', weight: 0.09, label: 'Striking vs opponent defense' },
  { key: 'opponent_adjusted_grappling', weight: 0.09, label: 'Grappling vs opponent TDD/control' },
  { key: 'finish_power', weight: 0.09, label: 'KO/sub finish potential' },
  { key: 'durability', weight: 0.09, label: 'Damage tolerance, KO losses' },
  { key: 'cardio_pace', weight: 0.06, label: 'Pace sustainability' },
  { key: 'recent_form', weight: 0.08, label: 'Recent fight trajectory' },
  { key: 'physical_style', weight: 0.04, label: 'Reach, height, stance' },
]);

export function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

export function avg(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function sourceQuality(stats) {
  if (!stats) return 'missing';
  if (stats.__source_quality?.source_method) return String(stats.__source_quality.source_method).toLowerCase();
  if (stats.__source_quality?.source_url) return 'medium';
  return 'high';
}

