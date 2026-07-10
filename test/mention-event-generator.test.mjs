import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  generateMentionEventPacket,
  parseMentionEventArgs,
  parseEventIdFromUrl,
} from '../scripts/packets/generate-mention-event.mjs';
import { validateCpcCustomerPacket } from '../scripts/packets/lib/cpc-packet-validator.mjs';
import { validatePacketText, DELIVERY_VERDICTS } from '../scripts/cron/cpc-packet-janitor.mjs';

const EVENT_URL = 'https://kalshi.com/markets/kxearningsmentionfdx/what-will-fedex-say-during-their-earnings-call/KXEARNINGSMENTIONFDX-26JUN23?utm_source=kalshiapp_eventpage';
const EVENT_ID = 'KXEARNINGSMENTIONFDX-26JUN23';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mention-event-generator-'));
}

function fedexKalshiEvent() {
  return {
    event: {
      event_ticker: EVENT_ID,
      series_ticker: 'KXEARNINGSMENTIONFDX',
      title: 'What will FedEx say during their next earnings call?',
      sub_title: 'On Jun 23, 2026',
      settlement_sources: [{ name: 'FedEx', url: 'https://investors.fedex.com/news-and-events/upcoming-events/default.aspx' }],
    },
    markets: [
      {
        ticker: `${EVENT_ID}-CHINA`,
        custom_strike: { Word: 'China' },
        rules_primary: 'If China is said by any FedEx Corporation representative (including the operator of the call) during the next FedEx Corporation earnings call (including the Q+A), then the market resolves to Yes.',
        yes_bid_dollars: '0.56',
        yes_ask_dollars: '0.57',
        volume_fp: '1234',
        open_interest_fp: '844.69',
      },
      {
        ticker: `${EVENT_ID}-TARIFFS`,
        custom_strike: { Word: 'Tariffs' },
        rules_primary: 'If Tariffs is said by any FedEx Corporation representative during the next FedEx Corporation earnings call, then the market resolves to Yes.',
        last_price_dollars: '0.22',
      },
    ],
  };
}

