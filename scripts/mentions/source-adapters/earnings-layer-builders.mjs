// Source-backed layer builders for earnings_mentions profile.
//
// Provides three previously-stubbed layers:
//   baseline_relevance   — keyword-to-company fit from transcript frequency + analyst density
//   source_velocity      — recency/coverage aggregation across independent source types
//   sec_filing_language  — keyword presence in SEC filings and earnings press releases
//
// All builders return a standard layer record:
//   { present, score, source_basis, source_path, detail, missing_note }
//
// NEVER include bid/ask/odds/volume/open_interest/line_movement in any record.
// Pure ESM. No I/O. No live network.

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ---------------------------------------------------------------------------
// buildBaselineRelevanceRecord
// ---------------------------------------------------------------------------
// Scores how core a keyword is to this company's business using:
//   - transcript hit rate across prior calls (0-1)
//   - average raw mention count per call (normalized)
//   - whether it is a core product, metric, or strategic theme
//   - analyst topic density (how prominently analysts discuss it)
//   - presence in the current earnings release text
//
// Weights: hitRate×0.30 + normalizedCount×0.20 + coreScore×0.25 + analystScore×0.20 + releaseScore×0.05
// Anti-spam: normalizedCount caps at avgHits/15 so high-frequency generic words don't dominate.

/**
 * @param {object} opts
 * @param {string}  opts.company
 * @param {string}  opts.keyword
 * @param {number}  opts.transcriptHitRate       - fraction 0-1 of calls with ≥1 mention (6-call window)
 * @param {number}  opts.transcriptAvgHitsPerCall - raw average hit count per call
 * @param {boolean} opts.isCoreProductOrMetric    - is this a primary Dell product brand, segment, or financial metric?
 * @param {number}  opts.analystTopicScore        - 0-100: how prominently analysts discuss this keyword in previews
 * @param {boolean} opts.inEarningsRelease        - does it appear in the current earnings press release?
 * @param {string?} opts.sourceUrl
 * @param {string?} opts.detail
 */
export function buildBaselineRelevanceRecord({
  company,
  keyword,
  transcriptHitRate = null,
  transcriptAvgHitsPerCall = null,
  isCoreProductOrMetric = null,
  analystTopicScore = null,
  inEarningsRelease = null,
  sourceUrl = null,
  detail = null,
} = {}) {
  const hasAny = transcriptHitRate !== null || transcriptAvgHitsPerCall !== null
    || isCoreProductOrMetric !== null || analystTopicScore !== null;

  if (!hasAny) {
    return {
      present: false, score: null,
      source_basis: `baseline_relevance: no source data supplied for "${company}" / "${keyword}"`,
      source_path: null, detail: null,
      missing_note: 'supply transcript hit rate, analyst topic score, or core-product flag',
    };
  }

  let num = 0, den = 0;
  const parts = [];

  if (transcriptHitRate !== null) {
    const component = clamp(transcriptHitRate * 100, 0, 100);
    num += component * 0.30; den += 0.30;
    parts.push(`transcript_hit_rate=${(transcriptHitRate*100).toFixed(0)}%`);
  }
  if (transcriptAvgHitsPerCall !== null) {
    // cap at 15 hits/call = 100; prevents high-frequency generic words from dominating
    const component = clamp((transcriptAvgHitsPerCall / 15) * 100, 0, 100);
    num += component * 0.20; den += 0.20;
    parts.push(`avg_hits/call=${transcriptAvgHitsPerCall.toFixed(1)}`);
  }
  if (isCoreProductOrMetric !== null) {
    const component = isCoreProductOrMetric ? 90 : 40;
    num += component * 0.25; den += 0.25;
    parts.push(`core_product=${isCoreProductOrMetric}`);
  }
  if (analystTopicScore !== null) {
    const component = clamp(analystTopicScore, 0, 100);
    num += component * 0.20; den += 0.20;
    parts.push(`analyst_topic_score=${component}`);
  }
  if (inEarningsRelease !== null) {
    const component = inEarningsRelease ? 85 : 25;
    num += component * 0.05; den += 0.05;
    parts.push(`in_earnings_release=${inEarningsRelease}`);
  }

  const score = den > 0 ? Math.round(clamp(num / den, 0, 100)) : null;

  return {
    present: score !== null,
    score,
    source_basis: `baseline relevance: ${parts.join('; ')} (${company})`,
    source_path: sourceUrl ?? null,
    detail: detail ?? `keyword "${keyword}" baseline fit for ${company} from ${parts.length} signal(s)`,
    missing_note: null,
  };
}

