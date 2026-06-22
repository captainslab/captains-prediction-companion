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

const CHICAGO_TZ = 'America/Chicago';
const EASTERN_TZ = 'America/New_York';

function safeStage(match) {
  return match?.group ?? match?.stage ?? 'Group stage';
}

function kickoffDisplay(match) {
  if (!match?.kickoff_utc) return 'Kickoff: TBD';
  const d = new Date(match.kickoff_utc);
  if (Number.isNaN(d.getTime())) return 'Kickoff: TBD';
  const ct = new Intl.DateTimeFormat('en-US', {
    timeZone: CHICAGO_TZ,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).format(d);
  const et = new Intl.DateTimeFormat('en-US', {
    timeZone: EASTERN_TZ,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).format(d);
  return `Kickoff: ${ct} / ${et}`;
}

function resultEdgePhrase(board, match) {
  const lane = (board?.lanes || []).find((entry) => entry.lane === 'match_winner');
  if (!lane || lane.recommendation === 'N/A') return 'No clear result edge';
  if (/HOME/.test(lane.recommendation)) return `${match.home_team} result edge`;
  if (/AWAY/.test(lane.recommendation)) return `${match.away_team} result edge`;
  if (/DRAW/.test(lane.recommendation)) return 'Draw edge';
  return 'No clear result edge';
}

function projectionFor(board) {
  const gp = board?.goal_projection;
  return gp && gp.projection_status === 'PROJECTED' ? gp : null;
}

function goalForecastLine(match, board) {
  const gp = projectionFor(board);
  if (!gp) return 'Goal forecast: Model unavailable: missing model layer';
  return `Goal forecast: Projected goals: ${match.home_team} ${gp.projected_home_goals}, ${match.away_team} ${gp.projected_away_goals}`;
}

function totalGoalsForecastLine(board) {
  const gp = projectionFor(board);
  if (!gp) return 'Total goals forecast: Model unavailable: missing model layer';
  return `Total goals forecast: Projected total ${gp.projected_total_goals}`;
}

function bttsForecastLine(board) {
  const gp = projectionFor(board);
  if (!gp) return 'Both-score forecast: Model unavailable: missing model layer';
  const lane = (board?.lanes || []).find((entry) => entry.lane === 'both_teams_to_score');
  return `Both-score forecast: ${pct(lane?.p_btts_yes, 0)}`;
}

function spreadForecastLine(match, board) {
  const gp = projectionFor(board);
  if (!gp) return 'Goal-spread forecast: Model unavailable: missing model layer';
  const margin = gp.projected_goal_margin_home >= 0
    ? `${match.home_team} +${gp.projected_goal_margin_home.toFixed(2)} goals`
    : `${match.away_team} +${Math.abs(gp.projected_goal_margin_home).toFixed(2)} goals`;
  return `Goal-spread forecast: ${margin}; no line available to grade`;
}

function scoreGridCheck(board) {
  const verdict = board?.goal_projection?.cross_check_1x2?.verdict;
  if (verdict === 'CONSISTENT') return 'Score-grid check: models aligned';
  if (verdict === 'MISMATCH') return 'Score-grid check: model disagreement';
  if (verdict) return 'Score-grid check: model check limited';
  return 'Score-grid check: model unavailable';
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
  const gp = projectionFor(board);
  lines.push(`▶ ${match.home_team} vs ${match.away_team}  [${safeStage(match)}]`);
  lines.push(`  ${kickoffDisplay(match)}${match.venue ? ` | ${match.venue}` : ''}`);
  lines.push('  Status: Pre-lock, lineups not confirmed');
  lines.push(`  Model basis: latest prior team composite${provenance?.provisional ? ` from ${provenance.source_date}` : ''}, not today's confirmed XI`);
  lines.push(`  Match forecast: ${resultEdgePhrase(board, match)}`);
  if (gp) {
    lines.push(`  ${goalForecastLine(match, board).replace(/^Goal forecast: /, 'Goal forecast: ')}`);
    lines.push(`  ${totalGoalsForecastLine(board).replace(/^Total goals forecast: /, 'Total goals forecast: ')}`);
    lines.push(`  ${bttsForecastLine(board).replace(/^Both-score forecast: /, 'Both-score forecast: ')}`);
    lines.push(`  ${spreadForecastLine(match, board).replace(/^Goal-spread forecast: /, 'Goal-spread forecast: ')}`);
    lines.push(`  ${scoreGridCheck(board)}`);
  } else {
    lines.push('  Goal forecast: Model unavailable: missing model layer');
    lines.push('  Total goals forecast: Model unavailable: missing model layer');
    lines.push('  Both-score forecast: Model unavailable: missing model layer');
    lines.push('  Goal-spread forecast: Model unavailable: missing model layer');
    lines.push('  Score-grid check: model unavailable');
  }
  lines.push('');
  return lines.join('\n');
}

export function renderWorldCupPacket({ matches, boards, meta = {} }) {
  const date = meta.date ?? new Date().toISOString().slice(0, 10);
  const provenance = meta.composite_provenance ?? null;
  const research = meta.research ?? null;
  const hasMarketContext = (boards || []).some((board) => (board?.lanes || []).some((lane) => lane?.market_context));

  const lines = [];
  lines.push(header('MATCHDAY FORECAST', date));
  if (provenance?.provisional) {
    lines.push(`Model basis: latest prior team composite from ${provenance.source_date}, not today's confirmed XI.`);
    lines.push('Pre-lock forecast: lineups are not confirmed. Model uses the latest available team composite from prior matches until starting XI data is available.\n');
  }

  // 1. Matchday Forecast
  lines.push(section('1. Matchday Forecast'));
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const board = boards[i];
    const projection = projectionFor(board);
    const edge = resultEdgePhrase(board, match);
    if (projection) {
      lines.push(`  • ${match.home_team} vs ${match.away_team}: ${edge}; projected goals ${projection.projected_home_goals}-${projection.projected_away_goals}; projected total ${projection.projected_total_goals}`);
    } else {
      lines.push(`  • ${match.home_team} vs ${match.away_team}: ${edge}; projected goals Model unavailable: missing model layer`);
    }
  }
  lines.push('');

  // 2. Match Breakdowns
  lines.push(section('2. Match Breakdowns'));
  for (let i = 0; i < matches.length; i++) {
    lines.push(formatMatch(matches[i], boards[i], provenance));
  }

  // 3. Market Comparison
  lines.push(section('3. Market Comparison'));
  if (!hasMarketContext) {
    lines.push('  Market comparison: no market lines attached; model output shown as forecast only.');
    lines.push('');
  } else {
    lines.push('  Market comparison: market lines attached; model output shown as forecast only.');
    lines.push('  Market prices are display-only when present and are NOT IN SCORE.\n');
  }

  // 4. Model Limits
  lines.push(section('4. Model Limits'));
  lines.push('  First-half markets are unavailable because no half-split model layer is sourced.');
  lines.push('  Pre-lock forecasts use the latest prior team composite until starting XI data is available.\n');

  // 5. Source Quality
  lines.push(section('5. Source Quality'));
  let totalLayers = 0;
  let presentLayers = 0;
  for (const board of boards) {
    totalLayers += (board.layers_total ?? 14) * 2;
    presentLayers += (board.layers_present_home ?? 0) + (board.layers_present_away ?? 0);
  }
  const researchStatus = research?.status ?? 'PERPLEXITY_UNAVAILABLE';
  lines.push(`  Matches evaluated: ${matches.length}`);
  lines.push(`  Side-layer coverage: ${presentLayers}/${totalLayers}`);
  lines.push('  Pre-lock status: lineups are not confirmed');
  lines.push(`  Model basis: latest prior team composite${provenance?.provisional ? ` from ${provenance.source_date}` : ''}; not today's confirmed XI.`);
  if (researchStatus === 'ok') {
    const summary = research?.source_quality
      ? `confirmed=${research.source_quality.confirmed ?? 0}, not_confirmed=${research.source_quality.not_confirmed ?? 0}, unknown=${research.source_quality.unknown ?? 0}`
      : 'context captured';
    lines.push(`  Perplexity research: live supplemental context captured and saved to ${research?.outPath ?? 'state/worldcup/<date>/research/perplexity_research.json'} (${summary})`);
  } else {
    lines.push(`  Perplexity research: ${researchStatus}; current source mode stayed cached/local.`);
  }
  lines.push('  Market prices are display-only when present and are not used in the model.');
  lines.push('');

  lines.push('─'.repeat(70));
  lines.push('Market prices are display-only when present and are NOT IN SCORE.');
  lines.push('No trades placed. Research only.');
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
