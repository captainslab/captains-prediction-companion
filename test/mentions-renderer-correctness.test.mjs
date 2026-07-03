import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveResearchRoute } from '../scripts/mentions/mention-route-resolver.mjs';
import { classifyEdnqRisk } from '../scripts/mentions/qualification-risk.mjs';
import { renderMentionPacket } from '../scripts/mentions/render-mention-packet.mjs';

const NOW = new Date('2026-06-22T12:00:00Z');

// Wording that must NEVER leak into a non-Trump / non-political packet.
const TRUMP_LEAK_RE = /\btrump\b|foreign[- ]leader|pool spray|working lunch|bilateral/i;

function worldCupEvent() {
  return {
    event_ticker: 'KXWCMENTION-26JUN22NORSEN',
    series_ticker: 'KXWCMENTION',
    title: 'What word will be said during Norway vs Senegal?',
    sub_title: 'World Cup group stage — Norway vs Senegal',
    markets: [
      {
        ticker: 'KXWCMENTION-26JUN22NORSEN-GOAL',
        title: 'Will "goal" be said?',
        yes_sub_title: 'goal',
        rules_primary: 'If "goal" is said during the World Cup match, resolves Yes.',
        close_time: '2026-06-22T20:00:00Z',
        expected_expiration_time: '2026-06-22T20:00:00Z',
      },
    ],
  };
}

function wesMooreEvent() {
  return {
    event_ticker: 'KXWESMOOREMENTION-26JUN22',
    series_ticker: 'KXWESMOOREMENTION',
    title: 'What will Governor Wes Moore say during his press conference?',
    sub_title: 'Wes Moore - Maryland governor press conference',
    markets: [
      {
        ticker: 'KXWESMOOREMENTION-26JUN22-JOBS',
        title: 'jobs',
        yes_sub_title: 'jobs',
        rules_primary: 'If Wes Moore says jobs during the press conference, resolves Yes.',
        close_time: '2026-06-22T20:00:00Z',
      },
    ],
  };
}

function cordenEvent() {
  return {
    event_ticker: 'KXCORDENMENTION-26JUN22',
    series_ticker: 'KXCORDENMENTION',
    title: 'What will James Corden say during the show?',
    sub_title: 'James Corden - late night talk show',
    markets: [
      {
        ticker: 'KXCORDENMENTION-26JUN22-CAR',
        title: 'carpool',
        yes_sub_title: 'carpool',
        rules_primary: 'If James Corden says carpool during the late night talk show, resolves Yes.',
        close_time: '2026-06-22T20:00:00Z',
      },
    ],
  };
}

// ---- Routing --------------------------------------------------------------

test('World Cup mention event routes to sports_announcer, never political_general', () => {
  const res = resolveResearchRoute(worldCupEvent(), { now: NOW });
  assert.equal(res.route, 'sports_announcer');
  assert.equal(res.profile_key, 'sports_announcer_mentions');
  assert.notEqual(res.route, 'political_general');
});

test('James Corden mention event routes to talk_show_media, never political_general', () => {
  const res = resolveResearchRoute(cordenEvent(), { now: NOW });
  assert.equal(res.route, 'talk_show_media');
  assert.notEqual(res.route, 'political_general');
});

test('Wes Moore (governor) routes to political_general via political evidence, not the blind default', () => {
  const res = resolveResearchRoute(wesMooreEvent(), { now: NOW });
  assert.equal(res.route, 'political_general');
  // Must be matched on real political evidence, not the mystery fallback.
  assert.notEqual(res.basis, 'default_political_general');
});

test('mystery keyword event still falls back to political_general (no regression)', () => {
  const res = resolveResearchRoute({
    event_ticker: 'KXMYSTERYMENTION-26JUN22',
    series_ticker: 'KXMYSTERYMENTION',
    title: 'Will the keyword be said?',
  }, { now: NOW });
  assert.equal(res.route, 'political_general');
  assert.equal(res.basis, 'default_political_general');
});

// ---- EDNQ wording is route-specific, never Trump-global --------------------

function ednqFor(event) {
  const res = resolveResearchRoute(event, { now: NOW });
  return classifyEdnqRisk({ event, researchRoute: res.route, qualificationTerms: [] });
}

test('earnings EDNQ wording carries no Trump/foreign-leader language', () => {
  const ednq = ednqFor({
    event_ticker: 'KXEARNINGSMENTIONNFLX-26JUL02',
    series_ticker: 'KXEARNINGSMENTIONNFLX',
    title: 'What will Netflix say during their next earnings call?',
    sub_title: 'On Jul 2, 2026',
    markets: [{ title: 'One Piece', yes_sub_title: 'One Piece', rules_primary: 'If Netflix says One Piece during the earnings call, resolves Yes.' }],
  });
  const blob = [...ednq.why_ednq, ...ednq.current_check, ednq.historical_note, ednq.event_type].join(' ');
  assert.doesNotMatch(blob, TRUMP_LEAK_RE, `earnings EDNQ wording leaked Trump/politics text: ${blob}`);
  assert.match(blob, /earnings|call/i);
});

test('sports EDNQ wording carries no Trump/foreign-leader language', () => {
  const ednq = ednqFor(worldCupEvent());
  const blob = [...ednq.why_ednq, ...ednq.current_check, ednq.historical_note, ednq.event_type].join(' ');
  assert.doesNotMatch(blob, TRUMP_LEAK_RE, `sports EDNQ wording leaked Trump/politics text: ${blob}`);
  assert.match(blob, /match|broadcast/i);
});

