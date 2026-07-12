import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { deliverDocumentEntry } from '../scripts/packets/send-packets-telegram.mjs';

const STEM = '2026-07-12-KXNASCARRACE-QUAS4AA26';
const KEY = 'nascar-correction:race-5615:v1';
const CAPTION = 'CORRECTED NASCAR PACKET — Supersedes the earlier incomplete Quaker State 400 packet.';
const DRIVERS = [
  'Ryan Blaney', 'Joey Logano', 'Kyle Larson', 'Austin Dillon', 'Daniel Suarez',
  'Alex Bowman', 'Chase Elliott', 'Austin Cindric', 'Ross Chastain', 'Brad Keselowski',
  'Erik Jones', 'Shane Van Gisbergen', 'Chris Buescher', 'Carson Hocevar', 'Ricky Stenhouse Jr',
  'Ty Dillon', 'Josh Berry', 'Michael McDowell', 'Ryan Preece', 'Chase Briscoe',
  'Todd Gilliland', 'Bubba Wallace', 'Ty Gibbs', 'John H. Nemechek', 'Connor Zilisch',
  'William Byron', 'AJ Allmendinger', 'Denny Hamlin', 'Riley Herbst', 'Austin Hill',
  'Tyler Reddick', 'Christopher Bell', 'Cole Custer', 'Zane Smith', 'Cody Ware',
  'Noah Gragson', 'BJ McLeod', 'Chad Finchum',
];

function packet({ start = '2026-07-12T23:00:00.000Z', blocked = false, drivers = DRIVERS } = {}) {
  const count = drivers.length;
  return [
    '=== Captain NASCAR — CPC Packet: Quaker State 400 Available at Walmart Winner ===',
    'date: 2026-07-12',
    'packet_type: nascar-sunday',
    'generated_utc: 2026-07-12T21:00:00.000Z',
    'sources: https://cf.nascar.com/cacher/2026/1/5615/weekend-feed.json',
    'event_ticker: KXNASCARRACE-QUAS4AA26',
    'race_id: 5615',
    'track_id: 111',
    'series_id: 1',
    'race_name: Quaker State 400 Available at Walmart',
    'track: Atlanta Motor Speedway',
    `official_start_utc: ${start}`,
    `field_size: ${count}`,
    `grid_count: ${count}`,
    `market_count: ${count}`,
    `candidate_count: ${count}`,
    `ranked_count: ${count}`,
    blocked ? 'BLOCKED_PACKET_INCOMPLETE' : 'RACE_READY',
    '=== FULL FIELD ===',
    ...drivers.map((driver, index) => `- P${String(index + 1).padStart(2, '0')} ${driver} | posture=WATCH | score=50 | confidence=medium`),
    '=== RANKED BOARD ===',
    ...drivers.map((driver, index) => `- #${index + 1} ${driver} | posture=WATCH | score=50 | fair=1%`),
    '=== STRONGEST ===',
    '- Ryan Blaney',
    '=== SECONDARY ===',
    '- none',
    '=== LONGSHOTS ===',
    '- none',
    '=== FADES ===',
    '- none',
    '=== EVIDENCE ===',
    '- official and model evidence complete',
    '=== CONFIDENCE ===',
    '- medium',
    '=== LIMITS ===',
    '- Market Context - NOT IN SCORE. Research only.',
    'No trades placed by this workflow.',
  ].join('\n');
}

