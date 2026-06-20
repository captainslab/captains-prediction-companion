import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  DELIVERY_VERDICTS,
  inspectPacketDir,
  inspectPacketFile,
  validatePacketText,
} from '../scripts/cron/cpc-packet-janitor.mjs';
import { renderMentionPacket } from '../scripts/mentions/render-mention-packet.mjs';
import { fetchSourceDocument } from '../scripts/mentions/source-research.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const JANITOR = join(REPO, 'scripts/cron/cpc-packet-janitor.mjs');
const SENDER = join(REPO, 'scripts/packets/send-packets-telegram.mjs');

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'cpc-janitor-test-'));
}

function cleanPacket(extra = '') {
  return [
    '=== CPC Packet: Test Packet ===',
    'generated_utc: 2099-01-01T00:00:00Z',
    'Market Context - NOT IN SCORE.',
    'Research only. No trades.',
    extra,
  ].filter(Boolean).join('\n');
}

function writePacket(root, rel, text = cleanPacket()) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text, 'utf8');
  return p;
}

function newStyleMentionPacket({ researchBacked = true } = {}) {
  const term = researchBacked
    ? {
        full_strike_text: 'What will the speaker say? -- Inflation',
        short_term: 'Inflation',
        cpc_score: 88,
        research_state: 'research-backed',
        research_term_note: {
          catalyst: 'full catalyst text that should remain readable on mobile',
          settlement_fit: 'full settlement fit text that should remain readable on mobile',
        },
        market_context: { bid_cents: 10, ask_cents: 15, note: 'NOT IN SCORE' },
      }
    : {
        full_strike_text: 'What will the speaker say? -- Inflation',
        short_term: 'Inflation',
        cpc_score: null,
        research_state: 'research gap',
        market_context: { bid_cents: 10, ask_cents: 15, note: 'NOT IN SCORE' },
      };
  return renderMentionPacket({
    packet_kind: 'mentions_customer_packet_v2',
    date: '2099-01-01',
    event: {
      title: 'What will the speaker say?',
      date_time: '2099-01-01T18:00:00Z',
      settlement_source_link: 'https://example.com/settlement',
    },
    summary: { market_count: 1 },
    terms: [term],
  }, {
    generatedAtUtc: '2099-01-01T00:00:00Z',
  });
}

async function makeProducerCacheHit({ root, date, url, text = 'cache-only source text' }) {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return { ok: true, status: 200, text: async () => text };
  };
  const first = await fetchSourceDocument({ url, stateRoot: root, date, env: {}, fetchImpl });
  const second = await fetchSourceDocument({ url, stateRoot: root, date, env: {}, fetchImpl });
  assert.equal(fetchCalls, 1, 'producer fetch should hit the network once and then reuse cache');
  return { first, second };
}

