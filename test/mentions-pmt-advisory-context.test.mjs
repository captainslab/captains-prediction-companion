import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPmtAdvisoryContext } from '../scripts/mentions/pmt-advisory-context.mjs';
import {
  buildKalshiEventPacket,
} from '../scripts/packets/generate-mentions-daily.mjs';
import {
  renderMentionPacket,
  validateRenderedPacket,
} from '../scripts/mentions/render-mention-packet.mjs';

function trumpFixture() {
  return {
    event_ticker: 'KXTRUMPMENTION-26JUN15',
    series_ticker: 'KXTRUMPMENTION',
    title: 'What will Trump say this week?',
    sub_title: 'Donald Trump - weekly mention',
    close_time: '2026-06-15T18:00:00Z',
    markets: [
      {
        ticker: 'KXTRUMPMENTION-26JUN15-TARIFF',
        title: 'What will Donald Trump say this week?',
        yes_sub_title: 'Tariff',
        custom_strike: 'Tariff',
        rules_primary: 'Resolves YES if Trump says tariff this week.',
        mention_profile: 'political_mentions',
        layer_records: {
          event_proximity: { present: true, score: 82, source_basis: 'official schedule' },
          historical_tendency: { present: true, score: 74, source_basis: 'prior transcript history' },
          direct_mention_pathway: { present: true, score: 71, source_basis: 'exact phrase path' },
        },
      },
    ],
  };
}

function nonTrumpFixture() {
  return {
    event_ticker: 'KXBIDENMENTION-26JUN15',
    series_ticker: 'KXBIDENMENTION',
    title: 'What will Biden say this week?',
    sub_title: 'Joe Biden - weekly mention',
    close_time: '2026-06-15T18:00:00Z',
    markets: [
      {
        ticker: 'KXBIDENMENTION-26JUN15-TARIFF',
        title: 'What will Joe Biden say this week?',
        yes_sub_title: 'Tariff',
        custom_strike: 'Tariff',
        rules_primary: 'Resolves YES if Biden says tariff this week.',
        mention_profile: 'political_mentions',
        layer_records: {
          event_proximity: { present: true, score: 82, source_basis: 'official schedule' },
          historical_tendency: { present: true, score: 74, source_basis: 'prior transcript history' },
          direct_mention_pathway: { present: true, score: 71, source_basis: 'exact phrase path' },
        },
      },
    ],
  };
}

function stripPmtContext(input) {
  const clone = JSON.parse(JSON.stringify(input));
  if (clone.research_provenance) {
    delete clone.research_provenance.pmt_advisory_context;
  }
  for (const term of clone.terms ?? []) {
    delete term.pmt_advisory_context;
  }
  return clone;
}

function sectionBlock(text, start, end) {
  const afterStart = text.split(start)[1] ?? '';
  return end ? afterStart.split(end)[0] : afterStart;
}

test('Trump routes receive PMT advisory context and the context is price-free', () => {
  const context = buildPmtAdvisoryContext({ route: 'trump_event', eventTitle: 'What will Trump say this week?' });
  assert.ok(context);
  assert.equal(context.route, 'trump_event');
  assert.equal(context.route_horizon, 'event');
  assert.equal(context.scope, 'advisory-only');
  assert.match(context.coverage_note, /first-pass transcript mining only/);
  assert.match(context.event_format_prior, /Event format comes first/);
  assert.match(context.exact_wording_settlement_fit, /Exact payout text governs settlement/);
  assert.match(context.nt_no_edge_guidance, /NT \/ skip remains valid/);
  assert.doesNotMatch(JSON.stringify(context), /\b(?:price|odds|bid|ask|volume|open_interest|liquidity|spread|market movement)\b/i);
  assert.equal(buildPmtAdvisoryContext({ route: 'political_general' }), null);
});

test('Trump mention packets thread PMT advisory context into synthesis input; non-Trump packets do not', () => {
  const trump = buildKalshiEventPacket({
    date: '2026-06-15',
    event: trumpFixture(),
    sourceUrl: '/tmp/trump.json',
  });
  assert.ok(trump.synthesisInput.research_provenance?.pmt_advisory_context);
  assert.ok(trump.synthesisInput.terms.every((term) => term.pmt_advisory_context));

  const nonTrump = buildKalshiEventPacket({
    date: '2026-06-15',
    event: nonTrumpFixture(),
    sourceUrl: '/tmp/biden.json',
  });
  assert.ok(!nonTrump.synthesisInput.research_provenance?.pmt_advisory_context);
  assert.ok(nonTrump.synthesisInput.terms.every((term) => !term.pmt_advisory_context));
});

test('PMT advisory context renders in a deterministic packet block for Trump only', () => {
  const trump = buildKalshiEventPacket({
    date: '2026-06-15',
    event: trumpFixture(),
    sourceUrl: '/tmp/trump.json',
  });
  const text = renderMentionPacket(trump.synthesisInput, { generatedAtUtc: '2026-06-15T18:00:00Z' });
  validateRenderedPacket(text, trump.synthesisInput);
  assert.match(text, /PMT ADVISORY CONTEXT/);
  assert.match(text, /event format prior: /);
  assert.match(text, /current news shock: /);
  assert.match(text, /exact wording \/ settlement fit: /);
  assert.match(text, /NT \/ no-edge guidance: /);

  const nonTrump = buildKalshiEventPacket({
    date: '2026-06-15',
    event: nonTrumpFixture(),
    sourceUrl: '/tmp/biden.json',
  });
  const nonTrumpText = renderMentionPacket(nonTrump.synthesisInput, { generatedAtUtc: '2026-06-15T18:00:00Z' });
  validateRenderedPacket(nonTrumpText, nonTrump.synthesisInput);
  assert.doesNotMatch(nonTrumpText, /PMT ADVISORY CONTEXT/);
});

test('PMT advisory context does not mutate score, posture, or ranking sections', () => {
  const trump = buildKalshiEventPacket({
    date: '2026-06-15',
    event: trumpFixture(),
    sourceUrl: '/tmp/trump.json',
  });
  const renderedWithContext = renderMentionPacket(trump.synthesisInput, { generatedAtUtc: '2026-06-15T18:00:00Z' });
  const renderedWithoutContext = renderMentionPacket(stripPmtContext(trump.synthesisInput), { generatedAtUtc: '2026-06-15T18:00:00Z' });

  assert.equal(
    sectionBlock(renderedWithContext, '2. TOP YES CASE', '5. SOURCE GAPS'),
    sectionBlock(renderedWithoutContext, '2. TOP YES CASE', '5. SOURCE GAPS'),
    'card ranking and score sections stay identical when advisory context is removed',
  );
});
