// World Cup packet renderer — sectioned decision board.
//
// Required sections:
//   1. TLDR BOARD
//   2. TOP EDGE CANDIDATES
//   3. WATCHLIST / TRIGGER BOARD
//   4. FADES / OVERPRICED
//   5. BLOCKED / NEEDS SOURCE
//   6. AUDIT ARTIFACTS
//   7. SOURCE QUALITY / MODEL COMPLETENESS
//
// Rules:
//   - Main packet must be enjoyable and quick to read.
//   - No raw contract inventory in main packet.
//   - Full raw market inventory goes to .inventory.txt audit artifact only.
//   - Every row shows model half and market half separately.
//   - Market line clearly labeled as NOT IN SCORE.
//   - If source data missing, show exact missing source and next trigger.
//   - If lineups unavailable, show pre-lineup confidence downgrade.

import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

function header(title, date) {
  return [
    `=== Captain World Cup — CPC Packet: ${title} ===`,
    `date: ${date}`,
    `packet_type: worldcup-matchday`,
    `Generated: ${new Date().toISOString()}`,
    `No trades placed by this workflow. Research only.`,
    ``,
  ].join('\n');
}

function section(title) {
  return `\n${'─'.repeat(70)}\n  ${title}\n${'─'.repeat(70)}\n`;
}

function pct(p) {
  return p == null ? 'N/A' : `${(p * 100).toFixed(0)}%`;
}

function formatLane(lane) {
  // Blocked lanes render as a single honest line — no fake model half.
  if (lane.recommendation === 'BLOCKED_MODEL_LAYER_MISSING') {
    const ref = lane.market_context
      ? ` | market ref (NOT IN SCORE): ${lane.market_context.normalized_target ?? lane.market_context.ticker}`
      : '';
    return `  [${lane.label}] BLOCKED_MODEL_LAYER_MISSING — ${lane.explanation}${ref}\n`;
  }

  const lines = [];
  lines.push(`  [${lane.label}] MODEL: ${lane.recommendation} | composite H:${lane.composite_score_home ?? 'MISSING'} A:${lane.composite_score_away ?? 'MISSING'} | confidence:${lane.confidence}`);
  if (lane.lane === 'match_winner' && lane.p_home != null) {
    lines.push(`    1X2: H ${pct(lane.p_home)} / D ${pct(lane.p_draw)} / A ${pct(lane.p_away)} | winner_lean:${lane.winner_lean} | draw_risk:${lane.draw_risk} | draw:${lane.draw_evaluation}`);
    if (lane.cross_check_1x2) {
      lines.push(`    Poisson 1X2 cross-check: ${lane.cross_check_1x2.verdict} (logistic→${lane.cross_check_1x2.logistic_winner ?? 'n/a'}, poisson→${lane.cross_check_1x2.poisson_winner})`);
    }
  }
  if (lane.lane === 'total_goals' && lane.projected_total_goals != null) {
    lines.push(lane.p_over != null
      ? `    Total: projected ${lane.projected_total_goals} | P(over ${lane.total_line})=${pct(lane.p_over)} / P(under ${lane.total_line})=${pct(lane.p_under)}`
      : `    Total: projected ${lane.projected_total_goals} | projection-only (no line)`);
  }
  if (lane.lane === 'both_teams_to_score' && lane.p_btts_yes != null) {
    lines.push(`    BTTS: P(Yes)=${pct(lane.p_btts_yes)} / P(No)=${pct(lane.p_btts_no)}`);
  }
  if (lane.lane === 'spread_full_game' && lane.projected_goal_margin_home != null) {
    lines.push(lane.p_cover != null
      ? `    Spread: projected margin ${lane.projected_goal_margin_home >= 0 ? '+' : ''}${lane.projected_goal_margin_home} | P(cover ${lane.spread_side} ${lane.spread_line})=${pct(lane.p_cover)}`
      : `    Spread: projected margin ${lane.projected_goal_margin_home >= 0 ? '+' : ''}${lane.projected_goal_margin_home} | margin-only (no line)`);
  }
  if (lane.market_context) {
    const mc = lane.market_context;
    const settle = mc.settlement ? `${mc.settlement.scope}${mc.settlement.explicit ? '' : ' (default)'}` : 'n/a';
    const edges = [
      lane.edge_home_pp != null ? `H:${lane.edge_home_pp}pp` : null,
      lane.edge_draw_pp != null ? `D:${lane.edge_draw_pp}pp` : null,
      lane.edge_away_pp != null ? `A:${lane.edge_away_pp}pp` : null,
    ].filter(Boolean).join(' ') || 'none (no model fair probability)';
    lines.push(`    MARKET (NOT IN SCORE): ${mc.normalized_target ?? mc.ticker ?? 'N/A'} | imp:${mc.implied_probability != null ? (mc.implied_probability * 100).toFixed(1) + '%' : 'N/A'} | settles:${settle} | edge ${edges}`);
  } else {
    lines.push(`    MARKET (NOT IN SCORE): no market context attached`);
  }
  lines.push(`    why: ${lane.explanation}`);
  lines.push('');
  return lines.join('\n');
}

