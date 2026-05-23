// Lineup block grouping for the MLB cron packet workflow.
// Pure functions. No I/O, no network.
//
// A lineup block groups games whose first pitches fall within
// BLOCK_GROUPING_MINUTES of each other. Each block shares a single packet.
//
// Timing model (America/Chicago):
//   polling_starts_utc = lead_first_pitch_utc - POLLING_LEAD_MINUTES   (3 h)
//   hard_cutoff_utc    = lead_first_pitch_utc - HARD_CUTOFF_MINUTES    (45 min)
//   preferred_at_utc   = when BOTH lineups are confirmed (poll-detected)
//
// The packet runner (generate-lineup-packets.mjs) polls periodically and fires:
//   1. Both lineups confirmed   → full packet (PACKET_DOWNGRADE.NONE)
//   2. One lineup by cutoff    → downgrade note (PACKET_DOWNGRADE.PARTIAL)
//   3. No lineups by cutoff    → HR blocked, others capped LEAN/WATCH (PACKET_DOWNGRADE.FULL)

import { ctClockFromUtc } from './series-discovery.mjs';

export const BLOCK_GROUPING_MINUTES = 30;
export const POLLING_LEAD_MINUTES   = 180;  // 3 h before lead first pitch
export const HARD_CUTOFF_MINUTES    = 45;   // 45 min before lead first pitch

export const LINEUP_STATUS = Object.freeze({
  BOTH_CONFIRMED: 'both_confirmed',
  ONE_CONFIRMED:  'one_confirmed',
  PENDING:        'pending',
});

export const PACKET_DOWNGRADE = Object.freeze({
  NONE:    'none',    // both lineups confirmed
  PARTIAL: 'partial', // one lineup confirmed — downgrade note added
  FULL:    'full',    // no lineups — HR blocked, others capped LEAN/WATCH
});

/**
 * Group games into lineup blocks.
 * Games whose first pitches fall within groupingWindowMin of the block's
 * lead first pitch are merged into that block.
 *
 * @param {Array} games    from joinGames() — each has .game_key + .start_utc
 * @param {object} options
 * @param {number} [options.groupingWindowMin=30]
 * @param {number} [options.pollingLeadMin=180]
 * @param {number} [options.hardCutoffMin=45]
 * @returns {Array<LineupBlock>}
 */
export function groupIntoLineupBlocks(games, options = {}) {
  const windowMin     = options.groupingWindowMin ?? BLOCK_GROUPING_MINUTES;
  const pollingLeadMin = options.pollingLeadMin  ?? POLLING_LEAD_MINUTES;
  const hardCutoffMin  = options.hardCutoffMin   ?? HARD_CUTOFF_MINUTES;

  const sorted = [...games]
    .filter((g) => g.start_utc)
    .sort((a, b) => a.start_utc.localeCompare(b.start_utc));

  const raw = [];
  for (const g of sorted) {
    const t    = Date.parse(g.start_utc);
    const last = raw[raw.length - 1];
    if (last && t - Date.parse(last.lead_utc) <= windowMin * 60_000) {
      last.games.push(g);
    } else {
      raw.push({ lead_utc: g.start_utc, games: [g] });
    }
  }

  return raw.map((b, i) => {
    const leadMs        = Date.parse(b.lead_utc);
    const pollingMs     = leadMs - pollingLeadMin * 60_000;
    const cutoffMs      = leadMs - hardCutoffMin  * 60_000;
    const pollingIso    = new Date(pollingMs).toISOString();
    const cutoffIso     = new Date(cutoffMs).toISOString();
    return {
      block_id:             `LB${String(i + 1).padStart(2, '0')}`,
      lead_first_pitch_utc: b.lead_utc,
      lead_first_pitch_ct:  ctClockFromUtc(b.lead_utc),
      polling_starts_utc:   pollingIso,
      polling_starts_ct:    ctClockFromUtc(pollingIso),
      hard_cutoff_utc:      cutoffIso,
      hard_cutoff_ct:       ctClockFromUtc(cutoffIso),
      game_keys:            b.games.map((g) => g.game_key),
      games:                b.games.map((g) => ({
        game_key: g.game_key,
        away: g.away, home: g.home,
        away_full: g.away_full, home_full: g.home_full,
        start_utc: g.start_utc, start_ct: g.start_ct,
      })),
      lineup_status: LINEUP_STATUS.PENDING,
      packet_status: 'scheduled',
    };
  });
}