function writeCorrectionState(stateRoot, { start = '2026-07-12T23:00:00.000Z' } = {}) {
  const root = join(stateRoot, 'nascar', '2026-07-12');
  const discoveryDir = join(root, 'discovery');
  const eventDir = join(root, 'kalshi-events');
  mkdirSync(discoveryDir, { recursive: true });
  mkdirSync(eventDir, { recursive: true });
  const identity = {
    event_ticker: 'KXNASCARRACE-QUAS4AA26',
    event_title: 'Quaker State 400 Available at Walmart Winner',
    race_id: 5615,
    track_id: 111,
    series_id: 1,
    race_name: 'Quaker State 400 Available at Walmart',
    track: 'Atlanta Motor Speedway',
    scheduled_start_utc: start,
    race_date: '2026-07-12',
  };
  const checked = '2026-07-12T21:00:00.000Z';
  const activeRecords = DRIVERS.map((driver_name, index) => ({
    driver_name,
    race_id: 5615,
    track_id: 111,
    starting_grid_position: index + 1,
  }));
  const practiceRecords = DRIVERS.map((driver_name, index) => ({
    driver_name,
    race_id: 5615,
    track_id: 111,
    effective_race_start: index + 1,
  }));
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(join(root, 'race_manifest.json'), json({
    schema_version: 'nascar_race_manifest_v2', mode: 'production', checked_at_utc: checked,
    event_identity: identity, active_field_count: DRIVERS.length, model_candidate_count: DRIVERS.length,
  }));
  writeFileSync(join(root, 'ceiling_board.json'), json({
    schema_version: 'nascar_track_aware_production_v1', mode: 'production', checked_at_utc: checked,
    event_identity: identity,
    candidates: DRIVERS.map((driver_name) => ({ driver_name, composite_score: 50 })),
  }));
  writeFileSync(join(root, 'source_registry.json'), json({ mode: 'production', checked_at_utc: checked, event_identity: identity }));
  writeFileSync(join(root, 'discovery.json'), json({ mode: 'production', checked_at_utc: checked, event_identity: identity }));
  writeFileSync(join(discoveryDir, 'nascar_official_adapter.json'), json({
    source_id: 'nascar_official', status: 'ok', checked_at_utc: checked,
    records: [{ ...identity, scheduled_start_utc: identity.scheduled_start_utc }],
  }));
  writeFileSync(join(discoveryDir, 'active_field_pool_adapter.json'), json({ status: 'ok', checked_at_utc: checked, records: activeRecords }));
  writeFileSync(join(discoveryDir, 'practice_qualifying_adapter.json'), json({ status: 'ok', checked_at_utc: checked, records: practiceRecords }));
  writeFileSync(join(eventDir, `${identity.event_ticker}.json`), json({
    event_ticker: identity.event_ticker,
    markets: DRIVERS.map((driver, index) => ({
      ticker: `${identity.event_ticker}-${index + 1}`,
      title: `${driver} to win the race`,
      yes_sub_title: driver,
    })),
  }));
}

