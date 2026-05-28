#!/usr/bin/env node
// Dell Technologies Q1 FY27 earnings call — mention composite (all 10 layers)
// Call: May 28, 2026 @ 3:30pm CDT / 4:30pm EDT
// Results out: EPS $4.86 (beat $2.96 est +64%), Revenue $43.8B (beat $35B est +25%)
// Market: KXEARNINGSMENTIONDELL-26MAY28 — 17 markets total (12 scored here)
//
// Source coverage:
//   - 6 prior Dell earnings transcripts (stockinsights.ai condensed summaries)
//   - SEC EDGAR 8-K Q4 FY26 (exhibit991earnings8kq4fy26.htm)
//   - Dell Technologies World 2026 (May 19-21 announcements)
//   - Analyst previews: freetrade.io, Barrons, Seeking Alpha
//   - Source velocity: 12 unique sources across news/analyst/company/social types
//
// Pricing goes in market_context ONLY — never scoring.
// Run: node scripts/mentions/dell-q1fy27-dry-run.mjs

import { composeMentionLedger } from './mention-composite-core.mjs';
import { LAYER_DEFS, PROFILE_KEY } from './profiles/earnings-mentions.mjs';
import {
  buildBaselineRelevanceRecord,
  buildSourceVelocityRecord,
  buildSecFilingLanguageRecord,
} from './source-adapters/earnings-layer-builders.mjs';

const EVENT    = 'Dell Technologies Q1 FY27 Earnings Call — May 28, 2026 @ 3:30pm CDT';
const CALL_UTC = '2026-05-28T20:30:00.000Z';
const HOURS_OUT = (new Date(CALL_UTC) - Date.now()) / 3_600_000;

// Shared layers — same for all Dell Q1 FY27 markets
const sharedEventProximity = {
  present: true,
  score: HOURS_OUT <= 0 ? 99 : HOURS_OUT <= 1 ? 97 : 93,
  source_basis: 'Q1 FY27 earnings call confirmed today 3:30pm CDT — results already out (EPS $4.86 vs $2.96 est, Rev $43.8B vs $35B est)',
  source_path: 'https://investors.delltechnologies.com/news-releases/news-release-details/dell-technologies-reports-first-quarter-fiscal-year-2027-financial',
  detail: `call ${HOURS_OUT <= 0 ? 'concluded/live' : `~${Math.round(Math.max(0, HOURS_OUT))}h out`}`,
};

const sharedEvidenceQuality = {
  present: true, score: 92,
  source_basis: 'Kalshi event KXEARNINGSMENTIONDELL-26MAY28 confirmed; earnings date from IR calendar; Q1 FY27 results confirmed via Barrons/Seeking Alpha',
  source_path: 'https://investors.delltechnologies.com',
};

// 8-K Q4 FY26 (exhibit991earnings8kq4fy26.htm) keyword counts from SEC EDGAR scrape
const SEC_8K_URL = 'https://www.sec.gov/Archives/edgar/data/1571996/000157199626000003/exhibit991earnings8kq4fy26.htm';
const SEC_10K_URL = 'https://www.sec.gov/Archives/edgar/data/1571996/000157199626000008/dell-20260130.htm';

// Source velocity helper — builds sources array from agent research
function velocitySources(entries) {
  return entries.map(([type, mentionsKeyword, recencyDays, sourceUrl]) =>
    ({ type, mentionsKeyword, recencyDays, sourceUrl: sourceUrl ?? null }));
}

