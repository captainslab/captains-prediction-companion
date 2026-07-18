import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MODEL_NAMES = Object.freeze(['score', 'yrfi', 'ks_home', 'ks_away', 'hr', 'composite']);

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashRunRecordValue(value) {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function modelSlot(model) {
  const outputs = model?.outputs ?? null;
  return {
    status: model?.status ?? null,
    outputs,
    hash: hashRunRecordValue(outputs),
  };
}

function canonicalRecord(record) {
  const generatedAt = String(record?.generated_at_utc ?? '');
  const gamePk = record?.game_pk;
  const runType = String(record?.run_type ?? '');
  const models = Object.fromEntries(MODEL_NAMES.map((name) => [name, modelSlot(record?.models?.[name])]));
  return {
    run_id: record?.run_id ?? hashRunRecordValue({ game_pk: gamePk, run_type: runType, generated_at_utc: generatedAt }),
    run_type: runType,
    game_pk: gamePk,
    generated_at_utc: generatedAt,
    generation_date: String(record?.generation_date ?? ''),
    lineup_confidence: record?.lineup_confidence ?? 'PROXY',
    lineup_source: record?.lineup_source ?? {
      mode: 'UNAVAILABLE',
      proxy_date: null,
      proxy_game_pk: null,
      batting_order_hash: hashRunRecordValue([]),
    },
    starters: record?.starters ?? {
      away: { name: null, source: null, as_of: String(record?.generation_date ?? '') },
      home: { name: null, source: null, as_of: String(record?.generation_date ?? '') },
    },
    models,
    input_hash: String(record?.input_hash ?? hashRunRecordValue(record?.input_snapshot ?? null)),
    output_hash: hashRunRecordValue(models),
  };
}

function recordPath(stateRoot, date, gamePk, runType) {
  return resolve(stateRoot, 'mlb', date, 'runs', `${gamePk}-${runType}.json`);
}

function writeImmutableJson(filePath, value) {
  const fd = openSync(filePath, 'wx');
  try {
    const body = `${JSON.stringify(value, null, 2)}\n`;
    // Writing through the exclusive descriptor keeps the no-overwrite
    // guarantee on the actual file creation, rather than relying on an
    // existsSync check.
    writeSync(fd, body, null, 'utf8');
  } finally {
    closeSync(fd);
  }
}

export function writeRunRecord(stateRoot, record) {
  const normalized = canonicalRecord(record);
  if (!normalized.run_type) throw new Error('run_type is required');
  if (normalized.game_pk === null || normalized.game_pk === undefined || normalized.game_pk === '') {
    throw new Error('game_pk is required');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized.generation_date)) {
    throw new Error('generation_date must be YYYY-MM-DD');
  }

  const dir = resolve(stateRoot, 'mlb', normalized.generation_date, 'runs');
  mkdirSync(dir, { recursive: true });
  const canonicalPath = recordPath(stateRoot, normalized.generation_date, normalized.game_pk, normalized.run_type);
  let path = canonicalPath;
  try {
    writeImmutableJson(path, normalized);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const collisionBase = join(dir, `${normalized.game_pk}-${normalized.run_type}-${normalized.run_id.slice(0, 12)}`);
    for (let suffix = 0; ; suffix += 1) {
      path = `${collisionBase}${suffix ? `-${suffix + 1}` : ''}.json`;
      try {
        writeImmutableJson(path, normalized);
        break;
      } catch (collisionError) {
        if (collisionError?.code !== 'EEXIST') throw collisionError;
      }
    }
  }
  return { path, record: normalized, created: path !== canonicalPath ? 'collision' : 'canonical' };
}

export function readRunRecord(stateRoot, date, gamePk, runType) {
  const dir = resolve(stateRoot, 'mlb', date, 'runs');
  const canonicalPath = recordPath(stateRoot, date, gamePk, runType);
  const candidates = [canonicalPath];
  if (existsSync(dir)) {
    candidates.push(...readdirSync(dir)
      .filter(name => name.startsWith(`${gamePk}-${runType}-`) && name.endsWith('.json'))
      .sort()
      .map(name => join(dir, name)));
  }
  for (const path of candidates) {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      // Ignore malformed/unreadable collision files and continue lookup.
    }
  }
  return null;
}

export { MODEL_NAMES };
