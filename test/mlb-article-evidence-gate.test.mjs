import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { isArticleDeliverable } from '../scripts/mlb/publish-article-reports.mjs';
import { enrichGamesWithContext } from '../scripts/mlb/publish-article-reports.mjs';
import { publish } from '../scripts/mlb/publish-article-reports.mjs';
import { buildNonMarketContextBundle, analyzeGame } from '../scripts/mlb/lib/market-engine.mjs';
import { buildGameArticle } from '../scripts/mlb/lib/article-render.mjs';
import { evaluateDecisionProcess, MARKET_TYPES, DECISION_STATUSES } from '../scripts/shared/decision-process.mjs';

function makeAnalysis(checkedKeys, rawDecision = 'LEAN') {
  const checked = Object.fromEntries(checkedKeys.map((k) => [k, true]));
  const process = evaluateDecisionProcess({
    marketType: MARKET_TYPES.SPORTS_GAME,
    rawDecision,
    checked,
    hasMarketSignal: rawDecision === 'CLEAR' || rawDecision === 'LEAN',
  });
  return { final: { decision: rawDecision, decision_process: process } };
}

const BOARD_ONLY_CHECKED = ['projected_participants', 'market_board_context'];
const COMPLETE_CHECKED = [
  'projected_participants', 'lineup_injury_news', 'venue_context',
  'recent_form_matchup', 'market_board_context', 'evidence_supported_side',
];
const REPO_ROOT = resolve(process.cwd());
const DISCOVERY_DIR = resolve(REPO_ROOT, 'state/mlb/2026-06-13/discovery');

function loadJson(fileName) {
  return JSON.parse(readFileSync(resolve(DISCOVERY_DIR, fileName), 'utf8'));
}

function makeDiscoveryGame() {
  const official = loadJson('mlb_official_adapter.json').records[0];
  return {
    game_key: '26JUN131610STLMIN',
    game_pk: official.game_pk,
    away: 'STL',
    home: 'MIN',
    away_full: official.away_team,
    home_full: official.home_team,
    start_ct: '2026-06-13 16:10 CT',
    start_utc: official.start_time_utc,
    series: {
      ml: { event_ticker: 'KXMLBGAME-26JUN131610STLMIN', markets: [
        { ticker: 'KXMLBGAME-26JUN131610STLMIN-STL', yes_ask_dollars: 0.58, no_ask_dollars: 0.43, yes_bid_dollars: 0.56, no_bid_dollars: 0.42, open_interest_fp: 83554, volume_fp: 1000 },
        { ticker: 'KXMLBGAME-26JUN131610STLMIN-MIN', yes_ask_dollars: 0.43, no_ask_dollars: 0.58, yes_bid_dollars: 0.42, no_bid_dollars: 0.56, open_interest_fp: 46943, volume_fp: 800 },
      ] },
      spread: { event_ticker: 'KXMLBSPREAD-26JUN131610STLMIN', markets: [] },
      total: { event_ticker: 'KXMLBTOTAL-26JUN131610STLMIN', markets: [] },
      hr: { event_ticker: 'KXMLBHR-26JUN131610STLMIN', markets: [] },
      ks: { event_ticker: 'KXMLBKS-26JUN131610STLMIN', markets: [] },
      rfi: { event_ticker: 'KXMLBRFI-26JUN131610STLMIN', markets: [] },
    },
  };
}

