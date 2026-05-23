// Per-game and block packet renderer for the MLB cron packet workflow.
// Pure rendering functions — no I/O, no network, no side effects.
//
// Exports:
//   renderPerGamePacket(game, options) → { text, analysis, lineupStatus, downgrade,
//                                          gameMatchup, bestLane, bestLaneDecision,
//                                          bestLaneDecisionLabel }
//   renderBlockPacket(block, perGamePackets) → string

import { analyzeGame } from './market-engine.mjs';
import {
  LINEUP_STATUS,
  PACKET_DOWNGRADE,
  resolveDowngrade,
  applyDowngrade,
} from './lineup-blocks.mjs';

// ---- constants ---------------------------------------------------------------

const DECISION_ORDER = { PICK: 0, LEAN: 1, WATCH: 2, 'NO CLEAR PICK': 3 };

// ---- label helpers -----------------------------------------------------------

function decisionLabel(raw) {
  if (raw === 'CLEAR') return 'PICK';
  if (raw === 'PASS')  return 'WATCH';
  return raw; // LEAN, WATCH, NO CLEAR PICK pass through
}

function lineupStatusLabel(ls) {
  if (ls === LINEUP_STATUS.BOTH_CONFIRMED) return 'CONFIRMED (both)';
  if (ls === LINEUP_STATUS.ONE_CONFIRMED)  return 'PARTIAL (one confirmed)';
  return 'PENDING (neither confirmed)';
}

function pad(s, len) {
  const str = String(s ?? '');
  return str.length >= len ? str.slice(0, len) : str + ' '.repeat(len - str.length);
}

function truncate(s, len) {
  const str = String(s ?? '');
  return str.length <= len ? str : str.slice(0, len - 1) + '…';
}

// ---- per-lane rendering ------------------------------------------------------

function renderLaneEntry(laneLabel, rawDecision, reason, downgrade, lane) {
  const { decision: finalDecision, downgradeReason } = applyDowngrade(lane, rawDecision, downgrade);
  const label = decisionLabel(finalDecision);
  const lines = [];
  lines.push(`  ${laneLabel}: ${label}`);
  lines.push(`    Reason: ${reason}`);
  if (downgradeReason) {
    lines.push(`    Downgrade: ${downgradeReason}`);
  }
  return { lines, label, finalDecision };
}

// ---- section renderers -------------------------------------------------------

function renderHeader(game, venueWeather) {
  const matchup = `${game.away ?? '?'}@${game.home ?? '?'}`;
  const lines = [];
  lines.push(`=== Game: ${matchup} ===`);
  lines.push(`First pitch: ${game.start_ct ?? 'MISSING'}  /  ${game.start_utc ?? 'MISSING'}`);
  if (venueWeather) {
    lines.push(`Venue/weather: ${venueWeather}`);
  } else {
    lines.push('Venue/weather: MISSING');
  }
  return lines;
}

function renderLineupStatusSection(lineupStatus, lineupNotes, downgrade) {
  const lines = [];
  lines.push('--- Lineup Status ---');
  lines.push(`Status: ${lineupStatusLabel(lineupStatus)}`);
  if (lineupNotes) {
    lines.push(`Notes: ${lineupNotes}`);
  }
  if (downgrade === PACKET_DOWNGRADE.FULL) {
    lines.push('WARNING: No lineups confirmed at packet time. HR props blocked. All CLEAR lanes capped at LEAN. PASS lanes capped at WATCH.');
  } else if (downgrade === PACKET_DOWNGRADE.PARTIAL) {
    lines.push('NOTE: One lineup confirmed; the other is pending. Monitor for late changes. HR props blocked.');
  }
  return lines;
}

function resolveStarter(val) {
  if (!val) return { name: null, notes: null };
  if (typeof val === 'string') return { name: val, notes: null };
  return { name: val.name ?? null, notes: val.notes ?? null };
}

function renderStartersSection(starters) {
  const lines = [];
  lines.push('--- Starters ---');
  if (!starters) {
    lines.push('Away starter: MISSING');
    lines.push('Home starter: MISSING');
    return lines;
  }
  const away = resolveStarter(starters.away);
  const home = resolveStarter(starters.home);
  lines.push(`Away starter: ${away.name ?? 'MISSING'}${away.notes ? `  — ${away.notes}` : ''}`);
  lines.push(`Home starter: ${home.name ?? 'MISSING'}${home.notes ? `  — ${home.notes}` : ''}`);
  return lines;
}

