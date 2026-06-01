// NASCAR loop-history source adapter (Gen 7 era: 2022 -> present).
//
// Reads the committed cf.nascar.com loop-feed snapshots OFFLINE and rolls them
// into the per-driver track-aware layer inputs consumed by
// track-aware-scoring-core.mjs. No live network at runtime. No credentials. No
// market/odds/price data of any kind — this is a pure fundamentals source.
//
// ════════════════════════════════════════════════════════════════════════════
// CARDINAL KEYING INVARIANT
//   "Driver skill layers follow the DRIVER. Equipment layers follow the CAR/TEAM."
//
//   Driver-keyed (PRIMARY KEY = normalized driver name) — these signals are the
//   human's skill and MUST move with the driver across teams/car numbers:
//     - track_history
//     - similar_track_history
//     - track_type_fit (recent_form_weighted_by_track_type is its proxy here)
//     - recent_form_weighted_by_track_type
//     - passing_difficulty_context
//     - restart_overtime_skill
//     - incident_dnf_risk
//     - long_run_speed / single_lap_speed (driver pace in the track-type sample)
//
//   Car/team-keyed (KEY = car_number + team + manufacturer) — these are the
//   charter/shop's assets and MUST move with the CAR, not the driver:
//     - team_equipment_strength
//     - pit_crew_and_pit_road
//     - crew_chief_strategy (when crew-chief/team data exists)
//
//   Car numbers are team/charter assets and change drivers year to year. Driver
//   track history is NEVER keyed primarily by car number — car_number is used
//   ONLY as a secondary equipment/team key and as a disambiguation field. The
//   equipment join uses the UPCOMING race's entry-list car assignment so a
//   driver inherits the equipment of the car they are ACTUALLY in this week,
//   never a previous occupant's record.
// ════════════════════════════════════════════════════════════════════════════
//
// ERA FLOOR: Next Gen / Gen 7 only. Any race season < 2022 is hard-dropped so
// pre-Next-Gen aero/package results never pollute track fit. The captured
// snapshots are already 2022+, so this is enforced defensively.
//
// EVIDENCE DISCIPLINE: a track/similar-track history rollup with fewer than
// MIN_HISTORY_SAMPLE driver-races is emitted as LOW_EVIDENCE (the scoring core
// then downgrades confidence). Drivers with zero qualifying races get the layer
// omitted entirely (MISSING) — never a fabricated value.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = resolve(__dirname, 'snapshots');

export const GEN7_ERA_FLOOR_SEASON = 2022;
const MIN_HISTORY_SAMPLE = 3;
const DEFAULT_SEASONS = Object.freeze([2022, 2023, 2024, 2025, 2026]);

