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
import { fixtureNascarOfficialEnvelope } from './source-adapters/nascar-official-fixture.mjs';
import { fixtureKalshiRaceEnvelope } from './source-adapters/kalshi-race-fixture.mjs';
import { fixtureLiquidityEnvelope } from './source-adapters/liquidity-fixture.mjs';

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
  const upMark = 'AVAILABLE';
  lines.push('## Base Fundamentals');
  lines.push('');
  lines.push(`- Driver skill: ${downMark} — no individual driver-skill projection emitted; discovery is fixture-only.`);
  lines.push(`- Team / equipment quality: ${downMark} — no organization-level equipment grade available in fixture mode.`);
  lines.push(`- Track history: ${downMark} — track_history_signal is "unknown" on placeholder driver records.`);
  lines.push(`- Recent speed: ${downMark} — no recent race-pace samples available.`);
  lines.push(`- Qualifying position: ${downMark} — practice/qualifying envelope is ${practiceStatus}; no starting grid published yet.`);
  lines.push(`- Practice speed: ${downMark} — practice/qualifying envelope is ${practiceStatus}; no session results published yet.`);
  lines.push(`- Pit crew / crew chief: ${downMark} — no crew performance signal in fixture mode.`);
  lines.push(`- Strategy risk: ${downMark} — no fuel/tire strategy model wired in for this dry run.`);
  lines.push(`- Race format / track type: ${upMark} — ${ctx.race_name ?? 'race'} at ${ctx.track ?? 'unknown'}, ${ctx.track_type ?? 'unknown'} track, event_format=${manifest.event_format ?? 'points'}.`);
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

  lines.push('## Market Context');
  lines.push('');
  lines.push('Market lanes are listed here as REFERENCE ONLY and are explicitly separated from the edge basis below.');
  lines.push('');
  for (const lane of discovery.supported_market_lanes ?? []) {
    lines.push(`- ${lane.market_lane} (${lane.lane_type}) — source_available=${lane.source_available} — ${lane.description}`);
  }
  lines.push('');

  lines.push('## Edge Basis');
  lines.push('');
  lines.push('The Kyle Busch / RCR No. 8 / Austin Hill tribute is layered strictly as a MODIFIER. Base fundamentals are DEGRADED (no practice or qualifying data published at packet time, placeholder driver records only). Under these conditions no PICK and no EVIDENCE_LEAN may be emitted. The allowed posture is WATCH or MARKET_REPRICING_ALERT. Storyline does not create speed.');
  lines.push('');

  lines.push('## Safety');
  lines.push('');
  lines.push('- No trades placed by this workflow.');
  lines.push('- Fixtures-only run; no live network and no credentials touched.');
  lines.push('- Downgrade applied: practice/qualifying envelope is DEGRADED — driver speeds were NOT fabricated.');
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
    practice_qualifying: fixtureCocaCola600PracticeEnvelope({
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

  const baseFundamentals = buildBaseFundamentalsForDriver(topActive, envelopes.practice_qualifying);
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

  const packetMd = renderPacket({
    runDate: RUN_DATE,
    manifest,
    discovery,
    practiceEnvelope: envelopes.practice_qualifying,
    beneficiary,
    modifier,
  });
  const packetPath = `${absOutputDir}/packet.md`;
  writeTextAtomic(packetPath, packetMd);

  return {
    runDate: RUN_DATE,
    outputDir: absOutputDir,
    files: [...baseline.files, modifierPath, packetPath],
    manifest,
    discovery,
    modifier,
    beneficiary,
    practice_envelope_status: envelopes.practice_qualifying.status,
    practice_degraded_reasons: envelopes.practice_qualifying.degraded_reasons ?? [],
  };
}

// Re-export for convenience
export { dirname };
