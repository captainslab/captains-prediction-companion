// Shared Discord Markdown formatter — coverage for EVERY current packet family.
//
// The shared formatter (scripts/shared/discord-format.mjs) is the single place
// where any packet family becomes Discord-ready output. These tests prove the
// Markdown cleanup (banner -> heading, metadata compaction, divider removal,
// boundary-aware splitting) works for representative fixtures of every current
// family, while every invariant still holds: parts stay under the 2000-char
// hard limit, clean packets redact to zero, raw inventory is refused, section
// order is preserved, and route selection is independent of packet content.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  beautifyPacketMarkdown,
  buildDiscordPost,
  routeDiscordPosts,
  scrubSecrets,
  splitForDiscord,
  DISCORD_HARD_LIMIT,
} from '../scripts/shared/discord-format.mjs';

// ---------------------------------------------------------------------------
// Representative raw fixtures — one per current packet family. Each mimics the
// banner-header + divider-clutter style the cron renderers emit today. NONE
// contain market price in a way that feeds scoring (price is display-only in a
// `market:` half), and none are raw inventory dumps.
// ---------------------------------------------------------------------------

const FIXTURES = {
  'worldcup-matchday': [
    '=== CPC Packet: World Cup Match Preview 2026-06-22 wc-2026-06-22-arg-vs-ger ===',
    'generated_utc: Monday, June 22, 2026 at 7:00 AM CDT',
    'Market Context — NOT IN SCORE.',
    '------------------------------------------------------------',
    'Headline: A tournament-pressure match with bracket stakes attached.',
    '',
    '=== 1. MODEL READ ===',
    'Result edge: Compact defensive shape favors the stronger transition side.',
    'Projected: Projected 2.3 goals',
    '',
    '=== 2. SOURCE-BACKED PREVIEW ===',
    'Primary source: Tournament preview desk',
    'Research only. No trades.',
  ].join('\n'),

  'mlb-daily': [
    '=== MLB Daily Decision Board ===',
    'date: 2026-05-31',
    '',
    'TLDR BOARD:',
    '  rows=139 :: top_edge=1 | watchlist=4 | blocked=126 | pass=8',
    '============================================================',
    '=== 1. TOP EDGE CANDIDATES (1) ===',
    '#1 [PICK] KX-1 :: Over 6.5 runs',
    '    model: fair=85% score=85 posture=PICK layers=6/9 conf=medium',
    '    market: implied=0.70 yes_ask=0.70 | edge=+4pp',
    '',
    '=== 2. WATCHLIST / TRIGGER BOARD (0) ===',
    '  (none)',
    '',
    '=== 3. AUDIT ARTIFACTS ===',
    '  - /state/packets/2026-05-31/mlb-daily/x.inventory.txt',
  ].join('\n'),

  'nascar-sunday': [
    '=== NASCAR Sunday Ceiling Board 2026-06-14 ===',
    'race: Sonoma',
    '------------------------------------------------------------',
    '=== CEILING BOARD ===',
    '#1 [LEAN] KXNASCAR-1 :: Top-5 finish',
    '    model: ceiling=72 score=72 posture=LEAN conf=medium',
    '',
    '=== FIELD / LONGSHOTS ===',
    '  (none rated)',
  ].join('\n'),

  'mentions-daily': [
    '=== Captain Mentions — CPC Packet: TRUMP MENTION EVENT ===',
    'URL: https://kalshi.com/markets/kxtrumpmention/what-will-trump-say/KXTRUMPMENTION-26MAY30',
    'NOTE: composite scores are model priors based on documented public record.',
    '################################################################',
    '=== RANKED BOARD (by composite, mention markets only) ===',
    '#1 [WATCH] "tariff" :: composite=61',
    '------------------------------------------------------------------------',
    '=== PER-MARKET DETAIL ===',
    'tariff :: recent hits dominate the prior.',
    '=== END ===',
  ].join('\n'),

  'ufc-weekly': [
    '=== UFC Fight Night Decision Board 2026-06-14 ===',
    'card: UFC Fight Night — Sonoma',
    '____________________________________________________________',
    '=== 1. TOP EDGE CANDIDATES ===',
    '#1 [PICK] KXUFCFIGHT-1 :: Fighter A by decision',
    '    model: fair=64% score=64 posture=PICK conf=medium',
    '    market: implied=0.55 | edge=+9pp',
    '',
    '=== 2. BLOCKED / NEEDS SOURCE ===',
    '#1 [BLOCKED] KXUFCFIGHT-2 :: needs source',
  ].join('\n'),

  alerts: [
    '=== CPC Alert ===',
    'kind: source-gap',
    '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
    'A required source layer is missing for KX-42. Packet held.',
  ].join('\n'),
};

const FAMILIES = Object.keys(FIXTURES);

// ---------------------------------------------------------------------------