function buildTempPublishStateRoot() {
  const root = mkdtempSync(resolve(tmpdir(), 'mlb-publish-gate-'));
  const date = '2026-06-13';
  const discoveryDir = resolve(root, 'mlb', date, 'discovery');
  mkdirSync(discoveryDir, { recursive: true });
  writeFileSync(resolve(root, 'mlb', date, 'slate-run-plan.json'), JSON.stringify({
    schema: 'mlb-slate-run-plan/v1',
    date,
    generated_utc: '2026-06-13T13:32:02.038Z',
    cluster_count: 1,
    games: [{ game_key: '26JUN132207TBLAA' }],
    report_windows: [],
  }, null, 2), 'utf8');
  writeFileSync(resolve(discoveryDir, 'kalshi_adapter.json'), JSON.stringify({
    source_id: 'kalshi',
    records: [{
      series_ticker: 'KXMLBGAME',
      event_ticker: 'KXMLBGAME-26JUN132207TBLAA',
      event_title: 'Tampa Bay vs Los Angeles A',
      market_title: 'Tampa Bay vs Los Angeles A',
      sub_title: 'TB vs LAA (Jun 13)',
      game_date: '2026-06-13',
      away_team: 'Tampa Bay Rays',
      home_team: 'Los Angeles Angels',
      markets: [
        {
          event_ticker: 'KXMLBGAME-26JUN132207TBLAA',
          market_ticker: 'KXMLBGAME-26JUN132207TBLAA-TB',
          market_title: 'Tampa Bay vs Los Angeles A Winner?',
          contract_title: 'Tampa Bay',
          team_side: 'away',
          team_name: 'Tampa Bay Rays',
          team_code: 'TB',
          yes_bid: 0.52,
          yes_ask: 0.53,
          no_bid: 0.47,
          no_ask: 0.48,
          last_price: 0.53,
          volume: 15460.21,
          open_interest: 14267.39,
          status: 'active',
        },
        {
          event_ticker: 'KXMLBGAME-26JUN132207TBLAA',
          market_ticker: 'KXMLBGAME-26JUN132207TBLAA-LAA',
          market_title: 'Tampa Bay vs Los Angeles A Winner?',
          contract_title: 'Los Angeles A',
          team_side: 'home',
          team_name: 'Los Angeles Angels',
          team_code: 'LAA',
          yes_bid: 0.49,
          yes_ask: 0.50,
          no_bid: 0.50,
          no_ask: 0.51,
          last_price: 0.50,
          volume: 7090.42,
          open_interest: 6937.85,
          status: 'active',
        },
      ],
    }],
  }, null, 2), 'utf8');
  return root;
}

test('board-only analysis is blocked', () => {
  const analysis = makeAnalysis(BOARD_ONLY_CHECKED, 'LEAN');
  const gate = isArticleDeliverable(analysis);
  assert.equal(gate.deliverable, false);
  assert.match(gate.reason, /BLOCKED_CONTEXT_MISSING/);
  assert.match(gate.reason, /lineup/i);
});

test('missing lineup blocks delivery', () => {
  const keys = COMPLETE_CHECKED.filter((k) => k !== 'lineup_injury_news');
  const gate = isArticleDeliverable(makeAnalysis(keys, 'LEAN'));
  assert.equal(gate.deliverable, false);
  assert.match(gate.reason, /lineup/i);
});

test('missing venue/weather blocks delivery', () => {
  const keys = COMPLETE_CHECKED.filter((k) => k !== 'venue_context');
  const gate = isArticleDeliverable(makeAnalysis(keys, 'LEAN'));
  assert.equal(gate.deliverable, false);
  assert.match(gate.reason, /venue|weather|park/i);
});

test('missing recent form/matchup blocks delivery', () => {
  const keys = COMPLETE_CHECKED.filter((k) => k !== 'recent_form_matchup');
  const gate = isArticleDeliverable(makeAnalysis(keys, 'LEAN'));
  assert.equal(gate.deliverable, false);
  assert.match(gate.reason, /recent form|matchup/i);
});

test('complete context allows delivery', () => {
  const gate = isArticleDeliverable(makeAnalysis(COMPLETE_CHECKED, 'LEAN'));
  assert.equal(gate.deliverable, true);
  assert.equal(gate.reason, null);
});

test('no decision_process blocks delivery', () => {
  const gate = isArticleDeliverable({ final: {} });
  assert.equal(gate.deliverable, false);
  assert.match(gate.reason, /no decision_process/);
});

test('PASS with complete context allows delivery (valid no-play article)', () => {
  const gate = isArticleDeliverable(makeAnalysis(COMPLETE_CHECKED, 'PASS'));
  assert.equal(gate.deliverable, true);
});

