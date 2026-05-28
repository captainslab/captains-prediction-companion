// Coca-Cola 600 dry-run packet composer.
// Fixtures-only. No live network. No credentials. No trading.
//
// - Runs the standard Stage-4 output-writer dry-run to populate
//   state/nascar/2026-05-25/ with discovery/ceiling artifacts.
// - Overlays a Coca-Cola 600 nascar_official record on top of the
//   existing manifest (the writer's bundled fixture is Daytona 500;
//   we replace it here to produce a Charlotte-specific packet).
// - Substitutes a DEGRADED practice/qualifying envelope so we do not
//   invent driver speeds.
// - Computes a Storyline Modifier for the top-1 active candidate
//   driver as a MODIFIER ONLY -- never a pick.
// - Writes storyline_modifier.json and packet.md alongside the
//   standard output-writer files.

import { dirname, resolve } from 'node:path';
import { writeJsonAtomic, writeTextAtomic } from './cache.mjs';
import { runOutputWriterDryRun } from './output-writer.mjs';
import { composeRaceDiscovery } from './discovery.mjs';
import { composeStorylineModifier, detectBeneficiary } from './storyline-modifier.mjs';
import {
  cocaCola600StorylineFixture,
  teamGraphFixture,
} from './storyline-fixtures.mjs';
import { fixtureCocaCola600PracticeEnvelope } from './source-adapters/practice-qualifying-coca-cola-600-fixture.mjs';
import { sourcedCocaCola600PracticeEnvelope } from './source-adapters/practice-qualifying-coca-cola-600-sourced.mjs';
import { fixtureNascarOfficialEnvelope } from './source-adapters/nascar-official-fixture.mjs';
import { fixtureKalshiRaceEnvelope } from './source-adapters/kalshi-race-fixture.mjs';
import { fixtureLiquidityEnvelope } from './source-adapters/liquidity-fixture.mjs';
import { fixtureFundamentalsEnvelope } from './source-adapters/fundamentals-fixture.mjs';
import { wikipediaTeamEquipmentEnvelope } from './source-adapters/wikipedia-team-equipment.mjs';
import { nascardataStrategyRiskEnvelope } from './source-adapters/nascardata-strategy.mjs';
import { derivedDriverSkillEnvelope } from './source-adapters/derived-driver-skill.mjs';
import { cupPointsTop20Envelope } from './source-adapters/cup-points-top-20.mjs';
import { seasonForm2026Envelope } from './source-adapters/season-form-2026.mjs';
import { charlotteOvalHistoryEnvelope } from './source-adapters/charlotte-oval-history.mjs';
import { intermediate15miOvalHistoryEnvelope } from './source-adapters/intermediate-15mi-oval-history.mjs';
import { composeBaseFundamentals, fundamentalsForStoryline } from './base-fundamentals.mjs';
import { composeMultiLaneCeilingBoard, MULTI_LANE_LANES } from './multi-lane-ceiling.mjs';
import { composeFinalCeilingBoardOverlay, FINAL_CEILINGS } from './final-ceiling.mjs';

const RUN_DATE = '2026-05-25';
const FROZEN_DEFAULT = '2026-05-24T18:00:00.000Z';

function cocaCola600OfficialEnvelope({ checked_at_utc, outputDir }) {
  const env = fixtureNascarOfficialEnvelope({
    checked_at_utc,
    outputDir,
    event_format: 'points',
    series: 'cup',
  });
  env.records = [
    {
      query_type: 'race_event_context',
      race_name: 'Coca-Cola 600',
      series: 'NCS',
      track: 'Charlotte Motor Speedway',
      track_type: 'intermediate',
      scheduled_start_utc: '2026-05-25T22:00:00.000Z',
      race_type: 'points',
      event_format: 'points',
      stage_lengths: [100, 100, 100, 100],
      is_special_event: false,
      source_urls: [],
      notes: 'Coca-Cola 600 overlay applied by coca-cola-600-packet.mjs (fixture-mode).',
    },
  ];
  env.warnings = [
    ...(env.warnings ?? []),
    'Coca-Cola 600 overlay: race_name/track replaced with Charlotte fixture values.',
  ];
  return env;
}