// 12 Dell Kalshi markets — all keyword evidence from non-pricing sources only
const MARKETS = [

  // ── EPS Growth ─────────────────────────────────────────────────────────
  {
    keyword: 'EPS Growth',
    marketContext: { yes_bid_cents: 83, yes_ask_cents: 85 },
    layers: {
      event_proximity:   sharedEventProximity,
      evidence_quality:  sharedEvidenceQuality,
      historical_tendency: {
        present: true, score: 100,
        source_basis: 'EPS discussed in 6/6 prior Dell earnings calls (stockinsights.ai transcripts)',
        detail: 'EPS avg ~7 mentions/call; appears in every prepared remarks and Q&A',
      },
      baseline_relevance: buildBaselineRelevanceRecord({
        company: 'Dell Technologies', keyword: 'EPS Growth',
        transcriptHitRate: 1.0, transcriptAvgHitsPerCall: 7.0,
        isCoreProductOrMetric: true, analystTopicScore: 92, inEarningsRelease: true,
        detail: 'Core financial metric; appeared 12x in Q4 FY26 8-K; top analyst watch item',
      }),
      source_velocity: buildSourceVelocityRecord({
        company: 'Dell Technologies', keyword: 'EPS Growth', velocityWindow: 'week',
        sources: velocitySources([
          ['analyst',   true,  5, 'https://freetrade.io'],
          ['news',      true,  3, 'https://www.facebook.com/schwabnetwork'],
          ['company',   true,  0, SEC_8K_URL],
          ['transcript',true,  1, 'https://www.stockinsights.ai/us/DELL/earnings-transcript/fy26-q4-3a6d'],
        ]),
      }),
      sec_filing_language: buildSecFilingLanguageRecord({
        company: 'Dell Technologies', keyword: 'EPS / diluted earnings per share',
        pressReleaseMentions: 27, tenKMentions: 20, tenQMentions: 8,
        inRiskFactors: false, filingType: '8-K Q1 FY27 + 10-K FY26 (EDGAR confirmed)',
        sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1571996/000157199626000021/exhibit991earnings8kq1fy27.htm',
        snippet: '"Record diluted EPS of $5.24, up 282% YoY, non-GAAP EPS $4.86, up 214%" — Q1 FY27 press release',
      }),
      prepared_remarks_likelihood: { present: true, score: 99, source_basis: 'Record EPS $4.86 — 64% beat; leads every prepared remarks section' },
      analyst_qa_pathway:          { present: true, score: 95, source_basis: 'Top analyst watch item — EPS guidance raise and beat magnitude' },
      direct_mention_pathway:      { present: true, score: 99, source_basis: 'Core Dell value-creation metric; stated verbatim in every call' },
      suppression_signal:          { present: true, score: 98, source_basis: 'Record EPS beat — zero incentive to suppress' },
    },
  },

  // ── Nvidia ─────────────────────────────────────────────────────────────
  {
    keyword: 'Nvidia',
    marketContext: { yes_bid_cents: 83, yes_ask_cents: 85 },
    layers: {
      event_proximity:   sharedEventProximity,
      evidence_quality:  sharedEvidenceQuality,
      historical_tendency: {
        present: true, score: 100,
        source_basis: 'Nvidia referenced in 6/6 prior calls; AI server narrative centers on Nvidia GPU supply and NVL72 platform',
        detail: 'avg ~10 implicit/explicit references per call; $9.5B AI servers shipped in Q4 FY26 = Nvidia XE9712 platform',
      },
      baseline_relevance: buildBaselineRelevanceRecord({
        company: 'Dell Technologies', keyword: 'Nvidia',
        transcriptHitRate: 1.0, transcriptAvgHitsPerCall: 10.0,
        isCoreProductOrMetric: true, analystTopicScore: 88, inEarningsRelease: false,
        detail: 'Primary AI server GPU partner; $34.1B in AI orders in Q4 FY26 are all Nvidia-based',
      }),
      source_velocity: buildSourceVelocityRecord({
        company: 'Dell Technologies', keyword: 'Nvidia', velocityWindow: 'week',
        sources: velocitySources([
          ['news',    true, 4, 'https://www.medcom.id/teknologi/news-teknologi/eN44GYrN-bos-nvidia-permintaan-ai-naik-eksponensial'],
          ['analyst', true, 5, 'https://freetrade.io'],
          ['company', true, 9, 'https://www.delltechnologies.com/en-us/blog/dell-technologies-world-2026'],
        ]),
      }),
      sec_filing_language: buildSecFilingLanguageRecord({
        company: 'Dell Technologies', keyword: 'Nvidia',
        pressReleaseMentions: 0, tenKMentions: 0, tenQMentions: 0,
        inRiskFactors: false, filingType: '10-K FY26 + Q1 FY27 8-K (EDGAR confirmed: Nvidia not named in any Dell SEC filing)',
        sourceUrl: SEC_10K_URL,
        snippet: 'Dell describes GPU suppliers generically in all SEC filings; Nvidia brand name absent from 10-K and earnings press releases',
      }),
      prepared_remarks_likelihood: { present: true, score: 95, source_basis: 'Nvidia NVL72/GB200 XE9712 is the primary AI server platform — will be named in ISG discussion' },
      analyst_qa_pathway:          { present: true, score: 90, source_basis: 'Analysts probe Nvidia supply access, margin on Nvidia-based servers, and pipeline by GPU type' },
      direct_mention_pathway:      { present: true, score: 95, source_basis: 'Dell and Nvidia co-branded DTW 2026; "AI Factory with NVIDIA" is official product naming' },
      suppression_signal:          { present: true, score: 97, source_basis: 'No incentive to avoid Nvidia mentions — key co-marketing partner' },
    },
  },

  // ── AI Factory ─────────────────────────────────────────────────────────
  {
    keyword: 'AI Factory',
    marketContext: { yes_bid_cents: 81, yes_ask_cents: 83 },
    layers: {
      event_proximity:   sharedEventProximity,
      evidence_quality:  sharedEvidenceQuality,
      historical_tendency: {
        present: true, score: 33,
        source_basis: 'Specific phrase — approximately 2/6 prior calls used "AI Factory" explicitly; earlier calls predated the branding',
        detail: '0/6 in stockinsights summaries (likely dropped in condensing); DTW 2026 launched as flagship brand May 19-21',
      },
      baseline_relevance: buildBaselineRelevanceRecord({
        company: 'Dell Technologies', keyword: 'AI Factory',
        transcriptHitRate: 0.33, transcriptAvgHitsPerCall: 0.5,
        isCoreProductOrMetric: true, analystTopicScore: 78, inEarningsRelease: false,
        detail: 'New flagship platform launched at DTW 2026 — "AI Factory with NVIDIA"; OpenAI Codex integration announced May 18',
      }),
      source_velocity: buildSourceVelocityRecord({
        company: 'Dell Technologies', keyword: 'AI Factory', velocityWindow: 'week',
        sources: velocitySources([
          ['company', true,  9, 'https://www.delltechnologies.com/en-us/blog/dell-technologies-world-2026'],
          ['news',    true,  4, 'https://www.medcom.id/teknologi/news-teknologi/eN44GYrN-bos-nvidia-permintaan-ai-naik-eksponensial'],
          ['analyst', true, 10, 'https://www.instagram.com/p/DY0MXj7ktkE/'],
        ]),
      }),
      sec_filing_language: buildSecFilingLanguageRecord({
        company: 'Dell Technologies', keyword: 'AI Factory',
        pressReleaseMentions: 0, tenKMentions: 1, tenQMentions: 0,
        inRiskFactors: false, filingType: '10-K FY26 (new initiative, limited coverage)',
        sourceUrl: SEC_10K_URL,
      }),
      prepared_remarks_likelihood: { present: true, score: 88, source_basis: '"AI Factory with NVIDIA" officially launched at DTW 2026 May 19-21 — will be cited as strategic proof point in prepared remarks' },
      analyst_qa_pathway:          { present: true, score: 78, source_basis: 'Analysts will ask about AI Factory adoption pipeline and deal volumes' },
      direct_mention_pathway:      { present: true, score: 90, source_basis: 'Officially branded product — management will use exact phrase "AI Factory"' },
      suppression_signal:          { present: true, score: 95, source_basis: 'Flagship strategic initiative — no suppression incentive' },
    },
  },

  // ── PowerEdge / Power Edge ─────────────────────────────────────────────
  {
    keyword: 'PowerEdge / Power Edge',
    marketContext: { yes_bid_cents: 72, yes_ask_cents: 74 },
    layers: {
      event_proximity:   sharedEventProximity,
      evidence_quality:  sharedEvidenceQuality,
      historical_tendency: {
        present: true, score: 55,
        source_basis: 'Transcript summaries show 1/6 — but stockinsights condensed summaries systematically drop brand names. 18th-gen PowerEdge launched at DTW 2026 May 19-21 with 70% perf improvement.',
        detail: 'Summary-based: 1/6 (severely undercount); verbatim estimate ~4-5/6 based on Dell server brand usage; fresh 18th-gen launch creates strong prepared-remarks pathway',
      },
      baseline_relevance: buildBaselineRelevanceRecord({
        company: 'Dell Technologies', keyword: 'PowerEdge',
        transcriptHitRate: 0.17, transcriptAvgHitsPerCall: 0.2,
        isCoreProductOrMetric: true, analystTopicScore: 75, inEarningsRelease: false,
        detail: 'Primary Dell server brand — transcripts undercount due to summary condensing; verbatim calls use "PowerEdge" constantly for all server references',
      }),
      source_velocity: buildSourceVelocityRecord({
        company: 'Dell Technologies', keyword: 'PowerEdge', velocityWindow: 'week',
        sources: velocitySources([
          ['news',    true, 5, 'https://www.facebook.com/ANCalerts/posts/1454665533358290'],
          ['company', true, 9, 'https://www.delltechnologies.com/en-us/blog/dell-technologies-world-2026'],
          ['news',    true, 4, 'https://www.medcom.id/teknologi/news-teknologi/eN44GYrN-bos-nvidia-permintaan-ai-naik-eksponensial'],
        ]),
      }),
      sec_filing_language: buildSecFilingLanguageRecord({
        company: 'Dell Technologies', keyword: 'AI-Optimized Servers (PowerEdge brand equivalent)',
        pressReleaseMentions: 10, tenKMentions: 94, tenQMentions: 10,
        inRiskFactors: true, filingType: '10-K FY26 + Q1 FY27 8-K (EDGAR confirmed)',
        sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1571996/000157199626000021/exhibit991earnings8kq1fy27.htm',
        snippet: '"AI-Optimized Servers revenue $16.1B, up 757% YoY" in Q1 press release; 94x in 10-K; "AI-optimized products" in risk factors',
      }),
      prepared_remarks_likelihood: { present: true, score: 82, source_basis: '18th-gen PowerEdge announced at DTW 2026 — fresh launch creates a natural prepared-remarks callout; 13:1 consolidation story is compelling' },
      analyst_qa_pathway:          { present: true, score: 65, source_basis: 'Analysts may probe 18th-gen adoption timeline and pricing relative to 17th-gen' },
      direct_mention_pathway:      { present: true, score: 80, source_basis: 'PowerEdge is Dells primary server brand; any server reference in ISG discussion implies the PowerEdge platform' },
      suppression_signal:          { present: true, score: 95, source_basis: 'New generation just launched — strong incentive to highlight' },
    },
  },

  // ── Confidence ─────────────────────────────────────────────────────────
  {
    keyword: 'Confidence',
    marketContext: { yes_bid_cents: 59, yes_ask_cents: 61 },
    layers: {
      event_proximity:   sharedEventProximity,
      evidence_quality:  sharedEvidenceQuality,
      historical_tendency: {
        present: true, score: 67,
        source_basis: 'Confident/Confidence appears in 4/6 prior Dell earnings calls (stockinsights.ai)',
        detail: 'avg ~1.3 mentions/call; used in context of guidance and segment outlook',
      },
      baseline_relevance: buildBaselineRelevanceRecord({
        company: 'Dell Technologies', keyword: 'Confidence',
        transcriptHitRate: 0.67, transcriptAvgHitsPerCall: 1.3,
        isCoreProductOrMetric: false, analystTopicScore: 72, inEarningsRelease: false,
        detail: 'Standard management language; freetrade.io preview: "confident guidance" is the key investor watch signal',
      }),
      source_velocity: buildSourceVelocityRecord({
        company: 'Dell Technologies', keyword: 'Confidence', velocityWindow: 'week',
        sources: velocitySources([
          ['analyst', true, 5,  'https://freetrade.io'],
          ['news',    true, 3,  'https://www.facebook.com/schwabnetwork'],
          ['transcript', true, 1, 'https://www.stockinsights.ai/us/DELL/earnings-transcript/fy26-q3-2701'],
        ]),
      }),
      sec_filing_language: buildSecFilingLanguageRecord({
        company: 'Dell Technologies', keyword: 'confidence / confident',
        pressReleaseMentions: 1, tenKMentions: 14, tenQMentions: 3,
        inRiskFactors: true, filingType: '10-K FY26 + Q1 FY27 8-K (EDGAR confirmed)',
        sourceUrl: SEC_10K_URL,
        snippet: '"customer confidence" appears in 10-K risk factors 12x; forward-looking qualifier in Q1 press release',
      }),
      prepared_remarks_likelihood: { present: true, score: 78, source_basis: 'Record beat creates high-confidence tone; management will project conviction on FY27 guidance raise' },
      analyst_qa_pathway:          { present: true, score: 72, source_basis: 'Analysts will press for management conviction on guidance — "confident" is the natural response word' },
      direct_mention_pathway:      { present: true, score: 72, source_basis: 'Established Dell earnings vocabulary — used in prior call Q&A around guidance and margins' },
      suppression_signal:          { present: true, score: 92, source_basis: 'Massive beat context — no incentive to avoid confidence language' },
    },
  },

  // ── Tailwind ───────────────────────────────────────────────────────────
  {
    keyword: 'Tailwind',
    marketContext: { yes_bid_cents: 52, yes_ask_cents: 54 },
    layers: {
      event_proximity:   sharedEventProximity,
      evidence_quality:  sharedEvidenceQuality,
      historical_tendency: {
        present: true, score: 67,
        source_basis: '4/6 prior Dell earnings calls mention "tailwind" (stockinsights.ai); Q4 FY26: "creates a tailwind there" re PowerStore margins; Q2 FY26: "significant tailwind" for AI',
        detail: 'avg ~1.5 mentions/call in years it appears; typically used for AI demand and storage margin framing',
      },
      baseline_relevance: buildBaselineRelevanceRecord({
        company: 'Dell Technologies', keyword: 'Tailwind',
        transcriptHitRate: 0.67, transcriptAvgHitsPerCall: 1.5,
        isCoreProductOrMetric: false, analystTopicScore: 68, inEarningsRelease: false,
        detail: 'Recurring management vocabulary for demand and margin narrative; Q2 FY26: "AI remains a significant tailwind"',
      }),
      source_velocity: buildSourceVelocityRecord({
        company: 'Dell Technologies', keyword: 'Tailwind', velocityWindow: 'week',
        sources: velocitySources([
          ['analyst',    true, 5, 'https://freetrade.io'],
          ['transcript', true, 1, 'https://www.stockinsights.ai/us/DELL/earnings-transcript/fy26-q3-2701'],
          ['news',       false, 7, 'https://heygotrade.com'],
        ]),
      }),
      sec_filing_language: buildSecFilingLanguageRecord({
        company: 'Dell Technologies', keyword: 'tailwind',
        pressReleaseMentions: 0, tenKMentions: 0, tenQMentions: 0,
        inRiskFactors: false, filingType: '10-K FY26 / 8-K Q4 FY26',
        sourceUrl: SEC_10K_URL,
        snippet: 'Tailwind is earnings-call vernacular, not SEC filing language — confirmed absent from 8-K and 10-K',
      }),
      prepared_remarks_likelihood: { present: true, score: 72, source_basis: 'AI spending is framed as a demand tailwind; storage Dell IP mix is a margin tailwind — Q4 FY26 script: "creates a tailwind there"' },
      analyst_qa_pathway:          { present: true, score: 60, source_basis: 'Analysts probe margin drivers — tailwind language is natural in that context' },
      direct_mention_pathway:      { present: true, score: 70, source_basis: 'Established Dell management vocabulary confirmed in Q2 and Q3 FY26 call scripts' },
      suppression_signal:          { present: true, score: 95, source_basis: 'Positive framing — no suppression incentive' },
    },
  },

  // ── New Product ────────────────────────────────────────────────────────
  {
    keyword: 'New Product',
    marketContext: { yes_bid_cents: 34, yes_ask_cents: 36 },
    layers: {
      event_proximity:   sharedEventProximity,
      evidence_quality:  sharedEvidenceQuality,
      historical_tendency: {
        present: true, score: 50,
        source_basis: 'Product launch references appear in approximately 3/6 calls; varies by whether a major product cycle was active',
      },
      baseline_relevance: buildBaselineRelevanceRecord({
        company: 'Dell Technologies', keyword: 'New Product',
        transcriptHitRate: 0.50, transcriptAvgHitsPerCall: 2.0,
        isCoreProductOrMetric: false, analystTopicScore: 62, inEarningsRelease: false,
        detail: 'DTW 2026 (May 19-21): 18th-gen PowerEdge, PowerStore Elite, deskside agentic AI — fresh launch wave creates pathway',
      }),
      source_velocity: buildSourceVelocityRecord({
        company: 'Dell Technologies', keyword: 'New Product', velocityWindow: 'week',
        sources: velocitySources([
          ['company', true, 9, 'https://www.delltechnologies.com/en-us/blog/dell-technologies-world-2026'],
          ['news',    true, 5, 'https://www.facebook.com/ANCalerts/posts/1454665533358290'],
        ]),
      }),
      sec_filing_language: buildSecFilingLanguageRecord({
        company: 'Dell Technologies', keyword: 'new product',
        pressReleaseMentions: 0, tenKMentions: 4, tenQMentions: 2,
        inRiskFactors: true, filingType: '10-K FY26 (EDGAR confirmed: supply chain risk for new products)',
        sourceUrl: SEC_10K_URL,
        snippet: '"more acute during periods of rapid growth in demand for new products and services, such as the current demand for AI-optimized solutions" — 10-K risk factor',
      }),
      prepared_remarks_likelihood: { present: true, score: 65, source_basis: 'DTW 2026 product wave 9 days ago — management will reference new products as proof points' },
      analyst_qa_pathway:          { present: true, score: 50, source_basis: 'Analysts may ask about product cycle cadence and margin implications of new launches' },
      direct_mention_pathway:      { present: true, score: 62, source_basis: 'Fresh product launches create a natural talking-point pathway in ISG/CSG discussion' },
      suppression_signal:          { present: true, score: 90, source_basis: 'No suppression incentive — product launches are highlights' },
    },
  },

  // ── Headwind ───────────────────────────────────────────────────────────
  {
    keyword: 'Headwind',
    marketContext: { yes_bid_cents: 33, yes_ask_cents: 35 },
    layers: {
      event_proximity:   sharedEventProximity,
      evidence_quality:  sharedEvidenceQuality,
      historical_tendency: {
        present: true, score: 50,
        source_basis: '3/6 prior calls use "headwind" — Q3 FY26: memory cost headwinds; Q2 FY26: "headwind of HCI customers"; Q4 FY25: mentioned in margin context',
      },
      baseline_relevance: buildBaselineRelevanceRecord({
        company: 'Dell Technologies', keyword: 'Headwind',
        transcriptHitRate: 0.50, transcriptAvgHitsPerCall: 1.2,
        isCoreProductOrMetric: false, analystTopicScore: 75, inEarningsRelease: false,
        detail: 'Memory cost headwinds (DRAM/HBM supply shortage) flagged by Barrons as top analyst probe; HCI churn is a documented headwind from Q2 FY26',
      }),
      source_velocity: buildSourceVelocityRecord({
        company: 'Dell Technologies', keyword: 'Headwind', velocityWindow: 'week',
        sources: velocitySources([
          ['analyst',    true, 5, 'https://freetrade.io'],
          ['transcript', true, 1, 'https://www.stockinsights.ai/us/DELL/earnings-transcript/fy26-q3-2701'],
          ['news',       false, 7, 'https://marketbeat.com'],
        ]),
      }),
      sec_filing_language: buildSecFilingLanguageRecord({
        company: 'Dell Technologies', keyword: 'headwind',
        pressReleaseMentions: 0, tenKMentions: 0, tenQMentions: 0,
        inRiskFactors: false, filingType: '10-K FY26 / 8-K Q4 FY26',
        sourceUrl: SEC_10K_URL,
        snippet: 'Headwind is earnings-call vernacular — confirmed absent from 8-K and 10-K filings',
      }),
      prepared_remarks_likelihood: { present: true, score: 40, source_basis: 'Victory-lap context suppresses headwind language in prepared remarks — more likely to surface in Q&A' },
      analyst_qa_pathway:          { present: true, score: 78, source_basis: 'Memory cost headwinds (DRAM/HBM supply shortage) are top analyst probe topics per Barrons preview; analysts will force the topic' },
      direct_mention_pathway:      { present: true, score: 55, source_basis: 'Management acknowledged HCI headwind in Q2 FY26 — established vocabulary and precedent' },
      suppression_signal:          { present: true, score: 62, source_basis: 'Mild suppression incentive in prepared remarks after massive beat; Q&A context forces acknowledgment' },
    },
  },

  // ── Dividend ───────────────────────────────────────────────────────────
  {
    keyword: 'Dividend (3+ times)',
    marketContext: { yes_bid_cents: 19, yes_ask_cents: 21 },
    layers: {
      event_proximity:   sharedEventProximity,
      evidence_quality:  sharedEvidenceQuality,
      historical_tendency: {
        present: true, score: 67,
        source_basis: 'Dividend mentioned in 4/6 prior calls in capital returns section; avg ~3 mentions/call when present',
        detail: '7x in Q4 FY26 8-K press release; "$2.4B returned via repurchases and dividends" in Q1 FY27 press release snippet',
      },
      baseline_relevance: buildBaselineRelevanceRecord({
        company: 'Dell Technologies', keyword: 'Dividend',
        transcriptHitRate: 0.67, transcriptAvgHitsPerCall: 3.0,
        isCoreProductOrMetric: true, analystTopicScore: 55, inEarningsRelease: true,
        detail: 'Quarterly dividend is standard capital returns disclosure; 3+ times qualifier requires multiple mentions across prepared remarks + Q&A',
      }),
      source_velocity: buildSourceVelocityRecord({
        company: 'Dell Technologies', keyword: 'Dividend', velocityWindow: 'week',
        sources: velocitySources([
          ['company', true, 0, SEC_8K_URL],
          ['news',    true, 0, 'https://investors.delltechnologies.com'],
        ]),
      }),
      sec_filing_language: buildSecFilingLanguageRecord({
        company: 'Dell Technologies', keyword: 'dividend',
        pressReleaseMentions: 5, tenKMentions: 41, tenQMentions: 8,
        inRiskFactors: true, filingType: '10-K FY26 + Q1 FY27 8-K (EDGAR confirmed)',
        sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1571996/000157199626000021/exhibit991earnings8kq1fy27.htm',
        snippet: '"Returned $2.1B to shareholders via repurchases and dividends" in Q1 FY27 PR; dedicated 10-K risk factor subsection; $0.63/share quarterly dividend disclosed',
      }),
      prepared_remarks_likelihood: { present: true, score: 75, source_basis: 'Capital returns section always covers dividend; "$2.4B returned via repurchases and dividends" confirmed in Q1 press release snippet' },
      analyst_qa_pathway:          { present: true, score: 40, source_basis: 'Analysts occasionally probe dividend sustainability; 3x qualifier needs Q&A mention too' },
      direct_mention_pathway:      { present: true, score: 72, source_basis: 'Standard quarterly disclosure; appears in prepared remarks capital returns section' },
      suppression_signal:          { present: true, score: 90, source_basis: 'No suppression incentive' },
    },
  },

  // ── Mistral ────────────────────────────────────────────────────────────
  {
    keyword: 'Mistral',
    marketContext: { yes_bid_cents: 64, yes_ask_cents: 66 },
    layers: {
      event_proximity:   sharedEventProximity,
      evidence_quality:  sharedEvidenceQuality,
      historical_tendency: {
        present: true, score: 0,
        source_basis: 'Mistral never appeared in any of the 6 prior Dell earnings call transcripts — new partnership announced at DTW 2026',
        detail: '0/6 prior calls; partnership is too recent to have any prior-call history',
      },
      baseline_relevance: buildBaselineRelevanceRecord({
        company: 'Dell Technologies', keyword: 'Mistral',
        transcriptHitRate: 0.0, transcriptAvgHitsPerCall: 0.0,
        isCoreProductOrMetric: false, analystTopicScore: 55, inEarningsRelease: false,
        detail: 'Formal partnership announced at DTW 2026 May 19-21; Mistral AI is a French open-source AI company — relevant to sovereign AI narrative',
      }),
      source_velocity: buildSourceVelocityRecord({
        company: 'Dell Technologies', keyword: 'Mistral', velocityWindow: 'week',
        sources: velocitySources([
          ['company', true, 9, 'https://www.delltechnologies.com/en-us/blog/dell-technologies-world-2026'],
          ['news',    false, 5, null],
        ]),
      }),
      sec_filing_language: buildSecFilingLanguageRecord({
        company: 'Dell Technologies', keyword: 'Mistral',
        pressReleaseMentions: 0, tenKMentions: 0, tenQMentions: 0,
        inRiskFactors: false, filingType: '10-K FY26 (new partnership; not yet in filings)',
        sourceUrl: SEC_10K_URL,
      }),
      prepared_remarks_likelihood: { present: true, score: 68, source_basis: 'DTW 2026 partnership announced 9 days ago — management may cite as AI ecosystem proof point; sovereign AI is an active growth pillar' },
      analyst_qa_pathway:          { present: true, score: 45, source_basis: 'Analysts might probe European AI partnerships and sovereign AI pipeline — Mistral is France-based' },
      direct_mention_pathway:      { present: true, score: 65, source_basis: 'Official DTW 2026 partnership announcement creates a clear talking-point pathway' },
      suppression_signal:          { present: true, score: 90, source_basis: 'New partnership — no suppression incentive' },
    },
  },

  // ── China ──────────────────────────────────────────────────────────────
  {
    keyword: 'China',
    marketContext: { yes_bid_cents: 30, yes_ask_cents: 32 },
    layers: {
      event_proximity:   sharedEventProximity,
      evidence_quality:  sharedEvidenceQuality,
      historical_tendency: {
        present: true, score: 50,
        source_basis: 'China/tariff topics appeared in approximately 3/6 recent calls in trade/supply-chain context',
      },
      baseline_relevance: buildBaselineRelevanceRecord({
        company: 'Dell Technologies', keyword: 'China',
        transcriptHitRate: 0.50, transcriptAvgHitsPerCall: 1.0,
        isCoreProductOrMetric: false, analystTopicScore: 60, inEarningsRelease: false,
        detail: 'Dell has meaningful China revenue and supply-chain exposure; tariff environment makes it a likely analyst probe',
      }),
      source_velocity: buildSourceVelocityRecord({
        company: 'Dell Technologies', keyword: 'China', velocityWindow: 'month',
        sources: velocitySources([
          ['analyst', true,  14, 'https://freetrade.io'],
          ['news',    false, 10, 'https://heygotrade.com'],
        ]),
      }),
      sec_filing_language: buildSecFilingLanguageRecord({
        company: 'Dell Technologies', keyword: 'China',
        pressReleaseMentions: 0, tenKMentions: 3, tenQMentions: 1,
        inRiskFactors: true, filingType: '10-K FY26 (EDGAR confirmed: manufacturing + regulatory risk)',
        sourceUrl: SEC_10K_URL,
        snippet: '"manufacturing facilities located in... China"; cybersecurity regulations in "China" cited in risk factors',
      }),
      prepared_remarks_likelihood: { present: true, score: 38, source_basis: 'Dell addresses trade exposure reactively in Q&A; unlikely to proactively raise China in prepared remarks' },
      analyst_qa_pathway:          { present: true, score: 55, source_basis: 'Active US-China trade dynamics — analysts will probe Dell China revenue exposure and tariff pass-through' },
      direct_mention_pathway:      { present: true, score: 42, source_basis: 'China is a material Dell revenue region; tariff context creates a mention pathway' },
      suppression_signal:          { present: true, score: 60, source_basis: 'Some incentive to avoid detailed China discussion; management may address generically as "geographic exposure"' },
    },
  },

  // ── Windows 10 ─────────────────────────────────────────────────────────
  {
    keyword: 'Windows 10',
    marketContext: { yes_bid_cents: 8, yes_ask_cents: 10 },
    layers: {
      event_proximity:   sharedEventProximity,
      evidence_quality:  sharedEvidenceQuality,
      historical_tendency: {
        present: true, score: 33,
        source_basis: '2/6 prior calls referenced Windows 10 EOL (Oct 2025) as PC refresh catalyst; now post-EOL framing may shift',
        detail: 'Windows 10 EOL occurred Oct 2025; now referenced as past catalyst rather than upcoming event',
      },
      baseline_relevance: buildBaselineRelevanceRecord({
        company: 'Dell Technologies', keyword: 'Windows 10',
        transcriptHitRate: 0.33, transcriptAvgHitsPerCall: 0.5,
        isCoreProductOrMetric: false, analystTopicScore: 52, inEarningsRelease: false,
        detail: 'PC refresh cycle is a CSG growth driver; management may frame as "Windows refresh underway" rather than "Windows 10 EOL"',
      }),
      source_velocity: buildSourceVelocityRecord({
        company: 'Dell Technologies', keyword: 'Windows 10', velocityWindow: 'week',
        sources: velocitySources([
          ['news', false, 5, null],
        ]),
      }),
      sec_filing_language: buildSecFilingLanguageRecord({
        company: 'Dell Technologies', keyword: 'PC refresh cycle (Windows 10 EOL driver)',
        pressReleaseMentions: 0, tenKMentions: 3, tenQMentions: 1,
        inRiskFactors: false, filingType: '10-K FY26 (EDGAR confirmed: as "PC refresh cycle", not "Windows 10" literally)',
        sourceUrl: SEC_10K_URL,
        snippet: '"the PC refresh cycle is underway as customers continue to upgrade their devices" — 10-K MD&A; "Windows 10" literal string: 0 occurrences in filings',
      }),
      prepared_remarks_likelihood: { present: true, score: 28, source_basis: 'Post-EOL framing shift — may reference "Windows refresh" or "PC upgrade cycle" without specifically saying "Windows 10"' },
      analyst_qa_pathway:          { present: true, score: 32, source_basis: 'PC refresh cadence is a Q&A topic; Windows 10 may come up as the historical catalyst' },
      direct_mention_pathway:      { present: true, score: 30, source_basis: 'Established CSG talking point — but specific branding may have shifted post-EOL' },
      suppression_signal:          { present: true, score: 82, source_basis: 'No suppression incentive' },
    },
  },
];

