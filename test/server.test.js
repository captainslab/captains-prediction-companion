import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNoteStore } from '../src/noteStore.js';
import {
  buildEventMarketPlan,
  buildEventMarketPlanSummary,
  buildFocusedKalshiMarketPlan,
} from '../src/eventMarketTool.js';
import { buildEventMarketWorkflowPrompt } from '../src/eventMarketPrompt.js';

const TRUMP_EVENT_URL =
  'https://kalshi.com/markets/kxtrumpmentionb/trump-mention-b/KXTRUMPMENTIONB-26MAR27?utm_source=kalshiapp_eventpage';
const TRUMP_GENERIC_EVENT_URL =
  'https://kalshi.com/markets/kxtrumpmention/what-will-trump-say/KXTRUMPMENTION-26MAR27?utm_source=kalshiapp_eventpage';
const KALSHI_BASE_URL = 'https://api.elections.kalshi.com/trade-api/v2';

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return JSON.parse(JSON.stringify(payload));
    },
  };
}

function createFetchStub(routeMap) {
  return async url => {
    const key = typeof url === 'string' ? url : url.toString();
    if (!routeMap.has(key)) {
      return jsonResponse({ error: 'not found' }, 404);
    }
    return jsonResponse(routeMap.get(key));
  };
}

function buildTrumpEventPayload() {
  return {
    event: {
      category: 'Mentions',
      event_ticker: 'KXTRUMPMENTIONB-26MAR27',
      series_ticker: 'KXTRUMPMENTIONB',
      sub_title: 'Remarks to Farmers',
      title: 'What will Donald Trump say during Remarks to Farmers?',
    },
    markets: [
      {
        ticker: 'KXTRUMPMENTIONB-26MAR27-BIDE',
        title: 'What will Donald Trump say during Remarks to Farmers?',
        yes_sub_title: 'Biden',
        custom_strike: { Word: 'Biden' },
        rules_primary:
          'If Donald Trump says Biden as part of Remarks to Farmers, then the market resolves to Yes.',
        status: 'active',
        yes_bid_dollars: '0.8200',
        yes_ask_dollars: '0.8600',
        last_price_dollars: '0.8400',
      },
      {
        ticker: 'KXTRUMPMENTIONB-26MAR27-TARI',
        title: 'What will Donald Trump say during Remarks to Farmers?',
        yes_sub_title: 'Tariff',
        custom_strike: { Word: 'Tariff' },
        rules_primary:
          'If Donald Trump says Tariff as part of Remarks to Farmers, then the market resolves to Yes.',
        status: 'active',
        yes_bid_dollars: '0.6100',
        yes_ask_dollars: '0.6500',
        last_price_dollars: '0.6300',
      },
    ],
  };
}

function buildTrumpGenericEventPayload() {
  return {
    event: {
      category: 'Mentions',
      event_ticker: 'KXTRUMPMENTION-26MAR27',
      series_ticker: 'KXTRUMPMENTION',
      sub_title: 'Donald Trump - Remarks at FII PRIORITY Summit',
      title: 'What will Trump say during his remarks at the FII PRIORITY Summit?',
    },
    markets: [
      {
        ticker: 'KXTRUMPMENTION-26MAR27-CHIN',
        title: 'What will Trump say during his remarks at the FII PRIORITY Summit?',
        yes_sub_title: 'China',
        custom_strike: { Word: 'China' },
        rules_primary:
          'If Trump says China during the remarks, then the market resolves to Yes.',
        status: 'active',
        yes_bid_dollars: '0.7400',
        yes_ask_dollars: '0.7800',
        last_price_dollars: '0.7600',
      },
      {
        ticker: 'KXTRUMPMENTION-26MAR27-BIDE',
        title: 'What will Trump say during his remarks at the FII PRIORITY Summit?',
        yes_sub_title: 'Biden',
        custom_strike: { Word: 'Biden' },
        rules_primary:
          'If Trump says Biden during the remarks, then the market resolves to Yes.',
        status: 'active',
        yes_bid_dollars: '0.1200',
        yes_ask_dollars: '0.1600',
        last_price_dollars: '0.1400',
      },
    ],
  };
}

