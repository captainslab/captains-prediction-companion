// Tests for the single-final-ceiling refactor of the Coca-Cola 600 board.
// Verifies: every points-pool driver gets ONE final ceiling, a 7-row evidence
// ledger, invalidators, and the required sources are wired up.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { composeCocaCola600Packet } from '../scripts/nascar/lib/coca-cola-600-packet.mjs';
import { FINAL_CEILINGS, composeFinalCeilingForDriver } from '../scripts/nascar/lib/final-ceiling.mjs';
import { seasonForm2026Envelope } from '../scripts/nascar/lib/source-adapters/season-form-2026.mjs';
import { charlotteOvalHistoryEnvelope } from '../scripts/nascar/lib/source-adapters/charlotte-oval-history.mjs';
import { intermediate15miOvalHistoryEnvelope } from '../scripts/nascar/lib/source-adapters/intermediate-15mi-oval-history.mjs';

function makeTempOutputDir() {
  const root = mkdtempSync(join(tmpdir(), 'cc600-finalceiling-'));
  return join(root, 'state', 'nascar', '2026-05-25');
}

const POOL_TOP_20 = [
  'Tyler Reddick','Denny Hamlin','Chase Elliott','Ryan Blaney','Chris Buescher',
  'Ty Gibbs','Carson Hocevar','Kyle Larson','Brad Keselowski','Bubba Wallace',
  'Christopher Bell','William Byron','Ryan Preece','Daniel Suárez','Austin Cindric',
  'Shane van Gisbergen','Chase Briscoe','Joey Logano','Ross Chastain','A. J. Allmendinger',
];

test('the three new source-backed adapters cover all 20 pool drivers', () => {
  for (const env of [
    seasonForm2026Envelope({ checked_at_utc: '2026-05-25T00:00:00Z' }),
    charlotteOvalHistoryEnvelope({ checked_at_utc: '2026-05-25T00:00:00Z' }),
    intermediate15miOvalHistoryEnvelope({ checked_at_utc: '2026-05-25T00:00:00Z' }),
  ]) {
    assert.equal(env.status, 'ok');
    assert.equal(env.records.length, 20, `expected 20 records, got ${env.records.length}`);
    for (const name of POOL_TOP_20) {
      assert.ok(env.records.find(r => r.driver_name === name), `missing ${name} in ${env.source_id}`);
    }
  }
});

test('composeFinalCeilingForDriver assigns one ceiling and builds a 7-row evidence ledger', () => {
  const r = composeFinalCeilingForDriver({
    driver: {
      driver_name: 'Test Driver', car_number: 99,
      driver_skill_rating: 80, driver_ability_to_convert: 75,
      team_equipment_quality: 85, pit_crew_crew_chief_grade: null,
      strategy_risk_rating: 70,
    },
    seasonFormRecord: { present: true, score: 80, races_run: 12, wins: 3, top_5s: 7,
      top_10s: 9, dnfs: 0, average_finish_excluding_dnf: 6.5, sample_quality: 'ok',
      source_basis: 'test' },
    charlotteOvalRecord: { present: true, score: 75, races_run: 4, wins: 1, top_5s: 2,
      top_10s: 3, average_finish: 9.0, sample_quality: 'ok', source_basis: 'test' },
    intermediateRecord: { present: true, score: 72, races_run: 20, wins: 2, top_5s: 6,
      top_10s: 11, dnfs: 1, average_finish: 10.5, sample_quality: 'ok', source_basis: 'test' },
    practiceQualifyingRecord: { driver_name: 'Test Driver', starting_position: 5, practice_rank: null },
  });

  assert.equal(r.evidence_ledger.length, 7, 'ledger must have one row per category');
  const categories = r.evidence_ledger.map(row => row.category);
  assert.deepEqual(categories, [
    'baseline_fundamentals', 'season_form_2026', 'season_speed_signal_2026',
    'charlotte_oval_history', 'intermediate_15mi_oval',
    'practice_qualifying', 'long_run_race_type_fit',
  ]);
  assert.ok(FINAL_CEILINGS.includes(r.final_ceiling));
  assert.ok(typeof r.composite_score === 'number');
  assert.ok(Array.isArray(r.invalidators));
  // long_run_race_type_fit must always be marked MISSING (no clean source).
  const lr = r.evidence_ledger.find(row => row.category === 'long_run_race_type_fit');
  assert.equal(lr.present, false);
  assert.ok(lr.missing_note);
});

