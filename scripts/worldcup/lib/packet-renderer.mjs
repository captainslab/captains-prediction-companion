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

import { buildPacketPreviewBlock } from '../../shared/cpc-preview-adapter.mjs';

const GOALSCORER_LINEUP_STATUS = Object.freeze({
  CONFIRMED_XI: 'CONFIRMED_XI',
  PRE_LOCK_PROJECTED: 'PRE_LOCK_PROJECTED',
  LINEUP_WINDOW: 'LINEUP_WINDOW',
  LINEUP_SENSITIVE: 'LINEUP_SENSITIVE',
  UNAVAILABLE: 'UNAVAILABLE',
});

const GOALSCORER_PROJECTION_STATUS = Object.freeze({
  READY: 'READY',
  PROVISIONAL_PRE_LOCK: 'PROVISIONAL_PRE_LOCK',
});

function projectAnytimeGoalscorers({ projected_team_goals = 0, player_candidates = [], lineup_status = GOALSCORER_LINEUP_STATUS.PRE_LOCK_PROJECTED } = {}) {
  const candidates = Array.isArray(player_candidates) ? player_candidates.filter(Boolean) : [];
  if (!candidates.length) {
    return {
      lineup_status,
      projection_status: GOALSCORER_PROJECTION_STATUS.PROVISIONAL_PRE_LOCK,
      players: [],
      projected_team_goals,
    };
  }

  const weights = candidates.map((candidate) => {
    const base = Number(candidate?.xg_per_90 ?? 0.15) || 0.15;
    const penaltyBoost = Number(candidate?.penalty_role ?? 0) > 0 ? 0.2 : 0;
    const setPieceBoost = Number(candidate?.set_piece_role ?? 0) > 0 ? 0.1 : 0;
    const startBoost = Number(candidate?.start_probability ?? 0) || 0;
    return Math.max(0.05, base + penaltyBoost + setPieceBoost + (startBoost * 0.1));
  });
  const weightTotal = weights.reduce((sum, value) => sum + value, 0) || candidates.length;
  const ready = lineup_status === GOALSCORER_LINEUP_STATUS.CONFIRMED_XI;
  const projection_status = ready
    ? GOALSCORER_PROJECTION_STATUS.READY
    : GOALSCORER_PROJECTION_STATUS.PROVISIONAL_PRE_LOCK;

  return {
    lineup_status,
    projection_status,
    projected_team_goals,
    players: candidates.map((candidate, index) => {
      const share = weights[index] / weightTotal;
      const projected_player_goals = Number((projected_team_goals * share).toFixed(2));
      return {
        player_id: candidate?.player_id ?? null,
        player_name: candidate?.player_name ?? candidate?.name ?? null,
        team_side: candidate?.team_side ?? null,
        lineup_status,
        projected_player_goals,
        projection_status,
        note: ready ? 'ready' : 'pre-lock',
      };
    }),
  };
}

const CHICAGO_TZ = 'America/Chicago';
const EASTERN_TZ = 'America/New_York';
const STAGE_LABELS = Object.freeze({
  group: 'Group stage',
  round_of_32: 'Round of 32',
  round_of_16: 'Round of 16',
  quarter_final: 'Quarterfinal',
  semi_final: 'Semifinal',
  third_place: 'Third-place match',
  final: 'Final',
});
const ROUND_STAGE_LABELS = Object.freeze({
  3: STAGE_LABELS.round_of_32,
  4: STAGE_LABELS.round_of_16,
  5: STAGE_LABELS.quarter_final,
  6: STAGE_LABELS.semi_final,
  7: STAGE_LABELS.third_place,
  8: STAGE_LABELS.final,
});

// --- Source-backed preview integration ---------------------------------------
// Resolve a Kalshi World Cup event ticker (KXWCGAME-<YYMONDD><HOME3><AWAY3>)
// from the match's Chicago-local kickoff date + team names, then look up the
// banked, sanitized research artifact for a customer-safe preview block. Price /
// market fields never enter this path — the sanitizer + adapter strip and guard
// them, and the model summary below carries model-side projection language only.

const MONTHS_3 = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// FIFA 3-letter codes for nations whose code is NOT the first three letters.
// Anything not listed falls back to first-three-uppercase (Norway→NOR, etc.).
const FIFA_CODE_OVERRIDES = {
  'South Africa': 'RSA',
  'South Korea': 'KOR',
  'Korea Republic': 'KOR',
  'Saudi Arabia': 'KSA',
  'United States': 'USA',
  'Netherlands': 'NED',
  'Switzerland': 'SUI',
  'Ivory Coast': 'CIV',
  'Costa Rica': 'CRC',
  'New Zealand': 'NZL',
  'Cape Verde': 'CPV',
};

function teamCode(name) {
  const clean = String(name ?? '').trim();
  if (FIFA_CODE_OVERRIDES[clean]) return FIFA_CODE_OVERRIDES[clean];
  return clean.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'UNK';
}

function chicagoYmd(value, fallbackDate) {
  const d = value ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) {
    const [y, m, day] = String(fallbackDate ?? '').split('-');
    return { y, m, d: day };
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: CHICAGO_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return { y: get('year'), m: get('month'), d: get('day') };
}

function worldCupEventTicker(match, packetDate) {
  const { y, m, d } = chicagoYmd(match?.kickoff_utc, packetDate);
  if (!y || !m || !d) return null;
  const mon = MONTHS_3[parseInt(m, 10) - 1];
  if (!mon) return null;
  return `KXWCGAME-${y.slice(2)}${mon}${d}${teamCode(match?.home_team)}${teamCode(match?.away_team)}`;
}

function advanceLane(board) {
  return board?.advances
    ?? (board?.lanes || []).find((entry) => entry.lane === 'team_to_advance')?.advances
    ?? null;
}

function marketContextDisplayLine(mc) {
  if (!mc) return null;
  const settle = mc.settlement ? `${mc.settlement.scope}${mc.settlement.explicit ? '' : ' (default)'}` : 'n/a';
  const parts = [
    `${mc.normalized_target ?? mc.ticker ?? 'N/A'}`,
    mc.side ? `side:${mc.side}` : null,
    mc.implied_probability != null ? `imp:${(mc.implied_probability * 100).toFixed(1)}%` : null,
    `settles:${settle}`,
  ].filter(Boolean);
  return `MARKET CONTEXT — DISPLAY ONLY / NOT IN SCORE: ${parts.join(' | ')}`;
}

