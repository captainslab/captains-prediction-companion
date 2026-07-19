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
  describeMoneyline,
  describeRunline,
  describeTotal,
  describeTeamRuns,
  describeProjectedSpread,
  describeYrfi,
  describeKs,
  describeHr,
} from './projection-language.mjs';
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

function renderProjectionFirstSection(game, projections, modelFreshness) {
  if (!projections) return [];

  const awayName = game.away_full ?? game.away ?? 'Away';
  const homeName = game.home_full ?? game.home ?? 'Home';
  const lines = [];

  if (modelFreshness === 'live' || modelFreshness === 'final') {
    lines.push('STALE_PREGAME_MODEL: these are pregame projections not recomputed from live inputs.');
  }

  lines.push('--- PROJECTION-FIRST READ (model layer, market-free) ---');
  lines.push(describeMoneyline(projections.score, { home_team: homeName, away_team: awayName }));
  lines.push(describeRunline(projections.score, { home_team: homeName }));
  lines.push(describeTotal(projections.score));
  lines.push(describeTeamRuns(projections.score, 'away', awayName));
  lines.push(describeTeamRuns(projections.score, 'home', homeName));
  lines.push(describeProjectedSpread(
    projections.means?.lambdaAway,
    projections.means?.lambdaHome,
    {
      away_team: awayName,
      home_team: homeName,
      status: projections.score?.status,
      blocked_reasons: projections.score?.blocked_reasons,
    },
  ));
  lines.push(describeYrfi(projections.yrfi));
  lines.push(describeKs(projections.ks_away, `${awayName} starter`));
  lines.push(describeKs(projections.ks_home, `${homeName} starter`));
  lines.push(describeHr(projections.hr));

  return lines;
}

// ---- fundamentals-based decision helper --------------------------------------

/**
 * Derive a fundamentals-based decision for a lane.
 *
 * Rules:
 *   - If the market engine returned 'NO CLEAR PICK' (market missing/unquoted),
 *     the fundamentals decision is also 'NO CLEAR PICK'.
 *   - Otherwise, fundamentals are incomplete at packet time → 'WATCH'.
 *
 * The result is the raw decision BEFORE downgrade is applied.
 *
 * @param {string} marketEngineDecision  — raw decision from analyzeGame()
 * @returns {'WATCH'|'NO CLEAR PICK'}
 */
function fundamentalsDecision(marketEngineDecision) {
  if (marketEngineDecision === 'NO CLEAR PICK') return 'NO CLEAR PICK';
  return 'WATCH';
}

// ---- edge basis section (replaces old market lanes section) ------------------

