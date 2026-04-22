import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPipelineService } from '../src/pipelineService.js';
import { runHermesOracle } from '../src/hermesOracle.js';
import { resolveHermesCommand } from '../src/hermesRuntime.js';

const RECENT_URL =
  'https://kalshi.com/markets/kxtrumpmention/what-will-trump-say/KXTRUMPMENTION-26MAR27?utm_source=kalshiapp_eventpage';
const SEED_URL =
  'https://kalshi.com/markets/kxpoliticsmention/general-politics/KXPOLITICSMENTION-26MAR27D?utm_source=kalshiapp_eventpage';

function buildReadyCard(url, ticker = 'KXTEST-1') {
  return {
    user_facing: {
      source: {
        platform: 'Kalshi',
        url,
        market_id: ticker,
      },
      event_domain: 'politics',
      event_type: 'speech',
      market_type: 'mention',
      status: 'ready',
      confidence: 'medium',
      summary: {
        headline: 'The mention contract is priced and the alpha pipeline has a directional edge.',
        recommendation: 'buy_no',
        one_line_reason: 'The pipeline found an active mention market with a negative edge on YES.',
      },
      next_action: 'review_market_rules',
      context: {
        speaker: 'Donald Trump',
        event_name: 'Remarks at FII PRIORITY Summit',
      },
      market_view: {
        target_phrase: 'Oil',
        available_contracts: [],
        watch_for: ['transcript release'],
        trade_view: {
          market_ticker: ticker,
          market_status: 'active',
          market_yes: 0.79,
          market_yes_bid: 0.71,
          market_yes_ask: 0.87,
          last_price: 0.84,
          fair_yes: 0.75,
          edge_cents: -4,
        },
      },
    },
  };
}

function buildNoEdgeBoard(url, ticker = 'KXNOEDGE-1') {
  return {
    user_facing: {
      source: {
        platform: 'Kalshi',
        url,
        market_id: ticker,
      },
      event_domain: 'general',
      event_type: 'general',
      market_type: 'general',
      status: 'ready',
      confidence: 'low',
      summary: {
        headline: 'The board has no actionable edge.',
        recommendation: 'pass',
        one_line_reason: 'Pricing is too close to fair value to act.',
      },
      next_action: 'watch_market',
      context: {},
      market_view: {
        available_contracts: [
          {
            market_ticker: `${ticker}-A`,
            label: 'Alpha',
            market_yes: 0.5,
            yes_bid: 0.49,
            yes_ask: 0.51,
            last_price: 0.5,
          },
          {
            market_ticker: `${ticker}-B`,
            label: 'Beta',
            market_yes: 0.5,
            yes_bid: 0.49,
            yes_ask: 0.51,
            last_price: 0.5,
          },
        ],
        trade_view: {
          market_ticker: ticker,
          market_status: 'active',
          fair_yes: 0.5,
          edge_cents: 0,
        },
      },
    },
  };
}

test('pipeline service runs research for the most recent analyzed URL and persists completed status', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-service-'));
  const stateFile = join(dir, 'pipeline-state.json');
  const calls = [];

  const service = createPipelineService({
    stateFile,
    seedUrls: [SEED_URL],
    now: () => new Date('2026-04-22T12:00:00.000Z'),
    defaultModels: {
      implications: 'env-implications',
      validation: 'env-validation',
    },
    runMarketAnalysis: async (input, options) => {
      calls.push({ input, options });
      return buildReadyCard(input.url, 'KXRECENT-1');
    },
  });

  service.recordRecentUrl(RECENT_URL);

  const initialStatus = service.getStatus();
  assert.equal(initialStatus.production.last_run, null);
  assert.deepEqual(initialStatus.default_models, {
    implications: 'env-implications',
    validation: 'env-validation',
  });

  await service.runProduction({
    full: false,
    max_events: 1,
    implications_model: 'chosen-implications-model',
    validation_model: 'chosen-validation-model',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.url, RECENT_URL);
  assert.equal(calls[0].options.alphaModel, 'chosen-implications-model');
  assert.equal(calls[0].options.validationModel, 'chosen-validation-model');

  const status = service.getStatus();
  assert.equal(status.running, false);
  assert.equal(status.current_step, null);
  assert.equal(status.step_progress?.completed_count, 8);
  assert.equal(status.production.total_events, 1);
  assert.equal(status.production.total_entities, 1);
  assert.equal(status.production.total_edges, 1);
  assert.equal(status.production.last_run?.status, 'completed');
  assert.equal(status.production.last_run?.events_processed, 1);
  assert.equal(status.production.last_run?.new_events, 1);

  const rawState = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(rawState.results.length, 1);
  assert.equal(rawState.results[0].source.url, RECENT_URL);
  assert.equal(rawState.recent_urls[0], RECENT_URL);

  rmSync(dir, { recursive: true, force: true });
});