function advanceDisplayLine(board, match) {
  const adv = advanceLane(board);
  if (!adv) return null;
  const tName = adv.team_name ?? match?.home_team ?? 'team';
  const oName = adv.opponent_name ?? match?.away_team ?? 'opponent';
  if (adv.status !== 'READY') {
    const friendly = (adv.missing_inputs ?? []).map((code) => {
      if (code === 'eloTeam') return `published Elo baseline for ${tName}`;
      if (code === 'eloOpp') return `published Elo baseline for ${oName}`;
      if (code === 'bracket') return 'bracket / next-round context';
      return code;
    });
    const miss = friendly.length ? ` | missing: ${friendly.join('; ')}` : '';
    return `Advances model ${adv.status} — settles on advancing (incl. extra time + penalties)${miss}`;
  }
  const teamName = tName;
  const oppName = oName;
  const lean = adv.lean === 'TEAM_ADVANCES' ? `${teamName} advances`
    : adv.lean === 'OPPONENT_ADVANCES' ? `${oppName} advances`
      : 'advances lean unavailable';
  const reg = `reg ${pct(adv.reg?.pWin)} / draw ${pct(adv.reg?.pDraw)} / loss ${pct(adv.reg?.pLoss)}`;
  const et = `ET ${pct(adv.et?.etWin)} / draw ${pct(adv.et?.etDraw)} / loss ${pct(adv.et?.etLoss)}`;
  const pen = `pen ${pct(adv.pen?.penWin)}`;
  const limitations = Array.isArray(adv.limitations) && adv.limitations.length
    ? ` | limitations: ${adv.limitations.join('; ')}`
    : '';
  return `${teamName} to advance ${(adv.p_advance * 100).toFixed(0)}% vs ${oppName}; includes extra time and penalties; model_mode ${adv.model_mode}; Poisson path ${reg}; ${et}; ${pen}${limitations}`;
}

// Market-neutral model summary for the preview's model-read fields. Only
// model-side (price-free) projection language is passed; never odds/price.
export function worldCupModelSummary(match, board) {
  const gp = projectionFor(board);
  const summary = {
    result_edge: resultEdgePhrase(board, match),
    advances: advanceDisplayLine(board, match),
  };
  if (gp) {
    summary.projection = `${match.home_team} ${gp.projected_home_goals}-${gp.projected_away_goals} ${match.away_team}`;
    summary.total_environment = totalProfile(gp.projected_total_goals);
  }
  summary.caveat = 'Pre-lineup; team baseline only, not official starting lineup.';
  const marketContext = advanceLane(board)?.market_context ?? null;
  if (marketContext) summary.display_only_market_line = marketContextDisplayLine(marketContext);
  return summary;
}

// Build the indented "Source-backed preview" sub-block for one match, or null
// when no banked artifact exists (the existing model forecast lines stand on
// their own — we never invent a source-backed block without a source).
function matchPreviewLines(match, board, packetDate, researchRoot) {
  const eventTicker = worldCupEventTicker(match, packetDate);
  if (!eventTicker) return null;
  let block;
  try {
    block = buildPacketPreviewBlock({
      date: packetDate,
      packet_family: 'sports',
      packet_type: 'worldcup-match',
      route: 'worldcup_match',
      submarket: 'match_preview',
      event_id: eventTicker,
      model: worldCupModelSummary(match, board),
      root: researchRoot,
    });
  } catch {
    return null;
  }
  if (!block || !block.artifact_found || !block.text) return null;
  const lines = ['', '  Source-backed preview:'];
  for (const line of String(block.text).split('\n')) {
    lines.push(line ? `    ${line}` : '');
  }
  return lines;
}

