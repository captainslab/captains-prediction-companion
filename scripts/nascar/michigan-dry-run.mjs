#!/usr/bin/env node
// Michigan dry-run: 2026 FireKeepers Casino 400 at Michigan International Speedway.
// Generates research-only packet using committed Gen-7 loop history and track-aware scoring model.
// No live network. No credentials. No trades. No market pricing in scoring.

import { pathToFileURL } from 'node:url';
import { composeMichiganPacket } from './lib/michigan-packet.mjs';

async function main() {
  const outputDir = process.argv.includes('--output-dir')
    ? process.argv[process.argv.indexOf('--output-dir') + 1]
    : 'state/nascar/2026-06-07/firekeepers-casino-400';

  process.stdout.write('Generating 2026 FireKeepers Casino 400 packet (Michigan International Speedway)...\n');
  process.stdout.write(`Output: ${outputDir}\n\n`);

  const result = await composeMichiganPacket({ outputDir });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(err => {
    process.stderr.write(`Michigan dry-run failed: ${err.message ?? err}\n${err.stack ?? ''}\n`);
    process.exit(1);
  });
}