test('pipeline service falls back safely when Hermes returns unusable output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-service-hermes-fallback-'));
  const stateFile = join(dir, 'pipeline-state.json');
  const outputFile = join(dir, 'pipeline-card-outputs.json');
  const previousHermesCommand = process.env.HERMES_COMMAND;

  process.env.HERMES_COMMAND = 'definitely-not-a-real-hermes-binary';

  try {
    const service = createPipelineService({
      stateFile,
      outputFile,
      seedUrls: [SEED_URL],
      now: () => new Date('2026-04-22T12:00:00.000Z'),
    });

    service.recordRecentUrl(RECENT_URL);
    await service.runProduction({ full: false, max_events: 1 });

    const output = JSON.parse(readFileSync(outputFile, 'utf8'));
    assert.equal(Array.isArray(output), true);
    assert.equal(output.length, 1);
    assert.equal(output[0].run_id, 1);
    assert.equal(output[0].cards.length, 1);
    assert.equal(output[0].cards[0].url, RECENT_URL);
    assert.equal(output[0].cards[0].board_url, RECENT_URL);
    assert.match(output[0].cards[0].summary_headline, /live oracle|source-backed|Hermes research fallback/i);
    assert.match(output[0].cards[0].recommendation, /watch|pass/);
    assert.match(output[0].cards[0].board_recommendation, /watch|pass/);
    assert.equal(output[0].cards[0].confidence, 'low');
    assert.equal(output[0].cards[0].board_confidence, 'low');
    assert.equal(typeof output[0].cards[0].board_no_edge_reason_code, 'string');
    assert.equal(typeof output[0].cards[0].no_edge_reason_code, 'string');
    assert.match(output[0].cards[0].no_edge_reason, /manual classification|fallback|fell back|unusable structured evidence|live Hermes oracle|structured decision/i);
    assert.equal(Array.isArray(output[0].cards[0].child_contracts), true);
  } finally {
    if (previousHermesCommand === undefined) {
      delete process.env.HERMES_COMMAND;
    } else {
      process.env.HERMES_COMMAND = previousHermesCommand;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runHermesOracle accepts strong live oracle output with structured reasoning', async () => {
  const oracleBoard = await runHermesOracle(
    {
      board_url: RECENT_URL,
      official_source_url: 'https://www.sec.gov/example',
      official_source_type: 'sec_8k_exhibit_99_1',
      transcript_excerpt: 'Management said the phrase during the official earnings update.',
      research_summary: 'Official issuer source located.',
      source_quality: 'high',
      evidence_strength: 'high',
      user_facing: buildReadyCard(RECENT_URL, 'KXTEST-ORACLE').user_facing,
    },
    { url: RECENT_URL },
    {
      forceOracleCall: true,
      localPlan: buildReadyCard(RECENT_URL, 'KXTEST-ORACLE'),
      oracleChatRunner: async () => ({
        ok: true,
        parsed: {
          board_headline: 'The live oracle sees mild YES overpricing into the event window.',
          board_recommendation: 'buy_no',
          board_confidence: 'medium',
          edge_type: 'market_structure',
          catalyst: 'earnings-call Q&A timing',
          reasoning_chain: [
            '[timing/catalyst insight] This is a live earnings-call board and Q&A often broadens topic coverage late in the event.',
            '[market-structure mismatch] The market is leaning too hard on immediate phrase certainty relative to the fair probability implied by the source packet and pricing context.'
          ],
          invalidation_condition: 'If the official transcript confirms the exact phrase early, the short thesis fails.',
          time_sensitivity: 'high'
        }
      })
    }
  );

  assert.equal(oracleBoard.board_recommendation, 'buy_no');
  assert.equal(oracleBoard.edge_type, 'market_structure');
  assert.equal(oracleBoard.catalyst, 'earnings-call Q&A timing');
  assert.equal(oracleBoard.time_sensitivity, 'high');
  assert.equal(oracleBoard.board_no_edge_reason_code, null);
  assert.match(oracleBoard.reasoning_chain[0], /timing\/catalyst insight/i);
  assert.match(oracleBoard.reasoning_chain[1], /market-structure mismatch/i);
  assert.equal(
    oracleBoard.invalidation_condition,
    'If the official transcript confirms the exact phrase early, the short thesis fails.'
  );
});

