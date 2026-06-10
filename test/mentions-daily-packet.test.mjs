import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildKalshiEventPacket, loadMentionResearch } from '../scripts/packets/generate-mentions-daily.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function strongEarningsEvent() {
  return {
    event_ticker: 'KXDELLMENTION-99JAN01',
    title: 'Will Dell mention PowerEdge on its earnings call?',
    sub_title: 'Dell earnings call',
    series_ticker: 'KXDELLMENTION',
    markets: [
      {
        ticker: 'KXDELLMENTION-99JAN01-POWEREDGE',
        title: 'Will Dell mention PowerEdge?',
        yes_sub_title: 'PowerEdge',
        no_sub_title: 'No',
        close_time: '2099-01-01T23:00:00Z',
        expected_expiration_time: '2099-01-01T23:00:00Z',
        yes_bid_dollars: '0.57',
        yes_ask_dollars: '0.61',
        no_bid_dollars: '0.39',
        no_ask_dollars: '0.43',
        last_price_dollars: '0.59',
        liquidity_dollars: '1200.00',
        volume_fp: '11442',
        open_interest_fp: '300',
        rules_primary: 'If Dell says PowerEdge during the earnings call, this market resolves Yes.',
        mention_profile: 'earnings_mentions',
        layer_records: {
          event_proximity: {
            present: true,
            score: 95,
            source_basis: 'official IR calendar confirms Dell earnings call before market close',
          },
          historical_tendency: {
            present: true,
            score: 90,
            source_basis: 'closed-event calendar: 5/6 prior Dell earnings calls resolved YES',
          },
          prepared_remarks_likelihood: {
            present: true,
            score: 88,
            source_basis: 'prior prepared remarks repeatedly use PowerEdge in server discussion',
          },
          sec_filing_language: {
            present: true,
            score: 80,
            source_basis: 'SEC filing language includes PowerEdge in segment discussion',
          },
        },
      },
    ],
  };
}

test('mentions daily packet renders mention-composite scoring instead of WATCH-only posture', () => {
  // Refactored to the compact sectioned decision board. Same guarantee:
  // a source-backed composite produces an actual scored PICK row (not WATCH-only),
  // with the composite score, posture, and layer coverage surfaced.
  const built = buildKalshiEventPacket({
    date: '2099-01-01',
    event: strongEarningsEvent(),
    sourceUrl: '/tmp/dell-mentions.json',
  });
  const text = built.text;

  // sectioned board, not the old YAML wall
  assert.match(text, /TLDR BOARD:/);
  assert.match(text, /TOP EDGE CANDIDATES/);
  // composite scoring surfaced: PICK posture, real score, layer coverage
  assert.match(text, /\[PICK\]/);
  assert.match(text, /PowerEdge/);
  assert.match(text, /score=90/);
  assert.match(text, /posture=PICK/);
  assert.match(text, /layers=4\/10/);
  // why-line carries the present + missing layers
  assert.match(text, /event_proximity=95/);
  assert.match(text, /Missing:/);
  // strong source-backed market is NOT downgraded to a generic WATCH-only posture
  assert.doesNotMatch(text, /posture=WATCH/);
});

test('mentions daily packet keeps market context only in NOT IN SCORE section', () => {
  const text = buildKalshiEventPacket({
    date: '2099-01-01',
    event: strongEarningsEvent(),
    sourceUrl: '/tmp/dell-mentions.json',
  }).text;

  // Explicit neutrality statement: market price is never a composite input.
  assert.match(text, /NEVER a composite input/);

  // Pricing (bid/ask/last) appears ONLY on the `market:` line, never on the
  // `model:` / `why:` composite lines.
  for (const line of text.split('\n')) {
    const isModelLine = /^\s*(model:|why:)/.test(line);
    if (isModelLine) {
      for (const term of ['yes_bid', 'yes_ask', 'last=', 'implied=']) {
        assert.ok(!line.includes(term), `composite line must not contain pricing token ${term}: ${line}`);
      }
    }
  }
  // Pricing is present, but on the market half.
  assert.match(text, /market: implied=.*yes_bid=57 yes_ask=61 last=59/);
});

test('mentions daily packet preserves all mention composite profiles', () => {
  const event = {
    event_ticker: 'KXMENTIONPROFILES-99JAN01',
    title: 'Mention profile coverage',
    sub_title: 'Profile smoke test',
    series_ticker: 'KXMENTIONPROFILES',
    markets: [
      {
        ticker: 'KXMENTIONPROFILES-POL',
        title: 'Will the speaker say tariff?',
        yes_sub_title: 'tariff',
        no_sub_title: 'No',
        mention_profile: 'political_mentions',
        layer_records: {
          event_proximity: { present: true, score: 80, source_basis: 'official speech schedule confirmed' },
        },
      },
      {
        ticker: 'KXMENTIONPROFILES-EARN',
        title: 'Will the company say revenue?',
        yes_sub_title: 'revenue',
        no_sub_title: 'No',
        mention_profile: 'earnings_mentions',
        layer_records: {
          event_proximity: { present: true, score: 80, source_basis: 'official earnings call schedule confirmed' },
        },
      },
      {
        ticker: 'KXMENTIONPROFILES-SPORT',
        title: 'Will the announcer say rivalry?',
        yes_sub_title: 'rivalry',
        no_sub_title: 'No',
        mention_profile: 'sports_announcer_mentions',
        layer_records: {
          event_proximity: { present: true, score: 80, source_basis: 'official broadcast schedule confirmed' },
        },
      },
    ],
  };

  const text = buildKalshiEventPacket({
    date: '2099-01-01',
    event,
    sourceUrl: '/tmp/profile-mentions.json',
  }).text;

  // All three profile markets render in the board (profile routing preserved).
  assert.match(text, /KXMENTIONPROFILES-POL/);
  assert.match(text, /tariff/);
  assert.match(text, /KXMENTIONPROFILES-EARN/);
  assert.match(text, /revenue/);
  assert.match(text, /KXMENTIONPROFILES-SPORT/);
  assert.match(text, /rivalry/);
});

