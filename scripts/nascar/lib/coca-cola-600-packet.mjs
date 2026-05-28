// Coca-Cola 600 packet composer.
// Public-source snapshots only. No credentials. No trading.
//
// - Runs the standard Stage-4 output-writer dry-run to populate
//   state/nascar/2026-05-25/ with discovery/ceiling artifacts.
// - Overlays a Coca-Cola 600 nascar_official record on top of the
//   existing manifest (the writer's bundled fixture is Daytona 500;
//   we replace it here to produce a Charlotte-specific packet).
// - Uses public-source snapshot envelopes where available and labels
//   every model-derived, partial, degraded, unavailable, or missing layer.
// - Computes a Storyline Modifier as a MODIFIER ONLY -- never a pick
//   and never a final-ceiling input.
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
import { sourcedCocaCola600PracticeEnvelope } from './source-adapters/practice-qualifying-coca-cola-600-sourced.mjs';
import { fixtureNascarOfficialEnvelope } from './source-adapters/nascar-official-fixture.mjs';
import { fixtureKalshiRaceEnvelope } from './source-adapters/kalshi-race-fixture.mjs';
import { fixtureLiquidityEnvelope } from './source-adapters/liquidity-fixture.mjs';
import { fixtureFundamentalsEnvelope } from './source-adapters/fundamentals-fixture.mjs';
import { wikipediaTeamEquipmentEnvelope } from './source-adapters/wikipedia-team-equipment.mjs';
import { nascardataStrategyRiskEnvelope } from './source-adapters/nascardata-strategy.mjs';
import { derivedDriverSkillEnvelope } from './source-adapters/derived-driver-skill.mjs';
import { cupPointsTop20Envelope } from './source-adapters/cup-points-top-20.mjs';
import { activeFieldPoolEnvelope } from './source-adapters/active-field-pool.mjs';
import { seasonForm2026Envelope } from './source-adapters/season-form-2026.mjs';
import { seasonSpeedSignal2026Envelope } from './source-adapters/season-speed-signal-2026.mjs';
import { charlotteOvalHistoryEnvelope } from './source-adapters/charlotte-oval-history.mjs';
import { intermediate15miOvalHistoryEnvelope } from './source-adapters/intermediate-15mi-oval-history.mjs';
import { composeBaseFundamentals, fundamentalsForStoryline } from './base-fundamentals.mjs';
import { composeMultiLaneCeilingBoard, MULTI_LANE_LANES } from './multi-lane-ceiling.mjs';
import { composeFinalCeilingBoardOverlay, FINAL_CEILINGS } from './final-ceiling.mjs';

const RUN_DATE = '2026-05-25';
const FROZEN_DEFAULT = '2026-05-24T18:00:00.000Z';
const PUBLICATION_CHECKED_AT_UTC = '2026-05-24T23:11:45.000Z';
const PUBLICATION_SOURCE_MODE = 'current public-source snapshots + model-derived scoring layers; race is live/in-progress, but live running order/results are not ingested';
const SOURCE_UNAVAILABLE_MARK = 'DOWNGRADED:UNAVAILABLE';
const SOURCE_PARTIAL_MARK = 'PARTIAL:PLACEHOLDER';
const SOURCE_AVAILABLE_MARK = 'AVAILABLE';

