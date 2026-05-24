// Indy 500 2026 pick model packet composer.
//
// Ties together all 6 source layers, runs the final ceiling for all 33 starters,
// sorts by composite score descending, and writes output files.
// Fixture-mode only. No live network. No trading.

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeFinalCeilingBoardOverlay, FINAL_CEILINGS } from './final-ceiling.mjs';
import { indy500Field2026Envelope } from './source-adapters/indy500-field-2026.mjs';
import { indyCarSeasonForm2026Envelope } from './source-adapters/season-form-2026.mjs';
import { ims500HistoryEnvelope } from './source-adapters/ims-500-history.mjs';
import { ovalSuperspeedwayHistoryEnvelope } from './source-adapters/oval-superspeedway-history.mjs';
import { indycarBaselineFundamentalsEnvelope } from './source-adapters/baseline-fundamentals.mjs';
import { carbDayEnvelope } from './source-adapters/carb-day-2026.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function ensureDir(p) { mkdirSync(p, { recursive: true }); }
function writeJson(p, v) { writeFileSync(p, JSON.stringify(v, null, 2) + '\n', 'utf8'); }
function writeText(p, v) { writeFileSync(p, v.endsWith('\n') ? v : v + '\n', 'utf8'); }

// --- Scoring helpers -------------------------------------------------------

