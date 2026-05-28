// Profile: earnings_mentions
//
// Layers and weights for scoring company earnings-call mention markets.
// Covers: prepared remarks, analyst Q&A, SEC filings, press releases.
//
// Canonical test event: Dell Earnings Call (keywords: Tailwind, PowerEdge, Headwind)
// Closed-event calendar applies — check last 6 closed Dell earnings events
// for per-keyword hit rates before sourcing external transcripts.
//
// Shared layers (all mention profiles):
//   baseline_relevance, event_proximity, source_velocity,
//   direct_mention_pathway, historical_tendency, suppression_signal, evidence_quality
//
// Earnings-specific:
//   prepared_remarks_likelihood — keyword appears in CEO/CFO script signals, prior call scripts
//   analyst_qa_pathway          — analysts commonly ask about this keyword
//   sec_filing_language         — keyword appears in 10-K/10-Q/press release language

export const PROFILE_KEY = 'earnings_mentions';

export const LAYER_DEFS = Object.freeze([
  {
    key:    'baseline_relevance',
    weight: 0.06,
    label:  'Company-to-keyword baseline relevance (product, segment, or strategic-theme fit)',
  },
  {
    key:    'event_proximity',
    weight: 0.18,
    label:  'Earnings call date proximity and confirmed event schedule (today vs. days out)',
  },
  {
    key:    'source_velocity',
    weight: 0.06,
    label:  'Source velocity: recent press/analyst coverage actively citing this keyword',
  },
  {
    key:    'direct_mention_pathway',
    weight: 0.15,
    label:  'Direct mention pathway: keyword in CEO/CFO talking points, IR materials, or prior-call opening script',
  },
  {
    key:    'historical_tendency',
    weight: 0.18,
    label:  'Historical tendency: prior earnings-call hit rate from closed-event calendar (most weight — calls are formulaic)',
  },
  {
    key:    'prepared_remarks_likelihood',
    weight: 0.10,
    label:  'Prepared-remarks likelihood: keyword present in prior call scripts, guidance language, or investor-day materials',
  },
  {
    key:    'analyst_qa_pathway',
    weight: 0.07,
    label:  'Analyst Q&A pathway: analysts have historically asked about this keyword; forces management response',
  },
  {
    key:    'sec_filing_language',
    weight: 0.05,
    label:  'SEC filing/press release language: keyword appears in official 10-K/10-Q/8-K filings',
  },
  {
    key:    'suppression_signal',
    weight: 0.06,
    label:  'Suppression signal: PR/legal incentive to avoid keyword (litigation, competitor sensitivity). High score = less suppressed.',
  },
  {
    key:    'evidence_quality',
    weight: 0.09,
    label:  'Evidence quality: confirmed earnings date, official transcript sourcing, SEC filing accessible',
  },
]);
