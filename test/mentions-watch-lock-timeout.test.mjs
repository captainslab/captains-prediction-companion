import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  watch,
  ledgerPath,
  loadLedger,
  runLockPath,
  acquireRunLock,
  releaseRunLock,
  runStep,
} from '../scripts/mentions/mentions-watch.mjs';
import { describeMentionsHermesInvocation } from '../scripts/packets/generate-mentions-daily.mjs';

const DATE = '2026-06-11';

function ev(ticker) {
  return { event_ticker: ticker, title: ticker, markets: [] };
}

function deadPid() {
  // A freshly reaped pid: almost certainly not alive (and not ours).
  const r = spawnSync('true');
  return r.pid;
}

function writeLock(path, pid) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ pid, started_utc: new Date().toISOString() }));
}

// ─── single-run lock ──────────────────────────────────────────────────────────

test('overlap lock: a second watch run exits cleanly as already-running and touches nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mw-lock-'));
  const eventsFile = join(root, 'events.json');
  writeFileSync(eventsFile, JSON.stringify([ev('KXHEARINGMENTION-26JUN11')]));
  // Live holder: our own pid.
  writeLock(runLockPath(root, DATE), process.pid);

  const result = await watch({ date: DATE, stateRoot: root, eventsFile });

  assert.equal(result.skipped, 'already-running');
  assert.deepEqual(result.attempted, []);
  assert.ok(!existsSync(ledgerPath(root, DATE)), 'overlapped run must not create a ledger');
  // Lock is still held by the original runner — the skipped run must not steal it.
  assert.ok(existsSync(runLockPath(root, DATE)), 'overlapped run must not remove the holder lock');
});

test('stale lock (dead pid) is recovered and the run proceeds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mw-stale-'));
  const lockPath = runLockPath(root, DATE);
  writeLock(lockPath, deadPid());

  const lock = acquireRunLock(lockPath);
  assert.equal(lock.acquired, true, 'dead-pid lock must be treated as stale and recovered');
  releaseRunLock(lockPath);
  assert.ok(!existsSync(lockPath));

  // Full watch run proceeds past a stale lock.
  writeLock(lockPath, deadPid());
  const eventsFile = join(root, 'events.json');
  writeFileSync(eventsFile, JSON.stringify([ev('KXFUTUREMENTION-26JUN13')]));
  const result = await watch({ date: DATE, stateRoot: root, eventsFile });
  assert.notEqual(result.skipped, 'already-running');
  assert.ok(!existsSync(lockPath), 'lock must be released after the run');
});

test('lock is released even when discovery throws', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mw-release-'));
  await assert.rejects(
    watch({ date: DATE, stateRoot: root, eventsFile: join(root, 'missing.json') }),
  );
  assert.ok(!existsSync(runLockPath(root, DATE)), 'lock must not leak after a crash');
});

// ─── per-step timeout with process-group cleanup ─────────────────────────────

test('generator timeout kills the whole child process group, including grandchildren', () => {
  const root = mkdtempSync(join(tmpdir(), 'mw-timeout-'));
  const pidFile = join(root, 'grandchild.pid');
  assert.throws(
    () => runStep(
      'generator:KXSLOW',
      'bash',
      ['-c', `sleep 60 & echo $! > "${pidFile}"; sleep 60`],
      { timeoutMs: 1000 },
    ),
    /generator:KXSLOW timed out/,
  );
  const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
  assert.ok(grandchild > 0);
  // Give the kernel a beat, then the grandchild must be gone.
  assert.throws(
    () => process.kill(grandchild, 0),
    { code: 'ESRCH' },
    `grandchild ${grandchild} must be killed with the process group`,
  );
});

