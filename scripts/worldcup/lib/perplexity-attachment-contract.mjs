const DEFAULT_SOURCE_ID = 'perplexity';
const DEFAULT_SOURCE_LABEL = 'Perplexity research';

function normalizeMatchId(match = {}) {
  const id = String(match?.match_id ?? '').trim();
  return id || null;
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

function attachmentSummaryFor(matches = [], key) {
  const attached_match_ids = [];
  let unavailable_count = 0;
  for (const match of matches) {
    if (match?.[key]?.status === 'gathered') {
      attached_match_ids.push(normalizeMatchId(match) ?? `${key}:${attached_match_ids.length}`);
    } else {
      unavailable_count += 1;
    }
  }
  return {
    attached_count: attached_match_ids.length,
    attached_match_ids,
    unavailable_count,
  };
}

export function summarizePerplexityAttachments(matches = []) {
  return {
    match_count: Array.isArray(matches) ? matches.length : 0,
    live_context: attachmentSummaryFor(matches, 'live_context'),
    preview_context: attachmentSummaryFor(matches, 'preview_context'),
  };
}

function compareCount(label, expected, actual, errors) {
  if (Number.isFinite(expected) && expected !== actual) {
    errors.push(`${label} expected ${expected} but found ${actual}`);
  }
}

function compareIds(label, expected, actual, errors) {
  if (!Array.isArray(expected)) return;
  const a = [...expected].map((value) => String(value)).sort();
  const b = [...actual].map((value) => String(value)).sort();
  if (a.length !== b.length) {
    errors.push(`${label} expected ${a.length} id(s) but found ${b.length}`);
    return;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      errors.push(`${label} expected [${a.join(', ')}] but found [${b.join(', ')}]`);
      return;
    }
  }
}

export function assertPerplexityAttachmentSummaryMatches(summary = null, matches = []) {
  if (!summary || typeof summary !== 'object') return true;
  const attachmentSummary = summarizePerplexityAttachments(matches);
  const errors = [];

  compareCount('live_context attached_count', Number(summary?.attached_count), attachmentSummary.live_context.attached_count, errors);
  compareIds('live_context attached_match_ids', summary?.attached_match_ids, attachmentSummary.live_context.attached_match_ids, errors);
  compareCount('preview_context attached_count', Number(summary?.preview_attached_count), attachmentSummary.preview_context.attached_count, errors);
  compareIds('preview_context attached_match_ids', summary?.preview_attached_match_ids, attachmentSummary.preview_context.attached_match_ids, errors);

  compareCount(
    'attachment_contract.live_context.attached_count',
    Number(summary?.attachment_contract?.live_context?.attached_count),
    attachmentSummary.live_context.attached_count,
    errors,
  );
  compareIds(
    'attachment_contract.live_context.attached_match_ids',
    summary?.attachment_contract?.live_context?.attached_match_ids,
    attachmentSummary.live_context.attached_match_ids,
    errors,
  );
  compareCount(
    'attachment_contract.preview_context.attached_count',
    Number(summary?.attachment_contract?.preview_context?.attached_count),
    attachmentSummary.preview_context.attached_count,
    errors,
  );
  compareIds(
    'attachment_contract.preview_context.attached_match_ids',
    summary?.attachment_contract?.preview_context?.attached_match_ids,
    attachmentSummary.preview_context.attached_match_ids,
    errors,
  );

  if (errors.length) {
    throw new Error(`worldcup perplexity attachment contract mismatch: ${errors.join('; ')}`);
  }
  return true;
}

export function buildWorldCupResearchSummary(research = {}, matches = []) {
  const attachment_contract = summarizePerplexityAttachments(matches);
  return {
    status: research?.status ?? null,
    ok: research?.ok ?? null,
    outPath: research?.outPath ?? null,
    match_count: attachment_contract.match_count,
    record_count: Array.isArray(research?.artifact?.records) ? research.artifact.records.length : 0,
    attached_count: attachment_contract.live_context.attached_count,
    attached_match_ids: attachment_contract.live_context.attached_match_ids,
    preview_attached_count: attachment_contract.preview_context.attached_count,
    preview_attached_match_ids: attachment_contract.preview_context.attached_match_ids,
    source_quality: research?.artifact?.source_quality ?? null,
    reason: research?.artifact?.reason ?? null,
    attachment_contract,
  };
}
