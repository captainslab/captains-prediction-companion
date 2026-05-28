import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { analyzeKalshiMarketUrlTool, createHttpRequestHandler } from '../src/server.js';
import { createNoteStore } from '../src/noteStore.js';
import { analyzeCompositeMarketLink } from '../scripts/mlb/link-composite-card.mjs';

const VALID_MLB_URL =
  'https://kalshi.com/markets/kxmlbgame/rays-orioles/KXMLBGAME-26MAY282000TBBAL-TB';

const AMBIGUOUS_MLB_URL =
  'https://kalshi.com/markets/mlb/aces-vs-bears-over-1-5';

const TB_BAL_INPUT = {
  label: 'TB@BAL',
  game_pk: 1001,
  away_team: 'Tampa Bay Rays',
  home_team: 'Baltimore Orioles',
  away_pitcher_splits: {
    park: { era: 1.50, fip: 1.90, hr9: 0.30, games: 4 },
    vsOpponent: { era: 1.80, fip: 2.00, kPct: 0.290, wins: 3, losses: 1, games: 4 },
  },
  home_pitcher_splits: {
    park: { era: 5.20, fip: 4.80, hr9: 1.40, games: 3 },
    vsOpponent: { era: 6.10, fip: 5.50, kPct: 0.170, wins: 1, losses: 4, games: 5 },
  },
  away_team_stats: { wins: 34, losses: 17, runDiff: 65, ops: 0.765, last10: '7-3' },
  home_team_stats: { wins: 23, losses: 30, runDiff: -25, ops: 0.710, last10: '4-6' },
  away_bullpen: { era: 3.40, recentLoadPct: 30 },
  home_bullpen: { era: 4.20, recentLoadPct: 55 },
  away_bullpen_fatigue: { consecutiveHLDays: 0, keyRelieverAvailable: true },
  home_bullpen_fatigue: { consecutiveHLDays: 2, keyRelieverAvailable: true },
  away_lineup_handedness: { vsRhpOps: 0.720, vsLhpOps: 0.690, rhbPct: 0.55, lhbPct: 0.45 },
  home_lineup_handedness: { vsRhpOps: 0.680, vsLhpOps: 0.700, rhbPct: 0.40, lhbPct: 0.60 },
  away_pitcher: {
    name: 'Griffin Jax',
    hand: 'R',
    era: 1.93,
    fip: 2.10,
    kPct: 0.268,
    bbPct: 0.082,
    recentQualityStarts: 2,
    recentStarts: 3,
  },
  home_pitcher: {
    name: 'Shane Baz',
    hand: 'R',
    era: 4.87,
    fip: 4.50,
    kPct: 0.195,
    bbPct: 0.095,
    recentQualityStarts: 1,
    recentStarts: 7,
  },
  park: { factor: 97, name: 'Camden Yards' },
  weather: { temperatureF: 72, windMph: 8, precipRisk: 0.05 },
};

function assertNoForbiddenRuntimeLanguage(value) {
  assert.doesNotMatch(JSON.stringify(value), /\b(trade|order|stake)\b/i);
}

function fakeSocket() {
  return {
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
  };
}

async function callJson(handler, { url, method = 'POST', body = null }) {
  const req = new PassThrough();
  req.url = url;
  req.method = method;
  req.headers = { 'content-type': 'application/json' };

  const chunks = [];
  const res = new http.ServerResponse(req);
  res.assignSocket(fakeSocket());
  res.write = chunk => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  };

  const response = new Promise((resolve, reject) => {
    res.end = chunk => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      resolve({
        statusCode: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      });
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });

  req.end(body == null ? '' : JSON.stringify(body));
  return response;
}

test('valid MLB market link routes through the composite path and returns a compact card', async () => {
  const result = await analyzeCompositeMarketLink({
    url: VALID_MLB_URL,
    gameInputs: [TB_BAL_INPUT],
  });

  assert.equal(result.ok, true);
  assert.equal(result.handled, true);
  assert.equal(result.pipeline, 'mlb_composite');
  assert.equal(result.composite_entrypoint, 'scripts/mlb/late-slate-composite-refresh.mjs#runComposite');
  assert.equal(result.route.route_status, 'ROUTED');
  assert.equal(result.route.market_lane, 'moneyline');
  assert.equal(result.compact_card.status, 'ready');
  assert.equal(result.compact_card.matchup, 'Tampa Bay Rays @ Baltimore Orioles');
  assert.equal(result.compact_card.signal.status, 'PICK');
  assert.equal(result.compact_card.composite.away_score, 81);
  assert.equal(result.compact_card.composite.home_score, 54);
  assert.equal(result.compact_card.price_inputs_used, false);
  assertNoForbiddenRuntimeLanguage(result.compact_card);
});

test('ambiguous MLB link is blocked without running a forced output', async () => {
  let compositeCalls = 0;
  const result = await analyzeCompositeMarketLink({
    url: AMBIGUOUS_MLB_URL,
    gameInputs: [TB_BAL_INPUT],
    compositeRunner: input => {
      compositeCalls += 1;
      return input;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.handled, true);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason_code, 'ambiguous_market_lane');
  assert.equal(result.route.route_status, 'AMBIGUOUS');
  assert.deepEqual(result.route.candidate_lanes, ['run_line', 'game_total']);
  assert.equal(compositeCalls, 0);
  assertNoForbiddenRuntimeLanguage(result.compact_card);
});

test('HTTP endpoint accepts one URL and returns the composite link card', async () => {
  const handler = createHttpRequestHandler({
    noteStore: createNoteStore('/tmp/cpc-link-composite-notes.json'),
    marketLinkAnalyzer: payload => analyzeCompositeMarketLink({
      ...payload,
      gameInputs: [TB_BAL_INPUT],
    }),
  });

  const response = await callJson(handler, {
    url: '/pipeline/analyze-link',
    body: { url: VALID_MLB_URL },
  });

  assert.equal(response.statusCode, 200);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.compact_card.pipeline, 'mlb_composite');
  assert.equal(parsed.compact_card.market_lane, 'moneyline');
  assert.equal(parsed.compact_card.signal.status, 'PICK');
  assertNoForbiddenRuntimeLanguage(parsed.compact_card);
});

test('MCP Kalshi URL tool uses the composite card for handled MLB links', async () => {
  const result = await analyzeKalshiMarketUrlTool(
    { url: VALID_MLB_URL },
    {
      marketLinkAnalyzer: payload => analyzeCompositeMarketLink({
        ...payload,
        gameInputs: [TB_BAL_INPUT],
      }),
    },
  );

  assert.equal(result.structuredContent.pipeline, 'mlb_composite');
  assert.equal(result.structuredContent.market_lane, 'moneyline');
  assert.equal(result.structuredContent.signal.status, 'PICK');
  assertNoForbiddenRuntimeLanguage(result.structuredContent);
});
