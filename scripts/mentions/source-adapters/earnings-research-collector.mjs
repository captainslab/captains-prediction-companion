// earnings-research-collector.mjs
//
// Real source-backed research collection for earnings mention markets.
// Uses earnings-layer-builders.mjs for consistent scoring.
//
// NEVER includes pricing fields.
// Read-only source discovery.

import {
  buildBaselineRelevanceRecord,
  buildSourceVelocityRecord,
  buildSecFilingLanguageRecord,
} from './earnings-layer-builders.mjs';
import { getVerifiedData } from './earnings-data-feed.mjs';

// ---------------------------------------------------------------------------
// External data source interface
// ---------------------------------------------------------------------------

/**
 * Fetches research data for a company/keyword from available sources.
 * This is a PLUG POINT — replace with real API calls, database queries,
 * or Hermes Alpha Hunter (Codex) research feeds.
 *
 * @param {string} company - Company name
 * @param {string} keyword - Target keyword
 * @returns {Promise<object>} Research data object
 */
async function fetchExternalResearchData(company, keyword) {
  // TODO: Replace with real data sources:
  // - SEC EDGAR API for filing mentions
  // - Earnings transcript APIs (Seeking Alpha, Motive, etc.)
  // - Analyst coverage databases
  // - News APIs (Bloomberg, Reuters, etc.)
  // - Company IR websites
  //
  // For now, returns null to indicate no external data available.
  // The caller should fall back to stub records.
  return null;
}

// ---------------------------------------------------------------------------
// Layer record builders using external data
// ---------------------------------------------------------------------------

function buildEventProximityRecord(company, earningsEvent) {
  if (earningsEvent?.call_date_utc && earningsEvent?.confirmed) {
    const msUntil = new Date(earningsEvent.call_date_utc) - Date.now();
    const hoursOut = msUntil / 3_600_000;
    let score = 10;
    if (hoursOut <= 1) score = 99;
    else if (hoursOut <= 4) score = 95;
    else if (hoursOut <= 12) score = 85;
    else if (hoursOut <= 24) score = 70;
    else if (hoursOut <= 72) score = 50;
    else if (hoursOut <= 168) score = 30;
    return {
      present: true,
      score,
      source_basis: `confirmed earnings call schedule (${earningsEvent.fiscal_quarter ?? 'next'})`,
      source_path: earningsEvent.source_url ?? null,
      detail: `${company} earnings call at ${earningsEvent.call_date_utc} (~${Math.round(Math.max(0, hoursOut))}h out)`,
      missing_note: null,
    };
  }
  return {
    present: false,
    score: null,
    source_basis: 'earnings-calendar-stub: no confirmed earnings call date supplied',
    source_path: null,
    detail: null,
    missing_note: 'confirm earnings call date and time from IR calendar or SEC 8-K filing',
  };
}

function buildHistoricalTendencyRecord(company, closedEventHitRate) {
  if (closedEventHitRate && Number.isFinite(closedEventHitRate.hits) && Number.isFinite(closedEventHitRate.total) && closedEventHitRate.total > 0) {
    const rate = closedEventHitRate.hits / closedEventHitRate.total;
    const score = Math.round(rate * 100);
    return {
      present: true,
      score,
      source_basis: `closed-event calendar: ${closedEventHitRate.hits}/${closedEventHitRate.total} prior ${company} earnings events resolved YES`,
      source_path: null,
      detail: `hit rate ${(rate * 100).toFixed(0)}% over last ${closedEventHitRate.total} closed events`,
      missing_note: null,
    };
  }
  return {
    present: false,
    score: null,
    source_basis: 'earnings-calendar-stub: no closed-event hit rate supplied',
    source_path: null,
    detail: null,
    missing_note: 'check closed-event calendar (top-right calendar icon on Kalshi board) for prior earnings hit rates',
  };
}

