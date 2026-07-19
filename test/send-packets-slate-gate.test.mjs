import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseFirstPitchUtc,
  parseGameStatus,
  evaluateSlateExpiry,
  deliverDocumentEntry,
} from '../scripts/packets/send-packets-telegram.mjs';
import { DELIVERY_VERDICTS } from '../scripts/cron/cpc-packet-janitor.mjs';

// Deterministic clock: 2026-07-08T20:00:00Z.
const NOW_MS = Date.parse('2026-07-08T20:00:00Z');
const FUTURE_ISO = new Date(NOW_MS + 60 * 60 * 1000).toISOString(); // +1h
const PAST_ISO = new Date(NOW_MS - 60 * 60 * 1000).toISOString(); // -1h

function makePacket({ matchup = 'Colorado Rockies at Los Angeles Dodgers', date = '2026-07-08', firstPitch = FUTURE_ISO, status = null } = {}) {
  const statusSuffix = status ? ` | Status: ${status}` : '';
  return [
    "Captain's MLB Prediction Companion",
    `Captain MLB — ${matchup} CPC Read`,
    matchup,
    `Date: ${date} | First pitch: ${firstPitch} | Venue: Test Park${statusSuffix}`,
    '',
    'CPC Read',
    '  CPC Read: monitor only.',
  ].join('\n');
}

function writeEntry(dir, name, packetText) {
  writeFileSync(join(dir, `${name}.txt`), packetText, 'utf8');
  return { name, files: [`${name}.txt`] };
}

function baseArgs(dir, entry, ledger) {
  return {
    entry,
    dir,
    packetType: 'mlb-daily',
    date: '2026-07-08',
    stateRoot: 'state',
    ledgerPath: join(dir, '.delivery-ledger.json'),
    ledger,
    force: false,
    dryRun: false,
    nowMs: NOW_MS,
  };
}

// --- Pure gate: parseFirstPitchUtc -----------------------------------------

test('parseFirstPitchUtc: present/parsed, present/unparseable, and absent', () => {
  assert.equal(parseFirstPitchUtc(makePacket({ firstPitch: PAST_ISO })).ms, Date.parse(PAST_ISO));
  const bad = parseFirstPitchUtc('Date: 2026-07-08 | First pitch: TBD | Venue: X');
  assert.equal(bad.present, true);
  assert.ok(Number.isNaN(bad.ms));
  assert.deepEqual(parseFirstPitchUtc('no pitch line here'), { present: false, ms: null, raw: null });
});

test('parseGameStatus reads the optional status suffix and stays absent when omitted', () => {
  assert.deepEqual(parseGameStatus(makePacket({ status: 'Delayed Start' })), { present: true, raw: 'Delayed Start' });
  assert.deepEqual(parseGameStatus(makePacket()), { present: false, raw: null });
});

// --- Test 1: future locked slate CAN send ----------------------------------

test('future slate: evaluateSlateExpiry allows send', () => {
  const res = evaluateSlateExpiry({ packetText: makePacket({ firstPitch: FUTURE_ISO }), nowMs: NOW_MS });
  assert.equal(res.blocked, false);
  assert.equal(res.verdict, DELIVERY_VERDICTS.SEND_ALLOWED);
});

test('future slate: deliverDocumentEntry sends both messages and marks delivered', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slate-gate-future-'));
  const entry = writeEntry(dir, '2026-07-08-KXMLBGAME-FUT', makePacket({ firstPitch: FUTURE_ISO }));
  const ledger = { delivered: {} };
  const calls = [];
  const outcome = await deliverDocumentEntry({
    ...baseArgs(dir, entry, ledger),
    inspect: () => ({ verdict: DELIVERY_VERDICTS.SEND_ALLOWED }),
    sendMessage: async () => { calls.push('notice'); return 111; },
    sendDocument: async () => { calls.push('document'); return 222; },
  });
  assert.equal(outcome.status, 'sent');
  assert.deepEqual(calls, ['notice', 'document']);
  assert.ok(ledger.delivered[entry.name]);
  assert.deepEqual(ledger.delivered[entry.name].message_ids, [111, 222]);
});

// --- Test 2: delayed-but-not-started slate CAN send --------------------------

test('delayed-but-not-started slate: scheduled time passed but delivery remains allowed', () => {
  const res = evaluateSlateExpiry({ packetText: makePacket({ firstPitch: PAST_ISO, status: 'Delayed Start' }), nowMs: NOW_MS });
  assert.equal(res.blocked, false);
  assert.equal(res.verdict, DELIVERY_VERDICTS.SEND_ALLOWED);
});

// --- Test 3: started slate CANNOT send ---------------------------------------

test('in-progress slate: status does not weaken EXPIRED_SLATE_BLOCKED', () => {
  const res = evaluateSlateExpiry({ packetText: makePacket({ firstPitch: PAST_ISO, status: 'In Progress' }), nowMs: NOW_MS });
  assert.equal(res.blocked, true);
  assert.equal(res.verdict, DELIVERY_VERDICTS.EXPIRED_SLATE_BLOCKED);
});

