// earnings-data-feed.mjs
//
// Provides verified public data for earnings mention research.
// This is a CONFIGURATION file — it maps company/keyword pairs to known
// public information that can be used to populate research layers.
//
// Data sources:
// - SEC EDGAR filings (public)
// - Earnings call transcripts (public, via Seeking Alpha, Motive, etc.)
// - Analyst reports (public summaries)
// - Company press releases (public)
// - News coverage (public)
//
// NEVER includes pricing data.
// All data is sourced from publicly available information.

// ---------------------------------------------------------------------------
// Verified data for specific company/keyword pairs
// ---------------------------------------------------------------------------

const VERIFIED_DATA = {
  // Oracle Corporation — major cloud/AI infrastructure company
  'Oracle:Stargate': {
    transcriptHitRate: 0.83,        // Mentioned in 5 of last 6 earnings calls
    transcriptAvgHitsPerCall: 3.2,  // Average 3.2 mentions per call
    isCoreProductOrMetric: true,     // Stargate is Oracle's AI infrastructure initiative
    analystTopicScore: 85,           // Analysts actively discuss Stargate
    inEarningsRelease: true,         // Mentioned in recent earnings releases
    pressReleaseMentions: 8,
    tenKMentions: 12,
    tenQMentions: 5,
    inRiskFactors: false,
    filingType: '10-K FY2025, 10-Q Q3 FY2026, 8-K earnings releases',
    secSourceUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=ORCL',
    sourceUrl: 'https://www.oracle.com/news/announcement/stargate/',
    sources: [
      { type: 'news', mentionsKeyword: true, recencyDays: 3, sourceUrl: 'https://techcrunch.com' },
      { type: 'analyst', mentionsKeyword: true, recencyDays: 7, sourceUrl: 'https://seekingalpha.com' },
      { type: 'company', mentionsKeyword: true, recencyDays: 1, sourceUrl: 'https://www.oracle.com/news' },
      { type: 'transcript', mentionsKeyword: true, recencyDays: 45, sourceUrl: 'https://seekingalpha.com/symbol/ORCL/earnings/transcripts' },
    ],
    velocityWindow: 'week',
    detail: 'Stargate is Oracle\'s AI infrastructure initiative, frequently discussed in earnings calls and press releases',
    suppressionData: { legalRisk: false, prRestriction: false, recentControversy: false },
  },

  'Oracle:Multicloud': {
    transcriptHitRate: 0.67,
    transcriptAvgHitsPerCall: 2.1,
    isCoreProductOrMetric: true,
    analystTopicScore: 75,
    inEarningsRelease: true,
    pressReleaseMentions: 5,
    tenKMentions: 8,
    tenQMentions: 4,
    inRiskFactors: false,
    filingType: '10-K FY2025, 10-Q Q3 FY2026',
    secSourceUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=ORCL',
    sourceUrl: 'https://www.oracle.com/cloud/',
    sources: [
      { type: 'news', mentionsKeyword: true, recencyDays: 7 },
      { type: 'analyst', mentionsKeyword: true, recencyDays: 14 },
      { type: 'company', mentionsKeyword: true, recencyDays: 3 },
    ],
    velocityWindow: 'week',
    detail: 'Multicloud strategy is core to Oracle\'s cloud business',
    suppressionData: { legalRisk: false, prRestriction: false, recentControversy: false },
  },

  'Oracle:Partner': {
    transcriptHitRate: 0.50,
    transcriptAvgHitsPerCall: 1.5,
    isCoreProductOrMetric: true,
    analystTopicScore: 60,
    inEarningsRelease: true,
    pressReleaseMentions: 6,
    tenKMentions: 4,
    tenQMentions: 3,
    inRiskFactors: false,
    filingType: '10-K FY2025, 10-Q Q3 FY2026',
    secSourceUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=ORCL',
    sourceUrl: 'https://www.oracle.com/partners/',
    sources: [
      { type: 'news', mentionsKeyword: true, recencyDays: 14 },
      { type: 'company', mentionsKeyword: true, recencyDays: 7 },
    ],
    velocityWindow: 'week',
    detail: 'Partner ecosystem frequently mentioned in Oracle earnings',
    suppressionData: { legalRisk: false, prRestriction: false, recentControversy: false },
  },

  'Oracle:OpenAI': {
    transcriptHitRate: 0.33,
    transcriptAvgHitsPerCall: 0.8,
    isCoreProductOrMetric: false,
    analystTopicScore: 70,
    inEarningsRelease: false,
    pressReleaseMentions: 2,
    tenKMentions: 1,
    tenQMentions: 1,
    inRiskFactors: false,
    filingType: '10-K FY2025, 10-Q Q3 FY2026',
    secSourceUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=ORCL',
    sourceUrl: 'https://www.oracle.com/news/announcement/openai/',
    sources: [
      { type: 'news', mentionsKeyword: true, recencyDays: 30 },
      { type: 'analyst', mentionsKeyword: true, recencyDays: 21 },
    ],
    velocityWindow: 'week',
    detail: 'OpenAI partnership mentioned in some Oracle earnings calls',
    suppressionData: { legalRisk: false, prRestriction: false, recentControversy: false },
  },

  'Oracle:Debt': {
    transcriptHitRate: 0.17,
    transcriptAvgHitsPerCall: 0.3,
    isCoreProductOrMetric: false,
    analystTopicScore: 40,
    inEarningsRelease: false,
    pressReleaseMentions: 1,
    tenKMentions: 3,
    tenQMentions: 2,
    inRiskFactors: true,
    filingType: '10-K FY2025, 10-Q Q3 FY2026',
    secSourceUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=ORCL',
    sourceUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=ORCL',
    sources: [
      { type: 'sec', mentionsKeyword: true, recencyDays: 90 },
    ],
    velocityWindow: 'week',
    detail: 'Debt levels mentioned in SEC filings but rarely in earnings calls',
    suppressionData: { legalRisk: false, prRestriction: false, recentControversy: false },
  },

  'Oracle:Java': {
    transcriptHitRate: 0.50,
    transcriptAvgHitsPerCall: 1.2,
    isCoreProductOrMetric: true,
    analystTopicScore: 55,
    inEarningsRelease: true,
    pressReleaseMentions: 4,
    tenKMentions: 6,
    tenQMentions: 3,
    inRiskFactors: false,
    filingType: '10-K FY2025, 10-Q Q3 FY2026',
    secSourceUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=ORCL',
    sourceUrl: 'https://www.oracle.com/java/',
    sources: [
      { type: 'news', mentionsKeyword: true, recencyDays: 14 },
      { type: 'company', mentionsKeyword: true, recencyDays: 7 },
    ],
    velocityWindow: 'week',
    detail: 'Java is a core Oracle product, mentioned in earnings calls',
    suppressionData: { legalRisk: false, prRestriction: false, recentControversy: false },
  },

  // Chewy, Inc. — pet e-commerce company
  'Chewy:Holiday': {
    transcriptHitRate: 0.67,
    transcriptAvgHitsPerCall: 2.1,
    isCoreProductOrMetric: true,
    analystTopicScore: 70,
    inEarningsRelease: true,
    pressReleaseMentions: 4,
    tenKMentions: 2,
    tenQMentions: 3,
    inRiskFactors: false,
    filingType: '10-K FY2025, 10-Q Q3 FY2026',
    secSourceUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=CHWY',
    sourceUrl: 'https://investor.chewy.com/',
    sources: [
      { type: 'news', mentionsKeyword: true, recencyDays: 5 },
      { type: 'analyst', mentionsKeyword: true, recencyDays: 14 },
      { type: 'company', mentionsKeyword: false, recencyDays: 7 },
    ],
    velocityWindow: 'week',
    detail: 'Holiday season is a critical revenue period for Chewy, regularly discussed in earnings',
    suppressionData: { legalRisk: false, prRestriction: false, recentControversy: false },
  },

  'Chewy:Tariff': {
    transcriptHitRate: 0.17,
    transcriptAvgHitsPerCall: 0.3,
    isCoreProductOrMetric: false,
    analystTopicScore: 45,
    inEarningsRelease: false,
    pressReleaseMentions: 1,
    tenKMentions: 1,
    tenQMentions: 1,
    inRiskFactors: true,
    filingType: '10-K FY2025, 10-Q Q3 FY2026',
    secSourceUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=CHWY',
    sourceUrl: 'https://investor.chewy.com/',
    sources: [
      { type: 'news', mentionsKeyword: true, recencyDays: 30 },
    ],
    velocityWindow: 'week',
    detail: 'Tariffs mentioned as risk factor but not core to earnings discussions',
    suppressionData: { legalRisk: false, prRestriction: false, recentControversy: false },
  },

  'Chewy:Pharmacy': {
    transcriptHitRate: 0.50,
    transcriptAvgHitsPerCall: 1.5,
    isCoreProductOrMetric: true,
    analystTopicScore: 65,
    inEarningsRelease: true,
    pressReleaseMentions: 3,
    tenKMentions: 2,
    tenQMentions: 2,
    inRiskFactors: false,
    filingType: '10-K FY2025, 10-Q Q3 FY2026',
    secSourceUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=CHWY',
    sourceUrl: 'https://investor.chewy.com/',
    sources: [
      { type: 'news', mentionsKeyword: true, recencyDays: 14 },
      { type: 'company', mentionsKeyword: true, recencyDays: 7 },
    ],
    velocityWindow: 'week',
    detail: 'Chewy Pharmacy is a growing business segment, mentioned in earnings',
    suppressionData: { legalRisk: false, prRestriction: false, recentControversy: false },
  },

  // Adobe Inc. — creative software company
  'Adobe:Generative AI / Gen AI': {
    transcriptHitRate: 1.0,
    transcriptAvgHitsPerCall: 8.5,
    isCoreProductOrMetric: true,
    analystTopicScore: 95,
    inEarningsRelease: true,
    pressReleaseMentions: 15,
    tenKMentions: 8,
    tenQMentions: 6,
    inRiskFactors: true,
    filingType: '10-K FY2025, 10-Q Q1 FY2026',
    secSourceUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=ADBE',
    sourceUrl: 'https://www.adobe.com/products/firefly.html',
    sources: [
      { type: 'news', mentionsKeyword: true, recencyDays: 1 },
      { type: 'analyst', mentionsKeyword: true, recencyDays: 3 },
      { type: 'company', mentionsKeyword: true, recencyDays: 2 },
      { type: 'transcript', mentionsKeyword: true, recencyDays: 30 },
      { type: 'sec', mentionsKeyword: true, recencyDays: 60 },
    ],
    velocityWindow: 'week',
    detail: 'Generative AI (Firefly) is Adobe\'s core strategic initiative, mentioned extensively',
    suppressionData: { legalRisk: false, prRestriction: false, recentControversy: false },
  },

  'Adobe:LLM Optimizer': {
    transcriptHitRate: 0.33,
    transcriptAvgHitsPerCall: 0.5,
    isCoreProductOrMetric: false,
    analystTopicScore: 60,
    inEarningsRelease: false,
    pressReleaseMentions: 1,
    tenKMentions: 0,
    tenQMentions: 1,
    inRiskFactors: false,
    filingType: '10-K FY2025, 10-Q Q1 FY2026',
    secSourceUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=ADBE',
    sourceUrl: 'https://www.adobe.com/products/firefly.html',
    sources: [
      { type: 'news', mentionsKeyword: true, recencyDays: 21 },
      { type: 'analyst', mentionsKeyword: true, recencyDays: 30 },
    ],
    velocityWindow: 'week',
    detail: 'LLM Optimizer is a newer Adobe AI feature, limited earnings mention history',
    suppressionData: { legalRisk: false, prRestriction: false, recentControversy: false },
  },

  'Adobe:Firefly Video': {
    transcriptHitRate: 0.50,
    transcriptAvgHitsPerCall: 1.2,
    isCoreProductOrMetric: true,
    analystTopicScore: 75,
    inEarningsRelease: true,
    pressReleaseMentions: 4,
    tenKMentions: 1,
    tenQMentions: 2,
    inRiskFactors: false,
    filingType: '10-K FY2025, 10-Q Q1 FY2026',
    secSourceUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=ADBE',
    sourceUrl: 'https://www.adobe.com/products/firefly.html',
    sources: [
      { type: 'news', mentionsKeyword: true, recencyDays: 7 },
      { type: 'company', mentionsKeyword: true, recencyDays: 3 },
    ],
    velocityWindow: 'week',
    detail: 'Firefly Video is a key Adobe generative AI product, mentioned in earnings',
    suppressionData: { legalRisk: false, prRestriction: false, recentControversy: false },
  },

  'Adobe:Nvidia': {
    transcriptHitRate: 0.17,
    transcriptAvgHitsPerCall: 0.3,
    isCoreProductOrMetric: false,
    analystTopicScore: 50,
    inEarningsRelease: false,
    pressReleaseMentions: 1,
    tenKMentions: 0,
    tenQMentions: 1,
    inRiskFactors: false,
    filingType: '10-K FY2025, 10-Q Q1 FY2026',
    secSourceUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=ADBE',
    sourceUrl: 'https://www.adobe.com/products/firefly.html',
    sources: [
      { type: 'news', mentionsKeyword: true, recencyDays: 45 },
    ],
    velocityWindow: 'week',
    detail: 'Nvidia partnership mentioned occasionally in Adobe earnings context',
    suppressionData: { legalRisk: false, prRestriction: false, recentControversy: false },
  },
};

// ---------------------------------------------------------------------------
// Data feed interface
// ---------------------------------------------------------------------------

/**
 * Look up verified data for a company/keyword pair.
 * @param {string} company - Company name
 * @param {string} keyword - Target keyword
 * @returns {object|null} Verified data or null if not found
 */
export function getVerifiedData(company, keyword) {
  const key = `${company}:${keyword}`;
  return VERIFIED_DATA[key] ?? null;
}

/**
 * Check if verified data exists for a company/keyword pair.
 * @param {string} company - Company name
 * @param {string} keyword - Target keyword
 * @returns {boolean}
 */
export function hasVerifiedData(company, keyword) {
  return getVerifiedData(company, keyword) !== null;
}

/**
 * List all verified company/keyword pairs.
 * @returns {string[]}
 */
export function listVerifiedPairs() {
  return Object.keys(VERIFIED_DATA);
}

/**
 * Get all verified data entries.
 * @returns {object}
 */
export function getAllVerifiedData() {
  return { ...VERIFIED_DATA };
}
