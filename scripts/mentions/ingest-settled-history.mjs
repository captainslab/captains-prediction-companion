#!/usr/bin/env node
// Settled-history ingest for mention markets.
//
// Bounded, route-aware ingest of prior SETTLED mention markets into the
// price-free history store at state/mentions/history/. Two modes:
//
//   --from-file markets.json   ingest raw market objects from a local file
//                              (shape: [ {...market} ] or { markets: [...] })
//   --series KXTRUMPMENTION    fetch settled markets for ONE series ticker
//                              from the public Kalshi API (single bounded
//                              request, no crawling, no auth)
//
// All price/volume/liquidity fields are stripped at ingest by
// sanitizeSettledRecord; only outcome-relevant fields persist.
//
// Usage:
//   node scripts/mentions/ingest-settled-history.mjs --from-file f.json \
//     [--route trump_weekly] [--entity trump] [--horizon weekly] [--state-root state]
//   node scripts/mentions/ingest-settled-history.mjs --series KXTRUMPMENTION \
//     [--route ...] [--limit 100]

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { ingestSettledMarkets } from './settled-history.mjs';
import { resolveResearchRoute } from './mention-route-resolver.mjs';

const KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const MAX_LIMIT = 200; // single bounded request — never paginate/crawl

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

export async function fetchSettledMarketsForSeries(seriesTicker, { limit = 100, fetchImpl = fetch } = {}) {
  const capped = Math.min(Math.max(1, Number(limit) || 100), MAX_LIMIT);
  const url = `${KALSHI_API_BASE}/markets?series_ticker=${encodeURIComponent(seriesTicker)}&status=settled&limit=${capped}`;
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Kalshi settled-markets fetch failed: HTTP ${res.status} for ${url}`);
  const body = await res.json();
  return Array.isArray(body?.markets) ? body.markets : [];
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || (!argValue(args, '--from-file') && !argValue(args, '--series'))) {
    console.log('Usage: ingest-settled-history.mjs (--from-file markets.json | --series SERIES) [--route R] [--entity E] [--horizon weekly|monthly|event] [--state-root state] [--limit 100]');
    return;
  }
  const stateRoot = argValue(args, '--state-root') || 'state';
  const fromFile = argValue(args, '--from-file');
  const series = argValue(args, '--series');

  let rawMarkets;
  if (fromFile) {
    const parsed = JSON.parse(readFileSync(fromFile, 'utf8'));
    rawMarkets = Array.isArray(parsed) ? parsed : (parsed.markets ?? []);
  } else {
    rawMarkets = await fetchSettledMarketsForSeries(series, { limit: argValue(args, '--limit') ?? 100 });
  }
  if (!rawMarkets.length) {
    console.log('[settled-history] no settled markets to ingest');
    return;
  }

  // Route metadata: explicit flags win; otherwise resolve from the market text
  // via the shared resolver (same authority as generator/collector).
  let route = argValue(args, '--route');
  let entity = argValue(args, '--entity');
  let horizon = argValue(args, '--horizon');
  if (!route) {
    const probe = resolveResearchRoute({
      event_ticker: rawMarkets[0]?.event_ticker ?? null,
      series_ticker: series ?? rawMarkets[0]?.series_ticker ?? null,
      title: rawMarkets[0]?.title ?? null,
      markets: rawMarkets.slice(0, 5),
    });
    route = probe.route;
    entity = entity ?? probe.entity;
    horizon = horizon ?? probe.horizon;
  }

  const out = await ingestSettledMarkets({ rawMarkets, route, entity, horizon, stateRoot });
  console.log(`[settled-history] ingested ${out.stored} settled market(s) (price-free) -> ${out.path}; route=${route} entity=${entity ?? 'n/a'} horizon=${horizon ?? 'n/a'}; total records in store: ${out.records.length}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`[settled-history] failed: ${err.message}`);
    process.exit(1);
  });
}
