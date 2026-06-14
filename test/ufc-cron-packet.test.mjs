// Tests for UFC cron schedule, packet structure, and anti-price rules.
// No network calls except the generator integration test which uses a temp state root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateDecisionProcess,
  renderDecisionProcess,
  MARKET_TYPES,
  DECISION_STATUSES,
} from '../scripts/shared/decision-process.mjs';
import {
  buildKalshiEventPacket,
  PACKET_TYPE,
  weekendDates,
} from '../scripts/packets/generate-ufc-weekly.mjs';

// ─── 1. Cron expression: Saturday 9:00 AM server time ─────────────────────

const UFC_CRON_EXPR = '0 9 * * 6';
const GENERATOR = 'scripts/packets/generate-ufc-weekly.mjs';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UFC_CRON_LINE = `${UFC_CRON_EXPR} cd ${REPO} && /usr/bin/node ${GENERATOR} >> logs/ufc-weekly.log 2>&1`;

function readUserCrontab() {
  try {
    return execSync('crontab -l 2>/dev/null', { encoding: 'utf8' });
  } catch {
    return '';
  }
}

function activeCronLines(crontabText) {
  return crontabText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function ufcCronLines(crontabText) {
  return activeCronLines(crontabText).filter((line) => line.includes(GENERATOR));
}

function assertSingleUfcCronLine(crontabText) {
  const lines = ufcCronLines(crontabText);
  assert.equal(
    lines.length,
    1,
    `Expected exactly 1 UFC cron line but found ${lines.length}:\n${lines.join('\n')}`,
  );
  return lines[0];
}

test('UFC cron expression targets Saturday (dow=6) at 09:00 server time only - no other days or times', () => {
  const [minute, hour, dom, month, dow] = UFC_CRON_EXPR.split(' ');
  assert.equal(minute, '0', 'minute must be 0');
  assert.equal(hour,   '9', 'hour must be 9 (09:00 server time)');
  assert.equal(dom,    '*', 'day-of-month must be wildcard - not pinned to a specific date');
  assert.equal(month,  '*', 'month must be wildcard');
  assert.equal(dow,    '6', 'day-of-week must be 6 (Saturday)');
});

test('UFC cron fixture contains exactly one active generator line', () => {
  const crontab = [
    '# unrelated job is ignored',
    '15 2 * * * /usr/bin/node /tmp/other-job.mjs',
    UFC_CRON_LINE,
  ].join('\n');
  const ufcLine = assertSingleUfcCronLine(crontab);
  assert.ok(ufcLine.includes(GENERATOR),
    `UFC cron line must invoke ${GENERATOR}.\nActual line: ${ufcLine}`);
});

test('UFC cron proof does not require any unrelated cron entries', () => {
  assert.equal(assertSingleUfcCronLine(UFC_CRON_LINE), UFC_CRON_LINE);
});

test('installed user crontab contains exactly the repo-owned UFC cron line', () => {
  const ufcLine = assertSingleUfcCronLine(readUserCrontab());
  assert.equal(ufcLine, UFC_CRON_LINE);
});

test('duplicate UFC cron lines fail the one-line invariant', () => {
  const duplicateCrontab = [
    UFC_CRON_LINE,
    UFC_CRON_LINE.replace('ufc-weekly.log', 'ufc-weekly-duplicate.log'),
  ].join('\n');
  assert.throws(
    () => assertSingleUfcCronLine(duplicateCrontab),
    /Expected exactly 1 UFC cron line but found 2/,
  );
});

test('single UFC cron line is no-send/no-trade scheduler glue only', () => {
  const ufcLine = assertSingleUfcCronLine(UFC_CRON_LINE);
  assert.ok(ufcLine.includes(`cd ${REPO}`), `cron line must run from repo root: ${ufcLine}`);
  assert.ok(ufcLine.includes(`/usr/bin/node ${GENERATOR}`),
    `cron line must invoke node generator: ${ufcLine}`);
  assert.doesNotMatch(ufcLine, /\b(send|telegram|trade|order)\b/i,
    `cron line must not send messages or place orders: ${ufcLine}`);
});

// ─── 2. Packet structure: required fields present ────────────────────────────

function buildTestProcess() {
  return evaluateDecisionProcess({
    marketType: MARKET_TYPES.SPORTS_GAME,
    rawDecision: 'WATCH',
    forceWatch: true,
    checked: {
      projected_participants: true,
      lineup_injury_news: false,
      venue_context: false,
      recent_form_matchup: false,
      market_board_context: true,
      evidence_supported_side: false,
    },
    topEvidence: ['Kalshi fight board captured with 19 market(s).'],
    settlementRules: 'UFC market settlement criteria not independently pulled by this packet.',
    verifiedFacts: 'Participants/market contracts captured; fighter status context still required.',
    marketSignalText: 'Market board captured for research; no pick inferred.',
    socialChatter: 'Not used as verified fact.',
    inference: 'Fight inference blocked until fighter status, matchup, recent form, and card-change checks are complete.',
    skepticReview: 'MISSING: no skeptic review in packet generator.',
    finalJudgment: 'WATCH only; no evidence lean from fight board alone.',
    whyNotPriceOnly: 'Market-board data is reference-only; no final pick is claimed without fighter-status, matchup, and card-change evidence.',
    wouldChangeView: [
      'Official card and fighter status are confirmed.',
      'Recent form and style matchup support the same side as any board signal.',
      'Late scratch, weight miss, or opponent change.',
    ],
  });
}

function priceOnlyUfcEvent() {
  return {
    event_ticker: 'KXUFCFIGHT-99JAN03ALPBET',
    title: 'Alpha Fighter vs Beta Fighter',
    sub_title: 'UFC test card',
    series_ticker: 'KXUFCFIGHT',
    close_time: '2099-01-03T23:00:00Z',
    markets: [
      {
        ticker: 'KXUFCFIGHT-99JAN03ALPBET-ALPHA',
        event_ticker: 'KXUFCFIGHT-99JAN03ALPBET',
        title: 'Will Alpha Fighter beat Beta Fighter?',
        subtitle: 'Alpha Fighter',
        yes_sub_title: 'Alpha Fighter',
        no_sub_title: 'Beta Fighter',
        yes_bid_dollars: '0.42',
        yes_ask_dollars: '0.45',
        no_bid_dollars: '0.55',
        no_ask_dollars: '0.58',
        last_price_dollars: '0.44',
        liquidity_dollars: '1200.00',
        volume_fp: '150',
        open_interest_fp: '80',
        close_time: '2099-01-03T23:00:00Z',
        expected_expiration_time: '2099-01-03T23:00:00Z',
      },
    ],
  };
}

function buildPriceOnlyPacketText() {
  const built = buildKalshiEventPacket({
    event: priceOnlyUfcEvent(),
    dates: weekendDates('2099-01-03'),
    sourcePath: '/tmp/ufc-price-only-source.json',
  });
  return built.text;
}

function sectionBetween(text, start, end) {
  const startIndex = text.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing section start: ${start}`);
  const bodyStart = startIndex + start.length;
  const endIndex = end ? text.indexOf(end, bodyStart) : -1;
  return text.slice(bodyStart, endIndex === -1 ? undefined : endIndex);
}

test('UFC packet process renders Research Completeness heading', () => {
  const process = buildTestProcess();
  const rendered = renderDecisionProcess(process, { heading: 'Research Completeness' });
  assert.match(rendered, /Research Completeness/,
    'packet must include Research Completeness heading');
});

test('UFC packet process renders Required checklist (sources checked)', () => {
  const process = buildTestProcess();
  const rendered = renderDecisionProcess(process, { heading: 'Research Completeness' });
  assert.match(rendered, /Required checklist/,
    'packet must include Required checklist section (sources checked)');
});

test('UFC packet process renders unchecked items (missing inputs)', () => {
  const process = buildTestProcess();
  const rendered = renderDecisionProcess(process, { heading: 'Research Completeness' });
  assert.match(rendered, /\[ \]/, 'packet must show unchecked items to expose missing inputs');
  assert.ok(process.missingEvidence.length > 0,
    'missingEvidence must be non-empty when checklist is incomplete');
});

test('UFC packet process includes Missing evidence field (no-pick reason)', () => {
  const process = buildTestProcess();
  const rendered = renderDecisionProcess(process, { heading: 'Research Completeness' });
  assert.match(rendered, /Missing evidence:/, 'packet must include Missing evidence field');
  const missing = process.missingEvidence;
  assert.ok(
    missing.some(m => /matchup|form|injury|evidence/i.test(m)),
    `Missing evidence must name absent research items; got: ${missing.join(', ')}`,
  );
});

test('UFC packet process includes anti-price justification field', () => {
  const process = buildTestProcess();
  const rendered = renderDecisionProcess(process, { heading: 'Research Completeness' });
  assert.match(rendered, /Why it is not price-only/,
    'packet must include "Why it is not price-only" field');
  assert.ok(
    process.whyNotPriceOnly && process.whyNotPriceOnly.length > 10,
    `whyNotPriceOnly must be a meaningful string; got: "${process.whyNotPriceOnly}"`,
  );
});

test('UFC packet output includes sources checked, missing inputs, research completeness, anti-price statement, and no-pick reason', () => {
  const text = buildPriceOnlyPacketText();
  assert.match(text, /Research Completeness/, 'packet must include research completeness section');
  assert.match(text, /sources_checked:/, 'packet must list sources checked');
  assert.match(text, /missing_inputs:/, 'packet must list missing inputs');
  assert.match(text, /Missing evidence:/, 'packet must render missing evidence/no-pick inputs');
  assert.match(text, /anti_price_statement:/, 'packet must include anti-price statement');
  assert.match(text, /Why it is not price-only:/, 'packet must include anti-price justification');
  assert.match(text, /no_pick_reason:/, 'packet must include no-pick reason');
});

test('UFC packet keeps prices, volume, open interest, and line movement out of Edge Basis', () => {
  const text = buildPriceOnlyPacketText();
  const edgeBasis = sectionBetween(text, '--- Edge Basis ---', '--- Market Context - NOT IN SCORE ---');
  const marketContext = sectionBetween(text, '--- Market Context - NOT IN SCORE ---', 'market_watch_notes');
  for (const term of ['yes_bid', 'yes_ask', 'last_price', 'liquidity', 'volume', 'open_interest', 'line_movement']) {
    assert.doesNotMatch(edgeBasis, new RegExp(term, 'i'), `Edge Basis must not contain ${term}`);
    assert.match(marketContext, new RegExp(term, 'i'), `Market Context must contain ${term}`);
  }
});

test('UFC packet with price-only market data stays WATCH, not PICK or EVIDENCE_LEAN', () => {
  const text = buildPriceOnlyPacketText();
  assert.match(text, /^  decision_status: WATCH$/m, 'price-only packet must stay WATCH');
  assert.doesNotMatch(
    text,
    /^  decision_status: (?:PICK|EVIDENCE[_ ]LEAN|STRONG EVIDENCE[_ ]LEAN)$/m,
    'price-only packet must not become PICK or EVIDENCE_LEAN',
  );
});

test('UFC packet TLDR note denies evidence lean without fighter context', () => {
  const tldrNote = 'fight board only; no evidence lean without fighter status and matchup context.';
  assert.ok(tldrNote.includes('no evidence lean'),
    'TLDR note must deny evidence lean without fighter context');
  assert.ok(!tldrNote.toLowerCase().includes('pick'),
    'TLDR note must not assert a pick');
});

// ─── 5. Anti-price rules: price alone cannot produce a pick ──────────────────

test('SPORTS_GAME with only market_board_context cannot become PICK or EVIDENCE_LEAN', () => {
  const p = evaluateDecisionProcess({
    marketType: MARKET_TYPES.SPORTS_GAME,
    rawDecision: 'LEAN',
    hasMarketSignal: true,
    checked: { market_board_context: true },
  });
  assert.notEqual(p.decisionStatus, 'PICK',
    'market board alone must not produce PICK');
  assert.notEqual(p.decisionStatus, DECISION_STATUSES.EVIDENCE_LEAN,
    'market board alone must not produce EVIDENCE_LEAN');
  assert.notEqual(p.decisionStatus, DECISION_STATUSES.STRONG_EVIDENCE_LEAN,
    'market board alone must not produce STRONG_EVIDENCE_LEAN');
});

test('forceWatch=true keeps UFC generator-style WATCH at WATCH regardless of checked items', () => {
  const p = evaluateDecisionProcess({
    marketType: MARKET_TYPES.SPORTS_GAME,
    rawDecision: 'WATCH',
    forceWatch: true,
    checked: {
      projected_participants: true,
      lineup_injury_news: true,
      venue_context: true,
      recent_form_matchup: true,
      market_board_context: true,
      evidence_supported_side: false,
    },
  });
  assert.equal(p.decisionStatus, DECISION_STATUSES.WATCH,
    'forceWatch=true with raw WATCH must keep status at WATCH even with most items checked');
});

test('evidence_supported_side=false blocks EVIDENCE_LEAN even when all other items checked', () => {
  const p = evaluateDecisionProcess({
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
  });
  assert.notEqual(p.decisionStatus, 'PICK',
    'evidence_supported_side=false must block PICK');
  assert.notEqual(p.decisionStatus, DECISION_STATUSES.EVIDENCE_LEAN,
    'evidence_supported_side=false must block EVIDENCE_LEAN');
  assert.notEqual(p.decisionStatus, DECISION_STATUSES.STRONG_EVIDENCE_LEAN,
    'evidence_supported_side=false must block STRONG_EVIDENCE_LEAN');
});

test('price/OI/volume signals alone cannot upgrade any market type past MARKET-ONLY LEAN', () => {
  for (const marketType of Object.values(MARKET_TYPES)) {
    const checked = marketType === MARKET_TYPES.PLAYER_PROP
      ? { line_ladder_comparison: true }
      : { market_board_context: true };
    const p = evaluateDecisionProcess({
      marketType,
      rawDecision: 'LEAN',
      hasMarketSignal: true,
      checked,
    });
    assert.notEqual(p.decisionStatus, 'PICK', `${marketType}: price-only -> no PICK`);
    assert.notEqual(p.decisionStatus, DECISION_STATUSES.EVIDENCE_LEAN, `${marketType}: price-only → no EVIDENCE_LEAN`);
    assert.notEqual(p.decisionStatus, DECISION_STATUSES.STRONG_EVIDENCE_LEAN, `${marketType}: price-only → no STRONG_EVIDENCE_LEAN`);
  }
});

// ─── 6. Dry-run / generator integration test ─────────────────────────────────

test('generate-ufc-weekly.mjs runs to completion with temp state root (integration)', { timeout: 45_000 }, () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ufc-cron-test-'));
  const date = '2099-01-03';
  try {
    const localDir = join(tmp, 'ufc', date);
    mkdirSync(localDir, { recursive: true });
    writeFileSync(
      join(localDir, 'local-ufc-card.json'),
      JSON.stringify({
        event_name: 'Local UFC Test Card',
        venue: 'Test Arena',
        fights: [{ fighter_a: 'Alpha Fighter', fighter_b: 'Beta Fighter', weight_class: '155', slot: 'main' }],
      }),
      'utf8',
    );
    const result = spawnSync(
      '/usr/bin/node',
      [GENERATOR, '--date', date, '--state-root', tmp],
      { encoding: 'utf8', timeout: 40_000, cwd: REPO },
    );
    assert.equal(result.status, 0,
      `Generator must exit 0; got ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    const combined = (result.stdout || '') + (result.stderr || '');
    assert.match(combined, new RegExp(PACKET_TYPE),
      'Output must reference ufc-weekly packet type');
    assert.match(combined, /\[dry-run\]|\[ufc-weekly\]/,
      'Output must include packet summary or dry-run summary');
    const packetPath = join(tmp, 'packets', date, PACKET_TYPE, `${date}-local-ufc-card.txt`);
    assert.equal(existsSync(packetPath), true, `Expected packet output at ${packetPath}`);
    const packet = readFileSync(packetPath, 'utf8');
    assert.match(packet, /telegram_send: disabled/, 'packet must state Telegram send is disabled');
    assert.match(packet, /No trades placed by this workflow\./, 'packet must preserve no-trades footer');
    assert.match(packet, /No bankroll advice\. No order placement\. Research only\./,
      'packet must preserve no-order-placement footer');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
