// 2026 FireKeepers Casino 400 — Michigan International Speedway
// Practice + qualifying fixture (confirmed public-source data).
//
// Qualifying: single-car timed laps held 2026-06-06.
//   Pole: Denny Hamlin #11 (36.901 sec / 195.117 mph).
//   Three drivers start from rear of field:
//     - #11 Hamlin: unapproved post-qualifying repair (pole awarded, pit stall kept)
//     - #24 Byron:  unapproved post-qualifying repair
//     - #21 Berry:  spun out in qualifying, no timed lap posted
//   effective_race_start reflects the actual race grid after rear-start adjustments.
//
// Practice: one single session held 2026-06-06.
//   Top-5 ranks confirmed (Reddick, Elliott, Larson, Buescher, Hamlin).
//   Top 6-10 confirmed as a GROUP (Chastain, Wallace, Byron, Blaney, Hocevar)
//   but exact order within 6-10 NOT confirmed — those drivers have practice_rank=null.
//   Slowest: #44 Yeley (185.028 mph).
//
// Sources:
//   https://beyondtheflag.com/michigan-nascar-qualifying-full-firekeepers-casino-400-starting-lineup-01kqx9g0vbpv
//   https://racingnews.co/2026/06/06/nascar-qualifying-results-michigan-june-2026/
//   https://heavy.com/sports/nascar/nascar-cup-series-drivers-hit-with-penalty-ahead-of-michigan-international-speedway-showdown/
//   https://ifantasyrace.com/2026/06/06/michigan-firekeepers-casino-400-fantasy-nascar-confidence-rankings-post-practice-predictions-2026/
//
// Read-only. No live network. No credentials. No fabricated data.

import { makeEnvelope } from '../cache.mjs';

export const SOURCE_ID = 'practice_qualifying_michigan_2026';

const CHECKED_AT_UTC = '2026-06-07T12:00:00.000Z';

const SOURCE_URLS = [
  'https://beyondtheflag.com/michigan-nascar-qualifying-full-firekeepers-casino-400-starting-lineup-01kqx9g0vbpv',
  'https://racingnews.co/2026/06/06/nascar-qualifying-results-michigan-june-2026/',
  'https://heavy.com/sports/nascar/nascar-cup-series-drivers-hit-with-penalty-ahead-of-michigan-international-speedway-showdown/',
  'https://ifantasyrace.com/2026/06/06/michigan-firekeepers-casino-400-fantasy-nascar-confidence-rankings-post-practice-predictions-2026/',
];