test('no-evidence driver receives NO CLEAR PICK with explanation', () => {
  const r = composeFinalCeilingForDriver({
    driver: { driver_name: 'Empty', car_number: 0 },
  });
  assert.equal(r.final_ceiling, 'NO CLEAR PICK');
  assert.equal(r.composite_score, null);
  assert.ok(r.reasoning_summary.includes('NO CLEAR PICK'));
});

test('a driver with strong composite but NO Charlotte/intermediate evidence is capped at TOP 10', () => {
  const r = composeFinalCeilingForDriver({
    driver: {
      driver_skill_rating: 95, driver_ability_to_convert: 90,
      team_equipment_quality: 95, strategy_risk_rating: 90,
    },
    seasonFormRecord: { present: true, score: 90, races_run: 12, wins: 5, top_5s: 8, top_10s: 10, dnfs: 0, average_finish_excluding_dnf: 4.5, sample_quality: 'ok', source_basis: 'test' },
    practiceQualifyingRecord: { driver_name: 'X', starting_position: 1, practice_rank: 1 },
    // No oval, no intermediate.
  });
  assert.equal(r.final_ceiling, 'TOP 10', `expected TOP 10 cap without track-type evidence, got ${r.final_ceiling} (composite=${r.composite_score})`);
});

test('Coca-Cola 600 packet: every pool driver has exactly one final_ceiling and an evidence ledger', async () => {
  const outputDir = makeTempOutputDir();
  const result = await composeCocaCola600Packet({ outputDir });
  const board = JSON.parse(readFileSync(join(outputDir, 'ceiling_board.json'), 'utf8'));

  assert.ok(board.candidates.length >= 20, 'must include at least the 20 points-pool drivers');
  assert.equal(board.candidate_pool_basis, 'cup_points_plus_active_field');
  assert.equal(board.scored_head.length, 20, 'scored head must be 20 (points top-20)');

  for (const c of board.candidates) {
    assert.ok(FINAL_CEILINGS.includes(c.final_ceiling),
      `${c.driver_name} has invalid final_ceiling=${c.final_ceiling}`);
    assert.ok(Array.isArray(c.final_evidence_ledger) && c.final_evidence_ledger.length === 7,
      `${c.driver_name} ledger length must be 7`);
    assert.ok(typeof c.final_reasoning_summary === 'string' && c.final_reasoning_summary.length > 0);
    assert.ok(Array.isArray(c.final_invalidators));
    assert.ok(typeof c.final_ceiling_reason === 'string' && c.final_ceiling_reason.length > 0);
  }

  // Scored head sorted by composite desc.
  const head = board.scored_head;
  for (let i = 1; i < head.length; i++) {
    assert.ok((head[i - 1].final_composite_score ?? -1) >= (head[i].final_composite_score ?? -1),
      `scored_head must be sorted by composite desc at index ${i}`);
  }

  // Tyler Reddick must be present and have 2026 form + practice/qualifying
  // ledger rows MARKED PRESENT (not missing).
  const reddick = board.candidates.find(c => c.driver_name === 'Tyler Reddick');
  assert.ok(reddick, 'Tyler Reddick must appear in the active pool');
  const season = reddick.final_evidence_ledger.find(r => r.category === 'season_form_2026');
  const pq = reddick.final_evidence_ledger.find(r => r.category === 'practice_qualifying');
  assert.equal(season.present, true, 'Reddick 2026 form must be present');
  assert.equal(pq.present, true, 'Reddick practice/qualifying must be present');

  // Schema metadata is exported.
  assert.ok(board.final_ceiling_schema);
  assert.deepEqual(board.final_ceiling_schema.ceilings_allowed, FINAL_CEILINGS);
  assert.match(board.final_ceiling_schema.charlotte_filter, /OVAL only/);
  assert.match(board.final_ceiling_schema.era_filter, /Gen 7/);
  assert.equal(board.final_ceiling_schema.grid_basis, 'rules_set');

  // packet.md surfaces the new section + the required row schema.
  const md = readFileSync(join(outputDir, 'packet.md'), 'utf8');
  assert.ok(md.includes('## Final Ceiling Board (single ceiling per driver)'));
  assert.ok(md.includes('1. Main scored field'));
  assert.ok(md.includes('2. Field tail'));
  assert.ok(md.indexOf('## Final Ceiling Board (single ceiling per driver)') < md.indexOf('## Final-Ceiling Evidence Ledger'));
  assert.ok(md.indexOf('## Final-Ceiling Evidence Ledger') < md.indexOf('## Storyline / Tiebreaker Context (non-scoring)'));
  assert.ok(md.includes('## Storyline / Tiebreaker Context (non-scoring)'));
  assert.ok(md.includes('Kyle Busch - NOT entered'));
  assert.ok(md.includes('#8 / #33 disambiguation'));
  assert.ok(md.includes('Rank | Driver'));
  assert.ok(md.includes('Ceiling'));
  assert.ok(md.includes('Note'));
  assert.ok(!md.includes('## Ceiling Board (full active field)'), 'packet.md must not render legacy lane-board section');
  assert.ok(!md.includes('Rank  Car  Driver'), 'packet.md must not render legacy lane-board table');
  assert.ok(!md.includes('practice P0'), 'null practice ranks must not render as practice P0');
  for (const name of POOL_TOP_20) {
    const stripped = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\./g, '');
    assert.ok(md.includes(name) || md.includes(stripped),
      `packet.md missing driver ${name}`);
  }

  // Kyle Busch is NEVER scored.
  for (const c of board.candidates) {
    assert.notEqual(c.driver_name, 'Kyle Busch', 'Kyle Busch must not be a scored candidate');
  }

  // Austin Hill #33 must appear in field_tail with Cup-history lockout
  // (season_form_2026 / charlotte_oval_history / intermediate_15mi_oval MISSING with lockout reason).
  const hill = board.candidates.find(c => c.car_number === 33);
  if (hill) {
    const lockMsg = /lockout|no transferable Cup record|no 2026 Cup season form|No\. 33|No\. 8 suspension/i;
    const cupLayers = ['season_form_2026', 'season_speed_signal_2026', 'charlotte_oval_history', 'intermediate_15mi_oval'];
    for (const cat of cupLayers) {
      const row = hill.final_evidence_ledger.find(r => r.category === cat);
      assert.equal(row.present, false, `Hill #33 ${cat} must be MISSING under lockout`);
      assert.match(String(row.missing_note ?? ''), lockMsg, `Hill #33 ${cat} must have lockout missing_note`);
    }
    assert.equal(hill.final_ceiling, 'WATCH', 'Hill #33 must be capped at WATCH under Cup-history lockout');
  }
});

