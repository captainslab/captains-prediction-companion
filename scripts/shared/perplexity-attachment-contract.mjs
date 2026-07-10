const DEFAULT_SOURCE_ID = 'perplexity';
const DEFAULT_SOURCE_LABEL = 'Perplexity research';

function normalizeId(value, fallbackPrefix = 'entity', index = 0) {
  const text = String(value ?? '').trim();
  return text || `${fallbackPrefix}:${index + 1}`;
}

function uniqueIds(values = [], fallbackPrefix = 'entity') {
  const seen = new Set();
  const out = [];
  values.forEach((value, index) => {
    const id = normalizeId(value, fallbackPrefix, index);
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
  });
  return out;
}

export function makeUnavailablePerplexityAttachment({
  attachment_kind,
  reason,
  source_id = DEFAULT_SOURCE_ID,
  source_label = DEFAULT_SOURCE_LABEL,
  ...rest
} = {}) {
  return {
    attachment_kind,
    status: 'unavailable',
    source_id,
    source_label,
    reason: String(reason ?? '').trim() || 'attachment unavailable',
    ...rest,
  };
}

export function makeGatheredPerplexityAttachment({
  attachment_kind,
  source_id = DEFAULT_SOURCE_ID,
  source_label = DEFAULT_SOURCE_LABEL,
  ...rest
} = {}) {
  return {
    attachment_kind,
    status: 'gathered',
    source_id,
    source_label,
    ...rest,
  };
}

export function buildPerplexityEntityAttachmentContract({
  entity_type = 'entity',
  entity_ids = [],
  attached_entity_ids = [],
  source_id = DEFAULT_SOURCE_ID,
  source_label = DEFAULT_SOURCE_LABEL,
} = {}) {
  const normalizedEntityIds = uniqueIds(entity_ids, entity_type);
  const entitySet = new Set(normalizedEntityIds);
  const normalizedAttachedIds = uniqueIds(attached_entity_ids, entity_type)
    .filter((id) => entitySet.size === 0 || entitySet.has(id));
  const attachedSet = new Set(normalizedAttachedIds);
  const missingEntityIds = normalizedEntityIds.filter((id) => !attachedSet.has(id));

  return {
    source_id,
    source_label,
    entity_type,
    entity_count: normalizedEntityIds.length,
    entity_ids: normalizedEntityIds,
    attached_count: normalizedAttachedIds.length,
    attached_entity_ids: normalizedAttachedIds,
    missing_count: missingEntityIds.length,
    missing_entity_ids: missingEntityIds,
    any_entities_attached: normalizedAttachedIds.length > 0,
    all_entities_attached: normalizedEntityIds.length > 0 && normalizedAttachedIds.length === normalizedEntityIds.length,
  };
}

export function summarizePerplexityEntityAttachments(entities = [], {
  attachment_key,
  entity_type = 'entity',
  entity_id = (entity, index) => normalizeId(entity?.id ?? entity?.event_id ?? entity?.match_id, entity_type, index),
} = {}) {
  const list = Array.isArray(entities) ? entities : [];
  const entityIds = list.map((entity, index) => entity_id(entity, index));
  const attachedIds = list
    .filter((entity) => entity?.[attachment_key]?.status === 'gathered')
    .map((entity, index) => entity_id(entity, index));
  return buildPerplexityEntityAttachmentContract({
    entity_type,
    entity_ids: entityIds,
    attached_entity_ids: attachedIds,
  });
}
