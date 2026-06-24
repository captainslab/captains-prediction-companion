// Matchday window selection.
//
// "Today's matches" are the matches whose kickoff falls on the target calendar
// date in the operating timezone (America/Chicago), NOT the UTC date. Filtering
// on the UTC date both drops late kickoffs that roll past midnight UTC and
// wrongly pulls in early kickoffs that are still "yesterday" locally.

export const CPC_MATCHDAY_TIMEZONE = 'America/Chicago';

// Returns the YYYY-MM-DD calendar date of a UTC instant in the given timezone.
// en-CA formats as YYYY-MM-DD, which sorts/compares as ISO date.
export function localDateInTimeZone(isoUtc, timeZone = CPC_MATCHDAY_TIMEZONE) {
  const d = new Date(isoUtc);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

// Filters matches to those whose kickoff lands on `date` (YYYY-MM-DD) in the
// given timezone. Matches without a kickoff are excluded.
export function filterMatchesForLocalDate(matches, date, timeZone = CPC_MATCHDAY_TIMEZONE) {
  return (matches || []).filter(m => {
    if (!m || !m.kickoff_utc) return false;
    return localDateInTimeZone(m.kickoff_utc, timeZone) === date;
  });
}
