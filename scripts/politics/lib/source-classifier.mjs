// Classify a source URL/string into the politics-swarm source hierarchy.
// Tier 1 (highest) → 7 (lowest). Used by report-render to flag claims and
// sort evidence inside Section 4 (Official Evidence) and Section 5 (X Signal).

export const TIERS = Object.freeze({
  KALSHI_RULES:   1, // Kalshi market rules / settlement text
  OFFICIAL_GOV:   2, // .gov, doj.gov, whitehouse.gov, senate.gov, fbi.gov
  ON_RECORD:      3, // Direct quoted statement from named principal
  REPORTING:      4, // Reuters, AP, NYT, WSJ, WaPo, Bloomberg, Politico, Axios
  PLAUSIBILITY:   5, // Inference / process logic
  MARKET:         6, // Kalshi price/volume/OI signal
  X_SOCIAL:       7, // X.com, twitter.com, generic social
  UNKNOWN:        9,
});

const GOV_HOSTS = [
  'whitehouse.gov', 'doj.gov', 'justice.gov', 'senate.gov', 'house.gov',
  'congress.gov', 'fbi.gov', 'state.gov', 'judiciary.senate.gov',
];

const REPORTING_HOSTS = [
  'reuters.com', 'apnews.com', 'nytimes.com', 'wsj.com', 'washingtonpost.com',
  'bloomberg.com', 'politico.com', 'axios.com', 'thehill.com', 'cnn.com',
  'nbcnews.com', 'cbsnews.com', 'abcnews.go.com', 'foxnews.com',
];

const X_HOSTS = ['x.com', 'twitter.com', 't.co'];

function hostOf(s) {
  if (!s) return '';
  try { return new URL(s).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return String(s).toLowerCase(); }
}

export function classifySource(input) {
  if (!input) return { tier: TIERS.UNKNOWN, label: 'unknown' };
  const raw = String(input).toLowerCase();
  const h   = hostOf(input);

  if (raw.includes('kalshi') && (raw.includes('rule') || raw.includes('settlement'))) {
    return { tier: TIERS.KALSHI_RULES, label: 'kalshi-rules' };
  }
  if (h.endsWith('.gov') || GOV_HOSTS.some(g => h === g || h.endsWith('.' + g))) {
    return { tier: TIERS.OFFICIAL_GOV, label: 'official-gov' };
  }
  if (REPORTING_HOSTS.some(r => h === r || h.endsWith('.' + r))) {
    return { tier: TIERS.REPORTING, label: 'reporting' };
  }
  if (X_HOSTS.some(x => h === x || h.endsWith('.' + x))) {
    return { tier: TIERS.X_SOCIAL, label: 'x-social' };
  }
  if (h.includes('kalshi.com')) {
    return { tier: TIERS.MARKET, label: 'market' };
  }
  if (raw.startsWith('on-record:') || raw.startsWith('quote:')) {
    return { tier: TIERS.ON_RECORD, label: 'on-record' };
  }
  if (raw.startsWith('infer:') || raw.startsWith('plausibility:')) {
    return { tier: TIERS.PLAUSIBILITY, label: 'plausibility' };
  }
  return { tier: TIERS.UNKNOWN, label: 'unknown' };
}

// Sort an array of {source} items strongest-first.
export function sortBySourceTier(items) {
  return [...items].sort((a, b) =>
    classifySource(a?.source).tier - classifySource(b?.source).tier);
}
