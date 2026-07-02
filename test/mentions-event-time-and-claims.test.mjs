import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveMentionPresentationMetadata,
} from '../scripts/mentions/qualification-risk.mjs';
import {
  sanitizeUnsupportedClaim,
  buildResearchTermNote,
} from '../scripts/mentions/mentions-research-perplexity.mjs';
import {
  buildKalshiEventPacket,
} from '../scripts/packets/generate-mentions-daily.mjs';
import { renderMentionPacket } from '../scripts/mentions/render-mention-packet.mjs';

const DATE = '2026-07-02';

// A Netflix-style earnings event: the market carries a far-future Dec 31
// expiration sentinel that disagrees with the near-term expected-expiration and
// occurrence fields. None of them is a trusted event-start time.
function netflixStyleEvent() {
  const market = (word, ticker) => ({
    ticker,
    event_ticker: 'KXEARNINGSMENTIONNFLX-26JUL02',
    title: 'What will Netflix say during their next earnings call?',
    yes_sub_title: word,
    no_sub_title: word,
    custom_strike: { Word: word },
    close_time: '2026-12-31T15:00:00Z',
    expiration_time: '2026-12-31T15:00:00Z',
    latest_expiration_time: '2026-12-31T15:00:00Z',
    expected_expiration_time: '2026-07-17T14:00:00Z',
    occurrence_datetime: '2026-07-02T14:00:00Z',
    yes_bid_dollars: '0.19',
    yes_ask_dollars: '0.93',
    rules_primary: `If Netflix says ${word} during the earnings call, resolves Yes.`,
    mention_profile: 'earnings_mentions',
  });
  return {
    event_ticker: 'KXEARNINGSMENTIONNFLX-26JUL02',
    title: 'What will Netflix say during their next earnings call?',
    sub_title: 'On Jul 2, 2026',
    series_ticker: 'KXEARNINGSMENTIONNFLX',
    settlement_sources: [
      { name: 'Netflix', url: 'https://ir.netflix.net/investor-news-and-events/event-details/2026/default.aspx' },
    ],
    markets: [
      market('Ad-Supported', 'KXEARNINGSMENTIONNFLX-26JUL02-AD'),
      market('KPop Demon Hunters', 'KXEARNINGSMENTIONNFLX-26JUL02-KPOP'),
      market('One Piece', 'KXEARNINGSMENTIONNFLX-26JUL02-ONE'),
    ],
  };
}

// A fixed-time event where every ceiling field AGREES on the real date.
function agreeingCeilingEvent() {
  return {
    event_ticker: 'KXPOLITICSMENTION-26JUL02',
    title: 'What will Jack Smith say during the show?',
    sub_title: 'MS NOW',
    series_ticker: 'KXPOLITICSMENTION',
    markets: [
      {
        ticker: 'KXPOLITICSMENTION-26JUL02-INDICT',
        event_ticker: 'KXPOLITICSMENTION-26JUL02',
        yes_sub_title: 'Indictment',
        close_time: '2026-07-17T14:00:00Z',
        expiration_time: '2026-07-17T14:00:00Z',
        expected_expiration_time: '2026-07-17T14:00:00Z',
        occurrence_datetime: '2026-07-17T14:00:00Z',
        rules_primary: 'If said, resolves Yes.',
        mention_profile: 'political_mentions',
      },
    ],
  };
}

test('Netflix-style far-future sentinel expiration does not become the event time (UNCONFIRMED)', () => {
  const presentation = resolveMentionPresentationMetadata({ date: DATE, event: netflixStyleEvent() });
  assert.equal(presentation.blocked, false, 'ceiling ambiguity must not fail-close the packet');
  assert.equal(presentation.event_time_iso, null, 'no trusted event-start time => null (UNCONFIRMED)');
  assert.notEqual(presentation.event_date, '2026-12-31');
});

test('agreeing ceiling fields resolve to the shared event date (no regression)', () => {
  const presentation = resolveMentionPresentationMetadata({ date: DATE, event: agreeingCeilingEvent() });
  assert.equal(presentation.blocked, false);
  assert.equal(presentation.event_date, '2026-07-17');
  assert.ok(String(presentation.event_time_iso).startsWith('2026-07-17'));
});

test('rendered Netflix packet header shows UNCONFIRMED, never Dec 31', () => {
  const built = buildKalshiEventPacket({ date: DATE, event: netflixStyleEvent(), sourceUrl: '/tmp/src.json' });
  assert.ok(!built.blocked, 'packet must not be blocked');
  assert.ok(built.synthesisInput, 'synthesis input must be produced');
  const text = renderMentionPacket(built.synthesisInput, { generatedAtUtc: '2026-07-02T21:47:00.000Z' });
  assert.match(text, /event_time_central: UNCONFIRMED/);
  assert.doesNotMatch(text, /Dec 31/);
  assert.doesNotMatch(text, /2026-12-31/);
  // settlement_sources URL is surfaced as the source link.
  assert.match(text, /ir\.netflix\.net/);
});

test('rendered Netflix packet never asserts an unsourced "not a Netflix title" claim', () => {
  const built = buildKalshiEventPacket({ date: DATE, event: netflixStyleEvent(), sourceUrl: '/tmp/src.json' });
  const text = renderMentionPacket(built.synthesisInput, { generatedAtUtc: '2026-07-02T21:47:00.000Z' });
  assert.doesNotMatch(text, /not a Netflix title/i);
  assert.doesNotMatch(text, /no known project/i);
});

test('sanitizeUnsupportedClaim strips unsourced title/partner claims', () => {
  const cases = [
    'Not a Netflix title; no known project under this name.',
    'Not a Netflix title; irrelevant to their content lineup.',
    'Not a Netflix partner; no direct collaboration mentioned.',
    'Irrelevant; Netflix has no NFL content or partnership.',
    'Not a Netflix title; unrelated to their content strategy.',
  ];
  for (const claim of cases) {
    assert.equal(
      sanitizeUnsupportedClaim(claim, { hasSourceSupport: false }),
      'No direct evidence in current packet research.',
      `should strip: ${claim}`,
    );
  }
});

test('sanitizeUnsupportedClaim keeps claims that have source support', () => {
  const claim = 'Not a Netflix title; irrelevant to their content lineup.';
  assert.equal(sanitizeUnsupportedClaim(claim, { hasSourceSupport: true }), claim);
});

test('sanitizeUnsupportedClaim leaves benign probability reasoning untouched', () => {
  const benign = [
    "Netflix consistently uses 'subscriber' in earnings calls.",
    "Common business term; may appear but not guaranteed.",
    "Netflix rarely uses these exact terms; focuses on 'price' generally.",
  ];
  for (const text of benign) {
    assert.equal(sanitizeUnsupportedClaim(text, { hasSourceSupport: false }), text);
  }
});

test('buildResearchTermNote sanitizes false title claim when there is no citation', () => {
  const note = buildResearchTermNote({
    phrase: 'KPop Demon Hunters',
    reason: 'Not a Netflix title; no known project under this name.',
    proofPct: 15,
    citations: [],
  });
  assert.ok(note, 'note should still be produced');
  assert.equal(note.catalyst, 'No direct evidence in current packet research.');
});

test('buildResearchTermNote keeps a sourced claim intact', () => {
  const note = buildResearchTermNote({
    phrase: 'One Piece',
    reason: 'Not a Netflix title; irrelevant to their content lineup.',
    proofPct: 15,
    citations: ['https://example.com/source'],
  });
  assert.ok(note);
  assert.match(note.catalyst, /Not a Netflix title/);
});
