import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEventResearch } from '../scripts/mentions/collect-mentions-research.mjs';
import {
  buildKalshiEventPacket,
  mergeResearchIntoEvent,
} from '../scripts/packets/generate-mentions-daily.mjs';

function eventFixture() {
  return {
    event_ticker: 'KXTRUMPMENTION-26JUL16',
    series_ticker: 'KXTRUMPMENTION',
    title: 'What will Trump say during the Speech to the Nation?',
    sub_title: 'Donald Trump - Speech to the Nation',
    event_url: 'https://kalshi.com/events/KXTRUMPMENTION-26JUL16',
    settlement_sources: [{ url: 'https://abcnews.go.com/' }],
    markets: [{
      ticker: 'KXTRUMPMENTION-26JUL16-TARI',
      title: 'What will Trump say? -- Tariff',
      yes_sub_title: 'Tariff',
      rules_primary: 'Resolves YES if Trump says the term during the event.',
    }],
  };
}

test('research-entry assembly carries Firecrawl event timing and URL into the generator contract', async () => {
  const firecrawl = {
    async scrape() {
      return {
        markdown: 'Begins · Thu Jul 16, 8:00 pm CDT',
      };
    },
  };

  const research = await buildEventResearch(eventFixture(), 'political_mentions', {
    date: null,
    deps: { firecrawl },
  });

  assert.equal(research.event_time, '2026-07-17T01:00:00.000Z');
  assert.equal(research.event_time_utc, '2026-07-17T01:00:00.000Z');
  assert.equal(research.declared_source_url, 'https://kalshi.com/events/KXTRUMPMENTION-26JUL16');
  assert.deepEqual(research.declared_source_urls, []);

  const merged = mergeResearchIntoEvent(eventFixture(), research);
  const packet = buildKalshiEventPacket({
    date: '2026-07-16',
    event: merged,
    sourceUrl: '/tmp/event.json',
  });
  assert.equal(packet.synthesisInput.canonical_event.event_time_central.status, 'EXACT');
  assert.equal(packet.synthesisInput.canonical_event.declared_source_url, 'https://kalshi.com/events/KXTRUMPMENTION-26JUL16');
});

test('event-start lookup failure remains fail-closed at research assembly', async () => {
  const firecrawl = {
    async scrape() {
      throw new Error('firecrawl unavailable');
    },
  };

  const research = await buildEventResearch(eventFixture(), 'political_mentions', {
    date: null,
    deps: { firecrawl },
  });

  assert.equal(Object.hasOwn(research, 'event_time'), false);
  assert.equal(Object.hasOwn(research, 'event_time_utc'), false);
  assert.equal(research.declared_source_url, null);
});
