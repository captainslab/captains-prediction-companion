import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';

import { buildPrompt, runNascarLiveResearch, BLOCKED_LIVE_RESEARCH_MISSING } from '../scripts/nascar/live-research.mjs';
import { buildRacePacket } from '../scripts/packets/generate-nascar-sunday.mjs';
import { evaluateNascarEventIdentity, evaluateNascarRaceReadiness } from '../scripts/nascar/lib/race-quality-gate.mjs';
import { validateCpcCustomerPacket } from '../scripts/packets/lib/cpc-packet-validator.mjs';
import { validatePacketText } from '../scripts/cron/cpc-packet-janitor.mjs';

const require = createRequire(import.meta.url);
const { auditPrompt } = require('../src/sports/perplexityClient.js');

function nascarEvent(overrides = {}) {
  return {
    event_ticker: 'KXNASCARRACE-TEST26',
    title: 'Test 400 Winner',
    venue: 'Test Speedway',
    scheduled_start_utc: '2026-07-05T19:00:00.000Z',
    product_metadata: {
      competition: 'NASCAR Cup Series',
      race_name: 'Test 400',
      track: 'Test Speedway',
      scheduled_start_utc: '2026-07-05T19:00:00.000Z',
      date: '2026-07-05',
    },
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

function liveResearchAllOkFixture() {
  const fixture = liveResearchFixture();
  fixture.layers.penalties_inspection_news = {
    status: 'ok',
    notes: 'No penalties or inspection issues reported.',
    sources: [{ url: 'https://www.nascar.com/stats', title: 'NASCAR stats' }],
    fetched_utc: fixture.generated_utc,
  };
  return fixture;
}

function writeRaceQualityState(tmpRoot, date) {
  const root = join(tmpRoot, 'nascar', date);
  const discoveryDir = join(root, 'discovery');
  mkdirSync(discoveryDir, { recursive: true });
  writeFileSync(join(root, 'source_registry.json'), `${JSON.stringify({
    schema_version: 'nascar_source_registry_v1',
    checked_at_utc: '2026-07-05T12:00:00.000Z',
  }, null, 2)}\n`);
  writeFileSync(join(root, 'discovery.json'), `${JSON.stringify({
    schema_version: 'nascar_discovery_v1',
    checked_at_utc: '2026-07-05T12:00:00.000Z',
  }, null, 2)}\n`);
  writeFileSync(join(discoveryDir, 'nascar_official_adapter.json'), `${JSON.stringify({
    source_id: 'nascar_official',
    status: 'ok',
    checked_at_utc: '2026-07-05T12:00:00.000Z',
    records: [{
      race_id: 901,
      track_id: 44,
      series_id: 1,
      race_name: 'Test 400',
      track: 'Test Speedway',
      scheduled_start_utc: '2026-07-05T19:00:00.000Z',
      source_urls: [
        'https://cf.nascar.com/cacher/2026/race_list_basic.json',
        'https://cf.nascar.com/cacher/2026/1/901/weekend-feed.json',
      ],
    }],
  }, null, 2)}\n`);
  writeFileSync(join(discoveryDir, 'active_field_pool_adapter.json'), `${JSON.stringify({
    source_id: 'active_field_pool',
    status: 'ok',
    checked_at_utc: '2026-07-05T12:00:00.000Z',
    records: [
      { driver_name: 'Denny Hamlin', race_id: 901, track_id: 44 },
      { driver_name: 'Kyle Larson', race_id: 901, track_id: 44 },
      { driver_name: 'Christopher Bell', race_id: 901, track_id: 44 },
    ],
  }, null, 2)}\n`);
  writeFileSync(join(discoveryDir, 'practice_qualifying_adapter.json'), `${JSON.stringify({
    source_id: 'practice_qualifying',
    status: 'ok',
    checked_at_utc: '2026-07-05T12:00:00.000Z',
    records: [
      { driver_name: 'Denny Hamlin', race_id: 901, effective_race_start: 1 },
      { driver_name: 'Kyle Larson', race_id: 901, effective_race_start: 2 },
      { driver_name: 'Christopher Bell', race_id: 901, effective_race_start: 3 },
    ],
  }, null, 2)}\n`);
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
  writeRaceQualityState(tmpRoot, date);
  writeFileSync(ceilingPath, `${JSON.stringify({
    candidates: [
      {
        driver_name: 'Denny Hamlin',
        composite_score: 78,
        fundamentals_layer_coverage: 4,
        fundamentals_layer_coverage_label: '4/4 layers',
        score_breakdown: { inputs_used: [{ layer: 'practice_speed' }] },
        lanes: { win: { status: 'EVIDENCE_LEAN', narrative: 'Top full-field profile.' } },
      },
      {
        driver_name: 'Kyle Larson',
        composite_score: 69,
        fundamentals_layer_coverage: 4,
        fundamentals_layer_coverage_label: '4/4 layers',
        score_breakdown: { inputs_used: [{ layer: 'track_history' }] },
        lanes: { win: { status: 'LEAN', narrative: 'Strong secondary profile.' } },
      },
      {
        driver_name: 'Christopher Bell',
        composite_score: 58,
        fundamentals_layer_coverage: 4,
        fundamentals_layer_coverage_label: '4/4 layers',
        score_breakdown: { inputs_used: [{ layer: 'recent_form' }] },
        lanes: { win: { status: 'WATCH', narrative: 'Needs pace upgrade.' } },
      },
    ],
    source: ceilingPath,
  }, null, 2)}\n`);

  try {
    const packet = buildRacePacket({
      date,
      event: nascarEvent(),
      sourcePath: '/tmp/nascar-event.json',
      artifacts: [ceilingPath],
      workspaceResult: null,
      stateRoot: tmpRoot,
      liveResearch: liveResearchAllOkFixture(),
      nowMs: Date.parse('2026-07-05T13:00:00.000Z'),
    });

    assert.match(packet.text, /--- Live Research \(Perplexity\) ---/);
    assert.match(packet.text, /evidence_ledger:/);
    assert.match(packet.text, /Missing layers:/);
    assert.match(packet.text, /- penalties_inspection_news/);
    assert.match(packet.text, /Market Context - NOT IN SCORE/);
    assert.doesNotMatch(packet.text, /yes_bid|yes_ask|last=|bid=|ask=|implied=/i);

    const validation = validateCpcCustomerPacket(packet.text);
    assert.equal(validation.valid, true, validation.errors.join('; '));
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('race readiness fails closed on mismatched identity, stale timestamps, and contradictory freshness', () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'cpc-nascar-live-bad-identity-'));
  const date = '2026-07-05';
  try {
    writeRaceQualityState(tmpRoot, date);

    const staleRegistryPath = join(tmpRoot, 'nascar', date, 'source_registry.json');
    writeFileSync(staleRegistryPath, `${JSON.stringify({
      schema_version: 'nascar_source_registry_v1',
      checked_at_utc: '2026-07-01T00:00:00.000Z',
      mode: 'fixtures-only',
      notes: 'stale Daytona fixture manifest',
      sources: {
        nascar_official: {
          source_id: 'nascar_official',
          checked_at_utc: '2026-07-01T00:00:00.000Z',
          race_name: 'Daytona 500',
          track: 'Daytona International Speedway',
        },
      },
    }, null, 2)}\n`);

    const conflictingLiveResearch = liveResearchFixture();
    conflictingLiveResearch.generated_utc = '2026-07-01T00:00:00.000Z';
    conflictingLiveResearch.layers.weather_track_condition.notes = 'cache only stale-source weather note';

    const quality = evaluateNascarRaceReadiness({
      date,
      event: nascarEvent({
        title: 'Wrong 400 Winner',
        venue: 'Wrong Speedway',
        scheduled_start_utc: '2026-07-06T19:00:00.000Z',
        product_metadata: {
          competition: 'NASCAR Cup Series',
          race_name: 'Wrong 400',
          track: 'Wrong Speedway',
          scheduled_start_utc: '2026-07-06T19:00:00.000Z',
          date: '2026-07-06',
        },
      }),
      ceiling: {
        candidates: [
          {
            driver_name: 'Denny Hamlin',
            composite_score: 78,
            fundamentals_layer_coverage: 4,
            score_breakdown: { inputs_used: [{ layer: 'practice_speed' }] },
            lanes: { win: { status: 'EVIDENCE_LEAN', narrative: 'Top profile.' } },
          },
          {
            driver_name: 'Kyle Larson',
            composite_score: 69,
            fundamentals_layer_coverage: 4,
            score_breakdown: { inputs_used: [{ layer: 'track_history' }] },
            lanes: { win: { status: 'WATCH', narrative: 'Strong profile.' } },
          },
          {
            driver_name: 'Christopher Bell',
            composite_score: 58,
            fundamentals_layer_coverage: 4,
            score_breakdown: { inputs_used: [{ layer: 'recent_form' }] },
            lanes: { win: { status: 'WATCH', narrative: 'Live if pace upgrades.' } },
          },
        ],
      },
      winMarkets: [
        { ticker: 'KXNASCARRACE-TEST26-HAML', driver_name: 'Denny Hamlin' },
        { ticker: 'KXNASCARRACE-TEST26-LARS', driver_name: 'Kyle Larson' },
        { ticker: 'KXNASCARRACE-TEST26-BELL', driver_name: 'Christopher Bell' },
      ],
      stateRoot: tmpRoot,
      liveResearch: conflictingLiveResearch,
      nowMs: Date.parse('2026-07-05T13:00:00.000Z'),
    });

    assert.equal(quality.ok, false);
    assert.ok(quality.errors.some((error) => error.code === 'EVENT_TITLE_IDENTITY_MISMATCH'));
    assert.ok(quality.errors.some((error) => error.code === 'EVENT_RACE_NAME_MISMATCH'));
    assert.ok(quality.errors.some((error) => error.code === 'EVENT_TRACK_MISMATCH'));
    assert.ok(quality.errors.some((error) => error.code === 'EVENT_START_MISMATCH'));
    assert.ok(quality.errors.some((error) => error.code === 'EVENT_DATE_MISMATCH'));
    assert.ok(quality.errors.some((error) => error.code === 'TIMESTAMP_STALE'));
    assert.ok(quality.errors.some((error) => error.code === 'STALE_FIXTURE_MANIFEST_IDENTITY'));

    const packet = buildRacePacket({
      date,
      event: nascarEvent({
        title: 'Wrong 400 Winner',
        venue: 'Wrong Speedway',
        scheduled_start_utc: '2026-07-06T19:00:00.000Z',
        product_metadata: {
          competition: 'NASCAR Cup Series',
          race_name: 'Wrong 400',
          track: 'Wrong Speedway',
          scheduled_start_utc: '2026-07-06T19:00:00.000Z',
          date: '2026-07-06',
        },
      }),
      sourcePath: '/tmp/nascar-event.json',
      artifacts: [join(tmpRoot, 'ceiling_board.json')],
      workspaceResult: null,
      stateRoot: tmpRoot,
      liveResearch: conflictingLiveResearch,
      nowMs: Date.parse('2026-07-05T13:00:00.000Z'),
    });

    assert.match(packet.text, /BLOCKED_PACKET_INCOMPLETE/);
    assert.match(packet.text, /EVENT_TITLE_IDENTITY_MISMATCH/);
    assert.match(packet.text, /TIMESTAMP_STALE/);
    assert.match(packet.text, /STALE_FIXTURE_MANIFEST_IDENTITY/);

    const janitor = validatePacketText(packet.text, {
      packetType: 'nascar-sunday',
      filePath: `state/packets/${date}/nascar-sunday/x.txt`,
    });
    assert.equal(janitor.verdict, 'JANITOR_BLOCKED');
    assert.ok(janitor.errors.some((error) => error.code === 'NASCAR_CONTRADICTORY_FRESHNESS_DISCLOSURE'));
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('race identity gate requires matchable product metadata, live ticker parity, and the supplied freshness limit', () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'cpc-nascar-quality-parameters-'));
  const date = '2026-07-05';
  try {
    writeRaceQualityState(tmpRoot, date);
    const missingMetadata = evaluateNascarEventIdentity({
      date,
      event: { ...nascarEvent(), product_metadata: undefined },
      stateRoot: tmpRoot,
      liveResearch: liveResearchFixture(),
    });
    assert.equal(missingMetadata.ok, false);
    assert.ok(missingMetadata.errors.some((error) => error.code === 'EVENT_RACE_NAME_IDENTITY_MISSING'));

    const tickerMismatch = evaluateNascarEventIdentity({
      date,
      event: nascarEvent(),
      stateRoot: tmpRoot,
      liveResearch: { ...liveResearchFixture(), event_ticker: 'KXNASCARRACE-OTHER26' },
    });
    assert.ok(tickerMismatch.errors.some((error) => error.code === 'LIVE_RESEARCH_EVENT_MISMATCH'));

    const quality = evaluateNascarRaceReadiness({
      date,
      event: nascarEvent(),
      ceiling: {
        candidates: nascarEvent().markets.map((market, index) => ({
          driver_name: market.yes_sub_title,
          composite_score: 80 - index,
          lanes: { win: { status: 'WATCH' } },
        })),
      },
      winMarkets: nascarEvent().markets.map((market) => ({ driver_name: market.yes_sub_title, ticker: market.ticker })),
      stateRoot: tmpRoot,
      liveResearch: liveResearchFixture(),
      nowMs: Date.parse('2026-07-05T13:00:00.000Z'),
      maxSourceAgeMs: 1_000,
    });
    assert.ok(quality.errors.some((error) => error.code === 'TIMESTAMP_STALE'));
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
