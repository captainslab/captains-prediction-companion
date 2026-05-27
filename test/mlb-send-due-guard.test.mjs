// Guard tests: prove that forbidden strings and non-composite sources never
// reach Telegram via _send-due.mjs, and that publish-article-reports --send-telegram
// is permanently disabled.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEND_DUE = join(REPO, 'scripts/mlb/_send-due.mjs');
const PUBLISH_ARTICLES = join(REPO, 'scripts/mlb/publish-article-reports.mjs');

// The forbidden strings that must never appear in MLB Telegram output.
const FORBIDDEN = [
  'BOARD_ONLY', 'MARKET-ONLY', 'MARKET_ONLY', 'KXMLB',
  '¢', 'open interest', 'open_interest', ' bid', ' ask', ' volume',
];

function makeTmpState(date) {
  const root = mkdtempSync(join(tmpdir(), 'mlb-guard-test-'));
  mkdirSync(join(root, 'mlb', date), { recursive: true });
  return root;
}

function writePlan(root, date, windows) {
  const plan = {
    date,
    generated_utc: new Date().toISOString(),
    game_count: 0,
    games: [],
    report_windows: windows,
  };
  writeFileSync(join(root, 'mlb', date, 'slate-run-plan.json'), JSON.stringify(plan, null, 2));
  return join(root, 'mlb', date, 'slate-run-plan.json');
}

function writeArtifact(root, name, text) {
  const p = join(root, name);
  writeFileSync(p, text, 'utf8');
  return p;
}

function runSendDue(root, date, extraArgs = []) {
  return spawnSync(process.execPath, [
    SEND_DUE, '--state-root', root, '--date', date, ...extraArgs,
  ], { encoding: 'utf8', cwd: REPO });
}

// ─── 1. Source filter: non-composite window is skipped ───────────────────────