function buildPoliticsDinnerEventPayload() {
  return {
    event: {
      category: 'Mentions',
      event_ticker: 'KXPOLITICSMENTION-26MAR27D',
      series_ticker: 'KXPOLITICSMENTION',
      sub_title: 'Ken Paxton - CPAC Ronald Reagan Dinner',
      title: 'What will Ken Paxton say during CPAC Ronald Reagan Dinner?',
    },
    markets: [
      {
        ticker: 'KXPOLITICSMENTION-26MAR27D-DEMO',
        title: 'What will Ken Paxton say during CPAC Ronald Reagan Dinner?',
        yes_sub_title: 'Democrat',
        custom_strike: { Word: 'Democrat' },
        rules_primary:
          'If Ken Paxton says Democrat as part of CPAC Ronald Reagan Dinner, then the market resolves to Yes.',
        status: 'active',
        yes_bid_dollars: '0.6100',
        yes_ask_dollars: '0.7100',
        last_price_dollars: '0.8300',
      },
    ],
  };
}

test('note store creates, searches, lists, and deletes notes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chatgpt-app-starter-'));
  const file = join(dir, 'notes.json');
  const store = createNoteStore(file);

  const note = store.create({
    title: 'Launch plan',
    body: 'Set up Developer mode and connect the MCP server.',
    tags: ['openai', 'private'],
  });

  assert.equal(store.stats().count, 1);
  assert.equal(store.list(10)[0].id, note.id);
  assert.equal(store.search('Developer', 10)[0].id, note.id);
  assert.equal(store.delete(note.id), true);
  assert.equal(store.stats().count, 0);
  assert.equal(store.delete(note.id), false);

  const raw = readFileSync(file, 'utf8');
  assert.equal(raw.trim(), '[]');

  rmSync(dir, { recursive: true, force: true });
});

test('event market tool builds the standard contract locally', async () => {
  const result = await buildEventMarketPlan({ venue: 'Kalshi', domain: 'sports' });
  assert.equal(result.plan.venue, 'Kalshi');
  assert.equal(result.workflow.name, 'sports-market-research');
  assert.equal(result.workflow.domain_wrapper, 'sports-market');
  assert.equal(result.workflow.stages.some(stage => stage.stage === 'routing'), true);
  assert.equal(result.output_contract.name, 'event-market-output');
  assert.equal(result.user_facing.source.platform, 'Kalshi');
});

test('event market tool infers mention workflow from the market title', async () => {
  const result = await buildEventMarketPlan({
    venue: 'Kalshi',
    title: 'Trump mention board',
    market_id: 'KXTRUMPMENTIONB-26MAR27',
  });

  assert.equal(result.plan.domain, 'mention');
  assert.equal(result.workflow.name, 'mention-market-research');
  assert.equal(result.workflow.domain_wrapper, 'mention-market');
  assert.match(result.workflow.evidence_targets[0], /broadcast/i);
  assert.equal(result.output_contract.sections.some(section => section.section === 'classification'), true);
  assert.equal(result.user_facing.market_type, 'mention');
});

test('event market tool infers mention workflow from a Kalshi url', async () => {
  const fetchImpl = createFetchStub(
    new Map([[`${KALSHI_BASE_URL}/events/KXTRUMPMENTIONB-26MAR27`, buildTrumpEventPayload()]])
  );
  const result = await buildEventMarketPlan({
    venue: 'Kalshi',
    url: TRUMP_EVENT_URL,
  }, { fetchImpl });

  assert.equal(result.plan.venue, 'Kalshi');
  assert.equal(result.plan.domain, 'mention');
  assert.equal(result.plan.metadata.market_id, 'KXTRUMPMENTIONB-26MAR27');
  assert.match(result.plan.metadata.url, /kalshi\.com/);
  assert.equal(result.user_facing.event_type, 'speech');
  assert.equal(result.user_facing.event_domain, 'politics');
  assert.equal(result.user_facing.status, 'waiting');
  assert.equal(result.user_facing.summary.recommendation, 'watch');
  assert.equal(result.user_facing.context.speaker, 'Donald Trump');
  assert.equal(result.user_facing.market_view.available_contracts.length, 2);
  assert.equal(result.workflow.name, 'mention-market-research');
});

