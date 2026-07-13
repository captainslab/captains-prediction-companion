// Conservative data-quality gates for HR profiles. No value is imputed here.
import { assertNoPriceFields } from '../lib/projection-contracts.mjs';
import { assertKnownFields } from './contracts.mjs';

export const HR_QUALITY_THRESHOLDS = Object.freeze({
  '7d': 3,
  '30d': 5,
  season: 8,
  stale_after_days: 14,
});

const REQUIRED_WINDOWS = Object.freeze(['7d', '30d', 'season']);

function asFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function ymd(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  const left = new Date(`${a}T00:00:00.000Z`).getTime();
  const right = new Date(`${b}T00:00:00.000Z`).getTime();
  return Number.isFinite(left) && Number.isFinite(right) ? Math.max(0, (right - left) / 86400000) : null;
}

export function assessDataQuality(input = {}) {
  assertNoPriceFields(input, 'HR data quality input');
  assertKnownFields(input, ['windows', 'latest_event_date', 'as_of', 'missing_fields', 'thresholds'], 'HR data quality input');
  const {
    windows = {},
    latest_event_date = null,
    as_of = null,
    missing_fields = [],
    thresholds = HR_QUALITY_THRESHOLDS,
  } = input;
  const effectiveThresholds = { ...HR_QUALITY_THRESHOLDS, ...(thresholds ?? {}) };
  const reasons = [];
  const present = [];
  const sample_sizes = {};
  for (const window of REQUIRED_WINDOWS) {
    const row = windows?.[window];
    const pa = Number.isInteger(row?.pa) ? row.pa : 0;
    sample_sizes[window] = Math.max(0, pa);
    if (row && pa > 0) present.push(window);
    if (!row) reasons.push(`window_missing:${window}`);
    else if (pa < effectiveThresholds[window]) reasons.push(`sample_below_threshold:${window}`);
  }
  for (const field of missing_fields) reasons.push(`field_missing:${field}`);
  const latest = ymd(latest_event_date);
  const target = ymd(as_of);
  const age = latest && target ? daysBetween(latest, target) : null;
  const staleAfterDays = asFinite(effectiveThresholds.stale_after_days);
  const staleThresholdInvalid = staleAfterDays == null;
  const stale = staleThresholdInvalid || age == null ? true : age > staleAfterDays;
  if (staleThresholdInvalid) reasons.push('stale_threshold_invalid');
  if (age == null) reasons.push('freshness_unverified');
  else if (stale) reasons.push('data_stale');
  const expectedChecks = REQUIRED_WINDOWS.length + 1 + missing_fields.length;
  const failedChecks = reasons.filter((reason) => reason.startsWith('window_missing') || reason.startsWith('sample_below') || reason.startsWith('field_missing') || reason === 'freshness_unverified' || reason === 'data_stale' || reason === 'stale_threshold_invalid').length;
  const data_completeness = Math.max(0, Math.min(1, (expectedChecks - failedChecks) / expectedChecks));
  const blocked = reasons.some((reason) => reason.startsWith('window_missing') || reason.startsWith('sample_below') || reason.startsWith('field_missing') || reason === 'freshness_unverified' || reason === 'data_stale' || reason === 'stale_threshold_invalid');
  const uncertainty = {
    status: blocked ? 'blocked' : (reasons.length ? 'elevated' : 'standard'),
    reasons,
    interval: blocked ? null : { low: 0, high: 1 },
    confidence_band: blocked ? 'unavailable' : (reasons.length ? 'wide' : 'moderate'),
    data_completeness,
  };
  const coverage = {
    windows_present: present,
    required_windows: [...REQUIRED_WINDOWS],
    sample_sizes,
    data_completeness,
    latest_event_date: latest,
    as_of: target,
    stale,
    missing_fields: [...missing_fields],
  };
  return { status: blocked ? 'blocked' : 'ready', blocked_reasons: reasons, uncertainty, coverage };
}