function renderEdgeBasisSection(analysis, downgrade, lineupStatus) {
  const { sections } = analysis;
  const lines = [];
  lines.push('--- Edge Basis ---');
  lines.push('Decisions require confirmed fundamentals. Board signals are in Market Context below.');
  lines.push('Price, board volume, spread movement, and quote structure do not create a PICK or LEAN here.');

  // Winner (ML)
  {
    const raw = fundamentalsDecision(sections.ml.decision);
    const reason = raw === 'NO CLEAR PICK'
      ? 'Market not available for this lane.'
      : 'Fundamentals required: confirmed starters, confirmed lineups, pitcher ERA/K profile, lineup offense rank, bullpen rest, park/weather.';
    const { lines: lns } = renderLaneEntry('Winner (ML)', raw, reason, downgrade, 'winner');
    for (const l of lns) lines.push(l);
  }

  // Spread / run line
  {
    const raw = fundamentalsDecision(sections.spread.decision);
    const reason = raw === 'NO CLEAR PICK'
      ? 'Market not available for this lane.'
      : 'Fundamentals required: same as winner, plus lineup depth and bullpen depth for run environment.';
    const { lines: lns } = renderLaneEntry('Spread/Run line', raw, reason, downgrade, 'spread');
    for (const l of lns) lines.push(l);
  }

  // Total
  {
    const raw = fundamentalsDecision(sections.total.decision);
    const reason = raw === 'NO CLEAR PICK'
      ? 'Market not available for this lane.'
      : 'Fundamentals required: confirmed starters, bullpen context, park HR factor, wind direction/speed, lineup quality.';
    const { lines: lns } = renderLaneEntry('Total', raw, reason, downgrade, 'total');
    for (const l of lns) lines.push(l);
  }

  // NFRI/YFRI
  {
    const raw = fundamentalsDecision(sections.yfri.decision);
    const reason = raw === 'NO CLEAR PICK'
      ? 'Market not available for this lane.'
      : 'Fundamentals required: top-3 lineup slots confirmed, starter first-inning profile, park first-inning factor.';
    const { lines: lns } = renderLaneEntry('NFRI/YFRI', raw, reason, downgrade, 'yfri');
    for (const l of lns) lines.push(l);
  }

  // HR props
  lines.push('  HR props:');
  if (sections.hr.perPlayer && sections.hr.perPlayer.length > 0) {
    for (const p of sections.hr.perPlayer) {
      const raw = fundamentalsDecision(p.decision);
      const reason = raw === 'NO CLEAR PICK'
        ? 'Market not available for HR props.'
        : 'Fundamentals required: batter slot confirmed, recent HR rate, pitcher HR/9 and handedness, park HR factor.';
      const { decision: finalDecision, downgradeReason } = applyDowngrade('hr', raw, downgrade);
      const label = decisionLabel(finalDecision);
      lines.push(`    ${p.name}: ${label}`);
      lines.push(`      Reason: ${reason}`);
      if (downgradeReason) {
        lines.push(`      Downgrade: ${downgradeReason}`);
      }
    }
  } else {
    // Aggregate HR entry — no per-player data.
    const raw = fundamentalsDecision(sections.hr.decision);
    const reason = raw === 'NO CLEAR PICK'
      ? 'Market not available for HR props.'
      : 'Fundamentals required: batter slot confirmed, recent HR rate, pitcher HR/9 and handedness, park HR factor.';
    const { decision: finalDecision, downgradeReason } = applyDowngrade('hr', raw, downgrade);
    const label = decisionLabel(finalDecision);
    lines.push(`    Aggregate: ${label}`);
    lines.push(`      Reason: ${reason}`);
    if (downgradeReason) {
      lines.push(`      Downgrade: ${downgradeReason}`);
    }
  }

  // K props — away starter
  lines.push('  K props (away starter):');
  if (sections.ks_away.perPitcher && sections.ks_away.perPitcher.length > 0) {
    for (const p of sections.ks_away.perPitcher) {
      const raw = fundamentalsDecision(p.decision);
      const reason = raw === 'NO CLEAR PICK'
        ? 'Market not available for K props.'
        : 'Fundamentals required: confirmed starter identity, K/9 profile, opponent K-rate vs. handedness, projected IP (5+ required).';
      const { decision: finalDecision, downgradeReason } = applyDowngrade('k', raw, downgrade);
      const label = decisionLabel(finalDecision);
      lines.push(`    ${p.name}: ${label}`);
      lines.push(`      Reason: ${reason}`);
      if (downgradeReason) {
        lines.push(`      Downgrade: ${downgradeReason}`);
      }
    }
  } else {
    const raw = fundamentalsDecision(sections.ks_away.decision);
    const reason = raw === 'NO CLEAR PICK'
      ? 'Market not available for K props.'
      : 'Fundamentals required: confirmed starter identity, K/9 profile, opponent K-rate vs. handedness, projected IP (5+ required).';
    const { decision: finalDecision, downgradeReason } = applyDowngrade('k', raw, downgrade);
    const label = decisionLabel(finalDecision);
    lines.push(`    (starter): ${label}`);
    lines.push(`      Reason: ${reason}`);
    if (downgradeReason) {
      lines.push(`      Downgrade: ${downgradeReason}`);
    }
  }

  // K props — home starter
  lines.push('  K props (home starter):');
  if (sections.ks_home.perPitcher && sections.ks_home.perPitcher.length > 0) {
    for (const p of sections.ks_home.perPitcher) {
      const raw = fundamentalsDecision(p.decision);
      const reason = raw === 'NO CLEAR PICK'
        ? 'Market not available for K props.'
        : 'Fundamentals required: confirmed starter identity, K/9 profile, opponent K-rate vs. handedness, projected IP (5+ required).';
      const { decision: finalDecision, downgradeReason } = applyDowngrade('k', raw, downgrade);
      const label = decisionLabel(finalDecision);
      lines.push(`    ${p.name}: ${label}`);
      lines.push(`      Reason: ${reason}`);
      if (downgradeReason) {
        lines.push(`      Downgrade: ${downgradeReason}`);
      }
    }
  } else {
    const raw = fundamentalsDecision(sections.ks_home.decision);
    const reason = raw === 'NO CLEAR PICK'
      ? 'Market not available for K props.'
      : 'Fundamentals required: confirmed starter identity, K/9 profile, opponent K-rate vs. handedness, projected IP (5+ required).';
    const { decision: finalDecision, downgradeReason } = applyDowngrade('k', raw, downgrade);
    const label = decisionLabel(finalDecision);
    lines.push(`    (starter): ${label}`);
    lines.push(`      Reason: ${reason}`);
    if (downgradeReason) {
      lines.push(`      Downgrade: ${downgradeReason}`);
    }
  }

  return lines;
}

// ---- market context section --------------------------------------------------

