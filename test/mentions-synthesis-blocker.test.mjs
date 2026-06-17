import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  writeKalshiEventPackets,
  synthesizeMentionsUserPacket,
  buildKalshiEventPacket,
  composeMentionPacketDeterministic,
} from '../scripts/packets/generate-mentions-daily.mjs';
import { writeAudit, previewAudit } from '../scripts/packets/lib/common.mjs';

const DATE = '2026-06-12';

function proximityOnlyEvent(ticker = 'KXWCMENTION-26JUN12CANBIH') {
  return {
    event_ticker: ticker,
    title: `What will the announcers say? [${ticker}]`,
    sub_title: 'World Cup broadcast mentions',
    series_ticker: 'KXWCMENTION',
    markets: [
      {
        ticker: `${ticker}-GOAL`,
        title: 'What will the announcers say?',
        yes_sub_title: 'Golazo',
        custom_strike: { Word: 'Golazo' },
        yes_bid_dollars: '0.10',
        yes_ask_dollars: '0.15',
        rules_primary: 'If the broadcast says Golazo, the market resolves Yes.',
        mention_profile: 'broadcast_mentions',
        layer_records: {
          event_proximity: {
            present: true,
            score: 20,
            source_basis: 'official broadcast schedule confirmed',
          },
        },
      },
    ],
  };
}

function compliantPacketText(event) {
  const built = buildKalshiEventPacket({ date: DATE, event, sourceUrl: '/tmp/x.json' });
  const fullStrike = built.synthesisInput.terms[0].full_strike_text;
  return [
    `Event title: ${event.title}`,
    `Date/time: ${DATE}`,
    'Setup: LOW-SOURCE WATCH only -- no pick.',
    `Watch-only terms: ${fullStrike} - LOW-SOURCE WATCH only -- no pick.`,
    'Market Context - NOT IN SCORE: bid/ask context only.',
    'Research-only footer: No trades placed. Research-only.',
  ].join('\n');
}

function violatingPacketText(event) {
  // Old model-written layout: no renderMentionPacket/v2 contract.
  return `${compliantPacketText(event)}\nThis is a source-backed composite read.`;
}

function makeSynthesizeImpl(textByTicker, calls = []) {
  return async ({ input }) => {
    calls.push(input.event.title);
    const ticker = (input.event.title.match(/\[(.+)\]/) || [])[1];
    if (ticker === 'KXWCMENTION-26JUN12CANBIH') {
      return { text: textByTicker(ticker), invocation: { renderer: 'legacy-model-packet_text' } };
    }
    return composeMentionPacketDeterministic({ input, env: {}, now: () => '2026-06-12T18:00:00.000Z' });
  };
}

test('old model packet_text synthesis becomes a blocker artifact, not final customer layout, and later events still produce packets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mentions-blocker-'));
  const dir = resolve(root, 'packets', DATE, 'mentions-daily');
  mkdirSync(dir, { recursive: true });
  const badTicker = 'KXWCMENTION-26JUN12CANBIH';
  const goodTicker = 'KXWCMENTION-26JUN12USAMEX';
  const bad = proximityOnlyEvent(badTicker);
  const good = proximityOnlyEvent(goodTicker);

  const result = await writeKalshiEventPackets({
    events: [bad, good],
    date: DATE,
    stateRoot: root,
    dir,
    audit: writeAudit,
    dryRun: false,
    synthesizeImpl: makeSynthesizeImpl((ticker) =>
      ticker === badTicker ? violatingPacketText(bad) : compliantPacketText(good)),
  });

  // The bad event is recorded as blocked, with a blocker artifact on disk.
  assert.deepEqual(result.failedTickers, [badTicker]);
  const blockerPath = resolve(root, 'mentions', DATE, 'blockers', `${DATE}-${badTicker}.json`);
  assert.ok(existsSync(blockerPath), 'blocker artifact must exist');
  const blocker = JSON.parse(readFileSync(blockerPath, 'utf8'));
  assert.equal(blocker.delivered, false);
  assert.equal(blocker.stage, 'model_synthesis');
  assert.match(blocker.error, /renderMentionPacket\/v2 contract/);

  // No deliverable .txt for the blocked event; the good event's packet exists.
  assert.ok(!existsSync(resolve(dir, `${DATE}-${badTicker}.txt`)), 'blocked event must not get a deliverable packet');
  assert.ok(existsSync(resolve(dir, `${DATE}-${goodTicker}.txt`)), 'later event must still be written');
  assert.ok(result.items.some((it) => it.name === goodTicker));
  assert.ok(!result.items.some((it) => it.name === badTicker));
});

test('synthesizeMentionsUserPacket fails closed for customer-facing packet_text synthesis', async () => {
  await assert.rejects(
    () => synthesizeMentionsUserPacket({ input: {}, chatRunner: async () => ({ ok: true, parsed: { packet_text: 'old' } }) }),
    /model-written mentions packet_text synthesis is disabled/,
  );
});

test('failedTickers is always initialized: success-only run returns an empty list', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mentions-blocker-ok-'));
  const dir = resolve(root, 'packets', DATE, 'mentions-daily');
  mkdirSync(dir, { recursive: true });
  const good = proximityOnlyEvent('KXWCMENTION-26JUN12USAMEX');

  const result = await writeKalshiEventPackets({
    events: [good],
    date: DATE,
    stateRoot: root,
    dir,
    audit: writeAudit,
    dryRun: false,
    synthesizeImpl: makeSynthesizeImpl(() => compliantPacketText(good)),
  });

  assert.deepEqual(result.failedTickers, []);
  assert.ok(Array.isArray(result.failedTickers));
});

test('dry-run never invokes model synthesis and leaves no deliverable artifacts (nothing for Telegram to send)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mentions-blocker-dry-'));
  const dir = resolve(root, 'packets', DATE, 'mentions-daily');
  const good = proximityOnlyEvent('KXWCMENTION-26JUN12USAMEX');
  const calls = [];

  const result = await writeKalshiEventPackets({
    events: [good],
    date: DATE,
    stateRoot: root,
    dir,
    audit: previewAudit,
    dryRun: true,
    synthesizeImpl: makeSynthesizeImpl(() => compliantPacketText(good), calls),
  });

  assert.equal(calls.length, 0, 'dry-run must not call model synthesis');
  assert.deepEqual(result.failedTickers, []);
  assert.ok(!existsSync(dir) || readdirSync(dir).length === 0, 'dry-run must leave no deliverable artifacts');
});