test('_send-due skips windows without composite source', () => {
  const date = '2099-01-01';
  const root = makeTmpState(date);
  try {
    const art = writeArtifact(root, 'legacy.txt', '★ LEAN  NYY@BOS  →  NYY  (diff: +8)\n  ↳ some reason.');
    writePlan(root, date, [{
      cluster_id: 'W01',
      idempotency_key: 'k1',
      status: 'rendered',
      last_artifact: art,
      source: 'pre-lock-report',         // NOT composite — must be skipped
      delivered_idempotency_key: null,
    }]);

    const r = runSendDue(root, date);
    assert.equal(r.status, 0, `process exited ${r.status}: ${r.stderr}`);
    assert.match(r.stdout, /no due windows to send/, 'should report nothing to send');
    assert.match(r.stdout, /skip W01/, 'should log the skip');
    assert.doesNotMatch(r.stdout, /would send|sent/, 'must not report a send');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── 2. Source filter: window with no source field is skipped ────────────────

test('_send-due skips window with no source field', () => {
  const date = '2099-01-02';
  const root = makeTmpState(date);
  try {
    const art = writeArtifact(root, 'nosrc.txt', '★ PICK  SEA@ATH  →  SEA  (diff: +12)\n  ↳ ace on mound.');
    writePlan(root, date, [{
      cluster_id: 'W02',
      idempotency_key: 'k2',
      status: 'rendered',
      last_artifact: art,
      // source field absent — must be skipped
      delivered_idempotency_key: null,
    }]);

    const r = runSendDue(root, date);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /no due windows to send/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── 3. Forbidden-string guard: KXMLB in artifact is blocked ─────────────────

test('_send-due blocks artifact containing KXMLB', () => {
  const date = '2099-01-03';
  const root = makeTmpState(date);
  try {
    const art = writeArtifact(root, 'kxmlb.txt',
      '★ PICK  TB@BAL  →  TB  (diff: +9)\n  ↳ ace signal.\nKXMLBGAME-26MAY271835TBBAL YES 51¢ / NO 50¢\n');
    writePlan(root, date, [{
      cluster_id: 'composite-refresh',
      idempotency_key: 'kx1',
      status: 'rendered',
      last_artifact: art,
      compact_artifact: art,
      source: 'late-slate-composite-refresh',
      delivered_idempotency_key: null,
    }]);

    const r = runSendDue(root, date, ['--dry-run']);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /BLOCK composite-refresh/i, 'should log BLOCK for forbidden content');
    assert.doesNotMatch(r.stdout, /would send/, 'must not report a send');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── 4. Forbidden-string guard: MARKET-ONLY in artifact is blocked ───────────

test('_send-due blocks artifact containing MARKET-ONLY', () => {
  const date = '2099-01-04';
  const root = makeTmpState(date);
  try {
    const art = writeArtifact(root, 'mktonly.txt',
      '★ LEAN  NYY@KC  →  NYY  (diff: +6)\n  ↳ signal.\n- Decision: MARKET-ONLY LEAN\n');
    writePlan(root, date, [{
      cluster_id: 'composite-refresh',
      idempotency_key: 'mo1',
      status: 'rendered',
      last_artifact: art,
      compact_artifact: art,
      source: 'late-slate-composite-refresh',
      delivered_idempotency_key: null,
    }]);

    const r = runSendDue(root, date, ['--dry-run']);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /BLOCK/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── 5. Forbidden-string guard: pricing cents symbol is blocked ───────────────

test('_send-due blocks artifact containing cent symbol', () => {
  const date = '2099-01-05';
  const root = makeTmpState(date);
  try {
    const art = writeArtifact(root, 'cents.txt',
      '★ PICK  MIA@TOR  →  TOR  (diff: +7)\n  ↳ reason.\nYES 51¢ / NO 50¢\n');
    writePlan(root, date, [{
      cluster_id: 'composite-refresh',
      idempotency_key: 'c1',
      status: 'rendered',
      last_artifact: art,
      compact_artifact: art,
      source: 'late-slate-composite-refresh',
      delivered_idempotency_key: null,
    }]);

    const r = runSendDue(root, date, ['--dry-run']);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /BLOCK/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── 6. Clean composite artifact passes guards (dry-run) ─────────────────────

test('_send-due dry-run passes clean composite artifact', () => {
  const date = '2099-01-06';
  const root = makeTmpState(date);
  try {
    const art = writeArtifact(root, 'clean.txt', [
      '=== Captain MLB — Composite Refresh 2099-01-06 ===',
      '13-layer model (market-neutral). Evidence scores only. No trades placed.',
      '',
      '★ PICK          NYY@KC     →  NYY  (diff: +14)',
      '  ↳ Gerrit Cole ERA 2.10 FIP 2.45 last 5 starts strong. vs-opp: 14 IP 1.29 ERA vs KC.',
      '',
      'Composite model — no bets placed, no trades executed.',
    ].join('\n'));
    writePlan(root, date, [{
      cluster_id: 'composite-refresh',
      idempotency_key: 'clean1',
      status: 'rendered',
      last_artifact: art,
      compact_artifact: art,
      source: 'late-slate-composite-refresh',
      delivered_idempotency_key: null,
    }]);

    const r = runSendDue(root, date, ['--dry-run']);
    assert.equal(r.status, 0, `process exited ${r.status}: ${r.stderr}`);
    assert.match(r.stdout, /\[dry-run\] would send composite-refresh/, 'should log dry-run send');
    assert.doesNotMatch(r.stderr, /BLOCK/i, 'clean artifact must not be blocked');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── 7. publish-article-reports --send-telegram is hard-blocked ──────────────

test('publish-article-reports --send-telegram exits non-zero', () => {
  // No state root needed — error is thrown before any plan is read.
  const r = spawnSync(process.execPath, [
    PUBLISH_ARTICLES, '--send-telegram', '--date', '2099-01-07',
  ], { encoding: 'utf8', cwd: REPO });
  assert.notEqual(r.status, 0, '--send-telegram should exit non-zero');
  const combined = (r.stdout ?? '') + (r.stderr ?? '');
  assert.match(combined, /disabled|composite/i, 'error should mention composite path');
});

// ─── 8. No forbidden strings in composite refresh output (dry-run) ───────────

test('late-slate-composite-refresh dry-run output contains no forbidden strings', () => {
  // Run composite refresh --dry-run against today's state (or an empty temp dir).
  // With no discovery adapters present it should output "NO CLEAR PICKS" — clean text.
  const root = mkdtempSync(join(tmpdir(), 'mlb-composite-dryrun-'));
  const date = '2099-01-08';
  mkdirSync(join(root, 'mlb', date), { recursive: true });
  try {
    const r = spawnSync(process.execPath, [
      join(REPO, 'scripts/mlb/late-slate-composite-refresh.mjs'),
      '--date', date, '--state-root', root, '--dry-run',
    ], { encoding: 'utf8', cwd: REPO });

    assert.equal(r.status, 0, `composite refresh exited ${r.status}: ${r.stderr}`);
    const output = (r.stdout ?? '') + (r.stderr ?? '');
    for (const s of FORBIDDEN) {
      assert.ok(
        !output.toLowerCase().includes(s.toLowerCase()),
        `forbidden string "${s}" found in composite refresh dry-run output`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
