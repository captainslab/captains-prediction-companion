#!/usr/bin/env node
// Confirmed, ledger-backed correction sender for customer-facing packets.
//
// This is intentionally a narrow operator entrypoint: it resolves exactly one
// packet from state/packets/<date>/<type>/, requires the original delivery, and
// records corrections separately from the original delivered ledger.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CORRECTION_PACKET_TYPES,
  deliverDocumentEntry,
  loadLedger,
  planDeliveries,
  saveLedger,
  tgSendDocument,
  tgSendMessage,
} from './send-packets-telegram.mjs';
import { inspectPacketFile } from '../cron/cpc-packet-janitor.mjs';

const VALUE_FLAGS = new Set(['--type', '--date', '--reason', '--correction-id', '--state-root']);
const BOOLEAN_FLAGS = new Set(['--confirm', '--dry-run', '--document-only']);
const ALLOWED_FLAGS = new Set([...VALUE_FLAGS, ...BOOLEAN_FLAGS]);

function parseArgs(argv) {
  const parsed = { values: {}, booleans: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!ALLOWED_FLAGS.has(flag)) throw new Error(`unsupported flag: ${flag}`);
    if (parsed.values[flag] !== undefined || parsed.booleans.has(flag)) {
      throw new Error(`duplicate flag: ${flag}`);
    }
    if (BOOLEAN_FLAGS.has(flag)) {
      parsed.booleans.add(flag);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    parsed.values[flag] = value;
    i += 1;
  }
  return parsed;
}

function requireNonEmpty(value, flag) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${flag} must not be empty`);
  return value;
}

function validateDate(value) {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(parsed)
    || new Date(parsed).toISOString().slice(0, 10) !== value) {
    throw new Error('--date must be YYYY-MM-DD');
  }
  return value;
}

function correctionNotice(packetType, reason) {
  const label = packetType === 'mlb-daily' ? 'MLB DAILY' : 'NASCAR';
  return `CORRECTED ${label} PACKET — ${reason}`;
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function correctionIdempotencyKey(packetType, stem, correctionId) {
  return `${packetType}-correction:${stem}:${correctionId}`;
}

function printLine(output, line) {
  output(line);
}

export async function runCorrection(argv, {
  sendMessage = tgSendMessage,
  sendDocument = tgSendDocument,
  inspect = inspectPacketFile,
  save = saveLedger,
  output = console.log,
  nowMs = Date.now(),
  sleepImpl = async () => {},
} = {}) {
  const parsed = parseArgs(argv);
  if (!parsed.booleans.has('--confirm')) throw new Error('--confirm is required for correction delivery');

  const packetType = requireNonEmpty(parsed.values['--type'], '--type');
  if (!CORRECTION_PACKET_TYPES.includes(packetType)) {
    throw new Error(`unsupported correction packet type: ${packetType}`);
  }
  const date = validateDate(requireNonEmpty(parsed.values['--date'], '--date'));
  const reason = requireNonEmpty(parsed.values['--reason'], '--reason');
  const correctionId = requireNonEmpty(parsed.values['--correction-id'], '--correction-id');
  const stateRoot = parsed.values['--state-root'] || 'state';
  const dryRun = parsed.booleans.has('--dry-run');
  const documentOnly = parsed.booleans.has('--document-only');

  const dir = resolve(stateRoot, 'packets', date, packetType);
  const ledgerPath = join(dir, '.delivery-ledger.json');
  if (!existsSync(dir)) throw new Error(`correction packet directory missing: ${dir}`);
  if (!existsSync(ledgerPath)) throw new Error('correction requires an existing delivery ledger');

  const ledger = loadLedger(ledgerPath);
  if (!ledger?.delivered || typeof ledger.delivered !== 'object') {
    throw new Error('correction requires an existing valid delivery ledger');
  }

  const plan = planDeliveries(dir, date, { preferBaseFile: true });
  if (plan.length !== 1 || plan[0].name === `${date}-no-events`) {
    throw new Error('correction requires exactly one real event packet');
  }
  const entry = plan[0];
  if (!Object.prototype.hasOwnProperty.call(ledger.delivered, entry.name)) {
    throw new Error(`correction requires an original delivery record for ${entry.name}`);
  }

  const corrections = Array.isArray(ledger.corrections) ? ledger.corrections : [];
  if (corrections.some((correction) =>
    correction?.source_packet_stem === entry.name && correction?.correction_id === correctionId)) {
    throw new Error(`correction_id already recorded for ${entry.name}: ${correctionId}`);
  }

  const fileName = entry.files.find((file) => file === `${entry.name}.txt`) ?? entry.files[0];
  const packetPath = resolve(dir, fileName);
  const relativePath = relative(dir, packetPath);
  if (relativePath.startsWith('..') || relativePath.includes('..' + '/')) {
    throw new Error('correction packet path escaped the packet directory');
  }

  const notice = correctionNotice(packetType, reason);
  const outcome = await deliverDocumentEntry({
    entry,
    dir,
    packetType,
    date,
    stateRoot,
    ledgerPath,
    ledger,
    force: false,
    dryRun,
    sendMessage,
    sendDocument,
    inspect,
    idempotencyKey: correctionIdempotencyKey(packetType, entry.name, correctionId),
    caption: notice,
    documentOnly,
    correctionMode: true,
    recordDelivery: false,
    nowMs,
    sleepImpl,
  });

  if (outcome.status !== 'sent' && outcome.status !== 'dryrun') {
    throw new Error(`correction blocked: ${outcome.reason || outcome.status}`);
  }

  const deliveryPath = outcome.delivery_path || packetPath;
  const correctionEntry = {
    utc: new Date(nowMs).toISOString(),
    source_packet_stem: entry.name,
    reason,
    original_message_ids: structuredClone(ledger.delivered[entry.name].message_ids ?? null),
    correction_message_ids: outcome.status === 'dryrun' ? null : outcome.message_ids,
    artifact_hash: sha256(deliveryPath),
    operator_mode: outcome.status === 'dryrun' ? 'dry_run' : 'live',
    correction_id: correctionId,
  };

  if (outcome.status === 'dryrun') {
    printLine(output, `CORRECTION_NOTICE: ${notice}`);
    printLine(output, `CORRECTION_DOCUMENT: ${basename(deliveryPath)}`);
    printLine(output, `CORRECTION_LEDGER_ENTRY: ${JSON.stringify(correctionEntry)}`);
    printLine(output, `CORRECTION_ID: ${correctionId}`);
    return { status: 'dry_run', correction: correctionEntry, notice, document_file: basename(deliveryPath) };
  }

  ledger.corrections = [...corrections, correctionEntry];
  save(ledgerPath, ledger);
  printLine(output, `CORRECTION_SENT: ${entry.name} document=${basename(deliveryPath)} correction_id=${correctionId}`);
  return { status: 'live', correction: correctionEntry, notice, document_file: basename(deliveryPath) };
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  runCorrection(process.argv.slice(2)).catch((error) => {
    console.error(`correction failed: ${error.message}`);
    process.exitCode = 1;
  });
}
