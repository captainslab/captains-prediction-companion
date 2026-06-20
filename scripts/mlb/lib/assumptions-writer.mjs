// Thin assumptions-ledger writer.
// Pure filesystem I/O only.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ledgerFilename } from './assumptions-ledger.mjs';

export function assumptionsDir(stateRoot, date) {
  return resolve(stateRoot, 'mlb', date, 'assumptions');
}

export function writeScopedLedger(stateRoot, date, scope, ledger, { gameId = null } = {}) {
  const dir = assumptionsDir(stateRoot, date);
  mkdirSync(dir, { recursive: true });
  const filePath = resolve(dir, ledgerFilename(scope, { gameId }));
  writeFileSync(filePath, JSON.stringify(ledger, null, 2), 'utf8');
  return filePath;
}

