// Editorial-only MLB paragraph helper.
//
// This module is intentionally isolated from deterministic model inputs. It
// only validates a caller-supplied paragraph and never calls a provider or
// reads credentials. The returned content is editorial storyline text only and
// must not be fed into the MLB scoring engine or any board/price layer.

import { assertNoPriceFields } from './projection-contracts.mjs';

const UNCERTAINTY_PHRASES = [
  'uncertain',
  'unconfirmed',
  'not confirmed',
  'pending',
  'remains unclear',
  'if confirmed',
];

function wordCount(text) {
  const words = String(text ?? '').trim().match(/\S+/g);
  return words ? words.length : 0;
}

export function validateEditorialParagraph(text) {
  const paragraph = typeof text === 'string' ? text.trim() : '';
  const reasons = [];
  const count = wordCount(paragraph);

  if (count < 120 || count > 170) reasons.push('word_count_out_of_range');

  const lines = paragraph ? paragraph.split(/\r?\n/) : [];
  if (lines.some((line) => /^(-|\*|•|\d+\.)\s*/.test(line.trim()))) {
    reasons.push('bullet_lines_not_allowed');
  }

  if (!/\[[0-9]+\]|https?:\/\/\S+/i.test(paragraph)) {
    reasons.push('citation_missing');
  }

  if (!UNCERTAINTY_PHRASES.some((phrase) => new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(paragraph))) {
    reasons.push('uncertainty_phrase_missing');
  }

  return {
    ok: reasons.length === 0,
    word_count: count,
    reasons,
  };
}

export async function buildEditorialContext({ promptContext, fetchParagraph } = {}) {
  let paragraph = null;
  let reasons = [];

  try {
    if (typeof fetchParagraph !== 'function') {
      reasons = ['fetchParagraph_missing'];
    } else {
      paragraph = await fetchParagraph(promptContext);
      const validation = validateEditorialParagraph(paragraph);
      if (validation.ok) {
        const result = {
          status: 'ok',
          kind: 'editorial_storyline',
          paragraph: typeof paragraph === 'string' ? paragraph.trim() : paragraph,
          word_count: validation.word_count,
          citations_present: true,
        };
        assertNoPriceFields(result, 'editorial context result');
        return result;
      }
      reasons = validation.reasons;
    }
  } catch (error) {
    reasons = [error instanceof Error ? error.message : String(error)];
  }

  const blocked = {
    status: 'blocked',
    kind: 'editorial_storyline',
    paragraph: null,
    reasons,
  };
  assertNoPriceFields(blocked, 'editorial context result');
  return blocked;
}

