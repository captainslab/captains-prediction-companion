// Captain Mentions — Source Ladder
//
// Standardizes evidence ordering across all mention-market packets.
// Pure ESM. No I/O. No live network. No market pricing in ladder.
//
// Order of evidence trust (high → low):
//   1. prior_transcript_word_match  — verbatim hits in past transcripts/broadcasts
//   2. recent_direct_quote_match    — direct quote from speaker in last 30d
//   3. current_event_context        — news cycle / product release / live storyline
//   4. prompt_likelihood            — host/analyst/show-format will likely prompt the topic
//   5. formal_document_proxy        — 10-K/PR/show-notes; PROXY only when transcripts missing
//   6. qualification_risk           — gating risk that can CAP posture (guest no-show, event NQE)
//
// Pricing is NEVER allowed in any ladder input. Pricing is rendered separately
// by the packet generator under "NOT IN SCORE".
//
// The Costco regression: missing live transcript access was treated as no signal.
// This module forces packets to record what was used, what was blocked, what is
// undercounted (proxy in lieu of transcript), and what is missing — explicitly.

export const SOURCE_CATEGORIES = Object.freeze([
  'prior_transcript_word_match',
  'recent_direct_quote_match',
  'current_event_context',
  'prompt_likelihood',
  'formal_document_proxy',
  'qualification_risk',
]);

export const SOURCE_RANK = Object.freeze({
  prior_transcript_word_match: 1,
  recent_direct_quote_match:   2,
  current_event_context:       3,
  prompt_likelihood:           4,
  formal_document_proxy:       5,
  qualification_risk:          6,
});

export const VALID_STATUSES = Object.freeze([
  'used', 'proxy', 'undercounted', 'blocked', 'missing', 'n/a',
]);

// Profiles dictate which ladder categories are EXPECTED (so missing is meaningful).
export const PROFILE_EXPECTED_CATEGORIES = Object.freeze({
  political_mentions: Object.freeze([
    'prior_transcript_word_match',
    'recent_direct_quote_match',
    'current_event_context',
    'prompt_likelihood',
    'qualification_risk',
  ]),
  earnings_mentions: Object.freeze([
    'prior_transcript_word_match',
    'recent_direct_quote_match',
    'current_event_context',
    'prompt_likelihood',
    'formal_document_proxy',
    'qualification_risk',
  ]),
  sports_announcer_mentions: Object.freeze([
    'prior_transcript_word_match',
    'recent_direct_quote_match',
    'current_event_context',
    'prompt_likelihood',
    'qualification_risk',
  ]),
});

const FORBIDDEN_SCORING_FIELDS = Object.freeze([
  'yes_bid', 'yes_ask', 'no_bid', 'no_ask',
  'bid', 'ask', 'odds', 'price',
  'volume', 'open_interest', 'line_movement',
  'kalshi_ask', 'kalshi_bid',
  'yes_bid_cents', 'yes_ask_cents',
]);

function assertNoPricing(category, entry) {
  if (!entry || typeof entry !== 'object') return;
  for (const f of FORBIDDEN_SCORING_FIELDS) {
    if (f in entry && entry[f] !== null && entry[f] !== undefined) {
      throw new Error(
        `Source-ladder entry "${category}" contains forbidden pricing field "${f}". ` +
        `Market data is NOT IN SCORE. Render pricing separately via the packet's market_context section.`
      );
    }
  }
}

function asEntry(category, raw) {
  if (!raw) {
    return {
      category,
      rank: SOURCE_RANK[category] ?? 99,
      status: 'missing',
      note:   `no ${category} evidence supplied`,
      source_path: null,
      hits: null,
      detail: null,
    };
  }
  assertNoPricing(category, raw);
  const status = VALID_STATUSES.includes(raw.status) ? raw.status : 'missing';
  return {
    category,
    rank:        SOURCE_RANK[category] ?? 99,
    status,
    note:        raw.note ?? (status === 'missing' ? `no ${category} evidence supplied` : null),
    source_path: raw.source_path ?? raw.url ?? null,
    hits:        raw.hits ?? null,
    detail:      raw.detail ?? null,
  };
}

const QUALIFICATION_CAPS = Object.freeze({
  high:      'WATCH',          // material chance event/guest does not qualify
  medium:    'LEAN',
  low:       null,
  confirmed: null,
  unknown:   'LEAN',           // unknown qualification status still caps to LEAN
});

const POSTURE_RANK = Object.freeze({
  NO_CLEAR_PICK: 0, WATCH: 1, LEAN: 2, EVIDENCE_LEAN: 3, PICK: 4,
});

function lowerOf(a, b) {
  return (POSTURE_RANK[a] ?? -1) <= (POSTURE_RANK[b] ?? -1) ? a : b;
}

/**
 * evaluateSourceLadder
 *
 * @param {object} opts
 * @param {string}  opts.profile          - One of PROFILE_EXPECTED_CATEGORIES keys
 * @param {object}  opts.inputs           - Map of category → { status, note, source_path?, hits?, detail? }
 *
 * Special semantics:
 *  - If profile is earnings_mentions AND prior_transcript_word_match.status === 'blocked'
 *    AND formal_document_proxy.status === 'used', the proxy is auto-marked 'proxy'
 *    and prior_transcript_word_match is auto-flagged 'undercounted' if not already.
 *  - For political/sports profiles (no formal_document_proxy expected by default), proxy
 *    can still be supplied explicitly but does not auto-promote.
 *
 * @returns {object} { profile, categories[], used[], proxy[], undercounted[], blocked[], missing[],
 *                     qualification_status, posture_cap, ranked_evidence, pricing_excluded }
 */
