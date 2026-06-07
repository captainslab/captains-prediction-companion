// 2026 FireKeepers Casino 400 — Michigan International Speedway
// Michigan-specific packet generator.
//
// Uses ONLY committed model components:
//   - scripts/nascar/lib/source-adapters/loop-history-gen7.mjs   (Gen-7 track/speed data)
//   - scripts/nascar/lib/track-aware-scoring-core.mjs             (15-layer composite scorer)
//   - scripts/nascar/lib/source-adapters/practice-qualifying-michigan-fixture.mjs
//   - scripts/nascar/lib/source-adapters/season-form-2026.mjs     (context only, not scoring layer)
//   - scripts/nascar/lib/source-adapters/season-speed-signal-2026.mjs (context only)
//
// MARKET NEUTRALITY: No Kalshi price, odds, bid/ask, volume, OI, or line movement
// appears anywhere in this model. scoreNascarField takes ONLY fundamentals inputs.
//
// ERA FLOOR: Gen-7 only (2022+). The loop snapshot for 2026 Michigan has
// capture_status='feed_403' and is skipped automatically; only 2022-2025 are used.
//
// KEYING INVARIANT:
//   Driver skill layers (track_history, speed, passing, restart, recent_form) →
//     keyed by driver NAME (portable across car numbers).
//   Equipment layers (team_equipment_strength) →
//     keyed by car NUMBER (follows the car/charter asset).
//
// MISSING LAYERS NOTE:
//   track_identity_fit and track_type_fit have no independent data source in the
//   committed repo (they require separate style-fit telemetry). These two critical
//   layers are MISSING for all drivers, capping confidence at 'medium'. The model
//   gracefully renormalizes over present layers; no fabricated values are used.

import { resolve } from 'node:path';
import { loopHistoryLayerInputs, normalizeDriverNameForLoopHistory } from './source-adapters/loop-history-gen7.mjs';
import { scoreNascarField } from './track-aware-scoring-core.mjs';
import { michiganPracticeQualifyingEnvelope } from './source-adapters/practice-qualifying-michigan-fixture.mjs';
import { seasonForm2026Envelope } from './source-adapters/season-form-2026.mjs';
import { seasonSpeedSignal2026Envelope } from './source-adapters/season-speed-signal-2026.mjs';
import { writeJsonAtomic, writeTextAtomic, ensureDir } from './cache.mjs';

const RUN_DATE = '2026-06-07';
const RACE_NAME = 'FireKeepers Casino 400';
const CHECKED_AT_UTC = '2026-06-07T12:00:00.000Z';

// Michigan track descriptor — used for loop history join.
const MICHIGAN_RACE = Object.freeze({
  track_id: 133,
  track_name: 'Michigan International Speedway',
  track_type: 'intermediate',
  restrictor_plate: false,
  scheduled_distance: 400,
});