// effective_race_start: actual race grid position after rear-start penalty adjustments.
//   Hamlin (qual P1) and Byron (qual P9) move to rear → everyone between shifts up.
//   Berry (no time) → P37 (last).
//   Hamlin → P36, Byron → P35.
const DRIVER_DATA = [
  // qual_pos=qualifying speed position; effective_race_start=actual grid slot
  { driver_name: 'Denny Hamlin',         car_number: 11, qual_pos: 1,    effective_race_start: 36,  practice_rank: 5,    rear_start: true,  rear_reason: 'unapproved post-qualifying repair; pole awarded and pit stall kept' },
  { driver_name: 'Carson Hocevar',       car_number: 77, qual_pos: 2,    effective_race_start: 1,   practice_rank: null, rear_start: false, rear_reason: null },
  { driver_name: 'Tyler Reddick',        car_number: 45, qual_pos: 3,    effective_race_start: 2,   practice_rank: 1,    rear_start: false, rear_reason: null },
  { driver_name: 'Ty Gibbs',             car_number: 54, qual_pos: 4,    effective_race_start: 3,   practice_rank: null, rear_start: false, rear_reason: null },
  { driver_name: 'Chase Briscoe',        car_number: 19, qual_pos: 5,    effective_race_start: 4,   practice_rank: null, rear_start: false, rear_reason: null },
  { driver_name: 'Chase Elliott',        car_number: 9,  qual_pos: 6,    effective_race_start: 5,   practice_rank: 2,    rear_start: false, rear_reason: null },
  { driver_name: 'Kyle Larson',          car_number: 5,  qual_pos: 7,    effective_race_start: 6,   practice_rank: 3,    rear_start: false, rear_reason: null },
  { driver_name: 'Christopher Bell',     car_number: 20, qual_pos: 8,    effective_race_start: 7,   practice_rank: null, rear_start: false, rear_reason: null },
  { driver_name: 'William Byron',        car_number: 24, qual_pos: 9,    effective_race_start: 35,  practice_rank: null, rear_start: true,  rear_reason: 'unapproved post-qualifying repair; confirmed top-10 in practice (exact rank unconfirmed)' },
  { driver_name: 'Erik Jones',           car_number: 43, qual_pos: 10,   effective_race_start: 8,   practice_rank: null, rear_start: false, rear_reason: null },
  { driver_name: 'Daniel Suarez',        car_number: 7,  qual_pos: 11,   effective_race_start: 9,   practice_rank: null, rear_start: false, rear_reason: null },
  { driver_name: 'Riley Herbst',         car_number: 35, qual_pos: 12,   effective_race_start: 10,  practice_rank: null, rear_start: false, rear_reason: null },
  { driver_name: 'Bubba Wallace',        car_number: 23, qual_pos: 13,   effective_race_start: 11,  practice_rank: null, rear_start: false, rear_reason: 'confirmed top-10 in practice (exact rank unconfirmed)' },
  { driver_name: 'Chris Buescher',       car_number: 17, qual_pos: 14,   effective_race_start: 12,  practice_rank: 4,    rear_start: false, rear_reason: null },
  { driver_name: 'Cole Custer',          car_number: 41, qual_pos: 15,   effective_race_start: 13,  practice_rank: null, rear_start: false, rear_reason: null },
  { driver_name: 'Zane Smith',           car_number: 38, qual_pos: 16,   effective_race_start: 14,  practice_rank: null, rear_start: false, rear_reason: null },
  { driver_name: 'John Hunter Nemechek', car_number: 42, qual_pos: 17,   effective_race_start: 15,  practice_rank: null, rear_start: false, rear_reason: null },
  { driver_name: 'Joey Logano',          car_number: 22, qual_pos: 18,   effective_race_start: 16,  practice_rank: null, rear_start: false, rear_reason: null },
  { driver_name: 'Ryan Blaney',          car_number: 12, qual_pos: 19,   effective_race_start: 17,  practice_rank: null, rear_start: false, rear_reason: 'confirmed top-10 in practice (exact rank unconfirmed)' },
  { driver_name: 'Michael McDowell',     car_number: 71, qual_pos: 20,   effective_race_start: 18,  practice_rank: null, rear_start: false, rear_reason: null },
  { driver_name: 'Austin Dillon',        car_number: 3,  qual_pos: 21,   effective_race_start: 19,  practice_rank: null, rear_start: false, rear_reason: null },
  { driver_name: 'Noah Gragson',         car_number: 4,  qual_pos: 22,   effective_race_start: 20,  practice_rank: null, rear_start: false, rear_reason: null },
  { driver_name: 'Ricky Stenhouse Jr.',  car_number: 47, qual_pos: 23,   effective_race_start: 21,  practice_rank: null, rear_start: false, rear_reason: null },
  { driver_name: 'Ty Dillon',            car_number: 10, qual_pos: 24,   effective_race_start: 22,  practice_rank: null, rear_start: false, rear_reason: null },
  { driver_name: 'AJ Allmendinger',      car_number: 16, qual_pos: 25,   effective_race_start: 23,  practice_rank: null, rear_start: false, rear_reason: null },
  { driver_name: 'Brad Keselowski',      car_number: 6,  qual_pos: 26,   effective_race_start: 24,  practice_rank: null, rear_start: false, rear_reason: null },
  { driver_name: 'Ryan Preece',          car_number: 60, qual_pos: 27,   effective_race_start: 25,  practice_rank: null, rear_start: false, rear_reason: null },
  { driver_name: 'Austin Hill',          car_number: 33, qual_pos: 28,   effective_race_start: 26,  practice_rank: null, rear_start: false, rear_reason: null },
  { driver_name: 'Alex Bowman',          car_number: 48, qual_pos: 29,   effective_race_start: 27,  practice_rank: null, rear_start: false, rear_reason: null },
  { driver_name: 'Shane Van Gisbergen',  car_number: 97, qual_pos: 30,   effective_race_start: 28,  practice_rank: null, rear_start: false, rear_reason: null },
  { driver_name: 'Austin Cindric',       car_number: 2,  qual_pos: 31,   effective_race_start: 29,  practice_rank: null, rear_start: false, rear_reason: null },
  { driver_name: 'Ross Chastain',        car_number: 1,  qual_pos: 32,   effective_race_start: 30,  practice_rank: null, rear_start: false, rear_reason: 'confirmed top-10 in practice (exact rank unconfirmed)' },
  { driver_name: 'Cody Ware',            car_number: 51, qual_pos: 33,   effective_race_start: 31,  practice_rank: null, rear_start: false, rear_reason: null },
  { driver_name: 'Connor Zilisch',       car_number: 88, qual_pos: 34,   effective_race_start: 32,  practice_rank: null, rear_start: false, rear_reason: null },
  { driver_name: 'Todd Gilliland',       car_number: 34, qual_pos: 35,   effective_race_start: 33,  practice_rank: null, rear_start: false, rear_reason: null },
  { driver_name: 'JJ Yeley',             car_number: 44, qual_pos: 36,   effective_race_start: 34,  practice_rank: null, rear_start: false, rear_reason: null },
  { driver_name: 'Josh Berry',           car_number: 21, qual_pos: null,  effective_race_start: 37,  practice_rank: null, rear_start: true,  rear_reason: 'no qualifying time (spun exiting turn 4 during qualifying session)' },
];