function renderMarketContextSection(analysis) {
  const { sections } = analysis;
  const lines = [];
  lines.push('--- Market Context ---');
  lines.push('Board signals shown for reference only. Board structure alone cannot create a PICK or LEAN.');

  lines.push(`Board Winner (ML): ${sections.ml.decision} — ${sections.ml.reason}`);
  lines.push(`Board Spread: ${sections.spread.decision} — ${sections.spread.reason}`);
  lines.push(`Board Total: ${sections.total.decision} — ${sections.total.reason}`);
  lines.push(`Board NFRI/YFRI: ${sections.yfri.decision} — ${sections.yfri.reason}`);
  lines.push(`Board HR: ${sections.hr.decision} — ${sections.hr.reason}`);
  lines.push(`Board K (away): ${sections.ks_away.decision} — ${sections.ks_away.reason}`);
  lines.push(`Board K (home): ${sections.ks_home.decision} — ${sections.ks_home.reason}`);

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

function renderOverallDecision(final, starters, lineupStatus) {
  const lines = [];
  lines.push('--- Overall Decision ---');
  lines.push(`Decision status: ${final.decision_status}`);
  lines.push(`Best angle: ${final.best_angle}`);

  // Fundamentals-based reasoning — do not surface board-signal language here.
  const startersOk = starters && (
    (typeof starters.away === 'string' ? starters.away : starters.away?.name) ||
    (typeof starters.home === 'string' ? starters.home : starters.home?.name)
  );
  const lineupPartial = lineupStatus === LINEUP_STATUS.BOTH_CONFIRMED
    || lineupStatus === LINEUP_STATUS.ONE_CONFIRMED;

  let fundamentalsReasoning;
  if (startersOk || lineupPartial) {
    fundamentalsReasoning = 'Partial fundamentals available. Full confirmation required before edge claim.';
  } else {
    fundamentalsReasoning = 'Fundamentals required before any edge claim. See Market Context for board signals.';
  }

  lines.push(`Reasoning: ${fundamentalsReasoning}`);
  return lines;
}

// ---- best lane resolution ----------------------------------------------------

function resolveBestLane(analysis, downgrade) {
  const candidates = [
    { lane: 'winner', engineDecision: analysis.sections.ml.decision },
    { lane: 'spread', engineDecision: analysis.sections.spread.decision },
    { lane: 'total',  engineDecision: analysis.sections.total.decision },
    { lane: 'yfri',   engineDecision: analysis.sections.yfri.decision },
  ];
  const ranked = candidates
    .map((c) => {
      const raw = fundamentalsDecision(c.engineDecision);
      const { decision: final } = applyDowngrade(c.lane, raw, downgrade);
      const label = decisionLabel(final);
      // Derive a fundamentals-based reason for the best lane summary.
      const reason = raw === 'NO CLEAR PICK'
        ? 'Market not available for this lane.'
        : (() => {
            switch (c.lane) {
              case 'winner': return 'Fundamentals required: confirmed starters, confirmed lineups, pitcher ERA/K profile, lineup offense rank, bullpen rest, park/weather.';
              case 'spread': return 'Fundamentals required: same as winner, plus lineup depth and bullpen depth for run environment.';
              case 'total':  return 'Fundamentals required: confirmed starters, bullpen context, park HR factor, wind direction/speed, lineup quality.';
              case 'yfri':   return 'Fundamentals required: top-3 lineup slots confirmed, starter first-inning profile, park first-inning factor.';
              default:       return 'Fundamentals required.';
            }
          })();
      return { ...c, finalDecision: final, label, order: DECISION_ORDER[label] ?? 99, reason };
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
  const projections  = options.projections  ?? null;
  const modelFreshness = options.modelFreshness ?? 'pregame';

  const downgrade = resolveDowngrade(lineupStatus);
  const analysis  = analyzeGame(game, { projections });

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
    ...renderProjectionFirstSection(game, projections, modelFreshness),
  ];

  if (projections) {
    sections.push('');
  }

  sections.push(
    ...renderEdgeBasisSection(analysis, downgrade, lineupStatus),
    '',
    ...renderResearchCompleteness(starters, lineupStatus),
    '',
    ...renderMarketContextSection(analysis),
    '',
    ...renderOverallDecision(analysis.final, starters, lineupStatus),
    '',
    'No trades placed. No bankroll sizing. Research only.',
  );

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
    hrProjection: projections?.hr ?? null,
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
    'Decisions require confirmed fundamentals (starters, lineups, pitcher stats, batter/power, bullpen, park/weather).',
    'Board context shown in each per-game packet. No price-only picks.',
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
      noPickSection.push(`${matchup}: NO CLEAR PICK — No fundamentals available to support an edge claim.`);
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

// ---- compact slate renderer (Telegram-friendly) ----------------------------
//
// One game = two lines max:
//   STATUS  AWAY@HOME  →  Lane
//   <≤2-sentence why>
//
// WATCH / NO CLEAR PICK games are collapsed into a single footer line.
// Raw market prices (¢, liq=, oi=, vol=) are never shown.
// Designed to fit in ONE Telegram message for a full slate.
//
// Optional `compositeOverrides` map: game_key → { status, lane, why }
// When provided, composite-model picks replace the market-engine signal.

export function renderCompactSlate(block, perGamePackets, compositeOverrides = new Map()) {
  const date  = block.lead_first_pitch_ct ?? block.block_id ?? '';
  const lines = [`MLB — ${block.block_id}  ${date}`, '─'.repeat(32)];

  const STATUS_EMOJI = { PICK: '★', PLAY: '★', CLEAR: '★', LEAN: '◆', WATCH: '○', 'NO CLEAR PICK': '–' };
  const STATUS_RANK  = { PICK: 0, PLAY: 0, CLEAR: 0, LEAN: 1, WATCH: 2, 'NO CLEAR PICK': 3 };

  const sorted = sortPacketsByDecision(perGamePackets);
  const watchGames  = [];
  const pickedGames = [];

  for (const p of sorted) {
    const override = compositeOverrides.get(p.gameKey ?? p.game_key ?? '');
    const matchup = `${p.awayAbbrev ?? '?'}@${p.homeAbbrev ?? '?'}`;

    if (override) {
      const rank = STATUS_RANK[override.status] ?? STATUS_RANK[p.bestLaneDecisionLabel] ?? 3;
      if (rank <= 1) {
        pickedGames.push({ matchup, status: override.status, lane: override.lane, why: override.why ?? '', rank });
      } else {
        watchGames.push(matchup);
      }
      continue;
    }

    const label = p.bestLaneDecisionLabel ?? 'NO CLEAR PICK';
    const rank  = STATUS_RANK[label] ?? 3;

    if (rank <= 1) {
      // Distill the raw market reason into ≤2 clean sentences.
      const rawReason = p.bestLaneReason ?? '';
      const why = distillReason(rawReason, label);
      pickedGames.push({ matchup, status: label, lane: p.bestLane ?? '', why, rank });
    } else {
      watchGames.push(matchup);
    }
  }

  pickedGames.sort((a, b) => a.rank - b.rank);

  for (const g of pickedGames) {
    const emoji = STATUS_EMOJI[g.status] ?? '◆';
    lines.push(`${emoji} ${g.status.padEnd(5)}  ${g.matchup.padEnd(10)}→  ${laneName(g.lane)}`);
    if (g.why) lines.push(g.why);
    lines.push('');
  }

  if (watchGames.length > 0) {
    if (pickedGames.length > 0) lines.push('─'.repeat(32));
    lines.push(`○ WATCH  ${watchGames.join(' · ')}`);
    lines.push('No actionable edge — board awaits starters, lineups, fundamentals.');
  }

  lines.push('─'.repeat(32));
  lines.push('Research only. No trades placed.');

  return lines.join('\n');
}

function laneName(lane) {
  const MAP = {
    winner: 'ML', spread: 'Run Line', total: 'Total',
    yfri: 'YRFI/NRFI', moneyline_away: 'Away ML', moneyline_home: 'Home ML',
    run_line_away: 'Away -1.5', run_line_home: 'Home -1.5',
    total_over: 'OVER', total_under: 'UNDER', yrfi: 'YRFI', nrfi: 'NRFI',
  };
  return MAP[lane] ?? lane;
}

// Condense a verbose market-engine reason string into ≤2 tight sentences.
// Strips raw price data (¢, liq=, oi=, vol=) and structural jargon.
function distillReason(raw, status) {
  if (!raw) return '';
  // Remove price noise
  let s = raw
    .replace(/YES\([^)]+\)=\d+¢\s*/g, '')
    .replace(/\d+¢\s*\+\s*\d+¢\s*=\s*\d+¢/g, match => match) // keep totals
    .replace(/liq=[\d.]+\s*/gi, '')
    .replace(/oi=[\d.]+\s*/gi, '')
    .replace(/vol=[\d.]+\s*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  // Truncate to ~180 chars (≈2 short sentences) at a sentence boundary
  if (s.length > 200) {
    const cut = s.slice(0, 200);
    const lastPeriod = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    s = lastPeriod > 80 ? cut.slice(0, lastPeriod + 1) : cut + '…';
  }
  // If it reads like "Fundamentals required: ..." replace with a clean placeholder
  if (/^Fundamentals required/i.test(s)) {
    return status === 'LEAN'
      ? 'Market signal detected; composite fundamentals will surface the edge when lineups confirm.'
      : 'Awaiting confirmed starters and lineups to support this lane.';
  }
  return s;
}