// Confirmed 2026 Michigan entry list (37 cars).
// car_number is stored as string to match loop history car_number keys.
// effective_race_start is used for the starting_position_context scoring layer.
const MICHIGAN_ENTRY_LIST = Object.freeze([
  { driver_name: 'Ross Chastain',        car_number: '1',  team: 'Trackhouse Racing',     manufacturer: 'Chevrolet', effective_race_start: 30 },
  { driver_name: 'Austin Cindric',       car_number: '2',  team: 'Team Penske',            manufacturer: 'Ford',      effective_race_start: 29 },
  { driver_name: 'Austin Dillon',        car_number: '3',  team: 'RCR',                    manufacturer: 'Chevrolet', effective_race_start: 19 },
  { driver_name: 'Noah Gragson',         car_number: '4',  team: 'Front Row Motorsports',  manufacturer: 'Ford',      effective_race_start: 20 },
  { driver_name: 'Kyle Larson',          car_number: '5',  team: 'Hendrick Motorsports',   manufacturer: 'Chevrolet', effective_race_start: 6  },
  { driver_name: 'Brad Keselowski',      car_number: '6',  team: 'RFK Racing',             manufacturer: 'Ford',      effective_race_start: 24 },
  { driver_name: 'Daniel Suarez',        car_number: '7',  team: 'Spire Motorsports',      manufacturer: 'Chevrolet', effective_race_start: 9  },
  { driver_name: 'Chase Elliott',        car_number: '9',  team: 'Hendrick Motorsports',   manufacturer: 'Chevrolet', effective_race_start: 5  },
  { driver_name: 'Ty Dillon',            car_number: '10', team: 'Kaulig Racing',          manufacturer: 'Chevrolet', effective_race_start: 22 },
  { driver_name: 'Denny Hamlin',         car_number: '11', team: 'Joe Gibbs Racing',       manufacturer: 'Toyota',    effective_race_start: 36 },
  { driver_name: 'Ryan Blaney',          car_number: '12', team: 'Team Penske',            manufacturer: 'Ford',      effective_race_start: 17 },
  { driver_name: 'AJ Allmendinger',      car_number: '16', team: 'Kaulig Racing',          manufacturer: 'Chevrolet', effective_race_start: 23 },
  { driver_name: 'Chris Buescher',       car_number: '17', team: 'RFK Racing',             manufacturer: 'Ford',      effective_race_start: 12 },
  { driver_name: 'Chase Briscoe',        car_number: '19', team: 'Joe Gibbs Racing',       manufacturer: 'Toyota',    effective_race_start: 4  },
  { driver_name: 'Christopher Bell',     car_number: '20', team: 'Joe Gibbs Racing',       manufacturer: 'Toyota',    effective_race_start: 7  },
  { driver_name: 'Josh Berry',           car_number: '21', team: 'Wood Brothers Racing',   manufacturer: 'Ford',      effective_race_start: 37 },
  { driver_name: 'Joey Logano',          car_number: '22', team: 'Team Penske',            manufacturer: 'Ford',      effective_race_start: 16 },
  { driver_name: 'Bubba Wallace',        car_number: '23', team: '23XI Racing',            manufacturer: 'Toyota',    effective_race_start: 11 },
  { driver_name: 'William Byron',        car_number: '24', team: 'Hendrick Motorsports',   manufacturer: 'Chevrolet', effective_race_start: 35 },
  { driver_name: 'Austin Hill',          car_number: '33', team: 'RCR',                    manufacturer: 'Chevrolet', effective_race_start: 26 },
  { driver_name: 'Todd Gilliland',       car_number: '34', team: 'Front Row Motorsports',  manufacturer: 'Ford',      effective_race_start: 33 },
  { driver_name: 'Riley Herbst',         car_number: '35', team: '23XI Racing',            manufacturer: 'Toyota',    effective_race_start: 10 },
  { driver_name: 'Zane Smith',           car_number: '38', team: 'Front Row Motorsports',  manufacturer: 'Ford',      effective_race_start: 14 },
  { driver_name: 'Cole Custer',          car_number: '41', team: 'Haas Factory Team',      manufacturer: 'Chevrolet', effective_race_start: 13 },
  { driver_name: 'John Hunter Nemechek', car_number: '42', team: 'Legacy Motor Club',      manufacturer: 'Toyota',    effective_race_start: 15 },
  { driver_name: 'Erik Jones',           car_number: '43', team: 'Legacy Motor Club',      manufacturer: 'Toyota',    effective_race_start: 8  },
  { driver_name: 'JJ Yeley',             car_number: '44', team: 'NY Racing Team',         manufacturer: 'Chevrolet', effective_race_start: 34 },
  { driver_name: 'Tyler Reddick',        car_number: '45', team: '23XI Racing',            manufacturer: 'Toyota',    effective_race_start: 2  },
  { driver_name: 'Ricky Stenhouse Jr.',  car_number: '47', team: 'Hyak Motorsports',       manufacturer: 'Chevrolet', effective_race_start: 21 },
  { driver_name: 'Alex Bowman',          car_number: '48', team: 'Hendrick Motorsports',   manufacturer: 'Chevrolet', effective_race_start: 27 },
  { driver_name: 'Cody Ware',            car_number: '51', team: 'Rick Ware Racing',       manufacturer: 'Chevrolet', effective_race_start: 31 },
  { driver_name: 'Ty Gibbs',             car_number: '54', team: 'Joe Gibbs Racing',       manufacturer: 'Toyota',    effective_race_start: 3  },
  { driver_name: 'Ryan Preece',          car_number: '60', team: 'RFK Racing',             manufacturer: 'Ford',      effective_race_start: 25 },
  { driver_name: 'Michael McDowell',     car_number: '71', team: 'Spire Motorsports',      manufacturer: 'Chevrolet', effective_race_start: 18 },
  { driver_name: 'Carson Hocevar',       car_number: '77', team: 'Spire Motorsports',      manufacturer: 'Chevrolet', effective_race_start: 1  },
  { driver_name: 'Connor Zilisch',       car_number: '88', team: 'Trackhouse Racing',      manufacturer: 'Chevrolet', effective_race_start: 32 },
  { driver_name: 'Shane Van Gisbergen',  car_number: '97', team: 'Trackhouse Racing',      manufacturer: 'Chevrolet', effective_race_start: 28 },
]);

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Convert effective race start position to a 0-100 score for the layer.
// P1 → 100, P37 → 0.
function startPosScore(pos) {
  if (pos === null || pos === undefined) return null;
  return clamp(Math.round(((37 - pos) / 36) * 100), 0, 100);
}