test('event market plan summary stays compact and hides the workflow memo', async () => {
  const fetchImpl = createFetchStub(
    new Map([[`${KALSHI_BASE_URL}/events/KXTRUMPMENTIONB-26MAR27`, buildTrumpEventPayload()]])
  );
  const result = await buildEventMarketPlan({
    venue: 'Kalshi',
    url: TRUMP_EVENT_URL,
  }, { fetchImpl });
  const summary = buildEventMarketPlanSummary(result);

  assert.deepEqual(summary.source, {
    platform: 'Kalshi',
    url: TRUMP_EVENT_URL,
    market_id: 'KXTRUMPMENTIONB-26MAR27',
  });
  assert.equal(summary.event_domain, 'politics');
  assert.equal(summary.event_type, 'speech');
  assert.equal(summary.market_type, 'mention');
  assert.equal(summary.status, 'waiting');
  assert.equal(summary.confidence, 'low');
  assert.equal(summary.summary.recommendation, 'watch');
  assert.match(summary.summary.one_line_reason, /specific contract/i);
  assert.equal(summary.next_action, 'select_specific_contract');
  assert.equal(Object.hasOwn(summary, 'workflow'), false);
  assert.equal(Object.hasOwn(summary.market_view, 'mention_paths'), false);
});

test('event market tool prices a specific Kalshi mention contract when market data is available', async () => {
  const eventPayload = buildTrumpEventPayload();
  const marketPayload = {
    market: {
      ...eventPayload.markets[0],
      event_ticker: 'KXTRUMPMENTIONB-26MAR27',
      rules_secondary: 'Video of the remarks will be used as the primary settlement source.',
    },
  };
  const orderbookPayload = {
    orderbook_fp: {
      yes_dollars: [
        [0.86, 100],
        [0.87, 50],
      ],
      no_dollars: [[0.18, 40]],
    },
  };
  const fetchImpl = createFetchStub(
    new Map([
      [`${KALSHI_BASE_URL}/markets/KXTRUMPMENTIONB-26MAR27-BIDE`, marketPayload],
      [`${KALSHI_BASE_URL}/markets/KXTRUMPMENTIONB-26MAR27-BIDE/orderbook`, orderbookPayload],
      [`${KALSHI_BASE_URL}/events/KXTRUMPMENTIONB-26MAR27`, eventPayload],
    ])
  );

  const result = await buildEventMarketPlan(
    {
      venue: 'Kalshi',
      market_id: 'KXTRUMPMENTIONB-26MAR27-BIDE',
      url: TRUMP_EVENT_URL,
    },
    { fetchImpl }
  );

  assert.equal(result.user_facing.status, 'needs_pricing');
  assert.equal(result.user_facing.summary.recommendation, 'watch');
  assert.equal(result.user_facing.context.speaker, 'Donald Trump');
  assert.equal(result.user_facing.market_view.target_phrase, 'Biden');
  assert.equal(result.user_facing.market_view.trade_view.market_ticker, 'KXTRUMPMENTIONB-26MAR27-BIDE');
  assert.equal(result.user_facing.market_view.trade_view.market_yes, 0.84);
  assert.equal(result.user_facing.market_view.trade_view.market_status, 'active');
  assert.equal(Object.hasOwn(result.user_facing.market_view, 'mention_paths'), false);
});