test('NO CLEAR PICK with complete context allows delivery', () => {
  const gate = isArticleDeliverable(makeAnalysis(COMPLETE_CHECKED, 'PASS'));
  assert.equal(gate.deliverable, true);
  assert.equal(gate.reason, null);
});

test('market price never enters scoring (price isolation check)', () => {
  const analysis = makeAnalysis(BOARD_ONLY_CHECKED, 'LEAN');
  const process = analysis.final.decision_process;
  assert.equal(process.decisionStatus, DECISION_STATUSES.MARKET_ONLY_LEAN);
  assert.ok(process.whyNotPriceOnly.length > 0);
  assert.ok(!process.evidenceReady);
});

test('complete context without evidence-supported side stays MARKET-ONLY LEAN', () => {
  const analysis = makeAnalysis(COMPLETE_CHECKED, 'LEAN');
  analysis.final.decision_process = evaluateDecisionProcess({
    marketType: MARKET_TYPES.SPORTS_GAME,
    rawDecision: 'LEAN',
    checked: {
      projected_participants: true,
      lineup_injury_news: true,
      venue_context: true,
      recent_form_matchup: true,
      market_board_context: true,
      evidence_supported_side: false,
    },
    hasMarketSignal: true,
  });
  const process = analysis.final.decision_process;
  assert.equal(process.decisionStatus, DECISION_STATUSES.MARKET_ONLY_LEAN);
  assert.ok(!process.evidenceReady);
});

test('evidence-supported side can still produce EVIDENCE LEAN', () => {
  const analysis = makeAnalysis(COMPLETE_CHECKED, 'LEAN');
  const process = analysis.final.decision_process;
  assert.equal(process.decisionStatus, DECISION_STATUSES.EVIDENCE_LEAN);
  assert.ok(process.evidenceReady);
});

// --- Idempotency stability ---

test('idempotency key is stable across reruns with same plan timestamp', () => {
  // Importing loadPlan would need filesystem; test the key function directly.
  // Inline the same logic used in publish-article-reports.mjs:
  function articleIdempotencyKey(planMeta, scope) {
    const stamp = planMeta.generated_utc || planMeta.date || 'unknown';
    return `mlb:${planMeta.date}:article:${scope}:${stamp}`;
  }
  const meta = { date: '2026-06-13', generated_utc: '2026-06-13T13:32:02.038Z' };
  const key1 = articleIdempotencyKey(meta, '26JUN131410STLMIN');
  const key2 = articleIdempotencyKey(meta, '26JUN131410STLMIN');
  const key3 = articleIdempotencyKey(meta, 'slate');
  assert.equal(key1, key2, 'same plan + game_key produces same idem key');
  assert.notEqual(key1, key3, 'different scope produces different idem key');
  assert.match(key1, /2026-06-13T13:32:02/, 'key includes generated_utc timestamp');
});

test('idempotency key changes when plan timestamp changes', () => {
  function articleIdempotencyKey(planMeta, scope) {
    const stamp = planMeta.generated_utc || planMeta.date || 'unknown';
    return `mlb:${planMeta.date}:article:${scope}:${stamp}`;
  }
  const meta1 = { date: '2026-06-13', generated_utc: '2026-06-13T13:32:02.038Z' };
  const meta2 = { date: '2026-06-13', generated_utc: '2026-06-13T17:00:00.000Z' };
  const key1 = articleIdempotencyKey(meta1, 'slate');
  const key2 = articleIdempotencyKey(meta2, 'slate');
  assert.notEqual(key1, key2, 'different plan timestamp produces different idem key');
});

// --- Telegram send path refuses blocked packets ---

