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
    `╔══════════════════════════════════════════════════════════════════════╗`,
    `║  WORLD CUP DECISION BOARD  —  ${date}                          ║`,
    `╚══════════════════════════════════════════════════════════════════════╝`,
    ``,
    `Packet type: ${title}`,
    `Generated: ${new Date().toISOString()}`,
    `No trades placed by this workflow.`,
    ``,
  ].join('\n');
}

function section(title) {
  return `\n${'─'.repeat(70)}\n  ${title}\n${'─'.repeat(70)}\n`;
}

function formatLane(lane) {
  const modelLine = `  MODEL: ${lane.recommendation} | composite H:${lane.composite_score_home ?? 'MISSING'} A:${lane.composite_score_away ?? 'MISSING'} | confidence:${lane.confidence}`;
  const marketLine = lane.market_context
    ? `  MARKET (NOT IN SCORE): ${lane.market_context.ticker ?? 'N/A'} | imp:${lane.market_context.implied_probability != null ? (lane.market_context.implied_probability * 100).toFixed(1) + '%' : 'N/A'} | edge H:${lane.edge_home_pp ?? 'N/A'} A:${lane.edge_away_pp ?? 'N/A'}`
    : `  MARKET (NOT IN SCORE): no market context attached`;
  return [modelLine, marketLine, `  why: ${lane.explanation}`, ''].join('\n');
}

function formatMatch(match, board) {
  const lines = [];
  lines.push(`▶ ${match.home_team} vs ${match.away_team}  [${match.stage}]`);
  lines.push(`  kickoff: ${match.kickoff_utc ?? 'TBD'}`);
  lines.push(`  lineup_status: ${match.lineup_status ?? 'unknown'}`);
  lines.push('');

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

  const lines = [];
  lines.push(header(packetStage === 'lineup_locked' ? 'LINEUP-LOCKED BOARD' : 'MATCHDAY MORNING BOARD', date));

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
    lines.push(formatMatch(matches[i], boards[i]));
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
  lines.push('END OF PACKET');
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
