import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';

import { buildPrompt, runNascarLiveResearch, BLOCKED_LIVE_RESEARCH_MISSING } from '../scripts/nascar/live-research.mjs';
import { buildRacePacket } from '../scripts/packets/generate-nascar-sunday.mjs';
import { validateCpcCustomerPacket } from '../scripts/packets/lib/cpc-packet-validator.mjs';

const require = createRequire(import.meta.url);
const { auditPrompt } = require('../src/sports/perplexityClient.js');

function nascarEvent(overrides = {}) {
  return {
    event_ticker: 'KXNASCARRACE-TEST26',
    title: 'Test 400 Winner',
    venue: 'Test Speedway',
    product_metadata: { competition: 'NASCAR Cup Series' },
    markets: [
      { ticker: 'KXNASCARRACE-TEST26-HAML', yes_sub_title: 'Denny Hamlin' },
      { ticker: 'KXNASCARRACE-TEST26-LARS', yes_sub_title: 'Kyle Larson' },
      { ticker: 'KXNASCARRACE-TEST26-BELL', yes_sub_title: 'Christopher Bell' },
    ],
    ...overrides,
  };
}

function liveResearchFixture() {
  const fetchedUtc = '2026-07-05T12:00:00.000Z';
  return {
    generated_utc: fetchedUtc,
    event_ticker: 'KXNASCARRACE-TEST26',
    model: 'sonar',
    disclaimer: 'Display-only narrative research.',
    source_urls: [
      { url: 'https://www.nascar.com/schedule', title: 'NASCAR schedule' },
      { url: 'https://www.nascar.com/stats', title: 'NASCAR stats' },
    ],
    layers: {
      race_event_identity: {
        status: 'ok',
        notes: 'Test 400 at Test Speedway.',
        sources: [{ url: 'https://www.nascar.com/schedule', title: 'NASCAR schedule' }],
        fetched_utc: fetchedUtc,
      },
      entry_list_drivers: {
        status: 'ok',
        notes: 'Denny Hamlin, Kyle Larson, and Christopher Bell are entered.',
        sources: [{ url: 'https://www.nascar.com/stats', title: 'NASCAR stats' }],
        fetched_utc: fetchedUtc,
      },
      qualifying_starting_order: {
        status: 'ok',
        notes: 'Starting order is posted.',
        sources: [{ url: 'https://www.nascar.com/stats', title: 'NASCAR stats' }],
        fetched_utc: fetchedUtc,
      },
      practice_speed: {
        status: 'ok',
        notes: 'Hamlin showed the best pace in practice.',
        sources: [{ url: 'https://www.nascar.com/stats', title: 'NASCAR stats' }],
        fetched_utc: fetchedUtc,
      },
      recent_driver_form: {
        status: 'ok',
        notes: 'Larson and Bell carry strong recent form.',
        sources: [{ url: 'https://www.nascar.com/stats', title: 'NASCAR stats' }],
        fetched_utc: fetchedUtc,
      },
      track_history_gen7_comparables: {
        status: 'ok',
        notes: 'Hamlin and Larson both have strong track history.',
        sources: [{ url: 'https://www.nascar.com/stats', title: 'NASCAR stats' }],
        fetched_utc: fetchedUtc,
      },
      team_manufacturer_notes: {
        status: 'ok',
        notes: 'Toyota and Hendrick notes look stable.',
        sources: [{ url: 'https://www.nascar.com/stats', title: 'NASCAR stats' }],
        fetched_utc: fetchedUtc,
      },
      penalties_inspection_news: {
        status: 'missing',
        notes: null,
        sources: [],
        fetched_utc: fetchedUtc,
      },
      weather_track_condition: {
        status: 'ok',
        notes: 'Dry conditions are expected.',
        sources: [{ url: 'https://www.weather.gov', title: 'Weather' }],
        fetched_utc: fetchedUtc,
      },
    },
    drivers: [
      {
        driver: 'Denny Hamlin',
        notes: 'Top practice pace and strong history at the track.',
        sources: [{ url: 'https://www.nascar.com/stats', title: 'NASCAR stats' }],
        fetched_utc: fetchedUtc,
        layer: 'practice_speed',
      },
      {
        driver: 'Kyle Larson',
        notes: 'Recent form remains strong.',
        sources: [{ url: 'https://www.nascar.com/stats', title: 'NASCAR stats' }],
        fetched_utc: fetchedUtc,
        layer: 'recent_driver_form',
      },
    ],
  };
}

