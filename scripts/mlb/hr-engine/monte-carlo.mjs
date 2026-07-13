// Deterministic simulation primitives. The random source is always injected.
import { assertNoPriceFields } from '../lib/projection-contracts.mjs';
import { assertKnownFields } from './contracts.mjs';

const SIMULATION_FIELDS = Object.freeze([
  'seed', 'plate_appearances', 'hr_probability', 'simulations', 'contact_probability',
]);

export function hashSeed(seed = '') {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(String(seed))) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createSeededRng(seed) {
  return mulberry32(hashSeed(seed));
}

export function seededNormal(rng, mean = 0, standardDeviation = 1) {
  const u = Math.max(Number.EPSILON, rng());
  const v = Math.max(Number.EPSILON, rng());
  return mean + standardDeviation * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function seededCategorical(rng, categories) {
  if (!Array.isArray(categories) || categories.length === 0) throw new Error('seededCategorical requires non-empty categories');
  const total = categories.reduce((sum, item) => sum + Number(item.weight ?? 0), 0);
  if (!(total > 0)) throw new Error('seededCategorical requires positive weights');
  let cursor = rng() * total;
  for (const item of categories) {
    cursor -= Number(item.weight ?? 0);
    if (cursor <= 0) return item.value;
  }
  return categories[categories.length - 1].value;
}

export function simulatePaOutcomes(input = {}) {
  assertNoPriceFields(input, 'HR simulation input');
  assertKnownFields(input, SIMULATION_FIELDS, 'HR simulation input');
  const {
    seed,
    plate_appearances,
    hr_probability,
    simulations = 400,
    contact_probability = 1,
  } = input;
  if (!Number.isInteger(plate_appearances) || plate_appearances <= 0) throw new Error('plate_appearances must be a positive integer');
  if (!Number.isFinite(hr_probability) || hr_probability < 0 || hr_probability > 1) throw new Error('hr_probability must be in [0,1]');
  if (!Number.isFinite(contact_probability) || contact_probability < 0 || contact_probability > 1) throw new Error('contact_probability must be in [0,1]');
  if (!Number.isInteger(simulations) || simulations <= 0) throw new Error('simulations must be a positive integer');
  const rng = createSeededRng(seed);
  const counts = [];
  let atLeastOne = 0;
  let sum = 0;
  for (let simulation = 0; simulation < simulations; simulation += 1) {
    let hrs = 0;
    for (let pa = 0; pa < plate_appearances; pa += 1) {
      if (rng() < contact_probability && rng() < hr_probability) hrs += 1;
    }
    counts.push(hrs);
    sum += hrs;
    if (hrs > 0) atLeastOne += 1;
  }
  const distribution = {};
  for (const count of counts) distribution[count] = (distribution[count] ?? 0) + 1;
  for (const key of Object.keys(distribution)) distribution[key] /= simulations;
  return {
    seed: String(seed), simulations, plate_appearances,
    probability_at_least_one_hr: atLeastOne / simulations,
    mean_hr: sum / simulations,
    hr_count_distribution: distribution,
    trace: counts.slice(0, 8),
  };
}

export const runPaSimulation = simulatePaOutcomes;
