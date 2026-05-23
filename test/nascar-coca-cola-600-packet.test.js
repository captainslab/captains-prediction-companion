// Tests for the Coca-Cola 600 dry-run packet composer.
// Fixtures-only. No live network. No credentials. No trading.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeCocaCola600Packet } from '../scripts/nascar/lib/coca-cola-600-packet.mjs';
import { composeStorylineModifier } from '../scripts/nascar/lib/storyline-modifier.mjs';
import { cocaCola600StorylineFixture } from '../scripts/nascar/lib/storyline-fixtures.mjs';

function makeTempOutputDir() {
  const root = mkdtempSync(join(tmpdir(), 'cc600-packet-'));
  return join(root, 'state', 'nascar', '2026-05-25');
}

test('Coca-Cola 600 packet: writes packet.md with six section headings, downgrades, and storyline_modifier.json', async () => {
  const outputDir = makeTempOutputDir();
  const result = await composeCocaCola600Packet({ outputDir });

  const packetPath = join(outputDir, 'packet.md');
  const modifierPath = join(outputDir, 'storyline_modifier.json');
  assert.ok(existsSync(packetPath), 'packet.md should exist');
  assert.ok(existsSync(modifierPath), 'storyline_modifier.json should exist');

  const md = readFileSync(packetPath, 'utf8');
  for (const heading of [
    '# Coca-Cola 600 — NASCAR Research Packet (Dry Run)',
    '## Base Fundamentals',
    '## Storyline Modifier',
    '## Market Context',
    '## Edge Basis',
    '## Safety',
  ]) {
    assert.ok(md.includes(heading), `missing heading: ${heading}`);
  }
  assert.ok(md.includes('Storyline does not create speed.'), 'missing storyline disclaimer');
  assert.ok(md.includes('DOWNGRADED'), 'missing DOWNGRADED marker');

  // Practice + qualifying lines now use sourced data (Wikipedia 2026 Coca-Cola 600);
  // qualifying must be AVAILABLE and practice PARTIAL (top-3 only published).
  const practiceLine = md.split('\n').find(l => l.toLowerCase().includes('practice speed'));
  const qualLine = md.split('\n').find(l => l.toLowerCase().includes('qualifying position'));
  assert.ok(qualLine && qualLine.includes('AVAILABLE'), 'qualifying position line must be AVAILABLE (sourced grid)');
  assert.ok(practiceLine && (practiceLine.includes('PARTIAL') || practiceLine.includes('AVAILABLE')),
    'practice speed line must reflect sourced (PARTIAL/AVAILABLE), not DOWNGRADED');

  // Section ordering: Base Fundamentals -> Storyline Modifier -> Market Context
  const idxBase = md.indexOf('## Base Fundamentals');
  const idxStory = md.indexOf('## Storyline Modifier');
  const idxMarket = md.indexOf('## Market Context');
  assert.ok(idxBase >= 0 && idxStory > idxBase, 'Storyline Modifier must come after Base Fundamentals');
  assert.ok(idxMarket > idxStory, 'Market Context must come after Storyline Modifier');

  const modifier = JSON.parse(readFileSync(modifierPath, 'utf8'));
  assert.equal(modifier.schema_version, 'nascar_storyline_modifier_v1');
  assert.notEqual(modifier.posture_hint, 'PICK');
  assert.notEqual(modifier.posture_hint, 'EVIDENCE_LEAN');

  // The composer leaves base fundamentals neutral/degraded, so delta must be 0.
  assert.equal(modifier.true_win_modifier.delta_probability, 0,
    'dry-run packet should have delta_probability=0 under degraded fundamentals');
});

test('composeStorylineModifier: strong base (eq=85, dac=80) + tribute storyline -> delta_probability in (0, 0.04]', () => {
  const storyline = cocaCola600StorylineFixture();
  const baseFundamentals = {
    driver_name: 'Strong Driver',
    car_number: 99,
    equipment_quality: 85,
    driver_ability_to_convert: 80,
    overpricing_penalty: 0,
  };
  const out = composeStorylineModifier({
    storyline,
    baseFundamentals,
    eventContext: { race_name: 'Coca-Cola 600' },
  });
  assert.ok(out.true_win_modifier.delta_probability > 0, 'should be > 0 with strong base + strong storyline');
  assert.ok(out.true_win_modifier.delta_probability <= 0.04, 'must be capped at +0.04');
  assert.notEqual(out.posture_hint, 'PICK');
  assert.notEqual(out.posture_hint, 'EVIDENCE_LEAN');
});

test('composeStorylineModifier: weak base (eq=40, dac=40) + high storyline -> delta=0 and posture WATCH or MARKET_REPRICING_ALERT', () => {
  // Boost score-driving inputs so storyline_score >= 80 and posture branch
  // moves out of TIEBREAKER_ONLY (which is the [50,80) bucket).
  const storyline = {
    ...cocaCola600StorylineFixture(),
    timing_proximity_days: 0,
    distraction_pressure_risk: 0,
    track_relevance: 100,
    team_car_relevance: 100,
  };
  const baseFundamentals = {
    driver_name: 'Weak Driver',
    car_number: 77,
    equipment_quality: 40,
    driver_ability_to_convert: 40,
    overpricing_penalty: 0,
  };
  const out = composeStorylineModifier({
    storyline,
    baseFundamentals,
    eventContext: { race_name: 'Coca-Cola 600' },
  });
  assert.equal(out.true_win_modifier.delta_probability, 0, 'weak base must block delta entirely');
  assert.ok(
    out.posture_hint === 'WATCH' || out.posture_hint === 'MARKET_REPRICING_ALERT',
    `expected WATCH or MARKET_REPRICING_ALERT, got ${out.posture_hint}`,
  );
});
