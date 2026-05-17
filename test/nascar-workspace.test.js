import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runNascarWorkspace } from '../scripts/nascar/nascar-workspace.mjs';

const REQUIRED_FILES = [
  'race_manifest.json',
  'source_registry.json',
  'discovery.json',
  'ceiling_board.json',
  'daily-nascar-guide.md',
  'run_log.md',
];

const JSON_FILES = [
  'race_manifest.json',
  'source_registry.json',
  'discovery.json',
  'ceiling_board.json',
];

const FORBIDDEN = [
  'trade',
  'order',
  'stake',
  'pick',
  'recommendation',
  'fair_value',
  'edge',
  'kelly',
  'execution',
];

function tempStateRoot() {
  return mkdtempSync(join(tmpdir(), 'nascar-workspace-'));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function readJson(outputDir, name) {
  return JSON.parse(readFileSync(join(outputDir, name), 'utf8'));
}

function assertNoForbiddenJsonFields(value) {
  const walk = (node, path = []) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, [...path, String(index)]));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        assert.equal(FORBIDDEN.includes(key), false, `forbidden field ${key} at ${[...path, key].join('.')}`);
        walk(child, [...path, key]);
      }
    }
  };
  walk(value);
}

async function runWorkspace(eventFormat = 'points') {
  const root = tempStateRoot();
  const summary = await runNascarWorkspace({
    date: '2026-02-13',
    eventFormat,
    fixturesOnly: true,
    stateRoot: root,
  });
  return { root, summary };
}

function runWorkspaceCli(eventFormat = 'points') {
  const root = tempStateRoot();
  const stdout = execFileSync(
    process.execPath,
    [
      'scripts/nascar/nascar-workspace.mjs',
      '--date',
      '2026-02-13',
      '--event-format',
      eventFormat,
      '--fixtures-only',
      '--state-root',
      root,
    ],
    { encoding: 'utf8' },
  );
  return { root, summary: JSON.parse(stdout) };
}

test('workspace command runs points fixture end-to-end', () => {
  const { root, summary } = runWorkspaceCli('points');
  try {
    assert.equal(summary.run_date, '2026-02-13');
    assert.equal(summary.event_format, 'points');
    assert.equal(summary.no_trades, true);
    assert.equal(summary.special_event_override, false);
    assert.equal(summary.files.length, REQUIRED_FILES.length);
    assert.ok(summary.ceilings_count > 0);
    assert.equal(typeof summary.field_count, 'number');
    assert.ok(summary.output_dir.endsWith('/nascar/2026-02-13'));
  } finally {
    cleanup(root);
  }
});

test('workspace command runs all_star fixture end-to-end', () => {
  const { root, summary } = runWorkspaceCli('all_star');
  try {
    assert.equal(summary.run_date, '2026-02-13');
    assert.equal(summary.event_format, 'all_star');
    assert.equal(summary.no_trades, true);
    assert.equal(summary.special_event_override, true);
    assert.ok(summary.ceilings_count > 0);
    assert.equal(typeof summary.field_count, 'number');
  } finally {
    cleanup(root);
  }
});

test('all six expected output files exist', async () => {
  const { root, summary } = await runWorkspace('points');
  try {
    for (const name of REQUIRED_FILES) {
      assert.equal(existsSync(join(summary.output_dir, name)), true, `missing ${name}`);
      assert.ok(summary.files.includes(join(summary.output_dir, name)), `summary missing ${name}`);
    }
  } finally {
    cleanup(root);
  }
});

test('JSON outputs parse and contain no forbidden trade runtime fields', async () => {
  const { root, summary } = await runWorkspace('points');
  try {
    for (const name of JSON_FILES) {
      const parsed = readJson(summary.output_dir, name);
      assertNoForbiddenJsonFields(parsed);
    }
  } finally {
    cleanup(root);
  }
});

test('daily guide contains driver ceiling lines', async () => {
  const { root, summary } = await runWorkspace('points');
  try {
    const guide = readFileSync(join(summary.output_dir, 'daily-nascar-guide.md'), 'utf8');
    const ceilingLines = guide
      .split('\n')
      .filter(line => /^- [^\[\]]+\s+(Win|Top 3|Top 5|Top 10|Top 20|Fastest Lap|Pass)$/.test(line));
    assert.ok(ceilingLines.length > 0, 'guide must include driver ceiling lines');
  } finally {
    cleanup(root);
  }
});

test('run_log contains no-trades proof', async () => {
  const { root, summary } = await runWorkspace('points');
  try {
    const runLog = readFileSync(join(summary.output_dir, 'run_log.md'), 'utf8');
    assert.match(runLog, /No trades placed by this workflow\./);
  } finally {
    cleanup(root);
  }
});
