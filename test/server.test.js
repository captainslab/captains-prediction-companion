import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNoteStore } from '../src/noteStore.js';
import { createPipelineService } from '../src/pipelineService.js';
import {
  buildEventMarketPlan,
  buildEventMarketPlanSummary,
  buildFocusedKalshiMarketPlan,
} from '../src/eventMarketTool.js';
import { buildOfficialSourcePacket } from '../src/sourcePackets.js';
import { buildEventMarketWorkflowPrompt } from '../src/eventMarketPrompt.js';
import { analyzeKalshiMarketUrlTool, createHttpRequestHandler } from '../src/server.js';

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

function createAlphaRunnerStub(result, verifier) {
  return async (query, options = {}) => {
    assert.equal(typeof query, 'string');
    assert.match(query, /alpha_input:/);
    verifier?.(query, options);
    return {
      ok: true,
      parsed: result,
      stdout: '',
      stderr: '',
      status: 0,
      error: null,
      sessionId: 'test-session',
    };
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

function buildTrumpLargeEventPayload() {
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
      {
        ticker: 'KXTRUMPMENTIONB-26MAR27-CHIN',
        title: 'What will Donald Trump say during Remarks to Farmers?',
        yes_sub_title: 'China',
        custom_strike: { Word: 'China' },
        rules_primary:
          'If Donald Trump says China as part of Remarks to Farmers, then the market resolves to Yes.',
        status: 'active',
        yes_bid_dollars: '0.5400',
        yes_ask_dollars: '0.5800',
        last_price_dollars: '0.5600',
      },
      {
        ticker: 'KXTRUMPMENTIONB-26MAR27-POWL',
        title: 'What will Donald Trump say during Remarks to Farmers?',
        yes_sub_title: 'Powell',
        custom_strike: { Word: 'Powell' },
        rules_primary:
          'If Donald Trump says Powell as part of Remarks to Farmers, then the market resolves to Yes.',
        status: 'active',
        yes_bid_dollars: '0.4300',
        yes_ask_dollars: '0.4700',
        last_price_dollars: '0.4500',
      },
      {
        ticker: 'KXTRUMPMENTIONB-26MAR27-AIXX',
        title: 'What will Donald Trump say during Remarks to Farmers?',
        yes_sub_title: 'AI',
        custom_strike: { Word: 'AI' },
        rules_primary:
          'If Donald Trump says AI as part of Remarks to Farmers, then the market resolves to Yes.',
        status: 'active',
        yes_bid_dollars: '0.2200',
        yes_ask_dollars: '0.2600',
        last_price_dollars: '0.2400',
      },
      {
        ticker: 'KXTRUMPMENTIONB-26MAR27-EPST',
        title: 'What will Donald Trump say during Remarks to Farmers?',
        yes_sub_title: 'Epstein',
        custom_strike: { Word: 'Epstein' },
        rules_primary:
          'If Donald Trump says Epstein as part of Remarks to Farmers, then the market resolves to Yes.',
        status: 'active',
        yes_bid_dollars: '0.0900',
        yes_ask_dollars: '0.1100',
        last_price_dollars: '0.1000',
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
  assert.ok(
    ['watch', 'buy_no'].includes(result.user_facing.summary.recommendation),
    `expected watch or buy_no, got ${result.user_facing.summary.recommendation}`,
  );
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

  assert.ok(
    ['needs_pricing', 'ready'].includes(result.user_facing.status),
    `expected a valid live status, got ${result.user_facing.status}`,
  );
  assert.ok(
    ['watch', 'buy_no'].includes(result.user_facing.summary.recommendation),
    `expected watch or buy_no, got ${result.user_facing.summary.recommendation}`,
  );
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
  assert.ok(
    ['needs_pricing', 'ready'].includes(result.user_facing.status),
    `expected needs_pricing or ready, got ${result.user_facing.status}`,
  );
  assert.ok(
    ['watch', 'buy_no'].includes(result.user_facing.summary.recommendation),
    `expected watch or buy_no, got ${result.user_facing.summary.recommendation}`,
  );
  assert.equal(result.user_facing.market_view.target_phrase, 'Tariff');
  assert.equal(result.user_facing.market_view.trade_view.market_ticker, 'KXTRUMPMENTIONB-26MAR27-TARI');
  assert.equal(result.user_facing.market_view.trade_view.market_yes, 0.63);
});

test('event market alpha computes fair value and a directional side for a specific contract', async () => {
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
  const alphaRunner = createAlphaRunnerStub(
    {
      fair_yes: 0.92,
      confidence: 'high',
      reasoning: 'Biden is a likely attack line in this remarks format.',
      watch_for: ['alternate wording', 'segment exclusions'],
    },
    (query, options) => {
      // No hard-coded model routing: with no explicit override configured,
      // packet generation must NOT force a provider/model, so the Hermes CLI
      // uses its own active default provider/model/reasoning.
      assert.equal(options.provider ?? null, null);
      assert.equal(options.model ?? null, null);
      assert.equal(options.source, 'event-market-alpha');
      assert.deepEqual(options.skills, []);
      assert.deepEqual(options.toolsets, []);
      assert.match(query, /"target_phrase":"Biden"/);
      // Price isolation: no market price / bid / ask / last_price may enter the
      // model query. Only non-price identifiers and evidence are allowed.
      assert.doesNotMatch(query, /market_yes/);
      assert.doesNotMatch(query, /yes_bid/);
      assert.doesNotMatch(query, /yes_ask/);
      assert.doesNotMatch(query, /last_price/);
    }
  );

  const result = await buildEventMarketPlan(
    {
      venue: 'Kalshi',
      market_id: 'KXTRUMPMENTIONB-26MAR27-BIDE',
      url: TRUMP_EVENT_URL,
    },
    { fetchImpl, alphaRunner }
  );

  assert.equal(result.user_facing.status, 'ready');
  assert.equal(result.user_facing.confidence, 'high');
  assert.equal(result.user_facing.summary.recommendation, 'buy_yes');
  assert.equal(
    result.user_facing.summary.one_line_reason,
    'Biden is a likely attack line in this remarks format.'
  );
  assert.equal(result.user_facing.market_view.trade_view.market_yes, 0.84);
  assert.equal(result.user_facing.market_view.trade_view.fair_yes, 0.92);
  assert.equal(result.user_facing.market_view.trade_view.edge_cents, 8);
  assert.deepEqual(result.user_facing.market_view.watch_for, [
    'alternate wording',
    'segment exclusions',
  ]);
});

test('event market alpha honors an explicit model/provider override', async () => {
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
  const alphaRunner = createAlphaRunnerStub(
    {
      fair_yes: 0.92,
      confidence: 'high',
      reasoning: 'Biden is a likely attack line in this remarks format.',
      watch_for: ['alternate wording'],
    },
    (query, options) => {
      // An explicit override must still flow through to the Hermes CLI call.
      assert.equal(options.provider, 'copilot');
      assert.equal(options.model, 'claude-opus-4.8');
    }
  );

  const result = await buildEventMarketPlan(
    {
      venue: 'Kalshi',
      market_id: 'KXTRUMPMENTIONB-26MAR27-BIDE',
      url: TRUMP_EVENT_URL,
    },
    { fetchImpl, alphaRunner, alphaProvider: 'copilot', alphaModel: 'claude-opus-4.8' }
  );

  assert.equal(result.user_facing.status, 'ready');
});

test('event market alpha falls back cleanly when the model call fails', async () => {
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
    {
      fetchImpl,
      alphaRunner: async () => {
        throw new Error('network down');
      },
    }
  );

  assert.equal(result.user_facing.status, 'needs_pricing');
  assert.equal(result.user_facing.summary.recommendation, 'watch');
  assert.equal(result.user_facing.market_view.trade_view.fair_yes, null);
  assert.equal(result.user_facing.market_view.trade_view.edge_cents, null);
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

test('event market board previews and alpha payload include more than five contracts', async () => {
  const eventPayload = buildTrumpLargeEventPayload();
  const focusTicker = 'KXTRUMPMENTIONB-26MAR27-BIDE';
  const marketPayload = {
    market: {
      ...eventPayload.markets[0],
      event_ticker: 'KXTRUMPMENTIONB-26MAR27',
      rules_secondary: 'Video of the remarks will be used as the primary settlement source.',
    },
  };
  const orderbookPayload = {
    orderbook_fp: {
      yes_dollars: [[0.86, 100]],
      no_dollars: [[0.18, 40]],
    },
  };
  let observedQuery = '';
  const fetchImpl = createFetchStub(
    new Map([
      [`${KALSHI_BASE_URL}/markets/${focusTicker}`, marketPayload],
      [`${KALSHI_BASE_URL}/markets/${focusTicker}/orderbook`, orderbookPayload],
      [`${KALSHI_BASE_URL}/events/KXTRUMPMENTIONB-26MAR27`, eventPayload],
    ])
  );
  const alphaRunner = createAlphaRunnerStub(
    {
      fair_yes: 0.92,
      confidence: 'high',
      reasoning: 'The contract can still clear on exact wording.',
      watch_for: ['official transcript'],
    },
    (query) => {
      observedQuery = query;
    }
  );

  const result = await buildEventMarketPlan(
    {
      venue: 'Kalshi',
      market_id: focusTicker,
      url: TRUMP_EVENT_URL,
    },
    { fetchImpl, alphaRunner }
  );

  assert.equal(result.user_facing.market_view.available_contracts.length, 6);
  assert.match(observedQuery, /\"market_ticker\":\"KXTRUMPMENTIONB-26MAR27-EPST\"/);
});

test('event market alpha sends exact phrase, speaker repertoire, transcript mechanics, and evidence separation to the model', async () => {
  const eventPayload = buildTrumpEventPayload();
  const marketPayload = {
    market: {
      ...eventPayload.markets[1],
      event_ticker: 'KXTRUMPMENTIONB-26MAR27',
      rules_secondary: 'Official transcript of the remarks and Q&A will be used as the settlement source.',
    },
  };
  const orderbookPayload = {
    orderbook_fp: {
      yes_dollars: [[0.65, 100]],
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
  const sourcePacket = {
    source_packet_kind: 'mention',
    official_source_url: 'https://example.com/transcript',
    official_source_type: 'official_transcript',
    source_quality: 'high',
    evidence_strength: 'medium',
    target_phrase: 'Tariff',
    rules_summary: 'Resolves Yes only if Donald Trump says the exact word Tariff in eligible remarks or Q&A.',
    speaker_repertoire: {
      speaker: 'Donald Trump',
      target_phrase: 'Tariff',
      naturalness: 'high',
      historical_evidence: ['Trump used tariff repeatedly in trade-focused remarks.'],
      avoidance_risk: 'low',
    },
    transcript_mechanics: {
      controlling_source: 'official transcript',
      exact_match_required: true,
      allowed_segments: ['prepared remarks', 'Q&A'],
      excluded_segments: ['moderator-only text'],
    },
    verified_evidence: ['Official transcript source identified.'],
    inference_notes: ['Historical repertoire supports naturalness; current event fit remains inferred.'],
  };
  const alphaRunner = createAlphaRunnerStub(
    {
      fair_yes: 0.72,
      confidence: 'medium',
      reasoning: 'Tariff is a high-naturalness Trump word, but exact transcript settlement still controls.',
      watch_for: ['official transcript exact word', 'moderator-only exclusion'],
    },
    (query) => {
      assert.match(query, /"target_phrase"\s*:\s*"Tariff"/);
      assert.match(query, /"speaker"\s*:\s*"Donald Trump"/);
      assert.match(query, /speaker_repertoire/);
      assert.match(query, /transcript_mechanics/);
      assert.match(query, /verified_evidence/);
      assert.match(query, /inference_notes/);
      assert.match(query, /exact target phrase/i);
      assert.match(query, /naturally uses/i);
      assert.match(query, /resolution mechanics/i);
    }
  );

  const result = await buildEventMarketPlan(
    {
      venue: 'Kalshi',
      market_id: 'KXTRUMPMENTIONB-26MAR27-TARI',
      url: 'https://kalshi.com/markets/kxtrumpmentionb/trump-mention-b/KXTRUMPMENTIONB-26MAR27-TARI',
      source_packet: sourcePacket,
    },
    { fetchImpl, alphaRunner }
  );

  assert.equal(result.user_facing.market_view.target_phrase, 'Tariff');
  assert.equal(result.user_facing.status, 'needs_pricing');
  assert.equal(result.user_facing.summary.one_line_reason, 'The contract has live Kalshi prices, but CPC has not produced a source-backed model read yet.');
  assert.equal(result.user_facing.market_view.trade_view.fair_yes, null);
  assert.equal(result.user_facing.market_view.trade_view.edge_cents, null);
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

test('corporate earnings source packets route to issuer SEC search candidates instead of generic mention fallback', async () => {
  const result = await buildOfficialSourcePacket({
    venue: 'Kalshi',
    domain: 'earnings',
    title: 'What will American Express say during earnings?',
    question: 'What will American Express say during earnings?',
    market_id: 'KXAXPMENTION-TEST',
    metadata: {
      company: 'American Express',
      event_name: 'American Express earnings call',
      target_phrase: 'revenue',
    },
  });

  assert.equal(result.event_domain, 'corporate');
  assert.equal(result.event_type, 'earnings_call');
  assert.equal(result.market_type, 'mention');
  assert.equal(result.source_packet_kind, 'earnings');
  assert.equal(result.source_quality, 'high');
  assert.equal(result.evidence_strength, 'medium');
  assert.match(result.official_source_url, /sec\.gov\/edgar\/search/);
  assert.equal(result.official_source_type, 'sec_earnings_search');
  assert.ok(result.official_source_candidates.some(candidate => candidate.type === 'sec_8k_company_search'));
  assert.ok(result.reasoning_chain.some(line => /American Express/i.test(line)));
  assert.ok(result.unresolved_gaps.length > 0);
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


test('pipeline latest output endpoint returns the most recent Tesla board record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-latest-board-'));
  const stateFile = join(dir, 'pipeline-state.json');
  const outputFile = join(dir, 'pipeline-card-outputs.json');
  const service = createPipelineService({
    stateFile,
    outputFile,
    seedUrls: [],
    now: () => new Date('2026-04-22T12:00:00.000Z'),
    runMarketAnalysis: async () => ({
      board_url: 'https://kalshi.com/markets/kxearningsmentiontsla/tesla-earnings-mention/KXEARNINGSMENTIONTSLA-26APR22-FSD',
      board_headline: 'The alpha pipeline priced the mention contract, but the edge is too thin to act.',
      board_recommendation: 'watch',
      board_confidence: 'high',
      official_source_url: 'https://www.sec.gov/Archives/edgar/data/1318605/000162828026026551/exhibit991.htm',
      official_source_type: 'sec_8k_exhibit_99_1',
      board_no_edge_reason_code: 'priced_in',
      board_no_edge_reason: 'Market price (100%) and model fair value (100%) were too close, leaving only a 0c gap.',
      edge_type: 'none',
      catalyst: 'Tesla earnings filing',
      reasoning_chain: [
        '[timing/catalyst insight] The official filing is already public, so the remaining edge is only in settlement confirmation.',
        '[market-structure mismatch] Market price and fair probability are aligned, so there is no actionable spread left.'
      ],
      invalidation_condition: 'If a later official source changes the exact phrase interpretation, revisit the board.',
      time_sensitivity: 'high',
      child_contracts: [],
    }),
  });

  service.recordRecentUrl('https://kalshi.com/markets/kxearningsmentiontsla/tesla-earnings-mention/KXEARNINGSMENTIONTSLA-26APR22-FSD');
  await service.runProduction({ full: false, max_events: 1 });

  const handler = createHttpRequestHandler({ pipelineService: service, noteStore: createNoteStore(join(dir, 'notes.json')) });
  const latest = await new Promise((resolve, reject) => {
    const req = new http.IncomingMessage();
    req.url = '/pipeline/outputs/latest';
    req.method = 'GET';
    req.headers = {};
    const chunks = [];
    const res = new http.ServerResponse(req);
    res.assignSocket({
      writable: true,
      on() {},
      once() {},
      emit() {},
      removeListener() {},
      cork() {},
      uncork() {},
      end() {},
      destroy() {},
      setTimeout() {},
      setNoDelay() {},
      setKeepAlive() {},
    });
    res.write = chunk => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    };
    res.end = chunk => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      resolve({
        statusCode: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      });
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });

  assert.equal(latest.statusCode, 200);
  const parsed = JSON.parse(latest.body);
  assert.equal(parsed.board_url, 'https://kalshi.com/markets/kxearningsmentiontsla/tesla-earnings-mention/KXEARNINGSMENTIONTSLA-26APR22-FSD');
  assert.equal(parsed.board_headline, 'The alpha pipeline priced the mention contract, but the edge is too thin to act.');
  assert.equal(parsed.board_recommendation, 'watch');
  assert.equal(parsed.board_confidence, 'high');
  assert.equal(parsed.official_source_url, 'https://www.sec.gov/Archives/edgar/data/1318605/000162828026026551/exhibit991.htm');
  assert.equal(parsed.official_source_type, 'sec_8k_exhibit_99_1');
  assert.equal(parsed.board_no_edge_reason_code, 'priced_in');
  assert.equal(parsed.board_no_edge_reason, 'Market price (100%) and model fair value (100%) were too close, leaving only a 0c gap.');
  assert.equal(parsed.edge_type, 'none');
  assert.equal(parsed.catalyst, 'Tesla earnings filing');
  assert.deepEqual(parsed.reasoning_chain, [
    '[timing/catalyst insight] The official filing is already public, so the remaining edge is only in settlement confirmation.',
    '[market-structure mismatch] Market price and fair probability are aligned, so there is no actionable spread left.'
  ]);
  assert.equal(parsed.invalidation_condition, 'If a later official source changes the exact phrase interpretation, revisit the board.');
  assert.equal(parsed.time_sensitivity, 'high');
  assert.equal(Array.isArray(parsed.child_contracts), true);
  assert.equal(parsed.child_contracts.length, 0);

  rmSync(dir, { recursive: true, force: true });
});
