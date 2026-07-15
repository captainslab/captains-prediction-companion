// Kalshi-stated event date propagation -> DATE_WINDOW timing provenance.
//
// A confirmed calendar date stated in the event's OWN Kalshi metadata
// (sub_title/title), corroborated by the event ticker's date suffix, must be
// propagated into the timing contract as DATE_WINDOW — never fabricated as an
// instant, never sourced from close/expiration/occurrence fields, and never
// used when the two Kalshi signals disagree.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  kalshiStatedEventDate,
  attachConfirmedEventTiming,
} from '../scripts/packets/generate-mentions-daily.mjs';
import { canonicalEventTime } from '../scripts/mentions/event-integrity.mjs';

test('JNJ-style stated date corroborated by ticker -> DATE_WINDOW', () => {
  const event = {
    event_ticker: 'KXEARNINGSMENTIONJNJ-26JUL15',
    sub_title: 'On Jul 15, 2026',
    title: 'What will Johnson & Johnson say during their next earnings call?',
  };
  assert.equal(kalshiStatedEventDate(event), '2026-07-15');
  const timed = attachConfirmedEventTiming(event, 'earnings_call', {});
  assert.equal(timed.event_time, '2026-07-15');
  const ct = canonicalEventTime(timed);
  assert.equal(ct.status, 'DATE_WINDOW');
  assert.equal(ct.calendar_date, '2026-07-15');
});

test('ISO stated date form is accepted when it matches the ticker', () => {
  const event = { event_ticker: 'KXHEARINGMENTION-26JUL15', sub_title: 'Session on 2026-07-15' };
  assert.equal(kalshiStatedEventDate(event), '2026-07-15');
});

test('no stated date -> null, timing stays UNCONFIRMED', () => {
  const event = {
    event_ticker: 'KXTRUMPMENTION-26JUL15',
    sub_title: 'Donald Trump - Pennsylvania Defense and Innovation Summit',
    title: 'What will Trump say during the Defense and Innovation Summit?',
  };
  assert.equal(kalshiStatedEventDate(event), null);
  const timed = attachConfirmedEventTiming(event, 'trump_event', {});
  assert.equal(timed.event_time, undefined);
  assert.equal(canonicalEventTime(timed).status, 'UNCONFIRMED');
});

test('stated date NOT equal to ticker date -> null (fail closed)', () => {
  const event = { event_ticker: 'KXEARNINGSMENTIONJNJ-26JUL15', sub_title: 'On Jul 20, 2026' };
  assert.equal(kalshiStatedEventDate(event), null);
  assert.equal(canonicalEventTime(attachConfirmedEventTiming(event, 'earnings_call', {})).status, 'UNCONFIRMED');
});

test('close/expiration/occurrence are never a timing source', () => {
  const event = {
    event_ticker: 'KXTRUMPMENTION-26JUL15',
    sub_title: 'Donald Trump - Pennsylvania Defense and Innovation Summit',
    close_time: '2026-07-30T14:00:00Z',
    expiration_time: '2026-07-30T14:00:00Z',
    expected_expiration_time: '2026-07-30T14:00:00Z',
    occurrence_datetime: '2026-07-30T14:00:00Z',
  };
  assert.equal(kalshiStatedEventDate(event), null);
  const timed = attachConfirmedEventTiming(event, 'trump_event', {});
  assert.equal(timed.event_time, undefined);
  assert.equal(canonicalEventTime(timed).status, 'UNCONFIRMED');
});

test('missing ticker date -> null even with a stated date', () => {
  const event = { event_ticker: 'KXNOTADATED', sub_title: 'On Jul 15, 2026' };
  assert.equal(kalshiStatedEventDate(event), null);
});

test('existing EXACT start field is preserved (fallback does not override)', () => {
  const event = {
    event_ticker: 'KXEARNINGSMENTIONJNJ-26JUL15',
    sub_title: 'On Jul 15, 2026',
    event_time: '2026-07-15T13:30:00Z',
  };
  const timed = attachConfirmedEventTiming(event, 'earnings_call', {});
  assert.equal(timed.event_time, '2026-07-15T13:30:00Z');
  assert.equal(canonicalEventTime(timed).status, 'EXACT');
});
