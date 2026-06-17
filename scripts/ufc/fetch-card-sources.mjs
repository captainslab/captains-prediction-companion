#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchFighter } from './lib/source-fetcher.mjs';

const UFC_LANE_SOURCES = [
  { lane: 'winner', series: 'KXUFCFIGHT' },
  { lane: 'method_of_victory', series: 'KXUFCMOV' },
  { lane: 'go_the_distance', series: 'KXUFCDISTANCE' },
  { lane: 'round_of_victory', series: 'KXUFCVICROUND' },
  { lane: 'round_of_finish', series: 'KXUFCROUNDS' },
  { lane: 'method_of_finish', series: 'KXUFCMOF' },
];

function parseArgs(argv) {
  const opts = { date: new Date().toISOString().slice(0, 10), stateRoot: 'state', help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--date') opts.date = argv[++i];
    else if (arg === '--state-root') opts.stateRoot = argv[++i];
    else if (arg === '--help' || arg === '-h') opts.help = true;
  }
  return opts;
}

function slug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node scripts/ufc/fetch-card-sources.mjs --date YYYY-MM-DD [--state-root state]');
    return;
  }
  const root = resolve(opts.stateRoot, 'ufc', opts.date, 'kalshi-events');
  const out = resolve(opts.stateRoot, 'ufc', 'sources');
  mkdirSync(out, { recursive: true });
  const written = [];
  for (const lane of UFC_LANE_SOURCES) {
    const lanePath = resolve(root, `${lane.series}.json`);
    try {
      const event = JSON.parse(readFileSync(lanePath, 'utf8'));
      for (const market of event.markets || []) {
        const fighter = market.yes_sub_title;
        if (!fighter) continue;
        const res = fetchFighter(fighter);
        if (!res.ok || !res.stats) continue;
        const path = join(out, `${slug(fighter)}.json`);
        writeFileSync(path, JSON.stringify({ fighter, source_url: res.source_url, stats: res.stats }, null, 2));
        written.push(path);
      }
    } catch {}
  }
  console.log(JSON.stringify({ source_id: 'ufc_stats', written }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