export function michiganPracticeQualifyingEnvelope({
  checked_at_utc = CHECKED_AT_UTC,
  outputDir = 'state/nascar/2026-06-07/firekeepers-casino-400',
} = {}) {
  const records = DRIVER_DATA.map(d => ({
    query_type: 'driver_universe_entry',
    driver_name: d.driver_name,
    car_number: d.car_number,
    // starting_position = qualifying speed position (for speed scoring)
    starting_position: d.qual_pos ?? null,
    // effective_race_start = actual race grid position (for position-context scoring)
    effective_race_start: d.effective_race_start,
    practice_rank: d.practice_rank,
    rear_start: d.rear_start,
    rear_start_reason: d.rear_reason ?? null,
    source_urls: SOURCE_URLS,
  }));

  return {
    ...makeEnvelope({
      source_id: SOURCE_ID,
      status: 'partial',
      checked_at_utc,
      cache_path: `${outputDir}/practice_qualifying_adapter.json`,
      required: false,
      records,
      warnings: [
        'Practice ranks 6-10 confirmed as group (Chastain, Wallace, Byron, Blaney, Hocevar) — exact order not confirmed; those drivers have practice_rank=null.',
        '#11 Hamlin and #24 Byron start from rear despite front-row qualifying speeds.',
        '#21 Berry starts from rear (no timed qualifying lap due to spin).',
        'starting_position = qualifying session speed order; effective_race_start = actual race grid after penalties.',
      ],
      errors: [],
      source_urls: SOURCE_URLS,
    }),
    snapshot: {
      grid_basis: 'qualifying_session',
      qualifying_format_note: 'Single-car timed laps (2026-06-06); 37 entries, all qualified (no one failed to make field)',
      pole_position_driver: 'Denny Hamlin',
      pole_position_car: 11,
      pole_time_sec: 36.901,
      pole_speed_mph: 195.117,
      rear_starters: [
        { driver_name: 'Denny Hamlin',  car_number: 11, reason: 'unapproved post-qualifying repair', effective_race_start: 36 },
        { driver_name: 'William Byron', car_number: 24, reason: 'unapproved post-qualifying repair', effective_race_start: 35 },
        { driver_name: 'Josh Berry',    car_number: 21, reason: 'no qualifying time (spin)',          effective_race_start: 37 },
      ],
      practice_partial_top5_confirmed: [
        { practice_rank: 1, driver_name: 'Tyler Reddick',  car_number: 45, best_speed_mph: 192.621, note: 'also best 10-lap avg 191.550 mph' },
        { practice_rank: 2, driver_name: 'Chase Elliott',  car_number: 9,  best_speed_mph: 192.199 },
        { practice_rank: 3, driver_name: 'Kyle Larson',    car_number: 5,  best_speed_mph: 191.402 },
        { practice_rank: 4, driver_name: 'Chris Buescher', car_number: 17, best_speed_mph: 191.367 },
        { practice_rank: 5, driver_name: 'Denny Hamlin',   car_number: 11, best_speed_mph: 191.341, note: 'left-rear flat during practice; underbody/diffuser damage (post-qualifying repair penalty applied)' },
      ],
      practice_top10_group_unordered: ['Ross Chastain', 'Bubba Wallace', 'William Byron', 'Ryan Blaney', 'Carson Hocevar'],
      practice_slowest: { driver_name: 'JJ Yeley', car_number: 44, best_speed_mph: 185.028 },
      most_laps_run: { driver_name: 'Austin Hill', car_number: 33, laps: 33 },
    },
  };
}
