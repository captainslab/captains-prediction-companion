#!/usr/bin/env node
// Offline generator. It writes only to an explicitly supplied output directory
// and never sends, schedules, deploys, or reads credentials.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildFixtureHomeRunDerbyPacket } from './derby-packet.mjs';

function parseArgs(argv) {
  const options = {
    outputDir: null,
    seed: 'cpc-hr-derby-phase3-fixture',
    simulations: 4000,
    generatedUtc: '2026-07-13T00:00:00.000Z',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output-dir') options.outputDir = argv[++index];
    else if (arg === '--seed') options.seed = argv[++index];
    else if (arg === '--simulations') options.simulations = Number(argv[++index]);
    else if (arg === '--generated-utc') options.generatedUtc = argv[++index];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.help) return options;
  if (!options.outputDir) throw new Error('--output-dir is required');
  if (!Number.isInteger(options.simulations) || options.simulations <= 0) throw new Error('--simulations must be a positive integer');
  return options;
}
function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function generateDerbyArtifacts(options) {
  const packet = buildFixtureHomeRunDerbyPacket({
    seed: options.seed,
    simulations: options.simulations,
    generated_utc: options.generatedUtc,
  });
  const outputDir = resolve(options.outputDir);
  mkdirSync(outputDir, { recursive: true });
  writeJson(`${outputDir}/projections.json`, packet.projection);
  writeFileSync(`${outputDir}/packet.txt`, packet.packetText, 'utf8');
  writeJson(`${outputDir}/participant-profiles.json`, packet.participantProfiles);
  writeJson(`${outputDir}/simulation-summary.json`, packet.simulationSummary);
  writeJson(`${outputDir}/assumptions-ledger.json`, packet.assumptionsLedger);
  writeFileSync(`${outputDir}/inventory.txt`, packet.inventoryText, 'utf8');
  writeJson(`${outputDir}/audit.json`, packet.audit);
  return { outputDir, packet };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log('Usage: node scripts/mlb/hr-engine/generate-derby.mjs --output-dir DIR [--seed SEED] [--simulations N] [--generated-utc ISO]');
    } else {
      const result = generateDerbyArtifacts(options);
      console.log(`Generated 2026 Home Run Derby fixture artifacts in ${result.outputDir}`);
      console.log(`packet_sha256=${result.packet.audit.packet_sha256}`);
      console.log('no_trades_placed=true');
    }
  } catch (error) {
    console.error(`Derby generation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