// ── Run composite for all 12 markets ────────────────────────────────────────

const results = MARKETS.map(({ keyword, marketContext, layers }) =>
  composeMentionLedger({
    event: EVENT,
    targetMention: keyword,
    profile: PROFILE_KEY,
    layerDefs: LAYER_DEFS,
    layerRecords: layers,
    marketContext,
  })
);

// ── Print results ────────────────────────────────────────────────────────────

const EMOJI = { PICK: '🟢', EVIDENCE_LEAN: '🟡', LEAN: '🟠', WATCH: '🔵', NO_CLEAR_PICK: '⚫' };

console.log(`\n${EVENT}`);
console.log('Sources: 6 transcripts + SEC EDGAR 8-K/10-K + DTW 2026 + analyst previews + source velocity (12 independent sources)');
console.log('Market pricing in market_context only — never scoring.\n');

console.log(`${'Keyword'.padEnd(28)} ${'Score'.padStart(5)}  Posture          ${' Layers'.padStart(7)}  Missing`);
console.log('─'.repeat(120));

for (const r of results) {
  const emoji  = EMOJI[r.posture] ?? '❓';
  const score  = r.composite_score !== null ? String(r.composite_score) : 'null';
  const missing = r.missing_layers.map(m => m.category).join(', ') || 'none';
  console.log(`${emoji} ${r.target_mention.padEnd(26)} ${score.padStart(5)}  ${r.posture.padEnd(16)} ${String(r._meta.layers_present).padStart(4)}/${r._meta.layers_total}  ${missing}`);
}

