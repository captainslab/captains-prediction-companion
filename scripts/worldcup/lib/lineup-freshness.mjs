// World Cup lineup freshness helpers.
//
// For lineup-sensitive generation, the cache must come from the current
// official lineup snapshot, not an older or mismatched artifact.

function parseDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const MAX_LINEUP_CACHE_AGE_MS = 12 * 60 * 60 * 1000;

function normalizeEventState(value) {
  const state = String(value ?? '').trim().toLowerCase();
  if (!state) return null;
  if (state === 'pre') return 'pre';
  if (state === 'in' || state === 'in_game' || state === 'in-game' || state === 'live' || state === 'halftime' || state === 'paused') {
    return 'in_game';
  }
  return state;
}

function identityMatches(matchday, matchId) {
  if (!matchId) return true;
  let matched = false;
  const matchdayId = matchday?.match_id ?? null;
  if (matchdayId !== null && matchdayId !== undefined) {
    matched = true;
    if (String(matchdayId) !== String(matchId)) return false;
  }
  const sourceEventId = matchday?.source?.event_id ?? null;
  if (sourceEventId !== null && sourceEventId !== undefined) {
    matched = true;
    if (String(sourceEventId) !== String(matchId)) return false;
  }
  return matched;
}

export function evaluateLineupCacheFreshness(matchday, options = {}) {
  const opts = typeof options === 'string' ? { refreshStartedAtIso: options } : (options || {});
  const matchId = opts.matchId ?? null;
  const kickoffUtc = opts.kickoffUtc ?? null;
  const refreshStartedAtIso = opts.refreshStartedAtIso ?? null;

  if (!matchday || !matchday.ok) {
    return { verified: false, reason: 'matchday cache missing or not ok', identity_matched: false, fresh_within_kickoff_window: false };
  }

  if (!identityMatches(matchday, matchId)) {
    return { verified: false, reason: 'match_id mismatch', identity_matched: false, fresh_within_kickoff_window: false };
  }

  const source = matchday.source ?? {};
  const sourceEventId = source.event_id ?? null;
  if (!sourceEventId) {
    return { verified: false, reason: 'source.event_id missing', identity_matched: false, fresh_within_kickoff_window: false };
  }

  const state = normalizeEventState(source.event_state);
  if (state !== 'pre' && state !== 'in_game') {
    return {
      verified: false,
      reason: `source.event_state=${source.event_state ?? 'missing'} is not pre/in-game`,
      identity_matched: true,
      fresh_within_kickoff_window: false,
      source_event_state: source.event_state ?? null,
      source_event_id: sourceEventId,
    };
  }

  const fetchedAt = parseDate(matchday.fetched_utc);
  if (!fetchedAt) {
    return {
      verified: false,
      reason: 'fetched_utc missing or invalid',
      identity_matched: true,
      fresh_within_kickoff_window: false,
      source_event_state: source.event_state ?? null,
      source_event_id: sourceEventId,
    };
  }

  const kickoffAt = parseDate(kickoffUtc);
  if (!kickoffAt) {
    return {
      verified: false,
      reason: 'kickoff_utc missing or invalid',
      identity_matched: true,
      fresh_within_kickoff_window: false,
      source_event_state: source.event_state ?? null,
      source_event_id: sourceEventId,
      fetched_utc: matchday.fetched_utc ?? null,
    };
  }

  const ageMs = kickoffAt.getTime() - fetchedAt.getTime();
  const freshWithinWindow = Math.abs(ageMs) <= MAX_LINEUP_CACHE_AGE_MS;
  if (!freshWithinWindow) {
    return {
      verified: false,
      reason: `fetched_utc is outside the ${MAX_LINEUP_CACHE_AGE_MS / 36e5}h kickoff window`,
      identity_matched: true,
      fresh_within_kickoff_window: false,
      source_event_state: source.event_state ?? null,
      source_event_id: sourceEventId,
      fetched_utc: matchday.fetched_utc ?? null,
      kickoff_utc: kickoffUtc ?? null,
      age_minutes: Math.round(ageMs / 60000),
    };
  }

  if (state === 'pre' && ageMs < 0) {
    return {
      verified: false,
      reason: 'fetched after kickoff while event_state is pre',
      identity_matched: true,
      fresh_within_kickoff_window: false,
      source_event_state: source.event_state ?? null,
      source_event_id: sourceEventId,
      fetched_utc: matchday.fetched_utc ?? null,
      kickoff_utc: kickoffUtc ?? null,
      age_minutes: Math.round(ageMs / 60000),
    };
  }

  if (refreshStartedAtIso) {
    const refreshStartedAt = parseDate(refreshStartedAtIso);
    if (!refreshStartedAt || fetchedAt.getTime() < refreshStartedAt.getTime()) {
      return {
        verified: false,
        reason: 'fetched_utc predates lineup refresh start',
        identity_matched: true,
        fresh_within_kickoff_window: true,
        source_event_state: source.event_state ?? null,
        source_event_id: sourceEventId,
        fetched_utc: matchday.fetched_utc ?? null,
        kickoff_utc: kickoffUtc ?? null,
        age_minutes: Math.round(ageMs / 60000),
      };
    }
  }

  return {
    verified: true,
    reason: 'fresh identity-matched official lineup cache',
    identity_matched: true,
    fresh_within_kickoff_window: true,
    source_event_state: source.event_state ?? null,
    source_event_id: sourceEventId,
    fetched_utc: matchday.fetched_utc ?? null,
    kickoff_utc: kickoffUtc ?? null,
    age_minutes: Math.round(ageMs / 60000),
  };
}

export function isFreshLineupCache(matchday, options) {
  return evaluateLineupCacheFreshness(matchday, options).verified;
}