function clientFromContent(content, model = 'sonar') {
  return async () => ({
    ok: true,
    _meta: { model },
    content,
  });
}

function fencedPayloadContent() {
  return `\`\`\`json\n${JSON.stringify(liveResearchFixture(), null, 2)}\n\`\`\``;
}

function proseWrappedPayloadContent() {
  return `Here is the research: ${JSON.stringify(liveResearchFixture())}`;
}

test('runNascarLiveResearch writes the expected artifact from a fenced payload and refreshes source registry', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'cpc-nascar-live-research-'));
  const date = '2026-07-05';
  try {
    const result = await runNascarLiveResearch({
      date,
      event: nascarEvent(),
      stateRoot: tmpRoot,
      env: { PERPLEXITY_API_KEY: 'test-key' },
      client: clientFromContent(fencedPayloadContent()),
    });

    assert.equal(result.ok, true);
    assert.equal(result.code, 'LIVE_RESEARCH_OK');
    assert.ok(existsSync(result.artifact_path), 'artifact written');
    assert.ok(existsSync(result.registry_path), 'source registry written');

    const artifact = JSON.parse(readFileSync(result.artifact_path, 'utf8'));
    assert.equal(artifact.event_ticker, 'KXNASCARRACE-TEST26');
    assert.equal(artifact.model, 'sonar');
    assert.ok(Array.isArray(artifact.source_urls));
    assert.ok(artifact.source_urls.length >= 1);
    assert.equal(artifact.layers.race_event_identity.status, 'ok');
    assert.equal(artifact.layers.penalties_inspection_news.status, 'missing');
    assert.ok(Array.isArray(artifact.drivers));
    assert.equal(artifact.drivers[0].driver, 'Denny Hamlin');
    assert.match(artifact.disclaimer, /Display-only/);

    const registry = JSON.parse(readFileSync(result.registry_path, 'utf8'));
    assert.equal(registry.checked_at_utc, artifact.generated_utc);
    assert.equal(registry.sources.perplexity_live_research.checked_at_utc, artifact.generated_utc);
    assert.equal(registry.sources.perplexity_live_research.source_id, 'perplexity_live_research');
    assert.ok(Array.isArray(registry.sources.perplexity_live_research.source_urls));
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('runNascarLiveResearch parses prose-wrapped payloads and retries once after transient failures', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'cpc-nascar-live-research-prose-'));
  const date = '2026-07-05';
  try {
    const proseResult = await runNascarLiveResearch({
      date,
      event: nascarEvent(),
      stateRoot: tmpRoot,
      env: { PERPLEXITY_API_KEY: 'test-key' },
      client: clientFromContent(proseWrappedPayloadContent()),
    });

    assert.equal(proseResult.ok, true);
    assert.equal(proseResult.code, 'LIVE_RESEARCH_OK');
    assert.ok(existsSync(proseResult.artifact_path), 'artifact written for prose-wrapped payload');

    let parseCalls = 0;
    const parseRetryResult = await runNascarLiveResearch({
      date,
      event: nascarEvent(),
      stateRoot: tmpRoot,
      env: { PERPLEXITY_API_KEY: 'test-key' },
      client: async () => {
        parseCalls += 1;
        return parseCalls === 1
          ? { ok: true, _meta: { model: 'sonar' }, content: 'garbage' }
          : { ok: true, _meta: { model: 'sonar' }, content: JSON.stringify(liveResearchFixture()) };
      },
    });

    assert.equal(parseRetryResult.ok, true);
    assert.equal(parseRetryResult.code, 'LIVE_RESEARCH_OK');
    assert.equal(parseCalls, 2);

    let throwCalls = 0;
    const throwRetryResult = await runNascarLiveResearch({
      date,
      event: nascarEvent(),
      stateRoot: tmpRoot,
      env: { PERPLEXITY_API_KEY: 'test-key' },
      client: async () => {
        throwCalls += 1;
        if (throwCalls === 1) throw new Error('transient client failure');
        return { ok: true, _meta: { model: 'sonar' }, content: JSON.stringify(liveResearchFixture()) };
      },
    });

    assert.equal(throwRetryResult.ok, true);
    assert.equal(throwRetryResult.code, 'LIVE_RESEARCH_OK');
    assert.equal(throwCalls, 2);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('runNascarLiveResearch fails closed without a key or after repeated parse failure', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'cpc-nascar-live-research-blocked-'));
  const date = '2026-07-05';
  try {
    const blocked = await runNascarLiveResearch({
      date,
      event: nascarEvent(),
      stateRoot: tmpRoot,
      env: {},
      client: async () => {
        throw new Error('should not be called without a key');
      },
    });

    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, BLOCKED_LIVE_RESEARCH_MISSING);
    assert.equal(existsSync(blocked.artifact_path), false);
    assert.equal(existsSync(blocked.registry_path), false);

    let calls = 0;
    const failed = await runNascarLiveResearch({
      date,
      event: nascarEvent(),
      stateRoot: tmpRoot,
      env: { PERPLEXITY_API_KEY: 'test-key' },
      client: async () => {
        calls += 1;
        return { ok: true, _meta: { model: 'sonar' }, content: 'still not json' };
      },
    });

    assert.equal(failed.ok, false);
    assert.equal(failed.code, BLOCKED_LIVE_RESEARCH_MISSING);
    assert.equal(existsSync(failed.artifact_path), false);
    assert.equal(existsSync(failed.registry_path), false);
    assert.equal(calls, 2);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('buildPrompt keeps dynamic NASCAR identifiers inside the policy block', () => {
  const prompt = buildPrompt({
    date: '2026-07-05',
    event: {
      title: 'United Rentals 300',
      venue: 'Pocono',
      event_ticker: 'KXNASCARRACE-UNIR26',
      product_metadata: { competition: 'NASCAR Cup Series' },
    },
    driverNames: [],
  });

  assert.equal(auditPrompt(prompt.user, { skipPolicyBlock: true }).safe, true);
  assert.equal(auditPrompt(prompt.system, { skipPolicyBlock: true }).safe, true);
});

