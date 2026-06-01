#!/usr/bin/env node
// One-time / refreshable capture tool for the NASCAR loop-data evidence base.
//
// Pulls the PUBLIC, FREE cf.nascar.com feeds (no auth, no credentials, no
// market data) and projects them down to the compact per-driver, per-race loop
// features the track-aware scoring core consumes. Writes a single committed
// snapshot the scoring core reads OFFLINE at runtime — the runtime path never
// touches the network.
//
// Sources (all public, all market-neutral):
//   schedule: https://cf.nascar.com/cacher/{season}/1/race_list_basic.json
//   loop:     https://cf.nascar.com/live/feeds/series_1/{race_id}/live_feed.json
//
// Hard rules: no price/odds/volume/OI field is fetched or stored. This is a
// fundamentals-only capture. Trades are never placed.
//
// Usage:
//   node scripts/nascar/tools/capture-loop-snapshot.mjs --season 2025 \
//        --out scripts/nascar/lib/source-adapters/snapshots/nascar-loop-2025.json

import https from 'node:https';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function get(url) {
  return new Promise((res, rej) => {
    https
      .get(url, { headers: { 'User-Agent': 'cpc-loop-capture/1.0' } }, (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => res({ status: r.statusCode, body: d }));
      })
      .on('error', rej);
  });
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Track-type taxonomy derived from track_id + restrictor_plate + scheduled
// distance/length. Market-neutral, structural only.
const ROAD_COURSE_TRACK_IDS = new Set([
  // COTA, Sonoma, Watkins Glen, Chicago Street, Mexico City, CLT Roval
]);
function classifyTrackType(race) {
  const name = String(race.track_name || '').toLowerCase();
  if (race.restrictor_plate === true) return 'superspeedway';
  if (/road course|street|circuit|sonoma|watkins glen|rodr|americas|roval/.test(name)) return 'road_course';
  if (/martinsville|bristol|richmond|phoenix|north wilkesboro/.test(name)) return 'short_track';
  if (/darlington/.test(name)) return 'egg_shaped_intermediate';
  if (/pocono|indianapolis/.test(name)) return 'flat_intermediate';
  // default by distance: <= 1.06mi short, else intermediate
  return 'intermediate';
}

function projectVehicle(v) {
  const d = v.driver || {};
  return {
    driver_name: d.full_name ?? null,
    car_number: v.vehicle_number ?? null,
    start: num(v.starting_position),
    finish: num(v.running_position),
    avg_running_position: num(v.average_running_position),
    avg_speed: num(v.average_speed),
    best_lap_speed: num(v.best_lap_speed),
    fastest_laps_run: num(v.fastest_laps_run),
    laps_led: num(v.laps_led),
    laps_completed: num(v.laps_completed),
    passing_differential: num(v.passing_differential),
    quality_passes: num(v.quality_passes),
    avg_restart_speed: num(v.average_restart_speed),
    pit_stops: Array.isArray(v.pit_stops) ? v.pit_stops.length : num(v.pit_stops),
    status: v.status ?? null,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const get1 = (flag, def) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : def;
  };
  const season = get1('--season', '2025');
  const out = get1(
    '--out',
    `scripts/nascar/lib/source-adapters/snapshots/nascar-loop-${season}.json`,
  );

  const sched = await get(`https://cf.nascar.com/cacher/${season}/1/race_list_basic.json`);
  if (sched.status !== 200) throw new Error(`schedule fetch failed: ${sched.status}`);
  const races = JSON.parse(sched.body).filter((r) => r.race_type_id === 1);

  const out_races = [];
  for (const r of races) {
    const feed = await get(`https://cf.nascar.com/live/feeds/series_1/${r.race_id}/live_feed.json`);
    if (feed.status !== 200) {
      out_races.push({ race_id: r.race_id, track_name: r.track_name, capture_status: `feed_${feed.status}` });
      continue;
    }
    let parsed;
    try { parsed = JSON.parse(feed.body); } catch { parsed = null; }
    const vehicles = parsed && Array.isArray(parsed.vehicles) ? parsed.vehicles : [];
    out_races.push({
      race_id: r.race_id,
      track_id: r.track_id,
      track_name: r.track_name,
      race_date: (r.race_date || '').slice(0, 10),
      scheduled_distance: num(r.scheduled_distance),
      scheduled_laps: num(r.scheduled_laps),
      restrictor_plate: r.restrictor_plate === true,
      track_type: classifyTrackType(r),
      number_of_cautions: num(r.number_of_cautions),
      number_of_lead_changes: num(r.number_of_lead_changes),
      laps_in_feed: parsed?.laps_in_race ?? null,
      capture_status: 'ok',
      drivers: vehicles.map(projectVehicle).filter((v) => v.driver_name),
    });
    process.stderr.write(`captured ${r.race_id} ${r.track_name} (${vehicles.length} cars)\n`);
  }

  const snapshot = {
    snapshot_id: `nascar_loop_${season}`,
    snapshot_kind: 'cf_nascar_live_feed_projection',
    season: Number(season),
    captured_at_utc: new Date().toISOString(),
    source_urls: [
      `https://cf.nascar.com/cacher/${season}/1/race_list_basic.json`,
      `https://cf.nascar.com/live/feeds/series_1/{race_id}/live_feed.json`,
    ],
    market_neutral: true,
    notes: [
      'Public free cf.nascar.com feeds. No auth, no credentials, no market/odds/price data.',
      'Per-driver per-race loop projection: pace, passing, restarts, laps led, pit count, start/finish.',
      'Runtime scoring core reads this snapshot OFFLINE; never fetches at runtime.',
    ],
    races: out_races,
  };

  const abs = resolve(out);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  const okCount = out_races.filter((r) => r.capture_status === 'ok').length;
  process.stderr.write(`\nwrote ${abs}\nraces_ok=${okCount}/${out_races.length}\n`);
}

main().catch((e) => {
  process.stderr.write(`capture failed: ${e.message}\n`);
  process.exit(1);
});
