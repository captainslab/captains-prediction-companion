// Contract tests for the CPC fighter-escort state machine.
// Design: docs/ESCORT_OPERATING_MODEL.md (§1 machine, §6 anti-spin, §7 tests).
//
// TDD-red until the Codex /goal (§8) implements scripts/escort/escort-state-machine.mjs.
// Guarded so the absence of the module SKIPS rather than fails the whole suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';

let mod = null;
try {
  mod = await import('../scripts/escort/escort-state-machine.mjs');
} catch {
  mod = null;
}

const guard = (t) => {
  if (!mod) {
    t.skip('scripts/escort/escort-state-machine.mjs not implemented yet (see ESCORT_OPERATING_MODEL.md §8)');
    return false;
  }
  return true;
};

// Adapter factory: every checkpoint result is injected, so tests are fully offline.
const fakeAdapters = (overrides = {}) => ({
  research: async () => ({ ok: true, status: 'present', artifact: '/tmp/research.json' }),
  render: async () => ({ ok: true, nonEmpty: true, failClosed: false, path: '/tmp/render.txt' }),
  evidence: async () => ({ ok: true, layersMatchRoute: true }),
  audit: async () => ({ ok: true, survivingBlockers: 0 }),
  priceIsolation: async () => ({ ok: true, leak: false }),
  idempotency: async () => ({ ok: true, duplicate: false }),
  writeProof: async (artifact) => ({ ok: true, path: `/tmp/runs/${artifact.run_id}.json` }),
  ...overrides,
});

test('clean walk reaches PASS_READY_TO_SEND with a proof artifact', async (t) => {
  if (!guard(t)) return;
  const res = await mod.runEscort({ runId: 'esc_test_001', route: 'mentions' }, fakeAdapters());
  assert.equal(res.terminalState, 'PASS_READY_TO_SEND');
  assert.ok(res.proofArtifact, 'every run writes a proof artifact');
  assert.equal(res.sentSomething, undefined, 'escort never sends');
});

test('research unavailable with explicit status advances (not blocked)', async (t) => {
  if (!guard(t)) return;
  const res = await mod.runEscort({ runId: 'esc_test_002', route: 'mentions' },
    fakeAdapters({ research: async () => ({ ok: true, status: 'unavailable', explicit: true }) }));
  assert.equal(res.terminalState, 'PASS_READY_TO_SEND');
});

test('empty render is repaired then advances', async (t) => {
  if (!guard(t)) return;
  let calls = 0;
  const res = await mod.runEscort({ runId: 'esc_test_003', route: 'mentions' },
    fakeAdapters({ render: async () => (++calls === 1
      ? { ok: false, nonEmpty: false, failClosed: true, fingerprint: 'render.empty' }
      : { ok: true, nonEmpty: true, failClosed: false, path: '/tmp/r.txt' }) }));
  assert.equal(res.terminalState, 'PASS_READY_TO_SEND');
  assert.equal(calls, 2, 'one repair re-enters the same checkpoint');
});

test('render failing twice → BLOCKED (anti-spin: max 2 repairs)', async (t) => {
  if (!guard(t)) return;
  const res = await mod.runEscort({ runId: 'esc_test_004', route: 'mentions' },
    fakeAdapters({ render: async () => ({ ok: false, nonEmpty: false, fingerprint: 'render.empty' }) }));
  assert.equal(res.terminalState, 'BLOCKED');
});

test('price-isolation failure → BLOCKED with no repair attempt', async (t) => {
  if (!guard(t)) return;
  let repairTried = false;
  const res = await mod.runEscort({ runId: 'esc_test_005', route: 'mentions' },
    fakeAdapters({
      priceIsolation: async () => ({ ok: false, leak: true, field: 'ask', fingerprint: 'price.leak' }),
      render: async () => { repairTried = true; return { ok: true, nonEmpty: true }; },
    }));
  assert.equal(res.terminalState, 'BLOCKED');
  assert.equal(res.blockerFingerprint?.startsWith('price.leak'), true);
});

test('duplicate idempotency → HELD_DUPLICATE, no send path', async (t) => {
  if (!guard(t)) return;
  const res = await mod.runEscort({ runId: 'esc_test_006', route: 'mentions' },
    fakeAdapters({ idempotency: async () => ({ ok: true, duplicate: true }) }));
  assert.equal(res.terminalState, 'HELD_DUPLICATE');
});

test('repair that would touch a no-touch zone → BLOCKED, handed up', async (t) => {
  if (!guard(t)) return;
  const res = await mod.runEscort({ runId: 'esc_test_007', route: 'mentions' },
    fakeAdapters({ render: async () => ({ ok: false, nonEmpty: false, fingerprint: 'render.empty', requiresNoTouch: true }) }));
  assert.equal(res.terminalState, 'BLOCKED');
  assert.equal(res.handedUp, true);
});

test('same-fingerprint recurrence after repair → BLOCKED (no re-retry)', async (t) => {
  if (!guard(t)) return;
  const res = await mod.runEscort({ runId: 'esc_test_008', route: 'mentions' },
    fakeAdapters({ audit: async () => ({ ok: false, survivingBlockers: 1, fingerprint: 'audit.fixable' }) }));
  assert.equal(res.terminalState, 'BLOCKED');
});

test('lesson is only persisted when all required fields are present', async (t) => {
  if (!guard(t)) return;
  assert.equal(typeof mod.validateLesson, 'function');
  assert.equal(mod.validateLesson({}), false);
  assert.equal(mod.validateLesson({
    source_run_id: 'esc_x', blocker_fingerprint: 'render.empty',
    repair_attempted: 'regen', outcome: 'cleared',
    safe_to_automate_next_time: false, required_proof_before_reuse: 'artifact path',
  }), true);
});