test('sender timeout blocks the event: no delivery, blocker artifact, ledger not delivered', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mw-sender-timeout-'));
  const eventsFile = join(root, 'events.json');
  writeFileSync(eventsFile, JSON.stringify([ev('KXHEARINGMENTION-26JUN11')]));

  const calls = [];
  const result = await watch({
    date: DATE,
    stateRoot: root,
    eventsFile,
    runStepImpl: (label, command, args) => {
      calls.push(label);
      if (label.startsWith('generator:')) {
        const stem = `${DATE}-${args[args.indexOf('--only') + 1]}`;
        const dir = join(root, 'packets', DATE, 'mentions-daily');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${stem}.txt`), 'packet');
        return { status: 0 };
      }
      throw new Error(`${label} timed out after 900s (child process group killed)`);
    },
  });

  assert.deepEqual(result.failed, ['KXHEARINGMENTION-26JUN11']);
  assert.deepEqual(result.succeeded, []);
  const rec = loadLedger(ledgerPath(root, DATE)).events['KXHEARINGMENTION-26JUN11'];
  assert.equal(rec.status, 'blocked');
  assert.equal(rec.delivered_at, null, 'timed-out send must never be marked delivered');
  assert.ok(rec.blocker_path && existsSync(rec.blocker_path));
  assert.match(JSON.parse(readFileSync(rec.blocker_path, 'utf8')).error, /timed out/);
});

test('generator timeout on one event writes a blocker and the run continues to the next event', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mw-gen-timeout-'));
  const eventsFile = join(root, 'events.json');
  writeFileSync(eventsFile, JSON.stringify([ev('KXSLOWMENTION-26JUN11'), ev('KXOKMENTION-26JUN11')]));

  const result = await watch({
    date: DATE,
    stateRoot: root,
    eventsFile,
    runStepImpl: (label, command, args) => {
      if (label === 'generator:KXSLOWMENTION-26JUN11') {
        throw new Error(`${label} timed out after 900s (child process group killed)`);
      }
      if (label.startsWith('generator:')) {
        const stem = `${DATE}-${args[args.indexOf('--only') + 1]}`;
        const dir = join(root, 'packets', DATE, 'mentions-daily');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${stem}.txt`), 'packet');
      }
      return { status: 0 };
    },
  });

  assert.deepEqual(result.failed, ['KXSLOWMENTION-26JUN11']);
  assert.deepEqual(result.succeeded, ['KXOKMENTION-26JUN11']);
  const ledger = loadLedger(ledgerPath(root, DATE));
  assert.equal(ledger.events['KXSLOWMENTION-26JUN11'].status, 'blocked');
  assert.equal(ledger.events['KXOKMENTION-26JUN11'].status, 'delivered');
});

// ─── no-agent cron + dynamic Hermes defaults ─────────────────────────────────

test('watch steps are script-only (no agent CLI) and Hermes synthesis inherits dynamic defaults', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mw-noagent-'));
  const eventsFile = join(root, 'events.json');
  writeFileSync(eventsFile, JSON.stringify([ev('KXHEARINGMENTION-26JUN11')]));

  const calls = [];
  await watch({
    date: DATE,
    stateRoot: root,
    eventsFile,
    runStepImpl: (label, command, args) => {
      calls.push({ label, command, args });
      if (label.startsWith('generator:')) {
        const stem = `${DATE}-${args[args.indexOf('--only') + 1]}`;
        const dir = join(root, 'packets', DATE, 'mentions-daily');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${stem}.txt`), 'packet');
      }
      return { status: 0 };
    },
  });

  for (const c of calls) {
    assert.equal(c.command, process.execPath, 'every watch step must be a plain node script');
    assert.match(c.args[0], /^scripts\/.*\.mjs$/, 'every watch step must invoke a repo script');
    const joined = c.args.join(' ');
    assert.ok(!/--provider|-m |--model|claude|copilot|codex/.test(joined), 'no agent CLI or hardcoded provider/model in cron steps');
  }

  const invocation = describeMentionsHermesInvocation();
  assert.equal(invocation.provider_arg, 'omitted');
  assert.equal(invocation.model_arg, 'omitted');
  assert.match(invocation.note, /runtime default/);
});

// ─── incremental ledger persistence (600s external kill survival) ───────────

test('ledger is persisted after EACH event so an externally killed run never repeats delivered work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mw-incremental-'));
  const eventsFile = join(root, 'events.json');
  writeFileSync(eventsFile, JSON.stringify([ev('KXAMENTION-26JUN11'), ev('KXBMENTION-26JUN11')]));

  const seenAtSecondEvent = [];
  await watch({
    date: DATE,
    stateRoot: root,
    eventsFile,
    runStepImpl: (label, command, args) => {
      if (label === 'generator:KXBMENTION-26JUN11') {
        // By the time event B starts, event A's delivery must already be durable
        // on disk — a SIGKILL here must not lose A's seen/delivered state.
        const onDisk = loadLedger(ledgerPath(root, DATE));
        seenAtSecondEvent.push(onDisk.events['KXAMENTION-26JUN11']?.status ?? 'missing');
      }
      if (label.startsWith('generator:')) {
        const stem = `${DATE}-${args[args.indexOf('--only') + 1]}`;
        const dir = join(root, 'packets', DATE, 'mentions-daily');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${stem}.txt`), 'packet');
      }
      return { status: 0 };
    },
  });

  assert.deepEqual(seenAtSecondEvent, ['delivered'], 'first event must be durably recorded before the second event starts');
});