function renderMarketLanesSection(analysis, downgrade, lineupStatus) {
  const { sections } = analysis;
  const lines = [];
  lines.push('--- Market Lanes ---');
  lines.push('Anti-price proof: All decisions below derive from market-internal structure (ladder inversions,');
  lines.push('cross-side arbitrage, OI-ratio confirmation). Price favoritism alone is MARKET-ONLY or NO CLEAR PICK.');

  // Winner (ML)
  {
    const { lines: lns } = renderLaneEntry(
      'Winner (ML)',
      sections.ml.decision,
      sections.ml.reason,
      downgrade,
      'winner',
    );
    for (const l of lns) lines.push(l);
  }

  // Spread / run line
  {
    const { lines: lns } = renderLaneEntry(
      'Spread/Run line',
      sections.spread.decision,
      sections.spread.reason,
      downgrade,
      'spread',
    );
    for (const l of lns) lines.push(l);
  }

  // Total
  {
    const { lines: lns } = renderLaneEntry(
      'Total',
      sections.total.decision,
      sections.total.reason,
      downgrade,
      'total',
    );
    for (const l of lns) lines.push(l);
  }

  // NFRI/YFRI
  {
    const { lines: lns } = renderLaneEntry(
      'NFRI/YFRI',
      sections.yfri.decision,
      sections.yfri.reason,
      downgrade,
      'yfri',
    );
    for (const l of lns) lines.push(l);
  }

  // HR props
  lines.push('  HR props:');
  if (sections.hr.perPlayer && sections.hr.perPlayer.length > 0) {
    for (const p of sections.hr.perPlayer) {
      const { decision: finalDecision, downgradeReason } = applyDowngrade('hr', p.decision, downgrade);
      const label = decisionLabel(finalDecision);
      lines.push(`    ${p.name}: ${label}`);
      lines.push(`      Reason: ${p.reason}`);
      if (downgradeReason) {
        lines.push(`      Downgrade: ${downgradeReason}`);
      }
    }
  } else {
    // Aggregate HR entry — no per-player data.
    const { decision: finalDecision, downgradeReason } = applyDowngrade('hr', sections.hr.decision, downgrade);
    const label = decisionLabel(finalDecision);
    lines.push(`    Aggregate: ${label}`);
    lines.push(`      Reason: ${sections.hr.reason}`);
    if (downgradeReason) {
      lines.push(`      Downgrade: ${downgradeReason}`);
    }
  }

  // K props — away starter
  lines.push('  K props (away starter):');
  if (sections.ks_away.perPitcher && sections.ks_away.perPitcher.length > 0) {
    for (const p of sections.ks_away.perPitcher) {
      const { decision: finalDecision, downgradeReason } = applyDowngrade('k', p.decision, downgrade);
      const label = decisionLabel(finalDecision);
      lines.push(`    ${p.name}: ${label}`);
      lines.push(`      Reason: ${p.reason}`);
      if (downgradeReason) {
        lines.push(`      Downgrade: ${downgradeReason}`);
      }
    }
  } else {
    const { decision: finalDecision, downgradeReason } = applyDowngrade('k', sections.ks_away.decision, downgrade);
    const label = decisionLabel(finalDecision);
    lines.push(`    (starter): ${label}`);
    lines.push(`      Reason: ${sections.ks_away.reason}`);
    if (downgradeReason) {
      lines.push(`      Downgrade: ${downgradeReason}`);
    }
  }

  // K props — home starter
  lines.push('  K props (home starter):');
  if (sections.ks_home.perPitcher && sections.ks_home.perPitcher.length > 0) {
    for (const p of sections.ks_home.perPitcher) {
      const { decision: finalDecision, downgradeReason } = applyDowngrade('k', p.decision, downgrade);
      const label = decisionLabel(finalDecision);
      lines.push(`    ${p.name}: ${label}`);
      lines.push(`      Reason: ${p.reason}`);
      if (downgradeReason) {
        lines.push(`      Downgrade: ${downgradeReason}`);
      }
    }
  } else {
    const { decision: finalDecision, downgradeReason } = applyDowngrade('k', sections.ks_home.decision, downgrade);
    const label = decisionLabel(finalDecision);
    lines.push(`    (starter): ${label}`);
    lines.push(`      Reason: ${sections.ks_home.reason}`);
    if (downgradeReason) {
      lines.push(`      Downgrade: ${downgradeReason}`);
    }
  }

  return lines;
}

