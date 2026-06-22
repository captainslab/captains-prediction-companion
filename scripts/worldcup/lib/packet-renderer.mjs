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

// --- Customer-facing translation of internal model enums ---------------------
// Internal enum names (PICK / LEAN / WATCH / FADE, CONSISTENT / MISMATCH, …) are
// kept on the board objects for compatibility but are NEVER rendered raw. The
// customer reads soccer / handicapping language only; the raw enums live in the
// audit JSON. Price/market fields still never touch any model value here.

const DISPLAY_LABELS = {
  match_winner: 'Match Result',
  spread_full_game: 'Goal Spread',
  total_goals: 'Total Goals',
  both_teams_to_score: 'BTTS',
};
function displayLabel(lane) {
  return DISPLAY_LABELS[lane.lane] ?? lane.label;
}

function confidenceLine(confidence, provisional) {
  return `    Confidence: ${confidence ?? 'low'}${provisional ? ', pre-lock' : ''}`;
}

// Side + strength for a result-style recommendation, in soccer language.
function modelSidePhrase(rec, match) {
  const side = /HOME/.test(rec) ? match.home_team
    : /AWAY/.test(rec) ? match.away_team
    : /DRAW/.test(rec) ? 'Draw'
    : null;
  if (rec.startsWith('PICK') && side) return `Clear model side: ${side}`;
  if (rec.startsWith('LEAN') && side) return `Slight model side: ${side}`;
  return 'No clear side';
}

// Generic translated model state for any non-main lane (last-resort fallback).
function modelStatePhrase(rec) {
  if (rec.startsWith('PICK')) return 'Actionable model edge';
  if (rec === 'LEAN_FADE') return 'Opposite-side value (model rejects price)';
  if (rec.startsWith('LEAN')) return 'Slight model advantage';
  if (rec === 'WATCH') return 'Monitor — no clear actionable edge';
  if (rec === 'BLOCKED_MODEL_LAYER_MISSING') return 'Model unavailable: missing model layer';
  return rec;
}

function crossCheckPhrase(verdict) {
  if (verdict === 'CONSISTENT') return 'models aligned';
  if (verdict === 'MISMATCH') return 'model disagreement';
  return 'monitor model disagreement';
}
function crossCheckSentence(verdict) {
  if (verdict === 'CONSISTENT') return 'The goal-distribution model and match-result model point to the same side.';
  if (verdict === 'MISMATCH') return 'The goal-distribution model and match-result model point to different sides.';
  return 'The goal-distribution model and match-result model differ slightly; monitor before lock.';
}

function drawReadPhrase(evaluation) {
  if (evaluation === 'ACTIONABLE') return 'draw in play';
  if (evaluation === 'WATCH_ONLY') return 'draw monitor';
  if (evaluation === 'BLOCKED_MODEL_LAYER_MISSING') return 'unavailable';
  return evaluation ?? 'n/a';
}

function totalProfile(total) {
  if (total == null) return 'unknown goal environment';
  if (total >= 3.0) return 'high-scoring profile';
  if (total >= 2.7) return 'neutral-to-over goal environment';
  if (total >= 2.4) return 'neutral total profile';
  if (total >= 2.1) return 'neutral-to-under goal environment';
  return 'low-scoring profile';
}

// Short side phrase for the summary/list sections (TLDR etc.).
function laneSidePhrase(lane, match) {
  const rec = lane.recommendation;
  if (lane.lane === 'match_winner') {
    return /HOME/.test(rec) ? match.home_team : /AWAY/.test(rec) ? match.away_team
      : /DRAW/.test(rec) ? 'Draw' : 'no clear side';
  }
  if (lane.lane === 'total_goals') {
    return /OVER/.test(rec) ? `Over ${lane.total_line}` : /UNDER/.test(rec) ? `Under ${lane.total_line}` : 'no clear total side';
  }
  if (lane.lane === 'spread_full_game') {
    return /COVER_HOME/.test(rec) ? `${match.home_team} cover` : /COVER_AWAY/.test(rec) ? `${match.away_team} cover`
      : rec === 'LEAN_FADE' ? 'underdog cushion' : 'no clear spread side';
  }
  if (lane.lane === 'both_teams_to_score') {
    return rec === 'YES' ? 'Both teams to score' : rec === 'NO' ? 'No / clean sheet' : 'no clear BTTS side';
  }
  return 'model side';
}

