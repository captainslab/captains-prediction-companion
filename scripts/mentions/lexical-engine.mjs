import { deepSanitize, RULES_FORBIDDEN_PATTERN, parseThresholdCount } from './rules-analyst.mjs';
import { classifyRouteFromSnapshot, getRouteContract } from './route-taxonomy.mjs';

const BOUNDARY_SAFE_CHAR_RE = /[A-Za-z0-9'-]/;
const EVIDENCE_WINDOW = 24;
const MAX_EVIDENCE_SPANS = 50;

function normalizeText(value) {
  return String(value ?? '')
    .replace(/[“”]/g, '"')
    .replace(/[’‘]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeUniqueList(values) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function pushReason(list, reason) {
  if (!reason || list.includes(reason)) return;
  list.push(reason);
}

function parseRequiredCountFromSnapshot(safeSnapshot) {
  if (Number.isFinite(Number(safeSnapshot?.required_count)) && Number(safeSnapshot.required_count) > 0) {
    return Number(safeSnapshot.required_count);
  }
  const text = [safeSnapshot?.market_title, safeSnapshot?.market_subtitle].filter(Boolean).join(' ');
  return parseThresholdCount(text);
}

function boundarySafe(text, start, end) {
  const before = start > 0 ? text[start - 1] : '';
  const after = end < text.length ? text[end] : '';
  return !BOUNDARY_SAFE_CHAR_RE.test(before) && !BOUNDARY_SAFE_CHAR_RE.test(after);
}

function buildMatchData(candidateText, acceptedForms) {
  const normalizedText = normalizeText(candidateText);
  const matchesByForm = new Map();
  const evidenceSpans = [];
  let matchedCount = 0;

  for (let formIndex = 0; formIndex < acceptedForms.length; formIndex += 1) {
    const form = acceptedForms[formIndex];
    if (!form) continue;

    let searchFrom = 0;
    let formCount = 0;
    while (searchFrom <= normalizedText.length) {
      const start = normalizedText.indexOf(form, searchFrom);
      if (start === -1) break;
      const end = start + form.length;
      if (boundarySafe(normalizedText, start, end)) {
        formCount += 1;
        matchedCount += 1;
        evidenceSpans.push({
          form,
          start,
          end,
          snippet: normalizedText.slice(
            Math.max(0, start - EVIDENCE_WINDOW),
            Math.min(normalizedText.length, end + EVIDENCE_WINDOW),
          ),
          _formIndex: formIndex,
        });
      }
      searchFrom = start + Math.max(1, form.length);
    }
    if (formCount > 0) matchesByForm.set(form, formCount);
  }

  evidenceSpans.sort((left, right) => (
    left.start - right.start
    || left.end - right.end
    || left._formIndex - right._formIndex
    || left.form.localeCompare(right.form)
  ));

  const cappedEvidenceSpans = evidenceSpans.slice(0, MAX_EVIDENCE_SPANS).map(({ _formIndex, ...span }) => span);
  const matchedForms = acceptedForms.filter((form) => matchesByForm.has(form));

  return { matchedCount, matchedForms, evidenceSpans: cappedEvidenceSpans, matchesByForm };
}

function buildTopicCounts(acceptedForms, matchesByForm) {
  return acceptedForms
    .map((form) => ({ form, count: matchesByForm.get(form) ?? 0 }))
    .sort((left, right) => right.count - left.count || left.form.localeCompare(right.form));
}

function buildLexicalPolicy(blockedCategories) {
  return {
    case_insensitive: true,
    word_boundary_safe: true,
    plural_possessive: 'accepted_forms_only',
    other_inflections: 'rejected',
    slash_bundle: 'any_variant_counts',
    blocked_categories: blockedCategories,
  };
}

export function evaluateLexicalMention({ rules_snapshot, candidate_text, speaker_meta, route_contract } = {}) {
  const safeSnapshot = deepSanitize(rules_snapshot ?? {});
  const safeSpeakerMeta = deepSanitize(speaker_meta ?? {});
  void safeSpeakerMeta;

  const snapshotBlockReasons = Array.isArray(safeSnapshot.block_reasons) ? safeSnapshot.block_reasons : [];
  const outOfScope = safeSnapshot.out_of_scope === true;
  const marketType = typeof safeSnapshot.market_type === 'string' ? safeSnapshot.market_type : 'unsupported';
  const acceptedForms = normalizeUniqueList(safeSnapshot.accepted_forms);
  const blockedCategories = normalizeUniqueList(safeSnapshot.blocked_forms);

  const derivedVerdict = route_contract
    ? null
    : classifyRouteFromSnapshot(safeSnapshot);
  const resolvedContract = route_contract ?? (derivedVerdict?.status === 'active' && derivedVerdict.route
    ? getRouteContract(derivedVerdict.route)
    : null);
  const route = typeof resolvedContract?.route === 'string'
    ? resolvedContract.route
    : typeof derivedVerdict?.route === 'string'
      ? derivedVerdict.route
      : null;

  const blockReasons = [];
  for (const reason of snapshotBlockReasons) {
    if (typeof reason === 'string') pushReason(blockReasons, reason);
  }

  if (blockReasons.includes('BLOCKED_RULES_UNCLEAR')) {
    return deepFreeze({
      status: 'BLOCKED',
      matched_forms: [],
      matched_count: 0,
      required_count: marketType === 'binary' || marketType === 'ednq' ? 1 : marketType === 'threshold_count'
        ? parseRequiredCountFromSnapshot(safeSnapshot)
        : null,
      market_type: marketType,
      route,
      block_reasons: blockReasons,
      out_of_scope: outOfScope,
      evidence_spans: [],
      lexical_policy_applied: buildLexicalPolicy(blockedCategories),
    });
  }

  if (outOfScope || blockReasons.includes('OUT_OF_SCOPE_ROLLING')) {
    pushReason(blockReasons, 'OUT_OF_SCOPE_ROLLING');
    return deepFreeze({
      status: 'BLOCKED',
      matched_forms: [],
      matched_count: 0,
      required_count: marketType === 'binary' || marketType === 'ednq' ? 1 : marketType === 'threshold_count'
        ? parseRequiredCountFromSnapshot(safeSnapshot)
        : null,
      market_type: marketType,
      route,
      block_reasons: blockReasons,
      out_of_scope: true,
      evidence_spans: [],
      lexical_policy_applied: buildLexicalPolicy(blockedCategories),
    });
  }

  if (marketType === 'unsupported') {
    pushReason(blockReasons, 'BLOCKED_RULES_UNCLEAR');
    return deepFreeze({
      status: 'BLOCKED',
      matched_forms: [],
      matched_count: 0,
      required_count: null,
      market_type: marketType,
      route,
      block_reasons: blockReasons,
      out_of_scope: false,
      evidence_spans: [],
      lexical_policy_applied: buildLexicalPolicy(blockedCategories),
    });
  }

  let requiredCount = null;
  if (marketType === 'binary' || marketType === 'ednq') {
    requiredCount = 1;
  } else if (marketType === 'threshold_count') {
    requiredCount = parseRequiredCountFromSnapshot(safeSnapshot);
    if (!requiredCount) {
      pushReason(blockReasons, 'BLOCKED_RULES_UNCLEAR');
      return deepFreeze({
        status: 'BLOCKED',
        matched_forms: [],
        matched_count: 0,
        required_count: null,
        market_type: marketType,
        route,
        block_reasons: blockReasons,
        out_of_scope: false,
        evidence_spans: [],
        lexical_policy_applied: buildLexicalPolicy(blockedCategories),
      });
    }
  }

  const { matchedCount, matchedForms, evidenceSpans, matchesByForm } = buildMatchData(candidate_text, acceptedForms);
  const topicCounts = marketType === 'comparative_count' ? buildTopicCounts(acceptedForms, matchesByForm) : null;
  const status = marketType === 'comparative_count'
    ? (matchedCount >= 1 ? 'MATCH' : 'NO_MATCH')
    : (matchedCount >= requiredCount ? 'MATCH' : 'NO_MATCH');

  const output = {
    status,
    matched_forms: matchedForms,
    matched_count: matchedCount,
    required_count: requiredCount,
    market_type: marketType,
    route,
    block_reasons: blockReasons,
    out_of_scope: false,
    evidence_spans: evidenceSpans,
    lexical_policy_applied: buildLexicalPolicy(blockedCategories),
  };

  if (topicCounts) output.topic_counts = topicCounts;

  return deepFreeze(output);
}