test('event market tool enriches a specific Kalshi contract from the url tail', async () => {
  const eventPayload = buildTrumpEventPayload();
  const marketPayload = {
    market: {
      ...eventPayload.markets[1],
      event_ticker: 'KXTRUMPMENTIONB-26MAR27',
      rules_secondary: 'Video of the remarks will be used as the primary settlement source.',
    },
  };
  const orderbookPayload = {
    orderbook_fp: {
      yes_dollars: [
        [0.65, 100],
        [0.66, 50],
      ],
      no_dollars: [[0.35, 40]],
    },
  };
  const fetchImpl = createFetchStub(
    new Map([
      [`${KALSHI_BASE_URL}/markets/KXTRUMPMENTIONB-26MAR27-TARI`, marketPayload],
      [`${KALSHI_BASE_URL}/markets/KXTRUMPMENTIONB-26MAR27-TARI/orderbook`, orderbookPayload],
      [`${KALSHI_BASE_URL}/events/KXTRUMPMENTIONB-26MAR27`, eventPayload],
    ])
  );

  const result = await buildEventMarketPlan(
    {
      venue: 'Kalshi',
      url: 'https://kalshi.com/markets/kxtrumpmentionb/trump-mention-b/KXTRUMPMENTIONB-26MAR27-TARI?utm_source=kalshiapp_eventpage',
    },
    { fetchImpl }
  );

  assert.equal(result.user_facing.market_type, 'mention');
  assert.equal(result.user_facing.status, 'needs_pricing');
  assert.equal(result.user_facing.summary.recommendation, 'watch');
  assert.equal(result.user_facing.market_view.target_phrase, 'Tariff');
  assert.equal(result.user_facing.market_view.trade_view.market_ticker, 'KXTRUMPMENTIONB-26MAR27-TARI');
  assert.equal(result.user_facing.market_view.trade_view.market_yes, 0.63);
});

test('generic trump mention board url still classifies as a mention market', async () => {
  const fetchImpl = createFetchStub(
    new Map([[`${KALSHI_BASE_URL}/events/KXTRUMPMENTION-26MAR27`, buildTrumpGenericEventPayload()]])
  );

  const result = await buildEventMarketPlan(
    {
      venue: 'Kalshi',
      url: TRUMP_GENERIC_EVENT_URL,
    },
    { fetchImpl }
  );

  assert.equal(result.user_facing.event_domain, 'politics');
  assert.equal(result.user_facing.event_type, 'speech');
  assert.equal(result.user_facing.market_type, 'mention');
  assert.equal(result.user_facing.status, 'waiting');
  assert.equal(result.user_facing.summary.recommendation, 'watch');
  assert.equal(result.user_facing.context.speaker, 'Donald Trump');
  assert.equal(result.user_facing.context.event_name, 'Remarks at FII PRIORITY Summit');
  assert.equal(result.user_facing.market_view.available_contracts.length, 2);
});

test('politics mention event metadata classifies as politics speech instead of generic media', async () => {
  const fetchImpl = createFetchStub(
    new Map([[`${KALSHI_BASE_URL}/events/KXPOLITICSMENTION-26MAR27D`, buildPoliticsDinnerEventPayload()]])
  );

  const result = await buildEventMarketPlan(
    {
      venue: 'Kalshi',
      url: 'https://kalshi.com/markets/kxpoliticsmention/general-politics/KXPOLITICSMENTION-26MAR27D?utm_source=kalshiapp_eventpage',
    },
    { fetchImpl }
  );

  assert.equal(result.user_facing.event_domain, 'politics');
  assert.equal(result.user_facing.event_type, 'speech');
  assert.equal(result.user_facing.market_type, 'mention');
  assert.equal(result.user_facing.context.speaker, 'Ken Paxton');
  assert.equal(result.user_facing.context.event_name, 'CPAC Ronald Reagan Dinner');
});