function formatLane(lane, match, provisional) {
  // Model-unavailable lanes render as a single honest line — no fake model half.
  if (lane.recommendation === 'BLOCKED_MODEL_LAYER_MISSING') {
    const ref = lane.market_context
      ? ` | market ref (NOT IN SCORE): ${lane.market_context.normalized_target ?? lane.market_context.ticker}`
      : '';
    return `  [${displayLabel(lane)}] Model unavailable: missing model layer.${ref}\n`;
  }

  const lines = [];
  const label = displayLabel(lane);

  if (lane.lane === 'match_winner' && lane.p_home != null) {
    lines.push(`  [${label}] ${modelSidePhrase(lane.recommendation, match)}`);
    lines.push(`    Home win profile: ${pct(lane.p_home)}`);
    lines.push(`    Draw risk: ${pct(lane.p_draw)}`);
    lines.push(`    Away win profile: ${pct(lane.p_away)}`);
    if (lane.cross_check_1x2) {
      lines.push(`    Score-grid cross-check: ${crossCheckPhrase(lane.cross_check_1x2.verdict)}`);
    }
    lines.push(`    Basis: composite H ${lane.composite_score_home ?? 'MISSING'} vs A ${lane.composite_score_away ?? 'MISSING'}`);
    if (lane.explanation && /Downgraded from PICK/.test(lane.explanation)) {
      lines.push('    Pre-lineup: model side held back until lineups confirm');
    }
    lines.push(confidenceLine(lane.confidence, provisional));
  } else if (lane.lane === 'total_goals' && lane.projected_total_goals != null) {
    lines.push(`  [${label}] Goal projection: ${lane.projected_total_goals}`);
    if (lane.p_over != null) {
      const view = /OVER/.test(lane.recommendation) ? `Over ${lane.total_line} profile`
        : /UNDER/.test(lane.recommendation) ? `Under ${lane.total_line} profile`
        : 'no clear total side';
      lines.push(`    Total view: ${view}`);
      lines.push(`    Over profile: ${pct(lane.p_over)} / Under profile: ${pct(lane.p_under)}`);
    } else {
      lines.push('    Total view: no line available to grade');
    }
    lines.push(`    Profile: ${totalProfile(lane.projected_total_goals)}`);
    lines.push(confidenceLine(lane.confidence, provisional));
  } else if (lane.lane === 'both_teams_to_score' && lane.p_btts_yes != null) {
    lines.push(`  [${label}] Both-score probability: ${pct(lane.p_btts_yes)}`);
    const view = lane.recommendation === 'YES' ? 'Yes profile'
      : lane.recommendation === 'NO' ? 'No profile'
      : 'balanced profile / no clear BTTS side';
    lines.push(`    BTTS view: ${view}`);
    const csr = lane.p_btts_no >= 0.6 ? 'high' : lane.p_btts_no >= 0.45 ? 'moderate' : 'low';
    lines.push(`    Clean-sheet risk: ${csr}`);
    lines.push(confidenceLine(lane.confidence, provisional));
  } else if (lane.lane === 'spread_full_game' && lane.projected_goal_margin_home != null) {
    const m = lane.projected_goal_margin_home;
    const marginPhrase = m === 0 ? 'even (0.0 goals)'
      : m > 0 ? `${match.home_team} +${m.toFixed(2)} goals`
      : `${match.away_team} +${Math.abs(m).toFixed(2)} goals`;
    lines.push(`  [${label}] Projected margin: ${marginPhrase}`);
    if (lane.p_cover != null) {
      const view = /COVER_HOME/.test(lane.recommendation) ? 'home cover profile'
        : /COVER_AWAY/.test(lane.recommendation) ? 'away cover profile'
        : lane.recommendation === 'LEAN_FADE' ? 'underdog cushion profile'
        : 'no clear spread side';
      lines.push(`    Spread view: ${view}`);
      lines.push(`    Cover profile: ${pct(lane.p_cover)} (${lane.spread_side} ${lane.spread_line})`);
    } else {
      lines.push('    Spread view: no line available to grade');
      lines.push(`    Profile: ${m === 0 ? 'even matchup' : 'favorite advantage'}, not enough line context for a cover call`);
    }
    lines.push(confidenceLine(lane.confidence, provisional));
  } else {
    lines.push(`  [${label}] ${modelStatePhrase(lane.recommendation)} | confidence:${lane.confidence}`);
  }

  // Market half — display only, always labeled NOT IN SCORE.
  if (lane.market_context) {
    const mc = lane.market_context;
    const settle = mc.settlement ? `${mc.settlement.scope}${mc.settlement.explicit ? '' : ' (default)'}` : 'n/a';
    const gaps = [
      lane.edge_home_pp != null ? `H:${lane.edge_home_pp}pp` : null,
      lane.edge_draw_pp != null ? `D:${lane.edge_draw_pp}pp` : null,
      lane.edge_away_pp != null ? `A:${lane.edge_away_pp}pp` : null,
    ].filter(Boolean).join(' ') || 'n/a (no model fair probability)';
    lines.push(`    MARKET (NOT IN SCORE): ${mc.normalized_target ?? mc.ticker ?? 'N/A'} | imp:${mc.implied_probability != null ? (mc.implied_probability * 100).toFixed(1) + '%' : 'N/A'} | settles:${settle} | model−market gap ${gaps}`);
  } else {
    lines.push('    MARKET (NOT IN SCORE): no market context attached');
  }
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
    lines.push(`  Match result model: H ${Math.round(probs.p_home * 100)}% / D ${Math.round(probs.p_draw * 100)}% / A ${Math.round(probs.p_away * 100)}% | draw risk: ${probs.draw_risk} | draw read: ${drawReadPhrase(probs.draw_evaluation)}`);
    if (probs.goal_environment) {
      lines.push(`  goal environment (proxy): total ${probs.goal_environment.xg_total} (H ${probs.goal_environment.xg_home} / A ${probs.goal_environment.xg_away})`);
    }
    const gp = board.goal_projection;
    if (gp && gp.projection_status === 'PROJECTED') {
      lines.push(`  projected goals: H ${gp.projected_home_goals} / A ${gp.projected_away_goals} | total ${gp.projected_total_goals} | margin ${gp.projected_goal_margin_home >= 0 ? '+' : ''}${gp.projected_goal_margin_home} (home)`);
      const cc = gp.cross_check_1x2;
      lines.push(`  Score-grid cross-check: ${crossCheckPhrase(cc.verdict)}`);
      lines.push(`    ${crossCheckSentence(cc.verdict)}`);
    } else if (gp && gp.projection_status) {
      lines.push('  projected goals: model unavailable (missing model layer)');
    }
    lines.push('');
  } else if (probs?.blocked_reason) {
    lines.push(`  Match result model: unavailable — ${probs.blocked_reason}`);
    lines.push('');
  }

  for (const lane of board.lanes || []) {
    // Keep the board compact: skip not-applicable lanes and lanes the model
    // has no logic for (empty explanation) — they live in the audit JSON.
    if (lane.recommendation === 'N/A' || !lane.explanation) continue;
    lines.push(formatLane(lane, match, provenance?.provisional));
  }

  lines.push(`  overall_confidence: ${board.overall_confidence}`);
  lines.push(`  Model sides — actionable: ${board.pick_count} | slight: ${board.lean_count} | monitor: ${board.watch_count}`);
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
    lines.push('  No clear model sides today. Board is monitor-only.\n');
  } else {
    for (const { match, lane } of [...allPicks, ...allLeans].slice(0, 5)) {
      const strength = lane.recommendation.startsWith('PICK') ? 'clear model side' : 'slight model side';
      lines.push(`  • ${match.home_team} vs ${match.away_team} — ${displayLabel(lane)}: ${laneSidePhrase(lane, match)} (${strength}, confidence ${lane.confidence})`);
    }
    lines.push('');
  }

  // 1b. MATCH BOARDS — model half and market half per lane
  lines.push(section('MATCH BOARDS (model vs market)'));
  for (let i = 0; i < matches.length; i++) {
    lines.push(formatMatch(matches[i], boards[i], provenance));
  }

  // 2. MODEL vs MARKET — LARGEST GAPS (post-model comparison; market is NOT IN SCORE)
  lines.push(section('2. MODEL vs MARKET — LARGEST GAPS'));
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
    lines.push('  No market context available for comparison.\n');
  } else {
    for (const { match, lane, edge } of edges.slice(0, 5)) {
      lines.push(`  • ${match.home_team} vs ${match.away_team} — ${displayLabel(lane)}: model−market gap ${edge > 0 ? '+' : ''}${edge}pp`);
    }
    lines.push('');
  }

  // 3. MONITOR — NO CLEAR SIDE
  lines.push(section('3. MONITOR — NO CLEAR SIDE'));
  if (allWatches.length === 0) {
    lines.push('  Nothing to monitor.\n');
  } else {
    for (const { match, lane } of allWatches.slice(0, 5)) {
      lines.push(`  • ${match.home_team} vs ${match.away_team} — ${displayLabel(lane)}: monitor / no clear side`);
    }
    lines.push('');
  }

  // 4. OPPOSITE-SIDE VALUE (model points opposite the market)
  lines.push(section('4. OPPOSITE-SIDE VALUE'));
  const fades = edges.filter(e => (e.edge ?? 0) < -5);
  if (fades.length === 0) {
    lines.push('  No opposite-side value today.\n');
  } else {
    for (const { match, lane, edge } of fades.slice(0, 5)) {
      lines.push(`  • ${match.home_team} vs ${match.away_team} — ${displayLabel(lane)}: model points opposite the market by ${Math.abs(edge)}pp (possible opposite-side value)`);
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
      lines.push(`  • ${match.home_team} vs ${match.away_team}: ${blockedLanes.length} model lane(s) unavailable (missing model layer) — ${blockedLanes.map(l => displayLabel(l)).join(', ')}`);
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
