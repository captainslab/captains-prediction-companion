#!/usr/bin/env node
// last30days-dry-run.mjs
//
// Dry run of the last30days collector against saved Kalshi event fixtures.
// Free sources only. Writes research records next to the fixtures under
// research/ so generate-mentions-daily's merge logic can be tested.
//
// Usage:
//   node scripts/mentions/source-adapters/last30days-dry-run.mjs [--fixture-dir DIR] [--only KIND[,KIND]]

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectLast30DaysEvidence } from './last30days-collector.mjs';
import { evaluateSourceLadder, renderSourceLadder } from '../source-ladder.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_FIXTURE_DIR = resolve(__dirname, '../../../state/mentions/test-fixtures/2026-06-11');

// Per-fixture research topics + speaker hints (event-level, one fetch each).
const TOPIC_CONFIG = {
  earningsmention: {
    topic: 'Adobe earnings call Q2 2026',
    speakerHint: 'Adobe',
    profile: 'earnings_mentions',
  },
  creatormention: {
    topic: 'MrBeast new video',
    speakerHint: 'MrBeast',
    profile: 'political_mentions', // creator profile not registered yet; same expected categories minus formal_document_proxy
  },
  presmention: {
    topic: 'Trump America is Back rally',
    speakerHint: 'Trump',
    profile: 'political_mentions',
  },
  polmention: {
    topic: 'Kevin Warsh Fed press conference June 2026',
    speakerHint: 'Warsh',
    profile: 'political_mentions',
  },
  sportsmention: {
    topic: 'Brazil vs Morocco World Cup',
    speakerHint: null,
    profile: 'sports_announcer_mentions',
  },
};

function parseArgs(argv) {
  const opts = { fixtureDir: DEFAULT_FIXTURE_DIR, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--fixture-dir') opts.fixtureDir = resolve(argv[++i]);
    else if (argv[i] === '--only') opts.only = argv[++i].split(',').map((s) => s.trim());
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return opts;
}

function strikeText(market) {
  return market.yes_sub_title || market.subtitle || market.ticker;
}

function main() {
  const { fixtureDir, only } = parseArgs(process.argv.slice(2));
  const researchDir = join(fixtureDir, 'research');
  mkdirSync(researchDir, { recursive: true });

  const fixtures = readdirSync(fixtureDir)
    .filter((f) => f.endsWith('.json') && f.includes('--'))
    .map((f) => ({ kind: f.split('--')[0], file: join(fixtureDir, f) }))
    .filter((fx) => TOPIC_CONFIG[fx.kind] && (!only || only.includes(fx.kind)));

  if (!fixtures.length) {
    console.error('No matching mention fixtures found.');
    process.exit(1);
  }

  for (const fx of fixtures) {
    const event = JSON.parse(readFileSync(fx.file, 'utf8'));
    const cfg = TOPIC_CONFIG[fx.kind];
    const strikes = (event.markets ?? []).map(strikeText).filter(Boolean);

    console.log(`\n=== ${fx.kind}: ${event.event_ticker} (${strikes.length} strikes) ===`);
    console.log(`topic: "${cfg.topic}"  speaker_hint: ${cfg.speakerHint ?? 'none'}`);

    const t0 = Date.now();
    const result = collectLast30DaysEvidence({
      topic: cfg.topic,
      strikes,
      speakerHint: cfg.speakerHint,
    });
    console.log(`fetch_ok=${result.fetch_ok} items=${result.item_count} transcripts=${result.transcripts_fetched} quality=${result.research_quality} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    if (result.fetch_error) console.log(`fetch_error: ${result.fetch_error}`);

    // Render the ladder for the first 3 strikes as a smoke check.
    for (const strike of strikes.slice(0, 3)) {
      const ladder = evaluateSourceLadder({ profile: cfg.profile, inputs: result.per_strike[strike] });
      console.log(`\n--- strike: "${strike}" ---`);
      console.log(renderSourceLadder(ladder).map((l) => `  ${l}`).join('\n'));
    }

    const outPath = join(researchDir, `${event.event_ticker}.json`);
    writeFileSync(outPath, `${JSON.stringify({
      event_ticker: event.event_ticker,
      profile: cfg.profile,
      research_quality: result.research_quality,
      collected_at: result.fetched_at,
      adapter: result.adapter,
      topic: result.topic,
      source_ladder_inputs_per_strike: result.per_strike,
    }, null, 2)}\n`, 'utf8');
    console.log(`\nwrote ${outPath}`);
  }
}

main();
