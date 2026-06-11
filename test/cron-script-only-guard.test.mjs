// Guard tests for the Hermes cron fleet and the script-only packet sender.
//
// 1. No Hermes cron job may run on the Kimi coding lane: Kimi rejects
//    non-coding-agent (cron) traffic with 403 access_terminated_error.
//    Because the Hermes default provider is kimi-coding, every enabled
//    agent-mode job MUST declare an explicit non-kimi provider — a null
//    provider silently inherits the default and breaks in cron.
// 2. send-packets-telegram.mjs must plan deliveries from packet artifacts
//    only (never .inventory.txt / *.meta.json audit files), stay idempotent,
//    and exit 0 quietly when there is nothing to send.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';

import { planDeliveries, tgSendMessage } from '../scripts/packets/send-packets-telegram.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SENDER = join(REPO, 'scripts/packets/send-packets-telegram.mjs');

// ─── 1. Hermes cron provider guard ───────────────────────────────────────────

function loadHermesCronJobs() {
  const jobs = [];
  const profilesDir = join(homedir(), '.hermes', 'profiles');
  const candidates = [join(homedir(), '.hermes', 'cron', 'jobs.json')];
  if (existsSync(profilesDir)) {
    for (const entry of globSync(join(profilesDir, '*', 'cron', 'jobs.json'))) {
      candidates.push(entry);
    }
  }
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : (parsed.jobs ?? []);
    for (const j of list) jobs.push({ ...j, _source: path });
  }
  return jobs;
}

test('no enabled Hermes cron job uses the kimi coding lane', (t) => {
  const jobs = loadHermesCronJobs();
  if (!jobs.length) {
    t.skip('no Hermes cron jobs on this machine');
    return;
  }
  for (const j of jobs.filter((j) => j.enabled)) {
    const provider = `${j.provider ?? ''}`.toLowerCase();
    const model = `${j.model ?? ''}`.toLowerCase();
    const baseUrl = `${j.base_url ?? ''}`.toLowerCase();
    assert.ok(!provider.includes('kimi'), `${j.name}: provider "${j.provider}" is a kimi lane (${j._source})`);
    assert.ok(!model.includes('kimi'), `${j.name}: model "${j.model}" is a kimi model (${j._source})`);
    assert.ok(!baseUrl.includes('kimi'), `${j.name}: base_url points at kimi (${j._source})`);
  }
});

test('every enabled agent-mode Hermes cron job declares an explicit non-default provider', (t) => {
  const jobs = loadHermesCronJobs();
  if (!jobs.length) {
    t.skip('no Hermes cron jobs on this machine');
    return;
  }
  for (const j of jobs.filter((j) => j.enabled && j.no_agent !== true)) {
    assert.ok(
      j.provider,
      `${j.name}: agent-mode cron with provider=null inherits the Hermes default (kimi-coding) and will 403 in cron. ` +
      `Convert to no_agent script mode or set an explicit cron-safe provider. (${j._source})`,
    );
  }
});

// ─── 2. Packet sender behavior ───────────────────────────────────────────────

function makePacketDir(date, type = 'mentions-daily') {
  const root = mkdtempSync(join(tmpdir(), 'send-packets-test-'));
  const dir = join(root, 'packets', date, type);
  mkdirSync(dir, { recursive: true });
  return { root, dir };
}

test('planDeliveries sends chunks in order and never audit artifacts', () => {
  const date = '2099-01-01';
  const { dir } = makePacketDir(date);
  writeFileSync(join(dir, `${date}-KXTEST-EVENT.txt`), 'full packet');
  writeFileSync(join(dir, `${date}-KXTEST-EVENT.chunk-2.txt`), 'part two');
  writeFileSync(join(dir, `${date}-KXTEST-EVENT.chunk-1.txt`), 'part one');
  writeFileSync(join(dir, `${date}-KXTEST-EVENT.chunk-10.txt`), 'part ten');
  writeFileSync(join(dir, `${date}-KXTEST-EVENT.inventory.txt`), 'AUDIT ONLY');
  writeFileSync(join(dir, `${date}-KXTEST-EVENT.meta.json`), '{}');
  writeFileSync(join(dir, `${date}-KXTEST-EVENT.inventory.meta.json`), '{}');

  const plan = planDeliveries(dir, date);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].name, `${date}-KXTEST-EVENT`);
  assert.deepEqual(plan[0].files, [
    `${date}-KXTEST-EVENT.chunk-1.txt`,
    `${date}-KXTEST-EVENT.chunk-2.txt`,
    `${date}-KXTEST-EVENT.chunk-10.txt`,
  ]);
  const flat = JSON.stringify(plan);
  assert.ok(!flat.includes('inventory'), 'inventory artifacts must never be planned for delivery');
});

