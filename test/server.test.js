import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNoteStore } from '../src/noteStore.js';
import { buildEventMarketPlan, buildEventMarketPlanSummary } from '../src/eventMarketTool.js';
import { buildEventMarketWorkflowPrompt } from '../src/eventMarketPrompt.js';

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
  const result = await buildEventMarketPlan({
    venue: 'Kalshi',
    url: 'https://kalshi.com/markets/kxtrumpmentionb/trump-mention-b/KXTRUMPMENTIONB-26MAR27?utm_source=kalshiapp_eventpage',
  });

  assert.equal(result.plan.venue, 'Kalshi');
  assert.equal(result.plan.domain, 'mention');
  assert.equal(result.plan.metadata.market_id, 'KXTRUMPMENTIONB-26MAR27');
  assert.match(result.plan.metadata.url, /kalshi\.com/);
  assert.equal(result.workflow.name, 'mention-market-research');
});

test('event market plan summary stays compact and hides the workflow memo', async () => {
  const result = await buildEventMarketPlan({
    venue: 'Kalshi',
    url: 'https://kalshi.com/markets/kxtrumpmentionb/trump-mention-b/KXTRUMPMENTIONB-26MAR27?utm_source=kalshiapp_eventpage',
  });
  const summary = buildEventMarketPlanSummary(result);

  assert.deepEqual(summary.source, {
    platform: 'Kalshi',
    url: 'https://kalshi.com/markets/kxtrumpmentionb/trump-mention-b/KXTRUMPMENTIONB-26MAR27?utm_source=kalshiapp_eventpage',
    market_id: 'KXTRUMPMENTIONB-26MAR27',
  });
  assert.equal(summary.event_domain, 'media');
  assert.equal(summary.market_type, 'mention');
  assert.equal(summary.status, 'insufficient_context');
  assert.equal(summary.confidence, 'low');
  assert.equal(summary.summary.recommendation, 'pass');
  assert.match(summary.summary.one_line_reason, /lacks enough event detail/i);
  assert.equal(summary.next_action, 'confirm_event_context');
  assert.equal(Object.hasOwn(summary, 'workflow'), false);
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
  assert.match(prompt.messages[0].content.text, /event_market_plan/);
  assert.match(prompt.messages[0].content.text, /background only/);
  assert.match(prompt.messages[0].content.text, /compact user-facing card/i);
  assert.match(prompt.messages[1].content.text, /KX123/);
});
