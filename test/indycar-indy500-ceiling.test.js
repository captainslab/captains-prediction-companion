// Tests for the 2026 Indy 500 ceiling model.
// Verifies: correct layer definitions, ceiling assignment logic, evidence ledger,
// invalidators, sort order, and no storyline/market-price upgrades.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FINAL_CEILINGS, composeFinalCeilingForDriver, composeFinalCeilingBoardOverlay } from '../scripts/indycar/lib/final-ceiling.mjs';
import { composeIndy500Packet } from '../scripts/indycar/lib/indy500-packet.mjs';

// --- Unit tests for ceiling logic -----------------------------------------

test('FINAL_CEILINGS has exactly the 6 allowed values', () => {
  assert.deepEqual(Array.from(FINAL_CEILINGS), ['WIN', 'TOP 5', 'TOP 10', 'TOP 20', 'WATCH', 'NO CLEAR PICK']);
});

test('composeFinalCeilingForDriver returns a 6-row evidence ledger', () => {
  const r = composeFinalCeilingForDriver({
    driver: {
      driver_name: 'Test Driver', car_number: 10,
      driver_skill_rating: 85, driver_ability_to_convert: 80,
      team_equipment_quality: 90, strategy_risk_rating: 75,
    },
    seasonFormRecord: {
      present: true, score: 82, races_run: 6, wins: 2, top_5s: 4,
      top_10s: 5, dnfs: 0, average_finish_excluding_dnf: 5.2,
      sample_quality: 'ok', source_basis: 'test',
    },
    ims500Record: {
      present: true, score: 80, races_run: 4, wins: 1, top_5s: 2,
      top_10s: 3, dnfs: 0, average_finish: 7.5, sample_quality: 'ok',
      source_basis: 'test',
    },
    ovalRecord: {
      present: true, score: 78, races_run: 12, wins: 2, top_5s: 5,
      top_10s: 8, dnfs: 1, average_finish: 8.2, sample_quality: 'ok',
      source_basis: 'test',
    },
    qualifyingRecord: { driver_name: 'Test Driver', starting_position: 3, qualifying_speed_mph: 234.5 },
  });

  assert.equal(r.evidence_ledger.length, 6, 'ledger must have 6 rows');
  const categories = r.evidence_ledger.map(row => row.category);
  assert.deepEqual(categories, [
    'baseline_fundamentals', 'season_form_2026', 'ims_500_history',
    'oval_superspeedway_history', 'qualifying_starting_position', 'carb_day_long_run',
  ]);
  assert.ok(FINAL_CEILINGS.includes(r.final_ceiling), `invalid ceiling: ${r.final_ceiling}`);
  assert.ok(typeof r.composite_score === 'number' && r.composite_score >= 0 && r.composite_score <= 100);
  assert.ok(Array.isArray(r.invalidators));
  assert.ok(typeof r.reasoning_summary === 'string' && r.reasoning_summary.length > 0);
});

test('carb_day_long_run layer missing when no carbDayRecord provided', () => {
  const r = composeFinalCeilingForDriver({
    driver: { driver_name: 'No Carb', car_number: 99 },
  });
  const carb = r.evidence_ledger.find(row => row.category === 'carb_day_long_run');
  assert.equal(carb.present, false);
  assert.ok(carb.missing_note);
});

test('driver with no data at all gets NO CLEAR PICK', () => {
  const r = composeFinalCeilingForDriver({ driver: { driver_name: 'Ghost', car_number: 0 } });
  assert.equal(r.final_ceiling, 'NO CLEAR PICK');
  assert.equal(r.composite_score, null);
  assert.ok(r.reasoning_summary.includes('NO CLEAR PICK'));
});

test('driver with strong composite but NO IMS history is capped at TOP 10', () => {
  const r = composeFinalCeilingForDriver({
    driver: {
      driver_skill_rating: 95, driver_ability_to_convert: 92,
      team_equipment_quality: 95, strategy_risk_rating: 90,
    },
    seasonFormRecord: {
      present: true, score: 92, races_run: 6, wins: 3, top_5s: 5,
      top_10s: 6, dnfs: 0, average_finish_excluding_dnf: 3.8,
      sample_quality: 'ok', source_basis: 'test',
    },
    qualifyingRecord: { driver_name: 'X', starting_position: 1, qualifying_speed_mph: 236.0 },
    // No IMS history, no oval history
  });
  // Without IMS or oval evidence, ceiling must be capped at TOP 10
  assert.ok(
    ['TOP 10', 'TOP 20', 'WATCH', 'NO CLEAR PICK'].includes(r.final_ceiling),
    `expected cap at TOP 10 without track-type evidence, got ${r.final_ceiling} (composite=${r.composite_score})`
  );
});