test('sender dry-run on no-events day plans a single status message', () => {
  const date = '2099-01-02';
  const { root, dir } = makePacketDir(date);
  writeFileSync(join(dir, `${date}-no-events.txt`), 'empty day packet');
  const r = spawnSync(process.execPath, [
    SENDER, '--type', 'mentions-daily', '--date', date, '--state-root', root, '--dry-run',
  ], { encoding: 'utf8', cwd: REPO });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /would send status: mentions-daily 2099-01-02: no events discovered/);
});

test('sender --only sends only the requested exact stem and skips future artifacts', () => {
  const date = '2099-01-02';
  const { root, dir } = makePacketDir(date);
  writeFileSync(join(dir, `${date}-KXTEST-TODAY.txt`), 'today packet');
  writeFileSync(join(dir, `${date}-KXTEST-FUTURE.txt`), 'future packet');
  writeFileSync(join(dir, `${date}-KXTEST-TODAY.meta.json`), '{}');
  writeFileSync(join(dir, `${date}-KXTEST-FUTURE.meta.json`), '{}');

  const r = spawnSync(process.execPath, [
    SENDER, '--type', 'mentions-daily', '--date', date, '--state-root', root, '--dry-run', '--only', `${date}-KXTEST-TODAY`,
  ], { encoding: 'utf8', cwd: REPO });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /would send .*2099-01-02-KXTEST-TODAY/);
  assert.doesNotMatch(r.stdout, /KXTEST-FUTURE/);
});

test('sender --only with no matching packet exits 0 and logs clearly', () => {
  const date = '2099-01-02';
  const { root } = makePacketDir(date);
  const r = spawnSync(process.execPath, [
    SENDER, '--type', 'mentions-daily', '--date', date, '--state-root', root, '--dry-run', '--only', `${date}-MISSING`,
  ], { encoding: 'utf8', cwd: REPO });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--only matched no packets — nothing to send/);
});

test('sender skips already-delivered packets via the ledger in dry-run too', () => {
  const date = '2099-01-02';
  const { root, dir } = makePacketDir(date);
  const stem = `${date}-KXTEST-ONCE`;
  writeFileSync(join(dir, `${stem}.txt`), 'packet body');
  writeFileSync(join(dir, '.delivery-ledger.json'), JSON.stringify({ delivered: { [stem]: { utc: '2099-01-02T00:00:00Z', message_ids: [1] } } }, null, 2));

  const r = spawnSync(process.execPath, [
    SENDER, '--type', 'mentions-daily', '--date', date, '--state-root', root, '--dry-run',
  ], { encoding: 'utf8', cwd: REPO });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /skipped_already_delivered=1/);
  assert.doesNotMatch(r.stdout, /would send KXTEST-ONCE/);
});

test('sender exits 0 quietly when packet directory is absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'send-packets-empty-'));
  const r = spawnSync(process.execPath, [
    SENDER, '--type', 'mentions-daily', '--date', '2099-01-03', '--state-root', root, '--dry-run',
  ], { encoding: 'utf8', cwd: REPO });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no packet directory — nothing to send/);
});

test('sender live mode without telegram env fails loudly (non-zero, stderr)', () => {
  const date = '2099-01-04';
  const { root, dir } = makePacketDir(date);
  writeFileSync(join(dir, `${date}-KXTEST-EVENT.txt`), 'packet body');
  const r = spawnSync(process.execPath, [
    SENDER, '--type', 'mentions-daily', '--date', date, '--state-root', root,
  ], {
    encoding: 'utf8',
    cwd: tmpdir(), // no .env available — telegram env must be missing
    env: { ...process.env, TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '', TELEGRAM_HOME_CHANNEL: '' },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /telegram env missing/);
});

test('tgSendMessage retries safely after Telegram 429 retry_after', async () => {
  const oldEnv = {
    token: process.env.TELEGRAM_BOT_TOKEN,
    chat: process.env.TELEGRAM_CHAT_ID,
    home: process.env.TELEGRAM_HOME_CHANNEL,
  };
  process.env.TELEGRAM_BOT_TOKEN = 'token';
  process.env.TELEGRAM_CHAT_ID = 'chat';
  delete process.env.TELEGRAM_HOME_CHANNEL;

  const calls = [];
  const sleeps = [];
  let attempt = 0;
  const fetchImpl = async () => {
    attempt += 1;
    calls.push(attempt);
    if (attempt === 1) {
      return {
        status: 429,
        json: async () => ({ ok: false, error_code: 429, parameters: { retry_after: 2 } }),
        text: async () => '',
      };
    }
    return {
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 987 } }),
      text: async () => '',
    };
  };

  try {
    const messageId = await tgSendMessage('hello', {
      fetchImpl,
      sleepImpl: async (ms) => { sleeps.push(ms); },
    });
    assert.equal(messageId, 987);
    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, [3000]);
  } finally {
    process.env.TELEGRAM_BOT_TOKEN = oldEnv.token;
    process.env.TELEGRAM_CHAT_ID = oldEnv.chat;
    if (oldEnv.home == null) delete process.env.TELEGRAM_HOME_CHANNEL;
    else process.env.TELEGRAM_HOME_CHANNEL = oldEnv.home;
  }
});