function loadSeason(season) {
  const p = resolve(SNAPSHOT_DIR, `nascar-loop-${season}.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function normName(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\([^)]*\)/g, '')          // strip feed tags e.g. "(P)" "(i)"
    .replace(/[*#]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv)\b\.?/gi, '') // unify Jr./Sr./suffixes
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function avg(xs) { const f = xs.filter((x) => Number.isFinite(x)); return f.length ? f.reduce((s, x) => s + x, 0) / f.length : null; }

// finish position -> 0-100 (P1 -> 100, P36+ -> 0).
function finishScore(f) {
  if (!Number.isFinite(f)) return null;
  return clamp(Math.round(((37 - f) / 36) * 100), 0, 100);
}
// avg running position -> 0-100 (running up front all race is the signal).
function runPosScore(p) {
  if (!Number.isFinite(p)) return null;
  return clamp(Math.round(((37 - p) / 36) * 100), 0, 100);
}
// normalize a raw metric to 0-100 within the race field (percentile rank).
function percentileWithinField(value, allValues, higherIsBetter = true) {
  if (!Number.isFinite(value)) return null;
  const xs = allValues.filter((x) => Number.isFinite(x));
  if (xs.length < 2) return null;
  const below = xs.filter((x) => (higherIsBetter ? x < value : x > value)).length;
  return clamp(Math.round((below / (xs.length - 1)) * 100), 0, 100);
}

/**
 * Build a per-driver, per-race feature table from the Gen-7 snapshots.
 * Each row carries within-field percentiles so cross-track aggregation is fair
 * (a 190mph lap means nothing in absolute terms across track types).
 */
function buildRaceRows({ seasons = DEFAULT_SEASONS } = {}) {
  const rows = [];
  for (const season of seasons) {
    if (season < GEN7_ERA_FLOOR_SEASON) continue; // era floor
    const snap = loadSeason(season);
    if (!snap || !Array.isArray(snap.races)) continue;
    for (const race of snap.races) {
      if (race.capture_status !== 'ok' || !Array.isArray(race.drivers) || race.drivers.length < 20) continue;
      const longRunField = race.drivers.map((d) => d.avg_running_position);
      const lapField = race.drivers.map((d) => d.best_lap_speed);
      const passField = race.drivers.map((d) => d.passing_differential);
      const restartField = race.drivers.map((d) => d.avg_restart_speed);
      const qualityField = race.drivers.map((d) => d.quality_passes);
      for (const d of race.drivers) {
        rows.push({
          season,
          track_id: race.track_id,
          track_name: race.track_name,
          track_type: race.track_type,
          driver_key: normName(d.driver_name),
          driver_name: d.driver_name,
          car_number: d.car_number,
          finish: d.finish,
          finish_score: finishScore(d.finish),
          run_pos_score: runPosScore(d.avg_running_position),
          long_run_pct: percentileWithinField(d.avg_running_position, longRunField, false),
          single_lap_pct: percentileWithinField(d.best_lap_speed, lapField, true),
          passing_pct: percentileWithinField(d.passing_differential, passField, true),
          restart_pct: percentileWithinField(d.avg_restart_speed, restartField, true),
          quality_pass_pct: percentileWithinField(d.quality_passes, qualityField, true),
          dnf: d.status !== 1 && Number.isFinite(d.finish) ? null : null, // status semantics vary; not used as DNF truth
        });
      }
    }
  }
  return rows;
}

function evidenceFor(sample) {
  if (sample <= 0) return null;
  return sample < MIN_HISTORY_SAMPLE ? 'LOW_EVIDENCE' : 'OK';
}

// ---------------------------------------------------------------------------
// EQUIPMENT KEY PATH (car/team — NOT driver).
// The car's Gen-7 results belong to the charter/shop. We aggregate per
// car_number (the charter asset) so the equipment layer reflects the CAR's
// program strength, independent of which driver sat in it. team / manufacturer
// are carried for context and as a secondary match key. A driver inherits the
// equipment of the car they are ENTERED in for the upcoming race.
// ---------------------------------------------------------------------------
function normCar(car) {
  if (car === null || car === undefined || car === '') return null;
  const s = String(car).trim().replace(/^#/, '');
  return s.length ? s : null;
}

/**
 * Roll the Gen-7 snapshots up BY CAR NUMBER into an equipment-strength signal.
 * Uses the car's finish + running-position results (program output), never the
 * driver identity. Returns Map<carNumber, {score, sample, teams, manufacturers,
 * seasons}>.
 */
function carEquipmentRollup({ seasons = DEFAULT_SEASONS } = {}) {
  const rows = buildRaceRows({ seasons });
  const byCar = new Map();
  for (const r of rows) {
    const car = normCar(r.car_number);
    if (car === null) continue;
    if (!byCar.has(car)) byCar.set(car, { finishes: [], runPos: [], seasons: new Set() });
    const e = byCar.get(car);
    if (Number.isFinite(r.finish_score)) e.finishes.push(r.finish_score);
    if (Number.isFinite(r.run_pos_score)) e.runPos.push(r.run_pos_score);
    e.seasons.add(r.season);
  }
  const out = new Map();
  for (const [car, e] of byCar) {
    const vals = [...e.finishes, ...e.runPos];
    if (!vals.length) continue;
    const score = Math.round(avg(vals));
    const sample = e.finishes.length;
    const evidence = evidenceFor(sample);
    if (evidence === null) continue;
    out.set(car, { score, sample, evidence, seasons: [...e.seasons].sort() });
  }
  return out;
}

/**
 * Build the CAR/TEAM-keyed equipment layers for an upcoming entry list.
 * Each entry is { driver_name, car_number, team?, manufacturer? } describing
 * who is in which car THIS week. The equipment layers are looked up by the
 * entry's car_number (charter asset), so a driver who changed cars inherits the
 * new car's program — never their old number's record, and never another
 * driver's history.
 *
 * @returns {Map<driverKey, { team_equipment_strength?, pit_crew_and_pit_road?,
 *   crew_chief_strategy?, _car_context }>}
 */
function equipmentLayersByDriverKey({ entryList = [], seasons = DEFAULT_SEASONS } = {}) {
  const carRollup = carEquipmentRollup({ seasons });
  const byKey = new Map();
  for (const entry of entryList) {
    const key = normName(entry.driver_name);
    if (!key) continue;
    const car = normCar(entry.car_number);
    const rec = car !== null ? carRollup.get(car) : null;
    const layers = {};
    const carContext = {
      car_number: car,
      team: entry.team ?? null,
      manufacturer: entry.manufacturer ?? null,
      car_history_sample: rec?.sample ?? 0,
      car_history_seasons: rec?.seasons ?? [],
      keyed_by: car !== null ? 'car_number+team+manufacturer' : 'MISSING_car_number',
    };
    if (rec) {
      // team_equipment_strength: the car/charter's Gen-7 program output.
      layers.team_equipment_strength = {
        score: rec.score,
        evidence: rec.evidence,
        sample: rec.sample,
        note: `car #${car} Gen-7 program output (n=${rec.sample}; keyed by car/team, not driver)`,
      };
      // pit_crew_and_pit_road: only when explicit team data is supplied (no
      // fabrication). If the caller passes a numeric team pit grade, honor it;
      // otherwise leave MISSING for the scoring core to flag.
      const pit = num(entry.pit_crew_grade ?? entry.team_pit_grade);
      if (pit !== null) {
        layers.pit_crew_and_pit_road = {
          score: clamp(pit, 0, 100), evidence: 'OK', sample: 1,
          note: `team pit grade for car #${car} (supplied)`,
        };
      }
      // crew_chief_strategy: only when crew-chief/team strategy data exists.
      const cc = num(entry.crew_chief_grade);
      if (cc !== null) {
        layers.crew_chief_strategy = {
          score: clamp(cc, 0, 100), evidence: 'OK', sample: 1,
          note: `crew-chief strategy grade for car #${car} (supplied)`,
        };
      }
    }
    byKey.set(key, { layers, _car_context: carContext });
  }
  return byKey;
}

