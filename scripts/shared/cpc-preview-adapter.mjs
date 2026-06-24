// Unified CPC packet preview adapter.
//
// One entry point every real packet path (mentions, MLB, World Cup) calls to
// turn a banked, sanitized research artifact PLUS the deterministic CPC model
// summary into a customer-safe preview block:
//
//   Headline / Why it matters / Storyline / Quick read
//
// Hard contract:
//   - The research bank is HISTORICAL MEMORY, not live truth. A banked artifact
//     is only rendered as source-backed when it is FRESH for the packet date;
//     otherwise it is labeled non-fresh and the block falls back to the
//     deterministic model + source-health summary. Generated narrative informs
//     style/continuity only and is NEVER evidence.
//   - Deterministic CPC code owns scoring, ranking, route selection, posture,
//     and final wording. This adapter renders display text only.
//   - Price/odds/market fields are stripped (defense in depth) before any text
//     is produced and can never reach the preview sections.
//   - Missing facts render as "unavailable / not sourced", never invented.
//   - No raw research JSON is ever emitted to the customer block.
//
// Pure-ish ESM: the only I/O is the read-only research-bank lookup.

import {
  sanitizeResearchArtifact,
  assertNoMarketLeak,
} from './preview-artifact-sanitizer.mjs';
import {
  buildSportsPreview,
  scrubCustomerText,
  findBannedCustomerWord,
} from './sports-preview-builder.mjs';
import { readResearchBankArtifact } from './cpc-research-bank.mjs';

const SPORTS_PACKET_TYPES = new Set(['mlb-game', 'mlb-slate', 'worldcup-match', 'worldcup-matchday']);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstText(...candidates) {
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    const text = String(candidate).trim();
    if (text.length) return text;
  }
  return '';
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function countWords(text) {
  const trimmed = String(text ?? '').trim();
  return trimmed ? trimmed.split(/\s+/).filter(Boolean).length : 0;
}

function truncateWords(text, maxWords) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(' ');
  return `${words.slice(0, maxWords).join(' ')}...`;
}

// Strip anything ISO-timestamp-shaped and any local filesystem/module path
// (defense in depth — these must never reach customer-facing text).
function scrubLeaks(text) {
  return String(text ?? '')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?Z?/g, '(time withheld)')
    .replace(/\/home\/[^\s]*/g, '(path withheld)')
    .replace(/[\w./-]+\.mjs/g, '(module withheld)');
}

function cleanText(text) {
  return scrubCustomerText(scrubLeaks(text));
}

// Pull a couple of human-readable source-backed values from sanitized
// model_safe_inputs (which is already price-free after sanitization).
function pickSourceBackedContext(sanitized) {
  const inputs = isObject(sanitized?.model_safe_inputs) ? sanitized.model_safe_inputs : {};
  const interesting = [];
  for (const [key, value] of Object.entries(inputs)) {
    if (typeof value === 'string' && value && value.toLowerCase() !== 'unavailable') {
      interesting.push(`${key.replace(/_/g, ' ')}: ${value}`);
    } else if (Array.isArray(value) && value.length && value.every((v) => typeof v === 'string')) {
      interesting.push(`${key.replace(/_/g, ' ')}: ${value.join(', ')}`);
    }
    if (interesting.length >= 2) break;
  }
  const sourceTitle = firstText(...toArray(sanitized?.source_titles));
  const parts = [];
  if (interesting.length) parts.push(interesting.join('; '));
  if (sourceTitle) parts.push(`primary source: ${sourceTitle}`);
  return parts.length ? truncateWords(parts.join('; '), 28) : 'No external source confirmed for this preview.';
}

function pickKeyUncertainty(sanitized) {
  const unconfirmed = firstText(...toArray(sanitized?.unconfirmed_claims));
  if (unconfirmed) return truncateWords(unconfirmed, 22);
  const unavailable = toArray(sanitized?.unavailable_fields).filter(Boolean);
  if (unavailable.length) return `${unavailable.slice(0, 4).join(', ').replace(/_/g, ' ')} not sourced`;
  return 'No flagged uncertainty.';
}