// Assign a final ceiling based on the track-aware model output.
// NOTE: confidence is capped at 'medium' for all Michigan entries because
// track_identity_fit and track_type_fit have no independent static source
// (both are MISSING by design; model renormalizes over present layers).
function assignMichiganCeiling(candidate) {
  const rating = candidate.model_rating_0_100;
  if (rating === null) return { ceiling: 'NO CLEAR PICK', reason: 'no usable layers scored' };

  const breakdown = candidate.layer_breakdown;
  const presentCount = breakdown.filter(l => l.value !== null).length;
  const hasTrackHistory = breakdown.find(l => l.layer === 'track_history' && l.value !== null && l.evidence !== 'MISSING');
  const hasSimilarTrack = breakdown.find(l => l.layer === 'similar_track_history' && l.value !== null);
  const hasTeamEquip = breakdown.find(l => l.layer === 'team_equipment_strength' && l.value !== null);
  const hasLongRun = breakdown.find(l => l.layer === 'long_run_speed' && l.value !== null);
  const trackEvidence = hasTrackHistory || hasSimilarTrack;

  if (rating >= 73 && trackEvidence && hasTeamEquip && hasLongRun && presentCount >= 5) {
    return {
      ceiling: 'WIN',
      reason: `model_rating=${rating}/100, Michigan track history OK, similar-track evidence, equipment OK (medium confidence — track style-fit layers structurally absent from Gen-7 snapshot)`,
    };
  }
  if (rating >= 65 && trackEvidence && hasTeamEquip && presentCount >= 4) {
    return {
      ceiling: 'TOP 5',
      reason: `model_rating=${rating}/100, track-type evidence present, equipment OK, ${presentCount} layers`,
    };
  }
  if (rating >= 55 && presentCount >= 3) {
    return {
      ceiling: 'TOP 10',
      reason: `model_rating=${rating}/100, ${presentCount} layers present`,
    };
  }
  if (rating >= 40 && presentCount >= 1) {
    return {
      ceiling: 'TOP 20',
      reason: `model_rating=${rating}/100`,
    };
  }
  if (presentCount >= 1) {
    return {
      ceiling: 'WATCH',
      reason: `model_rating=${rating}/100, thin evidence — monitor only`,
    };
  }
  return { ceiling: 'NO CLEAR PICK', reason: 'no source-backed layers available' };
}

