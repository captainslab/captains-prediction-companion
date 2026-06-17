import { LAYER_DEFS, clamp, avg, sourceQuality } from './evidence-ledger.mjs';

function capLayerForSource(layer, stats, layerKey) {
  const quality = sourceQuality(stats);
  const cap = quality === 'high' ? 100 : quality === 'medium' ? 85 : 70;
  return {
    ...layer,
    layer_key: layerKey,
    source_quality: quality,
    score: layer.present ? clamp(Math.round(Math.min(layer.score, cap))) : null,
  };
}

function parseHeightInches(height) {
  if (height === null || height === undefined) return null;
  if (typeof height === 'number') return height;
  const m = String(height).match(/(\d+)'?\s*(\d+)?/);
  if (!m) return null;
  const feet = Number(m[1]);
  const inches = Number(m[2] || 0);
  return Number.isFinite(feet) ? feet * 12 + inches : null;
}

function profileMetadata(stats) {
  const fights = Array.isArray(stats?.fights) ? stats.fights : [];
  const oppRows = fights.filter((f) => f.opponent).length;
  const roundRows = fights.filter((f) => Number.isFinite(Number(f.round))).length;
  const timeRows = fights.filter((f) => typeof f.time === 'string' && /^\d+:\d+$/.test(f.time)).length;
  const statRows = fights.filter((f) =>
    f.sig_str_for !== undefined || f.kd_for !== undefined || f.td_for !== undefined || f.sub_att_for !== undefined
  ).length;
  return {
    source_quality: sourceQuality(stats),
    fight_rows: fights.length,
    opponent_rows: oppRows,
    round_rows: roundRows,
    time_rows: timeRows,
    per_fight_stat_rows: statRows,
  };
}

function layeredScore(stats, key) {
  const record = stats?.record || {};
  const fights = Array.isArray(stats?.fights) ? stats.fights : [];
  const wins = Number(record.wins ?? 0);
  const losses = Number(record.losses ?? 0);
  const total = Math.max(wins + losses + Number(record.draws ?? 0), 1);

  switch (key) {
    case 'striking_offense':
      return clamp((Number(stats.slpm ?? 0) / 6.5) * 100 * 0.55 + Number(stats.str_acc ?? 0) * 0.45);
    case 'striking_defense':
      return clamp(Number(stats.str_def ?? 0) * 0.65 + (100 - Number(stats.sapm ?? 0) * 12) * 0.35);
    case 'grappling_offense':
      return clamp((Number(stats.td_avg ?? 0) / 4) * 100 * 0.35 + Number(stats.td_acc ?? 0) * 0.35 + Number(stats.sub_avg ?? 0) * 25);
    case 'grappling_defense':
      return clamp(Number(stats.td_def ?? 0) * 0.7 + (stats.sub_def ?? 50) * 0.3);
    case 'opponent_adjusted_striking':
      return clamp((layeredScore(stats, 'striking_offense') + layeredScore(stats, 'striking_defense')) / 2);
    case 'opponent_adjusted_grappling':
      return clamp((layeredScore(stats, 'grappling_offense') + layeredScore(stats, 'grappling_defense')) / 2);
    case 'finish_power':
      return clamp((wins / total) * 100 * 0.55 + (fights.filter((f) => /KO\/TKO|SUB/i.test(f.method || '')).length / Math.max(fights.length, 1)) * 100 * 0.45);
    case 'durability':
      return clamp(100 - (losses / total) * 100 * 0.7 - (fights.filter((f) => /KO\/TKO/i.test(f.method || '') && f.result === 'loss').length * 7));
    case 'cardio_pace':
      return clamp(50 + (fights.length >= 5 ? 10 : 0) + (Number(stats.str_def ?? 50) - 50) * 0.2);
    case 'recent_form':
      return clamp(50 + (wins - losses) * 3 + Math.min(fights.slice(0, 5).filter((f) => f.result === 'win').length * 2, 10));
    case 'physical_style': {
      const height = parseHeightInches(stats.height);
      const reach = stats.reach !== undefined && stats.reach !== null ? Number(stats.reach) : null;
      const stance = String(stats.stance || '').toLowerCase();
      return clamp(avg([
        reach === null ? null : (reach - 64) * 4,
        height === null ? null : (height - 64) * 2.5,
        stance === 'switch' ? 82 : stance === 'southpaw' ? 64 : 56,
      ]) ?? 50);
    }
    default:
      return 50;
  }
}

export function buildFighterEntry(fighterStats, opponentStats = null) {
  const profile = profileMetadata(fighterStats);
  const entry = {
    source_quality: sourceQuality(fighterStats),
    profile,
    _fight_shape: {
      opponent_rows: profile.opponent_rows,
      round_rows: profile.round_rows,
      time_rows: profile.time_rows,
      per_fight_stat_rows: profile.per_fight_stat_rows,
    },
  };

  for (const def of LAYER_DEFS) {
    const score = layeredScore(fighterStats, def.key);
    entry[def.key] = capLayerForSource({
      present: true,
      score,
      basis: `${def.key} from cached stat profile`,
      detail: `source_quality=${entry.source_quality}`,
    }, fighterStats, def.key);
  }

  return entry;
}