test('runHermesOracle explicitly downgrades weak live oracle output when evidence is missing or generic', async () => {
  const oracleBoard = await runHermesOracle(
    {
      board_url: RECENT_URL,
      research_summary: 'No verified official source packet was available.',
      unresolved_gaps: ['Official source missing'],
      user_facing: buildReadyCard(RECENT_URL, 'KXTEST-WEAK').user_facing,
    },
    { url: RECENT_URL },
    {
      forceOracleCall: true,
      localPlan: buildReadyCard(RECENT_URL, 'KXTEST-WEAK'),
      oracleChatRunner: async () => ({
        ok: true,
        parsed: {
          board_headline: 'Weak live oracle output',
          board_recommendation: 'buy_yes',
          board_confidence: 'medium',
          edge_type: 'information',
          catalyst: 'possible mention',
          reasoning_chain: ['Weak signal', 'Unclear setup'],
          invalidation_condition: 'If evidence changes.',
          time_sensitivity: 'high'
        }
      })
    }
  );

  assert.equal(oracleBoard.board_recommendation, 'watch');
  assert.equal(oracleBoard.edge_type, 'none');
  assert.match(oracleBoard.board_no_edge_reason_code, /evidence|oracle|research/i);
  assert.match(oracleBoard.board_no_edge_reason, /missing|generic|official-source|evidence/i);
});