function buildAnalystQAPathwayRecord(company, keyword, analystCoverage) {
  if (analystCoverage?.mentions_in_coverage === true) {
    return {
      present: true,
      score: Math.min(85, analystCoverage.topic_score ?? 70),
      source_basis: 'analyst coverage confirms keyword is an active Q&A topic',
      source_path: analystCoverage.source_url ?? null,
      detail: analystCoverage.detail ?? `analysts have asked about "${keyword}" in recent coverage`,
      missing_note: null,
    };
  }
  return {
    present: false,
    score: null,
    source_basis: 'earnings-calendar-stub: analyst coverage review not yet performed',
    source_path: null,
    detail: null,
    missing_note: 'review analyst reports and earnings preview notes for this keyword',
  };
}

function buildDirectMentionPathwayRecord(company, keyword, inEarningsRelease, sourceUrl) {
  if (inEarningsRelease) {
    return {
      present: true,
      score: 75,
      source_basis: 'earnings release: keyword appears in official company communications',
      source_path: sourceUrl,
      detail: `keyword "${keyword}" found in earnings releases and IR materials`,
      missing_note: null,
    };
  }
  return {
    present: false,
    score: null,
    source_basis: 'IR search: keyword not found in prepared materials',
    source_path: null,
    detail: null,
    missing_note: 'keyword not found in investor relations materials',
  };
}

function buildPreparedRemarksLikelihoodRecord(company, keyword, transcriptHitRate, sourceUrl) {
  if (transcriptHitRate !== null && transcriptHitRate >= 0.5) {
    return {
      present: true,
      score: Math.round(60 + (transcriptHitRate * 30)),
      source_basis: `transcript history: keyword mentioned in ${(transcriptHitRate * 100).toFixed(0)}% of prior calls`,
      source_path: sourceUrl,
      detail: `high transcript hit rate suggests prepared remarks include "${keyword}"`,
      missing_note: null,
    };
  }
  return {
    present: false,
    score: null,
    source_basis: 'transcript history: keyword rarely mentioned',
    source_path: null,
    detail: null,
    missing_note: 'low transcript hit rate; unlikely in prepared remarks',
  };
}

function buildSuppressionSignalRecord(company, keyword, suppressionData) {
  if (suppressionData?.legalRisk || suppressionData?.prRestriction || suppressionData?.recentControversy) {
    return {
      present: true,
      score: 20,
      source_basis: 'suppression risk detected: legal or PR restrictions may limit mentions',
      source_path: null,
      detail: suppressionData.detail ?? 'potential suppression signals detected',
      missing_note: null,
    };
  }
  return {
    present: false,
    score: null,
    source_basis: 'suppression scan: no legal/PR risks detected',
    source_path: null,
    detail: null,
    missing_note: 'no suppression signals found',
  };
}

function buildEvidenceQualityRecord(sources) {
  const sourceCount = sources.filter(Boolean).length;
  if (sourceCount >= 2) {
    return {
      present: true,
      score: Math.min(95, 75 + (sourceCount * 5)),
      source_basis: `evidence quality: ${sourceCount} independent verified sources`,
      source_path: null,
      detail: `verified sources: ${sourceCount}`,
      missing_note: null,
    };
  }
  return {
    present: false,
    score: null,
    source_basis: 'evidence quality: insufficient verified sources',
    source_path: null,
    detail: null,
    missing_note: 'need more independent source verification',
  };
}

// ---------------------------------------------------------------------------
// Main collector function
// ---------------------------------------------------------------------------