test('talk-show EDNQ wording carries no Trump/foreign-leader language', () => {
  const ednq = ednqFor(cordenEvent());
  const blob = [...ednq.why_ednq, ...ednq.current_check, ednq.historical_note, ednq.event_type].join(' ');
  assert.doesNotMatch(blob, TRUMP_LEAK_RE, `talk-show EDNQ wording leaked Trump/politics text: ${blob}`);
  assert.match(blob, /show|segment|broadcast|episode/i);
});

test('non-Trump political (Wes Moore) EDNQ wording never names Trump', () => {
  const ednq = ednqFor(wesMooreEvent());
  const blob = [...ednq.why_ednq, ...ednq.current_check, ednq.historical_note].join(' ');
  assert.doesNotMatch(blob, /\btrump\b/i, `Wes Moore EDNQ wording named Trump: ${blob}`);
  assert.doesNotMatch(ednq.historical_note, /foreign[- ]leader|working lunch/i);
});

test('Trump event EDNQ wording is unchanged (retains qualifying-remarks framing)', () => {
  const ednq = classifyEdnqRisk({
    event: {
      title: 'What will Trump say during his working lunch with foreign leaders?',
      sub_title: 'Donald Trump - multi-party working lunch',
    },
    researchRoute: 'trump_event',
    qualificationTerms: [{ is_qualification_term: true, full_strike_text: 'Event does not qualify' }],
  });
  assert.equal(ednq.cpc_read, 'high');
  assert.match(ednq.why_ednq.join(' '), /foreign-leader|working lunch|multi-party/i);
  assert.match(ednq.historical_note, /limited and not exhaustive/i);
});

// ---- Rendered Netflix packet: no Trump leak, source-specific settlement ----

function netflixSynthesisInput() {
  return {
    packet_kind: 'mentions_customer_packet_v2',
    date: '2026-07-02',
    research_provenance: { research_route: 'earnings_call' },
    event: {
      title: 'What will Netflix say during their next earnings call?',
      subtitle: 'Netflix earnings call',
      settlement_source_link: 'https://ir.netflix.net/investor-news-and-events/event-details/2026/default.aspx',
      rules_primary: 'If Netflix says the strike term during the earnings call, resolves Yes.',
    },
    summary: { market_count: 2 },
    terms: [
      { full_strike_text: 'Netflix earnings -- subscriber', short_term: 'subscriber', cpc_score: 66, research_state: 'research-backed', market_context: { note: 'NOT IN SCORE' } },
      { full_strike_text: 'Netflix earnings -- One Piece', short_term: 'One Piece', cpc_score: 20, research_state: 'research-backed', market_context: { note: 'NOT IN SCORE' } },
    ],
  };
}

test('rendered Netflix earnings packet has no Trump/foreign-leader wording anywhere', () => {
  const text = renderMentionPacket(netflixSynthesisInput(), { generatedAtUtc: '2026-07-02T21:47:00.000Z' });
  assert.doesNotMatch(text, TRUMP_LEAK_RE, 'Netflix earnings packet leaked Trump/politics EDNQ wording');
});

test('rendered packet surfaces a source-specific settlement link and never a fake ABC fallback', () => {
  const text = renderMentionPacket(netflixSynthesisInput(), { generatedAtUtc: '2026-07-02T21:47:00.000Z' });
  assert.match(text, /settlement_source: https:\/\/ir\.netflix\.net/);
  assert.doesNotMatch(text, /abcnews\.go\.com/i);
});

// ---- Evidence labels distinguish current / historical / generic / weak -----

function labelInput(term) {
  return {
    packet_kind: 'mentions_customer_packet_v2',
    date: '2026-06-22',
    research_provenance: { research_route: 'earnings_call' },
    event: {
      title: 'Evidence label test',
      subtitle: 'evidence labels',
      settlement_source_link: 'https://kalshi.com/events/KXLABEL',
      rules_primary: 'If said, resolves Yes.',
    },
    summary: { market_count: 1 },
    terms: [term],
  };
}

function evidenceLineFor(term) {
  const text = renderMentionPacket(labelInput(term), { generatedAtUtc: NOW.toISOString() });
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => l.trim() === 'Evidence:');
  return idx >= 0 ? (lines[idx + 1] ?? '').trim() : '';
}

test('substantive current narrative is labelled as current-event context', () => {
  const label = evidenceLineFor({
    full_strike_text: 'Evidence label test -- Alpha',
    short_term: 'Alpha',
    cpc_score: 60,
    research_state: 'research-backed',
    research_term_note: { catalyst: 'Confirmed on the published agenda for the event.', settlement_fit: 'exact token', citations: [] },
    market_context: { note: 'NOT IN SCORE' },
  });
  assert.match(label, /current-event context/i);
});

test('weak/cold-context term is labelled no direct current context, not current evidence', () => {
  const label = evidenceLineFor({
    full_strike_text: 'Evidence label test -- Beta',
    short_term: 'Beta',
    cpc_score: 40,
    research_state: 'research-backed',
    research_term_note: { catalyst: 'Not a focus of the event; no direct current context for this term.', settlement_fit: 'exact token', citations: [] },
    market_context: { note: 'NOT IN SCORE' },
  });
  assert.match(label, /no direct current context/i);
  assert.doesNotMatch(label, /current-event context \+/);
});

test('fast read does not overclaim terms as research-backed', () => {
  const text = renderMentionPacket(netflixSynthesisInput(), { generatedAtUtc: '2026-07-02T21:47:00.000Z' });
  const fastRead = text.split('2. TOP YES CASE')[0];
  assert.doesNotMatch(fastRead, /research-backed P\(YES\)/i);
});