function fakePerplexityArtifact() {
  return {
    schema: 'cpc_research_artifact_v1',
    packet_family: 'mentions',
    packet_type: 'earnings-call-mention',
    route: 'earnings_call',
    submarket: 'event',
    event_id: EVENT_ID,
    market_id: EVENT_ID,
    event_url: EVENT_URL,
    generated_at: '2026-06-23T20:00:00Z',
    source_id: 'perplexity',
    source_urls: [
      'https://investors.fedex.com/home/default.aspx',
      'https://investors.fedex.com/news-and-events/upcoming-events/upcoming-events-details/2026/FedEx-Q4-FY26-Earnings-Call/default.aspx',
      'https://investors.fedex.com/news-and-events/webcasts-and-presentations/default.aspx',
      'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=FDX&owner=exclude&count=10',
    ],
    source_titles: [
      'Investor Relations | FedEx',
      'FedEx Q4 FY26 Earnings Call | FedEx',
      'Webcasts & presentations | FedEx',
      'EDGAR Search Results — FEDEX CORP',
    ],
    source_freshness: [
      { url: 'https://investors.fedex.com/home/default.aspx', published_at: 'unavailable', checked_at: '2026-06-23T20:00:00Z', freshness: 'same_day' },
      { url: 'https://investors.fedex.com/news-and-events/upcoming-events/upcoming-events-details/2026/FedEx-Q4-FY26-Earnings-Call/default.aspx', published_at: 'unavailable', checked_at: '2026-06-23T20:00:00Z', freshness: 'same_day' },
      { url: 'https://investors.fedex.com/news-and-events/webcasts-and-presentations/default.aspx', published_at: 'unavailable', checked_at: '2026-06-23T20:00:00Z', freshness: 'same_day' },
      { url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=FDX&owner=exclude&count=10', published_at: 'unavailable', checked_at: '2026-06-23T20:00:00Z', freshness: 'same_day' },
    ],
    confirmed_facts: [
      'FedEx investor relations lists the FedEx Q4 FY26 Earnings Call for Tuesday, June 23, 2026 at 4:00 PM CT.',
      'FedEx investor relations links a webcast for the Q4 FY26 earnings call.',
      'SEC EDGAR identifies FEDEX CORP, ticker FDX, CIK 0001048911, with fiscal year end 0531.',
      'FedEx investor relations lists prior FY26 earnings-call materials, including transcripts for earlier FY26 quarters.',
    ],
    unconfirmed_claims: [],
    unavailable_fields: ['executive_speakers', 'press_release_url', 'prepared_remarks_status', 'transcript_status'],
    model_safe_inputs: {
      company_identity: 'FedEx Corporation',
      ticker: 'FDX',
      fiscal_period: 'Q4 FY26',
      earnings_call_datetime: 'Tuesday, June 23, 2026 at 4:00 PM CT',
      executive_speakers: 'unavailable',
      press_release_url: 'unavailable',
      webcast_url: 'https://events.q4inc.com/attendee/858038331',
      sec_filing_urls: ['https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=FDX&owner=exclude&count=10'],
      prepared_remarks_status: 'unavailable',
      transcript_status: 'unavailable before or during the scheduled call; prior FY26 transcripts are listed, but the Q4 FY26 transcript was not sourced in this packet',
      prior_call_topics: ['prior FY26 earnings-call materials exist on FedEx investor relations; specific prior topic extraction not sourced in this packet'],
      current_guidance_topics: ['unavailable'],
      known_issues: ['unavailable'],
      current_catalysts: ['unavailable'],
      settlement_scope: 'If China is said by any FedEx Corporation representative (including the operator of the call) during the next FedEx Corporation earnings call (including the Q+A), then the market resolves to Yes.',
      strike_terms: ['China', 'Tariffs'],
      market_snapshot: { yes_bid: '0.56', volume: '1234' },
    },
    editorial_context: {
      management_focus: 'unavailable',
      continuity_vs_change: 'FedEx has prior FY26 earnings-call transcript materials listed, but Q4 prepared remarks/transcript were unavailable for this packet.',
      street_narrative: 'unavailable',
      sensitivity_topics: 'unavailable',
      why_this_quarter_matters: 'The market is tied to the next FedEx earnings call, and FedEx IR confirms the scheduled Q4 FY26 call.',
    },
    why_this_matters: 'This is a single-event earnings-call mention packet: settlement depends on exact words said during FedEx\'s next earnings call, not market prices or a daily-board ranking.',
    headline_candidates: ['FedEx Q4 FY26 earnings-call mention event'],
    risk_notes: ['Manual research packet, not a full daily mentions board.'],
  };
}

function perplexityImpl({ messages }) {
  assert.ok(messages.some((m) => /PERPLEXITY_API_KEY|Perplexity key/i.test(m.content)) === false, 'prompt must never contain key text');
  assert.ok(messages.some((m) => /FedEx|KXEARNINGSMENTIONFDX-26JUN23|earnings-call-mention/i.test(m.content)), 'prompt is anchored');
  assert.ok(messages.some((m) => /source_urls|source_titles|company_identity|ticker|transcript_status/i.test(m.content)), 'prompt requests required fields');
  return Promise.resolve({
    content: JSON.stringify(fakePerplexityArtifact()),
    citations: fakePerplexityArtifact().source_urls,
    search_results: fakePerplexityArtifact().source_urls.map((url, i) => ({ url, title: fakePerplexityArtifact().source_titles[i] })),
  });
}

test('parses FedEx event id from event URL and CLI args', () => {
  assert.equal(parseEventIdFromUrl(EVENT_URL), EVENT_ID);
  assert.deepEqual(parseMentionEventArgs(['--event-url', EVENT_URL, '--date', '2026-06-23', '--dry-run']).eventId, EVENT_ID);
});

test('manual FedEx earnings mention generator writes source-backed packet and bank without price leakage', async () => {
  const root = tempRoot();
  try {
    const result = await generateMentionEventPacket({
      eventUrl: EVENT_URL,
      eventId: EVENT_ID,
      date: '2026-06-23',
      stateRoot: root,
      dryRun: true,
      kalshiFetcher: async () => ({ ok: true, status: 200, json: fedexKalshiEvent(), error: null }),
      env: { PERPLEXITY_API_KEY: 'pplx-test-key' },
      perplexityImpl,
      now: () => '2026-06-23T20:00:00Z',
    });

    assert.equal(result.route.route, 'earnings_call');
    assert.equal(result.promptContract.packet_type, 'earnings-call-mention');
    assert.ok(fs.existsSync(result.packetPath));
    assert.ok(fs.existsSync(path.join(result.researchBankDir, 'sanitized.json')));
    assert.ok(result.sanitized.sanitized_removed.includes('market_snapshot'));
    assert.doesNotMatch(JSON.stringify(result.sanitized.model_safe_inputs), /yes_bid|yes_ask|last_price|volume|open_interest|market_snapshot/i);

    const text = fs.readFileSync(result.packetPath, 'utf8');
    assert.match(text, /CPC Packet: EARNINGS CALL MENTION EVENT/);
    assert.match(text, /route: earnings_call/);
    assert.match(text, /company: FedEx/);
    assert.match(text, /Market Context .+ NOT IN SCORE/i);
    assert.match(text, /manual research packet and not a full daily board/i);
    assert.doesNotMatch(text, /TRUMP/i);
    assert.doesNotMatch(text, /yes_bid|yes_ask|last_price|open_interest|market_snapshot|orderbook|liquidity/i);
    assert.doesNotMatch(text, /(?:^|\s)\/home\//);
    assert.doesNotMatch(text, /\.mjs/);
    assert.doesNotMatch(text, /\d{4}-\d\d-\d\dT\d\d:\d\d/);

    const contract = validateCpcCustomerPacket(text);
    assert.equal(contract.valid, true, contract.errors.join('; '));
    const janitor = validatePacketText(text, { packetType: 'mention-event', stateRoot: root, date: '2026-06-23', filePath: result.packetPath });
    assert.ok(
      [DELIVERY_VERDICTS.SEND_ALLOWED, DELIVERY_VERDICTS.JANITOR_WARNING].includes(janitor.verdict),
      JSON.stringify({ errors: janitor.errors, warnings: janitor.warnings }),
    );
    assert.equal(janitor.errors.length, 0, JSON.stringify(janitor.errors));
    assert.equal(result.priceIsolation.pass, true, JSON.stringify(result.priceIsolation.checks));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('manual FedEx earnings mention generator fails closed when Perplexity returns no attached sources', async () => {
  const root = tempRoot();
  try {
    await assert.rejects(
      () => generateMentionEventPacket({
        eventUrl: EVENT_URL,
        eventId: EVENT_ID,
        date: '2026-06-23',
        stateRoot: root,
        dryRun: true,
        kalshiFetcher: async () => ({ ok: true, status: 200, json: fedexKalshiEvent(), error: null }),
        env: { PERPLEXITY_API_KEY: 'pplx-test-key' },
        perplexityImpl: async () => {
          const artifact = fakePerplexityArtifact();
          artifact.source_urls = [];
          artifact.source_titles = [];
          artifact.source_freshness = [];
          return {
            content: JSON.stringify(artifact),
            citations: [],
            search_results: [],
          };
        },
        now: () => '2026-06-23T20:00:00Z',
      }),
      /Perplexity attachment contract failed closed/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