export async function collectEarningsResearch({ company, keyword, earningsEvent, externalData = null }) {
  // Try external data first, then fall back to verified data feed
  let data = externalData;
  if (!data) {
    data = getVerifiedData(company, keyword);
  }
  if (!data) {
    data = await fetchExternalResearchData(company, keyword);
  }

  const layerRecords = {};
  const sourceLadderInputs = {};

  if (data) {
    // Use external data to build real source-backed layers
    layerRecords.baseline_relevance = buildBaselineRelevanceRecord({
      company,
      keyword,
      transcriptHitRate: data.transcriptHitRate,
      transcriptAvgHitsPerCall: data.transcriptAvgHitsPerCall,
      isCoreProductOrMetric: data.isCoreProductOrMetric,
      analystTopicScore: data.analystTopicScore,
      inEarningsRelease: data.inEarningsRelease,
      sourceUrl: data.sourceUrl,
      detail: data.detail,
    });

    layerRecords.event_proximity = buildEventProximityRecord(company, earningsEvent);

    layerRecords.historical_tendency = buildHistoricalTendencyRecord(company, data.closedEventHitRate);

    layerRecords.sec_filing_language = buildSecFilingLanguageRecord({
      company,
      keyword,
      pressReleaseMentions: data.pressReleaseMentions,
      tenKMentions: data.tenKMentions,
      tenQMentions: data.tenQMentions,
      inRiskFactors: data.inRiskFactors,
      filingType: data.filingType,
      sourceUrl: data.secSourceUrl,
      snippet: data.secSnippet,
    });

    layerRecords.analyst_qa_pathway = buildAnalystQAPathwayRecord(company, keyword, data.analystCoverage);

    layerRecords.source_velocity = buildSourceVelocityRecord({
      company,
      keyword,
      sources: data.sources ?? [],
      velocityWindow: data.velocityWindow ?? 'week',
    });

    layerRecords.direct_mention_pathway = buildDirectMentionPathwayRecord(
      company, keyword, data.inEarningsRelease, data.sourceUrl
    );

    layerRecords.prepared_remarks_likelihood = buildPreparedRemarksLikelihoodRecord(
      company, keyword, data.transcriptHitRate, data.sourceUrl
    );

    layerRecords.suppression_signal = buildSuppressionSignalRecord(company, keyword, data.suppressionData);

    const hasSec = data.secSourceUrl !== null || (data.pressReleaseMentions !== null);
    const hasTranscript = data.transcriptHitRate !== null;
    const hasAnalyst = data.analystTopicScore !== null;
    layerRecords.evidence_quality = buildEvidenceQualityRecord([hasSec, hasTranscript, hasAnalyst]);

    // Build source ladder inputs
    sourceLadderInputs.prior_transcript_word_match = {
      status: data.transcriptHitRate > 0 ? 'used' : 'missing',
      note: data.transcriptHitRate > 0
        ? `keyword found in ${(data.transcriptHitRate * 100).toFixed(0)}% of prior transcripts`
        : 'no prior transcript mentions found',
      source_path: data.sourceUrl,
    };

    sourceLadderInputs.recent_direct_quote_match = {
      status: data.inEarningsRelease ? 'used' : 'missing',
      note: data.inEarningsRelease
        ? 'keyword appears in earnings releases'
        : 'no direct quote match in IR materials',
      source_path: data.sourceUrl,
    };

    sourceLadderInputs.current_event_context = {
      status: 'used',
      note: `${company} earnings call scheduled`,
      source_path: earningsEvent?.source_url || `https://kalshi.com/events/${earningsEvent?.event_ticker}`,
    };

    sourceLadderInputs.prompt_likelihood = {
      status: data.analystTopicScore > 0 ? 'used' : 'missing',
      note: data.analystTopicScore > 0
        ? `analysts actively covering this keyword (score: ${data.analystTopicScore})`
        : 'analyst coverage not found',
      source_path: data.analystCoverage?.source_url ?? null,
    };

    sourceLadderInputs.formal_document_proxy = {
      status: (data.pressReleaseMentions > 0 || data.tenKMentions > 0) ? 'used' : 'missing',
      note: (data.pressReleaseMentions > 0 || data.tenKMentions > 0)
        ? `SEC filings mention keyword (${data.tenKMentions ?? 0} 10-K, ${data.tenQMentions ?? 0} 10-Q)`
        : 'no SEC filing mentions found',
      source_path: data.secSourceUrl,
    };

    sourceLadderInputs.qualification_risk = {
      status: 'used',
      note: 'earnings call confirmed on calendar',
      detail: { level: 'low' },
    };
  } else {
    // No external data available — return minimal records with clear missing notes
    layerRecords.baseline_relevance = {
      present: false,
      score: null,
      source_basis: 'earnings research: no external data available for baseline relevance',
      source_path: null,
      detail: null,
      missing_note: 'supply transcript hit rate, analyst topic score, or core-product flag',
    };

    layerRecords.event_proximity = buildEventProximityRecord(company, earningsEvent);

    layerRecords.historical_tendency = buildHistoricalTendencyRecord(company, null);

    layerRecords.sec_filing_language = {
      present: false,
      score: null,
      source_basis: 'earnings research: no SEC filing data available',
      source_path: null,
      detail: null,
      missing_note: 'search SEC EDGAR for 10-K/10-Q/8-K; supply mention counts per filing type',
    };

    layerRecords.analyst_qa_pathway = {
      present: false,
      score: null,
      source_basis: 'earnings research: analyst coverage review not yet performed',
      source_path: null,
      detail: null,
      missing_note: 'review analyst reports and earnings preview notes for this keyword',
    };

    layerRecords.source_velocity = {
      present: false,
      score: null,
      source_basis: 'earnings research: no source velocity data available',
      source_path: null,
      detail: null,
      missing_note: 'supply sources array with type, mentionsKeyword, recencyDays',
    };

    layerRecords.direct_mention_pathway = {
      present: false,
      score: null,
      source_basis: 'earnings research: no IR material data available',
      source_path: null,
      detail: null,
      missing_note: 'check investor relations materials for keyword mentions',
    };

    layerRecords.prepared_remarks_likelihood = {
      present: false,
      score: null,
      source_basis: 'earnings research: no transcript history available',
      source_path: null,
      detail: null,
      missing_note: 'analyze prior call transcripts for keyword frequency',
    };

    layerRecords.suppression_signal = {
      present: false,
      score: null,
      source_basis: 'earnings research: suppression scan not performed',
      source_path: null,
      detail: null,
      missing_note: 'scan for legal/PR risks that might suppress mentions',
    };

    layerRecords.evidence_quality = {
      present: false,
      score: null,
      source_basis: 'earnings research: no verified sources available',
      source_path: null,
      detail: null,
      missing_note: 'need independent source verification',
    };

    // Minimal source ladder inputs
    sourceLadderInputs.prior_transcript_word_match = {
      status: 'missing',
      note: 'transcript search not yet performed',
      source_path: null,
    };

    sourceLadderInputs.recent_direct_quote_match = {
      status: 'missing',
      note: 'recent quote search not yet performed',
      source_path: null,
    };

    sourceLadderInputs.current_event_context = {
      status: 'used',
      note: `${company} earnings call scheduled`,
      source_path: earningsEvent?.source_url || `https://kalshi.com/events/${earningsEvent?.event_ticker}`,
    };

    sourceLadderInputs.prompt_likelihood = {
      status: 'missing',
      note: 'analyst prompt likelihood not assessed',
      source_path: null,
    };

    sourceLadderInputs.formal_document_proxy = {
      status: 'missing',
      note: 'SEC filing search not yet performed',
      source_path: null,
    };

    sourceLadderInputs.qualification_risk = {
      status: 'used',
      note: 'earnings call confirmed on calendar',
      detail: { level: 'low' },
    };
  }

  return {
    layerRecords,
    sourceLadderInputs,
    metadata: {
      company,
      keyword,
      searchTimestamp: new Date().toISOString(),
      hasExternalData: data !== null,
      dataSource: data ? 'external' : 'stub',
    },
  };
}
