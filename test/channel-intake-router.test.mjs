import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseIntakeText } from '../channels/shared/intake.mjs';
import { routeMarket } from '../channels/shared/route-market.mjs';

test('intake parser handles a Kalshi URL', () => {
  const parsed = parseIntakeText('https://kalshi.com/markets/KXMLBGAME-26JUN09NYYBOS');
  assert.equal(parsed.inputType, 'kalshi_url');
  assert.equal(parsed.ticker, 'KXMLBGAME-26JUN09NYYBOS');
  assert.equal(parsed.marketFamily, 'kalshi_mlb');
});

test('intake parser handles a ticker', () => {
  const parsed = parseIntakeText('KXNASCARRACE-26JUN14DRIVER');
  assert.equal(parsed.inputType, 'ticker');
  assert.equal(parsed.ticker, 'KXNASCARRACE-26JUN14DRIVER');
  assert.equal(parsed.marketFamily, 'kalshi_nascar');
});

test('intake parser handles a plain text market request', () => {
  const parsed = parseIntakeText('Can CPC price whether Powell will say inflation?');
  assert.equal(parsed.inputType, 'market_request');
  assert.equal(parsed.marketFamily, 'kalshi_mentions');
  assert.match(parsed.intentText, /Powell/);
});

test('intake parser handles unsupported text', () => {
  const parsed = parseIntakeText('hello');
  assert.equal(parsed.inputType, 'unsupported');
  assert.equal(parsed.unsupportedReason, 'not_market_intent');
});

test('router maps MLB family to CPC event workflow and MLB packet hint', () => {
  const route = routeMarket(parseIntakeText('KXMLBGAME-26JUN09NYYBOS'));
  assert.equal(route.status, 'routed');
  assert.equal(route.workflow.id, 'event_market_card');
  assert.equal(route.packetWorkflow.id, 'mlb_daily_packet');
  assert.equal(route.safety.marketDataInScore, false);
  assert.equal(route.safety.liveTrades, false);
});

test('router maps mentions family to CPC workflows', () => {
  const route = routeMarket(parseIntakeText('KXMENTIONS-26JUN09POWELL-INFLATION'));
  assert.equal(route.status, 'routed');
  assert.equal(route.workflow.id, 'event_market_card');
  assert.equal(route.packetWorkflow.id, 'mentions_daily_packet');
});

test('router blocks plain market requests without a source', () => {
  const route = routeMarket(parseIntakeText('Will the Fed mention inflation?'));
  assert.equal(route.status, 'blocked');
  assert.equal(route.supported, false);
  assert.equal(route.blocker, 'WAITING_FOR_MARKET_SOURCE');
});

test('router rejects non-Kalshi URLs', () => {
  const route = routeMarket(parseIntakeText('https://example.com/markets/KXFAKE-1'));
  assert.equal(route.status, 'unsupported');
  assert.equal(route.supported, false);
  assert.match(route.reason, /Kalshi/);
});
