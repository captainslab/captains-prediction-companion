import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildTelegramPreview,
  parseBotArgs,
  resolveLiveConfig,
} from '../channels/telegram/bot.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fakeSummary() {
  return {
    source: {
      platform: 'Kalshi',
      url: 'https://kalshi.com/markets/KXMENTIONS-26JUN09POWELL-INFLATION',
      market_id: 'KXMENTIONS-26JUN09POWELL-INFLATION',
    },
    event_domain: 'media',
    event_type: 'speech',
    market_type: 'mention',
    status: 'needs_pricing',
    confidence: 'low',
    summary: {
      headline: 'The mention contract is mapped but missing fair value.',
      recommendation: 'watch',
      one_line_reason: 'Kalshi source resolved; model fair value has not been produced.',
    },
    next_action: 'run mention source ladder and re-score',
    market_view: {
      target_phrase: 'inflation',
      rules_summary: 'Exact-string settlement wording from the source listing.',
      trade_view: {
        best_side: 'watch',
        market_status: 'active',
        market_ticker: 'KXMENTIONS-26JUN09POWELL-INFLATION',
        market_yes: 0.42,
        market_yes_bid: 0.4,
        market_yes_ask: 0.44,
        fair_yes: null,
      },
    },
  };
}

test('parseBotArgs accepts the documented dry-run flag and en dash variant', () => {
  assert.deepEqual(
    parseBotArgs(['--dry-run', 'KXTEST-1']).mode,
    'dry-run',
  );
  const parsed = parseBotArgs(['\u2013dry-run', 'KXTEST-1']);
  assert.equal(parsed.mode, 'dry-run');
  assert.equal(parsed.input, 'KXTEST-1');
});

test('buildTelegramPreview dry-run routes a ticker without Telegram token or network send', async () => {
  let planCalls = 0;
  const preview = await buildTelegramPreview('KXMENTIONS-26JUN09POWELL-INFLATION', {
    writeArtifact: false,
    planBuilder: async (input) => {
      planCalls += 1;
      assert.equal(input.market_ticker, 'KXMENTIONS-26JUN09POWELL-INFLATION');
      return { user_facing: fakeSummary() };
    },
  });

  assert.equal(planCalls, 1);
  assert.equal(preview.route.status, 'routed');
  assert.equal(preview.route.workflow.id, 'event_market_card');
  assert.equal(preview.response.status, 'WAITING');
  assert.match(preview.formatted.parts.join('\n'), /CPC Decision Packet/);
  assert.match(preview.formatted.parts.join('\n'), /market data is NOT IN SCORE/);
});

test('resolveLiveConfig blocks live mode when token is missing and does not print a value', () => {
  assert.throws(
    () => resolveLiveConfig({}),
    /TELEGRAM_BOT_TOKEN is required.*not printed/,
  );
});

test('dry-run CLI works without TELEGRAM_BOT_TOKEN', () => {
  const env = { ...process.env };
  delete env.TELEGRAM_BOT_TOKEN;
  delete env.TELEGRAM_CHAT_ID;
  const result = spawnSync(process.execPath, [
    'channels/telegram/bot.mjs',
    '--no-artifact',
    '--dry-run',
    'Will Powell say inflation?',
  ], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[telegram-bot\] mode=dry-run/);
  assert.match(result.stdout, /WAITING_FOR_MARKET_SOURCE/);
  assert.doesNotMatch(result.stdout + result.stderr, /TELEGRAM_BOT_TOKEN=.*[A-Za-z0-9]/);
});

test('live CLI exits clearly when TELEGRAM_BOT_TOKEN is missing without contacting Telegram', () => {
  const env = { ...process.env };
  delete env.TELEGRAM_BOT_TOKEN;
  delete env.TELEGRAM_CHAT_ID;
  const result = spawnSync(process.execPath, [
    'channels/telegram/bot.mjs',
    '--live',
  ], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TELEGRAM_BOT_TOKEN is required/);
  assert.doesNotMatch(result.stdout + result.stderr, /1234567890:AA/);
  assert.doesNotMatch(result.stdout + result.stderr, /bot.*\/sendMessage/i);
});