function setup(text = packet(), { stateStart = '2026-07-12T23:00:00.000Z' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nascar-correction-'));
  const file = join(dir, `${STEM}.txt`);
  const ledgerPath = join(dir, '.delivery-ledger.json');
  const originalRecord = { utc: '2026-07-12T13:30:00.000Z', document_message_id: 6672, rejected: true };
  const ledger = { delivered: { [STEM]: structuredClone(originalRecord) }, rejected: { [STEM]: { reason: 'incomplete' } } };
  writeCorrectionState(dir, { start: stateStart });
  writeFileSync(file, text);
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  return { dir, file, ledgerPath, ledger, originalRecord };
}

function options(ctx, overrides = {}) {
  return {
    entry: { name: STEM, files: [`${STEM}.txt`] },
    dir: ctx.dir,
    packetType: 'nascar-sunday',
    date: '2026-07-12',
    stateRoot: ctx.dir,
    ledgerPath: ctx.ledgerPath,
    ledger: ctx.ledger,
    force: false,
    dryRun: false,
    nowMs: Date.parse('2026-07-12T21:00:00.000Z'),
    idempotencyKey: KEY,
    caption: CAPTION,
    documentOnly: true,
    correctionMode: true,
    inspect: () => ({ verdict: 'SEND_ALLOWED', repaired_path: null }),
    ...overrides,
  };
}

test('correction sends exactly one captioned document, preserves original record, and records stable idempotency', async () => {
  const ctx = setup();
  let notices = 0;
  const documents = [];
  try {
    const outcome = await deliverDocumentEntry(options(ctx, {
      sendMessage: async () => { notices += 1; return 7000; },
      sendDocument: async (path, sendOptions) => {
        documents.push({ path, sendOptions });
        return 7001;
      },
    }));
    assert.equal(outcome.status, 'sent');
    assert.equal(outcome.document_message_id, 7001);
    assert.equal(notices, 0);
    assert.equal(documents.length, 1);
    assert.equal(documents[0].sendOptions.caption, CAPTION);
    assert.deepEqual(ctx.ledger.delivered[STEM], ctx.originalRecord);
    assert.equal(ctx.ledger.delivered[KEY].document_message_id, 7001);
    assert.equal(ctx.ledger.delivered[KEY].caption, CAPTION);
    assert.deepEqual(ctx.ledger.delivered[KEY].message_ids, [7001]);

    const disk = JSON.parse(readFileSync(ctx.ledgerPath, 'utf8'));
    assert.deepEqual(disk.delivered[STEM], ctx.originalRecord);
    assert.equal(disk.delivered[KEY].document_message_id, 7001);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('second correction and check-only both suppress the stable key with no Telegram or ledger mutation', async () => {
  const ctx = setup();
  ctx.ledger.delivered[KEY] = { document_message_id: 7001, caption: CAPTION };
  writeFileSync(ctx.ledgerPath, `${JSON.stringify(ctx.ledger, null, 2)}\n`);
  const before = readFileSync(ctx.ledgerPath, 'utf8');
  let callbacks = 0;
  try {
    for (const checkOnly of [false, true]) {
      const outcome = await deliverDocumentEntry(options(ctx, {
        checkOnly,
        sendMessage: async () => { callbacks += 1; },
        sendDocument: async () => { callbacks += 1; },
      }));
      assert.equal(outcome.status, 'duplicate_suppressed');
      assert.equal(outcome.idempotency_key, KEY);
    }
    assert.equal(callbacks, 0);
    assert.equal(readFileSync(ctx.ledgerPath, 'utf8'), before);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('quality and expiry failures occur before janitor, Telegram, or ledger mutation', async (t) => {
  for (const [name, text, nowMs, expected, stateStart] of [
    ['invalid packet', packet({ blocked: true }), Date.parse('2026-07-12T21:00:00.000Z'), 'blocked_incomplete', undefined],
    ['truncated packet', packet({ drivers: DRIVERS.slice(0, 1) }), Date.parse('2026-07-12T21:00:00.000Z'), 'blocked_incomplete', undefined],
    ['started race', packet({ start: '2026-07-12T20:00:00.000Z' }), Date.parse('2026-07-12T21:00:00.000Z'), 'blocked_expired', '2026-07-12T20:00:00.000Z'],
  ]) {
    await t.test(name, async () => {
      const ctx = setup(text, { stateStart });
      const before = readFileSync(ctx.ledgerPath, 'utf8');
      let callbacks = 0;
      try {
        const outcome = await deliverDocumentEntry(options(ctx, {
          nowMs,
          inspect: () => { callbacks += 1; throw new Error('janitor must not run'); },
          sendMessage: async () => { callbacks += 1; },
          sendDocument: async () => { callbacks += 1; },
        }));
        assert.equal(outcome.status, expected);
        assert.equal(callbacks, 0);
        assert.equal(readFileSync(ctx.ledgerPath, 'utf8'), before);
        assert.deepEqual(ctx.ledger.delivered[STEM], ctx.originalRecord);
        assert.equal(existsSync(ctx.ledgerPath), true);
      } finally {
        rmSync(ctx.dir, { recursive: true, force: true });
      }
    });
  }
});

test('CLI correction check-only bypasses the preserved original stem and then proves custom-key suppression', () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'nascar-correction-cli-'));
  const dir = join(stateRoot, 'packets', '2026-07-12', 'nascar-sunday');
  const ledgerPath = join(dir, '.delivery-ledger.json');
  mkdirSync(dir, { recursive: true });
  writeCorrectionState(stateRoot);
  writeFileSync(join(dir, `${STEM}.txt`), packet());
  const ledger = { delivered: { [STEM]: { document_message_id: 6672 } } };
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  const args = [
    'scripts/packets/send-packets-telegram.mjs',
    '--date', '2026-07-12',
    '--type', 'nascar-sunday',
    '--state-root', stateRoot,
    '--only', STEM,
    '--caption', CAPTION,
    '--idempotency-key', KEY,
    '--document-only',
    '--check-only',
  ];
  try {
    const before = readFileSync(ledgerPath, 'utf8');
    const eligible = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(eligible.status, 0, eligible.stderr);
    assert.match(eligible.stdout, new RegExp(`CHECK_ONLY_READY idempotency_key=${KEY}`), eligible.stderr);
    assert.equal(readFileSync(ledgerPath, 'utf8'), before);

    ledger.delivered[KEY] = { document_message_id: 7001, caption: CAPTION };
    writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    const deliveredBefore = readFileSync(ledgerPath, 'utf8');
    const duplicate = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(duplicate.status, 0, duplicate.stderr);
    assert.match(duplicate.stdout, new RegExp(`DUPLICATE_SUPPRESSED idempotency_key=${KEY}`));
    assert.equal(readFileSync(ledgerPath, 'utf8'), deliveredBefore);

    delete ledger.delivered[KEY];
    writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    writeFileSync(join(dir, `${STEM}.txt`), packet({ blocked: true }));
    const blockedBefore = readFileSync(ledgerPath, 'utf8');
    const blocked = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: 'utf8' });
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /janitor blocked sole packet/);
    assert.equal(readFileSync(ledgerPath, 'utf8'), blockedBefore);

    const missingArgs = [...args];
    missingArgs[missingArgs.indexOf('--only') + 1] = `${STEM}-MISSING`;
    const missing = spawnSync(process.execPath, missingArgs, { cwd: process.cwd(), encoding: 'utf8' });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /matched no packet/);

    const noEventsStem = '2026-07-12-no-events';
    writeFileSync(join(dir, `${noEventsStem}.txt`), 'no events');
    const noEventsArgs = [...args];
    noEventsArgs[noEventsArgs.indexOf('--only') + 1] = noEventsStem;
    const noEvents = spawnSync(process.execPath, noEventsArgs, { cwd: process.cwd(), encoding: 'utf8' });
    assert.notEqual(noEvents.status, 0);
    assert.match(noEvents.stderr, /exactly one real event packet/);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});
