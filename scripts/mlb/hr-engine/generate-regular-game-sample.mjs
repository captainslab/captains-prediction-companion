// Reproducible audit sample built from the committed fitted model profiles.
// The matchup is explicitly labeled AUDIT_SAMPLE and is not a schedule claim.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadRegularGameModel } from './regular-game-model.mjs';
import { generateRegularGameArtifacts } from './generate-regular-game.mjs';

export const SAMPLE_MODEL_PATH = 'scripts/mlb/hr-engine/artifacts/regular-game-model-2025.json';
export const SAMPLE_GENERATED_UTC = '2025-09-29T12:00:00.000Z';
export const SAMPLE_SEED = 'cpc-hr-regular-game-held-out-proof-v1';

function batter(model, id, lineupSlot, side) {
  const profile = model.profiles?.batters?.[String(id)];
  if (!profile) throw new Error(`sample batter profile missing: ${id}`);
  return {
    mlb_id: String(id),
    batter_id: String(id),
    player_name: profile.player_name,
    stand: profile.stand,
    latest_event_date: profile.latest_event_date,
    lineup_slot: lineupSlot,
    side,
    windows: profile.windows,
  };
}

function pitcher(model, id, hand) {
  const profile = model.profiles?.pitchers?.[String(id)];
  if (!profile) throw new Error(`sample pitcher profile missing: ${id}`);
  return {
    mlb_id: String(id),
    p_throws: hand,
    latest_event_date: profile.latest_event_date,
    windows: profile.windows,
  };
}

export function buildRegularGameSampleInput(model) {
  const batters = [
    batter(model, '592450', 2, 'away'), // Aaron Judge
    batter(model, '519317', 4, 'away'), // Giancarlo Stanton
    batter(model, '680776', 1, 'home'), // Jarren Duran
    batter(model, '596115', 5, 'home'), // Trevor Story
  ];
  const parkProfile = model.profiles?.parks?.BOS;
  if (!parkProfile) throw new Error('sample park profile missing: BOS');
  return {
    game: {
      game_id: 'AUDIT-NYY-BOS-20250929',
      date: '2025-09-29',
      away_team: 'NYY',
      home_team: 'BOS',
      sample_mode: true,
    },
    batters,
    evidence: batters,
    opposing_pitchers: {
      away: pitcher(model, '608331', 'L'), // Max Fried profile
      home: pitcher(model, '676979', 'L'), // Garrett Crochet profile
    },
    park: { id: 'BOS', roof: null, altitude: null, windows: parkProfile.windows },
    weather: { roof: null, temperature_f: null, wind_out_mph: null, directional_fit: null },
    lineup_status: 'confirmed',
  };
}

export function generateRegularGameSample({
  modelPath = SAMPLE_MODEL_PATH,
  outputDir,
} = {}) {
  if (!outputDir) throw new Error('outputDir is required');
  const model = loadRegularGameModel(resolve(modelPath));
  const input = buildRegularGameSampleInput(model);
  return generateRegularGameArtifacts({
    modelPath,
    input,
    outputDir,
    generatedUtc: SAMPLE_GENERATED_UTC,
    seed: SAMPLE_SEED,
    simulations: 20_000,
  });
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--model') opts.modelPath = argv[++i];
    else if (argv[i] === '--output-dir') opts.outputDir = argv[++i];
    else if (argv[i] === '--help') opts.help = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return opts;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.log('Usage: node scripts/mlb/hr-engine/generate-regular-game-sample.mjs --output-dir DIR [--model MODEL.json]');
    } else {
      generateRegularGameSample(opts);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  }
}