function renderResearchCompleteness(starters, lineupStatus) {
  const lines = [];
  lines.push('--- Research Completeness ---');
  const startersOk = starters && (
    (typeof starters.away === 'string' ? starters.away : starters.away?.name) ||
    (typeof starters.home === 'string' ? starters.home : starters.home?.name)
  );
  lines.push(`[ ${startersOk ? 'x' : ' '} ] Starters: ${startersOk ? 'OK' : 'MISSING'}`);

  if (lineupStatus === LINEUP_STATUS.BOTH_CONFIRMED) {
    lines.push('[ x ] Lineups: CONFIRMED (both)');
  } else if (lineupStatus === LINEUP_STATUS.ONE_CONFIRMED) {
    lines.push('[   ] Lineups: ONE CONFIRMED — other still pending');
  } else {
    lines.push('[   ] Lineups: PENDING (neither confirmed)');
  }

  lines.push('[   ] Pitcher stats: MISSING — not pulled at packet time');
  lines.push('[   ] Batter/power splits: MISSING — not pulled at packet time');
  lines.push('[   ] Bullpen/rest: MISSING — not pulled at packet time');
  lines.push('[   ] Weather/park: MISSING — not pulled at packet time');
  return lines;
}

function renderOverallDecision(final) {
  const lines = [];
  lines.push('--- Overall Decision ---');
  lines.push(`Decision status: ${final.decision_status}`);
  lines.push(`Best angle: ${final.best_angle}`);
  lines.push(`Reasoning: ${final.reason}`);
  return lines;
}

// ---- best lane resolution ----------------------------------------------------

function resolveBestLane(analysis, downgrade) {
  const candidates = [
    { lane: 'winner', raw: analysis.sections.ml.decision,     reason: analysis.sections.ml.reason },
    { lane: 'spread', raw: analysis.sections.spread.decision, reason: analysis.sections.spread.reason },
    { lane: 'total',  raw: analysis.sections.total.decision,  reason: analysis.sections.total.reason },
    { lane: 'yfri',   raw: analysis.sections.yfri.decision,   reason: analysis.sections.yfri.reason },
  ];
  const ranked = candidates
    .map((c) => {
      const { decision: final } = applyDowngrade(c.lane, c.raw, downgrade);
      const label = decisionLabel(final);
      return { ...c, finalDecision: final, label, order: DECISION_ORDER[label] ?? 99 };
    })
    .sort((a, b) => a.order - b.order);
  const best = ranked[0];
  return {
    bestLane: best.lane,
    bestLaneDecision: best.finalDecision,
    bestLaneDecisionLabel: best.label,
    bestLaneReason: best.reason,
  };
}

// ---- public API --------------------------------------------------------------

/**
 * Render a single-game packet.
 *
 * @param {object} game       — from joinGames(): .game_key, .away, .home, .away_full,
 *                              .home_full, .start_utc, .start_ct, .series
 * @param {object} options
 * @param {string} [options.lineupStatus]   — LINEUP_STATUS value (default PENDING)
 * @param {string} [options.lineupNotes]    — free-text lineup note
 * @param {object} [options.starters]       — { away: { name, notes }, home: { name, notes } }
 * @param {string} [options.venueWeather]   — single-line venue/weather summary
 * @returns {{ text, analysis, lineupStatus, downgrade, gameMatchup,
 *             bestLane, bestLaneDecision, bestLaneDecisionLabel }}
 */
export function renderPerGamePacket(game, options = {}) {
  const lineupStatus = options.lineupStatus ?? LINEUP_STATUS.PENDING;
  const lineupNotes  = options.lineupNotes  ?? null;
  const starters     = options.starters     ?? null;
  const venueWeather = options.venueWeather ?? null;

  const downgrade = resolveDowngrade(lineupStatus);
  const analysis  = analyzeGame(game);

  const gameMatchup = game.away_full && game.home_full
    ? `${game.away_full} at ${game.home_full}`
    : `${game.away ?? '?'} at ${game.home ?? '?'}`;

  const { bestLane, bestLaneDecision, bestLaneDecisionLabel, bestLaneReason } =
    resolveBestLane(analysis, downgrade);

  const sections = [
    ...renderHeader(game, venueWeather),
    '',
    ...renderLineupStatusSection(lineupStatus, lineupNotes, downgrade),
    '',
    ...renderStartersSection(starters),
    '',
    ...renderMarketLanesSection(analysis, downgrade, lineupStatus),
    '',
    ...renderResearchCompleteness(starters, lineupStatus),
    '',
    ...renderOverallDecision(analysis.final),
    '',
    'No trades placed. No bankroll sizing. Research only.',
  ];

  return {
    text: sections.join('\n'),
    analysis,
    lineupStatus,
    downgrade,
    gameMatchup,
    bestLane,
    bestLaneDecision,
    bestLaneDecisionLabel,
    bestLaneReason,
    gameKey: game.game_key,
    awayAbbrev: game.away,
    homeAbbrev: game.home,
  };
}

