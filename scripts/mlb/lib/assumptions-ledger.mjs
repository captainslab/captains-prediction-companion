// MLB input assumptions ledger.
//
// This layer is model-adjacent metadata only. It classifies the packet inputs
// that feed MLB preview packets and HR watchlists, but it never reads board
// prices or score outputs.

import { assertNoPriceFields } from './projection-contracts.mjs';

export const INPUT_STATUSES = Object.freeze(['LOCKED', 'PROJECTED', 'ASSUMED', 'UNKNOWN']);
export const MISSING_TOKENS = Object.freeze(['UNKNOWN', 'MISSING', 'NOT_AVAILABLE', 'BLOCKED_INPUT']);
export const SOURCE_QUALITIES = Object.freeze(['A', 'B', 'C', 'D', 'F']);
export const PACKET_SCOPES = Object.freeze(['FULL_DAY_PREVIEW', 'SLATE_PREVIEW', 'GAME_PACKET']);
export const LEDGER_SCHEMA = 'mlb_assumptions_ledger_v1';

const STATUS_SET = new Set(INPUT_STATUSES);
const QUALITY_SET = new Set(SOURCE_QUALITIES);
const SCOPE_SET = new Set(PACKET_SCOPES);
const EVIDENCE_STATUSES = new Set(['LOCKED', 'PROJECTED', 'ASSUMED']);
const EVIDENCE_QUALITIES = new Set(['A', 'B', 'C', 'D']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizedStatus(status) {
  return STATUS_SET.has(status) ? status : 'UNKNOWN';
}

function normalizedQuality(status, quality, basis, source) {
  if (!QUALITY_SET.has(quality)) return 'F';
  if (!isNonEmptyString(basis) || !isNonEmptyString(source)) return 'F';
  if (status === 'UNKNOWN') return 'F';
  return quality;
}

function countMap(keys, values) {
  const out = {};
  for (const key of keys) out[key] = 0;
  for (const value of values) {
    if (value in out) out[value] += 1;
  }
  return out;
}

function validateScope(scope) {
  if (!SCOPE_SET.has(scope)) {
    throw new Error(`invalid MLB assumptions scope: ${scope}`);
  }
}

export function canSupportEvidence(item) {
  if (!item || typeof item !== 'object') return false;
  const status = item.status;
  const quality = item.source_quality;
  return EVIDENCE_STATUSES.has(status)
    && EVIDENCE_QUALITIES.has(quality)
    && isNonEmptyString(item.basis)
    && isNonEmptyString(item.source);
}

export function buildLedgerItem({
  type,
  scope,
  team = null,
  player = null,
  game = null,
  value = null,
  status,
  basis = null,
  source = null,
  source_url = null,
  local_source_ref = null,
  checked_utc = null,
  source_quality = null,
  ...rest
} = {}) {
  if (!isNonEmptyString(type)) {
    throw new Error('assumptions ledger item requires a non-empty type');
  }
  validateScope(scope);

  const raw = {
    type,
    scope,
    team,
    player,
    game,
    value,
    status,
    basis,
    source,
    source_url,
    local_source_ref,
    checked_utc,
    source_quality,
    ...rest,
  };
  assertNoPriceFields(raw, 'assumptions ledger item');

  let normalizedStatusValue = normalizedStatus(status);
  const basisProvided = isNonEmptyString(basis);
  const sourceProvided = isNonEmptyString(source);

  if (!basisProvided || !sourceProvided) {
    normalizedStatusValue = 'UNKNOWN';
  }
  if (normalizedStatusValue === 'ASSUMED' && !basisProvided) {
    normalizedStatusValue = 'UNKNOWN';
  }

  let normalizedSourceQuality = normalizedQuality(normalizedStatusValue, source_quality, basis, source);
  if (normalizedStatusValue === 'UNKNOWN') {
    normalizedSourceQuality = 'F';
  }

  const item = Object.freeze({
    type,
    scope,
    team,
    player,
    game,
    value,
    status: normalizedStatusValue,
    basis,
    source,
    source_url,
    local_source_ref,
    checked_utc: checked_utc ?? new Date().toISOString(),
    source_quality: normalizedSourceQuality,
    supports_evidence: canSupportEvidence({
      status: normalizedStatusValue,
      basis,
      source,
      source_quality: normalizedSourceQuality,
    }),
  });
  return item;
}

export function buildScopedLedger({ scope, date, items = [], now = () => new Date().toISOString() } = {}) {
  validateScope(scope);
  const generatedUtc = now();
  const normalizedItems = Object.freeze(items.map((item) => {
    const built = buildLedgerItem({ ...item, checked_utc: item?.checked_utc ?? generatedUtc });
    return item && typeof item === 'object' && item.removal_rule
      ? Object.freeze({ ...built, removal_rule: item.removal_rule })
      : built;
  }));
  const byStatus = countMap(INPUT_STATUSES, normalizedItems.map((item) => item.status));
  const byQuality = countMap(SOURCE_QUALITIES, normalizedItems.map((item) => item.source_quality));
  const evidenceEligible = normalizedItems.filter((item) => item.supports_evidence).length;
  return Object.freeze({
    schema_version: LEDGER_SCHEMA,
    scope,
    date,
    generated_utc: generatedUtc,
    items: normalizedItems,
    summary: Object.freeze({
      total: normalizedItems.length,
      by_status: Object.freeze(byStatus),
      by_quality: Object.freeze(byQuality),
      evidence_eligible: evidenceEligible,
    }),
  });
}

export function ledgerFilename(scope, { gameId = null } = {}) {
  validateScope(scope);
  if (scope === 'FULL_DAY_PREVIEW') return 'full-day-preview.json';
  if (scope === 'SLATE_PREVIEW') return 'slate.json';
  if (!isNonEmptyString(String(gameId ?? '').trim())) {
    throw new Error('gameId is required for GAME_PACKET assumptions ledgers');
  }
  const safeGameId = String(gameId).trim().replace(/[^A-Za-z0-9._-]+/g, '_');
  return `game-${safeGameId}.json`;
}

function statusLabel(inputStatus) {
  return INPUT_STATUSES.includes(inputStatus) ? inputStatus : 'UNKNOWN';
}

export function lineupLabel(inputStatus) {
  const status = statusLabel(typeof inputStatus === 'string' ? inputStatus.toUpperCase() : inputStatus);
  if (status === 'LOCKED') return 'LOCKED';
  if (status === 'PROJECTED' || status === 'ASSUMED') return 'PROJECTED';
  return 'UNKNOWN';
}

export function starterLabel(inputStatus) {
  const status = statusLabel(typeof inputStatus === 'string' ? inputStatus.toUpperCase() : inputStatus);
  if (status === 'LOCKED') return 'CONFIRMED';
  if (status === 'PROJECTED' || status === 'ASSUMED') return 'PROBABLE';
  return 'UNKNOWN';
}

export function weatherLabel(inputStatus) {
  const status = statusLabel(typeof inputStatus === 'string' ? inputStatus.toUpperCase() : inputStatus);
  if (status === 'LOCKED') return 'UPDATED';
  if (status === 'PROJECTED' || status === 'ASSUMED') return 'PRELIMINARY';
  return 'UNKNOWN';
}

function projectionToInput(value, kind) {
  const raw = String(value ?? '').toLowerCase();
  if (kind === 'lineup') {
    if (raw.includes('unconfirmed') || raw.includes('pending') || raw.includes('project')) return 'PROJECTED';
    if (raw.includes('confirm')) return 'LOCKED';
    return 'UNKNOWN';
  }
  if (kind === 'weather') {
    if (raw.includes('complete')) return 'LOCKED';
    if (raw.includes('partial')) return 'PROJECTED';
    return 'UNKNOWN';
  }
  return 'UNKNOWN';
}

export function mapProjectionStatusToInput({ lineup_status, weather_status } = {}) {
  return {
    lineupInput: projectionToInput(lineup_status, 'lineup'),
    weatherInput: projectionToInput(weather_status, 'weather'),
  };
}

export function buildInputStatusNote({ scope, lineupInput = null, starterInput = null, weatherInput = null } = {}) {
  validateScope(scope);
  if (scope === 'FULL_DAY_PREVIEW') {
    return 'FULL_DAY_PREVIEW uses projected lineups, probable starters, preliminary weather, and current injury/news; locked lineups arrive in the slate and game packets; unconfirmed players are removed or downgraded before final game packets.';
  }
  const lineup = lineupLabel(lineupInput);
  const starter = starterLabel(starterInput);
  const weather = weatherLabel(weatherInput);
  return `Lineup ${lineup} · Starter ${starter} · Weather ${weather}. Unconfirmed players removed or downgraded before final game packet.`;
}

function withHrRemovalRule(item) {
  return Object.freeze({
    ...item,
    removal_rule: 'Remove/downgrade if not in confirmed lineup.',
  });
}

export function buildHrWatchEntry({
  scope = 'GAME_PACKET',
  player,
  team = null,
  game = null,
  status,
  basis = null,
  source = null,
  source_quality = null,
  source_url = null,
  local_source_ref = null,
  projected_hr_prob = null,
  checked_utc = null,
} = {}) {
  if (!isNonEmptyString(player)) {
    throw new Error('HR watch entry requires a non-empty player');
  }
  if (projected_hr_prob != null && (typeof projected_hr_prob !== 'number' || !Number.isFinite(projected_hr_prob) || projected_hr_prob < 0 || projected_hr_prob > 1)) {
    throw new Error('projected_hr_prob must be a probability in [0,1] when provided');
  }
  const item = buildLedgerItem({
    type: 'hr_watch',
    scope,
    team,
    player,
    game,
    value: projected_hr_prob ?? null,
    status,
    basis,
    source,
    source_url,
    local_source_ref,
    checked_utc,
    source_quality,
  });
  if (!item.supports_evidence) return null;
  return withHrRemovalRule(item);
}

export function buildHrWatchlist(entries = [], { scope = 'GAME_PACKET' } = {}) {
  if (!Array.isArray(entries)) return [];
  const out = [];
  for (const entry of entries) {
    const built = buildHrWatchEntry({ scope, ...entry });
    if (built) out.push(built);
  }
  return out;
}
