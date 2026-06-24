import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateEditorialParagraph,
  buildEditorialContext,
} from '../scripts/mlb/lib/mlb-editorial.mjs';

const GOOD_PARAGRAPH = [
  'The division race remains interesting because the lineup report is partial and the starter timing is not confirmed, which leaves the story incomplete [1].',
  'Even so, several hitters are trending back, and the injury notes suggest progress, but the timing is uncertain and still needs another checkpoint.',
  'If confirmed, the projected order should improve contact quality, yet the bullpen workload and the weather window remain pending before anyone calls it settled.',
  'That uncertainty matters because a late scratch or a small shift in park conditions can change how the entire slate should be read.',
  'For that reason, the editorial frame should stay restrained, specific, and clearly provisional, with the latest context carried through to the end.',
  'Readers should treat the note as storyline guidance, not a verdict, until the next update arrives at https://example.com/report and the picture becomes clearer.',
].join(' ');

test('mocked editorial paragraph validates and builds an ok context', async () => {
  const validation = validateEditorialParagraph(GOOD_PARAGRAPH);
  assert.equal(validation.ok, true, validation.reasons.join(', '));
  assert.ok(validation.word_count >= 120 && validation.word_count <= 170, `word count: ${validation.word_count}`);

  let receivedPromptContext = null;
  const result = await buildEditorialContext({
    promptContext: { scope: 'MLB', topic: 'division race' },
    fetchParagraph: async (promptContext) => {
      receivedPromptContext = promptContext;
      return GOOD_PARAGRAPH;
    },
  });

  assert.deepEqual(receivedPromptContext, { scope: 'MLB', topic: 'division race' });
  assert.equal(result.status, 'ok');
  assert.equal(result.kind, 'editorial_storyline');
  assert.equal(result.paragraph, GOOD_PARAGRAPH);
  assert.equal(result.citations_present, true);
  assert.equal(result.word_count, validation.word_count);
});

test('invalid editorial paragraphs block cleanly and never fabricate content', async () => {
  const cases = [
    {
      name: 'bullets',
      text: '- first bullet line [1] uncertain\n- second bullet line',
      expected: 'bullet_lines_not_allowed',
    },
    {
      name: 'short',
      text: 'Too short to be useful [1] and still uncertain.',
      expected: 'word_count_out_of_range',
    },
    {
      name: 'long',
      text: `${GOOD_PARAGRAPH} ${GOOD_PARAGRAPH} Extra context remains unclear [1] because the situation is still pending and the additional wording pushes the paragraph over the allowed maximum.`,
      expected: 'word_count_out_of_range',
    },
    {
      name: 'no citation',
      text: GOOD_PARAGRAPH.replace('[1]', 'the reference').replace('https://example.com/report', 'reference text'),
      expected: 'citation_missing',
    },
    {
      name: 'no uncertainty',
      text: GOOD_PARAGRAPH.replace(/uncertain|unconfirmed|not confirmed|pending|remains unclear|if confirmed/gi, 'clear'),
      expected: 'uncertainty_phrase_missing',
    },
  ];

  for (const c of cases) {
    const validation = validateEditorialParagraph(c.text);
    assert.equal(validation.ok, false, `${c.name} should fail validation`);
    assert.ok(validation.reasons.includes(c.expected), `${c.name} reasons: ${validation.reasons.join(', ')}`);

    const result = await buildEditorialContext({
      promptContext: { case: c.name },
      fetchParagraph: async () => c.text,
    });

    assert.equal(result.status, 'blocked', `${c.name} should block`);
    assert.equal(result.kind, 'editorial_storyline');
    assert.equal(result.paragraph, null);
    assert.ok(result.reasons.length > 0, `${c.name} should report reasons`);
    assert.doesNotThrow(() => JSON.stringify(result));
  }
});