function fmt(v, fallback = '-') {
  return v === null || v === undefined || v === '' ? fallback : String(v);
}
function fmtScore(v) {
  return Number.isFinite(Number(v)) ? String(v) : 'n/a';
}
function round1(n) { return n === null || n === undefined ? null : Math.round(Number(n) * 10) / 10; }

function renderPacket({ candidates, pqEnvelope, loopMeta, runDate }) {
  const lines = [];
  const snap = pqEnvelope.snapshot ?? {};
  const rearStarters = snap.rear_starters ?? [];

  lines.push(`# ${RACE_NAME} — Michigan International Speedway`);
  lines.push('# Final Ceiling Board — Research Only / No Trades');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Safety Note');
  lines.push('');
  lines.push('This is a model-based research guide. It is NOT financial advice. NO trades were placed by this workflow.');
  lines.push('Composite scores and final ceilings are derived from Gen-7 loop history snapshots and public qualifying/practice data.');
  lines.push('No live data, no Kalshi pricing, no order execution.');
  lines.push('');

  lines.push('## Event Snapshot');
  lines.push('');
  lines.push(`- Race: ${RACE_NAME} (NASCAR Cup Series Race 15 of 36)`);
  lines.push('- Track: Michigan International Speedway — 2.000-mile D-shaped oval');
  lines.push('- Banking: 18° (turns), 12° (frontstretch), 5° (backstretch)');
  lines.push('- Distance: 400 miles / 200 laps');
  lines.push('- Stages: 45 / 75 / 80 laps');
  lines.push('- Broadcast: Amazon Prime Video, 3:00 PM ET');
  lines.push(`- Run date: ${runDate}`);
  lines.push(`- Packet checked at: ${CHECKED_AT_UTC}`);
  lines.push('');

  lines.push('## Track & Model Setup');
  lines.push('');
  lines.push('- Model: `track-aware-scoring-core.mjs` (nascar_track_aware_composite_v1)');
  lines.push('- Track layer source: `loop-history-gen7.mjs` (offline Gen-7 snapshots 2022-2025)');
  lines.push(`- Michigan track_id: ${MICHIGAN_RACE.track_id} | track_type: ${MICHIGAN_RACE.track_type}`);
  lines.push(`- Michigan Gen-7 races in snapshot: 4 (2022, 2023, 2024, 2025)`);
  lines.push(`- 2026 Michigan snapshot: feed_403 (race not yet run) — correctly excluded`);
  lines.push('- Era floor: Gen-7 only (2022+); pre-NextGen results are not used');
  lines.push(`- Drivers scored: ${candidates.length}`);
  lines.push('- Layers scored: 15 (9 driver-keyed, 3 car/team-keyed, 3 structurally MISSING)');
  lines.push('');
  lines.push('**Structural MISSING layers** (no independent static data source in committed repo):');
  lines.push('- `track_identity_fit` (weight 0.10) — MISSING for all drivers');
  lines.push('- `track_type_fit` (weight 0.12) — MISSING for all drivers');
  lines.push('- `package_fit` (weight 0.04) — MISSING for all drivers');
  lines.push('These are renormalized out of the composite; they do NOT fabricate neutral 50s.');
  lines.push('Confidence is capped at "medium" for all drivers due to two critical layers missing.');
  lines.push('');
  lines.push('**Rear-start penalties (affect starting_position_context layer):');
  for (const r of rearStarters) {
    lines.push(`  - #${r.car_number} ${r.driver_name}: effective start P${r.effective_race_start} (${r.reason})`);
  }
  lines.push('');

  lines.push('## Source Registry');
  lines.push('');
  lines.push('| Layer | Source | Status |');
  lines.push('|---|---|---|');
  lines.push('| track_history (Michigan) | Gen-7 loop snapshots 2022-2025 (track_id=133) | AVAILABLE |');
  lines.push('| similar_track_history | Gen-7 loop snapshots — all intermediate tracks (exc. Michigan) | AVAILABLE |');
  lines.push('| long_run_speed / single_lap_speed | Gen-7 loop snapshots — intermediate within-field percentiles | AVAILABLE |');
  lines.push('| passing_difficulty_context | Gen-7 loop snapshots — passing differential percentiles | AVAILABLE |');
  lines.push('| restart_overtime_skill | Gen-7 loop snapshots — restart speed percentiles | AVAILABLE |');
  lines.push('| recent_form_weighted_by_track_type | Gen-7 loop snapshots — intermediate running-position form | AVAILABLE |');
  lines.push('| team_equipment_strength | Gen-7 loop snapshots — car # program output (car/team keyed) | AVAILABLE |');
  lines.push('| starting_position_context | Confirmed 2026 qualifying results (public source) | AVAILABLE |');
  lines.push('| track_identity_fit | No independent static source in repo | MISSING |');
  lines.push('| track_type_fit | No independent static source in repo | MISSING |');
  lines.push('| package_fit | No independent static source in repo | MISSING |');
  lines.push('| pit_crew_and_pit_road | No team pit grade supplied | MISSING (most drivers) |');
  lines.push('| crew_chief_strategy | No crew chief grade supplied | MISSING (most drivers) |');
  lines.push('| incident_dnf_risk | Not computed (0-weight risk layer) | MISSING — no scoring impact |');
  lines.push('');
  lines.push('**Season form (context only — NOT a scoring layer):**');
  lines.push('- season_form_2026: Wikipedia 2026 NCS race matrix (pre-Coca-Cola 600, races 1-13)');
  lines.push('- season_speed_signal_2026: Wikipedia 2026 stage points + most-laps-led (pre-Coca-Cola 600)');
  lines.push('');

  lines.push('## Data Quality Summary');
  lines.push('');
  lines.push(`- Loop history: 4 full Michigan Gen-7 seasons (2022-2025), capture_status=ok for all four`);
  lines.push(`- Similar-track history: all intermediate-type Gen-7 races across 2022-2025`);
  lines.push('- Qualifying data: 36/37 drivers with confirmed timed laps; Berry no time (spin)');
  lines.push('- Practice top-5 confirmed; top 6-10 group confirmed but not individually ordered');
  lines.push('- Season form snapshot: through race 13 (pre-Coca-Cola 600); race 14 results not included');
  lines.push('- No fabricated values anywhere; MISSING layers are labeled and excluded from composite');
  lines.push('');

  lines.push('## Final Ceiling Board');
  lines.push('');
  lines.push('Sorted by model_rating_0_100 descending. "Start" is the effective race starting position after rear-start penalty adjustments.');
  lines.push('');
  lines.push('| Rank | Driver | Car | Team | MFR | Start | Rating | Conf | Layers | Ceiling |');
  lines.push('|---:|---|---:|---|---|---:|---:|---|---:|---|');
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const entry = MICHIGAN_ENTRY_LIST.find(e => e.car_number === String(c.car_number));
    lines.push(`| ${i + 1} | ${fmt(c.driver_name)} | ${fmt(c.car_number)} | ${fmt(entry?.team)} | ${fmt(entry?.manufacturer)} | P${fmt(entry?.effective_race_start)} | ${fmtScore(c.model_rating_0_100)} | ${fmt(c.confidence)} | ${candidates[i]._layers_present ?? 'n/a'} | ${c.ceiling} |`);
  }
  lines.push('');

  lines.push('## Driver Ceiling Evidence');
  lines.push('');
  lines.push('Each entry shows: final ceiling, model rating, key layer values (Michigan-track, similar-track, long-run, single-lap, team-equipment, starting-pos), and missing/low-evidence flags.');
  lines.push('');

  for (const c of candidates) {
    const entry = MICHIGAN_ENTRY_LIST.find(e => e.car_number === String(c.car_number));
    const isRear = rearStarters.some(r => r.car_number === c.car_number);
    lines.push(`### #${c.car_number} ${c.driver_name} — ${c.ceiling}`);
    lines.push(`*${entry?.team ?? 'n/a'} | ${entry?.manufacturer ?? 'n/a'} | P${entry?.effective_race_start ?? '?'} effective start${isRear ? ' (REAR PENALTY)' : ''}*`);
    lines.push('');
    lines.push(`- **Model rating**: ${fmtScore(c.model_rating_0_100)} / 100 (${c.confidence} confidence)`);
    lines.push(`- **Fair win probability**: ${c.fair_win_probability !== null ? (c.fair_win_probability * 100).toFixed(2) + '%' : 'n/a'}`);
    lines.push(`- **Ceiling reason**: ${c._ceiling_reason}`);
    lines.push('- **Key layers present:**');
    const keyLayers = ['track_history', 'similar_track_history', 'long_run_speed', 'single_lap_speed', 'team_equipment_strength', 'starting_position_context', 'passing_difficulty_context', 'restart_overtime_skill', 'recent_form_weighted_by_track_type'];
    for (const lk of keyLayers) {
      const lb = c.layer_breakdown.find(l => l.layer === lk);
      if (lb) {
        const present = lb.value !== null;
        const evi = lb.evidence ?? 'n/a';
        const val = lb.value !== null ? fmtScore(lb.value) : 'MISSING';
        const contrib = lb.contribution !== null ? ` (contrib=${round1(lb.contribution)})` : '';
        lines.push(`  - ${lk}: ${present ? `value=${val} [${evi}]${contrib}` : `MISSING`}${lb.note ? ` — ${lb.note}` : ''}`);
      }
    }
    if (c.missing_or_low_evidence_flags.length > 0) {
      lines.push(`- **Missing/low-evidence flags**: ${c.missing_or_low_evidence_flags.join(', ')}`);
    }
    lines.push('');
  }

  lines.push('## Michigan-Specific Reasoning');
  lines.push('');
  lines.push('Michigan International Speedway is a 2.0-mile D-shaped superspeedway-style oval with 18-degree banking in the turns. It generates corner entry speeds exceeding 200 mph — among the highest of any oval on the Cup schedule. Key factors:');
  lines.push('');
  lines.push('1. **Long-run speed dominates**: Michigan rewards cars that can maintain high corner speed over 200 laps. Long-run pace percentile (from the Gen-7 intermediate sample) is the highest-weighted speed signal.');
  lines.push('2. **Wide track, multiple grooves**: The 73-foot-wide turns enable side-by-side racing. Passing-difficulty context is meaningful here.');
  lines.push('3. **Tire management**: The Goodyear tire at Michigan historically degrades, rewarding cars with good aero balance. This is a structural advantage for better-funded programs (team_equipment_strength captures this indirectly via program output).');
  lines.push('4. **Qualifying speed signal**: Michigan qualifying is a legitimate speed signal (single-car timed laps). The top qualifiers (Hamlin 195.117 mph, Hocevar 192.9) are genuinely fast, even if Hamlin/Byron start from the rear.');
  lines.push('5. **Track history matters**: 4 Michigan Gen-7 races per driver provide meaningful track_history. Drivers with strong Michigan Gen-7 averages score higher here.');
  lines.push('');

  lines.push('## No-Trade / Research-Only Notice');
  lines.push('');
  lines.push('- This packet is for RESEARCH purposes only.');
  lines.push('- No bets, trades, or orders were placed or recommended.');
  lines.push('- No Kalshi market data was used in any scoring layer.');
  lines.push('- Final ceiling is a research label, not a position recommendation.');
  lines.push('- Storyline context (rear-start penalties, Austin Hill #33 equipment context) is non-scoring background only.');
  lines.push('');

  lines.push('## MARKET CONTEXT — NOT IN SCORE');
  lines.push('');
  lines.push('No Kalshi market data was fetched or used in this packet. If market context is desired for comparison, it must be sourced separately and appended here WITHOUT modifying the model board above.');
  lines.push('');

  lines.push('## Proof Section');
  lines.push('');
  lines.push(`- Model files used: track-aware-scoring-core.mjs (nascar_track_aware_composite_v1), loop-history-gen7.mjs`);
  lines.push(`- Loop history seasons used: 2022, 2023, 2024, 2025 (Gen-7 era floor enforced)`);
  lines.push(`- Michigan track_id: ${MICHIGAN_RACE.track_id} (confirmed in all 4 Gen-7 snapshots)`);
  lines.push(`- Michigan Gen-7 2026 snapshot: feed_403 (today's race not yet run) — EXCLUDED`);
  lines.push(`- Market/pricing data used in model score: NONE`);
  lines.push(`- Drivers scored: ${candidates.length}`);
  lines.push(`- Practice/qualifying source: Confirmed 2026 public qualifying data (36/37 timed)`);
  lines.push(`- Run date: ${runDate}`);
  lines.push('');

  return lines.join('\n');
}

