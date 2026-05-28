// Source adapter: earnings mentions
//
// Returns layer records for the earnings_mentions profile.
// Canonical test event: Dell Earnings Call (keywords: Tailwind, PowerEdge, Headwind)
//
// Closed-event calendar applies to earnings markets the same as political markets:
// check the calendar icon (top-right of the Kalshi board) for the last 6 closed
// earnings events for this company before scraping external transcripts.
//
// Three layers now fully wired (previously stubbed):
//   baseline_relevance   — transcript frequency + analyst density + core-metric flag
//   source_velocity      — independent source coverage aggregation
//   sec_filing_language  — SEC filing / press release keyword presence
//
// NEVER include bid/ask/odds/volume/open_interest/line_movement in any record.

export {
  buildBaselineRelevanceRecord,
  buildSourceVelocityRecord,
  buildSecFilingLanguageRecord,
} from './earnings-layer-builders.mjs';

import {
  buildBaselineRelevanceRecord,
  buildSourceVelocityRecord,
  buildSecFilingLanguageRecord,
} from './earnings-layer-builders.mjs';

/**
 * buildEarningsLayerRecords
 *
 * @param {object} opts
 * @param {string}  opts.company            - Company name (e.g. "Dell Technologies")
 * @param {string}  opts.keyword            - Target mention keyword (e.g. "PowerEdge")
 * @param {object?} opts.earningsEvent      - { call_date_utc, confirmed, fiscal_quarter }
 * @param {object?} opts.closedEventHitRate - { hits, total } from closed-event calendar
 * @param {object?} opts.secFilingMatch     - { found: boolean, filing_type, snippet } from SEC filings
 *                                           OR { pressReleaseMentions, tenKMentions, tenQMentions, inRiskFactors, ... }
 * @param {object?} opts.analystCoverage    - { mentions_in_coverage: boolean, detail } from analyst reports
 * @param {object?} opts.baselineRelevance  - args for buildBaselineRelevanceRecord (transcriptHitRate, etc.)
 * @param {object?} opts.sourceVelocity     - args for buildSourceVelocityRecord (sources array, etc.)
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
  baselineRelevance = null,
  sourceVelocity = null,
} = {}) {
  const records = {};

  // baseline_relevance — source-backed via buildBaselineRelevanceRecord
  records.baseline_relevance = baselineRelevance
    ? buildBaselineRelevanceRecord({ company, keyword, ...baselineRelevance })
    : { present: false, score: null,
        source_basis: 'earnings adapter: no baselineRelevance data supplied',
        source_path: null, detail: null,
        missing_note: 'supply baselineRelevance: { transcriptHitRate, transcriptAvgHitsPerCall, isCoreProductOrMetric, analystTopicScore }' };

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

  // sec_filing_language — source-backed via buildSecFilingLanguageRecord
  // Accepts either the legacy { found, filing_type, snippet } shape or the richer
  // { pressReleaseMentions, tenKMentions, tenQMentions, inRiskFactors, ... } shape.
  if (secFilingMatch !== null && secFilingMatch !== undefined) {
    const hasRichData = 'pressReleaseMentions' in secFilingMatch
      || 'tenKMentions' in secFilingMatch
      || 'tenQMentions' in secFilingMatch;
    if (hasRichData) {
      records.sec_filing_language = buildSecFilingLanguageRecord({ company, keyword, ...secFilingMatch });
    } else if (secFilingMatch.found === true) {
      records.sec_filing_language = buildSecFilingLanguageRecord({
        company, keyword,
        pressReleaseMentions: 1,
        filingType: secFilingMatch.filing_type ?? 'SEC filing',
        sourceUrl: secFilingMatch.source_url ?? null,
        snippet: secFilingMatch.snippet ?? null,
      });
    } else {
      records.sec_filing_language = buildSecFilingLanguageRecord({
        company, keyword,
        pressReleaseMentions: 0,
        tenKMentions: 0,
        filingType: secFilingMatch.filing_type ?? 'SEC filings searched',
        sourceUrl: secFilingMatch.source_url ?? null,
      });
    }
  } else {
    records.sec_filing_language = {
      present: false, score: null,
      source_basis: 'earnings adapter: no SEC filing data supplied',
      source_path: null, detail: null,
      missing_note: 'supply secFilingMatch: { pressReleaseMentions, tenKMentions, tenQMentions } from SEC EDGAR search',
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

  // source_velocity — source-backed via buildSourceVelocityRecord
  records.source_velocity = sourceVelocity
    ? buildSourceVelocityRecord({ company, keyword, ...sourceVelocity })
    : { present: false, score: null,
        source_basis: 'earnings adapter: no sourceVelocity data supplied',
        source_path: null, detail: null,
        missing_note: 'supply sourceVelocity: { sources: [{ type, mentionsKeyword, recencyDays }] }' };

  // Remaining layers — stubs requiring live integration
  const stubs = [
    ['direct_mention_pathway',     'prior call script / IR talking-points review (stub)'],
    ['prepared_remarks_likelihood','prior call opening-script keyword analysis (stub)'],
    ['suppression_signal',         'PR/legal suppression-risk analysis (stub)'],
    ['evidence_quality',           'official earnings date + transcript source quality check (stub)'],
  ];
  for (const [key, note] of stubs) {
    records[key] = {
      present: false,
      score: null,
      source_basis: `earnings adapter: ${note}`,
      source_path: null,
      detail: null,
      missing_note: `${key} requires live source integration`,
    };
  }

  return records;
}
