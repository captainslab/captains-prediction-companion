import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeJsonAtomic } from '../file-io.mjs';

export const CONFIRMED_LINEUP_RUN_TYPE = 'confirmed_lineup';

function stableJson(value) {
  return JSON.stringify(value);
}

export function sha256Json(value) {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

export function confirmedLineupRunPath(stateRoot, date, gamePk) {
  return resolve(stateRoot, 'mlb', date, 'runs', `${gamePk}-${CONFIRMED_LINEUP_RUN_TYPE}.json`);
}

export function lineupsNotLockedPath(stateRoot, date, gamePk) {
  return resolve(stateRoot, 'mlb', date, 'runs', `${gamePk}-lineups-not-locked.json`);
}

export function buildConfirmedLineupRunRecord({
  gamePk,
  generatedAtUtc,
  generationDate,
  lineupSource,
  starters,
  models,
  inputHash,
}) {
  if (lineupSource?.mode !== 'current_boxscore') {
    throw new Error('confirmed_lineup record requires lineup_source.mode=current_boxscore');
  }
  if (!lineupSource?.batting_order_hash) {
    throw new Error('confirmed_lineup record requires lineup_source.batting_order_hash');
  }
  if (!starters?.away?.name || !starters?.home?.name) {
    throw new Error('confirmed_lineup record requires reconfirmed away/home starters');
  }
  if (!models || typeof models !== 'object') {
    throw new Error('confirmed_lineup record requires models');
  }
  if (!inputHash) throw new Error('confirmed_lineup record requires input_hash');

  const runType = CONFIRMED_LINEUP_RUN_TYPE;
  const runId = sha256Json({ game_pk: gamePk, run_type: runType, generated_at_utc: generatedAtUtc });
  return {
    run_id: runId,
    run_type: runType,
    game_pk: gamePk,
    generated_at_utc: generatedAtUtc,
    generation_date: generationDate,
    lineup_confidence: 'CONFIRMED',
    lineup_source: lineupSource,
    starters,
    models,
    input_hash: inputHash,
    output_hash: sha256Json(models),
  };
}

export function writeImmutableRunRecord(stateRoot, date, gamePk, record) {
  const path = confirmedLineupRunPath(stateRoot, date, gamePk);
  if (existsSync(path)) {
    return { path, record: JSON.parse(readFileSync(path, 'utf8')), created: false };
  }
  writeJsonAtomic(path, record);
  return { path, record, created: true };
}

export function writeLineupsNotLockedArtifact({ stateRoot, date, gamePk, checkedAtUtc, affectedLayers }) {
  const path = lineupsNotLockedPath(stateRoot, date, gamePk);
  const artifact = {
    game_pk: gamePk,
    checked_at_utc: checkedAtUtc,
    retries_exhausted: true,
    affected_layers: [...affectedLayers],
  };
  writeJsonAtomic(path, artifact);
  return { path, artifact };
}
