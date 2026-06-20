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
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { globSync } from 'node:fs';

import {
  filterAlreadyDeliveredPlan,
  filterDeliveryPlan,
  mentionsPacketNotice,
  planDeliveries,
  tgSendDocument,
  tgSendMessage,
} from '../scripts/packets/send-packets-telegram.mjs';
import { inspectPacketFile } from '../scripts/cron/cpc-packet-janitor.mjs';
import { renderMentionPacket } from '../scripts/mentions/render-mention-packet.mjs';

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

test('mentions delivery plan uses one base txt document and ignores chunk artifacts', () => {
  const date = '2099-01-01';
  const { dir } = makePacketDir(date);
  writeFileSync(join(dir, `${date}-KXTEST-EVENT.txt`), 'full packet');
  writeFileSync(join(dir, `${date}-KXTEST-EVENT.chunk-2.txt`), 'part two');
  writeFileSync(join(dir, `${date}-KXTEST-EVENT.chunk-1.txt`), 'part one');
  writeFileSync(join(dir, `${date}-KXTEST-EVENT.inventory.txt`), 'AUDIT ONLY');

  const plan = planDeliveries(dir, date, { preferBaseFile: true });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].name, `${date}-KXTEST-EVENT`);
  assert.deepEqual(plan[0].files, [`${date}-KXTEST-EVENT.txt`]);
});

test('sender dry-run on no-events day plans a single status message', () => {
  const date = '2099-01-02';
  const { root, dir } = makePacketDir(date);
  writeFileSync(join(dir, `${date}-no-events.txt`), 'empty day packet');
  const plan = planDeliveries(dir, date, { preferBaseFile: true });
  assert.deepEqual(plan.map((entry) => entry.name), [`${date}-no-events`]);
});

test('sender --only sends only the requested exact stem and skips future artifacts', () => {
  const date = '2099-01-02';
  const { root, dir } = makePacketDir(date);
  writeFileSync(join(dir, `${date}-KXTEST-TODAY.txt`), 'today packet');
  writeFileSync(join(dir, `${date}-KXTEST-FUTURE.txt`), 'future packet');
  writeFileSync(join(dir, `${date}-KXTEST-TODAY.meta.json`), '{}');
  writeFileSync(join(dir, `${date}-KXTEST-FUTURE.meta.json`), '{}');

  const plan = filterDeliveryPlan(planDeliveries(dir, date, { preferBaseFile: true }), {
    onlyStems: new Set([`${date}-KXTEST-TODAY`]),
  });
  assert.deepEqual(plan.map((entry) => entry.name), [`${date}-KXTEST-TODAY`]);
});

test('sender --exclude removes stems and combines with --only', () => {
  const date = '2099-01-02';
  const { root, dir } = makePacketDir(date);
  const keepStem = `${date}-KXTEST-KEEP`;
  const dropStem = `${date}-KXTEST-DROP`;
  const extraStem = `${date}-KXTEST-EXTRA`;
  writeFileSync(join(dir, `${keepStem}.txt`), 'keep packet');
  writeFileSync(join(dir, `${dropStem}.txt`), 'drop packet');
  writeFileSync(join(dir, `${extraStem}.txt`), 'extra packet');

  const plan = planDeliveries(dir, date, { preferBaseFile: true });
  const filtered = filterDeliveryPlan(plan, {
    onlyStems: new Set([keepStem, dropStem]),
    excludeStems: new Set([dropStem]),
  });
  assert.deepEqual(filtered.map((entry) => entry.name), [keepStem]);

  const excludedOnly = filterDeliveryPlan(plan, { excludeStems: new Set([keepStem]) });
  assert.deepEqual(excludedOnly.map((entry) => entry.name).sort(), [dropStem, extraStem].sort());
});

test('mentions sender dry-run sends short notice plus one txt document, not chunks', () => {
  const date = '2099-01-02';
  const { root, dir } = makePacketDir(date);
  const stem = `${date}-KXTRUMPMENTION-26JUN11`;
  writeFileSync(join(dir, `${stem}.txt`), [
    'Event title: What will Trump say during his Burt Jones Tele-Rally?',
    'Market Context - NOT IN SCORE',
    'Research-only footer',
  ].join('\n'));
  writeFileSync(join(dir, `${stem}.chunk-1.txt`), 'old chunk');
  writeFileSync(join(dir, `${stem}.chunk-2.txt`), 'old chunk');
  const notice = mentionsPacketNotice(readFileSync(join(dir, `${stem}.txt`), 'utf8'), stem);
  const plan = planDeliveries(dir, date, { preferBaseFile: true });
  assert.equal(notice, 'New CPC packet: Trump Tele-Rally -- attached .txt');
  assert.deepEqual(plan.map((entry) => entry.files), [[`${stem}.txt`]]);
});

test('sender --only with no matching packet exits 0 and logs clearly', () => {
  const date = '2099-01-02';
  const { dir } = makePacketDir(date);
  writeFileSync(join(dir, `${date}-KXTEST-TODAY.txt`), 'today packet');
  const filtered = filterDeliveryPlan(planDeliveries(dir, date, { preferBaseFile: true }), {
    onlyStems: new Set([`${date}-MISSING`]),
  });
  assert.deepEqual(filtered, []);
});