// Mentions-shaped preview. Source facts come only from the sanitized artifact;
// route/submarket/model read come only from the deterministic CPC model summary.
function buildMentionsPreview({ packet_type, route, submarket, id, model = {}, sanitized = null }) {
  const hasResearch = isObject(sanitized);

  const headline = cleanText(
    firstText(...toArray(sanitized?.headline_candidates), model?.headline, `Mention preview ${id}`),
  );

  const whyItMatters = cleanText(
    hasResearch
      ? firstText(sanitized?.why_this_matters, model?.why_it_matters, model?.context_summary) || 'unavailable'
      : firstText(model?.why_it_matters, model?.context_summary, model?.stakes) || 'Mention context unavailable.',
  );

  // Storyline: editorial context + a confirmed fact, capped at 110 words.
  const editorialValues = isObject(sanitized?.editorial_context)
    ? Object.values(sanitized.editorial_context).filter((v) => typeof v === 'string' && v)
    : [];
  const fact = firstText(...toArray(sanitized?.confirmed_facts));
  const storyPieces = [];
  if (editorialValues.length) storyPieces.push(truncateWords(editorialValues[0], 30));
  else storyPieces.push(firstText(model?.context_summary, model?.storyline) || 'Mention context is sourced.');
  if (fact) storyPieces.push(truncateWords(fact, 28));
  let storyline = storyPieces.filter(Boolean).join(' ');
  if (countWords(storyline) > 110) {
    storyline = `${storyline.trim().split(/\s+/).slice(0, 110).join(' ')}...`;
  }
  storyline = cleanText(storyline);

  const quickRead = {
    route_market_family: cleanText(`Route / market family: ${firstText(route, model?.route, 'unavailable')} / ${firstText(submarket, packet_type, 'unavailable')}`),
    model_read: cleanText(`Result/model read: ${firstText(model?.model_read, model?.result_edge, model?.posture_summary, model?.read) || 'unavailable'}`),
    source_backed_context: cleanText(`Source-backed context: ${hasResearch ? pickSourceBackedContext(sanitized) : 'No banked research; deterministic model and source-health only.'}`),
    key_uncertainty: cleanText(`Key uncertainty: ${hasResearch ? pickKeyUncertainty(sanitized) : firstText(model?.key_uncertainty, 'Research gap — no banked source.')}`),
    model_caveat: cleanText(`Model caveat: ${firstText(model?.caveat, model?.model_caveat, 'Model output is deterministic; research is context only.')}`),
  };

  const sections = { headline, why_it_matters: whyItMatters, storyline, quick_read: quickRead };
  return { sections, used_research: hasResearch, fallback: !hasResearch };
}

function renderMentionsText(sections, nonFreshNote) {
  const q = sections.quick_read;
  const lines = [
    `Headline: ${sections.headline}`,
    `Why it matters: ${sections.why_it_matters}`,
    `Storyline: ${sections.storyline}`,
    'Quick read:',
    `- ${q.route_market_family}`,
    `- ${q.model_read}`,
    `- ${q.source_backed_context}`,
    `- ${q.key_uncertainty}`,
    `- ${q.model_caveat}`,
  ];
  if (nonFreshNote) lines.push(nonFreshNote);
  return cleanText(lines.join('\n'));
}

function nonFreshNoteFor(freshnessStatus) {
  if (freshnessStatus === 'no_artifact') return '';
  if (freshnessStatus === 'fresh') return '';
  return `Research note: banked context is ${freshnessStatus} (historical memory only — not treated as fresh evidence).`;
}

/**
 * Build a customer-safe preview block for one event from the research bank +
 * deterministic CPC model summary.
 *
 * @param {object} args
 * @param {string} args.date           Packet date (YYYY-MM-DD), used for the bank lookup + freshness.
 * @param {string} args.packet_family  'sports' | 'mentions'
 * @param {string} args.packet_type    e.g. 'mlb-game', 'worldcup-match', 'earnings-call-mention'
 * @param {string} args.event_id       Kalshi event ticker used as the bank key.
 * @param {object} [args.model]        Market-neutral deterministic CPC model summary.
 * @param {string} [args.root]         Research-bank root override (tests).
 * @returns {{ text, sections, used_research, fallback, artifact_found, freshness_status }}
 */
export function buildPacketPreviewBlock({
  date,
  packet_family,
  packet_type,
  route,
  submarket,
  event_id,
  model = {},
  root,
  freshWindowDays,
  agingWindowDays,
} = {}) {
  const banked = readResearchBankArtifact({ date, packet_family, packet_type, event_id, root, freshWindowDays, agingWindowDays });

  const artifactFound = Boolean(banked && banked.sanitized);
  const freshnessStatus = artifactFound ? banked.freshness.status : 'no_artifact';
  const isFresh = artifactFound && banked.freshness.fresh === true;

  // Defense in depth: re-sanitize on read so price/odds/market_context can never
  // reach the preview even if a bank file was written by an older sanitizer.
  let sanitized = null;
  if (isFresh) {
    sanitized = sanitizeResearchArtifact(banked.sanitized);
    assertNoMarketLeak(sanitized.model_safe_inputs);
  }

  const isSports = packet_family === 'sports' || SPORTS_PACKET_TYPES.has(packet_type);
  const nonFreshNote = nonFreshNoteFor(freshnessStatus);

  let result;
  if (isSports) {
    const sport = String(packet_type || '').startsWith('worldcup') || route === 'worldcup_match' ? 'worldcup' : 'mlb';
    const preview = buildSportsPreview({
      sport,
      packet_type,
      id: event_id,
      model,
      research: sanitized, // null when not fresh → builder renders model-only fallback
    });
    let text = preview.text;
    if (nonFreshNote) text = cleanText(`${text}\n${nonFreshNote}`);
    result = {
      text,
      sections: preview.sections,
      used_research: Boolean(sanitized) && preview.used_research,
      fallback: !sanitized || preview.fallback,
    };
  } else {
    const preview = buildMentionsPreview({ packet_type, route, submarket, id: event_id, model, sanitized });
    result = {
      text: renderMentionsText(preview.sections, nonFreshNote),
      sections: preview.sections,
      used_research: preview.used_research,
      fallback: preview.fallback,
    };
  }

  // Final guard: a banned tout word in the rendered block is a hard error.
  const banned = findBannedCustomerWord(result.text);
  if (banned) {
    throw new Error(`banned customer preview word leaked into preview block: "${banned}"`);
  }

  return {
    ...result,
    artifact_found: artifactFound,
    freshness_status: freshnessStatus,
  };
}

export { buildMentionsPreview };
