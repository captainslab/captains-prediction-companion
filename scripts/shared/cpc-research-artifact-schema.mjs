// Normalized CPC research artifact schema + validator.
// Pure ESM. No I/O.
//
// Perplexity returns ONE artifact in this shape. CPC deterministic code owns
// scoring, ranking, route resolution, posture, layout, and customer wording;
// this artifact is source-backed extraction only and never carries market/price
// data into model_safe_inputs.

export const CPC_RESEARCH_ARTIFACT_SCHEMA = 'cpc_research_artifact_v1';

export const CPC_PACKET_FAMILIES = Object.freeze(['sports', 'mentions']);

export const CPC_FRESHNESS_VALUES = Object.freeze([
  'same_day',
  '1d',
  '2to7d',
  'stale',
  'undated',
]);

// Required top-level keys, in canonical order.
export const CPC_RESEARCH_ARTIFACT_KEYS = Object.freeze([
  'schema',
  'packet_family',
  'packet_type',
  'route',
  'submarket',
  'event_id',
  'market_id',
  'event_url',
  'generated_at',
  'source_id',
  'source_urls',
  'source_titles',
  'source_freshness',
  'confirmed_facts',
  'unconfirmed_claims',
  'unavailable_fields',
  'model_safe_inputs',
  'editorial_context',
  'why_this_matters',
  'headline_candidates',
  'risk_notes',
]);

const STRING_KEYS = Object.freeze([
  'packet_type',
  'route',
  'submarket',
  'event_id',
  'market_id',
  'event_url',
  'generated_at',
  'why_this_matters',
]);

const STRING_ARRAY_KEYS = Object.freeze([
  'source_urls',
  'source_titles',
  'confirmed_facts',
  'unconfirmed_claims',
  'unavailable_fields',
  'headline_candidates',
  'risk_notes',
]);

const OBJECT_KEYS = Object.freeze(['model_safe_inputs', 'editorial_context']);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Validate a normalized CPC research artifact.
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateCpcResearchArtifact(artifact) {
  const errors = [];

  if (!isObject(artifact)) {
    return { valid: false, errors: ['artifact must be a plain object'] };
  }

  for (const key of CPC_RESEARCH_ARTIFACT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(artifact, key)) {
      errors.push(`missing required key: ${key}`);
    }
  }

  if (artifact.schema !== CPC_RESEARCH_ARTIFACT_SCHEMA) {
    errors.push(`schema must equal "${CPC_RESEARCH_ARTIFACT_SCHEMA}"`);
  }

  if (!CPC_PACKET_FAMILIES.includes(artifact.packet_family)) {
    errors.push(`packet_family must be one of: ${CPC_PACKET_FAMILIES.join(', ')}`);
  }

  if (artifact.source_id !== 'perplexity') {
    errors.push('source_id must equal "perplexity"');
  }

  for (const key of STRING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(artifact, key) && typeof artifact[key] !== 'string') {
      errors.push(`${key} must be a string`);
    }
  }

  for (const key of STRING_ARRAY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(artifact, key) && !isStringArray(artifact[key])) {
      errors.push(`${key} must be an array of strings`);
    }
  }

  for (const key of OBJECT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(artifact, key) && !isObject(artifact[key])) {
      errors.push(`${key} must be a plain object`);
    }
  }

  if (Object.prototype.hasOwnProperty.call(artifact, 'source_freshness')) {
    if (!Array.isArray(artifact.source_freshness)) {
      errors.push('source_freshness must be an array');
    } else {
      artifact.source_freshness.forEach((entry, index) => {
        if (!isObject(entry)) {
          errors.push(`source_freshness[${index}] must be an object`);
          return;
        }
        if (typeof entry.url !== 'string') {
          errors.push(`source_freshness[${index}].url must be a string`);
        }
        if (typeof entry.checked_at !== 'string') {
          errors.push(`source_freshness[${index}].checked_at must be a string`);
        }
        if (!CPC_FRESHNESS_VALUES.includes(entry.freshness)) {
          errors.push(`source_freshness[${index}].freshness must be one of: ${CPC_FRESHNESS_VALUES.join(', ')}`);
        }
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

export function assertCpcResearchArtifact(artifact, label = 'artifact') {
  const { valid, errors } = validateCpcResearchArtifact(artifact);
  if (!valid) {
    throw new Error(`invalid cpc_research_artifact_v1 (${label}): ${errors.join('; ')}`);
  }
  return true;
}

/**
 * Build a schema-complete artifact with safe defaults, merged over `partial`.
 * Strings default to "unavailable"; arrays to []; objects to {}.
 * Never invents source-backed facts.
 */
export function makeEmptyCpcResearchArtifact(partial = {}) {
  const base = {
    schema: CPC_RESEARCH_ARTIFACT_SCHEMA,
    packet_family: 'unavailable',
    packet_type: 'unavailable',
    route: 'unavailable',
    submarket: 'unavailable',
    event_id: 'unavailable',
    market_id: 'unavailable',
    event_url: 'unavailable',
    generated_at: 'unavailable',
    source_id: 'perplexity',
    source_urls: [],
    source_titles: [],
    source_freshness: [],
    confirmed_facts: [],
    unconfirmed_claims: [],
    unavailable_fields: [],
    model_safe_inputs: {},
    editorial_context: {},
    why_this_matters: 'unavailable',
    headline_candidates: [],
    risk_notes: [],
  };
  return { ...base, ...partial };
}
