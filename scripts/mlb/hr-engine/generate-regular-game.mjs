import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildGameHrProjections, loadRegularGameModel } from './regular-game-model.mjs';
import { buildRegularGamePacketArtifacts } from './regular-game-packet.mjs';

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function generateRegularGameArtifacts({
  modelPath,
  input,
  outputDir,
  generatedUtc,
  seed,
  simulations = 10_000,
} = {}) {
  if (!modelPath || !input || !outputDir || !generatedUtc || !seed) {
    throw new Error('modelPath, input, outputDir, generatedUtc, and seed are required');
  }
  const model = loadRegularGameModel(modelPath);
  const projection = buildGameHrProjections({
    model,
    batters: input.batters,
    evidence: input.evidence,
    opposing_pitchers: input.opposing_pitchers,
    park: input.park,
    weather: input.weather,
    lineup_status: input.lineup_status,
    seed,
    simulations,
    as_of: input.game?.date,
  });
  const artifacts = buildRegularGamePacketArtifacts({
    game: input.game,
    projection,
    generatedUtc,
    modelSource: modelPath,
  });
  const out = resolve(outputDir);
  mkdirSync(out, { recursive: true });
  writeJson(resolve(out, 'projections.json'), artifacts.projection);
  writeFileSync(resolve(out, 'packet.txt'), `${artifacts.packetText}\n`, 'utf8');
  writeJson(resolve(out, 'profiles.json'), artifacts.profiles);
  writeJson(resolve(out, 'simulation-summary.json'), artifacts.simulationSummary);
  writeJson(resolve(out, 'assumptions-ledger.json'), artifacts.assumptionsLedger);
  writeFileSync(resolve(out, 'inventory.txt'), `${artifacts.inventoryText}\n`, 'utf8');
  writeJson(resolve(out, 'audit.json'), artifacts.audit);
  return artifacts;
}

function parseArgs(argv) {
  const opts = { simulations: 10_000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--model') opts.modelPath = argv[++i];
    else if (arg === '--input') opts.inputPath = argv[++i];
    else if (arg === '--output-dir') opts.outputDir = argv[++i];
    else if (arg === '--generated-utc') opts.generatedUtc = argv[++i];
    else if (arg === '--seed') opts.seed = argv[++i];
    else if (arg === '--simulations') opts.simulations = Number(argv[++i]);
    else if (arg === '--help') opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node scripts/mlb/hr-engine/generate-regular-game.mjs --model MODEL.json --input INPUT.json --output-dir DIR --generated-utc ISO --seed TEXT');
    return;
  }
  const { readFileSync } = await import('node:fs');
  const input = JSON.parse(readFileSync(resolve(opts.inputPath), 'utf8'));
  generateRegularGameArtifacts({ ...opts, input });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
}