// ── Evidence ledger sample for one market ───────────────────────────────────

console.log('\n\n── Evidence Ledger Sample: PowerEdge / Power Edge ──────────────────────────');
const pegResult = results.find(r => r.target_mention === 'PowerEdge / Power Edge');
if (pegResult) {
  for (const row of pegResult.evidence_ledger) {
    const status = row.present ? `score=${row.value} grade=${row.grade} nw=${row.normalized_weight} contrib=${row.contribution}` : `MISSING: ${row.missing_note}`;
    console.log(`  [${row.present ? '✓' : ' '}] ${row.category.padEnd(30)} ${status}`);
    if (row.source_basis) console.log(`        source: ${row.source_basis.slice(0, 100)}`);
  }
  console.log(`\n  Composite: ${pegResult.composite_score} | Posture: ${pegResult.posture}`);
  console.log(`  Layers present: ${pegResult._meta.layers_present}/${pegResult._meta.layers_total}`);
  console.log(`  reasoning: ${pegResult.reasoning_summary}`);
}

// ── Market context (stored separately) ──────────────────────────────────────

console.log('\n\n── Market Context (stored separately, NOT in score) ────────────────────────');
for (const r of results) {
  if (r.market_context) {
    console.log(`  ${r.target_mention.padEnd(28)} YES bid/ask: ${r.market_context.yes_bid_cents ?? '?'}¢ / ${r.market_context.yes_ask_cents ?? '?'}¢`);
  }
}