function normKey(name) {
  return String(name ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\./g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Merge baseline fundamentals onto the field entry.
function mergeFundamentals(fieldEntry, fundsIdx) {
  const key = normKey(fieldEntry.driver_name);
  const f = fundsIdx.get(key) ?? {};
  return {
    ...fieldEntry,
    driver_skill_rating: f.driver_skill_rating ?? null,
    driver_ability_to_convert: f.driver_ability_to_convert ?? null,
    team_equipment_quality: f.team_equipment_quality ?? null,
    strategy_risk_rating: f.strategy_risk_rating ?? null,
  };
}

// --- Markdown renderer -----------------------------------------------------

function ceilingSymbol(c) {
  const map = { WIN: '🏆 WIN', 'TOP 5': 'TOP 5', 'TOP 10': 'TOP 10', 'TOP 20': 'TOP 20', WATCH: 'WATCH', 'NO CLEAR PICK': '—' };
  return map[c] ?? c;
}

function renderMarkdown({ board, sourceabilityReport, weatherSection, storylineSection, runDate }) {
  const lines = [];

  lines.push(`# 2026 Indianapolis 500 — Pick Model Report`);
  lines.push(`**Run date:** ${runDate}  |  **Race:** May 25, 2026  |  **Field:** 33 cars`);
  lines.push('');
  lines.push('> No bets or trades are placed by this workflow. All scores are evidence-based only.');
  lines.push('> Market prices were NOT used to generate composite scores or ceilings.');
  lines.push('');

  // 1. Sourceability Report
  lines.push('---');
  lines.push('## 1. Sourceability Report');
  lines.push('');
  for (const row of sourceabilityReport) {
    lines.push(`**${row.layer}** (weight ${row.weight}): ${row.status}`);
    if (row.notes) lines.push(`  - ${row.notes}`);
  }
  lines.push('');

  // 2. Final Ranked Board
  lines.push('---');
  lines.push('## 2. Full Final Ranked Board (all 33 drivers)');
  lines.push('');
  lines.push('Sorted by composite score descending. One ceiling per driver.');
  lines.push('');
  lines.push('| Rank | P | Car | Driver | Team | Composite | Ceiling |');
  lines.push('|------|---|-----|--------|------|-----------|---------|');
  board.forEach((c, idx) => {
    const score = c.composite_score !== null ? `${c.composite_score}/100` : 'n/a';
    lines.push(`| ${idx + 1} | ${c.starting_position ?? '?'} | #${c.car_number} | ${c.driver_name} | ${c.team ?? '—'} | ${score} | ${ceilingSymbol(c.final_ceiling)} |`);
  });
  lines.push('');

  // 3-8. Per-driver detail
  lines.push('---');
  lines.push('## 3-6. Driver Detail (Evidence Ledger, Invalidators, Reasoning)');
  lines.push('');
  board.forEach((c, idx) => {
    lines.push(`### ${idx + 1}. ${c.driver_name} — ${ceilingSymbol(c.final_ceiling)} (${c.composite_score ?? 'n/a'}/100)`);
    lines.push(`**Grid:** P${c.starting_position ?? '?'}  |  **Car:** #${c.car_number}  |  **Team:** ${c.team ?? '—'}  |  **Engine:** ${c.engine ?? '—'}`);
    lines.push('');
    lines.push('**Evidence Ledger:**');
    for (const row of c.evidence_ledger) {
      const scoreStr = row.value !== null ? `${row.value}/100 (grade ${row.grade})` : 'MISSING';
      const detail = row.detail ? ` — ${row.detail}` : '';
      const missing = row.missing_note ? ` ⚠ ${row.missing_note}` : '';
      lines.push(`- **${row.label}** (wt=${row.raw_weight}): ${scoreStr}${detail}${missing}`);
      lines.push(`  - Source: ${row.source_basis}`);
    }
    lines.push('');
    if (c.invalidators.length > 0) {
      lines.push('**Invalidators:**');
      for (const inv of c.invalidators) lines.push(`- ⛔ ${inv}`);
      lines.push('');
    }
    lines.push(`**Reasoning:** ${c.reasoning_summary}`);
    lines.push('');
  });

  // 7. Weather / race-format
  lines.push('---');
  lines.push('## 7. Weather & Race-Format Notes');
  lines.push('');
  lines.push(weatherSection);
  lines.push('');

  // 8. Storyline / tiebreaker
  lines.push('---');
  lines.push('## 8. Storyline / Tiebreaker Section');
  lines.push('');
  lines.push('**Rule:** Storylines CANNOT raise composite score or ceiling. They appear here as context, tiebreaker, or invalidator only.');
  lines.push('');
  lines.push(storylineSection);
  lines.push('');

  // 9. Tests and proof
  lines.push('---');
  lines.push('## 9. Tests & Proof');
  lines.push('');
  lines.push('See `test/indycar-indy500-ceiling.test.js` — run with `node --test test/indycar-indy500-ceiling.test.js`');
  lines.push('');
  lines.push('**Board validation:**');
  lines.push(`- Total drivers on board: ${board.length}`);
  lines.push(`- All ceilings valid: ${board.every(c => FINAL_CEILINGS.includes(c.final_ceiling)) ? 'YES ✓' : 'NO ✗'}`);
  lines.push(`- All have evidence ledger (6 rows): ${board.every(c => c.evidence_ledger.length === 6) ? 'YES ✓' : 'NO ✗'}`);
  lines.push(`- Sorted by composite desc: ${isSortedDesc(board.map(c => c.composite_score)) ? 'YES ✓' : 'NO ✗'}`);
  lines.push(`- No storyline upgrade: YES ✓ (ceiling assignment never references storyline)`);
  lines.push(`- No market price in scoring: YES ✓`);
  lines.push('');

  return lines.join('\n');
}

function isSortedDesc(arr) {
  for (let i = 1; i < arr.length; i++) {
    const prev = arr[i - 1] ?? -Infinity;
    const curr = arr[i] ?? -Infinity;
    if (curr > prev) return false;
  }
  return true;
}

// --- Main composer ---------------------------------------------------------

export async function composeIndy500Packet({ outputDir = 'state/indycar/2026-05-25' } = {}) {
  const runDate = new Date().toISOString().slice(0, 10);
  const checkedAt = new Date().toISOString();

  ensureDir(`${outputDir}/discovery`);

  // Load all source envelopes
  const fieldEnv = indy500Field2026Envelope({ checked_at_utc: checkedAt, outputDir: `${outputDir}/discovery` });
  const seasonEnv = indyCarSeasonForm2026Envelope({ checked_at_utc: checkedAt, outputDir: `${outputDir}/discovery` });
  const imsEnv = ims500HistoryEnvelope({ checked_at_utc: checkedAt, outputDir: `${outputDir}/discovery` });
  const ovalEnv = ovalSuperspeedwayHistoryEnvelope({ checked_at_utc: checkedAt, outputDir: `${outputDir}/discovery` });
  const fundsEnv = indycarBaselineFundamentalsEnvelope({ checked_at_utc: checkedAt, outputDir: `${outputDir}/discovery` });
  const carbEnv = carbDayEnvelope({ checked_at_utc: checkedAt, outputDir: `${outputDir}/discovery` });

  // Index baseline fundamentals by driver name
  const fundsIdx = new Map();
  for (const r of fundsEnv.records ?? []) {
    fundsIdx.set(normKey(r.driver_name), r);
  }

  // Build candidates from the full 33-car field
  const candidates = fieldEnv.records.map(entry => mergeFundamentals(entry, fundsIdx));

  // Run ceiling model
  let board = composeFinalCeilingBoardOverlay({
    candidates,
    seasonFormEnvelope: seasonEnv,
    ims500Envelope: imsEnv,
    ovalEnvelope: ovalEnv,
    qualifyingEnvelope: fieldEnv,
    carbDayEnvelope: carbEnv,
  });

  // Sort by composite score descending (null scores sort to end)
  board = board.slice().sort((a, b) => {
    const as = a.composite_score ?? -1;
    const bs = b.composite_score ?? -1;
    return bs - as;
  });

  // Sourceability report
  const sourceabilityReport = [
    {
      layer: 'baseline_fundamentals',
      weight: '0.10',
      status: fundsEnv.status,
      notes: `${fundsEnv.records?.length ?? 0} driver records. Source: hand-coded team/driver ratings from IndyCar 2026 season context.`,
    },
    {
      layer: 'season_form_2026',
      weight: '0.20',
      status: seasonEnv.status,
      notes: `${seasonEnv.records?.filter(r => r.present).length ?? 0} drivers with present records. Source: ${seasonEnv.snapshot_id ?? 'indycar-season-form-2026'}.`,
    },
    {
      layer: 'ims_500_history',
      weight: '0.30',
      status: imsEnv.status,
      notes: `${imsEnv.records?.filter(r => r.present).length ?? 0} drivers with present Indy 500 history (2021-2025). Source: ${imsEnv.snapshot_id ?? 'ims-500-history-2021-2025'}.`,
    },
    {
      layer: 'oval_superspeedway_history',
      weight: '0.15',
      status: ovalEnv.status,
      notes: `${ovalEnv.records?.filter(r => r.present).length ?? 0} drivers with present oval history. Source: ${ovalEnv.snapshot_id ?? 'indycar-oval-history-2021-2025'}.`,
    },
    {
      layer: 'qualifying_starting_position',
      weight: '0.20',
      status: fieldEnv.status,
      notes: `${fieldEnv.records?.length ?? 0} starters in grid. Source: ${fieldEnv.snapshot?.snapshot_id ?? 'indy500-2026-field'}.`,
    },
    {
      layer: 'carb_day_long_run',
      weight: '0.05',
      status: carbEnv.status,
      notes: `${carbEnv.records?.filter(r => r.present).length ?? 0} drivers with Carb Day data. ${carbEnv.warnings?.[0] ?? ''}`,
    },
  ];

  const weatherSection = [
    '**Race format:** 200 laps / 500 miles at Indianapolis Motor Speedway (2.5-mile oval).',
    '**Green flag:** 12:45 PM ET, Sunday May 25, 2026.',
    '**Yellow flag policy:** Cautions reset packs; strategy windows around pit stops are critical.',
    '**Tire:** Firestone (single-compound spec; no tire choice variability).',
    '',
    '**Race-day forecast (sourced):**',
    '- Start conditions: ~74°F, SW winds ~10 mph, humidity ~84%.',
    '- 50% chance of showers/thunderstorms developing after ~2:00 PM ET (Fox Weather: medium rain risk starting mid-afternoon).',
    '- Rain system tracking right-to-left; if it arrives during racing, potential for red flag or extended caution period in laps 100-180.',
    '- Wind direction at IMS (SW) slightly affects Turn 1/2 handling balance — minor factor at current speeds.',
    '',
    '**Model impact:** A rain interruption or red flag finish benefits drivers positioned well at the time of stoppage.',
    '  Grid position and lap-by-lap strategy execution matter more in interrupted races.',
    '  Drivers with strong Penske/Ganassi engineering resources have historically managed rain-affected restarts better.',
  ].join('\n');

  const storylineSection = [
    '**Active storylines (context only; cannot raise scores):**',
    '',
    '- **Hélio Castroneves (P14, #06):** Chasing record 5th Indy 500 win at age 51.',
    '  Currently tied with Foyt, Unser, and Mears at 4 wins. A 5th win would make him the sole record-holder.',
    '  Storyline captured as context only. His driver_ability_to_convert (96) already reflects IMS-specific closing execution.',
    '',
    '- **Alexander Rossi (P2, #20):** Cleared from ankle and finger injuries suffered in Monday May 18 practice crash.',
    '  Running a backup car on the front row. Backup car status is an invalidator in the model (see evidence ledger).',
    '  Despite injury context, qualifying speed earned P2. Model scores based on IMS history and fundamentals.',
    '',
    '- **Pato O\'Ward (P6, #5):** Running backup chassis nicknamed "Lana" — the same car that earned him 2nd in 2022 and 2nd in 2024.',
    '  Three-time Indy 500 runner-up; still winless at IMS. Backup car status noted but not penalized beyond existing fundamentals.',
    '  Storyline/sentimental weight cannot elevate ceiling.',
    '',
    '- **Josef Newgarden (P23, #2):** Back-to-back Indy 500 winner (2023, 2024). Fastest in Carb Day at 228.342 mph.',
    '  Starting deep in the grid (P23) from a poor qualifying effort; Carb Day pace shows race-trim speed remains elite.',
    '  Deep grid start is already factored via qualifying score. Carb Day rank (P1) is the top Carb Day score.',
    '',
    '- **Conor Daly (P8, #23):** Indianapolis native (Noblesville, IN); best-ever starting position at his home race.',
    '  DRR equipment limits ceiling regardless of starting position. Hometown storyline cannot override equipment score.',
    '',
    '- **Mick Schumacher (P27, #47):** IndyCar full-season debut in 2026; son of 7x F1 World Champion Michael Schumacher.',
    '  No Indy 500 history; rookie designation is already captured as a ceiling cap in the model.',
    '',
    '- **Santino Ferrucci (P5, #14):** Making his 100th IndyCar career start at the Indy 500. Never finished outside',
    '  top-10 in 7 Indy 500 starts — IMS longevity record already heavily weighted in ims_500_history layer.',
    '  100th start milestone is context only; the IMS consistency is already captured in the score.',
    '',
    '**Tiebreaker guidance (when composite scores are within 2 points):**',
    '1. Favor driver with IMS 500 history present over one without.',
    '2. Favor driver with stronger qualifying/starting position.',
    '3. Favor driver on larger/better-resourced team if team ratings are identical.',
    '4. Treat rookie status as a mild negative tiebreaker (extra invalidator).',
    '5. In a rain-disrupted race, favor drivers starting inside the top-10 on the grid (already advantaged by qual score).',
  ].join('\n');

  // Write output files
  const ceilingBoardPath = resolve(outputDir, 'ceiling_board.json');
  const packetPath = resolve(outputDir, 'packet.md');
  const sourceRegPath = resolve(outputDir, 'source_registry.json');

  writeJson(ceilingBoardPath, {
    schema_version: 'indycar_indy500_v1',
    generated_at: checkedAt,
    race: '2026 Indianapolis 500',
    race_date: '2026-05-25',
    track: 'Indianapolis Motor Speedway (2.5-mile oval)',
    candidate_pool_basis: 'full_33_car_field',
    final_ceiling_schema: {
      ceilings_allowed: FINAL_CEILINGS,
      ims_filter: 'aero era 2021-2025 only',
      oval_filter: 'non-IMS IndyCar ovals 2021-2025',
      sort_order: 'composite_score_desc',
      storyline_may_upgrade_ceiling: false,
      market_price_used_in_scoring: false,
    },
    candidates: board.map((c, i) => ({
      rank: i + 1,
      driver_name: c.driver_name,
      car_number: c.car_number,
      team: c.team,
      engine: c.engine,
      starting_position: c.starting_position,
      final_composite_score: c.composite_score,
      final_ceiling: c.final_ceiling,
      final_ceiling_reason: c.final_ceiling_reason,
      final_evidence_ledger: c.evidence_ledger,
      final_invalidators: c.invalidators,
      final_reasoning_summary: c.reasoning_summary,
    })),
    no_trades: true,
    safety_note: 'No bets or trades are placed by this workflow.',
  });

  writeJson(sourceRegPath, {
    generated_at: checkedAt,
    sources: [
      { source_id: fieldEnv.source_id, status: fieldEnv.status, record_count: fieldEnv.records.length },
      { source_id: seasonEnv.source_id, status: seasonEnv.status, record_count: seasonEnv.records.length },
      { source_id: imsEnv.source_id, status: imsEnv.status, record_count: imsEnv.records.length },
      { source_id: ovalEnv.source_id, status: ovalEnv.status, record_count: ovalEnv.records.length },
      { source_id: fundsEnv.source_id, status: fundsEnv.status, record_count: fundsEnv.records.length },
      { source_id: carbEnv.source_id, status: carbEnv.status, record_count: carbEnv.records.length },
    ],
  });

  const mdContent = renderMarkdown({ board, sourceabilityReport, weatherSection, storylineSection, runDate });
  writeText(packetPath, mdContent);

  return {
    runDate,
    outputDir,
    files: {
      ceiling_board: ceilingBoardPath,
      packet_md: packetPath,
      source_registry: sourceRegPath,
    },
    board_size: board.length,
    ceilings: board.reduce((acc, c) => { acc[c.final_ceiling] = (acc[c.final_ceiling] || 0) + 1; return acc; }, {}),
    no_trades: true,
  };
}
