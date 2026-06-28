/**
 * citationHandler.js
 * Normalizes, tags, and surfaces Perplexity citations in CPC research artifacts.
 * Handles source freshness, provider/model attribution, parse status, and cost tracking.
 */

'use strict';

/**
 * Normalize a raw Perplexity citations array into structured CPC citation objects.
 *
 * @param {Array} rawCitations — Array of citation strings or objects from Perplexity
 * @param {string} fetchedUtc  — ISO timestamp of when research was fetched
 * @returns {Array<object>}    — Normalized citation records
 */
function normalizeCitations(rawCitations, fetchedUtc) {
  if (!Array.isArray(rawCitations)) return [];
  return rawCitations.map((c, idx) => {
    const url = typeof c === 'string' ? c : (c?.url || null);
    const title = typeof c === 'object' ? (c?.title || null) : null;
    return {
      index: idx + 1,
      url,
      title,
      fetched_utc: fetchedUtc || null,
      freshness_note: fetchedUtc
        ? `Sourced at ${fetchedUtc}`
        : 'Freshness unknown',
    };
  });
}

/**
 * Build a _meta citation block for a research artifact.
 *
 * @param {object} opts
 * @param {string}  opts.provider       — e.g. 'perplexity'
 * @param {string}  opts.model          — model identifier
 * @param {string}  opts.sport          — sport identifier
 * @param {string}  opts.fetchedUtc     — ISO timestamp
 * @param {Array}   opts.rawCitations   — raw citations from API
 * @param {string}  opts.parseStatus    — 'ok' | 'parse_error' | 'fallback'
 * @param {Array}   opts.missingFields  — keys with null values
 * @param {string|null} opts.costUsd    — estimated cost string
 * @returns {object}
 */
function buildCitationMeta(opts) {
  const {
    provider = 'perplexity',
    model = null,
    sport = 'unknown',
    fetchedUtc = null,
    rawCitations = [],
    parseStatus = 'ok',
    missingFields = [],
    costUsd = null,
  } = opts;

  const citations = normalizeCitations(rawCitations, fetchedUtc);

  return {
    provider,
    model,
    sport,
    fetched_utc: fetchedUtc,
    citation_count: citations.length,
    citations,
    parse_status: parseStatus,
    missing_fields: missingFields,
    cost_usd: costUsd,
    source_freshness: citations.length > 0
      ? `${citations.length} source(s) retrieved at ${fetchedUtc}`
      : 'No sources retrieved',
  };
}

/**
 * Returns true if the artifact has at least one usable citation.
 * @param {object} artifact — research artifact with _meta
 * @returns {boolean}
 */
function hasCitations(artifact) {
  return Array.isArray(artifact?._meta?.citations) &&
    artifact._meta.citations.length > 0;
}

module.exports = {
  normalizeCitations,
  buildCitationMeta,
  hasCitations,
};
