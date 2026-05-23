#!/usr/bin/env node
// NASCAR Coca-Cola 600 dry-run packet CLI.
// Fixtures-only. No live network. No credentials. No trading.
import { pathToFileURL } from 'node:url';
import { composeCocaCola600Packet } from './lib/coca-cola-600-packet.mjs';

async function main() {
  const result = await composeCocaCola600Packet({
    outputDir: 'state/nascar/2026-05-25',
  });
  const summary = {
    run_date: result.runDate,
    output_dir: result.outputDir,
    files: result.files,
    practice_envelope_status: result.practice_envelope_status,
    practice_degraded_reasons: result.practice_degraded_reasons,
    storyline_posture_hint: result.modifier.posture_hint,
    storyline_score: result.modifier.storyline_score,
    true_win_modifier_delta: result.modifier.true_win_modifier.delta_probability,
    true_win_modifier_applied: result.modifier.true_win_modifier.applied,
    beneficiary: result.beneficiary,
    mode: 'fixtures-only',
    no_trades: true,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(err => {
    process.stderr.write(`Coca-Cola 600 dry-run failed: ${err.message ?? err}\n`);
    if (err.stack) process.stderr.write(`${err.stack}\n`);
    process.exit(1);
  });
}
