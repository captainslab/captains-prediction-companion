#!/usr/bin/env node
// IndyCar 2026 Indy 500 dry-run packet CLI.
// Fixtures-only. No live network. No credentials. No trading.
import { pathToFileURL } from 'node:url';
import { composeIndy500Packet } from './lib/indy500-packet.mjs';

async function main() {
  const result = await composeIndy500Packet({
    outputDir: 'state/indycar/2026-05-25',
  });
  const summary = {
    run_date: result.runDate,
    output_dir: result.outputDir,
    files: result.files,
    board_size: result.board_size,
    ceiling_distribution: result.ceilings,
    mode: 'fixtures-only',
    no_trades: true,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(err => {
    process.stderr.write(`Indy 500 dry-run failed: ${err.message ?? err}\n`);
    if (err.stack) process.stderr.write(`${err.stack}\n`);
    process.exit(1);
  });
}
