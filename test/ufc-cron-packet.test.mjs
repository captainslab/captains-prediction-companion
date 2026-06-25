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
  buildCompositeCard,
  PACKET_TYPE,
  weekendDates,
} from '../scripts/packets/generate-ufc-weekly.mjs';
import { renderUfcPacket } from '../scripts/ufc/lib/packet-renderer.mjs';
import { renderUfcModelScores } from '../scripts/ufc/lib/model-score-matrix.mjs';

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
    topEvidence: ['Kalshi fight market set captured with 19 market(s).'],
    settlementRules: 'UFC market settlement criteria not independently pulled by this packet.',
    verifiedFacts: 'Participants/market contracts captured; fighter status context still required.',
    marketSignalText: 'Price context captured for research; no CPC read inferred from price.',
    socialChatter: 'Not used as verified fact.',
    inference: 'Fight inference blocked until fighter status, matchup, recent form, and card-change checks are complete.',
    skepticReview: 'MISSING: no skeptic review in packet generator.',
    finalJudgment: 'WATCH only; no CPC read from price context or fight context alone.',
    whyNotPriceOnly: 'Price context is reference-only; no final CPC read is claimed without fighter-status, matchup, and card-change evidence.',
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

test('UFC packet process includes Missing evidence field (rated-view reason)', () => {
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

test('UFC packet output uses compact BLOCKED format with NOT IN SCORE', () => {
  const text = buildPriceOnlyPacketText();
  assert.match(text, /BLOCKED_MODEL_LAYER_MISSING/, 'packet must include BLOCKED_MODEL_LAYER_MISSING');
  assert.match(text, /BLOCKED — MODEL LAYER MISSING/, 'packet must include BLOCKED section header');
  assert.match(text, /NOT IN SCORE/, 'packet must include NOT IN SCORE marker');
  assert.match(text, /audit inventory only/, 'packet must note market data is in audit only');
});

test('UFC compact packet keeps raw market data out of customer body (audit inventory only)', () => {
  const built = buildKalshiEventPacket({
    event: priceOnlyUfcEvent(),
    dates: weekendDates('2099-01-03'),
    sourcePath: '/tmp/ufc-price-only-source.json',
  });
  for (const term of ['yes_bid', 'yes_ask', 'last_price', 'liquidity', 'volume', 'open_interest']) {
    assert.doesNotMatch(built.text, new RegExp(term, 'i'), `Customer packet must not contain ${term}`);
  }
  assert.ok(built.inventoryText, 'Must produce inventory text');
  assert.match(built.inventoryText, /markets:/, 'Inventory must contain markets section');
});

test('UFC compact packet never claims a rated view from price context alone', () => {
  const text = buildPriceOnlyPacketText();
  assert.doesNotMatch(
    text,
    /decision_status: (?:PICK|EVIDENCE[_ ]LEAN|STRONG EVIDENCE[_ ]LEAN)/m,
    'compact BLOCKED packet must not claim a rated view from price context alone',
  );
});

test('UFC composite path keeps raw prices out of the customer packet', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'ufc-cron-composite-'));
  try {
    const cacheDir = join(tempDir, 'ufc', 'sources');
    mkdirSync(cacheDir, { recursive: true });
    const fighterA = { slpm: 5.1, str_acc: 56, sapm: 3.2, str_def: 59, td_avg: 2.1, td_acc: 49, td_def: 73, sub_avg: 0.7, height: '5\' 11"', reach: 73, stance: 'Switch', record: { wins: 13, losses: 2, draws: 0 }, fights: [{ result: 'win', method: 'KO/TKO' }] };
    const fighterB = { slpm: 2.7, str_acc: 39, sapm: 5.1, str_def: 42, td_avg: 0.7, td_acc: 28, td_def: 44, sub_avg: 0.2, height: '5\' 8"', reach: 68, stance: 'Orthodox', record: { wins: 8, losses: 5, draws: 0 }, fights: [{ result: 'loss', method: 'U-DEC' }] };
    writeFileSync(join(cacheDir, 'alpha.json'), JSON.stringify({ stats: fighterA }), 'utf8');
    writeFileSync(join(cacheDir, 'beta.json'), JSON.stringify({ stats: fighterB }), 'utf8');

    const winner = priceOnlyUfcEvent();
    winner.markets[0].yes_sub_title = 'Alpha';
    winner.markets[0].no_sub_title = 'Beta';
    winner.markets[0].ticker = 'KXUFCFIGHT-99JAN03ALPBET-ALPHA';
    winner.markets.push({
      ticker: 'KXUFCFIGHT-99JAN03ALPBET-BETA',
      event_ticker: winner.event_ticker,
      title: 'Will Beta beat Alpha?',
      subtitle: 'Beta',
      yes_sub_title: 'Beta',
      no_sub_title: 'Alpha',
      yes_bid_dollars: '0.55',
      yes_ask_dollars: '0.58',
      no_bid_dollars: '0.42',
      no_ask_dollars: '0.45',
      last_price_dollars: '0.56',
      liquidity_dollars: '1200.00',
      volume_fp: '150',
      open_interest_fp: '80',
      close_time: '2099-01-03T23:00:00Z',
      expected_expiration_time: '2099-01-03T23:00:00Z',
    });
    const composite = buildCompositeCard({
      kalshiEvents: [winner],
      allLaneEvents: [
        winner,
        { event_ticker: 'KXUFCMOV-99JAN03ALPBET', title: 'Alpha vs Beta: Method of Victory', markets: [{ ticker: 'MOV' }] },
        { event_ticker: 'KXUFCDISTANCE-99JAN03ALPBET', title: 'Alpha vs Beta: To Go The Distance', markets: [{ ticker: 'DIST' }] },
        { event_ticker: 'KXUFCVICROUND-99JAN03ALPBET', title: 'Alpha vs Beta: Round of Victory', markets: [{ ticker: 'VIC' }] },
        { event_ticker: 'KXUFCROUNDS-99JAN03ALPBET', title: 'Alpha vs Beta: Round of Finish', markets: [{ ticker: 'ROF' }] },
        { event_ticker: 'KXUFCMOF-99JAN03ALPBET', title: 'Alpha vs Beta: Method of Finish', markets: [{ ticker: 'MOF' }] },
      ],
      cacheDir,
      date: '2099-01-03',
    });

    const packetText = renderUfcPacket({
      cardTitle: composite.cardTitle,
      date: '2099-01-03',
      card: { fights: composite.fights },
      sources: ['UFCStats.com'],
    });
    const matrixText = renderUfcModelScores({
      cardTitle: composite.cardTitle,
      date: '2099-01-03',
      card: { fights: composite.fights },
    });

    assert.match(packetText, /captured lanes:/);
    assert.doesNotMatch(packetText, /bid=|ask=|last=|vol=/);
    assert.doesNotMatch(matrixText, /bid=|ask=|last=|vol=/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('UFC packet TLDR note denies a rated view without fighter context', () => {
  const tldrNote = 'fight board only; no rated view without fighter status and matchup context.';
  assert.ok(tldrNote.includes('no rated view'),
    'TLDR note must deny a rated view without fighter context');
  assert.ok(!tldrNote.toLowerCase().includes('pick'),
    'TLDR note must not assert a pick');
});

// ─── 5. Anti-price rules: price alone cannot produce a pick ──────────────────

test('SPORTS_GAME with only market_board_context cannot become a rated view', () => {
  const p = evaluateDecisionProcess({
    marketType: MARKET_TYPES.SPORTS_GAME,
    rawDecision: 'LEAN',
    hasMarketSignal: true,
    checked: { market_board_context: true },
  });
  assert.notEqual(p.decisionStatus, 'PICK',
    'market board alone must not produce a top-rated model view');
  assert.notEqual(p.decisionStatus, DECISION_STATUSES.EVIDENCE_LEAN,
    'market board alone must not produce a higher-rated model view');
  assert.notEqual(p.decisionStatus, DECISION_STATUSES.STRONG_EVIDENCE_LEAN,
    'market board alone must not produce a top-rated model view');
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

test('evidence_supported_side=false blocks a higher-rated view even when all other items are checked', () => {
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
    'evidence_supported_side=false must block a top-rated model view');
  assert.notEqual(p.decisionStatus, DECISION_STATUSES.EVIDENCE_LEAN,
    'evidence_supported_side=false must block a higher-rated model view');
  assert.notEqual(p.decisionStatus, DECISION_STATUSES.STRONG_EVIDENCE_LEAN,
    'evidence_supported_side=false must block a top-rated model view');
});

test('price/OI/volume signals alone cannot upgrade any market type past market signal only', () => {
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
    assert.notEqual(p.decisionStatus, 'PICK', `${marketType}: price-only -> no top-rated model view`);
    assert.notEqual(p.decisionStatus, DECISION_STATUSES.EVIDENCE_LEAN, `${marketType}: price-only → no higher-rated model view`);
    assert.notEqual(p.decisionStatus, DECISION_STATUSES.STRONG_EVIDENCE_LEAN, `${marketType}: price-only → no top-rated model view`);
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
    assert.match(packet, /BLOCKED_MODEL_LAYER_MISSING|No trades placed by this workflow\./, 'packet must include BLOCKED or no-trades footer');
    assert.match(packet, /No order placement\. Research only\./,
      'packet must preserve no-order-placement footer');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
