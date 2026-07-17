function toIso(value) {
  if (value == null) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

const PREPARE_LEAD_MINUTES = 5;

function idempotencyKeyFromParts(parts) {
  if (Array.isArray(parts)) return parts.map((part) => String(part)).join(':');
  if (parts == null) return null;
  return String(parts);
}

/**
 * Build the canonical per-event report window used by each event family.
 *
 * `reportAtUtc` is supplied by the caller so an event family cannot silently
 * substitute a non-authoritative timestamp (for example, a market close
 * time) for its report schedule.
 */
export function buildReportWindow({
  eventFamily,
  eventKey,
  clusterId,
  reportAtUtc,
  eventStartAuthority,
  eventStartSourceUrl,
  eventStartRetrievedUtc = null,
  eventStartRaw,
  prelockMinutes,
  retryOffsetsMinutes = [5, 10],
  idempotencyKeyParts,
}) {
  const startIso = toIso(eventStartRaw);
  const reportIso = toIso(reportAtUtc);
  const startMs = Date.parse(startIso ?? '');
  const reportMs = Date.parse(reportIso ?? '');
  if (!Number.isFinite(startMs)) throw new Error('buildReportWindow requires a valid eventStartRaw');
  if (!Number.isFinite(reportMs)) throw new Error('buildReportWindow requires a valid reportAtUtc');
  if (!Number.isFinite(prelockMinutes) || prelockMinutes < 0) throw new Error('buildReportWindow requires non-negative prelockMinutes');
  if (!Array.isArray(retryOffsetsMinutes) || retryOffsetsMinutes.some((offset) => !Number.isFinite(Number(offset)) || Number(offset) < 0)) {
    throw new Error('buildReportWindow requires non-negative retryOffsetsMinutes');
  }

  const window = {
    cluster_id: clusterId,
    lead_first_pitch_utc: startIso,
    lead_first_pitch_ct: null,
    event_start_authority: eventStartAuthority,
    event_start_source_url: eventStartSourceUrl,
    event_start_retrieved_utc: eventStartRetrievedUtc,
    event_start_raw: eventStartRaw,
    event_start_freshness: 'fresh',
    prepare_at_utc: new Date(startMs - (prelockMinutes + PREPARE_LEAD_MINUTES) * 60_000).toISOString(),
    report_at_utc: reportIso,
    report_at_ct: null,
    retry_at_utc: retryOffsetsMinutes.map((offset) => new Date(reportMs + Number(offset) * 60_000).toISOString()),
    retry_index: 0,
    game_keys: [eventKey],
    idempotency_key: idempotencyKeyFromParts(idempotencyKeyParts),
    status: 'pending',
    event_family: eventFamily,
    event_key: eventKey,
  };
  assertValidReportWindow(window);
  return window;
}

export function assertValidReportWindow(window) {
  const missing = ['report_at_utc', 'idempotency_key', 'event_start_authority', 'event_start_source_url', 'status']
    .filter((field) => window?.[field] == null || window[field] === '');
  if (missing.length) throw new Error(`Invalid report_window: missing ${missing.join(', ')}`);
  if (!Number.isFinite(Date.parse(window.report_at_utc))) throw new Error('Invalid report_window: report_at_utc must be a valid timestamp');
  if (!Array.isArray(window.retry_at_utc) || window.retry_at_utc.some((value) => !Number.isFinite(Date.parse(value)))) {
    throw new Error('Invalid report_window: retry_at_utc must contain valid timestamps');
  }
  if (!Number.isInteger(window.retry_index) || window.retry_index < 0) {
    throw new Error('Invalid report_window: retry_index must be a non-negative integer');
  }
  return true;
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