test('missing status: pure time gate still blocks with EXPIRED_SLATE_BLOCKED', () => {
  const res = evaluateSlateExpiry({ packetText: makePacket({ firstPitch: PAST_ISO }), nowMs: NOW_MS });
  assert.equal(res.blocked, true);
  assert.equal(res.verdict, DELIVERY_VERDICTS.EXPIRED_SLATE_BLOCKED);
  assert.match(res.reason, /Colorado Rockies at Los Angeles Dodgers/);
  assert.match(res.reason, new RegExp(PAST_ISO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

// --- Test 3: expired slate does NOT mark delivery success -------------------

test('expired slate: deliverDocumentEntry does not mark delivered, records blocked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slate-gate-expired-'));
  const entry = writeEntry(dir, '2026-07-08-KXMLBGAME-PAST', makePacket({ firstPitch: PAST_ISO }));
  const ledger = { delivered: {} };
  const outcome = await deliverDocumentEntry({
    ...baseArgs(dir, entry, ledger),
    inspect: () => { throw new Error('janitor must not run for expired slate'); },
    sendMessage: async () => { throw new Error('must not send'); },
    sendDocument: async () => { throw new Error('must not send'); },
  });
  assert.equal(outcome.status, 'blocked_expired');
  assert.equal(outcome.verdict, DELIVERY_VERDICTS.EXPIRED_SLATE_BLOCKED);
  assert.equal(Object.prototype.hasOwnProperty.call(ledger.delivered, entry.name), false);
  assert.ok(ledger.blocked[entry.name]);
  assert.equal(ledger.blocked[entry.name].verdict, DELIVERY_VERDICTS.EXPIRED_SLATE_BLOCKED);
  assert.ok(ledger.blocked[entry.name].reason);
  // ledger persisted to disk (record of why it blocked)
  assert.ok(existsSync(join(dir, '.delivery-ledger.json')));
});

// --- Test 4: blocked delivery does NOT touch Telegram -----------------------

test('expired slate: neither send function is invoked (no Telegram)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slate-gate-notouch-'));
  const entry = writeEntry(dir, '2026-07-08-KXMLBGAME-NOTOUCH', makePacket({ firstPitch: PAST_ISO }));
  const ledger = { delivered: {} };
  let touched = false;
  const outcome = await deliverDocumentEntry({
    ...baseArgs(dir, entry, ledger),
    inspect: () => { touched = true; throw new Error('janitor ran'); },
    sendMessage: async () => { touched = true; throw new Error('sendMessage called'); },
    sendDocument: async () => { touched = true; throw new Error('sendDocument called'); },
  });
  assert.equal(outcome.status, 'blocked_expired');
  assert.equal(touched, false);
});

function makeMultiGamePacket(firstPitches) {
  return [
    "Captain's MLB Prediction Companion",
    '=== FULL SLATE BOARD ===',
    'Date: 2026-07-08',
    ...firstPitches.map((firstPitch, index) => [
      `Game ${index + 1}`,
      `FIRST PITCH: ${firstPitch}`,
      'Status: Pregame',
    ].join('\n')),
  ].join('\n');
}

test('multi-game slate: earliest started but latest remains future allows send', () => {
  const firstPitches = [
    PAST_ISO,
    new Date(NOW_MS + 2 * 60 * 60 * 1000).toISOString(),
    new Date(NOW_MS + 3 * 60 * 60 * 1000).toISOString(),
  ];
  const res = evaluateSlateExpiry({ packetText: makeMultiGamePacket(firstPitches), nowMs: NOW_MS });
  assert.equal(res.blocked, false);
  assert.equal(res.verdict, DELIVERY_VERDICTS.SEND_ALLOWED);
  assert.equal(res.firstPitchUtc, firstPitches[2]);
});

test('multi-game slate: all three games started blocks at the latest first pitch', () => {
  const firstPitches = [
    new Date(NOW_MS - 3 * 60 * 60 * 1000).toISOString(),
    new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString(),
    PAST_ISO,
  ];
  const res = evaluateSlateExpiry({ packetText: makeMultiGamePacket(firstPitches), nowMs: NOW_MS });
  assert.equal(res.blocked, true);
  assert.equal(res.verdict, DELIVERY_VERDICTS.EXPIRED_SLATE_BLOCKED);
  assert.equal(res.firstPitchUtc, PAST_ISO);
  assert.match(res.reason, /all games in this slate have started/);
  assert.match(res.reason, /latest first pitch was at/);
});

test('multi-game slate: two of sixteen started remains deliverable', () => {
  const firstPitches = [
    new Date(NOW_MS - 3 * 60 * 60 * 1000).toISOString(),
    new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString(),
    ...Array.from({ length: 14 }, (_, index) => new Date(NOW_MS + (index + 1) * 60 * 60 * 1000).toISOString()),
  ];
  const res = evaluateSlateExpiry({ packetText: makeMultiGamePacket(firstPitches), nowMs: NOW_MS });
  assert.equal(firstPitches.length, 16);
  assert.equal(res.blocked, false);
  assert.equal(res.verdict, DELIVERY_VERDICTS.SEND_ALLOWED);
  assert.equal(res.firstPitchUtc, firstPitches.at(-1));
});