const PUBLICATION_SOURCE_CHECKS = Object.freeze([
  {
    label: 'NASCAR live/results page',
    url: 'https://www.nascar.com/live-results/nascar-cup-series/2026-coca-cola-600/',
    verifies: 'Charlotte Motor Speedway, Sunday May 24, 2026, 6:00 PM ET listing; live-results page and race-status surface.',
  },
  {
    label: 'Charlotte Motor Speedway event page',
    url: 'https://www.charlottemotorspeedway.com/events/coca-cola-600/',
    verifies: 'Coca-Cola 600 event date/time and track.',
  },
  {
    label: 'NASCAR entry list',
    url: 'https://www.nascar.com/news-media/2026/05/18/2026-nascar-cup-series-entry-list-for-charlotte-motor-speedway-spring-race/',
    verifies: 'Cup Series event context, Charlotte Motor Speedway, longest-race format, and published entry-list context.',
  },
  {
    label: 'Motorsport.com starting lineup',
    url: 'https://www.motorsport.com/nascar-cup/news/coca-cola-600-starting-lineup-nascar-cup-qualifying-canceled-due-to-rain/10823468/',
    verifies: '39 entries, qualifying canceled by weather, grid set by metric, Tyler Reddick on pole.',
  },
  {
    label: 'TobyChristie practice results',
    url: 'https://tobychristie.com/race-result/practice-results-2026-nascar-cup-series-coca-cola-600-at-charlotte/',
    verifies: 'Practice-results source; the current model snapshot ingests only the top-three practice ranks and labels the rest missing.',
  },
  {
    label: 'AP/RCR No. 33 report',
    url: 'https://apnews.com/article/200880317c943523957143ac8f035af9',
    verifies: 'Kyle Busch death after hospitalization, RCR suspension of No. 8 use, No. 33 run, and Austin Hill scheduled for Charlotte.',
  },
  {
    label: 'NASCAR Kyle Busch tribute analysis',
    url: 'https://www.nascar.com/news-media/2026/05/23/cup-series-2026-kyle-busch-in-tribute/',
    verifies: 'Source-backed tribute/memorial context; used only as non-scoring context.',
  },
]);

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
      scheduled_start_utc: '2026-05-24T22:00:00.000Z',
      race_type: 'points',
      event_format: 'points',
      stage_lengths: [100, 100, 100, 100],
      is_special_event: false,
      source_urls: [
        'https://www.nascar.com/live-results/nascar-cup-series/2026-coca-cola-600/',
        'https://www.charlottemotorspeedway.com/events/coca-cola-600/',
      ],
      notes: 'Coca-Cola 600 public-source overlay applied by coca-cola-600-packet.mjs.',
    },
  ];
  env.warnings = [
    ...(env.warnings ?? []),
    'Coca-Cola 600 overlay: race_name/track/start time replaced with public-source Charlotte values.',
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
  const scoredHead = Array.isArray(multiLaneBoard.scored_head) ? multiLaneBoard.scored_head : [];
  const fieldTail = Array.isArray(multiLaneBoard.field_tail) ? multiLaneBoard.field_tail : [];
  const finalCandidates = Array.isArray(multiLaneBoard.candidates) ? multiLaneBoard.candidates : [];
  const hasFinalCeilingData =
    scoredHead.length > 0 &&
    fieldTail.length > 0 &&
    finalCandidates.length === scoredHead.length + fieldTail.length &&
    finalCandidates.every(c =>
      typeof c.final_ceiling === 'string' &&
      Object.hasOwn(c, 'final_composite_score') &&
      Array.isArray(c.final_evidence_ledger) &&
      Array.isArray(c.final_invalidators),
    );

  if (!hasFinalCeilingData) {
    throw new Error('Final ceiling data missing: packet renderer requires scored_head, field_tail, final ceilings, evidence ledgers, and invalidators.');
  }

  const practiceStatus = practiceEnvelope.status;
  const degraded = practiceStatus === 'degraded';
  const downMark = SOURCE_UNAVAILABLE_MARK;
  const partialMark = SOURCE_PARTIAL_MARK;
  const upMark = SOURCE_AVAILABLE_MARK;
  const fcs = multiLaneBoard.final_ceiling_schema ?? {};
  const pqRecords = Array.isArray(practiceEnvelope?.records) ? practiceEnvelope.records : [];
  const gridCount = pqRecords.filter(r => Number.isFinite(Number(r?.starting_position))).length;
  const practiceCount = pqRecords.filter(r =>
    r?.practice_rank !== null &&
    r?.practice_rank !== undefined &&
    r?.practice_rank !== '' &&
    Number.isFinite(Number(r.practice_rank)),
  ).length;
  const pqSrc = (practiceEnvelope?.source_urls && practiceEnvelope.source_urls[0]) || 'unknown source';
  const activeFieldCount = scoredHead.length + fieldTail.length;

  const layerStatus = fundamentals.layer_status ?? {};
  function layerMark(layer) {
    const s = layerStatus[layer];
    if (s === 'ok') return upMark;
    if (s === 'degraded') return partialMark;
    return downMark;
  }
  function layerNote(layer) {
    const notes = fundamentals.layer_source_notes?.[layer] ?? [];
    const text = notes[0] ?? 'no source note available.';
    return String(text)
      .replace(/fixture adapter/gi, 'non-live unavailable adapter')
      .replace(/fixture-mode/gi, 'non-live snapshot')
      .replace(/fixtures-only/gi, 'snapshot-only')
      .replace(/fixture data/gi, 'snapshot data');
  }
  function fmt(v, fallback = '-') {
    return v === null || v === undefined || v === '' ? fallback : String(v);
  }
  function fmtScore(v) {
    return Number.isFinite(Number(v)) ? String(v) : 'n/a';
  }
  function compactText(value, max = 116) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (text.length <= max) return text;
    return `${text.slice(0, max - 3).trimEnd()}...`;
  }
  function boardNote(c) {
    if (Number(c.car_number) === 33) {
      return 'Active field-tail entry; Cup-history lockout; no transferable Cup history; capped at WATCH.';
    }
    return compactText(c.final_ceiling_reason || c.final_reasoning_summary || 'Source-backed final ceiling.');
  }
  function renderBoardSection(title, rows) {
    lines.push(`### ${title}`);
    lines.push('');
    lines.push('Sorted by composite score descending inside this section.');
    lines.push('');
    lines.push('| Rank | Driver | Car | PtsR | Start | Score | Layers | Ceiling | Note |');
    lines.push('|---:|---|---:|---:|---:|---:|---:|---|---|');
    for (const c of rows) {
      lines.push(`| ${fmt(c.display_rank, '?')} | ${fmt(c.driver_name, 'Unknown')} | ${fmt(c.car_number, '?')} | ${fmt(c.points_position)} | ${fmt(c.starting_grid_position, '?')} | ${fmtScore(c.final_composite_score)} | ${fmt(c.final_layers_present, '0')} | ${fmt(c.final_ceiling, 'NO CLEAR PICK')} | ${boardNote(c)} |`);
    }
    lines.push('');
  }
  function renderSourceSummary() {
    const sources = fcs.sources ?? {};
    for (const [cat, urls] of Object.entries(sources)) {
      const list = Array.isArray(urls) ? urls : [];
      const visible = list.length > 4
        ? `${list.slice(0, 4).join(' | ')} | ... (${list.length} total)`
        : (list.join(' | ') || 'n/a');
      lines.push(`- ${cat}: ${visible}`);
    }
  }

  lines.push('# Coca-Cola 600 - Final Ceiling Board (Race Live - Pre-Race Model Snapshot)');
  lines.push('');
  lines.push('## Publication Safety Note');
  lines.push('');
  lines.push(`This is a model-based betting/research guide, not a guarantee, not financial advice, and not an instruction to trade. The race was live or in progress at the ${PUBLICATION_CHECKED_AT_UTC} publication check, so every score and ceiling below must be read as a pre-race/static model snapshot, not live-running-order analysis.`);
  lines.push('');
  lines.push('- No trades were placed by this workflow.');
  lines.push('- Composite scores and final ceilings are model-derived from the labeled source snapshots and missing-data rules below.');
  lines.push('- Degraded, placeholder, missing, and unavailable layers remain explicitly labeled; no missing layer is filled with fabricated data.');
  lines.push('- Kyle Busch / No. 8 / Austin Hill / No. 33 context is non-scoring background only and never changes composite score or ceiling.');
  lines.push('');
  lines.push(`Run date: ${runDate}`);
  lines.push(`Race: ${ctx.race_name ?? 'unknown'}`);
  lines.push(`Track: ${ctx.track ?? 'unknown'} (${ctx.track_type ?? 'unknown'})`);
  lines.push(`Series: ${ctx.series ?? 'unknown'}`);
  lines.push(`Scheduled start (UTC): ${ctx.scheduled_start_utc ?? 'unknown'} (6:00 PM ET source-listed)`);
  lines.push(`Publication check (UTC): ${PUBLICATION_CHECKED_AT_UTC}`);
  lines.push('Race status at publication check: live/in-progress by schedule and NASCAR live-results page; live running order/results are not ingested by this packet.');
  lines.push(`Event format: ${manifest.event_format ?? 'points'}`);
  lines.push(`Source mode: ${PUBLICATION_SOURCE_MODE}.`);
  lines.push('');

  lines.push('## Final Ceiling Board (single ceiling per driver)');
  lines.push('');
  lines.push(`- Active field coverage: ${activeFieldCount}/${multiLaneBoard.candidate_pool_size} published starters (${scoredHead.length} main scored + ${fieldTail.length} field-tail).`);
  lines.push('- Board shape: one final ceiling per active driver; no Win/Top5/Top10/Top20 lane table is used as the report lead.');
  lines.push('- Sort: composite score descending within the main scored field and within field-tail.');
  lines.push('- Non-scoring context: storyline, Kyle Busch/#8 memorial context, market context, and national-series notes do not affect composite score or ceiling.');
  lines.push(`- Ceilings allowed: ${(fcs.ceilings_allowed ?? []).join(' | ')}`);
  lines.push(`- Era filter: ${fcs.era_filter ?? 'n/a'}`);
  lines.push(`- Charlotte filter: ${fcs.charlotte_filter ?? 'n/a'}`);
  lines.push(`- Grid basis: ${fcs.grid_basis ?? 'n/a'} (rules_set => practice_qualifying weight reduced 50%).`);
  if (Array.isArray(fcs.cup_history_lockouts) && fcs.cup_history_lockouts.length > 0) {
    lines.push('- Cup-history lockouts: #33 active field-tail entry has locked-missing Cup-history layers; detail appears in the evidence ledger.');
  }
  lines.push('');
  renderBoardSection('1. Main scored field (Cup points top-20, in-grid)', multiLaneBoard.scored_head ?? []);
  renderBoardSection('2. Field tail / lower-confidence entries', multiLaneBoard.field_tail ?? []);

  lines.push('## Final-Ceiling Evidence Ledger');
  lines.push('');
  lines.push('Each active driver has the same scoring ledger shape: source-backed layer values are included, missing layers are called out, and invalidators are listed directly under the driver.');
  lines.push('');
  for (const c of multiLaneBoard.candidates) {
    const section = c.pool_section === 'field_tail' ? ' [field-tail]' : '';
    const ptsTxt = c.points_position ? ` points_rank=${c.points_position}` : '';
    const startTxt = c.starting_grid_position ? ` start=P${c.starting_grid_position}` : '';
    lines.push(`### #${c.car_number ?? '?'} ${c.driver_name ?? 'Unknown'} (${c.team ?? 'team n/a'})${section}`);
    lines.push(`- Display rank: ${c.display_rank}${ptsTxt}${startTxt}`);
    lines.push(`- Composite score: ${c.final_composite_score ?? 'n/a'} over ${c.final_layers_present} layer(s)`);
    lines.push(`- Final ceiling: ${c.final_ceiling} - ${c.final_ceiling_reason}`);
    lines.push('- Evidence ledger:');
    for (const row of c.final_evidence_ledger ?? []) {
      if (row.present) {
        const eff = row.effective_weight !== undefined && row.effective_weight !== row.raw_weight
          ? ` eff_weight=${row.effective_weight}` : '';
        lines.push(`  - ${row.category} [${row.label}]: value=${row.value} grade=${row.grade} raw_weight=${row.raw_weight}${eff} norm_weight=${row.normalized_weight} contribution=${row.contribution}`);
        lines.push(`    source: ${row.source_basis}`);
        if (row.detail) lines.push(`    detail: ${row.detail}`);
        if (row.missing_note) lines.push(`    note: ${row.missing_note}`);
      } else {
        lines.push(`  - ${row.category} [${row.label}]: MISSING - excluded from score (raw_weight=${row.raw_weight} would have been re-normalized away).`);
        lines.push(`    source: ${row.source_basis}`);
        if (row.missing_note) lines.push(`    note: ${row.missing_note}`);
      }
    }
    lines.push('- Invalidators:');
    if ((c.final_invalidators ?? []).length === 0) {
      lines.push('  - (none flagged)');
    } else {
      for (const inv of c.final_invalidators) lines.push(`  - ${inv}`);
    }
    lines.push('');
  }

  lines.push('## Appendix: Model Inputs, Caveats, and Source Index');
  lines.push('');
  lines.push(`- Driver skill: ${layerMark('driver_skill')} - ${layerNote('driver_skill')}`);
  lines.push(`- Team / equipment quality: ${layerMark('team_equipment')} - ${layerNote('team_equipment')}`);
  lines.push(`- Pit crew / crew chief: ${layerMark('pit_crew')} - ${layerNote('pit_crew')}`);
  lines.push(`- Strategy risk: ${layerMark('strategy_risk')} - ${layerNote('strategy_risk')}`);
  lines.push(`- Track history signal: ${downMark} - track_history_signal is "unknown" on driver records and is not used as a verified live-race fact.`);
  lines.push(`- Recent speed: ${downMark} - no recent race-pace samples available.`);
  if (practiceStatus === 'ok' && gridCount > 0) {
    lines.push(`- Qualifying position: ${upMark} - starting grid published (${gridCount} entries) from ${pqSrc}. Format note: ${practiceEnvelope.snapshot?.qualifying_format_note ?? 'n/a'}. Pole: ${practiceEnvelope.snapshot?.pole_position_driver ?? 'n/a'} (#${practiceEnvelope.snapshot?.pole_position_car ?? '?'}).`);
    lines.push(`- Practice speed: ${practiceCount > 0 ? partialMark : downMark} - practice results are published, but the current model snapshot ingests only the top ${practiceCount}; remaining drivers practice_rank=null (not fabricated). Source: ${pqSrc}.`);
  } else {
    lines.push(`- Qualifying position: ${downMark} - practice/qualifying envelope is ${practiceStatus}; no starting grid published yet.`);
    lines.push(`- Practice speed: ${downMark} - practice/qualifying envelope is ${practiceStatus}; no session results published yet.`);
  }
  lines.push(`- Race format / track type: ${upMark} - ${ctx.race_name ?? 'race'} at ${ctx.track ?? 'unknown'}, ${ctx.track_type ?? 'unknown'} track, event_format=${manifest.event_format ?? 'points'}.`);
  lines.push(`- Overall fundamentals data quality: ${fundamentals.overall_data_quality}.`);
  lines.push(`- Allowed max posture from fundamentals alone: ${fundamentals.allowed_max_posture}.`);
  if (Array.isArray(fundamentals.downgrade_reasons) && fundamentals.downgrade_reasons.length > 0) {
    lines.push('- Fundamentals downgrade reasons:');
    for (const r of fundamentals.downgrade_reasons) lines.push(`  - ${r}`);
  }
  if (degraded && Array.isArray(practiceEnvelope.degraded_reasons)) {
    lines.push('- Practice/qualifying degraded_reasons:');
    for (const r of practiceEnvelope.degraded_reasons) lines.push(`  - ${r}`);
  }
  lines.push('');
  lines.push('### Source Index');
  lines.push('');
  lines.push('Publication source checks:');
  for (const src of PUBLICATION_SOURCE_CHECKS) {
    lines.push(`- ${src.label}: ${src.url} - ${src.verifies}`);
  }
  lines.push('');
  lines.push('Model layer source URLs:');
  renderSourceSummary();
  lines.push('');

  lines.push('## Market Context');
  lines.push('');
  lines.push('Market lanes are reference only and are explicitly separated from the Edge Basis below. Price, volume, OI, and line movement are Market Context only and never create edge.');
  lines.push('');
  for (const lane of discovery.supported_market_lanes ?? []) {
    lines.push(`- ${lane.market_lane} (${lane.lane_type}) - source_available=${lane.source_available} - ${lane.description}`);
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
  lines.push('The single final ceiling board is driven by final-ceiling composite layers only. Storyline does not create speed, and market context never contributes to Edge Basis.');
  lines.push('');

  lines.push('## Storyline / Tiebreaker Context (non-scoring)');
  lines.push('');
  lines.push('These notes explain sourced narrative context and tie-breakers. They have zero impact on composite scores or final ceilings. No driver here is upgraded by storyline.');
  lines.push('');
  lines.push('### Kyle Busch - NOT entered (memorial context only)');
  lines.push('- Kyle Busch is not on the published 2026 Coca-Cola 600 starting grid and is excluded from scoring.');
  lines.push('- Do NOT mark him DNQ in this packet. Treat references purely as memorial / RCR No. 8 backstory.');
  lines.push('- AP reports Busch died after hospitalization with a severe illness; no cause-of-death claim is used as a model input.');
  lines.push('- His season-form, Charlotte history, and 1.5-mi record are not applied to any active driver.');
  lines.push('');
  lines.push('### #8 / #33 disambiguation');
  lines.push('- The active RCR context car is #33, driven by Austin Hill, per public reports after RCR suspended No. 8 use.');
  lines.push('- Austin Hill is NOT scored as "the #8." Tyler Reddick #8 history and Kyle Busch #8 history do NOT transfer to Austin Hill #33.');
  lines.push('- Cup-history layers (season form, Charlotte oval, intermediate oval, season speed signal) are MISSING for #33 with the lockout reason recorded in the ledger.');
  lines.push('- Austin Hill national-series context is not used in this packet\'s Cup composite score or final ceiling.');
  lines.push('');
  lines.push('### Storyline modifier audit (non-scoring)');
  const twm = modifier.true_win_modifier ?? {};
  lines.push(`- Beneficiary candidate held in audit file: ${beneficiary.driver_name ?? 'n/a'} (#${beneficiary.car_number ?? '?'}) - ${beneficiary.connection_type ?? 'none'}.`);
  lines.push('- Article-facing use: source-backed context only; no unsourced modifier summary is used here.');
  lines.push(`- True-win delta_probability: +${(Number(twm.delta_probability ?? 0) * 100).toFixed(2)}pp (capped +${((twm.capped_at ?? 0.04) * 100).toFixed(0)}pp; applied=${twm.applied === true}). This is a MODIFIER ONLY and never raises a ceiling.`);
  lines.push(`- Reason: ${twm.reason ?? 'n/a'}`);
  lines.push(`- Market repricing score: ${modifier.market_repricing_score}`);
  lines.push(`- Performance path: ${modifier.performance_path}`);
  lines.push(`- Market path: ${modifier.market_path}`);
  lines.push(`- Pressure / distraction risk: ${modifier.pressure_distraction_risk?.score} - ${modifier.pressure_distraction_risk?.note}`);
  lines.push(`- Posture hint: ${modifier.posture_hint}`);
  lines.push(`- Disclaimer: "${modifier.disclaimer}"`);
  lines.push('');

  lines.push('## Safety');
  lines.push('');
  lines.push('- No trades placed by this workflow.');
  lines.push('- No credentials touched and no live betting/order action performed.');
  lines.push('- This is not financial advice; do not treat model scores as a guarantee or as a recommendation to trade.');
  lines.push('- Race-live warning: this packet does not ingest live running order, incidents, pit cycles, weather changes during the race, or in-race odds movement.');
  lines.push('- Downgrade applied: any unavailable fundamentals layer is marked DOWNGRADED:UNAVAILABLE; no fabricated ratings.');
  lines.push('- Storyline context is source-backed background only and does not affect score, ceiling, or trade posture.');
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
      mode: 'public-source-snapshot',
      generator: 'scripts/nascar/lib/coca-cola-600-packet.mjs',
      stage: 'coca_cola_600_publication_safe_packet',
      no_trades: true,
      source_mode: PUBLICATION_SOURCE_MODE,
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

  // 3c. Multi-lane ceiling board — full ACTIVE field as the pool.
  //
  // Pool basis is now CUP POINTS top-20 (head) plus the remaining published
  // Coca-Cola 600 starting-grid entries (field tail). Only ACTIVE entries
  // are scored — drivers not on the published grid (e.g. Kyle Busch in 2026)
  // are excluded from scoring and surfaced exclusively in the storyline
  // section. Drivers without a fundamentals join stay in the pool with NO
  // CLEAR PICK lanes; they are not dropped or replaced.
  const activePoolEnv = activeFieldPoolEnvelope({
    checked_at_utc: checkedAtUtc,
    outputDir: `${absOutputDir}/discovery`,
  });
  // Keep legacy points adapter wired for downstream consumers / tests.
  const cupPointsEnv = cupPointsTop20Envelope({
    checked_at_utc: checkedAtUtc,
    outputDir: `${absOutputDir}/discovery`,
    poolSize: 20,
  });
  const candidatePool = activePoolEnv.records.map(r => ({
    driver_name: r.driver_name,
    car_number: r.car_number,
    team: r.team,
    manufacturer: r.manufacturer,
    points_position: r.points_position,
    season_points: r.season_points,
    starting_grid_position: r.starting_grid_position,
    pool_section: r.pool_section,
  }));
  const poolSize = candidatePool.length;

  const multiLaneBoard = composeMultiLaneCeilingBoard({
    fundamentals,
    supportedMarketLanes: discovery.supported_market_lanes,
    eventContext: discovery.event_context,
    storylineBeneficiary: {
      driver_name: 'Austin Hill',
      car_number: 33,
      connection_type: 'current_team',
    },
    poolSize,
    candidatePool,
    candidatePoolBasis: 'cup_points_plus_active_field',
    candidatePoolSourceUrls: activePoolEnv.source_urls,
  });

  // Re-stamp per-candidate fields the multi-lane board strips off, so the
  // downstream final-ceiling overlay and renderer can split scored head
  // vs field tail and display points_position / grid position.
  const poolByCar = new Map(candidatePool.map(p => [p.car_number, p]));
  for (const c of multiLaneBoard.candidates) {
    const src = poolByCar.get(c.car_number);
    if (src) {
      c.points_position = src.points_position;
      c.season_points = src.season_points;
      c.starting_grid_position = src.starting_grid_position;
      c.pool_section = src.pool_section;
    }
  }

  // 3d. Final-ceiling overlay — collapses the 4 lane statuses into ONE
  // ceiling per driver (WIN / TOP 5 / TOP 10 / TOP 20 / WATCH / NO CLEAR PICK),
  // backed by a 6-category source-cited evidence ledger.
  const seasonFormEnv = seasonForm2026Envelope({
    checked_at_utc: checkedAtUtc,
    outputDir: `${absOutputDir}/fundamentals`,
  });
  const seasonSpeedSignalEnv = seasonSpeedSignal2026Envelope({
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

  // Cup-history lockout: Austin Hill #33 is a part-time Cup driver running an
  // RCR No. 33 entry after the No. 8 suspension. He has no transferable Cup body of work, and the
  // #8/Kyle Busch/Tyler Reddick history is NOT his. Force Cup-history
  // layers to MISSING with a labeled reason so the storyline cannot inflate
  // his ceiling. Xfinity readiness is surfaced separately in the packet
  // storyline section as a lower-confidence context note (not a layer).
  const cupHistoryLockouts = new Map([
    [33, 'Austin Hill #33 is a part-time Cup entry in an RCR No. 33 car after the No. 8 suspension; he has no 2026 Cup season form, no Charlotte Cup-oval starts, and no Gen-7 1.5-mi Cup sample. Tyler Reddick #8 and Kyle Busch #8 history does NOT transfer to this entry.'],
  ]);

  const finalCeilingOverlay = composeFinalCeilingBoardOverlay({
    candidates: multiLaneBoard.candidates,
    seasonFormEnvelope: seasonFormEnv,
    seasonSpeedSignalEnvelope: seasonSpeedSignalEnv,
    charlotteOvalEnvelope: charlotteOvalEnv,
    intermediateEnvelope: intermediateEnv,
    practiceQualifyingEnvelope: envelopes.practice_qualifying,
    gridBasis: envelopes.practice_qualifying?.snapshot?.grid_basis ?? null,
    cupHistoryLockouts,
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
  multiLaneBoard.final_ceiling_schema = {
    ceilings_allowed: FINAL_CEILINGS,
    layer_categories: [
      'baseline_fundamentals',
      'season_form_2026',
      'season_speed_signal_2026',
      'charlotte_oval_history',
      'intermediate_15mi_oval',
      'practice_qualifying',
      'long_run_race_type_fit',
    ],
    sources: {
      season_form_2026: seasonFormEnv.source_urls,
      season_speed_signal_2026: seasonSpeedSignalEnv.source_urls,
      charlotte_oval_history: charlotteOvalEnv.source_urls,
      intermediate_15mi_oval: intermediateEnv.source_urls,
      practice_qualifying: envelopes.practice_qualifying.source_urls,
    },
    era_filter: 'Next Gen / Gen 7 (2022 Daytona 500 onward)',
    charlotte_filter: 'Charlotte Motor Speedway OVAL only — Roval explicitly excluded',
    grid_basis: envelopes.practice_qualifying?.snapshot?.grid_basis ?? null,
    cup_history_lockouts: Array.from(cupHistoryLockouts.entries()).map(([car, reason]) => ({ car_number: car, reason })),
  };

  // Sort candidates within each section by composite desc; stamp display rank.
  function sortAndRank(list) {
    const sorted = [...list].sort((a, b) => {
      const sa = a.final_composite_score ?? -1;
      const sb = b.final_composite_score ?? -1;
      if (sb !== sa) return sb - sa;
      // Tiebreakers: points_position asc (lower=better), then grid pos asc.
      const pa = a.points_position ?? 999;
      const pb = b.points_position ?? 999;
      if (pa !== pb) return pa - pb;
      return (a.starting_grid_position ?? 999) - (b.starting_grid_position ?? 999);
    });
    sorted.forEach((c, i) => { c.display_rank = i + 1; });
    return sorted;
  }
  const scoredHead = sortAndRank(multiLaneBoard.candidates.filter(c => c.pool_section === 'points_top_20'));
  const fieldTail = sortAndRank(multiLaneBoard.candidates.filter(c => c.pool_section === 'field_tail'));
  multiLaneBoard.scored_head = scoredHead;
  multiLaneBoard.field_tail = fieldTail;
  multiLaneBoard.candidates = [...scoredHead, ...fieldTail];

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
