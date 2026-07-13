// Deterministic customer and audit artifacts for regular-game HR projections.

import { buildHrWatchlist, buildScopedLedger } from '../lib/assumptions-ledger.mjs';
import { validateCpcCustomerPacket } from '../../packets/lib/cpc-packet-validator.mjs';

function pct(value, digits = 2) {
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

function fixed(value, digits = 6) {
  return Number(value).toFixed(digits);
}

function playerLabel(projection) {
  return projection?.player?.player_name
    ?? (projection?.player?.mlb_id ? `MLB ${projection.player.mlb_id}` : 'Unknown batter');
}

export function renderRegularGamePacket({
  game,
  projection,
  generatedUtc,
} = {}) {
  if (!generatedUtc) throw new Error('generatedUtc is required for deterministic regular-game packet rendering');
  const lines = [
    "Captain's MLB Prediction Companion",
    `CPC Packet: ${game?.away_team ?? 'Away'} @ ${game?.home_team ?? 'Home'} Anytime-HR Model`,
    `date: ${game?.date ?? 'UNKNOWN'}`,
    `game_id: ${game?.game_id ?? 'UNKNOWN'}`,
    `generated_utc: ${generatedUtc}`,
    ...(game?.sample_mode ? ['mode: AUDIT_SAMPLE — model demonstration, not a scheduled-game recommendation'] : []),
    '',
    'TLDR',
  ];
  const ready = (projection?.outputs ?? []).filter((row) => row.status === 'ready');
  if (ready.length) {
    const top = ready[0];
    lines.push(`  Model leader: ${playerLabel(top)} at ${pct(top.outputs.probability_at_least_one_hr)} for at least one HR.`);
    lines.push(`  Model evidence status: ${top.model_status}.`);
  } else {
    lines.push('  MODEL_INSUFFICIENT: no confirmed, uniquely matched batter has all required model inputs.');
  }
  lines.push(
    '  Market prices, odds, bids, asks, volume, and open interest are display-only and NOT IN SCORE.',
    '',
    'Anytime-HR Projections',
  );
  if (!projection?.outputs?.length) {
    lines.push('  MODEL_INSUFFICIENT — no batter evidence supplied.');
  } else {
    projection.outputs.forEach((row, index) => {
      const label = playerLabel(row);
      if (row.status !== 'ready') {
        lines.push(`#${index + 1} [BLOCKED] ${label}`);
        lines.push(`  MODEL_INSUFFICIENT: ${row.blocked_reasons.join(', ') || 'required inputs missing'}.`);
        return;
      }
      const output = row.outputs;
      lines.push(`#${index + 1} [MODEL_READY] ${label} (MLB ID ${row.player.mlb_id ?? 'MISSING'}, lineup slot ${row.player.lineup_slot})`);
      lines.push(`  Per-PA HR probability: ${pct(output.per_pa_probability)} (${fixed(output.per_pa_probability)}).`);
      lines.push(`  Expected PA: ${fixed(output.expected_pa, 3)} (fitted lineup-slot mean); simulation PA: ${output.simulation_plate_appearances} (rounded).`);
      lines.push(`  At least one HR: ${pct(output.probability_at_least_one_hr)} (${fixed(output.probability_at_least_one_hr)}).`);
      lines.push(`  Expected HR: ${fixed(output.expected_home_runs, 4)}.`);
      lines.push(`  HR count distribution: 0=${pct(output.home_run_distribution['0'])}; 1=${pct(output.home_run_distribution['1'])}; 2+=${pct(output.home_run_distribution['2_plus'])}.`);
      lines.push(`  Evidence status: ${row.model_status}; confidence=${row.confidence}; identity=${row.player.identity_match}; simulation seed=${row.simulation.seed}; n=${row.simulation.simulations}.`);
    });
  }
  lines.push(
    '',
    'Method and Assumptions',
    '  P(at least one HR) = 1 - (1 - per-PA probability)^expected PA.',
    '  This conversion assumes plate-appearance outcomes are conditionally independent.',
    '  Opportunity is fitted separately by lineup slot; it does not alter per-PA contact quality.',
    '  Missing context uses explicit missingness indicators. Ambiguous names block; MLB ID is preferred.',
    `  Calibration claim: ${ready[0]?.audit?.calibration_claim_supported ? 'supported by the committed held-out report' : 'not made; model is labeled uncalibrated'}.`,
    '',
    'Market Context',
    '  Market data is display-only and NOT IN SCORE. No market field changes model output, ranking, confidence, or ordering.',
    '',
    'No trades placed. No bankroll sizing. Research only.',
  );
  return lines.join('\n');
}

function buildAssumptionsLedger({ game, projection, generatedUtc, modelSource }) {
  const readyEntries = buildHrWatchlist((projection.outputs ?? [])
    .filter((row) => row.status === 'ready')
    .map((row) => ({
      player: playerLabel(row),
      team: row.player?.team ?? null,
      game: `${game.away_team} @ ${game.home_team}`,
      status: 'LOCKED',
      basis: `confirmed lineup slot ${row.player.lineup_slot}; MLB-ID-first match; fitted per-PA HR model`,
      source: modelSource,
      source_quality: 'B',
      local_source_ref: `${game.game_id}:${row.player.mlb_id}`,
      projected_hr_prob: row.outputs.probability_at_least_one_hr,
      checked_utc: generatedUtc,
    })), { scope: 'GAME_PACKET' });
  const blockedEntries = (projection.outputs ?? [])
    .filter((row) => row.status !== 'ready')
    .map((row) => ({
      type: 'hr_watch',
      scope: 'GAME_PACKET',
      player: playerLabel(row),
      game: `${game.away_team} @ ${game.home_team}`,
      value: null,
      status: 'UNKNOWN',
      basis: `MODEL_INSUFFICIENT: ${row.blocked_reasons.join(', ')}`,
      source: modelSource,
      source_quality: 'F',
      local_source_ref: `${game.game_id}:${row.player?.mlb_id ?? 'unknown'}`,
    }));
  return buildScopedLedger({
    scope: 'GAME_PACKET',
    date: game.date,
    items: [...readyEntries, ...blockedEntries],
    now: () => generatedUtc,
  });
}

export function buildRegularGamePacketArtifacts({
  game,
  projection,
  generatedUtc,
  modelSource = 'scripts/mlb/hr-engine/artifacts/regular-game-model-2025.json',
} = {}) {
  const packetText = renderRegularGamePacket({ game, projection, generatedUtc });
  const validation = validateCpcCustomerPacket(packetText);
  if (!validation.valid) throw new Error(`regular-game packet validation failed: ${validation.errors.join('; ')}`);
  const assumptionsLedger = buildAssumptionsLedger({ game, projection, generatedUtc, modelSource });
  const profiles = (projection.outputs ?? []).map((row) => ({
    player: row.player,
    status: row.status,
    model_status: row.model_status,
    confidence: row.confidence,
    blocked_reasons: row.blocked_reasons,
  }));
  const simulationSummary = (projection.outputs ?? []).map((row) => ({
    player: row.player,
    outputs: row.outputs,
    simulation: row.simulation ?? null,
  }));
  const inventoryText = (projection.outputs ?? []).map((row, index) =>
    `#${index + 1} status=${row.status} model_status=${row.model_status} player=${playerLabel(row)} mlb_id=${row.player?.mlb_id ?? 'MISSING'} any_hr=${row.outputs?.probability_at_least_one_hr ?? 'MODEL_INSUFFICIENT'} per_pa=${row.outputs?.per_pa_probability ?? 'MODEL_INSUFFICIENT'} blocked=${row.blocked_reasons.join('|') || 'none'}`,
  ).join('\n');
  const audit = {
    schema_version: 'cpc_mlb_regular_game_hr_audit_v1',
    generated_utc: generatedUtc,
    game,
    packet_validation: validation,
    json_txt_parity: 'packet text is rendered exclusively from the projection object',
    deterministic_inputs: {
      generated_utc: generatedUtc,
      simulation_seeds: (projection.outputs ?? []).map((row) => row.simulation?.seed ?? null),
    },
    market_neutrality: projection.audit?.market_inputs_used === false,
    ordering: projection.audit?.ordering ?? null,
  };
  return {
    projection,
    packetText,
    profiles,
    simulationSummary,
    assumptionsLedger,
    inventoryText,
    audit,
  };
}
