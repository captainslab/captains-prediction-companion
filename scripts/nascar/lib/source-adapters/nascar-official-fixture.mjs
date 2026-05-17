// Read-only fixture adapter for NASCAR official race/event context.
// Fixture-first. No authenticated endpoints. No order placement. No live network by default.
//
// Provides race-name, series, track, scheduled time, race_type, and event_format
// so downstream stages can detect All-Star / Clash / exhibition / heat / transfer /
// cutdown events and apply special_event_override.

import { isoNow, makeEnvelope } from '../cache.mjs';

export const SOURCE_ID = 'nascar_official';
export const NASCAR_PUBLIC_BASE = 'https://www.nascar.com/schedule';

export const SERIES_CODES = Object.freeze({
  cup: 'NCS',
  xfinity: 'NXS',
  trucks: 'NTS',
});

// Event formats Stage 2 must surface (special_event_override handled later by scoring).
export const EVENT_FORMATS = Object.freeze([
  'points',
  'all_star',
  'clash',
  'exhibition',
  'heat',
  'qualifying_transfer',
  'cutdown',
]);

function raceContextRecord({
  race_name,
  series,
  track,
  track_type,
  scheduled_start_utc,
  race_type,
  event_format,
  stage_lengths,
}) {
  return {
    query_type: 'race_event_context',
    race_name,
    series,
    track,
    track_type, // superspeedway|intermediate|short|road|drafting|street
    scheduled_start_utc,
    race_type, // points|all_star|clash|qualifying_event
    event_format, // see EVENT_FORMATS
    stage_lengths: stage_lengths ?? null,
    is_special_event: event_format !== 'points',
    source_urls: [NASCAR_PUBLIC_BASE],
    notes:
      event_format !== 'points'
        ? 'Special event: downstream scoring must apply special_event_override; do not use as default model.'
        : null,
  };
}

export function fixtureNascarOfficialEnvelope({
  checked_at_utc = '2026-05-15T14:00:00.000Z',
  outputDir = 'state/nascar/_dry-run/discovery',
  event_format = 'points',
  series = 'cup',
} = {}) {
  const records =
    event_format === 'all_star'
      ? [
          raceContextRecord({
            race_name: 'NASCAR All-Star Race',
            series: SERIES_CODES[series] ?? SERIES_CODES.cup,
            track: 'North Wilkesboro Speedway',
            track_type: 'short',
            scheduled_start_utc: '2026-05-17T00:00:00.000Z',
            race_type: 'all_star',
            event_format: 'all_star',
            stage_lengths: [100, 100, 50, 50],
          }),
        ]
      : [
          raceContextRecord({
            race_name: 'Daytona 500',
            series: SERIES_CODES[series] ?? SERIES_CODES.cup,
            track: 'Daytona International Speedway',
            track_type: 'superspeedway',
            scheduled_start_utc: '2026-02-15T19:30:00.000Z',
            race_type: 'points',
            event_format: 'points',
            stage_lengths: [65, 65, 70],
          }),
        ];

  const warnings = ['Fixture mode: no live NASCAR official source was called.'];
  if (event_format !== 'points') {
    warnings.push(
      `Fixture event_format="${event_format}" surfaced; scoring must trigger special_event_override.`,
    );
  }

  return makeEnvelope({
    source_id: SOURCE_ID,
    status: 'ok',
    checked_at_utc,
    cache_path: `${outputDir}/nascar_official_adapter.json`,
    required: true,
    records,
    warnings,
    source_urls: [NASCAR_PUBLIC_BASE],
  });
}

export async function fetchNascarOfficialReadonly({
  outputDir = 'state/nascar/_dry-run/discovery',
  fixturesOnly = true,
  now = new Date(),
  event_format = 'points',
  series = 'cup',
} = {}) {
  const checked_at_utc = isoNow(now);
  if (fixturesOnly) {
    return fixtureNascarOfficialEnvelope({ checked_at_utc, outputDir, event_format, series });
  }
  return makeEnvelope({
    source_id: SOURCE_ID,
    status: 'blocked',
    checked_at_utc,
    cache_path: `${outputDir}/nascar_official_adapter.json`,
    required: true,
    errors: ['Live mode not implemented in Stage 2; fixtures-only.'],
    source_urls: [NASCAR_PUBLIC_BASE],
  });
}