function formatMatch(match, board, provenance = null) {
  const lines = [];
  lines.push(`▶ ${match.home_team} vs ${match.away_team}  [${match.stage}]`);
  lines.push(`  kickoff: ${match.kickoff_utc ?? 'TBD'}`);
  const lockStatus = match.lineup_status === 'lineup_confirmed' ? 'LOCKED' : 'PRE_LOCK / NOT_LOCKED';
  lines.push(`  lineup_status: ${match.lineup_status ?? 'unknown'} (${lockStatus})`);
  if (provenance?.provisional) {
    lines.push(`  model_basis: PRIOR_TEAM_COMPOSITE (baseline ${provenance.source_date}) — PRE_LOCK / PROVISIONAL`);
  }
  lines.push('');

  const probs = board.probabilities;
  if (probs && probs.p_home != null) {
    lines.push(`  1X2 model: H ${Math.round(probs.p_home * 100)}% / D ${Math.round(probs.p_draw * 100)}% / A ${Math.round(probs.p_away * 100)}% | draw_risk:${probs.draw_risk} | draw read:${probs.draw_evaluation}`);
    if (probs.goal_environment) {
      lines.push(`  goal environment (proxy): total ${probs.goal_environment.xg_total} (H ${probs.goal_environment.xg_home} / A ${probs.goal_environment.xg_away})`);
    }
    const gp = board.goal_projection;
    if (gp && gp.projection_status === 'PROJECTED') {
      lines.push(`  projected goals: H ${gp.projected_home_goals} / A ${gp.projected_away_goals} | total ${gp.projected_total_goals} | margin ${gp.projected_goal_margin_home >= 0 ? '+' : ''}${gp.projected_goal_margin_home} (home)`);
      const cc = gp.cross_check_1x2;
      lines.push(`  Poisson 1X2 (cross-check): H ${Math.round(gp.poisson_1x2.p_home * 100)}% / D ${Math.round(gp.poisson_1x2.p_draw * 100)}% / A ${Math.round(gp.poisson_1x2.p_away * 100)}% | vs logistic: ${cc.verdict} (logistic→${cc.logistic_winner ?? 'n/a'}, poisson→${cc.poisson_winner})`);
    } else if (gp && gp.projection_status) {
      lines.push(`  projected goals: ${gp.projection_status}${gp.reason ? ` — ${gp.reason}` : ''}`);
    }
    lines.push('');
  } else if (probs?.blocked_reason) {
    lines.push(`  1X2 model: BLOCKED — ${probs.blocked_reason}`);
    lines.push('');
  }

  for (const lane of board.lanes || []) {
    // Keep the board compact: skip not-applicable lanes and lanes the model
    // has no logic for (empty explanation) — they live in the audit JSON.
    if (lane.recommendation === 'N/A' || !lane.explanation) continue;
    lines.push(formatLane(lane));
  }

  lines.push(`  overall_confidence: ${board.overall_confidence}`);
  lines.push(`  pick_count:${board.pick_count} lean_count:${board.lean_count} watch_count:${board.watch_count}`);
  lines.push('');
  return lines.join('\n');
}