test('pipeline service persists oracle reasoning metadata without breaking board output', async () => {
  const oracleBoard = await runHermesOracle(
    {
      board_url: RECENT_URL,
      board_headline: 'Hermes board analysis',
      board_recommendation: 'watch',
      board_confidence: 'low',
      board_no_edge_reason_code: 'manual_classification_required',
      board_no_edge_reason: 'The board stayed on watch because Hermes returned no actionable edge with verifiable official-source evidence.',
      edge_type: 'information',
      catalyst: 'speech',
      reasoning_chain: ['[behavioral tendency] Speaker format is known', '[timing/catalyst insight] The exact phrase is still unverified'],
      invalidation_condition: 'If the exact phrase appears in the official source, the watch status should be removed.',
      time_sensitivity: 'high',
      child_contracts: [
        {
          ticker: 'KXTEST-ORACLE',
          label: 'Test Oracle',
          yes_bid: 0.1,
          yes_ask: 0.2,
          last_price: 0.15,
          source_url: RECENT_URL,
          transcript_excerpt: 'sample excerpt',
          phrase_found: false,
          evidence: ['official source missing exact phrase'],
        },
      ],
      user_facing: {
        source: {
          platform: 'Kalshi',
          url: RECENT_URL,
          market_id: 'KXTEST-ORACLE',
        },
        event_domain: 'politics',
        event_type: 'speech',
        market_type: 'mention',
        status: 'ready',
        confidence: 'low',
        summary: {
          headline: 'Hermes board analysis',
          recommendation: 'watch',
          one_line_reason: 'The exact phrase remains unverified.',
        },
        next_action: 'review_market_rules',
        context: {},
        market_view: {
          available_contracts: [],
          trade_view: {
            market_ticker: 'KXTEST-ORACLE',
            market_status: 'active',
            fair_yes: 0.5,
            edge_cents: 0,
          },
        },
      },
    },
    { url: RECENT_URL },
    { localPlan: buildReadyCard(RECENT_URL, 'KXTEST-ORACLE') }
  );

  assert.equal(oracleBoard.edge_type, 'information');
  assert.equal(oracleBoard.catalyst, 'speech');
  assert.deepEqual(oracleBoard.reasoning_chain, [
    '[behavioral tendency] Speaker format is known',
    '[timing/catalyst insight] The exact phrase is still unverified',
    '[probability gap] Implied market probability is 79% YES while local fair probability is 75% YES, leaving a -4c gap that needs source-backed explanation.'
  ]);
  assert.equal(
    oracleBoard.invalidation_condition,
    'If the exact phrase appears in the official source, the watch status should be removed.'
  );
  assert.equal(oracleBoard.time_sensitivity, 'high');

  const dir = mkdtempSync(join(tmpdir(), 'pipeline-service-oracle-metadata-'));
  const stateFile = join(dir, 'pipeline-state.json');
  const outputFile = join(dir, 'pipeline-card-outputs.json');
  const service = createPipelineService({
    stateFile,
    outputFile,
    seedUrls: [RECENT_URL],
    now: () => new Date('2026-04-22T12:00:00.000Z'),
    runMarketAnalysis: async () => oracleBoard,
  });

  service.recordRecentUrl(RECENT_URL);
  await service.runProduction({ full: false, max_events: 1 });

  const output = JSON.parse(readFileSync(outputFile, 'utf8'));
  assert.equal(output[0].cards[0].board_recommendation, 'watch');
  assert.equal(output[0].cards[0].board_no_edge_reason_code, 'manual_classification_required');
  assert.equal(output[0].cards[0].edge_type, 'information');
  assert.equal(output[0].cards[0].catalyst, 'speech');
  assert.deepEqual(output[0].cards[0].reasoning_chain, [
    '[behavioral tendency] Speaker format is known',
    '[timing/catalyst insight] The exact phrase is still unverified',
    '[probability gap] Implied market probability is 79% YES while local fair probability is 75% YES, leaving a -4c gap that needs source-backed explanation.'
  ]);
  assert.equal(
    output[0].cards[0].invalidation_condition,
    'If the exact phrase appears in the official source, the watch status should be removed.'
  );
  assert.equal(output[0].cards[0].time_sensitivity, 'high');

  rmSync(dir, { recursive: true, force: true });
});

test('pipeline reset clears persisted research state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-service-reset-'));
  const stateFile = join(dir, 'pipeline-state.json');

  const service = createPipelineService({
    stateFile,
    seedUrls: [SEED_URL],
    now: () => new Date('2026-04-22T12:00:00.000Z'),
    defaultModels: {
      implications: 'env-implications',
      validation: 'env-validation',
    },
    runMarketAnalysis: async input => buildReadyCard(input.url, 'KXSEED-1'),
  });

  await service.runProduction({ full: true, max_events: 1 });
  service.reset();

  const status = service.getStatus();
  assert.equal(status.running, false);
  assert.equal(status.current_step, null);
  assert.equal(status.production.total_events, 0);
  assert.equal(status.production.total_entities, 0);
  assert.equal(status.production.total_edges, 0);
  assert.equal(status.production.last_run, null);
  assert.equal(status.step_progress, null);

  const rawState = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.deepEqual(rawState.results, []);
  assert.deepEqual(rawState.recent_urls, []);

  rmSync(dir, { recursive: true, force: true });
});