test('IMS DNF rate invalidator fires when >= 30%', () => {
  const r = composeFinalCeilingForDriver({
    driver: { driver_name: 'DNF King', car_number: 55 },
    ims500Record: {
      present: true, score: 55, races_run: 4, wins: 0, top_5s: 0,
      top_10s: 1, dnfs: 2, average_finish: 18.5, sample_quality: 'ok',
      source_basis: 'test',
    },
  });
  const hasDNFInvalidator = r.invalidators.some(inv => inv.includes('DNF rate'));
  assert.ok(hasDNFInvalidator, `expected DNF rate invalidator, got: ${JSON.stringify(r.invalidators)}`);
});

test('deep starting position (P25+) triggers invalidator', () => {
  const r = composeFinalCeilingForDriver({
    driver: { driver_name: 'Back Row', car_number: 77 },
    qualifyingRecord: { driver_name: 'Back Row', starting_position: 28 },
  });
  const hasStartInvalidator = r.invalidators.some(inv => inv.includes('starting position'));
  assert.ok(hasStartInvalidator, `expected deep grid invalidator, got: ${JSON.stringify(r.invalidators)}`);
});

test('reasoning_summary never references storyline for ceiling assignment', () => {
  const r = composeFinalCeilingForDriver({
    driver: {
      driver_skill_rating: 88, driver_ability_to_convert: 82,
      team_equipment_quality: 85, strategy_risk_rating: 75,
    },
    seasonFormRecord: { present: true, score: 80, races_run: 5, wins: 1, top_5s: 3, top_10s: 4, dnfs: 0, average_finish_excluding_dnf: 6.5, sample_quality: 'ok', source_basis: 'test' },
    ims500Record: { present: true, score: 78, races_run: 3, wins: 1, top_5s: 2, top_10s: 3, dnfs: 0, average_finish: 8.0, sample_quality: 'ok', source_basis: 'test' },
  });
  assert.ok(!/storyline/i.test(r.final_ceiling_reason),
    `ceiling reason must not mention storyline: "${r.final_ceiling_reason}"`);
});

// --- Integration test with full packet ------------------------------------

test('Indy 500 packet: board has 33 drivers, all valid ceilings, sorted desc', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'indy500-test-'));
  const outputDir = join(tmpDir, 'state', 'indycar', '2026-05-25');

  const result = await composeIndy500Packet({ outputDir });

  assert.equal(result.board_size, 33, `expected 33 drivers on board, got ${result.board_size}`);
  assert.ok(result.no_trades === true);

  // Read and validate ceiling_board.json
  const board = JSON.parse(readFileSync(result.files.ceiling_board, 'utf8'));
  assert.equal(board.candidates.length, 33);
  assert.equal(board.candidate_pool_basis, 'full_33_car_field');
  assert.equal(board.no_trades, true);
  assert.equal(board.final_ceiling_schema.storyline_may_upgrade_ceiling, false);
  assert.equal(board.final_ceiling_schema.market_price_used_in_scoring, false);

  // Each driver has required fields
  for (const c of board.candidates) {
    assert.ok(FINAL_CEILINGS.includes(c.final_ceiling),
      `${c.driver_name} has invalid ceiling: ${c.final_ceiling}`);
    assert.ok(Array.isArray(c.final_evidence_ledger) && c.final_evidence_ledger.length === 6,
      `${c.driver_name} ledger must have 6 rows`);
    assert.ok(Array.isArray(c.final_invalidators));
    assert.ok(typeof c.final_reasoning_summary === 'string' && c.final_reasoning_summary.length > 0);
    assert.ok(typeof c.final_ceiling_reason === 'string' && c.final_ceiling_reason.length > 0);
    assert.ok(c.starting_position !== undefined, `${c.driver_name} missing starting_position`);
  }

  // Board is sorted composite score descending
  const scores = board.candidates.map(c => c.final_composite_score ?? -1);
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i] <= scores[i - 1],
      `Board not sorted descending at index ${i}: ${scores[i - 1]} -> ${scores[i]}`);
  }

  // packet.md exists and has required sections
  assert.ok(existsSync(result.files.packet_md), 'packet.md must exist');
  const md = readFileSync(result.files.packet_md, 'utf8');
  assert.ok(md.includes('## 1. Sourceability Report'));
  assert.ok(md.includes('## 2. Full Final Ranked Board'));
  assert.ok(md.includes('## 7. Weather & Race-Format Notes'));
  assert.ok(md.includes('## 8. Storyline / Tiebreaker Section'));
  assert.ok(md.includes('## 9. Tests & Proof'));
  assert.ok(md.includes('No bets or trades'));

  // source_registry.json exists
  assert.ok(existsSync(result.files.source_registry), 'source_registry.json must exist');
});

test('no driver has ceiling justified by storyline in full packet', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'indy500-nostoryline-'));
  const outputDir = join(tmpDir, 'state', 'indycar', '2026-05-25');
  const result = await composeIndy500Packet({ outputDir });
  const board = JSON.parse(readFileSync(result.files.ceiling_board, 'utf8'));
  for (const c of board.candidates) {
    assert.ok(!/storyline/i.test(c.final_ceiling_reason),
      `${c.driver_name} ceiling reason mentions storyline: "${c.final_ceiling_reason}"`);
  }
});
