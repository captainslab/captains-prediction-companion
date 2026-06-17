// Deterministic prior-transcript word coverage for earnings mention markets.
//
// Pure ESM. No I/O. No network. No model calls. No market pricing — EVER.
//
// Given a set of mention strikes (each derived from a Kalshi yes_sub_title) and
// a set of prior earnings-call transcript documents (raw text + quarter label),
// this module computes a deterministic, reproducible HIT/MISS per strike per
// document via word-boundary regex over the strike's own settlement phrase.
// This is the source-ladder rank-1 `prior_transcript_word_match` signal: it is
// evidence of how often a term was actually said on prior calls, not a price.
//
// HARD RULE: this module never reads or emits price/bid/ask/volume/liquidity/
// open-interest. Inputs are strike phrases and transcript prose only.

const FORBIDDEN_PATTERN = /price|bid|ask|volume|liquidity|interest|spread|notional|odds/i;

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * termPatterns — pure. Build the alternative match patterns for one strike,
 * driven entirely by the Kalshi yes_sub_title (no per-company cherry-picking).
 *
 *   "SNAP / Food Stamp"          -> ["SNAP", "Food Stamp"]
 *   "AI / Artificial Intelligence" -> ["AI", "Artificial Intelligence"]
 *   "GLP-1"                       -> ["GLP-1"]
 *   "250"                         -> ["250"]
 *
 * Each alternative becomes a case-insensitive, word-boundary regex. Single
 * alphabetic tokens allow an optional trailing "s" (tariff -> tariffs); spaces
 * become flexible whitespace; hyphens become flexible hyphen/space.
 */
export function termPatterns(strikePhrase) {
  const phrase = String(strikePhrase ?? '').trim();
  if (!phrase) return [];
  const alternatives = phrase.split('/').map((p) => p.trim()).filter(Boolean);
  const patterns = [];
  for (const alt of alternatives) {
    const isPureNumber = /^\d+$/.test(alt);
    const isSingleAlphaToken = /^[A-Za-z]+$/.test(alt);
    let body = escapeRegex(alt)
      .replace(/\\?\s+/g, '\\s+')
      .replace(/\\-/g, '[-\\s]?');
    if (isSingleAlphaToken) body = `${body}s?`;
    const source = isPureNumber ? `(?<![\\d.,])${body}(?![\\d.,])` : `\\b${body}\\b`;
    patterns.push({ alternative: alt, regex: new RegExp(source, 'i') });
  }
  return patterns;
}

function firstQuote(text, regex) {
  const m = regex.exec(text);
  if (!m) return null;
  const idx = m.index;
  const start = Math.max(0, idx - 90);
  const end = Math.min(text.length, idx + m[0].length + 90);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

/**
 * matchStrikeInText — pure. Returns { hit, matched_alternative, quote } for one
 * strike against one transcript text body.
 */
export function matchStrikeInText(strikePhrase, text) {
  const body = String(text ?? '');
  for (const { alternative, regex } of termPatterns(strikePhrase)) {
    if (regex.test(body)) {
      return { hit: true, matched_alternative: alternative, quote: firstQuote(body, regex) };
    }
  }
  return { hit: false, matched_alternative: null, quote: null };
}

/**
 * buildStrikeCoverage — pure, deterministic.
 *
 * @param {object} opts
 * @param {Array<{ticker,strike}>} opts.strikes  - current-board strikes
 * @param {Array<{label,quarter,text,source_url,source_type}>} opts.sources
 *        - prior transcript / official documents (newest first preferred)
 *
 * For each strike, computes per-source HIT/MISS, a quarter hit count over
 * transcript sources, and a deterministic prior_transcript_word_match record.
 * Misses are recorded, never skipped (the Costco regression guard).
 */
export function buildStrikeCoverage({ strikes = [], sources = [] } = {}) {
  const transcriptSources = sources.filter((s) => s.source_type === 'transcript');
  const rows = strikes.map(({ ticker, strike }) => {
    const perSource = sources.map((s) => {
      const m = matchStrikeInText(strike, s.text);
      return {
        source_label: s.label,
        quarter: s.quarter ?? null,
        source_type: s.source_type ?? null,
        source_url: s.source_url ?? null,
        hit: m.hit,
        matched_alternative: m.matched_alternative,
        quote: m.quote,
      };
    });
    const transcriptHits = perSource.filter((p) => p.source_type === 'transcript' && p.hit).length;
    const transcriptN = transcriptSources.length;
    const anyOfficialHit = perSource.some((p) => p.source_type !== 'transcript' && p.hit);
    return {
      ticker,
      strike,
      patterns: termPatterns(strike).map((p) => p.regex.source),
      // No prior Kalshi board exists for this series (verified live); stored
      // history is structurally unavailable, so every strike needs a fresh
      // source fetch — which this transcript coverage provides.
      prior_board_seen: false,
      resolved_yes: 0,
      resolved_no: 0,
      ednq: 0,
      ambiguous: 0,
      unresolved: 0,
      last_4q_transcript_hits: transcriptHits,
      last_4q_transcript_quarters: transcriptN,
      last_4q_transcript_hit_rate: transcriptN ? transcriptHits / transcriptN : null,
      official_document_hit: anyOfficialHit,
      needs_fresh_source_fetch: true,
      reason: 'no prior Kalshi board for KXEARNINGSMENTIONKR (settled=0, closed=0); coverage from prior earnings-call transcripts',
      per_source: perSource,
      source_backed: transcriptHits > 0 || anyOfficialHit,
    };
  });

  const summary = {
    strike_count: rows.length,
    transcript_sources: transcriptSources.length,
    total_sources: sources.length,
    source_backed_strikes: rows.filter((r) => r.source_backed).length,
    low_source_strikes: rows.filter((r) => !r.source_backed).length,
  };
  return { rows, summary };
}

export function assertNoPriceFields(value, label = 'transcript-word-coverage output') {
  JSON.stringify(value, (key, v) => {
    if (key && FORBIDDEN_PATTERN.test(key)) {
      throw new Error(`${label} contains forbidden price-shaped key "${key}".`);
    }
    return v;
  });
  return true;
}
