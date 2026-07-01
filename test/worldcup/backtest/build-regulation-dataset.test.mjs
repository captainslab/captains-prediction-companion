import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRegulationDataset } from '../../../scripts/worldcup/backtest/build-regulation-dataset.mjs';

test('builds records with W/D/L outcome from a sample TSV', () => {
  const tsv = readFileSync(new URL('./fixtures/results-sample.tsv', import.meta.url), 'utf8');
  const ds = buildRegulationDataset([tsv]);
  assert.ok(ds.records.length >= 3);
  const draw = ds.records.find(r => r.outcome === 'draw');
  assert.ok(draw && draw.homeElo > 0 && draw.awayElo > 0);
  assert.ok(['home', 'draw', 'away'].includes(ds.records[0].outcome));
});