// ---------------------------------------------------------------------------
// buildSourceVelocityRecord
// ---------------------------------------------------------------------------
// Aggregates recent independent source coverage to produce a velocity score.
// Velocity = how actively multiple source TYPES are citing this keyword in
// the pre-call window.
//
// Source types recognized: 'news', 'analyst', 'company', 'transcript', 'sec'
// Recency weights: same-day=1.0, ≤7 days=0.8, ≤30 days=0.5, older=0.2
// Score = weighted_source_type_count / max_possible × 100
// Anti-gaming: duplicate source types are deduped — only one count per type.

/**
 * @param {object} opts
 * @param {string}  opts.company
 * @param {string}  opts.keyword
 * @param {Array}   opts.sources  - [{ type, mentionsKeyword, recencyDays, sourceUrl?, snippet? }]
 *   type: 'news'|'analyst'|'company'|'transcript'|'sec'
 *   mentionsKeyword: boolean
 *   recencyDays: number (0 = today)
 * @param {string?} opts.velocityWindow - 'today'|'week'|'month' — log filter only (not enforced)
 */
export function buildSourceVelocityRecord({
  company,
  keyword,
  sources = [],
  velocityWindow = 'week',
} = {}) {
  if (!sources || sources.length === 0) {
    return {
      present: false, score: null,
      source_basis: `source_velocity: no sources supplied for "${company}" / "${keyword}"`,
      source_path: null, detail: null,
      missing_note: `supply sources array with type, mentionsKeyword, recencyDays for each source`,
    };
  }

  const mentioningSources = sources.filter(s => s.mentionsKeyword === true);
  if (mentioningSources.length === 0) {
    return {
      present: true, score: 10,
      source_basis: `source_velocity: ${sources.length} source(s) checked; none mention "${keyword}" in the ${velocityWindow} window`,
      source_path: null,
      detail: `0/${sources.length} sources mention this keyword`,
      missing_note: null,
    };
  }

  // Recency weight per source
  function recencyWeight(days) {
    if (days <= 0)   return 1.0;
    if (days <= 1)   return 0.95;
    if (days <= 3)   return 0.85;
    if (days <= 7)   return 0.75;
    if (days <= 14)  return 0.55;
    if (days <= 30)  return 0.40;
    return 0.20;
  }

  // Dedup by type — take the best (most recent) per type
  const byType = {};
  for (const s of mentioningSources) {
    const t = s.type ?? 'unknown';
    if (!byType[t] || (s.recencyDays ?? 999) < (byType[t].recencyDays ?? 999)) {
      byType[t] = s;
    }
  }

  const TYPE_WEIGHTS = { news: 1.0, analyst: 1.2, company: 0.9, transcript: 0.8, sec: 1.1 };
  const ALL_TYPES = ['news', 'analyst', 'company', 'transcript', 'sec'];
  const MAX_POSSIBLE = ALL_TYPES.reduce((s, t) => s + (TYPE_WEIGHTS[t] ?? 1.0) * 1.0, 0); // 5.0

  let weightedScore = 0;
  const coverage = [];
  for (const [type, src] of Object.entries(byType)) {
    const rw = recencyWeight(src.recencyDays ?? 30);
    const tw = TYPE_WEIGHTS[type] ?? 1.0;
    weightedScore += rw * tw;
    coverage.push(`${type}(${src.recencyDays ?? '?'}d)`);
  }

  const score = Math.round(clamp((weightedScore / MAX_POSSIBLE) * 100, 5, 98));
  const sourceUrls = mentioningSources.map(s => s.sourceUrl).filter(Boolean);

  return {
    present: true,
    score,
    source_basis: `source_velocity: ${Object.keys(byType).length} independent source type(s) mention "${keyword}" in ${velocityWindow} window — ${coverage.join(', ')}`,
    source_path: sourceUrls[0] ?? null,
    detail: `${Object.keys(byType).length}/${ALL_TYPES.length} source types active; weighted velocity score ${score}/100`,
    missing_note: null,
  };
}

