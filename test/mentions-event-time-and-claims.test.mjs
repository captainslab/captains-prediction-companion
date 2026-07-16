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

test('market ceiling fields never become an event start time', () => {
  const presentation = resolveMentionPresentationMetadata({ date: DATE, event: agreeingCeilingEvent() });
  assert.equal(presentation.blocked, false);
  assert.equal(presentation.event_date, null);
  assert.equal(presentation.event_time_iso, null);
});

test('rendered Netflix packet header shows the sub_title-derived DATE_WINDOW, never Dec 31', () => {
  // Ticker/series/settlement-source are all present on this fixture — the
  // ambiguous expiration sentinels (close/expiration/occurrence, which never
  // become event start timing) don't matter here because the event's own
  // sub_title ("On Jul 2, 2026") independently confirms a DATE_WINDOW. Even
  // where that weren't true, a pure timing/provenance gap (no identity risk)
  // must not block an otherwise-valid packet. Either way the header must
  // never fabricate the Dec 31 expiration sentinel as the event start.
  const built = buildKalshiEventPacket({ date: DATE, event: netflixStyleEvent(), sourceUrl: '/tmp/src.json' });
  assert.equal(built.publication_blocked, false);
  assert.equal(built.synthesisInput.canonical_event.event_time_central.status, 'DATE_WINDOW');
  assert.equal(built.synthesisInput.canonical_event.event_time_central.iso, '2026-07-02T00:00:00.000Z');
  const rendered = renderMentionPacket(built.synthesisInput, { generatedAtUtc: `${DATE}T00:00:00.000Z` });
  assert.match(rendered, /event_time_central: Jul 02, 2026 \(DATE_WINDOW\)/);
  assert.doesNotMatch(rendered, /Dec 31/);
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
