/**
 * citationHandler.js
 * Normalizes citations for CPC sports research artifacts.
 */

'use strict';

function normalizeCitations(rawCitations, fetchedUtc) {
  if (!Array.isArray(rawCitations)) return [];
  return rawCitations.map((citation, index) => {
    const url = typeof citation === 'string' ? citation : (citation?.url || null);
    const title = typeof citation === 'object' ? (citation?.title || null) : null;
    const snippet = typeof citation === 'object' ? (citation?.snippet || citation?.summary || null) : null;
    return {
      index: index + 1,
      url,
      title,
      snippet,
      fetched_utc: fetchedUtc || null,
      freshness_note: fetchedUtc ? `Sourced at ${fetchedUtc}` : 'Freshness unknown',
    };
  });
}

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
  } = opts || {};

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

function hasCitations(artifact) {
  return Array.isArray(artifact?._meta?.citations) && artifact._meta.citations.length > 0;
}

module.exports = {
  normalizeCitations,
  buildCitationMeta,
  hasCitations,
};
