// Source adapter stub: political mentions
//
// Returns layer records for the political_mentions profile.
// Stub mode: returns structured records with present=false and clear missing_note
// for layers that require live source integration.
//
// When a live data source is wired, replace the relevant stub record with a
// real fetcher that returns { present: true, score, source_basis, source_path, detail }.
//
// NEVER include bid/ask/odds/volume/open_interest/line_movement in any record.
// Those belong in market_context only (composeMentionLedger parameter).

/**
 * buildPoliticalLayerRecords
 *
 * @param {object} opts
 * @param {string}  opts.speaker          - Speaker name (e.g. "Bernie Sanders")
 * @param {string}  opts.keyword          - Target mention keyword
 * @param {object?} opts.schedule         - { event_type, event_date_utc, confirmed } if known
 * @param {object?} opts.closedEventHitRate - { hits, total } from closed-event calendar
 * @param {number?} opts.hoursUntilClose  - Hours until market settlement
 *
 * @returns {object} Map of layerKey → layer record
 */
export function buildPoliticalLayerRecords({
  speaker,
  keyword,
  schedule = null,
  closedEventHitRate = null,
  hoursUntilClose = null,
} = {}) {
  const records = {};

  // baseline_relevance — stub: requires topic-fit lookup
  records.baseline_relevance = {
    present: false,
    score: null,
    source_basis: 'political-schedule-stub: requires topic-fit lookup for speaker/keyword pair',
    source_path: null,
    detail: null,
    missing_note: `no baseline relevance data for "${speaker}" / "${keyword}"`,
  };

  // event_proximity — populated if schedule is provided
  if (schedule?.event_date_utc && schedule?.confirmed) {
    const msUntil = new Date(schedule.event_date_utc) - Date.now();
    const hoursOut = msUntil / 3_600_000;
    // Score: 100 if within 2h, 80 if within 12h, 60 if today, 40 if tomorrow, 20 if 2-7 days
    let score = 10;
    if (hoursOut <= 2) score = 98;
    else if (hoursOut <= 12) score = 82;
    else if (hoursOut <= 24) score = 65;
    else if (hoursOut <= 48) score = 45;
    else if (hoursOut <= 168) score = 25;
    records.event_proximity = {
      present: true,
      score,
      source_basis: `official ${schedule.event_type} schedule (confirmed)`,
      source_path: schedule.source_url ?? null,
      detail: `${schedule.event_type} at ${schedule.event_date_utc} (~${Math.round(Math.max(0, hoursOut))}h out)`,
      missing_note: null,
    };
  } else {
    records.event_proximity = {
      present: false,
      score: null,
      source_basis: 'political-schedule-stub: no confirmed event schedule supplied',
      source_path: null,
      detail: null,
      missing_note: 'no confirmed rally/interview/hearing/debate schedule for this window',
    };
  }

  // historical_tendency — populated from closed-event calendar hit rate
  if (closedEventHitRate && Number.isFinite(closedEventHitRate.hits) && Number.isFinite(closedEventHitRate.total) && closedEventHitRate.total > 0) {
    const rate = closedEventHitRate.hits / closedEventHitRate.total;
    const score = Math.round(rate * 100);
    records.historical_tendency = {
      present: true,
      score,
      source_basis: `closed-event calendar: ${closedEventHitRate.hits}/${closedEventHitRate.total} prior events resolved YES`,
      source_path: null,
      detail: `hit rate ${(rate * 100).toFixed(0)}% (${closedEventHitRate.hits} of ${closedEventHitRate.total} closed events)`,
      missing_note: null,
    };
  } else {
    records.historical_tendency = {
      present: false,
      score: null,
      source_basis: 'political-schedule-stub: no closed-event hit rate supplied',
      source_path: null,
      detail: null,
      missing_note: 'check closed-event calendar (top-right calendar icon) for prior speech hit rates',
    };
  }

  // Remaining layers — stubs requiring live integration
  const stubs = [
    ['source_velocity',        'transcript/article search for recent keyword mentions (stub)'],
    ['direct_mention_pathway', 'talking-points database / confirmed prepared remarks (stub)'],
    ['news_cycle_pressure',    'news-cycle keyword frequency analysis (stub)'],
    ['opponent_topic_relevance','debate agenda / opponent statement analysis (stub)'],
    ['suppression_signal',     'political-incentive suppression analysis (stub)'],
    ['evidence_quality',       'official-schedule + credible-source quality check (stub)'],
  ];
  for (const [key, note] of stubs) {
    records[key] = {
      present: false,
      score: null,
      source_basis: `political-schedule-stub: ${note}`,
      source_path: null,
      detail: null,
      missing_note: `${key} requires live source integration`,
    };
  }

  return records;
}