export function renderWorldCupPacket({ matches, boards, meta = {} }) {
  const date = meta.date ?? new Date().toISOString().slice(0, 10);
  const packetStage = meta.packet_stage ?? 'morning_board';

  const provenance = meta.composite_provenance ?? null;

  const lines = [];
  lines.push(header(packetStage === 'lineup_locked' ? 'LINEUP-LOCKED BOARD' : 'MATCHDAY MORNING BOARD', date));
  if (provenance?.provisional) {
    lines.push(`MODEL BASIS: PRIOR_TEAM_COMPOSITE (last available baseline ${provenance.source_date}) — PRE_LOCK / PROVISIONAL.`);
    lines.push('Composites are carried from the most recent prior baseline; not yet refreshed for today. Confidence is provisional until lineups lock.\n');
  }

  // 1. TLDR BOARD
  lines.push(section('1. TLDR BOARD'));
  const allPicks = [];
  const allLeans = [];
  const allWatches = [];
  for (let i = 0; i < matches.length; i++) {
    const board = boards[i];
    for (const lane of board.lanes || []) {
      if (lane.recommendation.startsWith('PICK')) allPicks.push({ match: matches[i], lane });
      else if (lane.recommendation.startsWith('LEAN')) allLeans.push({ match: matches[i], lane });
      else if (lane.recommendation === 'WATCH') allWatches.push({ match: matches[i], lane });
    }
  }

  if (allPicks.length === 0 && allLeans.length === 0) {
    lines.push('  No PICKs or LEANs today. Board is WATCH or PASS.\n');
  } else {
    for (const { match, lane } of [...allPicks, ...allLeans].slice(0, 5)) {
      lines.push(`  • ${match.home_team} vs ${match.away_team} — ${lane.label}: ${lane.recommendation} (confidence:${lane.confidence})`);
    }
    lines.push('');
  }

  // 1b. MATCH BOARDS — model half and market half per lane
  lines.push(section('MATCH BOARDS (model vs market)'));
  for (let i = 0; i < matches.length; i++) {
    lines.push(formatMatch(matches[i], boards[i], provenance));
  }

  // 2. TOP EDGE CANDIDATES
  lines.push(section('2. TOP EDGE CANDIDATES'));
  const edges = [];
  for (let i = 0; i < matches.length; i++) {
    const board = boards[i];
    for (const lane of board.lanes || []) {
      if (lane.edge_home_pp != null || lane.edge_away_pp != null) {
        const e = Math.abs(lane.edge_home_pp ?? 0) > Math.abs(lane.edge_away_pp ?? 0)
          ? lane.edge_home_pp
          : lane.edge_away_pp;
        edges.push({ match: matches[i], lane, edge: e });
      }
    }
  }
  edges.sort((a, b) => Math.abs(b.edge ?? 0) - Math.abs(a.edge ?? 0));
  if (edges.length === 0) {
    lines.push('  No market context available for edge calculation.\n');
  } else {
    for (const { match, lane, edge } of edges.slice(0, 5)) {
      lines.push(`  • ${match.home_team} vs ${match.away_team} — ${lane.label}: edge=${edge > 0 ? '+' : ''}${edge}pp`);
    }
    lines.push('');
  }

  // 3. WATCHLIST / TRIGGER BOARD
  lines.push(section('3. WATCHLIST / TRIGGER BOARD'));
  if (allWatches.length === 0) {
    lines.push('  Nothing on watchlist.\n');
  } else {
    for (const { match, lane } of allWatches.slice(0, 5)) {
      lines.push(`  • ${match.home_team} vs ${match.away_team} — ${lane.label}: ${lane.recommendation}`);
    }
    lines.push('');
  }

  // 4. FADES / OVERPRICED
  lines.push(section('4. FADES / OVERPRICED'));
  const fades = edges.filter(e => (e.edge ?? 0) < -5);
  if (fades.length === 0) {
    lines.push('  No clear fades today.\n');
  } else {
    for (const { match, lane, edge } of fades.slice(0, 5)) {
      lines.push(`  • ${match.home_team} vs ${match.away_team} — ${lane.label}: model below market by ${Math.abs(edge)}pp`);
    }
    lines.push('');
  }

  // 4b. Market context note
  lines.push(section('Market Context — NOT IN SCORE'));
  lines.push('  All market pricing is display context only and never enters composite scoring.\n');

  // 5. BLOCKED / NEEDS SOURCE
  lines.push(section('5. BLOCKED / NEEDS SOURCE'));
  let blockedCount = 0;
  for (let i = 0; i < matches.length; i++) {
    const board = boards[i];
    const match = matches[i];
    if (board.overall_confidence === 'low' || match.lineup_status === 'lineup_pending') {
      blockedCount++;
      const missing = [];
      if (match.lineup_status === 'lineup_pending') missing.push('lineups');
      if (board.composite_score_home == null) missing.push('home composite');
      if (board.composite_score_away == null) missing.push('away composite');
      lines.push(`  • ${match.home_team} vs ${match.away_team}: blocked — missing ${missing.join(', ')}`);
    }
    const blockedLanes = (board.lanes || []).filter(l => l.recommendation === 'BLOCKED_MODEL_LAYER_MISSING');
    if (blockedLanes.length > 0) {
      blockedCount++;
      lines.push(`  • ${match.home_team} vs ${match.away_team}: ${blockedLanes.length} market lane(s) BLOCKED_MODEL_LAYER_MISSING — ${blockedLanes.map(l => l.label).join(', ')}`);
    }
  }
  if (blockedCount === 0) lines.push('  No blocked matches.\n');
  else lines.push('');

  // 6. AUDIT ARTIFACTS
  lines.push(section('6. AUDIT ARTIFACTS'));
  lines.push('  Full raw market inventory, source JSON, and model layers are stored');
  lines.push('  in the audit directory alongside this packet.\n');

  // 7. SOURCE QUALITY / MODEL COMPLETENESS
  lines.push(section('7. SOURCE QUALITY / MODEL COMPLETENESS'));
  let totalLayers = 0;
  let presentLayers = 0;
  for (const board of boards) {
    totalLayers += (board.layers_total ?? 14) * 2;
    presentLayers += (board.layers_present_home ?? 0) + (board.layers_present_away ?? 0);
  }
  lines.push(`  Matches evaluated: ${matches.length}`);
  lines.push(`  Packet stage: ${packetStage}`);
  lines.push(`  Overall data coverage: ${presentLayers}/${totalLayers} side-layers present`);
  lines.push(`  Pre-lineup confidence downgrade: ${packetStage === 'morning_board' ? 'YES' : 'NO'}`);
  lines.push('');

  lines.push('─'.repeat(70));
  lines.push('No trades placed by this workflow.');
  lines.push('No bankroll advice. No order placement. Research only.');
  lines.push('─'.repeat(70));

  return lines.join('\n');
}

export function writeWorldCupPacket({ dir, baseName, packetText, meta = {} }) {
  mkdirSync(dir, { recursive: true });
  const safeBase = baseName.replace(/[^a-z0-9._-]/gi, '_').slice(0, 80);
  const txtPath = resolve(dir, `${safeBase}.txt`);
  const metaPath = resolve(dir, `${safeBase}.meta.json`);
  writeFileSync(txtPath, packetText, 'utf8');
  writeFileSync(metaPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    char_count: packetText.length,
    no_trades_placed: true,
    ...meta,
  }, null, 2), 'utf8');
  return { txtPath, metaPath };
}