function layerFromRows(rows, scoreField, { sampleNote }) {
  if (!rows.length) return null;
  const vals = rows.map((r) => r[scoreField]).filter((x) => Number.isFinite(x));
  if (!vals.length) return null;
  const sample = vals.length;
  const score = Math.round(avg(vals));
  const evidence = evidenceFor(sample);
  if (evidence === null) return null;
  return { score, evidence, sample, note: `${sampleNote} (n=${sample})` };
}

/**
 * Produce per-driver track-aware layer inputs for ONE upcoming race.
 *
 * @param {object} params
 * @param {object} params.race  - { track_id, track_name, track_type } of the
 *                                 upcoming race (identity used for history join).
 * @param {string[]} [params.driverNames] - restrict to these drivers (the field).
 * @param {number[]} [params.seasons]
 * @returns {object} {
 *   source_id, era_floor_season, track, by_driver: {
 *     <driver_key>: { driver_name, layers: { track_history, similar_track_history,
 *       long_run_speed, single_lap_speed, passing_difficulty_context,
 *       restart_overtime_skill, recent_form_weighted_by_track_type },
 *       evidence_summary }
 *   }, races_considered, source_urls
 * }
 */
export function loopHistoryLayerInputs({ race = {}, driverNames = null, entryList = null, seasons = DEFAULT_SEASONS } = {}) {
  const rows = buildRaceRows({ seasons });
  const wantKeys = driverNames ? new Set(driverNames.map(normName)) : null;
  const trackId = race.track_id ?? null;
  const trackType = race.track_type ?? null;

  // Car/team-keyed equipment layers (separate key path). Built from the
  // upcoming entry list so equipment follows the CAR the driver is in THIS
  // week — never the driver's old number, never a previous occupant's record.
  const equipmentByKey = Array.isArray(entryList) && entryList.length
    ? equipmentLayersByDriverKey({ entryList, seasons })
    : new Map();

  const byDriver = {};
  const driverKeys = new Set(rows.map((r) => r.driver_key));
  for (const key of driverKeys) {
    if (wantKeys && !wantKeys.has(key)) continue;
    const driverRows = rows.filter((r) => r.driver_key === key);
    if (!driverRows.length) continue;
    // Display name = most frequent raw name for this key (a single feed typo
    // like "William Byron Jr." must not surface as the canonical label).
    const nameCounts = new Map();
    for (const r of driverRows) {
      const clean = String(r.driver_name ?? '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/[*#]/g, '').replace(/\s+/g, ' ').trim();
      if (clean) nameCounts.set(clean, (nameCounts.get(clean) || 0) + 1);
    }
    const name = [...nameCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]?.[0]
      ?? driverRows[0].driver_name;

    // This-track history: same track_id (Gen 7 only). Two-date tracks roll in
    // both dates — that is the real this-track sample.
    const thisTrack = trackId != null ? driverRows.filter((r) => r.track_id === trackId) : [];
    // Similar-track history: same track_type, EXCLUDING this exact track.
    const similar = trackType
      ? driverRows.filter((r) => r.track_type === trackType && r.track_id !== trackId)
      : [];
    // Track-type-weighted recent form: same track_type, all of it.
    const sameType = trackType ? driverRows.filter((r) => r.track_type === trackType) : [];

    const layers = {};
    const th = layerFromRows(thisTrack, 'finish_score', { sampleNote: `Gen-7 ${race.track_name ?? 'this-track'} finishes` });
    if (th) layers.track_history = th;
    const sh = layerFromRows(similar, 'finish_score', { sampleNote: `Gen-7 ${trackType ?? 'similar'} finishes` });
    if (sh) layers.similar_track_history = sh;

    // Speed + execution layers pull from same-track-type sample (track-type
    // specific pace is the right unit; absolute pace is meaningless cross-type).
    const lr = layerFromRows(sameType, 'long_run_pct', { sampleNote: `${trackType ?? 'type'} long-run pace pct` });
    if (lr) layers.long_run_speed = lr;
    const sl = layerFromRows(sameType, 'single_lap_pct', { sampleNote: `${trackType ?? 'type'} single-lap pace pct` });
    if (sl) layers.single_lap_speed = sl;
    const pd = layerFromRows(sameType, 'passing_pct', { sampleNote: `${trackType ?? 'type'} passing pct` });
    if (pd) layers.passing_difficulty_context = pd;
    const rs = layerFromRows(sameType, 'restart_pct', { sampleNote: `${trackType ?? 'type'} restart pace pct` });
    if (rs) layers.restart_overtime_skill = rs;
    const rf = layerFromRows(sameType, 'run_pos_score', { sampleNote: `${trackType ?? 'type'} running-position form` });
    if (rf) layers.recent_form_weighted_by_track_type = rf;

    // Merge in CAR/TEAM-keyed equipment layers (separate key path). These come
    // from the upcoming entry list keyed by car_number — they do NOT use this
    // driver's name-keyed history. Driver skill follows the driver; equipment
    // follows the car.
    const equip = equipmentByKey.get(key) ?? null;
    if (equip) {
      if (equip.layers.team_equipment_strength) layers.team_equipment_strength = equip.layers.team_equipment_strength;
      if (equip.layers.pit_crew_and_pit_road) layers.pit_crew_and_pit_road = equip.layers.pit_crew_and_pit_road;
      if (equip.layers.crew_chief_strategy) layers.crew_chief_strategy = equip.layers.crew_chief_strategy;
    }

    byDriver[key] = {
      driver_name: name,
      layers,
      track_specific_inputs: {
        track_name: race.track_name ?? null,
        track_id: trackId,
        track_type: trackType,
        this_track_races: thisTrack.length,
        this_track_finishes: thisTrack.map((r) => r.finish).filter((f) => Number.isFinite(f)),
      },
      similar_track_inputs: {
        track_type: trackType,
        similar_track_races: similar.length,
      },
      // Equipment context is car/team-keyed and kept SEPARATE from the
      // driver-keyed track-history inputs above, so the packet can show the two
      // provenances side by side and never conflate them.
      equipment_inputs: equip ? equip._car_context : {
        car_number: null, team: null, manufacturer: null,
        car_history_sample: 0, car_history_seasons: [],
        keyed_by: entryList ? 'no_entry_for_driver' : 'no_entry_list_supplied',
      },
      evidence_summary: {
        this_track_sample: thisTrack.length,
        similar_track_sample: similar.length,
        same_type_sample: sameType.length,
        equipment_car_sample: equip?._car_context?.car_history_sample ?? 0,
      },
    };
  }

  return {
    source_id: 'nascar_loop_history_gen7',
    era_floor_season: GEN7_ERA_FLOOR_SEASON,
    track: { track_id: trackId, track_name: race.track_name ?? null, track_type: trackType },
    by_driver: byDriver,
    races_considered: rows.length,
    driver_count: Object.keys(byDriver).length,
    source_urls: [
      'https://cf.nascar.com/cacher/{season}/1/race_list_basic.json',
      'https://cf.nascar.com/live/feeds/series_1/{race_id}/live_feed.json',
    ],
    notes: [
      `Gen-7 era floor: seasons >= ${GEN7_ERA_FLOOR_SEASON} only; older results dropped.`,
      `History layers with < ${MIN_HISTORY_SAMPLE} samples are LOW_EVIDENCE; zero-sample layers are omitted (MISSING).`,
      'Cross-track speed metrics use within-field percentiles so track types are comparable.',
      'KEYING INVARIANT: driver skill layers follow the driver (name-keyed); equipment layers follow the car/team (car_number-keyed via the entry list).',
      'No market/odds/price data. Offline snapshot read only.',
    ],
  };
}

export {
  normName as normalizeDriverNameForLoopHistory,
  carEquipmentRollup as nascarCarEquipmentRollup,
  equipmentLayersByDriverKey as nascarEquipmentLayersByDriverKey,
};