// ---------------------------------------------------------------------------
// buildSecFilingLanguageRecord
// ---------------------------------------------------------------------------
// Scores keyword presence in SEC filings and earnings press releases.
// Sources: 10-K, 10-Q, 8-K earnings release, proxy/IR materials.
//
// Score components:
//   pressRelease: highest weight (most current; directly precedes the call)
//   tenK:         product/risk-factor documentation
//   tenQ:         most recent quarterly filing
//   riskFactor:   bonus if keyword appears in risk factors (signals materiality)
//
// A keyword absent from ALL filing types scores 15 (low but not zero —
// absence from filings does not prove it won't be spoken on the call;
// conversely, presence is strong evidence of intentional framing).

/**
 * @param {object} opts
 * @param {string}  opts.company
 * @param {string}  opts.keyword
 * @param {number?} opts.pressReleaseMentions   - count in current earnings press release (8-K)
 * @param {number?} opts.tenKMentions           - count in most recent 10-K annual filing
 * @param {number?} opts.tenQMentions           - count in most recent 10-Q quarterly filing
 * @param {boolean?} opts.inRiskFactors         - keyword appears in risk factors section
 * @param {string?} opts.filingType             - human label e.g. "10-K FY2026, 8-K Q4 FY26"
 * @param {string?} opts.sourceUrl              - SEC EDGAR URL
 * @param {string?} opts.snippet               - supporting excerpt
 */
export function buildSecFilingLanguageRecord({
  company,
  keyword,
  pressReleaseMentions = null,
  tenKMentions = null,
  tenQMentions = null,
  inRiskFactors = null,
  filingType = null,
  sourceUrl = null,
  snippet = null,
} = {}) {
  const hasAny = pressReleaseMentions !== null || tenKMentions !== null || tenQMentions !== null;

  if (!hasAny) {
    return {
      present: false, score: null,
      source_basis: `sec_filing_language: no filing data supplied for "${company}" / "${keyword}"`,
      source_path: null, detail: null,
      missing_note: 'search SEC EDGAR for 10-K/10-Q/8-K; supply mention counts per filing type',
    };
  }

  function mentionScore(count) {
    if (count === null || count === undefined) return null;
    if (count === 0)  return 15;
    if (count <= 2)   return 55;
    if (count <= 5)   return 68;
    if (count <= 10)  return 78;
    if (count <= 20)  return 85;
    return 92;
  }

  let num = 0, den = 0;
  const parts = [];

  const prScore = mentionScore(pressReleaseMentions);
  if (prScore !== null) {
    num += prScore * 0.45; den += 0.45;
    parts.push(`press_release=${pressReleaseMentions}x`);
  }

  const tkScore = mentionScore(tenKMentions);
  if (tkScore !== null) {
    num += tkScore * 0.35; den += 0.35;
    parts.push(`10-K=${tenKMentions}x`);
  }

  const tqScore = mentionScore(tenQMentions);
  if (tqScore !== null) {
    num += tqScore * 0.20; den += 0.20;
    parts.push(`10-Q=${tenQMentions}x`);
  }

  let score = den > 0 ? clamp(num / den, 0, 100) : null;

  // Risk factor bonus: +8 if the keyword is material enough to appear in risk factors
  if (inRiskFactors === true && score !== null) {
    score = clamp(score + 8, 0, 100);
    parts.push('risk_factor=YES');
  }

  score = score !== null ? Math.round(score) : null;

  const filingLabel = filingType ?? 'SEC filings';
  return {
    present: score !== null,
    score,
    source_basis: `SEC filing language (${filingLabel}): ${parts.join('; ')} for "${keyword}"`,
    source_path: sourceUrl ?? 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=DELL',
    detail: snippet ?? `"${keyword}" in ${filingLabel}: ${parts.join(', ')}`,
    missing_note: null,
  };
}