test('mentions packet generator preserves forbidden pricing field guard in layer records', () => {
  const event = strongEarningsEvent();
  event.markets[0].layer_records.event_proximity.yes_bid = 57;
  assert.throws(
    () => buildKalshiEventPacket({
      date: '2099-01-01',
      event,
      sourceUrl: '/tmp/dell-mentions.json',
    }),
    /forbidden pricing field "yes_bid"/i,
  );
});

// ---------------------------------------------------------------------------
// Research-artifact wiring: layer_records from state/mentions/<date>/research/
// must reach the composite scorer for live Kalshi markets (2026-06-10 repair).
// ---------------------------------------------------------------------------

test('buildKalshiEventPacket merges research map records so markets score instead of staying BLOCKED', () => {
  const event = {
    event_ticker: 'KXTESTMENTION-26JUN10',
    series_ticker: 'KXTESTMENTION',
    title: 'What will the speaker say during the test hearing?',
    markets: [
      {
        ticker: 'KXTESTMENTION-26JUN10-ALPHA',
        event_ticker: 'KXTESTMENTION-26JUN10',
        title: 'What will the speaker say during the test hearing?',
        yes_sub_title: 'Alpha',
        no_sub_title: 'Alpha',
        custom_strike: { Word: 'Alpha' },
        rules_primary: 'Resolves YES if the speaker says Alpha during the hearing.',
        close_time: '2026-06-25T14:00:00Z',
      },
      {
        ticker: 'KXTESTMENTION-26JUN10-BETA',
        event_ticker: 'KXTESTMENTION-26JUN10',
        title: 'What will the speaker say during the test hearing?',
        yes_sub_title: 'Beta',
        no_sub_title: 'Beta',
        custom_strike: { Word: 'Beta' },
        rules_primary: 'Resolves YES if the speaker says Beta during the hearing.',
        close_time: '2026-06-25T14:00:00Z',
      },
    ],
  };
  const research = new Map([
    ['KXTESTMENTION-26JUN10-ALPHA', {
      mention_profile: 'political_mentions',
      layer_records: {
        baseline_relevance: { present: true, score: 90, source_basis: 'official agenda names Alpha', source_path: 'https://example.gov/agenda' },
        event_proximity: { present: true, score: 95, source_basis: 'hearing confirmed today', source_path: 'https://example.gov/schedule' },
        evidence_quality: { present: true, score: 85, source_basis: 'primary sources' },
      },
    }],
  ]);

  const built = buildKalshiEventPacket({
    date: '2026-06-10',
    event,
    sourceUrl: 'state/mentions/2026-06-10/kalshi-events/KXTESTMENTION-26JUN10.json',
    inventoryPath: '2026-06-10-KXTESTMENTION-26JUN10.inventory.txt',
    research,
  });

  // Researched market scores; un-researched market stays BLOCKED.
  assert.match(built.inventoryText, /KXTESTMENTION-26JUN10-ALPHA :: Alpha \| score=9\d posture=PICK layers=3\//);
  assert.match(built.inventoryText, /\[BLOCKED\] KXTESTMENTION-26JUN10-BETA :: Beta \| score=null/);
  // Contract labels come from the phrase, not the shared event title.
  assert.doesNotMatch(built.inventoryText, /:: What will the speaker say/);
  assert.equal(built.compositeSummary.scored_count, 1);
});

test('loadMentionResearch reads per-event and per-market research files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mention-research-'));
  try {
    const researchDir = join(dir, 'mentions', '2026-06-10', 'research');
    mkdirSync(researchDir, { recursive: true });
    writeFileSync(join(researchDir, 'event.json'), JSON.stringify({
      event_ticker: 'KXTESTMENTION-26JUN10',
      markets: { 'KXTESTMENTION-26JUN10-ALPHA': { layer_records: { baseline_relevance: { present: true, score: 80 } } } },
    }));
    writeFileSync(join(researchDir, 'single.json'), JSON.stringify({
      market_ticker: 'KXTESTMENTION-26JUN10-BETA',
      layer_records: { baseline_relevance: { present: true, score: 70 } },
    }));
    const map = loadMentionResearch(dir, '2026-06-10');
    assert.equal(map.size, 2);
    assert.ok(map.get('KXTESTMENTION-26JUN10-ALPHA'));
    assert.ok(map.get('KXTESTMENTION-26JUN10-BETA'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