/**
 * Return blocks whose polling window is open right now and that have not
 * yet been rendered.
 *
 * @param {Array}  blocks
 * @param {number} nowMs    - Date.now()
 * @param {number} graceMs  - grace period after hard cutoff (default 5 min)
 * @returns {Array<LineupBlock>}
 */
export function findDueBlocks(blocks, nowMs, graceMs = 5 * 60_000) {
  return blocks.filter((b) => {
    if (b.packet_status === 'rendered' || b.packet_status === 'sent') return false;
    const pollingStart = Date.parse(b.polling_starts_utc);
    const hardCutoff   = Date.parse(b.hard_cutoff_utc);
    return nowMs >= pollingStart && nowMs <= hardCutoff + graceMs;
  });
}

/**
 * Resolve the downgrade level from lineup status.
 *
 * @param {string} lineupStatus - one of LINEUP_STATUS values
 * @returns {string} one of PACKET_DOWNGRADE values
 */
export function resolveDowngrade(lineupStatus) {
  if (lineupStatus === LINEUP_STATUS.BOTH_CONFIRMED) return PACKET_DOWNGRADE.NONE;
  if (lineupStatus === LINEUP_STATUS.ONE_CONFIRMED)  return PACKET_DOWNGRADE.PARTIAL;
  return PACKET_DOWNGRADE.FULL;
}

/**
 * Apply downgrade rules to a per-lane decision.
 *
 * Rules:
 *   - HR props require BOTH_CONFIRMED: all other states → NO CLEAR PICK.
 *   - FULL downgrade (no lineups): CLEAR → LEAN, PASS → WATCH for non-HR lanes.
 *   - PARTIAL downgrade (one lineup): decision preserved; downgrade note added.
 *   - Price-only paths (PASS on ML/spread/total) are left as WATCH (already mapped).
 *
 * @param {string} lane          - 'hr'|'winner'|'spread'|'total'|'yfri'|'k'
 * @param {string} rawDecision   - 'CLEAR'|'LEAN'|'WATCH'|'PASS'|'NO CLEAR PICK'
 * @param {string} downgrade     - one of PACKET_DOWNGRADE values
 * @returns {{ decision: string, downgradeReason: string|null }}
 */
export function applyDowngrade(lane, rawDecision, downgrade) {
  if (downgrade === PACKET_DOWNGRADE.NONE) {
    return { decision: rawDecision, downgradeReason: null };
  }

  // HR always requires both lineups.
  if (lane === 'hr') {
    const why = downgrade === PACKET_DOWNGRADE.FULL
      ? 'HR props require both lineups confirmed — no lineups available at packet time.'
      : 'HR props require both lineups confirmed — only one lineup available at packet time.';
    return { decision: 'NO CLEAR PICK', downgradeReason: why };
  }

  if (downgrade === PACKET_DOWNGRADE.FULL) {
    // Cap at LEAN for CLEAR; PASS → WATCH; others unchanged.
    if (rawDecision === 'CLEAR') {
      return { decision: 'LEAN', downgradeReason: 'Downgraded CLEAR → LEAN: no lineups confirmed at packet time.' };
    }
    if (rawDecision === 'PASS') {
      return { decision: 'WATCH', downgradeReason: 'Downgraded PASS → WATCH: no lineups confirmed at packet time.' };
    }
    return { decision: rawDecision, downgradeReason: 'No lineups confirmed at packet time.' };
  }

  // PARTIAL: one lineup — preserve decision, add monitoring note.
  return {
    decision: rawDecision,
    downgradeReason: 'One lineup confirmed; the other is still pending — monitor for late changes.',
  };
}
