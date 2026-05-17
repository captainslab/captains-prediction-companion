import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runOutputWriterDryRun } from '../scripts/nascar/lib/output-writer.mjs';

const REQUIRED_FILES = [
  'race_manifest.json',
  'source_registry.json',
  'discovery.json',
  'ceiling_board.json',
  'daily-nascar-guide.md',
  'run_log.md',
];

const FORBIDDEN = ['trade', 'order', 'stake', 'pick', 'recommendation', 'fair_value', 'edge', 'kelly', 'execution'];

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'nascar-writer-'));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function jsonNoForbidden(value) {
  const walk = (node, path = []) => {
    if (Array.isArray(node)) return node.forEach((it, i) => walk(it, [...path, String(i)]));
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        assert.equal(FORBIDDEN.includes(k), false, `forbidden field ${k} at ${[...path, k].join('.')}`);
        walk(v, [...path, k]);
      }
    }
  };
  walk(value);
}

test('output writer creates all six required files', async () => {
  const root = tempDir();
  try {
    const result = await runOutputWriterDryRun({ date: '2026-02-13', stateRoot: root });
    for (const name of REQUIRED_FILES) {
      const p = join(result.outputDir, name);
      assert.equal(existsSync(p), true, `missing ${name}`);
    }
  } finally {
    cleanup(root);
  }
});

test('all JSON output files parse cleanly', async () => {
  const root = tempDir();
  try {
    const result = await runOutputWriterDryRun({ date: '2026-02-13', stateRoot: root });
    const jsons = ['race_manifest.json', 'source_registry.json', 'discovery.json', 'ceiling_board.json'];
    for (const name of jsons) {
      const data = JSON.parse(readFileSync(join(result.outputDir, name), 'utf8'));
      jsonNoForbidden(data);
    }
  } finally {
    cleanup(root);
  }
});

test('markdown files contain the dry-run safety phrase', async () => {
  const root = tempDir();
  try {
    const result = await runOutputWriterDryRun({ date: '2026-02-13', stateRoot: root });
    const runLog = readFileSync(join(result.outputDir, 'run_log.md'), 'utf8');
    const guide = readFileSync(join(result.outputDir, 'daily-nascar-guide.md'), 'utf8');
    assert.match(runLog, /No trades placed by this workflow\./);
    assert.match(guide, /No trades placed by this workflow\./);
  } finally {
    cleanup(root);
  }
});

test('daily guide uses user-facing [driver_name] [ceiling] style lines', async () => {
  const root = tempDir();
  try {
    const result = await runOutputWriterDryRun({ date: '2026-02-13', stateRoot: root });
    const guide = readFileSync(join(result.outputDir, 'daily-nascar-guide.md'), 'utf8');
    const ceilingLines = guide
      .split('\n')
      .filter(l => /^- /.test(l) && !/FIELD|Longshots/i.test(l));
    assert.ok(ceilingLines.length > 0, 'guide must have at least one ceiling line');
    for (const line of ceilingLines) {
      // bullet then "Driver Name Ceiling" — e.g. "- Driver A Top 3"
      assert.match(line, /^- [^\[\]]+\s+(Win|Top 3|Top 5|Top 10|Top 20|Fastest Lap|Pass)$/);
    }
    // FIELD bucket appears only as a summary line, not per-driver.
    assert.match(guide, /FIELD \/ Longshots:/);
  } finally {
    cleanup(root);
  }
});

test('race_manifest captures event_format and special_event_override status', async () => {
  const root = tempDir();
  try {
    const result = await runOutputWriterDryRun({
      date: '2026-02-13',
      eventFormat: 'all_star',
      stateRoot: root,
    });
    const manifest = JSON.parse(readFileSync(join(result.outputDir, 'race_manifest.json'), 'utf8'));
    assert.equal(manifest.event_format, 'all_star');
    assert.equal(manifest.special_event_override.active, true);
    assert.ok(Array.isArray(manifest.supported_market_lanes));
    assert.ok(manifest.run_metadata);
    assert.equal(manifest.run_metadata.mode, 'fixtures-only');
  } finally {
    cleanup(root);
  }
});

test('source_registry summarizes Stage 2 envelopes and source health', async () => {
  const root = tempDir();
  try {
    const result = await runOutputWriterDryRun({ date: '2026-02-13', stateRoot: root });
    const reg = JSON.parse(readFileSync(join(result.outputDir, 'source_registry.json'), 'utf8'));
    assert.ok(reg.sources, 'sources block exists');
    for (const [id, info] of Object.entries(reg.sources)) {
      assert.ok(info.source_id);
      assert.ok(typeof info.status === 'string');
      assert.equal(typeof info.record_count, 'number');
    }
  } finally {
    cleanup(root);
  }
});

test('output writer is deterministic across runs', async () => {
  const a = tempDir();
  const b = tempDir();
  try {
    const ra = await runOutputWriterDryRun({ date: '2026-02-13', stateRoot: a, frozenCheckedAtUtc: '2026-02-13T12:00:00.000Z' });
    const rb = await runOutputWriterDryRun({ date: '2026-02-13', stateRoot: b, frozenCheckedAtUtc: '2026-02-13T12:00:00.000Z' });
    for (const name of ['race_manifest.json', 'discovery.json', 'ceiling_board.json', 'source_registry.json']) {
      const ja = readFileSync(join(ra.outputDir, name), 'utf8');
      const jb = readFileSync(join(rb.outputDir, name), 'utf8');
      assert.equal(ja, jb, `${name} should be deterministic`);
    }
  } finally {
    cleanup(a);
    cleanup(b);
  }
});