function buildBaseFundamentalsForDriver(driver, practiceEnvelope) {
  // Practice envelope is degraded; do not invent speeds. We still need
  // numeric scaffolding for composeStorylineModifier to evaluate gates.
  // Use neutral midline values so gates remain meaningful but no claim
  // of strong fundamentals is being made.
  const isDegraded = practiceEnvelope.status === 'degraded';
  return {
    driver_name: driver?.driver_name ?? 'Unknown Driver',
    car_number: driver?.car_number ?? null,
    team: 'RCR',
    manufacturer: 'Chevrolet',
    // Neutral placeholders -- gates intentionally NOT satisfied so true_win
    // modifier stays at 0 for the dry-run packet.
    equipment_quality: isDegraded ? 50 : 65,
    driver_ability_to_convert: isDegraded ? 50 : 60,
    overpricing_penalty: 0,
    data_quality: isDegraded ? 'unknown_downgrade_placeholder' : 'partial',
  };
}

function renderPacket({
  runDate,
  manifest,
  discovery,
  practiceEnvelope,
  fundamentals,
  multiLaneBoard,
  beneficiary,
  modifier,
}) {
  const ctx = manifest.event_context ?? {};
  const lines = [];
  lines.push('# Coca-Cola 600 — NASCAR Research Packet (Dry Run)');
  lines.push('');
  lines.push(`Run date: ${runDate}`);
  lines.push(`Race: ${ctx.race_name ?? 'unknown'}`);
  lines.push(`Track: ${ctx.track ?? 'unknown'} (${ctx.track_type ?? 'unknown'})`);
  lines.push(`Series: ${ctx.series ?? 'unknown'}`);
  lines.push(`Scheduled start (UTC): ${ctx.scheduled_start_utc ?? 'unknown'}`);
  lines.push(`Event format: ${manifest.event_format ?? 'points'}`);
  lines.push('Source mode: fixtures-only (no live network, no credentials)');
  lines.push('');

  const practiceStatus = practiceEnvelope.status;
  const degraded = practiceStatus === 'degraded';
  const downMark = 'DOWNGRADED:UNAVAILABLE';
  const partialMark = 'PARTIAL:PLACEHOLDER';
  const upMark = 'AVAILABLE';

  const layerStatus = fundamentals.layer_status ?? {};
  function layerMark(layer) {
    const s = layerStatus[layer];
    if (s === 'ok') return upMark;
    if (s === 'degraded') return partialMark;
    return downMark;
  }
  function layerNote(layer) {
    const notes = fundamentals.layer_source_notes?.[layer] ?? [];
    return notes[0] ?? 'no source note available.';
  }

  lines.push('## Base Fundamentals');
  lines.push('');
  lines.push(`- Driver skill: ${layerMark('driver_skill')} — ${layerNote('driver_skill')}`);
  lines.push(`- Team / equipment quality: ${layerMark('team_equipment')} — ${layerNote('team_equipment')}`);
  lines.push(`- Pit crew / crew chief: ${layerMark('pit_crew')} — ${layerNote('pit_crew')}`);
  lines.push(`- Strategy risk: ${layerMark('strategy_risk')} — ${layerNote('strategy_risk')}`);
  lines.push(`- Track history: ${downMark} — track_history_signal is "unknown" on placeholder driver records.`);
  lines.push(`- Recent speed: ${downMark} — no recent race-pace samples available.`);
  const pqRecords = Array.isArray(practiceEnvelope?.records) ? practiceEnvelope.records : [];
  const gridCount = pqRecords.filter(r => Number.isFinite(r?.starting_position)).length;
  const practiceCount = pqRecords.filter(r => Number.isFinite(r?.practice_rank)).length;
  const pqSrc = (practiceEnvelope?.source_urls && practiceEnvelope.source_urls[0]) || 'unknown source';
  if (practiceStatus === 'ok' && gridCount > 0) {
    lines.push(`- Qualifying position: ${upMark} — starting grid published (${gridCount} entries) from ${pqSrc}. Format note: ${practiceEnvelope.snapshot?.qualifying_format_note ?? 'n/a'}. Pole: ${practiceEnvelope.snapshot?.pole_position_driver ?? 'n/a'} (#${practiceEnvelope.snapshot?.pole_position_car ?? '?'}).`);
    lines.push(`- Practice speed: ${practiceCount > 0 ? partialMark : downMark} — official practice results published (top ${practiceCount} only); remaining drivers practice_rank=null (not fabricated). Source: ${pqSrc}.`);
  } else {
    lines.push(`- Qualifying position: ${downMark} — practice/qualifying envelope is ${practiceStatus}; no starting grid published yet.`);
    lines.push(`- Practice speed: ${downMark} — practice/qualifying envelope is ${practiceStatus}; no session results published yet.`);
  }
  lines.push(`- Race format / track type: ${upMark} — ${ctx.race_name ?? 'race'} at ${ctx.track ?? 'unknown'}, ${ctx.track_type ?? 'unknown'} track, event_format=${manifest.event_format ?? 'points'}.`);
  lines.push('');
  lines.push(`Overall fundamentals data quality: ${fundamentals.overall_data_quality}`);
  lines.push(`Allowed max posture from fundamentals alone: ${fundamentals.allowed_max_posture}`);
  if (Array.isArray(fundamentals.downgrade_reasons) && fundamentals.downgrade_reasons.length > 0) {
    lines.push('Fundamentals downgrade reasons:');
    for (const r of fundamentals.downgrade_reasons) lines.push(`  - ${r}`);
  }
  if (degraded && Array.isArray(practiceEnvelope.degraded_reasons)) {
    lines.push('');
    lines.push('Practice/qualifying degraded_reasons:');
    for (const r of practiceEnvelope.degraded_reasons) lines.push(`  - ${r}`);
  }
  lines.push('');

  const sIn = modifier.inputs_echo?.storyline ?? {};
  const twm = modifier.true_win_modifier ?? {};
  lines.push('## Storyline Modifier');
  lines.push('');
  lines.push(`- Storyline summary: ${sIn.summary ?? '(unknown)'}`);
  lines.push(`- Beneficiary candidate: ${beneficiary.driver_name ?? 'n/a'} (#${beneficiary.car_number ?? '?'})`);
  lines.push(`- Connection type: ${beneficiary.connection_type ?? 'none'}`);
  if (Array.isArray(beneficiary.evidence) && beneficiary.evidence.length > 0) {
    lines.push(`  - Evidence: ${beneficiary.evidence.join('; ')}`);
  }
  lines.push(`- True win modifier (delta_probability): +${(Number(twm.delta_probability ?? 0) * 100).toFixed(2)}pp (capped at +${((twm.capped_at ?? 0.04) * 100).toFixed(0)}pp; applied=${twm.applied === true})`);
  lines.push(`  - Reason: ${twm.reason ?? 'n/a'}`);
  lines.push(`- Market repricing score: ${modifier.market_repricing_score}`);
  lines.push(`- Performance path: ${modifier.performance_path}`);
  lines.push(`- Market path: ${modifier.market_path}`);
  lines.push(`- Pressure / distraction risk: ${modifier.pressure_distraction_risk?.score} — ${modifier.pressure_distraction_risk?.note}`);
  lines.push(`- Posture hint: ${modifier.posture_hint}`);
  lines.push(`- Disclaimer: "${modifier.disclaimer}"`);
  lines.push('');

  lines.push('## Ceiling Board (Top 20 candidate pool)');
  lines.push('');
  lines.push(`- candidate_pool_size: ${multiLaneBoard.candidate_pool_size}`);
  lines.push(`- candidate_pool_basis: ${multiLaneBoard.candidate_pool_basis}`);
  if (Array.isArray(multiLaneBoard.candidate_pool_source_urls) && multiLaneBoard.candidate_pool_source_urls.length > 0) {
    lines.push(`- candidate_pool_source_urls: ${multiLaneBoard.candidate_pool_source_urls.join(' | ')}`);
  }
  lines.push(`- pool_selection_basis: ${multiLaneBoard.pool_selection_basis}`);
  if (Array.isArray(multiLaneBoard.candidate_pool_join_warnings) && multiLaneBoard.candidate_pool_join_warnings.length > 0) {
    lines.push(`- candidate_pool_join_warnings (${multiLaneBoard.candidate_pool_join_warnings.length}):`);
    for (const w of multiLaneBoard.candidate_pool_join_warnings) lines.push(`    - ${w}`);
  }
  if (multiLaneBoard.pool_short_reason) {
    lines.push(`- pool_short_reason: ${multiLaneBoard.pool_short_reason}`);
  }
  lines.push(`- fundamentals_data_quality: ${multiLaneBoard.fundamentals_data_quality}`);
  lines.push(`- lanes: ${multiLaneBoard.lanes.join(', ')}`);
  lines.push(`- statuses allowed: ${multiLaneBoard.statuses.join(' | ')}`);
  lines.push('');
  lines.push('Rank  Car  Driver                       Score  Cov  Win            Top5           Top10          Top20');
  for (const c of multiLaneBoard.candidates) {
    const name = String(c.driver_name ?? '').padEnd(28).slice(0, 28);
    const car = String(c.car_number ?? '').padStart(3);
    const rank = String(c.pool_rank).padStart(4);
    const sc = String(c.composite_score ?? 'n/a').padStart(5);
    const cov = String(c.fundamentals_layer_coverage ?? 0).padStart(3);
    const w = String(c.lanes.win.status).padEnd(14);
    const t5 = String(c.lanes.top_5.status).padEnd(14);
    const t10 = String(c.lanes.top_10.status).padEnd(14);
    const t20 = String(c.lanes.top_20.status).padEnd(14);
    const bene = c.storyline_beneficiary ? '  * storyline beneficiary' : '';
    lines.push(`${rank}  ${car}  ${name} ${sc}  ${cov}  ${w} ${t5} ${t10} ${t20}${bene}`);
  }
  lines.push('');

  lines.push('## Executive Summary');
  lines.push('');
  lines.push('Charlotte\'s Coca-Cola 600 is a four-stage, 600-mile attrition race where long green-flag cycles and late cautions can both decide the winner. This board keeps the model\'s current scoring and ranking intact while translating the evidence into race-context interpretation for Charlotte specifically: intermediate-track balance, long-run tire management, and pit-cycle execution under fatigue. With pit-crew data missing and practice coverage limited to a published top subset, confidence is capped at EVIDENCE_LEAN even for the highest raw scorers.');
  lines.push('');
  lines.push('Because traditional qualifying was not available and the grid was set by formula, starting-position signal is weaker than usual for projecting clean-air dependence versus pass-quality. The result is a wider uncertainty band around early race pace and setup direction, especially for teams that typically improve through multi-run practice notebooks.');
  lines.push('');
  lines.push('### Race Volatility Note (600-mile variance)');
  lines.push('');
  lines.push('The 600\'s length increases variance through compounding pit cycles, tire-cycle management, heat-to-night track evolution, and caution timing. Even strong baseline profiles can lose position through one poorly timed yellow or an execution miss late, while mid-tier cars can jump tiers on strategy sequence. Treat the top of this board as probability-weighted profiles, not deterministic race scripts.');
  lines.push('');
  lines.push('### Top-driver Charlotte Profiles (rankings unchanged)');
  lines.push('');
  const topProfiles = multiLaneBoard.candidates.slice(0, 8);
  for (const c of topProfiles) {
    const score = c.composite_score ?? 'n/a';
    const top10 = c?.lanes?.top_10?.status ?? 'n/a';
    const top20 = c?.lanes?.top_20?.status ?? 'n/a';
    lines.push(`- #${c.car_number ?? '?'} ${c.driver_name ?? 'Unknown'} (rank ${c.pool_rank}, score ${score}) — Charlotte fit: ${c.final_reasoning_summary ?? 'Model favors this profile on combined driver-skill, equipment, and strategy-risk inputs.'} Long-run context: current packet has no full-field run-by-run falloff telemetry; interpretation is inferred from available strategy-risk and equipment layers only. Path to failure: ${c.final_invalidators?.[0] ?? 'Late-cycle caution variance and missing pit-crew granularity can erase edge quickly.'} Ceiling posture: Top 10 ${top10}; Top 20 ${top20}.`);
  }
  lines.push('');

  // Per-driver evidence ledger — the heart of the reasoning-backed board.
  lines.push('### Per-driver Evidence Ledger');
  lines.push('');
  lines.push('Each driver shows: composite score, fundamentals layer coverage,');
  lines.push('per-layer contribution/missingness, the coverage rule applied,');
  lines.push('and the resulting per-lane ceiling with reason text.');
  lines.push('');
  for (const c of multiLaneBoard.candidates) {
    lines.push(`#${c.car_number ?? '?'} ${c.driver_name ?? 'Unknown'} (${c.team ?? 'team n/a'})`);
    lines.push(`  pool_rank: ${c.pool_rank}`);
    lines.push(`  composite_score: ${c.composite_score ?? 'n/a'}`);
    lines.push(`  fundamentals_layer_coverage: ${c.fundamentals_layer_coverage} — ${c.fundamentals_layer_coverage_label}`);
    lines.push(`  coverage_cap_rule: ${c.coverage_cap_rule}`);
    lines.push(`  score_reasoning: ${c.score_reasoning}`);
    lines.push('  layer_evidence_ledger:');
    for (const row of c.layer_evidence_ledger ?? []) {
      if (row.present) {
        const fieldStr = row.fields_used.map(f => `${f.field}=${f.value} (w=${f.normalized_weight}, contrib=${f.contribution})`).join('; ');
        lines.push(`    - ${row.layer}: PRESENT — ${fieldStr}; layer_contribution_total=${row.contribution_total}`);
      } else {
        const missing = row.fields_missing.map(f => f.field).join(', ');
        lines.push(`    - ${row.layer}: MISSING — no source-backed value; excluded from score (fields: ${missing}).`);
      }
    }
    lines.push('  lane ceilings:');
    for (const lane of multiLaneBoard.lanes) {
      const l = c.lanes[lane];
      lines.push(`    - ${l.narrative}`);
    }
    if (c.storyline_beneficiary) {
      lines.push('  storyline_beneficiary: true (reference-only flag; never upgrades a lane).');
    }
    lines.push('');
  }

  lines.push('Lane gating notes:');
  for (const note of multiLaneBoard.safety_notes) lines.push(`- ${note}`);
  lines.push('');

  // ── Final Ceiling Board (single ceiling per driver) ────────────────────
  lines.push('## Final Ceiling Board (single ceiling per driver)');
  lines.push('');
  const fcs = multiLaneBoard.final_ceiling_schema ?? {};
  lines.push(`Ceilings allowed: ${(fcs.ceilings_allowed ?? []).join(' | ')}`);
  lines.push(`Era filter: ${fcs.era_filter ?? 'n/a'}`);
  lines.push(`Charlotte filter: ${fcs.charlotte_filter ?? 'n/a'}`);
  lines.push('Sources:');
  for (const [cat, urls] of Object.entries(fcs.sources ?? {})) {
    lines.push(`  - ${cat}: ${(urls ?? []).join(' | ') || 'n/a'}`);
  }
  lines.push('');
  lines.push('Rank | Driver                    | Car | Score | Ceiling       | Reasoning Summary');
  lines.push('-----+---------------------------+-----+-------+---------------+---------------------------------------');
  for (const c of multiLaneBoard.candidates) {
    const rank = String(c.pool_rank).padStart(4);
    const name = String(c.driver_name ?? '').padEnd(26).slice(0, 26);
    const car = String(c.car_number ?? '?').padStart(3);
    const sc = String(c.final_composite_score ?? 'n/a').padStart(5);
    const ce = String(c.final_ceiling ?? 'NO CLEAR PICK').padEnd(13);
    const sum = String(c.final_reasoning_summary ?? '').slice(0, 200);
    lines.push(`${rank} | ${name}| ${car} | ${sc} | ${ce} | ${sum}`);
  }
  lines.push('');

  lines.push('### Per-driver Final-Ceiling Evidence Ledger');
  lines.push('');
  for (const c of multiLaneBoard.candidates) {
    lines.push(`#${c.car_number ?? '?'} ${c.driver_name ?? 'Unknown'} (${c.team ?? 'team n/a'}) — pool_rank=${c.pool_rank}`);
    lines.push(`  Composite score: ${c.final_composite_score ?? 'n/a'} (over ${c.final_layers_present} layer(s))`);
    lines.push(`  Final ceiling: ${c.final_ceiling} — ${c.final_ceiling_reason}`);
    lines.push('  Evidence ledger:');
    for (const row of c.final_evidence_ledger ?? []) {
      if (row.present) {
        lines.push(`    - ${row.category} [${row.label}]: value=${row.value} grade=${row.grade} raw_weight=${row.raw_weight} norm_weight=${row.normalized_weight} contribution=${row.contribution}`);
        lines.push(`        source: ${row.source_basis}`);
        if (row.detail) lines.push(`        detail: ${row.detail}`);
        if (row.missing_note) lines.push(`        note: ${row.missing_note}`);
      } else {
        lines.push(`    - ${row.category} [${row.label}]: MISSING — excluded from score (raw_weight=${row.raw_weight} would have been re-normalized away).`);
        lines.push(`        source: ${row.source_basis}`);
        if (row.missing_note) lines.push(`        note: ${row.missing_note}`);
      }
    }
    lines.push('  Invalidators:');
    if ((c.final_invalidators ?? []).length === 0) {
      lines.push('    - (none flagged)');
    } else {
      for (const inv of c.final_invalidators) lines.push(`    - ${inv}`);
    }
    lines.push('');
  }

  lines.push('## Market Context');
  lines.push('');
  lines.push('Market lanes are listed here as REFERENCE ONLY and are explicitly separated from the Edge Basis below. Price, volume, OI, and line movement are Market Context only and never create edge.');
  lines.push('');
  for (const lane of discovery.supported_market_lanes ?? []) {
    lines.push(`- ${lane.market_lane} (${lane.lane_type}) — source_available=${lane.source_available} — ${lane.description}`);
  }
  lines.push('');

  lines.push('## Edge Basis');
  lines.push('');
  const dq = fundamentals.overall_data_quality;
  const cap = fundamentals.allowed_max_posture;
  const layerLine = Object.entries(fundamentals.layer_status ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  let capRationale;
  if (dq === 'ok') {
    capRationale = 'All critical layers (driver_skill, team_equipment, strategy_risk) and pit_crew are OK. PICK is eligible where a lane score clears the PICK threshold and the market lane is available.';
  } else if (dq === 'partial') {
    capRationale = 'All critical layers (driver_skill, team_equipment, strategy_risk) are present (sourced or derived/proxy); pit_crew is non-critical and may be unavailable. PICK is blocked; lanes may reach EVIDENCE_LEAN, LEAN, or WATCH based on per-driver score and market availability.';
  } else if (dq === 'degraded') {
    capRationale = 'At least one critical layer (driver_skill, team_equipment, or strategy_risk) is unavailable. All lanes cap at WATCH regardless of score.';
  } else {
    capRationale = 'No fundamentals layers are available. All lanes cap at NO CLEAR PICK.';
  }
  lines.push(`Layer status: ${layerLine}.`);
  lines.push(`Overall fundamentals data quality: ${dq}. Allowed maximum posture: ${cap}.`);
  lines.push(capRationale);
  lines.push('The Kyle Busch / RCR No. 8 / Austin Hill tribute is layered strictly as a MODIFIER and never creates LEAN, EVIDENCE_LEAN, or PICK on its own. Storyline does not create speed.');
  lines.push('Market context (price/OI/volume/line movement) is reference only and never contributes to Edge Basis.');
  lines.push('');

  lines.push('## Safety');
  lines.push('');
  lines.push('- No trades placed by this workflow.');
  lines.push('- Fixtures-only run; no live network and no credentials touched.');
  lines.push('- Downgrade applied: any unavailable fundamentals layer is marked DOWNGRADED:UNAVAILABLE — no fabricated ratings.');
  lines.push('- Storyline fields are fixture placeholders; replace with sourced packet before publication.');
  lines.push('');
  return lines.join('\n');
}

export async function composeCocaCola600Packet({
  outputDir = `state/nascar/${RUN_DATE}`,
  frozenCheckedAtUtc = FROZEN_DEFAULT,
} = {}) {
  const absOutputDir = resolve(outputDir);
  const stateRoot = resolve(absOutputDir, '..', '..'); // .../state

  // 1. Standard Stage-4 dry run (writes the six baseline files).
  const baseline = await runOutputWriterDryRun({
    date: RUN_DATE,
    eventFormat: 'points',
    series: 'cup',
    stateRoot,
    frozenCheckedAtUtc,
  });

  // 2. Build Coca-Cola 600 specific envelopes (official overlay + degraded P/Q).
  const checkedAtUtc = frozenCheckedAtUtc;
  const envelopes = {
    kalshi_race: fixtureKalshiRaceEnvelope({
      checked_at_utc: checkedAtUtc,
      outputDir: `${absOutputDir}/discovery`,
      event_format: 'points',
    }),
    nascar_official: cocaCola600OfficialEnvelope({
      checked_at_utc: checkedAtUtc,
      outputDir: `${absOutputDir}/discovery`,
    }),
    practice_qualifying: sourcedCocaCola600PracticeEnvelope({
      checked_at_utc: checkedAtUtc,
      outputDir: `${absOutputDir}/discovery`,
    }),
    liquidity: fixtureLiquidityEnvelope({
      checked_at_utc: checkedAtUtc,
      outputDir: `${absOutputDir}/discovery`,
    }),
  };

  const discovery = composeRaceDiscovery({
    envelopes,
    runDate: RUN_DATE,
    checkedAtUtc,
  });

  const manifest = {
    schema_version: 'nascar_race_manifest_v1',
    run_date: RUN_DATE,
    checked_at_utc: checkedAtUtc,
    event_context: discovery.event_context,
    event_format: discovery.event_context?.event_format ?? 'points',
    special_event_override: discovery.special_event_override,
    supported_market_lanes: discovery.supported_market_lanes,
    pool_rules: discovery.pool_rules,
    run_metadata: {
      mode: 'fixtures-only',
      generator: 'scripts/nascar/lib/coca-cola-600-packet.mjs',
      stage: 'coca_cola_600_dry_run_packet',
      no_trades: true,
    },
  };

  // 3. Pick top-1 active candidate driver (fall back to first universe entry).
  const topActive =
    (discovery.active_candidate_pool && discovery.active_candidate_pool[0]) ||
    (discovery.driver_universe && discovery.driver_universe[0]) ||
    null;

  const storyline = cocaCola600StorylineFixture();
  const teamGraph = teamGraphFixture();

  // Detect beneficiary against the Austin Hill #33 fixture entry (per task spec).
  const austinHillFixtureDriver = {
    driver_name: 'Austin Hill',
    car_number: 33,
    team: 'RCR',
    manufacturer: 'Chevrolet',
  };
  const detection = detectBeneficiary(storyline, austinHillFixtureDriver, teamGraph);

  const baseFundamentalsLegacy = buildBaseFundamentalsForDriver(topActive, envelopes.practice_qualifying);

  // 3b. Load the 4 explicit fundamentals layers. Clean adapters where a
  // public, non-blocked source exists; fixture/unavailable otherwise.
  //   - team_equipment: Wikipedia 2025 Cup season aggregates (clean).
  //   - strategy_risk:  nascaR.data 2024 CSV mirror (DEGRADED proxy).
  //   - driver_skill:   derived from strategy + team (DEGRADED proxy;
  //                     live sources blocked by anti-bot under recon).
  //   - pit_crew:       UNAVAILABLE — no clean public structured source.
  const strategyEnv = nascardataStrategyRiskEnvelope({
    checked_at_utc: checkedAtUtc,
    outputDir: `${absOutputDir}/fundamentals`,
  });
  const teamEnv = wikipediaTeamEquipmentEnvelope({
    checked_at_utc: checkedAtUtc,
    outputDir: `${absOutputDir}/fundamentals`,
  });
  const fundamentalsEnvelopes = {
    driver_skill: derivedDriverSkillEnvelope({
      checked_at_utc: checkedAtUtc,
      outputDir: `${absOutputDir}/fundamentals`,
      strategyEnvelope: strategyEnv,
      teamEnvelope: teamEnv,
    }),
    team_equipment: teamEnv,
    pit_crew: fixtureFundamentalsEnvelope({
      layer: 'pit_crew',
      status: 'unavailable',
      checked_at_utc: checkedAtUtc,
      outputDir: `${absOutputDir}/fundamentals`,
    }),
    strategy_risk: strategyEnv,
  };
  const fundamentals = composeBaseFundamentals({ envelopes: fundamentalsEnvelopes });

  // 3c. Multi-lane ceiling board — full active-field candidate pool with 4 lanes
  //     (win, top_5, top_10, top_20) per driver.
  //
  // Pool basis for article packet is the FULL active field from the sourced
  // Coca-Cola 600 starting grid (Charlotte oval only). We left-join points
  // position metadata where available but do not drop drivers missing points
  // rows. Drivers without a fundamentals join stay in the pool with
  // NO CLEAR PICK lanes — they are not dropped or replaced.
  const cupPointsEnv = cupPointsTop20Envelope({
    checked_at_utc: checkedAtUtc,
    outputDir: `${absOutputDir}/discovery`,
    poolSize: 39,
  });
  const pointsByCar = new Map(
    cupPointsEnv.records.map(r => [Number(r.car_number), r]),
  );
  const activeField = Array.isArray(envelopes.practice_qualifying?.records)
    ? envelopes.practice_qualifying.records
    : [];
  const candidatePool = activeField.map(r => {
    const points = pointsByCar.get(Number(r.car_number));
    return {
      driver_name: r.driver_name,
      car_number: r.car_number,
      team: r.team,
      manufacturer: r.manufacturer,
      points_position: points?.points_position ?? null,
      season_points: points?.season_points ?? null,
    };
  });

  const multiLaneBoard = composeMultiLaneCeilingBoard({
    fundamentals,
    supportedMarketLanes: discovery.supported_market_lanes,
    eventContext: discovery.event_context,
    storylineBeneficiary: {
      driver_name: 'Austin Hill',
      car_number: 33,
      connection_type: 'current_team',
    },
    poolSize: candidatePool.length,
    candidatePool,
    candidatePoolBasis: 'coca_cola_600_active_field_grid',
    candidatePoolSourceUrls: [
      ...(envelopes.practice_qualifying.source_urls ?? []),
      ...(cupPointsEnv.source_urls ?? []),
    ],
  });

  // 3d. Final-ceiling overlay — collapses the 4 lane statuses into ONE
  // ceiling per driver (WIN / TOP 5 / TOP 10 / TOP 20 / WATCH / NO CLEAR PICK),
  // backed by a 6-category source-cited evidence ledger.
  const seasonFormEnv = seasonForm2026Envelope({
    checked_at_utc: checkedAtUtc,
    outputDir: `${absOutputDir}/fundamentals`,
  });
  const charlotteOvalEnv = charlotteOvalHistoryEnvelope({
    checked_at_utc: checkedAtUtc,
    outputDir: `${absOutputDir}/fundamentals`,
  });
  const intermediateEnv = intermediate15miOvalHistoryEnvelope({
    checked_at_utc: checkedAtUtc,
    outputDir: `${absOutputDir}/fundamentals`,
  });

  const finalCeilingOverlay = composeFinalCeilingBoardOverlay({
    candidates: multiLaneBoard.candidates,
    seasonFormEnvelope: seasonFormEnv,
    charlotteOvalEnvelope: charlotteOvalEnv,
    intermediateEnvelope: intermediateEnv,
    practiceQualifyingEnvelope: envelopes.practice_qualifying,
  });

  // Inject overlay fields onto each candidate row (single source of truth).
  for (let i = 0; i < multiLaneBoard.candidates.length; i++) {
    const c = multiLaneBoard.candidates[i];
    const o = finalCeilingOverlay[i];
    c.final_ceiling = o.final_ceiling;
    c.final_ceiling_reason = o.final_ceiling_reason;
    c.final_composite_score = o.composite_score;
    c.final_layers_present = o.layers_present;
    c.final_evidence_ledger = o.evidence_ledger;
    c.final_invalidators = o.invalidators;
    c.final_reasoning_summary = o.reasoning_summary;
  }
  multiLaneBoard.candidates.sort((a, b) => (Number(b.final_composite_score ?? -1) - Number(a.final_composite_score ?? -1)));
  multiLaneBoard.candidates.forEach((c, idx) => {
    c.pool_rank = idx + 1;
  });
  multiLaneBoard.final_ceiling_schema = {
    ceilings_allowed: FINAL_CEILINGS,
    layer_categories: [
      'baseline_fundamentals',
      'season_form_2026',
      'charlotte_oval_history',
      'intermediate_15mi_oval',
      'practice_qualifying',
      'long_run_race_type_fit',
    ],
    sources: {
      season_form_2026: seasonFormEnv.source_urls,
      charlotte_oval_history: charlotteOvalEnv.source_urls,
      intermediate_15mi_oval: intermediateEnv.source_urls,
      practice_qualifying: envelopes.practice_qualifying.source_urls,
    },
    era_filter: 'Next Gen / Gen 7 (2022 Daytona 500 onward)',
    charlotte_filter: 'Charlotte Motor Speedway OVAL only — Roval explicitly excluded',
  };

  // Pick the fundamentals entry whose car matches the active candidate
  // (fallback: first entry). Convert to storyline-gate input.
  const driverEntry = fundamentals.by_driver.find(d => d.car_number === topActive?.car_number)
    ?? fundamentals.by_driver[0]
    ?? null;
  const storylineBaseFundamentals = fundamentalsForStoryline(driverEntry);
  // Preserve the legacy placeholder fields the existing test suite cares
  // about (overpricing_penalty, etc.) but let real fundamentals override
  // equipment_quality and driver_ability_to_convert when present.
  const baseFundamentals = {
    ...baseFundamentalsLegacy,
    equipment_quality: storylineBaseFundamentals.equipment_quality,
    driver_ability_to_convert: storylineBaseFundamentals.driver_ability_to_convert,
    fundamentals_data_quality: fundamentals.overall_data_quality,
  };

  const modifier = composeStorylineModifier({
    storyline,
    baseFundamentals,
    eventContext: discovery.event_context,
  });

  const beneficiary = {
    driver_name: austinHillFixtureDriver.driver_name,
    car_number: austinHillFixtureDriver.car_number,
    connection_type: detection.connection_type,
    evidence: detection.evidence,
    stand_in_top1_active_candidate: topActive
      ? { driver_name: topActive.driver_name, car_number: topActive.car_number }
      : null,
  };

  // 4. Write storyline_modifier.json + packet.md.
  const modifierPath = `${absOutputDir}/storyline_modifier.json`;
  writeJsonAtomic(modifierPath, {
    ...modifier,
    beneficiary,
    fixture_safety_notes: storyline.safety_notes,
  });

  const fundamentalsPath = `${absOutputDir}/base_fundamentals.json`;
  writeJsonAtomic(fundamentalsPath, fundamentals);

  const ceilingBoardPath = `${absOutputDir}/ceiling_board.json`;
  writeJsonAtomic(ceilingBoardPath, multiLaneBoard);

  const packetMd = renderPacket({
    runDate: RUN_DATE,
    manifest,
    discovery,
    practiceEnvelope: envelopes.practice_qualifying,
    fundamentals,
    multiLaneBoard,
    beneficiary,
    modifier,
  });
  const packetPath = `${absOutputDir}/packet.md`;
  writeTextAtomic(packetPath, packetMd);

  return {
    runDate: RUN_DATE,
    outputDir: absOutputDir,
    files: [...baseline.files, fundamentalsPath, ceilingBoardPath, modifierPath, packetPath],
    manifest,
    discovery,
    fundamentals,
    multiLaneBoard,
    modifier,
    beneficiary,
    practice_envelope_status: envelopes.practice_qualifying.status,
    practice_degraded_reasons: envelopes.practice_qualifying.degraded_reasons ?? [],
  };
}

// Re-export for convenience
export { dirname };