export function evaluateSourceLadder({ profile, inputs = {} } = {}) {
  if (!PROFILE_EXPECTED_CATEGORIES[profile]) {
    throw new Error(
      `Unknown mention profile "${profile}". Expected one of: ${Object.keys(PROFILE_EXPECTED_CATEGORIES).join(', ')}`
    );
  }
  const expected = PROFILE_EXPECTED_CATEGORIES[profile];

  // Pricing guard runs on every supplied entry (whether expected or not)
  for (const [cat, entry] of Object.entries(inputs)) {
    assertNoPricing(cat, entry);
  }

  const categories = expected.map(cat => asEntry(cat, inputs[cat]));

  // Earnings undercount rule: transcript blocked + filing proxy used
  if (profile === 'earnings_mentions') {
    const transcript = categories.find(c => c.category === 'prior_transcript_word_match');
    const proxy      = categories.find(c => c.category === 'formal_document_proxy');
    if (transcript && transcript.status === 'blocked' && proxy && proxy.status === 'used') {
      proxy.status = 'proxy';
      proxy.note = (proxy.note ? proxy.note + ' ' : '') +
        '(formal-document proxy; conversational/Q&A terms are undercounted because live transcript source is blocked)';
      // The transcript row stays 'blocked' for honesty; we also surface it under undercounted
      // via the derived list below.
    }
  }

  const used         = categories.filter(c => c.status === 'used').map(c => c.category);
  const proxy        = categories.filter(c => c.status === 'proxy').map(c => c.category);
  const undercounted = categories
    .filter(c => c.status === 'undercounted' || (c.category === 'prior_transcript_word_match' && c.status === 'blocked' && proxy.length > 0))
    .map(c => c.category);
  const blocked      = categories.filter(c => c.status === 'blocked').map(c => c.category);
  const missing      = categories.filter(c => c.status === 'missing').map(c => c.category);

  // Qualification gate
  const qual = categories.find(c => c.category === 'qualification_risk');
  const qualLevel = qual?.detail?.level ?? qual?.detail ?? (qual?.status === 'used' ? (qual?.note?.toLowerCase().includes('high') ? 'high' : qual?.note?.toLowerCase().includes('medium') ? 'medium' : 'low') : 'unknown');
  const postureCap = Object.hasOwn(QUALIFICATION_CAPS, qualLevel)
    ? QUALIFICATION_CAPS[qualLevel]
    : QUALIFICATION_CAPS.unknown;

  // Ranked evidence by trust order, used/proxy only
  const rankedEvidence = categories
    .filter(c => c.status === 'used' || c.status === 'proxy')
    .sort((a, b) => a.rank - b.rank)
    .map(c => ({ category: c.category, status: c.status, hits: c.hits, note: c.note, source_path: c.source_path }));

  return {
    profile,
    categories,
    used,
    proxy,
    undercounted,
    blocked,
    missing,
    qualification_status: qualLevel,
    posture_cap: postureCap,
    ranked_evidence: rankedEvidence,
    pricing_excluded: true,
  };
}

/**
 * applyQualificationCap — combine a composite posture with the ladder's posture cap.
 * Returns { posture, capped: bool, cap_reason }
 */
export function applyQualificationCap(posture, ladder) {
  if (!ladder || !ladder.posture_cap) {
    return { posture, capped: false, cap_reason: null };
  }
  const capped = lowerOf(posture, ladder.posture_cap);
  if (capped !== posture) {
    return {
      posture: capped,
      capped: true,
      cap_reason: `qualification_risk=${ladder.qualification_status} → cap=${ladder.posture_cap}`,
    };
  }
  return { posture, capped: false, cap_reason: null };
}

/**
 * renderSourceLadder — return array of plain-text lines for inclusion in packets.
 */
export function renderSourceLadder(ladder) {
  if (!ladder) return ['SOURCE LADDER: MISSING (no ladder supplied)'];
  const lines = [];
  lines.push('--- SOURCE LADDER ---');
  lines.push(`profile: ${ladder.profile}`);
  lines.push('order: prior_transcript_word_match > recent_direct_quote_match > current_event_context > prompt_likelihood > formal_document_proxy (proxy only) > qualification_risk (cap)');
  lines.push('pricing_excluded: true (market context rendered separately as NOT IN SCORE)');
  lines.push('categories:');
  for (const c of ladder.categories) {
    lines.push(`  - ${c.category} [rank ${c.rank}]: status=${c.status}`);
    if (c.note)        lines.push(`      note: ${c.note}`);
    if (c.hits !== null && c.hits !== undefined) lines.push(`      hits: ${c.hits}`);
    if (c.source_path) lines.push(`      source: ${c.source_path}`);
    if (c.detail && typeof c.detail === 'string') lines.push(`      detail: ${c.detail}`);
  }
  lines.push(`used: ${ladder.used.join(', ') || 'none'}`);
  lines.push(`proxy: ${ladder.proxy.join(', ') || 'none'}`);
  lines.push(`undercounted: ${ladder.undercounted.join(', ') || 'none'}`);
  lines.push(`blocked: ${ladder.blocked.join(', ') || 'none'}`);
  lines.push(`missing: ${ladder.missing.join(', ') || 'none'}`);
  lines.push(`qualification_status: ${ladder.qualification_status}`);
  lines.push(`posture_cap: ${ladder.posture_cap ?? 'none'}`);
  if (ladder.ranked_evidence.length) {
    lines.push('ranked_evidence_used_or_proxy:');
    for (const r of ladder.ranked_evidence) {
      lines.push(`  - ${r.category} (${r.status})${r.hits !== null && r.hits !== undefined ? ` hits=${r.hits}` : ''}${r.note ? `: ${r.note}` : ''}`);
    }
  }
  return lines;
}
