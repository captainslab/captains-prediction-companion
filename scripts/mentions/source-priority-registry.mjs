// Per-rule-family PRIORITY SOURCE registry for mention research.
//
// Drives the Perplexity `search_domain_filter` allowlist (priority sources) and
// records which domains are settlement-proof-grade vs handicapping-grade. This is
// the INTERACTIVE research layer only — it is never used by the cron pipeline,
// which has no Perplexity key. Read-only, pure data + classifiers. No price data.
//
// Settlement still follows the source Kalshi's rules name; "priority" only biases
// research discovery/handicapping toward trustworthy domains.

// Family keys mirror the rule families in the design memo. Each entry lists
// `proof` domains (official/settlement-grade) and `handicapping` domains
// (research-grade news/context). Perplexity caps the allowlist near 10 domains.
export const FAMILY_PRIORITY = Object.freeze({
  trump_whitehouse: {
    // User directive 2026-06-19: rollcall.com is the DEFAULT priority source for
    // the whole Trump + White House entity class (President, Cabinet secretaries,
    // press secretary, VP). It is research/handicapping-grade unless a contract's
    // rules name it.
    proof: ['whitehouse.gov', 'c-span.org'],
    handicapping: ['rollcall.com', 'reuters.com', 'apnews.com', 'politico.com'],
  },
  politics: {
    proof: ['whitehouse.gov', 'c-span.org'],
    handicapping: ['reuters.com', 'apnews.com', 'politico.com', 'rollcall.com'],
  },
  fed: {
    proof: ['federalreserve.gov', 'c-span.org'],
    handicapping: ['reuters.com', 'apnews.com'],
  },
  earnings: {
    // ir.<company>.com is injected dynamically when the company domain is known.
    proof: ['sec.gov'],
    handicapping: ['fool.com', 'finance.yahoo.com'],
  },
  sports: {
    proof: ['mlb.com', 'nfl.com', 'official.nba.com'],
    handicapping: ['espn.com'],
  },
  tv_media: {
    proof: [],
    handicapping: ['cnn.com'],
  },
  generic: {
    proof: ['c-span.org'],
    handicapping: ['reuters.com', 'apnews.com'],
  },
});

// Entity-class detection for the Trump/White House default. Matches the speaker
// being Trump / the President / a Cabinet secretary / press secretary / VP.
const TRUMP_WH_PATTERNS = [
  /\btrump\b/i,
  /\bwhite house\b/i,
  /\bpresident\b/i,
  /\bvice\s+president\b/i,
  /\b(vp|potus|flotus)\b/i,
  /\bpress secretary\b/i,
  /\bsecretary of (state|defense|treasury|homeland|commerce|labor|energy|education|transportation|interior|agriculture|veterans|health)\b/i,
  /\bcabinet\b/i,
  /\battorney general\b/i,
];

const FED_PATTERNS = [/\bfed\b/i, /\bfederal reserve\b/i, /\bfomc\b/i, /\bpowell\b/i, /\bwarsh\b/i];
const EARNINGS_PATTERNS = [/\bearnings\b/i, /\bquarter(ly)?\b/i, /\bearnings call\b/i];
const SPORTS_PATTERNS = [/\bannouncer/i, /\bplay-by-play\b/i, /\bworld cup\b/i, /\bmlb\b/i, /\bnfl\b/i, /\bnba\b/i, /\bufc\b/i, /\bnhl\b/i];
const TV_PATTERNS = [/\btonight show\b/i, /\bthe view\b/i, /\blate[- ]night\b/i, /\binterview\b/i, /\btalk show\b/i];

/**
 * Classify an event into a priority family using its title/ticker/series.
 * Pure. Returns a family key present in FAMILY_PRIORITY.
 */
export function classifyPriorityFamily(event = {}) {
  const hay = [
    event.title ?? '', event.sub_title ?? '', event.event_ticker ?? '',
    event.series_ticker ?? '',
  ].join(' ');
  if (TRUMP_WH_PATTERNS.some((p) => p.test(hay))) return 'trump_whitehouse';
  if (FED_PATTERNS.some((p) => p.test(hay))) return 'fed';
  if (EARNINGS_PATTERNS.some((p) => p.test(hay))) return 'earnings';
  if (SPORTS_PATTERNS.some((p) => p.test(hay))) return 'sports';
  if (TV_PATTERNS.some((p) => p.test(hay))) return 'tv_media';
  // Any remaining political-looking event.
  if (/\bsay\b|\bmention\b|\bspeech\b|\brally\b|\bdebate\b|\bhearing\b/i.test(hay)) return 'politics';
  return 'generic';
}

const DOMAIN_RE = /\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/gi;
const PRICE_HOST_RE = /kalshi|polymarket|predictit|betfair|draftkings|fanduel/i;

/**
 * Pull bare domains out of free text (e.g. the "Outcome verified from ..." list
 * a Kalshi event page exposes). Drops market/price hosts. Pure.
 */
export function extractDomainsFromText(text = '') {
  const out = new Set();
  let m;
  DOMAIN_RE.lastIndex = 0;
  while ((m = DOMAIN_RE.exec(text)) !== null) {
    const d = m[1].toLowerCase().replace(/^www\./, '');
    if (!d.includes('.')) continue;
    if (PRICE_HOST_RE.test(d)) continue;
    // Reject prose abbreviations like "e.g" / "i.e": the TLD must be alphabetic
    // and at least 2 chars (a real TLD), not a one-letter fragment.
    const tld = d.split('.').pop();
    if (!/^[a-z]{2,}$/.test(tld)) continue;
    out.add(d);
  }
  return [...out];
}

/**
 * Build the priority allowlists for an event.
 *   - proofDomains: family proof domains + any outlets named in the contract
 *     rules text (rulesNamedDomains) + dynamic IR domain for earnings.
 *   - handicappingDomains: family handicapping domains.
 * Capped to maxDomains each (Perplexity allowlist limit ~10). Pure.
 */
export function buildPriorityDomains(event = {}, options = {}) {
  const family = options.family ?? classifyPriorityFamily(event);
  const base = FAMILY_PRIORITY[family] ?? FAMILY_PRIORITY.generic;
  const maxDomains = options.maxDomains ?? 10;

  const rulesNamed = Array.isArray(options.rulesNamedDomains) ? options.rulesNamedDomains : [];
  const dynamic = [];
  if (family === 'earnings' && options.companyIrDomain) dynamic.push(options.companyIrDomain);

  // Proof pass: rules-named outlets win (highest trust — Kalshi may settle from
  // them), then dynamic IR, then family defaults.
  const proof = dedupeCap([...rulesNamed, ...dynamic, ...base.proof], maxDomains);
  const handicapping = dedupeCap([...base.handicapping], maxDomains);
  // Combined PRIORITY allowlist actually applied as the Perplexity
  // search_domain_filter — includes the family's priority handicapping domains
  // (e.g. rollcall.com for Trump/White House) so the default priority sources
  // genuinely shape results, not just official proof domains.
  const priority = dedupeCap([...proof, ...handicapping], maxDomains);

  return { family, proofDomains: proof, handicappingDomains: handicapping, priorityDomains: priority };
}

function dedupeCap(list, cap) {
  const seen = new Set();
  const out = [];
  for (const d of list) {
    const v = String(d || '').toLowerCase().replace(/^www\./, '').trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= cap) break;
  }
  return out;
}