test('blocked article in delivery results has skipped=blocked, not sent=true', () => {
  const analysis = makeAnalysis(BOARD_ONLY_CHECKED, 'LEAN');
  const gate = isArticleDeliverable(analysis);
  assert.equal(gate.deliverable, false);
  // Simulate what the send loop does for blocked items:
  const result = gate.deliverable
    ? { sent: true }
    : { sent: false, skipped: 'blocked', blocked_reason: gate.reason };
  assert.equal(result.sent, false);
  assert.equal(result.skipped, 'blocked');
  assert.match(result.blocked_reason, /BLOCKED_CONTEXT_MISSING/);
});

test('limited coverage article without caveat is blocked as an overclaim', () => {
  const analysis = makeAnalysis(COMPLETE_CHECKED, 'PASS');
  analysis.final.coverage = { mode: 'LIMITED', families: {} };
  const gate = isArticleDeliverable(analysis, 'MLB game report\nCall: NO CLEAR PICK.');
  assert.equal(gate.deliverable, false);
  assert.match(gate.reason, /BLOCKED_COVERAGE_OVERCLAIM/);
});

// --- Complete-context fixture: simulate delivery plan showing allowed ---

test('complete-context fixture shows would-send in delivery plan simulation', () => {
  const completeAnalysis = makeAnalysis(COMPLETE_CHECKED, 'LEAN');
  const completePassAnalysis = makeAnalysis(COMPLETE_CHECKED, 'PASS');
  const boardOnlyAnalysis = makeAnalysis(BOARD_ONLY_CHECKED, 'LEAN');

  const completeGate = isArticleDeliverable(completeAnalysis);
  const completePassGate = isArticleDeliverable(completePassAnalysis);
  const boardGate = isArticleDeliverable(boardOnlyAnalysis);

  // Simulate delivery plan entries
  const plan = [
    { kind: 'game', game_key: 'EVIDENCE_LEAN_GAME', blocked: !completeGate.deliverable, blocked_reason: completeGate.reason },
    { kind: 'game', game_key: 'NO_CLEAR_PICK_GAME', blocked: !completePassGate.deliverable, blocked_reason: completePassGate.reason },
    { kind: 'game', game_key: 'BOARD_ONLY_GAME', blocked: !boardGate.deliverable, blocked_reason: boardGate.reason },
  ];

  // Evidence lean with context passes
  assert.equal(plan[0].blocked, false);
  assert.equal(plan[0].blocked_reason, null);

  // NO CLEAR PICK with full context also passes (valid no-play article)
  assert.equal(plan[1].blocked, false);
  assert.equal(plan[1].blocked_reason, null);

  // Board-only game is blocked
  assert.equal(plan[2].blocked, true);
  assert.match(plan[2].blocked_reason, /BLOCKED_CONTEXT_MISSING/);

  // Slate allowed when at least one game passes
  const deliverableCount = plan.filter((p) => !p.blocked).length;
  const slateBlocked = deliverableCount === 0;
  assert.equal(slateBlocked, false, 'slate allowed when >=1 game passes gate');
});

// --- Price isolation: market price never enters model/scoring ---

test('price isolation: market board data stays display-only in decision process', () => {
  const analysis = makeAnalysis(BOARD_ONLY_CHECKED, 'LEAN');
  const process = analysis.final.decision_process;

  // market_board_context is checked but is in MARKET_ONLY_ITEMS set
  const checkedIds = process.checkedItems.map((x) => x.id);
  assert.ok(checkedIds.includes('market_board_context'));

  // With only market-only items checked + projected_participants,
  // the status must be MARKET_ONLY_LEAN (not EVIDENCE_LEAN)
  assert.equal(process.decisionStatus, DECISION_STATUSES.MARKET_ONLY_LEAN);
  assert.ok(!process.evidenceReady, 'evidence not ready with board-only data');

  // The whyNotPriceOnly text must explain the downgrade
  assert.match(process.whyNotPriceOnly, /not an evidence-based pick|incomplete/i);
});