test('storyline beneficiary does not upgrade final ceiling', async () => {
  const outputDir = makeTempOutputDir();
  await composeCocaCola600Packet({ outputDir });
  const board = JSON.parse(readFileSync(join(outputDir, 'ceiling_board.json'), 'utf8'));
  // Austin Hill isn't in the pool; storyline beneficiary flag attaches to the pool
  // candidate matched by name/car, if any. We just assert no driver has a final
  // ceiling justified by storyline alone (reason string never mentions storyline).
  for (const c of board.candidates) {
    assert.ok(!/storyline/i.test(c.final_ceiling_reason),
      `${c.driver_name} ceiling reason mentions storyline`);
  }
});

test('sanity sample drivers (Larson, Hamlin, Byron, Elliott, Briscoe, SVG) appear with finite composite scores', async () => {
  const outputDir = makeTempOutputDir();
  await composeCocaCola600Packet({ outputDir });
  const board = JSON.parse(readFileSync(join(outputDir, 'ceiling_board.json'), 'utf8'));
  for (const name of ['Kyle Larson', 'Denny Hamlin', 'William Byron', 'Chase Elliott', 'Chase Briscoe', 'Shane van Gisbergen']) {
    const c = board.candidates.find(x => x.driver_name === name);
    assert.ok(c, `missing ${name}`);
    assert.ok(Number.isFinite(c.final_composite_score), `${name} composite must be finite, got ${c.final_composite_score}`);
    assert.ok(FINAL_CEILINGS.includes(c.final_ceiling));
  }
});
