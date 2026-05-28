// Tests for the Coca-Cola 600 publication-safe packet composer.
// Public-source snapshots. No credentials. No trading.

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

test('Coca-Cola 600 packet: writes article-ready final ceiling packet and storyline_modifier.json', async () => {
  const outputDir = makeTempOutputDir();
  const result = await composeCocaCola600Packet({ outputDir });

  const packetPath = join(outputDir, 'packet.md');
  const modifierPath = join(outputDir, 'storyline_modifier.json');
  assert.ok(existsSync(packetPath), 'packet.md should exist');
  assert.ok(existsSync(modifierPath), 'storyline_modifier.json should exist');

  const md = readFileSync(packetPath, 'utf8');
  for (const heading of [
    '# Coca-Cola 600 - Final Ceiling Board (Race Live - Pre-Race Model Snapshot)',
    '## Publication Safety Note',
    '## Final Ceiling Board (single ceiling per driver)',
    '### 1. Main scored field (Cup points top-20, in-grid)',
    '### 2. Field tail / lower-confidence entries',
    '## Final-Ceiling Evidence Ledger',
    '## Appendix: Model Inputs, Caveats, and Source Index',
    '## Market Context',
    '## Edge Basis',
    '## Storyline / Tiebreaker Context (non-scoring)',
    '## Safety',
  ]) {
    assert.ok(md.includes(heading), `missing heading: ${heading}`);
  }
  assert.ok(md.includes('Storyline does not create speed.'), 'missing storyline disclaimer');
  assert.ok(md.includes('Publication source checks:'), 'missing publication source checks');
  assert.ok(md.includes('Race status at publication check: live/in-progress'), 'missing live race status');
  assert.ok(!md.includes('fixtures-only'), 'packet must not present source mode as fixtures-only');
  assert.ok(!md.includes('Dry Run'), 'article title/body must not use Dry Run framing');
  assert.ok(md.includes('DOWNGRADED'), 'missing DOWNGRADED marker');
  assert.ok(!md.includes('## Ceiling Board (full active field)'), 'legacy four-lane board must not render in packet.md');
  assert.ok(!md.includes('Rank  Car  Driver'), 'legacy lane table must not render in packet.md');
  assert.ok(!md.includes('## Storyline Modifier'), 'storyline modifier must not lead packet.md');
  assert.ok(!md.includes('practice P0'), 'missing practice ranks must not render as practice P0');

  // Practice + qualifying lines use sourced public snapshots; qualifying must
  // be AVAILABLE and practice must be explicitly PARTIAL/AVAILABLE.
  const practiceLine = md.split('\n').find(l => l.toLowerCase().includes('practice speed'));
  const qualLine = md.split('\n').find(l => l.toLowerCase().includes('qualifying position'));
  assert.ok(qualLine && qualLine.includes('AVAILABLE'), 'qualifying position line must be AVAILABLE (sourced grid)');
  assert.ok(practiceLine && (practiceLine.includes('PARTIAL') || practiceLine.includes('AVAILABLE')),
    'practice speed line must reflect sourced (PARTIAL/AVAILABLE), not DOWNGRADED');

  // Section ordering: final board leads; storyline context stays near the bottom.
  const idxBoard = md.indexOf('## Final Ceiling Board');
  const idxLedger = md.indexOf('## Final-Ceiling Evidence Ledger');
  const idxSource = md.indexOf('## Appendix: Model Inputs, Caveats, and Source Index');
  const idxMarket = md.indexOf('## Market Context');
  const idxEdge = md.indexOf('## Edge Basis');
  const idxStory = md.indexOf('## Storyline / Tiebreaker Context');
  const idxSafety = md.indexOf('## Safety');
  assert.ok(idxBoard >= 0 && idxLedger > idxBoard, 'evidence ledger must come after final board');
  assert.ok(idxSource > idxLedger, 'source notes must come after final evidence ledger');
  assert.ok(idxMarket > idxSource, 'Market Context must come after source notes');
  assert.ok(idxEdge > idxMarket, 'Edge Basis must come after Market Context');
  assert.ok(idxStory > idxEdge, 'storyline context must come after Edge Basis');
  assert.ok(idxSafety > idxStory, 'Safety must remain after storyline context');

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
