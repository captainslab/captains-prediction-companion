// Source adapter stub: earnings mentions
//
// Returns layer records for the earnings_mentions profile.
// Canonical test event: Dell Earnings Call (keywords: Tailwind, PowerEdge, Headwind)
//
// Closed-event calendar applies to earnings markets the same as political markets:
// check the calendar icon (top-right of the Kalshi board) for the last 6 closed
// earnings events for this company before scraping external transcripts.
//
// When a live data source is wired, replace the relevant stub record with a
// real fetcher that returns { present: true, score, source_basis, source_path, detail }.
//
// NEVER include bid/ask/odds/volume/open_interest/line_movement in any record.

/**
 * buildEarningsLayerRecords
 *
 * @param {object} opts
 * @param {string}  opts.company          - Company name (e.g. "Dell Technologies")
 * @param {string}  opts.keyword          - Target mention keyword (e.g. "PowerEdge")
 * @param {object?} opts.earningsEvent    - { call_date_utc, confirmed, fiscal_quarter }
 * @param {object?} opts.closedEventHitRate - { hits, total } from closed-event calendar
 * @param {object?} opts.secFilingMatch   - { found: boolean, filing_type, snippet } from SEC filings
 * @param {object?} opts.analystCoverage  - { mentions_in_coverage: boolean, detail } from analyst reports
 *
 * @returns {object} Map of layerKey → layer record
 */
export function buildEarningsLayerRecords({
  company,
  keyword,
  earningsEvent = null,
  closedEventHitRate = null,
  secFilingMatch = null,
  analystCoverage = null,
} = {}) {
  const records = {};

  // baseline_relevance — stub
  records.baseline_relevance = {
    present: false,
    score: null,
    source_basis: 'earnings-calendar-stub: requires product/segment-fit lookup',
    source_path: null,
    detail: null,
    missing_note: `no baseline relevance data for "${company}" / "${keyword}"`,
  };

  // event_proximity — populated if earnings event is provided
  if (earningsEvent?.call_date_utc && earningsEvent?.confirmed) {
    const msUntil = new Date(earningsEvent.call_date_utc) - Date.now();
    const hoursOut = msUntil / 3_600_000;
    let score = 10;
    if (hoursOut <= 1)   score = 99; // call is imminent
    else if (hoursOut <= 4)   score = 95;
    else if (hoursOut <= 12)  score = 85;
    else if (hoursOut <= 24)  score = 70;
    else if (hoursOut <= 72)  score = 50;
    else if (hoursOut <= 168) score = 30;
    records.event_proximity = {
      present: true,
      score,
      source_basis: `confirmed earnings call schedule (${earningsEvent.fiscal_quarter ?? 'quarter unknown'})`,
      source_path: earningsEvent.source_url ?? null,
      detail: `${company} earnings call at ${earningsEvent.call_date_utc} (~${Math.round(Math.max(0, hoursOut))}h out)`,
      missing_note: null,
    };
  } else {
    records.event_proximity = {
      present: false,
      score: null,
      source_basis: 'earnings-calendar-stub: no confirmed earnings call date supplied',
      source_path: null,
      detail: null,
      missing_note: 'confirm earnings call date and time from IR calendar or SEC 8-K filing',
    };
  }

  // historical_tendency — populated from closed-event calendar (primary source for earnings)
  if (closedEventHitRate && Number.isFinite(closedEventHitRate.hits) && Number.isFinite(closedEventHitRate.total) && closedEventHitRate.total > 0) {
    const rate = closedEventHitRate.hits / closedEventHitRate.total;
    // Earnings calls are formulaic — hit rate maps directly to score
    const score = Math.round(rate * 100);
    records.historical_tendency = {
      present: true,
      score,
      source_basis: `closed-event calendar: ${closedEventHitRate.hits}/${closedEventHitRate.total} prior ${company} earnings events resolved YES`,
      source_path: null,
      detail: `hit rate ${(rate * 100).toFixed(0)}% over last ${closedEventHitRate.total} closed events`,
      missing_note: null,
    };
  } else {
    records.historical_tendency = {
      present: false,
      score: null,
      source_basis: 'earnings-calendar-stub: no closed-event hit rate supplied',
      source_path: null,
      detail: null,
      missing_note: 'check closed-event calendar (top-right calendar icon on Kalshi board) for prior earnings hit rates',
    };
  }

  // sec_filing_language — populated if SEC filing match is provided
  if (secFilingMatch?.found === true) {
    records.sec_filing_language = {
      present: true,
      score: 72,
      source_basis: `${secFilingMatch.filing_type ?? 'SEC filing'} contains keyword "${keyword}"`,
      source_path: secFilingMatch.source_url ?? null,
      detail: secFilingMatch.snippet ?? `"${keyword}" found in ${secFilingMatch.filing_type}`,
      missing_note: null,
    };
  } else if (secFilingMatch?.found === false) {
    records.sec_filing_language = {
      present: true,
      score: 20,
      source_basis: `SEC filings searched; keyword "${keyword}" not found in recent filings`,
      source_path: secFilingMatch.source_url ?? null,
      detail: `"${keyword}" absent from ${secFilingMatch.filing_type ?? 'SEC filings'}`,
      missing_note: null,
    };
  } else {
    records.sec_filing_language = {
      present: false,
      score: null,
      source_basis: 'earnings-calendar-stub: SEC filing search not yet performed',
      source_path: null,
      detail: null,
      missing_note: 'search SEC EDGAR for 10-K/10-Q/8-K containing this keyword',
    };
  }

  // analyst_qa_pathway — populated if analyst coverage is provided
  if (analystCoverage?.mentions_in_coverage === true) {
    records.analyst_qa_pathway = {
      present: true,
      score: 70,
      source_basis: 'analyst coverage confirms keyword is an active Q&A topic',
      source_path: null,
      detail: analystCoverage.detail ?? `analysts have asked about "${keyword}" in recent coverage`,
      missing_note: null,
    };
  } else if (analystCoverage?.mentions_in_coverage === false) {
    records.analyst_qa_pathway = {
      present: true,
      score: 25,
      source_basis: 'analyst coverage reviewed; keyword not an active Q&A topic',
      source_path: null,
      detail: analystCoverage.detail ?? `"${keyword}" not prominent in recent analyst coverage`,
      missing_note: null,
    };
  } else {
    records.analyst_qa_pathway = {
      present: false,
      score: null,
      source_basis: 'earnings-calendar-stub: analyst coverage review not yet performed',
      source_path: null,
      detail: null,
      missing_note: 'review analyst reports and earnings preview notes for this keyword',
    };
  }

  // Remaining layers — stubs
  const stubs = [
    ['source_velocity',            'press/analyst keyword velocity search (stub)'],
    ['direct_mention_pathway',     'prior call script / IR talking-points review (stub)'],
    ['prepared_remarks_likelihood','prior call opening-script keyword analysis (stub)'],
    ['suppression_signal',         'PR/legal suppression-risk analysis (stub)'],
    ['evidence_quality',           'official earnings date + transcript source quality check (stub)'],
  ];
  for (const [key, note] of stubs) {
    records[key] = {
      present: false,
      score: null,
      source_basis: `earnings-calendar-stub: ${note}`,
      source_path: null,
      detail: null,
      missing_note: `${key} requires live source integration`,
    };
  }

  return records;
}
