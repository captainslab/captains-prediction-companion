import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPipelineService } from '../src/pipelineService.js';

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
    runMarketAnalysis: async (input) => buildReadyCard(input.url, 'KXSEED-1'),
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