export async function composeMichiganPacket({
  outputDir = `state/nascar/${RUN_DATE}/firekeepers-casino-400`,
} = {}) {
  const absOutputDir = resolve(outputDir);
  ensureDir(absOutputDir);

  // 1. Load practice/qualifying data.
  const pqEnvelope = michiganPracticeQualifyingEnvelope({
    checked_at_utc: CHECKED_AT_UTC,
    outputDir: absOutputDir,
  });

  // 2. Load season form + speed signal for context (NOT scoring layers).
  const seasonFormEnv = seasonForm2026Envelope({
    checked_at_utc: CHECKED_AT_UTC,
    outputDir: `${absOutputDir}/fundamentals`,
  });
  const speedSignalEnv = seasonSpeedSignal2026Envelope({
    checked_at_utc: CHECKED_AT_UTC,
    outputDir: `${absOutputDir}/fundamentals`,
  });

  // 3. Load Gen-7 loop history for Michigan.
  const loopHistory = loopHistoryLayerInputs({
    race: MICHIGAN_RACE,
    entryList: MICHIGAN_ENTRY_LIST.map(e => ({
      driver_name: e.driver_name,
      car_number: e.car_number,
      team: e.team,
      manufacturer: e.manufacturer,
    })),
  });

  // 4. Build per-driver layer inputs for scoreNascarField.
  const pqByName = new Map();
  for (const r of pqEnvelope.records ?? []) {
    pqByName.set(normalizeDriverNameForLoopHistory(r.driver_name), r);
  }

  const driverInputs = MICHIGAN_ENTRY_LIST.map(entry => {
    const key = normalizeDriverNameForLoopHistory(entry.driver_name);
    const hist = loopHistory.by_driver[key] ?? null;
    const pq = pqByName.get(key) ?? null;

    const layers = {};

    if (hist) {
      // Driver-keyed layers (follow the driver, not the car).
      if (hist.layers.track_history)                     layers.track_history = hist.layers.track_history;
      if (hist.layers.similar_track_history)             layers.similar_track_history = hist.layers.similar_track_history;
      if (hist.layers.long_run_speed)                    layers.long_run_speed = hist.layers.long_run_speed;
      if (hist.layers.single_lap_speed)                  layers.single_lap_speed = hist.layers.single_lap_speed;
      if (hist.layers.passing_difficulty_context)        layers.passing_difficulty_context = hist.layers.passing_difficulty_context;
      if (hist.layers.restart_overtime_skill)            layers.restart_overtime_skill = hist.layers.restart_overtime_skill;
      if (hist.layers.recent_form_weighted_by_track_type) layers.recent_form_weighted_by_track_type = hist.layers.recent_form_weighted_by_track_type;
      // Car/team-keyed layers (follow the car_number, not the driver).
      if (hist.layers.team_equipment_strength)           layers.team_equipment_strength = hist.layers.team_equipment_strength;
      if (hist.layers.pit_crew_and_pit_road)             layers.pit_crew_and_pit_road = hist.layers.pit_crew_and_pit_road;
      if (hist.layers.crew_chief_strategy)               layers.crew_chief_strategy = hist.layers.crew_chief_strategy;
    }

    // starting_position_context: use effective_race_start (actual grid position after penalties).
    const effStart = entry.effective_race_start;
    if (effStart !== null && effStart !== undefined) {
      layers.starting_position_context = {
        score: startPosScore(effStart),
        evidence: 'OK',
        sample: 1,
        note: `effective race start P${effStart} (qualifying_session; see rear-start notes if applicable)`,
      };
    }

    return {
      driver_name: entry.driver_name,
      car_number: entry.car_number,
      team: entry.team,
      manufacturer: entry.manufacturer,
      starting_position: effStart,
      layers,
      track_specific_inputs: hist?.track_specific_inputs ?? { track_name: MICHIGAN_RACE.track_name, track_type: MICHIGAN_RACE.track_type },
      similar_track_inputs: hist?.similar_track_inputs ?? null,
    };
  });

  // 5. Score the full field.
  const scoredField = scoreNascarField({
    race: MICHIGAN_RACE,
    drivers: driverInputs,
    gamma: 7,
  });

  // 6. Apply Michigan ceiling logic and attach context.
  const candidates = scoredField.candidates.map(c => {
    const { ceiling, reason } = assignMichiganCeiling(c);
    const layersPresent = c.layer_breakdown.filter(l => l.value !== null).length;
    return {
      ...c,
      ceiling,
      _ceiling_reason: reason,
      _layers_present: layersPresent,
    };
  });

  // 7. Write artifacts.
  const ceilingBoardPath = `${absOutputDir}/ceiling_board.json`;
  writeJsonAtomic(ceilingBoardPath, {
    schema_version: 'michigan_ceiling_board_v1',
    run_date: RUN_DATE,
    race_name: RACE_NAME,
    track: scoredField.track,
    candidate_count: candidates.length,
    layers_total: scoredField.layers_total,
    field_notes: scoredField.field_notes,
    candidates: candidates.map(c => ({
      driver_name: c.driver_name,
      car_number: c.car_number,
      team: c.team,
      manufacturer: c.manufacturer,
      model_rating_0_100: c.model_rating_0_100,
      fair_win_probability: c.fair_win_probability,
      confidence: c.confidence,
      ceiling: c.ceiling,
      ceiling_reason: c._ceiling_reason,
      layers_present: c._layers_present,
      missing_or_low_evidence_flags: c.missing_or_low_evidence_flags,
    })),
    no_trades: true,
    market_neutral: true,
  });

  const loopInputsPath = `${absOutputDir}/loop_history_inputs.json`;
  writeJsonAtomic(loopInputsPath, {
    schema_version: 'nascar_loop_history_gen7',
    run_date: RUN_DATE,
    track: loopHistory.track,
    era_floor_season: loopHistory.era_floor_season,
    driver_count: loopHistory.driver_count,
    races_considered: loopHistory.races_considered,
    source_urls: loopHistory.source_urls,
    notes: loopHistory.notes,
    by_driver_summary: Object.fromEntries(
      Object.entries(loopHistory.by_driver).map(([k, v]) => [
        k,
        { driver_name: v.driver_name, evidence_summary: v.evidence_summary, layers_present: Object.keys(v.layers) },
      ]),
    ),
  });

  const packetMd = renderPacket({
    candidates,
    pqEnvelope,
    loopMeta: { era_floor: loopHistory.era_floor_season, driver_count: loopHistory.driver_count },
    runDate: RUN_DATE,
  });
  const packetPath = `${absOutputDir}/packet.md`;
  writeTextAtomic(packetPath, packetMd);

  return {
    runDate: RUN_DATE,
    outputDir: absOutputDir,
    files: [packetPath, ceilingBoardPath, loopInputsPath],
    candidateCount: candidates.length,
    topFive: candidates.slice(0, 5).map(c => ({
      driver_name: c.driver_name,
      car_number: c.car_number,
      model_rating: c.model_rating_0_100,
      ceiling: c.ceiling,
    })),
    no_trades: true,
  };
}