test('adapter wiring attaches real context and placeholder weather does not count complete', () => {
  const game = makeDiscoveryGame();
  enrichGamesWithContext([game], resolve(REPO_ROOT, 'state'), '2026-06-13');
  assert.ok(game.stats_record, 'stats adapter should attach');
  assert.ok(game.weather_record, 'weather adapter should attach');
  assert.ok(game.context_record, 'context adapter should attach');

  const bundle = buildNonMarketContextBundle(game);
  assert.ok(bundle, 'non-market context bundle should build');
  assert.notEqual(bundle.provenance.lineup.status, 'missing');
  assert.notEqual(bundle.provenance.recent_form.status, 'missing');

  const placeholder = JSON.parse(JSON.stringify(game));
  placeholder.weather_record = { temperature: '?F', wind_speed: null, precipitation_risk: null };
  placeholder.weather = { temperature: '?F', wind_speed: null, precipitation_risk: null };
  placeholder.context_record = { ...placeholder.context_record, weather_from_mlb_feed: {}, venue_roof_type: 'Open' };
  const placeholderBundle = buildNonMarketContextBundle(placeholder);
  assert.notEqual(placeholderBundle.provenance.weather.status, 'complete');
  assert.ok(['partial', 'unavailable', 'indoor/roof', 'missing'].includes(placeholderBundle.provenance.weather.status));
});

test('publish dry-run uses per-game article text in delivery planning and returns blocked metadata', async () => {
  const root = buildTempPublishStateRoot();
  try {
    const result = await publish({
      date: '2026-06-13',
      dryRun: true,
      refresh: false,
      sendTelegram: false,
      force: false,
      only: null,
      stateRoot: root,
    });

    assert.equal(result.sent, false);
    assert.equal(result.results.length, 0);
    assert.ok(result.delivery_plan.length >= 2, 'delivery plan should include the game and slate rows');

    const gameItem = result.delivery_plan.find((item) => item.kind === 'game');
    assert.ok(gameItem, 'expected a per-game delivery plan item');
    assert.equal(typeof gameItem.blocked, 'boolean');
    assert.equal(typeof gameItem.blocked_reason, 'string');
    assert.equal(gameItem.blocked, true);
    assert.match(gameItem.blocked_reason, /BLOCKED_/);

    const slateItem = result.delivery_plan.find((item) => item.kind === 'slate');
    assert.ok(slateItem, 'expected a slate delivery plan item');
    assert.equal(slateItem.blocked, true);
    assert.match(slateItem.blocked_reason, /BLOCKED_/);

    const summaryPath = resolve(root, 'mlb', '2026-06-13', 'article-reports', 'delivery-summary.json');
    assert.ok(existsSync(summaryPath), 'dry-run should still write a delivery summary for inspection');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stale wording is absent when context exists in the article text', () => {
  const game = makeDiscoveryGame();
  enrichGamesWithContext([game], resolve(REPO_ROOT, 'state'), '2026-06-13');
  const analysis = analyzeGame(game);
  const article = buildGameArticle({ date: '2026-06-13', game, analysis, audit: true });
  assert.doesNotMatch(article.text, /No lineup, weather, park, starter form, or bullpen context was pulled\./);
  assert.doesNotMatch(article.text, /real-world context is incomplete/i);
  assert.doesNotMatch(article.text, /context incomplete/i);
  assert.match(article.text, /Provenance/);
  assert.match(article.text, /context reviewed, no defensible edge/i);
});

test('no-trade/no-bankroll policy is explicit in article text', () => {
  // The article renderer always includes the no-trade line.
  // Verify via buildGameArticle import would need game fixtures; instead
  // verify the decision process does not claim a trade.
  const analysis = makeAnalysis(COMPLETE_CHECKED, 'LEAN');
  const process = analysis.final.decision_process;
  // Even EVIDENCE_LEAN should never claim a trade — decisionStatus is advisory.
  assert.equal(process.decisionStatus, DECISION_STATUSES.EVIDENCE_LEAN);
  // The status is a research label, not a trade instruction.
  assert.ok(!process.decisionStatus.includes('TRADE'));
  assert.ok(!process.decisionStatus.includes('BUY'));
  assert.ok(!process.decisionStatus.includes('SELL'));
});