test('beautify removes every raw === banner header for every family', () => {
  for (const fam of FAMILIES) {
    const pretty = beautifyPacketMarkdown(FIXTURES[fam]);
    assert.doesNotMatch(pretty, /^\s*={2,}.*={2,}\s*$/m, `${fam}: a raw === banner survived`);
  }
});

test('beautify emits Markdown headings and a title for every family', () => {
  for (const fam of FAMILIES) {
    const pretty = beautifyPacketMarkdown(FIXTURES[fam]);
    assert.match(pretty, /^# .+/m, `${fam}: no top-level (#) title heading`);
    assert.match(pretty, /^##? .+/m, `${fam}: no Markdown headings at all`);
  }
});

test('beautify strips decorative divider clutter for every family', () => {
  for (const fam of FAMILIES) {
    const pretty = beautifyPacketMarkdown(FIXTURES[fam]);
    for (const line of pretty.split('\n')) {
      assert.doesNotMatch(line, /^\s*[-_*~#]{3,}\s*$/, `${fam}: decorative divider "${line}" survived`);
    }
  }
});

test('beautify collapses leading metadata into one compact subtext line', () => {
  const pretty = beautifyPacketMarkdown(FIXTURES['mlb-daily']);
  assert.match(pretty, /^-# date: 2026-05-31$/m, 'mlb metadata not compacted to subtext');
  // Content that merely looks meta (TLDR BOARD:) is NOT swept into the subtext.
  assert.match(pretty, /^TLDR BOARD:$/m, 'TLDR content was wrongly treated as metadata');
});

test('beautify preserves section order for every family', () => {
  for (const fam of FAMILIES) {
    const rawHeaders = FIXTURES[fam]
      .split('\n')
      .map((l) => l.match(/^\s*={2,}\s*(.+?)\s*={2,}\s*$/))
      .filter(Boolean)
      .map((m) => m[1].trim());
    const pretty = beautifyPacketMarkdown(FIXTURES[fam]);
    const prettyHeadings = pretty
      .split('\n')
      .filter((l) => /^##? /.test(l))
      .map((l) => l.replace(/^##? /, '').trim());
    assert.deepEqual(prettyHeadings, rawHeaders, `${fam}: heading order/content drifted`);
  }
});

test('every family: buildDiscordPost yields parts under the 2000-char hard limit', () => {
  for (const fam of FAMILIES) {
    const { parts, partCount } = buildDiscordPost({ packetText: FIXTURES[fam], title: `CPC ${fam}` });
    assert.ok(partCount >= 1, `${fam}: expected at least one part`);
    for (const p of parts) {
      assert.ok(p.length <= DISCORD_HARD_LIMIT, `${fam}: part length ${p.length} > ${DISCORD_HARD_LIMIT}`);
    }
  }
});

test('every family: clean packet produces redaction_count=0', () => {
  for (const fam of FAMILIES) {
    const { redactions } = buildDiscordPost({ packetText: FIXTURES[fam], title: `CPC ${fam}` });
    assert.equal(redactions, 0, `${fam}: a clean packet must redact zero secrets`);
  }
});

test('every family: an oversized packet splits and stays under the hard limit', () => {
  for (const fam of FAMILIES) {
    const big = FIXTURES[fam] + '\n' + Array.from({ length: 600 }, (_, i) =>
      `#${i} [BLOCKED] KX-${i} :: long driver name needs source layer to unlock edge here`).join('\n');
    const { parts, partCount } = buildDiscordPost({ packetText: big, title: `CPC ${fam}` });
    assert.ok(partCount > 1, `${fam}: oversized packet should split into multiple parts`);
    for (const p of parts) {
      assert.ok(p.length <= DISCORD_HARD_LIMIT, `${fam}: split part length ${p.length} > ${DISCORD_HARD_LIMIT}`);
    }
    assert.match(parts[0], /\[part 1\//, `${fam}: part numbering missing`);
  }
});

test('splitForDiscord prefers section-heading boundaries when it must split', () => {
  const a = 'A'.repeat(1200);
  const b = 'B'.repeat(1200);
  const text = `## Section One\n${a}\n\n## Section Two\n${b}`;
  const parts = splitForDiscord(text);
  assert.ok(parts.length >= 2, 'expected a split');
  // Section Two should begin a part rather than being stranded mid-part.
  assert.ok(parts.some((p) => /\n## Section Two/.test(p) || /^\[part \d+\/\d+\]\n## Section Two/.test(p)),
    'split did not land on the section-heading boundary');
});

// The World Cup renderer frames each section title BETWEEN two U+2500 box-drawing
// dividers instead of using `=== Title ===` banners, and wraps a footer note the
// same way. Beautify must strip every box divider, promote each single-line
// sandwiched title to a heading (in order), and leave multi-line wrapped notes
// as plain text rather than headings.
const BOX = '─'.repeat(60);
const BOX_DIVIDER_PACKET = [
  '=== Captain World Cup — CPC Packet: MATCHDAY FORECAST ===',
  'date: 2026-07-11',
  'packet_type: worldcup-matchday',
  '',
  BOX,
  '  Why it matters',
  BOX,
  '',
  '  Today\'s games: Norway vs England; Argentina vs Switzerland.',
  '',
  BOX,
  '  1. Matchday Forecast',
  BOX,
  '',
  '  • Norway vs England: No clear side; projected total 2.61',
  '',
  BOX,
  '  2. Match Breakdowns',
  BOX,
  '',
  '  ▶ Norway vs England [Round of 32]',
  '',
  BOX,
  '  Market prices are display-only when presented and never feed the model.',
  '  No trades placed. Research only.',
  BOX,
].join('\n');

test('beautify strips U+2500 box dividers and promotes sandwiched titles', () => {
  const pretty = beautifyPacketMarkdown(BOX_DIVIDER_PACKET);
  // No box-drawing divider line may survive.
  for (const line of pretty.split('\n')) {
    assert.doesNotMatch(line, /^\s*[─━═]{3,}\s*$/, `box divider "${line}" survived`);
  }
  // The top `===` banner becomes the single `#` title; the box-sandwiched
  // sections become `##` headings, in original order.
  const headings = pretty
    .split('\n')
    .filter((l) => /^##? /.test(l))
    .map((l) => l.replace(/^##? /, '').trim());
  assert.deepEqual(headings, [
    'Captain World Cup — CPC Packet: MATCHDAY FORECAST',
    'Why it matters',
    '1. Matchday Forecast',
    '2. Match Breakdowns',
  ], 'box-sandwiched section order/content drifted');
  assert.match(pretty, /^# Captain World Cup/m, 'no single top-level title');
});

test('beautify leaves a multi-line box-wrapped note as plain text, not a heading', () => {
  const pretty = beautifyPacketMarkdown(BOX_DIVIDER_PACKET);
  // The two-line footer note must survive as body text (never promoted).
  assert.match(pretty, /^ *Market prices are display-only/m, 'footer note line 1 lost');
  assert.match(pretty, /^ *No trades placed\. Research only\.$/m, 'footer note line 2 lost');
  assert.doesNotMatch(pretty, /^##? .*Market prices are display-only/m, 'footer note wrongly promoted to a heading');
});

test('box-divider packet: buildDiscordPost stays under the hard limit and redacts zero', () => {
  const { parts, redactions, partCount } = buildDiscordPost({ packetText: BOX_DIVIDER_PACKET, title: 'CPC World Cup' });
  assert.ok(partCount >= 1, 'expected at least one part');
  assert.equal(redactions, 0, 'clean box-divider packet must redact zero secrets');
  for (const p of parts) {
    assert.ok(p.length <= DISCORD_HARD_LIMIT, `part length ${p.length} > ${DISCORD_HARD_LIMIT}`);
  }
});

test('raw-inventory refusal still fires after the Markdown cleanup', () => {
  const inv = '=== RAW CONTRACT INVENTORY (AUDIT ONLY — NOT IN MAIN PACKET) ===\n#1 ...\n#2 ...';
  assert.throws(() => buildDiscordPost({ packetText: inv }), /RAW inventory/);
});

test('secrets are scrubbed before the packet is reshaped', () => {
  const leaky = FIXTURES['ufc-weekly'] + '\nwebhook_url=https://discord.com/api/webhooks/999/SECRETTOKENVALUE12345';
  const { parts, redactions } = buildDiscordPost({ packetText: leaky, title: 'CPC UFC' });
  assert.ok(redactions >= 1, 'leak should be detected');
  assert.doesNotMatch(parts.join('\n'), /SECRETTOKENVALUE12345/, 'secret leaked into output');
});

test('route selection is independent of packet content and market data', () => {
  // Same packet body, different declared packetType -> different route.
  // Swapping the body (including any market: lines) must not move the route.
  const bodyA = FIXTURES['mlb-daily'];
  const bodyB = FIXTURES['nascar-sunday'];
  const routedAsMlbWithMlbBody = routeDiscordPosts([{ packetType: 'mlb-daily', packetText: bodyA }])[0].channel;
  const routedAsMlbWithNascarBody = routeDiscordPosts([{ packetType: 'mlb-daily', packetText: bodyB }])[0].channel;
  assert.equal(routedAsMlbWithMlbBody, routedAsMlbWithNascarBody, 'route changed when only body changed');
  assert.equal(routedAsMlbWithMlbBody, '#cpc-mlb');
});

test('a market: line never alters routing (price isolation at the route layer)', () => {
  const withPrice = '=== Alert ===\nmarket: implied=0.99 yes_ask=0.99 volume=99999';
  const withoutPrice = '=== Alert ===\nkind: source-gap';
  const r1 = routeDiscordPosts([{ packetType: 'alerts', packetText: withPrice }])[0].channel;
  const r2 = routeDiscordPosts([{ packetType: 'alerts', packetText: withoutPrice }])[0].channel;
  assert.equal(r1, r2, 'market data influenced the route');
});