test('NASCAR packet renders the live research section and keeps price isolation', () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'cpc-nascar-live-packet-'));
  const date = '2026-07-05';
  const ceilingPath = join(tmpRoot, 'ceiling_board.json');
  writeFileSync(ceilingPath, `${JSON.stringify({
    ceilings: [
      {
        driver_name: 'Denny Hamlin',
        ceiling_label: 'Win lane ceiling',
        lane_type: 'win',
        pool_entry_reason: 'top-tier model fit',
        basis: 'composite score',
      },
    ],
    source: ceilingPath,
    userFacingLines: ['- Denny Hamlin win lane ceiling'],
    fieldBucket: { summary: 'field bucket summary' },
  }, null, 2)}\n`);

  try {
    const packet = buildRacePacket({
      date,
      event: nascarEvent(),
      sourcePath: '/tmp/nascar-event.json',
      artifacts: [ceilingPath],
      workspaceResult: null,
      stateRoot: tmpRoot,
      liveResearch: liveResearchFixture(),
    });

    assert.match(packet.text, /--- Live Research \(Perplexity\) ---/);
    assert.match(packet.text, /evidence_ledger:/);
    assert.match(packet.text, /Missing layers:/);
    assert.match(packet.text, /- penalties_inspection_news/);
    assert.doesNotMatch(packet.text, /score=|odds=|probability=|confidence=/i);

    const validation = validateCpcCustomerPacket(packet.text);
    assert.equal(validation.valid, true, validation.errors.join('; '));
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