test('focused kalshi market plan auto-selects the top contract from a board url', async () => {
  const eventPayload = buildTrumpGenericEventPayload();
  const focusTicker = 'KXTRUMPMENTION-26MAR27-CHIN';
  const marketPayload = {
    market: {
      ...eventPayload.markets[0],
      event_ticker: 'KXTRUMPMENTION-26MAR27',
      rules_secondary: 'Video of the remarks will be used as the primary settlement source.',
    },
  };
  const orderbookPayload = {
    orderbook_fp: {
      yes_dollars: [[0.78, 120]],
      no_dollars: [[0.22, 80]],
    },
  };
  const fetchImpl = createFetchStub(
    new Map([
      [`${KALSHI_BASE_URL}/events/KXTRUMPMENTION-26MAR27`, eventPayload],
      [`${KALSHI_BASE_URL}/markets/${focusTicker}`, marketPayload],
      [`${KALSHI_BASE_URL}/markets/${focusTicker}/orderbook`, orderbookPayload],
    ])
  );

  const result = await buildFocusedKalshiMarketPlan(
    {
      venue: 'Kalshi',
      url: TRUMP_GENERIC_EVENT_URL,
    },
    { fetchImpl }
  );

  assert.equal(result.user_facing.status, 'needs_pricing');
  assert.equal(result.user_facing.summary.recommendation, 'watch');
  assert.equal(result.user_facing.source.market_id, focusTicker);
  assert.equal(result.user_facing.market_view.target_phrase, 'China');
  assert.equal(result.user_facing.market_view.trade_view.market_ticker, focusTicker);
  assert.equal(result.user_facing.market_view.trade_view.market_yes, 0.76);
});

test('event market tool routes earnings markets into the mention workflow', async () => {
  const result = await buildEventMarketPlan({
    venue: 'Kalshi',
    domain: 'earnings',
    title: 'Will the CEO say revenue?',
    market_id: 'KXEARNINGS-TEST',
  });

  assert.equal(result.plan.domain, 'mention');
  assert.equal(result.workflow.name, 'mention-market-research');
});

test('event market tool routes macro markets into the macro workflow', async () => {
  const result = await buildEventMarketPlan({
    venue: 'Kalshi',
    domain: 'macro',
    title: 'Will the Fed cut rates?',
    market_id: 'KXMACRO-TEST',
  });

  assert.equal(result.plan.domain, 'macro');
  assert.equal(result.workflow.name, 'macro-market-research');
  assert.equal(result.workflow.domain_wrapper, 'macro-market');
  assert.equal(result.workflow.stages.some(stage => stage.stage === 'research'), true);
});

test('event market tool routes politics markets into the politics workflow', async () => {
  const result = await buildEventMarketPlan({
    venue: 'Kalshi',
    domain: 'politics',
    title: 'Will the candidate mention the policy?',
    market_id: 'KXPOLITICS-TEST',
  });

  assert.equal(result.plan.domain, 'politics');
  assert.equal(result.workflow.name, 'politics-market-research');
  assert.equal(result.workflow.domain_wrapper, 'politics-market');
  assert.equal(result.workflow.stages.some(stage => stage.stage === 'evidence'), true);
});

test('event market prompt primes the backend plan workflow', () => {
  const prompt = buildEventMarketWorkflowPrompt({
    venue: 'Kalshi',
    domain: 'sports',
    market_id: 'KX123',
    title: 'Will the home team win?',
  });

  assert.equal(prompt.messages[0].role, 'system');
  assert.match(prompt.messages[0].content.text, /analyze_kalshi_market_url/);
  assert.doesNotMatch(prompt.messages[0].content.text, /analyze_market_url/);
  assert.doesNotMatch(prompt.messages[0].content.text, /event_market_plan/);
  assert.match(prompt.messages[0].content.text, /do not manually interpret/i);
  assert.match(prompt.messages[0].content.text, /exactly the compact user-facing card json/i);
  assert.match(prompt.messages[1].content.text, /KX123/);
});