function generatedDisplay(d = new Date()) {
  const ct = new Intl.DateTimeFormat('en-US', {
    timeZone: CHICAGO_TZ,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
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
  return `${ct} / ${et}`;
}

function header(title, date) {
  return [
    `=== Captain World Cup — CPC Packet: ${title} ===`,
    `date: ${date}`,
    `packet_type: worldcup-matchday`,
    `Generated: ${generatedDisplay()}`,
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

function normalizedGroupLabel(group) {
  const text = String(group ?? '').trim();
  if (!text) return null;
  if (/^group\s+/i.test(text)) return text.replace(/\s+/g, ' ');
  if (/^[A-L]$/i.test(text)) return `Group ${text.toUpperCase()}`;
  return text.replace(/\s+/g, ' ');
}

function stageLabel(stage) {
  const key = String(stage ?? '').trim().toLowerCase();
  return STAGE_LABELS[key] ?? null;
}

function stageLabelFromRound(round) {
  const numeric = Number(round);
  return ROUND_STAGE_LABELS[numeric] ?? null;
}

function isKnockoutStage(stage) {
  const key = String(stage ?? '').trim().toLowerCase();
  return Boolean(key && key !== 'group');
}

function inferStageFromText(text) {
  const value = String(text ?? '');
  if (!value) return null;
  if (/Round of 32/i.test(value)) return STAGE_LABELS.round_of_32;
  if (/Round of 16/i.test(value)) return STAGE_LABELS.round_of_16;
  if (/Quarter(?:final)?/i.test(value)) return STAGE_LABELS.quarter_final;
  if (/Semi(?:final)?/i.test(value)) return STAGE_LABELS.semi_final;
  if (/Third(?:-place|\s+place)|3rd/i.test(value)) return STAGE_LABELS.third_place;
  if (/(?:\bWorld Cup\b.*\bFinal\b|\bFinal\b)/i.test(value) && !/Quarter|Semi|Third|3rd/i.test(value)) return STAGE_LABELS.final;
  return null;
}

function safeStage(match) {
  const stage = stageLabel(match?.stage);
  const round = stageLabelFromRound(match?.round);
  const group = normalizedGroupLabel(match?.group);
  const sourcedStage = inferStageFromText(match?.live_context?.summary ?? match?.preview_context?.summary);
  if (isKnockoutStage(match?.stage) && stage) return stage;
  if (group) return group;
  if (stage) return stage;
  if (round) return round;
  if (sourcedStage) return sourcedStage;
  return 'Stage unavailable';
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
  if (!lane || lane.recommendation === 'N/A') return 'No clear side';
  if (/HOME/.test(lane.recommendation)) return `${match.home_team} rates higher`;
  if (/AWAY/.test(lane.recommendation)) return `${match.away_team} rates higher`;
  if (/DRAW/.test(lane.recommendation)) return 'Draw rates higher';
  return 'No clear side';
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
  return `Goal-spread forecast: ${margin}; projected goal difference only; no market line attached`;
}

function scoreGridCheck(board) {
  const verdict = board?.goal_projection?.cross_check_1x2?.verdict;
  if (verdict === 'CONSISTENT') return 'Score-grid check: models aligned';
  if (verdict === 'MISMATCH') return 'Score-grid check: model disagreement';
  if (verdict) return 'Score-grid check: model check limited';
  return 'Score-grid check: model unavailable';
}

// --- Customer-facing translation of internal model enums ---------------------
// Internal enum names (PICK / LEAN / WATCH / FADE, CONSISTENT / MISMATCH, ...) are
// kept on the board objects for compatibility but are NEVER rendered raw. The
// customer reads soccer / handicapping language only; the raw enums live in the
// audit JSON. Price/market fields still never touch any model value here.

const DISPLAY_LABELS = {
  match_winner: 'Match Result',
  spread_full_game: 'Goal Spread',
  total_goals: 'Total Goals',
  both_teams_to_score: 'BTTS',
  team_to_advance: 'Team to Advance',
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

function fmtPct(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'N/A';
  return `${(value * 100).toFixed(digits)}%`;
}

function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function displayPair(date) {
  const ct = new Intl.DateTimeFormat('en-US', {
    timeZone: CHICAGO_TZ,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).format(date);
  const et = new Intl.DateTimeFormat('en-US', {
    timeZone: EASTERN_TZ,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).format(date);
  return `${ct} / ${et}`;
}

function isLineupVerified(match) {
  return match?.lineup_locked_verified === true;
}

function isLineupLocked(match) {
  return isLineupVerified(match);
}

function isForecastHeld(match) {
  return match?.lineup_status === 'lineup_confirmed' && match?.model_consumes_lineup !== true;
}

function currentBaselineSummary(provenance) {
  if (provenance?.provisional) {
    return `prior baseline from ${provenance.source_date ?? 'unknown date'} retained for diagnostics only`;
  }
  if (provenance?.source_date) {
    return `same-date team baseline from ${provenance.source_date}`;
  }
  return 'same-date team baseline';
}

function isGoalkeeperPosition(position) {
  return /goalkeeper|keeper|gk/.test(String(position ?? '').trim().toLowerCase());
}

function lineupsStatusText(match) {
  return isLineupVerified(match)
    ? 'official starting lineup verified'
    : 'official starting lineup not verified';
}

function lineupSourceText(md) {
  if (!md?.source?.provider) return null;
  const ev = md.source.event_id ? ` (event ${md.source.event_id})` : '';
  return `${md.source.provider.toUpperCase()} ${md.source.league ?? ''}`.trim().replace(/\s+/g, ' ') + ev;
}

function compactText(value, max = 180) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return 'summary unavailable';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
}

function liveContextCoverage(match) {
  const ctx = match?.live_context ?? null;
  const coverage = (status, reason) => `    live context: ${status} — ${reason}`;
  if (!ctx || ctx.status !== 'gathered') {
    return coverage('unavailable', compactText(ctx?.reason ?? 'no live context attached to this match', 160));
  }

  const provenance = [];
  if (ctx.source_label) provenance.push(ctx.source_label);
  if (ctx.matched_by) provenance.push(`matched by ${ctx.matched_by}`);
  if (ctx.match_id) provenance.push(`match_id ${ctx.match_id}`);
  if (ctx.event_id) provenance.push(`event ${ctx.event_id}`);
  if (ctx.source_quality) provenance.push(`source quality ${ctx.source_quality}`);
  const summary = compactText(ctx.summary ?? ctx.note ?? ctx.reason ?? 'summary unavailable');
  return coverage('gathered', `${provenance.join(', ')}${provenance.length ? '; ' : ''}summary: ${summary}`);
}

function countLiveContextMatches(matches = []) {
  return (matches || []).filter((match) => match?.live_context?.status === 'gathered').length;
}

function lineupCoverage(match, board) {
  const md = match?.matchday;
  const source = md?.source ?? null;
  const verified = isLineupVerified(match);
  const result = [];
  const sourceText = source ? lineupSourceText(md) : null;
  const fetched = md?.fetched_utc ?? match?.lineup_freshness?.fetched_utc ?? null;
  const freshnessReason = match?.lineup_freshness?.reason ?? 'not verified';
  const freshnessState = match?.lineup_freshness?.source_event_state ?? source?.event_state ?? null;
  const freshnessId = match?.lineup_freshness?.source_event_id ?? source?.event_id ?? null;
  const lineup = [];
  for (const side of ['home', 'away']) {
    const startingXi = md?.[side]?.lineup?.starting_xi;
    if (Array.isArray(startingXi)) lineup.push(...startingXi);
  }
  const positionsKnown = lineup.length > 0 && lineup.every((player) => String(player?.position ?? '').trim().length > 0);
  const hasGoalScoringPriors = lineup.some((player) => candidateHasRealPrior(player));
  const hasMarketLines = Boolean(board?.lanes?.some((lane) => lane?.market_context) || match?.board_has_market_lines);
  const coverage = (label, status, reason) => `    ${label}: ${status} — ${reason}`;
  result.push(coverage(
    'official starting lineup',
    verified ? 'gathered' : 'unavailable',
    verified
      ? `${sourceText ?? 'official source not attached'}${fetched ? `, fetched ${fetched}` : ''}`
      : `${freshnessReason}${freshnessState ? ` (event_state=${freshnessState})` : ''}${freshnessId ? ` (event ${freshnessId})` : ''}`,
  ));
  result.push(coverage(
    'player positions/roles',
    verified && positionsKnown ? 'gathered' : 'unavailable',
    verified && positionsKnown
      ? `${lineup.length} starters with positions`
      : verified
        ? 'starter positions missing from lineup artifact'
        : 'official starting lineup not verified',
  ));
  result.push(coverage(
    'player scoring priors',
    verified && hasGoalScoringPriors ? 'gathered' : verified ? 'blocked' : 'unavailable',
    verified
      ? (hasGoalScoringPriors
        ? `${lineup.filter((player) => candidateHasRealPrior(player)).length} starting players carry xG or role priors`
        : 'player-level scoring priors unavailable')
      : 'official starting lineup not verified',
  ));
  result.push(coverage(
    'team baseline composite',
    'gathered',
    verified ? 'baseline composite only; lineup-adjusted model not applied' : 'baseline composite only; lineup-adjusted model not applied (pre-lineup)',
  ));
  result.push(coverage(
    'lineup-adjusted team model',
    verified ? 'blocked' : 'unavailable',
    verified
      ? `LINEUP_ADJUSTED_MODEL_MISSING; ${match?.lineup_adjustment?.reason ?? 'matchday artifact lacks player_ratings, key_absence_flags, and expected_starters'}`
      : 'official starting lineup not verified',
  ));
  result.push(coverage(
    'market lines',
    hasMarketLines ? 'gathered' : 'unavailable',
    hasMarketLines ? 'display-only and not used in scoring' : 'no market lines sourced for this match',
  ));
  result.push(coverage('advancement/standings', 'unavailable', 'standings feed not sourced'));
  result.push(liveContextCoverage(match));
  return result.join('\n');
}

function lineupLockDisplay(match) {
  if (!match?.kickoff_utc) return 'Kickoff: TBD';
  const d = new Date(match.kickoff_utc);
  if (Number.isNaN(d.getTime())) return 'Kickoff: TBD';
  return displayPair(new Date(d.getTime() - (50 * 60 * 1000)));
}

function starterMinutesForPosition(position) {
  const p = String(position ?? '').toLowerCase();
  if (/goalkeeper|keeper|gk/.test(p)) return 90;
  if (/(defender|centre back|center back|cb|lb|rb|lwb|rwb|fullback|full-back|wingback|wing-back)/.test(p)) return 82;
  if (/(midfielder|cm|dm|am|lm|rm|cam|holding midfielder|attacking midfielder|central midfielder)/.test(p)) return 78;
  if (/(forward|striker|centre forward|center forward|cf|fw|winger|wide forward|inside forward)/.test(p)) return 74;
  return 76;
}

function candidateHasRealPrior(candidate) {
  return (candidate?.xg_per_90 !== null && candidate?.xg_per_90 !== undefined)
    || (candidate?.penalty_role ?? 0) > 0
    || (candidate?.set_piece_role ?? 0) > 0;
}

// Customer-facing label for an internal goalscorer lineup-status enum so the
// rendered packet never leaks raw tokens like CONFIRMED_XI / PRE_LOCK_PROJECTED.
function lineupStatusLabel(status) {
  switch (String(status ?? '').trim().toUpperCase()) {
    case 'CONFIRMED_XI': return 'official starting lineup';
    case 'PRE_LOCK_PROJECTED': return 'pre-lineup projection';
    case 'LINEUP_WINDOW': return 'lineup window';
    case 'LINEUP_SENSITIVE': return 'lineup-sensitive';
    case 'UNAVAILABLE': return 'unavailable';
    default: return String(status ?? '').trim().toLowerCase().replace(/_/g, ' ') || 'unavailable';
  }
}

function candidatePoolForSide(match, side) {
  const md = match?.matchday?.[side];
  const team = md?.lineup?.team_name ?? md?.team ?? (side === 'home' ? match?.home_team : match?.away_team) ?? null;
  const lineupConfirmed = isLineupLocked(match);
  const lineup = Array.isArray(md?.lineup?.starting_xi) ? md.lineup.starting_xi : [];
  const squadPlayers = Array.isArray(md?.squad?.players) ? md.squad.players : [];
  const sourcePlayers = lineupConfirmed && lineup.length ? lineup : squadPlayers;

  return {
    team,
    lineup_status: lineupConfirmed
      ? GOALSCORER_LINEUP_STATUS.CONFIRMED_XI
      : GOALSCORER_LINEUP_STATUS.PRE_LOCK_PROJECTED,
    players: sourcePlayers.map((player, index) => {
      const name = player?.name ?? player?.fullName ?? player?.player_name ?? null;
      const position = player?.position ?? player?.role ?? null;
      if (isGoalkeeperPosition(position)) return null;
      return {
        player_id: player?.player_id ?? `${match?.match_id ?? 'match'}:${side}:${slugify(name ?? `player-${index}`)}:${index}`,
        player_name: name,
        team_side: side,
        position,
        lineup_status: lineupConfirmed
          ? GOALSCORER_LINEUP_STATUS.CONFIRMED_XI
          : GOALSCORER_LINEUP_STATUS.PRE_LOCK_PROJECTED,
        start_probability: lineupConfirmed ? 0.85 : undefined,
        expected_minutes: lineupConfirmed ? starterMinutesForPosition(player?.position ?? player?.role ?? null) : undefined,
        penalty_role: player?.penalty_role ?? null,
        set_piece_role: player?.set_piece_role ?? null,
        xg_per_90: player?.xg_per_90 ?? null,
      };
    }).filter((player) => player && player.player_name),
  };
}

function projectGoalscorerSide(match, board, side) {
  const goalProjection = board?.goal_projection;
  if (!goalProjection || goalProjection.projection_status !== 'PROJECTED') {
    return {
      team: side === 'home' ? match?.home_team : match?.away_team,
      side,
      blocked: 'team projected goals unavailable',
      projection: null,
      players: [],
      playerPoolSize: 0,
    };
  }

  const teamProjectedGoals = side === 'home'
    ? goalProjection.projected_home_goals
    : goalProjection.projected_away_goals;
  const pool = candidatePoolForSide(match, side);
  if (pool.lineup_status === GOALSCORER_LINEUP_STATUS.CONFIRMED_XI
    && pool.players.length
    && !pool.players.some(candidateHasRealPrior)) {
    return {
      team: pool.team,
      side,
      blocked: 'player-level scoring priors unavailable',
      projection: null,
      players: [],
      playerPoolSize: pool.players.length,
      teamProjectedGoals,
      lineup_status: pool.lineup_status,
    };
  }
  if (!pool.players.length) {
    return {
      team: pool.team,
      side,
      blocked: 'player candidate pool unavailable',
      projection: null,
      players: [],
      playerPoolSize: 0,
      teamProjectedGoals,
      lineup_status: pool.lineup_status,
    };
  }

  const projection = projectAnytimeGoalscorers({
    match,
    team_side: side,
    projected_team_goals: teamProjectedGoals,
    player_candidates: pool.players,
    lineup_status: pool.lineup_status,
  });

  const players = (projection.players || [])
    .slice()
    .sort((a, b) => (b.projected_player_goals ?? -1) - (a.projected_player_goals ?? -1))
    .slice(0, 3);

  return {
    team: pool.team,
    side,
    blocked: null,
    projection,
    players,
    playerPoolSize: pool.players.length,
    teamProjectedGoals,
    lineup_status: pool.lineup_status,
  };
}

function summarizeGoalscorerStatus(sidecar) {
  if (!sidecar?.length) return 'BLOCKED_PLAYER_DATA_MISSING';
  if (sidecar.some((entry) => entry.blocked === 'team projected goals unavailable')) return 'BLOCKED_TEAM_GOALS_MISSING';
  if (sidecar.some((entry) => entry.blocked === 'player-level scoring priors unavailable')) {
    return 'blocked — player-level scoring priors unavailable';
  }
  if (sidecar.some((entry) => entry.blocked === 'player candidate pool unavailable')) return 'BLOCKED_PLAYER_DATA_MISSING';
  if (sidecar.some((entry) => (entry.players || []).some((player) => player.projection_status === GOALSCORER_PROJECTION_STATUS.READY))) {
    return 'READY for official starting lineup players';
  }
  if (sidecar.some((entry) => (entry.players || []).some((player) => player.projection_status === GOALSCORER_PROJECTION_STATUS.PROVISIONAL_PRE_LOCK))) {
    return 'PROVISIONAL_PRE_LOCK';
  }
  return 'LINEUP_SENSITIVE';
}

function whyItMattersBlock(matches = [], boards = []) {
  const lines = [];
  lines.push(section('Why it matters'));
  if (!matches.length) {
    lines.push('  No matches loaded for this date.');
    lines.push('');
    return lines.join('\n');
  }

  if (matches.length === 1) {
    const match = matches[0];
    const board = boards[0];
    const goalProjection = board?.goal_projection;
    const sidecar = ['home', 'away'].map((side) => projectGoalscorerSide(match, board, side));
    const timingState = isLineupVerified(match) ? 'official starting lineup verified' : 'lineup-sensitive';
    lines.push(`  Match context: ${match.home_team} vs ${match.away_team} [${safeStage(match)}] — ${kickoffDisplay(match)}${match.venue ? ` | ${match.venue}` : ''}`);
    lines.push(`  Model lanes that matter: result, total goals, BTTS, goal spread, and anytime goalscorer.`);
    lines.push(`  Lineup status: ${timingState}.`);
    lines.push(`  Goalscorer status: ${summarizeGoalscorerStatus(sidecar)}.`);
    const missingOrBlocked = [...new Set(sidecar.map((entry) => entry.blocked || 'player candidates available'))];
    lines.push(`  Missing or blocked: ${missingOrBlocked.join('; ')}.`);
    lines.push('  Price context: display-only and not used in scoring.');
    if (goalProjection?.projection_status === 'PROJECTED') {
      lines.push(`  Goal environment: projected ${goalProjection.projected_home_goals}-${goalProjection.projected_away_goals} goals.`);
    } else {
      lines.push(`  Goal environment: ${goalProjection?.reason ?? 'team goals unavailable'}.`);
    }
    lines.push('');
    return lines.join('\n');
  }

  const games = matches
    .filter((m) => m?.home_team && m?.away_team)
    .map((m) => `${m.home_team} vs ${m.away_team} (${kickoffDisplay(m)})`)
    .join('; ');
  const timingSensitive = matches
    .filter((m) => !isLineupLocked(m))
    .map((m) => `${m.home_team} vs ${m.away_team}`)
    .join('; ') || 'all matches with kickoff times';
  const lineupPackets = matches
    .filter((m) => m.kickoff_utc)
    .map((m) => `${m.home_team} vs ${m.away_team} at ${lineupLockDisplay(m)}`)
    .join('; ');
  lines.push(`  Today's games: ${games}.`);
  lines.push(`  Timing-sensitive matches: ${timingSensitive}.`);
  lines.push('  Pre-lock / lineup-sensitive lanes: result, total goals, BTTS, goal spread, and anytime goalscorer.');
  lines.push('  Watch lineup-lock windows: each match is scheduled 50 minutes before kickoff.');
  lines.push(`  Individual lineup-lock packets: ${lineupPackets}.`);
  lines.push('  Goalscorer outputs stay provisional until an official starting lineup is verified.');
  lines.push('');
  return lines.join('\n');
}

function renderGoalscorerBlock(match, board) {
  const sidecar = ['home', 'away'].map((side) => projectGoalscorerSide(match, board, side));
  const lines = [];
  lines.push('  Anytime Goalscorer Model — PRICE FREE (display-only and not used in scoring)');
  if (sidecar.every((entry) => entry.blocked === 'team projected goals unavailable')) {
    lines.push('    BLOCKED_TEAM_GOALS_MISSING — team projected goals unavailable.');
    lines.push('');
    return lines.join('\n');
  }
  if (sidecar.every((entry) => entry.blocked === 'player-level scoring priors unavailable')) {
    lines.push('    Goalscorer status: blocked — player-level scoring priors unavailable.');
    lines.push('');
    return lines.join('\n');
  }

  for (const entry of sidecar) {
    const team = entry.team ?? (entry.side === 'home' ? match.home_team : match.away_team);
    const sideLabel = entry.side === 'home' ? 'home' : 'away';
    const goalBudget = entry.teamProjectedGoals == null ? 'MISSING' : entry.teamProjectedGoals.toFixed(2);
    const status = entry.projection?.lineup_status ?? (entry.blocked ? 'UNAVAILABLE' : 'LINEUP_SENSITIVE');
    lines.push(`    ${team} (${sideLabel}) | team goals ${goalBudget} | lineup ${lineupStatusLabel(status)}`);

    if (entry.blocked === 'player candidate pool unavailable') {
      lines.push('      BLOCKED_PLAYER_DATA_MISSING — player candidate pool unavailable.');
      continue;
    }
    if (entry.blocked === 'player-level scoring priors unavailable') {
      lines.push('      Goalscorer status: blocked — player-level scoring priors unavailable.');
      continue;
    }

    const players = entry.players || [];
    if (!players.length) {
      lines.push('      BLOCKED_PLAYER_DATA_MISSING — player candidate pool unavailable.');
      continue;
    }

    for (const player of players) {
      lines.push(
        `      - ${player.player_name} | ${player.team_side} | ${player.projection_status} | mins ${player.expected_minutes ?? 'N/A'} | start ${fmtPct(player.start_probability, 0)} | goals ${player.projected_player_goals == null ? 'MISSING' : player.projected_player_goals.toFixed(2)} | P(anytime) ${fmtPct(player.anytime_goal_probability, 1)} | ${player.reason}`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
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
  if (lane.lane === 'team_to_advance') {
    const adv = lane.advances ?? null;
    if (!adv || adv.status !== 'READY') {
      return adv?.status === 'RESEARCH_ONLY' ? 'advances research only' : adv?.status === 'BLOCKED' ? 'advances blocked' : 'no clear advance side';
    }
    if (adv.lean === 'TEAM_ADVANCES') return `${adv.team_name} to advance`;
    if (adv.lean === 'OPPONENT_ADVANCES') return `${adv.opponent_name} to advance`;
    return 'no clear advance side';
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
      lines.push('    Total view: projected goal difference only; no market line attached');
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
  } else if (lane.lane === 'team_to_advance' && lane.advances) {
    const adv = lane.advances;
    lines.push(`  [${label}] ${adv.status === 'READY' ? `${adv.team_name} advances read` : `Advances model ${adv.status}`}`);
    lines.push('    Settlement: advances market includes extra time and penalties; not regulation-only.');
    lines.push(`    Model mode: ${adv.model_mode}`);
    if (adv.status === 'READY') {
      lines.push(`    Poisson path: regulation ${pct(adv.reg?.pWin)} / draw ${pct(adv.reg?.pDraw)} / loss ${pct(adv.reg?.pLoss)}.`);
      lines.push(`    Extra time: ${pct(adv.et?.etWin)} / draw ${pct(adv.et?.etDraw)} / loss ${pct(adv.et?.etLoss)}.`);
      lines.push(`    Penalties: ${pct(adv.pen?.penWin)}.`);
      lines.push(`    Advance probability: ${pct(adv.p_advance)} (${adv.lean === 'TEAM_ADVANCES' ? 'team advances' : 'opponent advances'}).`);
    } else {
      lines.push(`    Missing inputs: ${adv.missing_inputs?.length ? adv.missing_inputs.join(', ') : 'n/a'}`);
      if (Array.isArray(adv.limitations) && adv.limitations.length) {
        lines.push(`    Limitations: ${adv.limitations.join('; ')}`);
      }
    }
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
      lines.push('    Spread view: projected goal difference only; no market line attached');
      lines.push(`    Profile: ${m === 0 ? 'even matchup' : 'favorite advantage'}, not enough line context for a cover call`);
    }
    lines.push(confidenceLine(lane.confidence, provisional));
  } else {
    lines.push(`  [${label}] ${modelStatePhrase(lane.recommendation)} | confidence:${lane.confidence}`);
  }

  // Market half — display only, always labeled NOT IN SCORE.
  if (lane.market_context) {
    const mc = lane.market_context;
    const gaps = [
      lane.edge_home_pp != null ? `H:${lane.edge_home_pp}pp` : null,
      lane.edge_draw_pp != null ? `D:${lane.edge_draw_pp}pp` : null,
      lane.edge_away_pp != null ? `A:${lane.edge_away_pp}pp` : null,
    ].filter(Boolean).join(' ') || 'n/a (no model fair probability)';
    lines.push(`    MARKET CONTEXT — DISPLAY ONLY / NOT IN SCORE: ${mc.normalized_target ?? mc.ticker ?? 'N/A'} | imp:${mc.implied_probability != null ? (mc.implied_probability * 100).toFixed(1) + '%' : 'N/A'} | settles:${mc.settlement ? `${mc.settlement.scope}${mc.settlement.explicit ? '' : ' (default)'}` : 'n/a'} | model−market gap ${gaps}`);
  } else {
    lines.push('    MARKET CONTEXT — DISPLAY ONLY / NOT IN SCORE: no market context attached');
  }
  lines.push('');
  return lines.join('\n');
}

// Favored side label for a match, derived from model output only (price-free).
function favoredTeam(board, match) {
  const phrase = resultEdgePhrase(board, match);
  if (phrase === `${match.home_team} rates higher`) return match.home_team;
  if (phrase === `${match.away_team} rates higher`) return match.away_team;
  if (phrase === 'Draw rates higher') return 'even (draw rates higher)';
  return 'no clear edge';
}

function slateStatusLabel(match) {
  return isLineupLocked(match)
    ? 'LINEUP LOCKED (official XIs)'
    : 'scheduled — lineups not yet announced';
}

// Unnumbered daily slate preview. Pure model/structure data; no advancement
// math is invented, no market/price content is referenced.
function slatePreviewBlock(matches = [], boards = []) {
  const lines = [];
  lines.push(section('Daily Slate Preview — Why Today Matters'));
  lines.push("  Today's matches:");
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    lines.push(`   • ${m.home_team} vs ${m.away_team} [${safeStage(m)}] — ${kickoffDisplay(m).replace(/^Kickoff: /, '')} — ${slateStatusLabel(m)}`);
    const adv = isKnockoutStage(m?.stage) ? advanceDisplayLine(boards[i], m) : null;
    if (adv) {
      lines.push(`     Advances: ${adv}`);
    }
  }
  // Group rollup.
  const groups = new Map();
  for (const m of matches) {
    const g = safeStage(m);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(`${m.home_team} vs ${m.away_team}`);
  }
  lines.push('');
  for (const [g, fixtures] of groups) {
    lines.push(`  ${g} today: ${fixtures.join('; ')}.`);
  }
  // Model-projected favorites (forecast only).
  const favs = matches.map((m, i) => favoredTeam(boards[i], m)).filter((f) => f && f !== 'no clear edge');
  if (favs.length) {
    lines.push(`  Model-rated side (forecast only): ${favs.join(', ')}.`);
  }
  const advanceReads = matches.map((m, i) => isKnockoutStage(m?.stage) ? advanceDisplayLine(boards[i], m) : null).filter(Boolean);
  if (advanceReads.length) {
    lines.push(`  Advances read: ${advanceReads.join(' | ')}.`);
  }
  const lockedNames = matches.filter((m) => isLineupLocked(m)).map((m) => `${m.home_team} vs ${m.away_team}`);
  lines.push('  Advancement / standings math: not sourced — omitted rather than invented.');
  if (lockedNames.length) {
    if (lockedNames.length === matches.length) {
      lines.push('  Lineup/source: official starting XIs confirmed for all matches; a customer-ready packet still requires a lineup-adjusted model path.');
    } else {
      lines.push(`  Lineup/source: official starting XIs confirmed for ${lockedNames.join(', ')}; remaining matches are still pre-lineup.`);
    }
  } else {
    lines.push('  Lineup/source: no official starting XIs confirmed yet; pre-lock output depends on the same-date team baseline only.');
  }
  lines.push('');
  return lines.join('\n');
}

// Confirmed starting-XI lines for the lineup-locked match block. Reads only
// name/position/number/formation and the source label — never price fields.
function lineupLockedLines(match) {
  const md = match?.matchday;
  if (!md) return [];
  const out = [];
  for (const side of ['home', 'away']) {
    const lu = md[side]?.lineup;
    if (!lu || !Array.isArray(lu.starting_xi) || !lu.starting_xi.length) continue;
    const team = lu.team_name ?? md[side]?.team ?? (side === 'home' ? match.home_team : match.away_team);
    const xi = lu.starting_xi
      .map((p) => `${p.number ?? '-'} ${p.name ?? '?'}`)
      .join(', ');
    out.push(`  Official starting lineup — ${team}${lu.formation ? ` (${lu.formation})` : ''}: ${xi}`);
  }
  if (md.source?.provider) {
    const ev = md.source.event_id ? ` (event ${md.source.event_id})` : '';
    const label = `${md.source.provider.toUpperCase()} ${md.source.league ?? ''}`.trim().replace(/\s+/g, ' ');
    out.push(`  Lineup source: official starting lineup from ${label}${ev}`);
  }
  return out;
}

function formatMatch(match, board, provenance = null, previewLines = null) {
  const lines = [];
  const locked = isLineupLocked(match);
  const gp = projectionFor(board);
  lines.push(`▶ ${match.home_team} vs ${match.away_team}  [${safeStage(match)}]`);
  lines.push(`  ${kickoffDisplay(match)}${match.venue ? ` | ${match.venue}` : ''}`);
  if (locked) {
    lines.push('  Status: LINEUP LOCKED — official starting XI confirmed');
    lines.push(`  Model basis: confirmed lineup visible; forecast uses ${currentBaselineSummary(provenance)} and requires a lineup-adjusted model path for customer-ready lineup-lock output`);
  } else {
    lines.push('  Status: Pre-lock, lineups not confirmed');
    lines.push(`  Model basis: ${currentBaselineSummary(provenance)}; official starting lineup not yet verified`);
  }
  lines.push(`  Match forecast: ${resultEdgePhrase(board, match)}`);
  const advanceRead = isKnockoutStage(match?.stage) ? advanceDisplayLine(board, match) : null;
  if (advanceRead) {
    lines.push(`  Advances forecast: ${advanceRead}`);
  }
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
  if (locked) {
    for (const line of lineupLockedLines(match)) lines.push(line);
  }
  if (Array.isArray(previewLines) && previewLines.length) {
    for (const line of previewLines) lines.push(line);
  }
  lines.push('');
  return lines.join('\n');
}

function formatBlockedReason(reason) {
  const scope = reason.scope === 'match'
    ? `${reason.match_label ?? reason.match_id ?? 'match'}`
    : 'packet';
  const detail = compactText(reason.detail ?? 'missing requirement', 220);
  const nextArtifact = reason.next_artifact ? ` | next artifact: ${reason.next_artifact}` : '';
  return `  - [${reason.code}] ${scope}: ${detail}${nextArtifact}`;
}

function renderBlockedWorldCupPacket({ matches, meta = {} }) {
  const date = meta.date ?? new Date().toISOString().slice(0, 10);
  const packetGate = meta.packet_gate ?? { blocked: true, reasons: [] };
  const research = meta.research ?? null;
  const reasons = Array.isArray(packetGate.reasons) ? packetGate.reasons : [];
  const packetReasons = reasons.filter((reason) => reason.scope !== 'match');

  const lines = [];
  lines.push(header('MATCHDAY BLOCKED', date));
  lines.push('Packet status: BLOCKED — no customer-ready forecast emitted.');
  lines.push('Why: one or more required same-date model, lineup, or source-proof inputs are missing or fail verification.\n');

  lines.push(section('1. Blockers'));
  if (!reasons.length) {
    lines.push('  No blocker details were attached.');
  } else {
    for (const reason of reasons) lines.push(formatBlockedReason(reason));
  }
  lines.push('');

  lines.push(section('2. Match Coverage'));
  for (const match of matches) {
    const matchReasons = reasons.filter((reason) => reason.match_id && String(reason.match_id) === String(match.match_id));
    lines.push(`▶ ${match.home_team} vs ${match.away_team}  [${safeStage(match)}]`);
    lines.push(`  ${kickoffDisplay(match)}${match.venue ? ` | ${match.venue}` : ''}`);
    lines.push('  Status: BLOCKED — forecast withheld');
    lines.push(`  Lineup verification: ${lineupsStatusText(match)}`);
    if (matchReasons.length) {
      for (const reason of matchReasons) lines.push(formatBlockedReason(reason));
    } else if (packetReasons.length) {
      lines.push('  Packet-level blockers apply to this match as well.');
    }
    lines.push(liveContextCoverage(match));
    lines.push('');
  }

  lines.push(section('3. Source Proof'));
  lines.push(`  Packet-local Perplexity snapshot: ${research?.outPath ?? 'missing'}`);
  lines.push(`  Shared Perplexity source artifact: ${research?.sourceOutPath ?? 'missing'}`);
  lines.push(`  Research status: ${research?.status ?? 'unknown'}`);
  if (research?.reason) {
    lines.push(`  Research note: ${compactText(research.reason, 220)}`);
  }
  lines.push('');

  lines.push(section('4. Market Context'));
  lines.push('  Market prices are display-only when present and are NOT IN SCORE.');
  lines.push('  This blocked packet withholds any customer-ready forecast regardless of market context.');
  lines.push('');

  lines.push('─'.repeat(70));
  lines.push('Market prices are display-only when present and are NOT IN SCORE.');
  lines.push('Customer-ready forecast withheld until the listed artifacts are refreshed and re-rendered.');
  lines.push('No trades placed. Research only.');
  lines.push('─'.repeat(70));
  return lines.join('\n');
}

export function renderWorldCupPacket({ matches, boards, meta = {} }) {
  const date = meta.date ?? new Date().toISOString().slice(0, 10);
  const provenance = meta.composite_provenance ?? null;
  const packetGate = meta.packet_gate ?? null;
  const research = meta.research ?? null;
  const researchRoot = meta.research_root ?? undefined;
  const packetStage = meta.packet_stage ?? null;
  const confirmedCount = (matches || []).filter((m) => isLineupLocked(m)).length;
  const isMorningPreview = packetStage === 'morning_pre_lock' || packetStage === 'morning_board';
  const lineupLockedPacket = packetStage === 'lineup_locked' || (!isMorningPreview && confirmedCount > 0);
  const hasMarketContext = (boards || []).some((board) => (board?.lanes || []).some((lane) => lane?.market_context));

  if (packetGate?.blocked) {
    return renderBlockedWorldCupPacket({ matches, meta });
  }

  const lines = [];
  lines.push(header('MATCHDAY FORECAST', date));
  if (lineupLockedPacket) {
    lines.push(`Model basis: ${currentBaselineSummary(provenance)}.`);
    lines.push('Lineup-aware note: confirmed lineups are shown per match; customer-ready lineup-lock output requires a lineup-adjusted team model path.\n');
  } else if (isMorningPreview) {
    lines.push(`Model basis: ${currentBaselineSummary(provenance)}.`);
    lines.push('Lineup-aware note: this preview is pre-lock; official starting lineups are not yet verified.\n');
  } else if (provenance?.source_date) {
    lines.push(`Model basis: ${currentBaselineSummary(provenance)}.`);
    lines.push('Pre-lock forecast: official starting lineups are not yet verified.\n');
  }

  lines.push(whyItMattersBlock(matches, boards));

  // Daily slate preview — why today matters (unnumbered; precedes section 1).
  lines.push(slatePreviewBlock(matches, boards));

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
    const previewLines = matchPreviewLines(matches[i], boards[i], date, researchRoot);
    lines.push(formatMatch(matches[i], boards[i], provenance, previewLines));
    lines.push('  Data coverage (gathered / unavailable / blocked):');
    lines.push(lineupCoverage(matches[i], boards[i]));
    lines.push(renderGoalscorerBlock(matches[i], boards[i]));
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
  lines.push('  Prior-date baselines are diagnostic only and block customer-ready output when same-date basis is missing.');
  lines.push('  Confirmed-lineup packets require a lineup-adjusted team model path; otherwise the packet is blocked.\n');

  // 5. Source Quality
  lines.push(section('5. Source Quality'));
  let totalLayers = 0;
  let presentLayers = 0;
  for (const board of boards) {
    totalLayers += (board.layers_total ?? 14) * 2;
    presentLayers += (board.layers_present_home ?? 0) + (board.layers_present_away ?? 0);
  }
  const liveContextCount = countLiveContextMatches(matches);
  const researchStatus = research?.status ?? 'PERPLEXITY_UNAVAILABLE';
  lines.push(`  Matches evaluated: ${matches.length}`);
  lines.push(`  Side-layer coverage: ${presentLayers}/${totalLayers}`);
  if (confirmedCount > 0) {
    if (confirmedCount === matches.length) {
      lines.push(`  Lineup status: official starting XIs confirmed for all ${matches.length} match(es).`);
    } else {
      lines.push(`  Lineup status: official starting XIs confirmed for ${confirmedCount}/${matches.length} match(es); the rest are pre-lineup.`);
    }
  } else {
    lines.push('  Pre-lock status: lineups are not confirmed');
  }
  if (matches.some(isForecastHeld)) {
    lines.push('  Model basis: official starting XIs are confirmed, but the public forecast is held until the model consumes the confirmed XI state.');
  } else {
    lines.push(`  Model basis: ${currentBaselineSummary(provenance)}.`);
  }
  if (liveContextCount > 0) {
    lines.push(`  Perplexity research: live supplemental context captured for ${liveContextCount}/${matches.length} matches.`);
  } else {
    const reason = researchStatus === 'ok'
      ? 'no match-level live context attached'
      : `${researchStatus}${research?.reason ? `: ${research.reason}` : ''}`;
    lines.push(`  Perplexity research: unavailable — ${reason}; current source mode stayed cached/local.`);
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
