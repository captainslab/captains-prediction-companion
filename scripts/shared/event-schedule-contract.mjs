function toIso(value) {
  if (value == null) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

export function buildEventScheduleContract({
  eventFamily = null,
  eventTicker = null,
  eventKey = null,
  eventStartUtc,
  authority,
  sourceUrl,
  retrievedAtUtc = null,
  status = 'fresh',
  idempotencyKey = null,
  rawStartField = null,
  prepareOffsetMinutes = null,
  reportOffsetMinutes = null,
  sourceStatus = null,
  metadata = {},
}) {
  const startIso = toIso(eventStartUtc);
  if (!startIso) {
    throw new Error('buildEventScheduleContract requires a valid eventStartUtc');
  }
  const schedule = {
    event_family: eventFamily,
    event_ticker: eventTicker,
    event_key: eventKey,
    event_start_utc: startIso,
    prepare_at_utc: Number.isFinite(prepareOffsetMinutes) ? new Date(Date.parse(startIso) - prepareOffsetMinutes * 60_000).toISOString() : null,
    report_at_utc: Number.isFinite(reportOffsetMinutes) ? new Date(Date.parse(startIso) - reportOffsetMinutes * 60_000).toISOString() : null,
    authority,
    source_url: sourceUrl,
    retrieved_at_utc: retrievedAtUtc,
    status,
    idempotency_key: idempotencyKey,
    raw_start_field: rawStartField,
    source_status: sourceStatus ?? status,
  };
  return { ...schedule, ...metadata };
}