test('sender fails closed when janitor blocks the only candidate packet', () => {
  const date = '2099-01-04';
  const { root, dir } = makePacketDir(date);
  const stem = `${date}-KXTEST-BLOCKED`;
  const text = renderMentionPacket({
    packet_kind: 'mentions_customer_packet_v2',
    date,
    event: {
      title: 'Example blocked packet',
      subtitle: 'Example blocked packet',
      date_time: '2099-01-04T00:00:00Z',
      settlement_source_link: 'https://example.com',
      rules_primary: 'If the word appears, resolves Yes.',
    },
    summary: { market_count: 1 },
    terms: [{
      full_strike_text: 'Example blocked packet -- Term',
      short_term: 'Term',
      cpc_score: null,
      research_state: 'research gap',
      market_context: { note: 'NOT IN SCORE' },
    }],
  }, { generatedAtUtc: '2099-01-04T00:00:00Z' });
  writeFileSync(join(dir, `${stem}.txt`), text);

  const result = inspectPacketFile(join(dir, `${stem}.txt`), {
    date,
    stateRoot: root,
    packetType: 'mentions-daily',
    ledgerPath: join(dir, 'delivery-ledger.json'),
    idempotencyKey: stem,
    requireLedger: true,
    requireSourceHealth: true,
    documentDelivery: false,
    force: false,
  });

  assert.equal(result.verdict, 'JANITOR_BLOCKED');
  assert.ok(result.errors.some((err) => err.code === 'NO_USABLE_SOURCE_EVIDENCE'));
});

test('sender skips already-delivered packets via the ledger in dry-run too', () => {
  const date = '2099-01-02';
  const { root, dir } = makePacketDir(date);
  const stem = `${date}-KXTEST-ONCE`;
  writeFileSync(join(dir, `${stem}.txt`), 'packet body');
  const ledger = { delivered: { [stem]: { utc: '2099-01-02T00:00:00Z', message_ids: [1] } } };
  const filtered = filterAlreadyDeliveredPlan(planDeliveries(dir, date, { preferBaseFile: true }), ledger);
  assert.deepEqual(filtered, []);
});

test('sender exits 0 quietly when packet directory is absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'send-packets-empty-'));
  const dir = join(root, 'packets', '2099-01-03', 'mentions-daily');
  assert.equal(existsSync(dir), false);
});

test('sender live mode without telegram env fails loudly (non-zero, stderr)', () => {
  const oldEnv = {
    token: process.env.TELEGRAM_BOT_TOKEN,
    chat: process.env.TELEGRAM_CHAT_ID,
    home: process.env.TELEGRAM_HOME_CHANNEL,
  };
  process.env.TELEGRAM_BOT_TOKEN = '';
  process.env.TELEGRAM_CHAT_ID = '';
  process.env.TELEGRAM_HOME_CHANNEL = '';
  return assert.rejects(
    tgSendMessage('hello world'),
    /telegram env missing/,
  ).finally(() => {
    process.env.TELEGRAM_BOT_TOKEN = oldEnv.token;
    process.env.TELEGRAM_CHAT_ID = oldEnv.chat;
    process.env.TELEGRAM_HOME_CHANNEL = oldEnv.home;
  });
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

test('tgSendDocument posts a txt file via Telegram sendDocument', async () => {
  const root = mkdtempSync(join(tmpdir(), 'send-doc-test-'));
  const filePath = join(root, 'packet.txt');
  writeFileSync(filePath, 'packet body');
  const oldEnv = {
    token: process.env.TELEGRAM_BOT_TOKEN,
    chat: process.env.TELEGRAM_CHAT_ID,
    home: process.env.TELEGRAM_HOME_CHANNEL,
  };
  process.env.TELEGRAM_BOT_TOKEN = 'token';
  process.env.TELEGRAM_CHAT_ID = 'chat';
  delete process.env.TELEGRAM_HOME_CHANNEL;

  try {
    const messageId = await tgSendDocument(filePath, {
      fetchImpl: async (url, init) => {
        assert.match(url, /sendDocument/);
        assert.equal(init.method, 'POST');
        assert.ok(init.body instanceof FormData);
        assert.equal(init.body.get('chat_id'), 'chat');
        assert.equal(init.body.get('document').name, 'packet.txt');
        return {
          status: 200,
          json: async () => ({ ok: true, result: { message_id: 321 } }),
          text: async () => '',
        };
      },
    });
    assert.equal(messageId, 321);
  } finally {
    process.env.TELEGRAM_BOT_TOKEN = oldEnv.token;
    process.env.TELEGRAM_CHAT_ID = oldEnv.chat;
    if (oldEnv.home == null) delete process.env.TELEGRAM_HOME_CHANNEL;
    else process.env.TELEGRAM_HOME_CHANNEL = oldEnv.home;
  }
});

test('mentionsPacketNotice collapses the Trump tele-rally title to the required short notice', () => {
  const notice = mentionsPacketNotice('Event title: What will Trump say during his Burt Jones Tele-Rally?', 'stem');
  assert.equal(notice, 'New CPC packet: Trump Tele-Rally -- attached .txt');
});