test('strips cron wrapper and validates remaining packet as repaired copy', () => {
  const root = tempRoot();
  try {
    const file = writePacket(root, 'packets/2099-01-01/mentions-daily/packet.txt', `Cronjob Response:\nnoise\n${cleanPacket()}`);
    const result = inspectPacketFile(file, { stateRoot: root, date: '2099-01-01', packetType: 'mentions-daily' });
    assert.equal(result.verdict, DELIVERY_VERDICTS.SEND_ALLOWED_AFTER_REPAIR);
    assert.equal(result.repair_rule, 'strip_cron_wrapper_text');
    assert.ok(result.repaired_path);
    assert.equal(readFileSync(file, 'utf8').startsWith('Cronjob Response:'), true, 'original artifact must remain unchanged');
    assert.doesNotMatch(readFileSync(result.repaired_path, 'utf8'), /Cronjob Response:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('blocks dry-run-only text with no valid packet body', () => {
  const result = validatePacketText('[dry-run] would send document: packet.txt', { packetType: 'mlb-daily' });
  assert.equal(result.verdict, DELIVERY_VERDICTS.JANITOR_BLOCKED);
  assert.ok(result.errors.some((err) => err.code === 'DRY_RUN_ONLY_OUTPUT'));
});

test('blocks raw market prices inside scoring/rationale section', () => {
  const text = cleanPacket([
    'CPC COMPOSITE BOARD',
    '- model: score=64 rationale uses YES 51 cents and bid 49 in scoring.',
  ].join('\n'));
  const result = validatePacketText(text, { packetType: 'mlb-daily' });
  assert.equal(result.verdict, DELIVERY_VERDICTS.JANITOR_BLOCKED);
  assert.ok(result.errors.some((err) => err.code === 'MARKET_PRICE_IN_SCORING_SECTION'));
});

test('accepts a valid new-style mentions packet', () => {
  const text = newStyleMentionPacket({ researchBacked: true });
  const result = validatePacketText(text, { packetType: 'mentions-daily' });
  assert.equal(result.verdict, DELIVERY_VERDICTS.SEND_ALLOWED);
  assert.equal(result.errors.length, 0);
});

test('blocks a no-research mentions packet with hard fail-closed evidence gate', () => {
  const text = newStyleMentionPacket({ researchBacked: false });
  const result = validatePacketText(text, { packetType: 'mentions-daily' });
  assert.equal(result.verdict, DELIVERY_VERDICTS.JANITOR_BLOCKED);
  assert.ok(result.errors.some((err) => err.code === 'NO_USABLE_SOURCE_EVIDENCE'));
});

test('allows market-neutral disclaimers in scoring sections', () => {
  const text = cleanPacket([
    'CPC COMPOSITE BOARD',
    '- market-neutrality: raw market prices are not in score and not used for ranking.',
  ].join('\n'));
  const result = validatePacketText(text, { packetType: 'mlb-daily' });
  assert.equal(result.verdict, DELIVERY_VERDICTS.SEND_ALLOWED);
});

test('allows price missing placeholders in scoring sections', () => {
  const text = cleanPacket([
    'CPC COMPOSITE BOARD',
    '- model: score=61, market price=MISSING pending source inventory.',
  ].join('\n'));
  const result = validatePacketText(text, { packetType: 'mlb-daily' });
  assert.equal(result.verdict, DELIVERY_VERDICTS.SEND_ALLOWED);
});

test('allows inventory-artifact-only raw market labels in scoring sections', () => {
  const text = cleanPacket([
    'CPC COMPOSITE BOARD',
    '- raw bid/ask/last/volume/OI: inventory artifact only, NOT IN SCORE.',
    '- model: score=64 after fundamentals only.',
  ].join('\n'));
  const result = validatePacketText(text, { packetType: 'mlb-daily' });
  assert.equal(result.verdict, DELIVERY_VERDICTS.SEND_ALLOWED);
});

test('allows baseball and MMA stat volume language in scoring sections', () => {
  const text = cleanPacket([
    'MODEL SCORE',
    '- Pitcher form: last 5 starts show command stabilization.',
    '- Fight form: striking volume/accuracy supports a pace lean.',
  ].join('\n'));
  const result = validatePacketText(text, { packetType: 'ufc-weekly' });
  assert.equal(result.verdict, DELIVERY_VERDICTS.SEND_ALLOWED);
});

test('blocks yes_ask market value inside scoring/rationale section', () => {
  const text = cleanPacket([
    'RATIONALE',
    '- score=65 because yes_ask=0.41 leaves edge after model review.',
  ].join('\n'));
  const result = validatePacketText(text, { packetType: 'mlb-daily' });
  assert.equal(result.verdict, DELIVERY_VERDICTS.JANITOR_BLOCKED);
  assert.ok(result.errors.some((err) => err.code === 'MARKET_PRICE_IN_SCORING_SECTION'));
});

test('blocks high NO_CLEAR_PICK ratio without source-backed explanation', () => {
  const text = cleanPacket([
    '#1 [NO_CLEAR_PICK] A',
    '#2 [NO_CLEAR_PICK] B',
    '#3 [NO_CLEAR_PICK] C',
  ].join('\n'));
  const result = validatePacketText(text, { packetType: 'mlb-daily' });
  assert.equal(result.verdict, DELIVERY_VERDICTS.JANITOR_BLOCKED);
  assert.ok(result.errors.some((err) => err.code === 'HIGH_NO_CLEAR_PICK_RATIO_WITHOUT_EXPLANATION'));
});

test('allows source-backed no-clear with close margin and cancellation evidence', () => {
  const text = cleanPacket([
    'source layer coverage: 13/13',
    'canceling evidence: starters edge offsets bullpen edge; score margin: 2',
    'missing layer list: none',
    '#1 [NO_CLEAR_PICK] A',
    '#2 [NO_CLEAR_PICK] B',
    '#3 [NO_CLEAR_PICK] C',
  ].join('\n'));
  const result = validatePacketText(text, { packetType: 'mlb-daily' });
  assert.equal(result.verdict, DELIVERY_VERDICTS.SEND_ALLOWED);
});

test('allows UFC no-clear only with sufficient coverage and close margin', () => {
  const bad = validatePacketText(cleanPacket('#1 [NO_CLEAR_PICK] fighter A'), { packetType: 'ufc-weekly' });
  assert.equal(bad.verdict, DELIVERY_VERDICTS.JANITOR_BLOCKED);
  assert.ok(bad.errors.some((err) => err.code === 'UFC_NO_CLEAR_WITHOUT_CLOSE_MARGIN_COVERAGE'));

  const good = validatePacketText(cleanPacket([
    'source layer coverage: 8/8',
    'close composite margin: 1.5 points',
    '#1 [NO_CLEAR_PICK] fighter A',
  ].join('\n')), { packetType: 'ufc-weekly' });
  assert.equal(good.verdict, DELIVERY_VERDICTS.SEND_ALLOWED);
});

test('allows mentions fail-closed only when blocker artifacts exist', () => {
  const root = tempRoot();
  try {
    const date = '2099-01-02';
    const blockedMissing = inspectPacketDir(join(root, 'packets', date, 'mentions-daily'), {
      stateRoot: root,
      date,
      packetType: 'mentions-daily',
    });
    assert.equal(blockedMissing.verdict, DELIVERY_VERDICTS.JANITOR_BLOCKED);

    mkdirSync(join(root, 'mentions', date, 'blockers'), { recursive: true });
    writeFileSync(join(root, 'mentions', date, 'blockers', 'event.watch.json'), JSON.stringify({ reason: 'FETCH_SOURCE_MISSING' }));
    const failClosed = inspectPacketDir(join(root, 'packets', date, 'mentions-daily'), {
      stateRoot: root,
      date,
      packetType: 'mentions-daily',
    });
    assert.equal(failClosed.verdict, DELIVERY_VERDICTS.JANITOR_WARNING);
    assert.equal(failClosed.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reruns generator once for deterministic missing-artifact case', () => {
  const root = tempRoot();
  try {
    const file = join(root, 'packets/2099-01-03/mlb-daily/generated.txt');
    const generator = [
      process.execPath,
      '-e',
      `require('fs').mkdirSync(${JSON.stringify(dirname(file))},{recursive:true});require('fs').writeFileSync(${JSON.stringify(file)},${JSON.stringify(cleanPacket())})`,
    ];
    const result = inspectPacketFile(file, {
      stateRoot: root,
      date: '2099-01-03',
      packetType: 'mlb-daily',
      generatorCommand: generator,
    });
    assert.equal(result.verdict, DELIVERY_VERDICTS.SEND_ALLOWED);
    assert.equal(result.generator_result.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('blocks after one failed repair attempt', () => {
  const root = tempRoot();
  try {
    const file = writePacket(root, 'packets/2099-01-04/mlb-daily/bad.txt', 'Cronjob Response:\nCPC Packet: Broken\nMarket Context - NOT IN SCORE.');
    const result = inspectPacketFile(file, { stateRoot: root, date: '2099-01-04', packetType: 'mlb-daily' });
    assert.equal(result.verdict, DELIVERY_VERDICTS.JANITOR_BLOCKED);
    assert.equal(result.repair_attempted, true);
    assert.ok(result.errors.some((err) => err.code === 'REPAIR_ATTEMPT_FAILED'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('blocks alpha/source fetch failures when source health is required', () => {
  const root = tempRoot();
  try {
    const date = '2099-01-05';
    const file = writePacket(root, `packets/${date}/mlb-daily/packet.txt`);
    const healthDir = join(root, 'mlb', date, 'discovery');
    mkdirSync(healthDir, { recursive: true });
    writeFileSync(join(healthDir, 'stats_adapter.json'), JSON.stringify({
      generated_utc: new Date().toISOString(),
      records: [],
      status: 403,
      error: 'forbidden',
    }));
    const result = inspectPacketFile(file, {
      stateRoot: root,
      date,
      packetType: 'mlb-daily',
      requireSourceHealth: true,
    });
    assert.equal(result.verdict, DELIVERY_VERDICTS.JANITOR_BLOCKED);
    assert.ok(result.errors.some((err) => err.code === 'FETCH_SOURCE_EMPTY'));
    assert.ok(result.errors.some((err) => err.code === 'FETCH_AUTH_BLOCKED'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('matched_game_pk passes MLB join-key source-health check', () => {
  const root = tempRoot();
  try {
    const date = '2099-01-09';
    const file = writePacket(root, `packets/${date}/mlb-daily/packet.txt`);
    const healthDir = join(root, 'mlb', date, 'discovery');
    mkdirSync(healthDir, { recursive: true });
    writeFileSync(join(healthDir, 'stats_adapter.json'), JSON.stringify({
      fetched_utc: new Date().toISOString(),
      records: [{ matched_game_pk: 824434, away_team_ops: 0.724 }],
    }));
    const result = inspectPacketFile(file, {
      stateRoot: root,
      date,
      packetType: 'mlb-daily',
      requireSourceHealth: true,
    });
    assert.equal(result.verdict, DELIVERY_VERDICTS.SEND_ALLOWED);
    assert.equal(result.errors.some((err) => err.code === 'FETCH_JOIN_KEY_MISSING'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('accepted join keys cover MLB, UFC, WorldCup, and mentions adapters', () => {
  const root = tempRoot();
  try {
    const date = '2099-01-14';
    const cases = [
      {
        packetType: 'mlb-daily',
        file: writePacket(root, `packets/${date}/mlb-daily/mlb.txt`),
        path: join(root, 'mlb', date, 'discovery', 'mlb_stats.json'),
        payload: { fetched_utc: new Date().toISOString(), records: [{ gamePk: 824434 }] },
      },
      {
        packetType: 'ufc-weekly',
        file: writePacket(root, `packets/${date}/ufc-weekly/ufc.txt`),
        path: join(root, 'ufc', date, 'discovery', 'ufc_stats.json'),
        payload: { fetched_utc: new Date().toISOString(), records: [{ fight_id: 'UFC-1001' }] },
      },
      {
        packetType: 'worldcup-matchday',
        file: writePacket(root, `packets/${date}/worldcup-matchday/worldcup.txt`),
        path: join(root, 'worldcup', date, 'discovery', 'worldcup_stats.json'),
        payload: { fetched_utc: new Date().toISOString(), records: [{ match_id: 'M-1001' }] },
      },
      {
        packetType: 'mentions-daily',
        file: writePacket(root, `packets/${date}/mentions-daily/mentions.txt`),
        path: join(root, 'mentions', date, 'sources', 'mentions_stats.json'),
        payload: { fetched_utc: new Date().toISOString(), records: [{ event_ticker: 'KXTEST-1' }] },
      },
    ];

    for (const entry of cases) {
      mkdirSync(dirname(entry.path), { recursive: true });
      writeFileSync(entry.path, JSON.stringify(entry.payload));
      const result = inspectPacketFile(entry.file, {
        stateRoot: root,
        date,
        packetType: entry.packetType,
        requireSourceHealth: true,
        sourceHealthPaths: [entry.path],
      });
      assert.equal(result.verdict, DELIVERY_VERDICTS.SEND_ALLOWED, entry.packetType);
      assert.equal(result.errors.some((err) => err.code === 'FETCH_JOIN_KEY_MISSING'), false, entry.packetType);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('source manifests do not require per-game join keys', () => {
  const root = tempRoot();
  try {
    const date = '2099-01-15';
    const file = writePacket(root, `packets/${date}/mlb-daily/packet.txt`);
    const healthDir = join(root, 'mlb', date, 'discovery');
    mkdirSync(healthDir, { recursive: true });
    writeFileSync(join(healthDir, 'source-manifest.json'), JSON.stringify({
      fetched_utc: new Date().toISOString(),
      source_type: 'manifest',
      records: [{ source_id: 'mlb_stats' }, { source_id: 'mlb_weather' }],
    }));
    const result = inspectPacketFile(file, {
      stateRoot: root,
      date,
      packetType: 'mlb-daily',
      requireSourceHealth: true,
    });
    assert.equal(result.verdict, DELIVERY_VERDICTS.SEND_ALLOWED);
    assert.equal(result.errors.some((err) => err.code === 'FETCH_JOIN_KEY_MISSING'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cache-only disclosure is downgraded to a warning', async () => {
  const root = tempRoot();
  try {
    const date = '2099-01-16';
    const file = writePacket(root, `packets/${date}/mentions-daily/packet.txt`, cleanPacket('cache-only source coverage disclosed in packet text.'));
    const url = 'https://example.com/producer-cache-warning';
    await makeProducerCacheHit({ root, date, url });
    const result = inspectPacketFile(file, {
      stateRoot: root,
      date,
      packetType: 'mentions-daily',
      requireSourceHealth: true,
    });
    assert.equal(result.verdict, DELIVERY_VERDICTS.JANITOR_WARNING);
    assert.ok(result.warnings.some((warn) => warn.code === 'FETCH_CACHE_ONLY'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mentions source-health artifacts under research are isolated from blocker artifacts', async () => {
  const root = tempRoot();
  try {
    const date = '2099-01-15';
    const file = writePacket(root, `packets/${date}/mentions-daily/packet.txt`);
    const now = new Date().toISOString();
    const researchDir = join(root, 'mentions', date, 'research');
    mkdirSync(researchDir, { recursive: true });
    writeFileSync(join(researchDir, 'event.source-health.json'), JSON.stringify({
      schema: 'mentions_source_health_v1',
      url: 'https://official.gov/transcript',
      generated_utc: now,
      checked_at_utc: now,
      provider: 'firecrawl',
      status: 'ok',
      http_status: 200,
      error_code: null,
      retry_count: 0,
      cache_status: 'live',
      used_in_score: false,
      required: true,
      fallback_used: false,
      disclosure_required: false,
      source_status: 'SOURCE_FETCHED',
      fetch_method: 'normal',
      text_cached: true,
      records: [{ event_ticker: 'KXWCMENTION-26JUN12USAMEX' }],
    }));
    mkdirSync(join(root, 'mentions', date, 'blockers'), { recursive: true });
    writeFileSync(join(root, 'mentions', date, 'blockers', 'event.watch.json'), JSON.stringify({ reason: 'FETCH_SOURCE_MISSING' }));
    const result = inspectPacketFile(file, {
      stateRoot: root,
      date,
      packetType: 'mentions-daily',
      requireSourceHealth: true,
    });
    assert.equal(result.verdict, DELIVERY_VERDICTS.SEND_ALLOWED);
    assert.equal(result.errors.some((err) => err.code === 'FETCH_SOURCE_MISSING'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fresh generated_utc-only source artifact is not flagged cache-only', () => {
  const root = tempRoot();
  try {
    const date = '2099-01-17';
    const file = writePacket(root, `packets/${date}/mlb-daily/packet.txt`);
    const healthDir = join(root, 'mlb', date, 'discovery');
    mkdirSync(healthDir, { recursive: true });
    writeFileSync(join(healthDir, 'stats_adapter.json'), JSON.stringify({
      generated_utc: new Date().toISOString(),
      records: [{ matched_game_pk: 824434 }],
    }));
    const result = inspectPacketFile(file, {
      stateRoot: root,
      date,
      packetType: 'mlb-daily',
      requireSourceHealth: true,
    });
    assert.equal(result.verdict, DELIVERY_VERDICTS.SEND_ALLOWED);
    const codes = [...result.errors, ...result.warnings].map((entry) => entry.code);
    assert.equal(codes.includes('FETCH_CACHE_ONLY'), false);
    assert.equal(result.source_health.some((entry) => entry.code === 'FETCH_CACHE_ONLY'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('real-format UFC no-clear (53-52 + edge did not separate) is justified', () => {
  const text = cleanPacket([
    'Overall data coverage: 147/154 fighter-layers present',
    '· Fighter A vs Fighter B  [NO_CLEAR_PICK] 53-52',
    'posture: NO_CLEAR_PICK | confidence: high',
    'Fighter A vs Fighter B: NO_CLEAR_PICK; close composite margin: 1.5 points; fully scored but edge did not separate the matchup.',
  ].join('\n'));
  const result = validatePacketText(text, { packetType: 'ufc-weekly' });
  assert.equal(result.errors.some((err) => err.code === 'UFC_NO_CLEAR_WITHOUT_CLOSE_MARGIN_COVERAGE'), false);
  assert.equal(result.verdict, DELIVERY_VERDICTS.SEND_ALLOWED);
});

test('429 source status is classified as FETCH_RATE_LIMITED, not auth blocked', () => {
  const root = tempRoot();
  try {
    const date = '2099-01-10';
    const file = writePacket(root, `packets/${date}/mlb-daily/packet.txt`);
    const healthDir = join(root, 'mlb', date, 'discovery');
    mkdirSync(healthDir, { recursive: true });
    writeFileSync(join(healthDir, 'stats_adapter.json'), JSON.stringify({
      fetched_utc: new Date().toISOString(),
      records: [{ matched_game_pk: 824434 }],
      status: 429,
      error: 'rate limit',
    }));
    const result = inspectPacketFile(file, {
      stateRoot: root,
      date,
      packetType: 'mlb-daily',
      requireSourceHealth: true,
    });
    const codes = [...result.errors, ...result.warnings].map((entry) => entry.code);
    assert.ok(codes.includes('FETCH_RATE_LIMITED'));
    assert.equal(codes.includes('FETCH_AUTH_BLOCKED'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('numeric volume 403 is not classified as auth blocked', () => {
  const root = tempRoot();
  try {
    const date = '2099-01-11';
    const file = writePacket(root, `packets/${date}/mlb-daily/packet.txt`);
    const healthDir = join(root, 'mlb', date, 'discovery');
    mkdirSync(healthDir, { recursive: true });
    writeFileSync(join(healthDir, 'stats_adapter.json'), JSON.stringify({
      fetched_utc: new Date().toISOString(),
      records: [{ matched_game_pk: 824434, volume: 403 }],
    }));
    const result = inspectPacketFile(file, {
      stateRoot: root,
      date,
      packetType: 'mlb-daily',
      requireSourceHealth: true,
    });
    const codes = [...result.errors, ...result.warnings].map((entry) => entry.code);
    assert.equal(codes.includes('FETCH_AUTH_BLOCKED'), false);
    assert.equal(result.verdict, DELIVERY_VERDICTS.SEND_ALLOWED);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('FETCH_CACHE_ONLY is detected when source health lacks live fetch coverage disclosure', async () => {
  const root = tempRoot();
  try {
    const date = '2099-01-12';
    const file = writePacket(root, `packets/${date}/mentions-daily/packet.txt`);
    await makeProducerCacheHit({
      root,
      date,
      url: 'https://example.com/producer-cache-block',
    });
    const result = inspectPacketFile(file, {
      stateRoot: root,
      date,
      packetType: 'mentions-daily',
      requireSourceHealth: true,
    });
    assert.equal(result.verdict, DELIVERY_VERDICTS.JANITOR_BLOCKED);
    assert.ok(result.errors.some((err) => err.code === 'FETCH_CACHE_ONLY'));
    assert.ok(result.source_health.some((entry) => entry.code === 'FETCH_CACHE_ONLY'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('justified low-ratio UFC no-clear passes per-fight validation', () => {
  const text = cleanPacket([
    'source layer coverage: 8/8',
    '#1 [NO_CLEAR_PICK] Fighter A vs Fighter B - close composite margin: 1.5 points; source-backed cancellation.',
    '#2 [WATCH] Fighter C',
    '#3 [WATCH] Fighter D',
  ].join('\n'));
  const result = validatePacketText(text, { packetType: 'ufc-weekly' });
  assert.equal(result.verdict, DELIVERY_VERDICTS.SEND_ALLOWED);
});

test('sender live path prevents Telegram env lookup when janitor blocks', () => {
  const root = tempRoot();
  try {
    const date = '2099-01-06';
    const dir = join(root, 'packets', date, 'mentions-daily');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${date}-BAD.txt`), '[dry-run] would send document only');
    const result = spawnSync(process.execPath, [
      SENDER,
      '--type', 'mentions-daily',
      '--date', date,
      '--state-root', root,
    ], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '', TELEGRAM_HOME_CHANNEL: '' },
    });
    assert.notEqual(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr + result.stdout, /telegram env missing/);
    const janitorDir = join(root, 'janitor', date);
    assert.ok(existsSync(janitorDir), 'blocked send must write janitor artifacts');
    assert.ok(readdirSync(janitorDir).some((name) => name.endsWith('.janitor.json')), 'janitor artifact missing');
    assert.ok(readdirSync(janitorDir).some((name) => name.endsWith('.debug.txt')), 'debug artifact missing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('allows clean MLB/UFC/WorldCup fixture packets', () => {
  const mlb = validatePacketText([
    '=== Captain MLB - Composite Refresh 2099-01-07 ===',
    'Composite board.',
    'PICK Team A because source-backed fundamentals support it.',
    'Composite model -- no bets placed, no trades executed.',
  ].join('\n'), { packetType: 'mlb-composite' });
  assert.equal(mlb.verdict, DELIVERY_VERDICTS.SEND_ALLOWED);

  const ufc = validatePacketText(cleanPacket('source layer coverage: 8/8\n#1 [WATCH] fighter A'), { packetType: 'ufc-weekly' });
  assert.equal(ufc.verdict, DELIVERY_VERDICTS.SEND_ALLOWED);

  const worldcup = validatePacketText(cleanPacket('source layer coverage: 14/14\n#1 [WATCH] Team A'), { packetType: 'worldcup-matchday' });
  assert.equal(worldcup.verdict, DELIVERY_VERDICTS.SEND_ALLOWED);
});

test('CLI writes delivery manifest and debug artifact on block', () => {
  const root = tempRoot();
  try {
    const date = '2099-01-08';
    const file = writePacket(root, `packets/${date}/mlb-daily/bad.txt`, '[dry-run] would send only');
    const result = spawnSync(process.execPath, [
      JANITOR,
      'validate-file',
      '--file', file,
      '--date', date,
      '--state-root', root,
      '--type', 'mlb-daily',
    ], { cwd: REPO, encoding: 'utf8' });
    assert.equal(result.status, 1);
    const manifest = join(root, 'janitor', date, 'delivery-manifest.json');
    assert.match(readFileSync(manifest, 'utf8'), /JANITOR_BLOCKED/);
    const debugDir = join(root, 'janitor', date);
    assert.ok(readdirSync(debugDir).some((name) => name.endsWith('.debug.txt')), 'debug artifact missing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