// ---- block summary sort ------------------------------------------------------

function sortPacketsByDecision(packets) {
  return packets.slice().sort((a, b) => {
    const aOrd = DECISION_ORDER[a.bestLaneDecisionLabel] ?? 99;
    const bOrd = DECISION_ORDER[b.bestLaneDecisionLabel] ?? 99;
    return aOrd - bOrd;
  });
}

// ---- block packet ------------------------------------------------------------

/**
 * Render a block-level summary packet wrapping all per-game packets.
 *
 * @param {object} block           — lineup block from groupIntoLineupBlocks()
 * @param {Array}  perGamePackets  — array of renderPerGamePacket() return values
 * @returns {string}
 */
export function renderBlockPacket(block, perGamePackets) {
  const sorted = sortPacketsByDecision(perGamePackets);
  const overallLineupLabel = lineupStatusLabel(block.lineup_status ?? LINEUP_STATUS.PENDING);

  const header = [
    `=== MLB Block Packet: ${block.block_id} — ${block.lead_first_pitch_ct} ===`,
    `Games: ${perGamePackets.length}  |  Hard cutoff: ${block.hard_cutoff_ct}  |  Lineup status: ${overallLineupLabel}`,
  ];

  // Ranked fundamentals summary table
  const ranked = sorted.filter((p) => p.bestLaneDecisionLabel !== 'NO CLEAR PICK');
  const noPickGames = sorted.filter((p) => p.bestLaneDecisionLabel === 'NO CLEAR PICK');

  const rankSection = [
    '--- Ranked Fundamentals Summary ---',
    'Signals below derive from market-internal structure only (ladder inversions, cross-side arb, OI confirmation).',
    'No price-only picks. No external context modeled.',
    '',
  ];

  // Table header
  const COL = { matchup: 22, lane: 14, decision: 14, reason: 48 };
  const tableHeader = `${pad('Matchup', COL.matchup)} | ${pad('Best Lane', COL.lane)} | ${pad('Decision', COL.decision)} | Reason`;
  const tableSep    = `${'-'.repeat(COL.matchup)}-+-${'-'.repeat(COL.lane)}-+-${'-'.repeat(COL.decision)}-+-${'-'.repeat(COL.reason)}`;
  rankSection.push(tableHeader);
  rankSection.push(tableSep);

  for (const p of sorted) {
    const matchup  = truncate(`${p.awayAbbrev ?? '?'}@${p.homeAbbrev ?? '?'}`, COL.matchup);
    const lane     = truncate(p.bestLane, COL.lane);
    const decision = truncate(p.bestLaneDecisionLabel, COL.decision);
    const reason   = truncate(p.bestLaneReason ?? '', COL.reason);
    rankSection.push(`${pad(matchup, COL.matchup)} | ${pad(lane, COL.lane)} | ${pad(decision, COL.decision)} | ${reason}`);
  }

  // NO CLEAR PICK brief section
  const noPickSection = ['--- NO CLEAR PICK Games (brief) ---'];
  if (noPickGames.length === 0) {
    noPickSection.push('None — all games have at least a WATCH-tier signal.');
  } else {
    for (const p of noPickGames) {
      const matchup = `${p.awayAbbrev ?? '?'}@${p.homeAbbrev ?? '?'}`;
      const reason = p.analysis?.final?.reason ?? 'No market-internal signal above noise.';
      noPickSection.push(`${matchup}: NO CLEAR PICK — ${truncate(reason, 120)}`);
    }
  }

  // Per-game packets
  const perGameSection = [
    '--- Per-Game Packets ---',
    ...sorted.flatMap((p, i) => [
      ...(i > 0 ? ['---'] : []),
      p.text,
    ]),
  ];

  const footer = 'No price-only picks. No bankroll. No trade execution.';

  const all = [
    ...header,
    '',
    ...rankSection,
    '',
    ...noPickSection,
    '',
    ...perGameSection,
    '',
    footer,
  ];

  return all.join('\n');
}
