#!/usr/bin/env node
// MLB daily packet generator (pre-final-lineup research).
// One packet per Kalshi MLB game event (KXMLBGAME). No trades.
//
// Events = container (the game). Markets = the tradable contracts (per-team
// winner, totals, etc.). Each market is emitted as its own block under the
// event, with strike text sourced from market fields — never ticker fragments.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parsePacketArgs,
  ensurePacketDir,
  writeAudit,
  packetHeader,
  packetFooter,
  printDryRunSummary,
  readJsonIfExists,
  runPacketCommand,
} from './lib/common.mjs';
import {
  fetchKalshiEvents,
  filterByEventDate,
  persistEventArtifacts,
  summarizeEvent,
  renderMarketBlocks,
  normalizeMarket,
  KALSHI_SOURCES,
} from './lib/kalshi-discovery.mjs';
import { buildEventDisplay, buildMarketDisplay } from './lib/mlb-teams.mjs';
import {
  buildScoreEngineProjection,
  buildYrfiProjection,
  buildKsProjection,
  buildHrProjection,
} from '../mlb/lib/projection-contracts.mjs';
import {
  describeMoneyline,
  describeTotal,
  describeTeamRuns,
  describeYrfi,
  describeKs,
  describeHr,
} from '../mlb/lib/projection-language.mjs';
import { evaluateDecisionProcess, MARKET_TYPES, renderDecisionProcess } from '../shared/decision-process.mjs';
import {
  buildDecisionRow,
  renderDecisionBoard,
  renderSectionedPacket,
  rankDecisionRows,
  buildInventoryArtifact,
  EDGE_STATUS,
  CONFIDENCE,
} from '../shared/decision-packet.mjs';

const PACKET_TYPE = 'mlb-daily';

// Map an MLB scoring-core classification to the shared edge_status vocabulary.
// The MLB scorer is the authority on the verdict; the shared row carries it as
// statusOverride so the generic threshold logic does not relitigate it. Market
// price is NEVER read back into the composite — fair_value (model) and
// kalshi_ask (market) stay in separate halves of the row.
const MLB_CLASSIFICATION_TO_STATUS = Object.freeze({
  CLEAR_PICK: EDGE_STATUS.PICK,
  PRE_LINEUP_PICK: EDGE_STATUS.PICK,
  LEAN: EDGE_STATUS.LEAN,
  WATCH_FOR_PRICE: EDGE_STATUS.WATCH,
  WATCH_FOR_LISTING: EDGE_STATUS.WATCH,
  CORRELATED_ALTERNATE: EDGE_STATUS.WATCH,
  PASS: EDGE_STATUS.PASS,
  FADE: EDGE_STATUS.FADE,
  BLOCKED: EDGE_STATUS.BLOCKED,
  BLOCKED_SOURCE_GAP: EDGE_STATUS.BLOCKED,
});

const MLB_POSTURE = Object.freeze({
  CLEAR_PICK: 'PICK',
  PRE_LINEUP_PICK: 'EVIDENCE_LEAN',
  LEAN: 'LEAN',
  WATCH_FOR_PRICE: 'WATCH',
  WATCH_FOR_LISTING: 'WATCH',
  CORRELATED_ALTERNATE: 'MARKET_ONLY_LEAN',
  PASS: 'NO_CLEAR_PICK',
  FADE: 'NO_CLEAR_PICK',
  BLOCKED: 'NO_CLEAR_PICK',
  BLOCKED_SOURCE_GAP: 'NO_CLEAR_PICK',
});

/**
 * Load the MLB scoring artifacts (picks.json / today-execution-board.json) for
 * a date if the sports-pre-game pipeline already produced them. Read-only.
 * Returns { picks: [], source, runDate, summaryCounts } or null.
 */
export function loadMlbScoring(stateRoot, date) {
  const picksPath = resolve(stateRoot, 'mlb', date, 'picks.json');
  const json = readJsonIfExists(picksPath);
  if (!json || !Array.isArray(json.picks)) return null;
  return {
    picks: json.picks,
    source: picksPath,
    runDate: json.run_date ?? date,
    summaryCounts: json.summary_counts ?? {},
    sourceHealth: json.source_health ?? {},
  };
}

/**
 * Convert one MLB pick record into a shared decision row. fair_value is the
 * MARKET-NEUTRAL model probability from the composite scoring core; kalshi_ask
 * is the market price. Edge derives from fair vs implied only.
 * A lineup_pending confirmation downgrades confidence but does NOT collapse the
 * row to WATCH — a strong pre-lineup edge still surfaces as a PICK.
 */
export function mlbPickToDecisionRow(pick = {}) {
  const cls = String(pick.classification ?? 'PASS').toUpperCase();
  const status = MLB_CLASSIFICATION_TO_STATUS[cls] ?? EDGE_STATUS.WATCH;
  const posture = MLB_POSTURE[cls] ?? 'WATCH';
  const missing = Array.isArray(pick.missing_confirmations) ? pick.missing_confirmations : [];
  const gates = Array.isArray(pick.gates_passed) ? pick.gates_passed : [];
  const lineupPending = missing.some((m) => /lineup/i.test(String(m)));

  // Confidence: gate coverage, then downgrade once for a pending lineup so the
  // pre-lineup nature is reflected without killing the pick.
  let confidence = gates.length >= 5 ? CONFIDENCE.HIGH : gates.length >= 3 ? CONFIDENCE.MEDIUM : CONFIDENCE.LOW;
  if (lineupPending && confidence === CONFIDENCE.HIGH) confidence = CONFIDENCE.MEDIUM;
  else if (lineupPending && confidence === CONFIDENCE.MEDIUM) confidence = CONFIDENCE.LOW;

  const sideTarget = pick.contract_title
    ? `${pick.contract_title}${pick.game ? ` — ${pick.game}` : ''}`
    : (pick.game ?? pick.market_title ?? 'MISSING');

  const analysisBits = [];
  if (pick.edge_pp != null) {
    // Edge reference: prefer the market-neutral composite fair_value; if the
    // composite produced no probability, fall back to the book-derived
    // market_reference_prob (renamed from fair_value in 3f46ae8 so it is NOT
    // mistaken for the composite). Label the source honestly and never emit NaN.
    const composite = pick.fair_value != null && Number.isFinite(Number(pick.fair_value)) ? Number(pick.fair_value) : null;
    const bookRef = pick.market_reference_prob != null && Number.isFinite(Number(pick.market_reference_prob)) ? Number(pick.market_reference_prob) : null;
    const refProb = composite ?? bookRef;
    const refLabel = composite != null ? 'model fair' : (bookRef != null ? 'book-ref (not composite)' : 'ref');
    const refPct = refProb != null ? `${(refProb * 100).toFixed(0)}%` : 'MISSING';
    const mktPct = Number.isFinite(Number(pick.kalshi_ask)) ? `${(Number(pick.kalshi_ask) * 100).toFixed(0)}%` : 'MISSING';
    analysisBits.push(`${refLabel} ${refPct} vs market ${mktPct} = ${pick.edge_pp >= 0 ? '+' : ''}${Number(pick.edge_pp).toFixed(1)}pp`);
  }
  if (pick.dk_line != null) analysisBits.push(`book line ${pick.dk_line}`);
  if (cls === 'CORRELATED_ALTERNATE') analysisBits.push('reference-only: primary pick selected elsewhere in correlation group');
  if (lineupPending) analysisBits.push('pre-lineup: do not enter until lineup confirmed');
  const analysis = analysisBits.length ? analysisBits.join('; ') : `classification ${cls}`;

  const trigger = {
    price: pick.target_entry ?? null,
    event: lineupPending ? 'lineup confirmation' : (pick.target_entry != null ? 'price reaches target entry' : 'MISSING'),
  };

  return buildDecisionRow({
    marketTicker: pick.market_ticker ?? 'MISSING',
    sideTarget,
    marketType: pick.market_lane ?? 'mlb',
    settlementSummary: pick.market_title ?? pick.contract_title ?? 'MLB market settlement per Kalshi listing',
    composite: {
      score: pick.fair_value != null ? Math.round(Number(pick.fair_value) * 1000) / 10 : null,
      posture,
      layersPresent: gates.length,
      layersTotal: gates.length + missing.length,
      topEvidenceLayers: gates.map((g) => String(g).split(':')[0]),
      missingLayers: missing,
      modelProbability: pick.fair_value ?? null,
    },
    market: {
      yes_ask: pick.kalshi_ask ?? null,
      yes_bid: pick.kalshi_bid ?? null,
      last_price: pick.kalshi_last ?? null,
    },
    fair: { probability: pick.fair_value ?? null },
    confidence,
    analysis,
    trigger,
    statusOverride: status,
    edgeOverridePp: Number.isFinite(Number(pick.edge_pp)) ? Number(pick.edge_pp) : undefined,
  });
}

/**
 * Build the compact, sectioned MLB slate packet from picks.json scoring rows.
 * Returns { text, rows, inventoryText, counts } or null if no scoring exists.
 * The main user-facing text contains ONLY the sectioned decision board (TLDR +
 * Top Edge / Watchlist / Fades / Blocked + audit pointers). The full per-pick
 * inventory goes to a separate audit artifact, never the packet body.
 */
export function buildMlbSlatePacket({ date, scoring, artifacts = [], inventoryPath = null }) {
  if (!scoring || !Array.isArray(scoring.picks) || !scoring.picks.length) return null;
  // Skip pure reference rows from the headline board so we don't pad sections,
  // but keep them in the inventory artifact.
  const allRows = scoring.picks.map((p) => mlbPickToDecisionRow(p));
  const boardRows = allRows.filter((r) => r.market_type !== 'correlated_alternate');

  const lineupPending = scoring.picks.filter((p) =>
    Array.isArray(p.missing_confirmations) && p.missing_confirmations.some((m) => /lineup/i.test(String(m)))).length;

  const tldrNote = lineupPending
    ? `Pre-lineup slate: ${lineupPending} pick(s) await confirmed lineups — confidence is downgraded, not the board.`
    : 'Lineups confirmed where available.';

  const body = renderSectionedPacket(boardRows, {
    tldrNote,
    auditArtifacts: [inventoryPath, scoring.source].filter(Boolean),
    perSectionLimit: 14,
  });

  const header = packetHeader({
    packetType: PACKET_TYPE,
    date,
    title: 'Captain MLB — CPC Packet: Daily Slate Board',
    sources: [KALSHI_SOURCES.mlb?.page_url ?? KALSHI_SOURCES.mlb?.label, scoring.source].filter(Boolean),
  });
  const neutralityNote = 'Composite scoring is market-neutral: model fair_value never reads market price. Edge = fair − implied.';
  const text = [header, neutralityNote, body, packetFooter()].filter(Boolean).join('\n\n');

  // Full per-pick inventory -> audit artifact only. Each line carries model and
  // market fields together for routing/audit; pricing here is NOT a score input.
  const inventoryLines = allRows.map((r, i) =>
    `#${i + 1} [${r.edge_status}] ${r.market_ticker} :: ${r.side_target} | fair=${r.fair_probability_or_range} score=${r.composite_score} implied=${r.implied_probability} ask=${r.market_yes_ask} edge=${r.edge_cents_or_pp === null ? 'MISSING' : `${r.edge_cents_or_pp}pp`} conf=${r.confidence}`);
  const inventoryText = buildInventoryArtifact({
    marketType: 'mlb',
    date,
    eventTicker: `MLB-SLATE-${date}`,
    inventoryLines,
    meta: { summary_counts: JSON.stringify(scoring.summaryCounts ?? {}), board_rows: boardRows.length, total_rows: allRows.length },
  });

  return {
    text,
    rows: boardRows,
    inventoryText,
    counts: { total: allRows.length, board: boardRows.length, lineupPending },
  };
}

function buildMlbPacketProcess({ event = null, marketCount = 0, artifacts = [] }) {
  const hasParticipants = Boolean(event?.title || event?.sub_title || marketCount > 0);
  return evaluateDecisionProcess({
    marketType: MARKET_TYPES.SPORTS_GAME,
    rawDecision: 'WATCH',
    forceWatch: true,
    checked: {
      projected_participants: hasParticipants,
      lineup_injury_news: false,
      venue_context: false,
      recent_form_matchup: false,
      market_board_context: marketCount > 0,
      evidence_supported_side: false,
    },
    topEvidence: [
      marketCount > 0 ? `Kalshi MLB board captured with ${marketCount} market(s).` : null,
      artifacts.length ? `${artifacts.length} local MLB artifact(s) available.` : null,
    ].filter(Boolean),
    settlementRules: 'MLB market settlement criteria not independently pulled by this packet.',
    verifiedFacts: hasParticipants ? 'Game/event identity captured; lineup, starter, weather, and matchup context still required.' : 'No game identity verified.',
    marketSignalText: marketCount > 0 ? 'Market board captured for research; no pick inferred.' : 'No market board captured.',
    socialChatter: 'Not used as verified fact.',
    inference: 'MLB inference blocked until starters, lineups/news, venue/weather, and matchup context are complete.',
    skepticReview: 'MISSING: no skeptic review in packet generator.',
    finalJudgment: 'WATCH only; no evidence lean from market board alone.',
    wouldChangeView: [
      'Probable/confirmed starters and lineups are available.',
      'Weather/park and recent matchup context support the same side as a board signal.',
      'A starter scratch, lineup surprise, or weather change invalidates the setup.',
    ],
  });
}

export function primeMlbResearch(date, options = {}) {
  const runner = options.runner;
  const cwd = options.cwd ?? process.cwd();
  const commands = [
    ['node', ['scripts/mlb/mlb-workspace.mjs', 'discover', '--date', date, '--live-readonly', '--source', 'all']],
    ['node', ['scripts/mlb/mlb-workspace.mjs', 'outputs', '--date', date]],
  ];
  const attempts = [];
  for (const [command, args] of commands) {
    const result = runPacketCommand(command, args, { cwd, runner });
    attempts.push(result);
    if (!result.ok) break;
  }
  return attempts;
}

export function locateMlbArtifacts(stateRoot, date) {
  const root = resolve(stateRoot, 'mlb');
  if (!existsSync(root)) return [];
  const hits = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try { entries = readdirSync(cur); } catch { continue; }
    for (const e of entries) {
      const p = join(cur, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) {
        if (e === date || p.endsWith(`/${date}`)) {
          try {
            for (const f of readdirSync(p)) {
              const fp = join(p, f);
              if (statSync(fp).isFile() && f.endsWith('.json')) hits.push(fp);
            }
          } catch {}
        } else {
          stack.push(p);
        }
      }
    }
  }
  return hits;
}

/**
 * Read MLB workflow slate_manifest.json files and normalize to a flat list of
 * { game_id, matchup, start_utc, away, home } records. Tolerates missing/bad
 * files. Used by tests and as a fallback when no Kalshi events are available.
 */
export function extractGames(paths = []) {
  const out = [];
  for (const p of paths) {
    if (!p || !existsSync(p)) continue;
    let raw;
    try { raw = readFileSync(p, 'utf8'); } catch { continue; }
    let json;
    try { json = JSON.parse(raw); } catch { continue; }
    const games = Array.isArray(json?.games) ? json.games : [];
    for (const g of games) {
      if (!g) continue;
      out.push({
        game_id: g.game_pk ?? g.game_id ?? null,
        matchup: g.game || g.matchup
          || (g.teams ? `${g.teams.away ?? '?'} at ${g.teams.home ?? '?'}` : 'MISSING'),
        start_utc: g.start_time_utc || g.start_utc || null,
        away: g.teams?.away ?? g.away ?? null,
        home: g.teams?.home ?? g.home ?? null,
      });
    }
  }
  return out;
}

// Projection-FIRST read for one game. Renders what the MODEL layer projects
// (win prob, total/team runs, YRFI, Ks, HR) through the price-isolated
// projection contracts + language — NEVER a board line or an over/under call.
//
// Inputs are derived ONLY from confirmation gaps (lineup/roof/weather), never
// from market price, odds, or board shape. We do NOT fabricate projection
// outputs: with no model outputs available the contracts return blocked /
// provisional, and the language layer states that honestly. This is the wire
// that lets real model outputs flow the moment they exist.
export function buildProjectionFirstBlock({ date, gamePicks = [] } = {}) {
  const picks = Array.isArray(gamePicks) ? gamePicks : [];
  const as_of = `${date || 'unknown-date'}T00:00:00Z`;
  const game_id = String(picks[0]?.matched_game_pk ?? picks[0]?.event_ticker ?? 'unknown');

  // Team names: parse "Away at Home" from the pick's game string when present.
  let away = 'Away';
  let home = 'Home';
  const gameStr = picks.find((p) => typeof p?.game === 'string' && / at /.test(p.game))?.game;
  if (gameStr) {
    const [a, h] = gameStr.split(' at ');
    if (a?.trim()) away = a.trim();
    if (h?.trim()) home = h.trim();
  }

  // Confirmation-derived status — NOT price-derived.
  const allMissing = picks.flatMap((p) => (Array.isArray(p.missing_confirmations) ? p.missing_confirmations : []));
  const lineup_status = picks.length ? (allMissing.some((m) => /lineup/i.test(String(m))) ? 'unconfirmed' : 'confirmed') : null;
  const weather_status = picks.length ? (allMissing.some((m) => /roof|weather/i.test(String(m))) ? 'partial' : 'complete') : null;

  // Park identity is the matched game (display/identity only, no roof assumed).
  const park = picks[0]?.matched_game_pk != null ? { id: String(picks[0].matched_game_pk), roof: null } : null;
  const common = { game_id, as_of, lineup_status, weather_status };

  const score = buildScoreEngineProjection({ ...common, inputs: { park }, outputs: null });
  const yrfi = buildYrfiProjection({ ...common, inputs: { park }, outputs: null });
  const ks = buildKsProjection({ game_id, as_of, lineup_status, inputs: {}, outputs: null });
  const hr = buildHrProjection({ game_id, as_of, lineup_status, weather_status, inputs: { park }, outputs: null });

  return [
    '--- PROJECTION-FIRST READ (model layer, market-free) ---',
    describeMoneyline(score, { home_team: home, away_team: away }),
    describeTotal(score),
    describeTeamRuns(score, 'home', home),
    describeTeamRuns(score, 'away', away),
    describeYrfi(yrfi),
    describeKs(ks),
    describeHr(hr),
    'Projection layer only — model outputs feed this read; no market signal does.',
  ];
}

function buildKalshiGamePacket({ date, event, artifacts, primeAttempts, kalshiSummary, sourcePath, gamePicks }) {
  const s = summarizeEvent(event);
  const block = renderMarketBlocks(event, { limit: 40 });
  const process = buildMlbPacketProcess({ event, marketCount: block.marketCount, artifacts });
  const hasComposite = Array.isArray(gamePicks) && gamePicks.length > 0;

  const header = packetHeader({
    title: `Captain MLB — CPC Packet: ${hasComposite ? 'Game Board' : 'Pre-Final-Lineup'}`,
    date,
    packetType: PACKET_TYPE,
    sources: [sourcePath, KALSHI_SOURCES.mlb.page_url, ...artifacts],
  });
  const lines = [];

  if (hasComposite) {
    const rows = gamePicks.map((p) => mlbPickToDecisionRow(p));
    const boardRows = rows.filter((r) => r.market_type !== 'correlated_alternate');
    const lineupPending = gamePicks.filter((p) =>
      Array.isArray(p.missing_confirmations) && p.missing_confirmations.some((m) => /lineup/i.test(String(m)))).length;
    const tldrNote = lineupPending
      ? `Pre-lineup: ${lineupPending} pick(s) await confirmed lineups — confidence downgraded, not the board.`
      : 'Lineups confirmed where available.';

    const body = renderSectionedPacket(boardRows, {
      tldrNote,
      auditArtifacts: [sourcePath].filter(Boolean),
      perSectionLimit: 14,
    });
    lines.push('Composite scoring is market-neutral: model fair_value never reads market price. Edge = fair − implied.');
    lines.push('');
    lines.push(body);
  } else {
    lines.push('TLDR BOARD:');
    lines.push('  BLOCKED_MODEL_LAYER_MISSING');
    lines.push('');
    lines.push('=== BLOCKED — MODEL LAYER MISSING ===');
    lines.push(`No composite scoring available for this game (${s.title}).`);
    lines.push(`Markets discovered: ${block.marketCount}`);
    lines.push('Next step: run MLB scoring pipeline (scripts/mlb/composite-dry-run.mjs) for this date.');
    lines.push('Per-market pricing is available in the audit inventory only.');
    lines.push('');
    lines.push('--- Market Context - NOT IN SCORE ---');
    lines.push('Market data stored in audit artifact for reference; not displayed in customer packet without model layer.');
  }

  // Projection-first read: model-layer language (not board-derived), every game.
  lines.push('');
  for (const l of buildProjectionFirstBlock({ date, gamePicks })) lines.push(l);

  const inventoryLines = [];
  inventoryLines.push(`event_ticker: ${s.ticker}`);
  inventoryLines.push(`event_title: ${s.title}`);
  inventoryLines.push(`event_sub_title: ${s.sub_title || 'MISSING'}`);
  const evDisp = buildEventDisplay(event);
  inventoryLines.push(`display_event_title: ${evDisp.display_event_title}`);
  inventoryLines.push(`display_name_status: ${evDisp.display_name_status}`);
  inventoryLines.push(`series_ticker: ${s.series}`);
  inventoryLines.push(`market_count: ${s.marketCount}`);
  inventoryLines.push(`close_time_utc: ${s.close}`);
  inventoryLines.push('');
  inventoryLines.push('markets:');
  for (const l of block.lines) inventoryLines.push(l);
  const rawMarkets = Array.isArray(event?.markets) ? event.markets : [];
  if (rawMarkets.length) {
    inventoryLines.push('');
    inventoryLines.push('market_display:');
    for (const raw of rawMarkets) {
      const m = normalizeMarket(raw);
      const md = buildMarketDisplay(m, evDisp);
      inventoryLines.push(`  - market_ticker: ${m.ticker || 'MISSING'}`);
      inventoryLines.push(`    display_market_title: ${md.display_market_title}`);
      inventoryLines.push(`    display_yes_label: ${md.display_yes_label}`);
      inventoryLines.push(`    display_no_label: ${md.display_no_label}`);
      inventoryLines.push(`    display_name_status: ${md.display_name_status}`);
    }
  }

  return {
    text: header + lines.join('\n') + packetFooter(),
    inventoryText: inventoryLines.join('\n'),
    marketCount: block.marketCount,
    missingStrikeCount: block.missingStrikeCount,
    missingMarkets: block.missingMarkets,
  };
}

function buildEmptyPacket({ date, artifacts, primeAttempts, kalshiSummary }) {
  const process = evaluateDecisionProcess({
    marketType: MARKET_TYPES.SPORTS_GAME,
    rawDecision: 'NO CLEAR PICK',
    checked: {},
    settlementRules: 'MISSING: no MLB event packet.',
    verifiedFacts: 'MISSING: no matching MLB events discovered.',
    marketSignalText: 'No market board captured.',
    socialChatter: 'Not used.',
    inference: 'No inference.',
    skepticReview: 'MISSING.',
    finalJudgment: 'NO CLEAR PICK.',
  });
  const header = packetHeader({
    title: 'Captain MLB — CPC Packet: Pre-Final-Lineup',
    date,
    packetType: PACKET_TYPE,
    sources: [KALSHI_SOURCES.mlb.api_url, KALSHI_SOURCES.mlb.page_url, ...artifacts],
  });
  const lines = [];
  lines.push('TLDR:');
  lines.push(`  market_type: ${process.marketType}`);
  lines.push(`  decision_status: ${process.decisionStatus}`);
  lines.push('  note: no MLB events found; no pick or lean.');
  lines.push('');
  lines.push(renderDecisionProcess(process, { heading: 'Research Completeness' }));
  lines.push('');
  lines.push('research_prime:');
  if (primeAttempts.length) {
    for (const attempt of primeAttempts) {
      lines.push(`  - command: ${attempt.label}`);
      lines.push(`    status: ${attempt.ok ? 'ok' : 'MISSING'}`);
      if (!attempt.ok) lines.push(`    error: ${attempt.error || attempt.stderr || 'command failed'}`);
    }
  } else {
    lines.push('  - MISSING: no discovery command attempted');
  }
  lines.push('');
  if (kalshiSummary) {
    lines.push('kalshi_discovery:');
    lines.push(`  source_page: ${KALSHI_SOURCES.mlb.page_url}`);
    lines.push(`  source_api: ${KALSHI_SOURCES.mlb.api_url}`);
    lines.push(`  reachable: ${kalshiSummary.ok ? 'yes' : 'no'}`);
    lines.push(`  total_events: ${kalshiSummary.total}`);
    lines.push(`  window_matched: ${kalshiSummary.matched}`);
    if (kalshiSummary.error) lines.push(`  error: ${kalshiSummary.error}`);
    lines.push('');
  }
  lines.push('status: MISSING');
  lines.push(`reason: no Kalshi MLB events with derived event-date ${date}.`);
  return header + lines.join('\n') + packetFooter();
}

async function main() {
  const opts = parsePacketArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node scripts/packets/generate-mlb-daily.mjs --date YYYY-MM-DD [--dry-run]');
    return;
  }
  const dir = ensurePacketDir(opts.stateRoot, opts.date, PACKET_TYPE);
  const primeAttempts = primeMlbResearch(opts.date);
  const artifacts = locateMlbArtifacts(opts.stateRoot, opts.date);

  const discovery = await fetchKalshiEvents('mlb');
  const dateFilter = filterByEventDate(opts.date, { windowDays: 0, allowUndated: false });
  const kalshiEvents = discovery.events.filter(dateFilter);

  let persistedCount = 0;
  if (kalshiEvents.length) {
    const p = persistEventArtifacts({ stateRoot: opts.stateRoot, sport: 'mlb', date: opts.date, events: kalshiEvents });
    persistedCount = p.written.length;
  }

  const kalshiSummary = {
    ok: discovery.ok,
    total: discovery.events.length,
    matched: kalshiEvents.length,
    error: discovery.error,
  };

  let totalMarketCount = 0;
  let missingMarketEventCount = 0;
  let missingStrikeTextCount = 0;
  const items = [];
  const primeMeta = primeAttempts.map(({ label, ok, status, stderr, error }) => ({ label, ok, status, stderr, error }));

  // PRIMARY OUTPUT: when the MLB scoring pipeline already produced picks.json,
  // emit the compact sectioned decision board as the headline packet and push
  // the full per-pick inventory to a separate audit artifact. This replaces the
  // old all-WATCH per-event dump as the main user-facing result.
  const scoring = loadMlbScoring(opts.stateRoot, opts.date);
  if (scoring) {
    const inventoryName = `${opts.date}-mlb-daily.inventory`;
    const slate = buildMlbSlatePacket({
      date: opts.date,
      scoring,
      artifacts,
      inventoryPath: join(dir, `${inventoryName}.txt`),
    });
    if (slate) {
      const invW = writeAudit(dir, inventoryName, slate.inventoryText, {
        kind: 'raw_inventory_audit',
        total_rows: slate.counts.total,
        board_rows: slate.counts.board,
      });
      items.push({ name: 'mlb-daily.inventory', ...invW });
      const w = writeAudit(dir, `${opts.date}-mlb-daily-board`, slate.text, {
        kind: 'decision_board',
        board_rows: slate.counts.board,
        total_rows: slate.counts.total,
        lineup_pending: slate.counts.lineupPending,
        inventory_artifact: invW.txtPath ?? `${inventoryName}.txt`,
        scoring_source: scoring.source,
        research_prime: primeMeta,
      });
      items.push({ name: 'mlb-daily-board', ...w });
    }
  }

  if (!kalshiEvents.length) {
    const txt = buildEmptyPacket({ date: opts.date, artifacts, primeAttempts, kalshiSummary });
    const w = writeAudit(dir, `${opts.date}-mlb-daily-MISSING`, txt, {
      event_count: 0,
      total_market_count: 0,
      missing_market_count: 0,
      missing_strike_text_count: 0,
      artifact_count: artifacts.length,
      kalshi_discovery: kalshiSummary,
      research_prime: primeMeta,
    });
    items.push({ name: 'mlb-daily-MISSING', ...w });
  } else {
    for (const ev of kalshiEvents) {
      const ticker = ev?.event_ticker;
      if (!ticker) continue;
      const sourcePath = resolve(opts.stateRoot, 'mlb', opts.date, 'kalshi-events', `${ticker.replace(/[^A-Z0-9_-]/gi, '_').slice(0, 80)}.json`);
      const gamePicks = scoring ? scoring.picks.filter((p) => p.event_ticker === ticker) : null;
      const built = buildKalshiGamePacket({ date: opts.date, event: ev, artifacts, primeAttempts, kalshiSummary, sourcePath, gamePicks });
      totalMarketCount += built.marketCount;
      if (built.missingMarkets) missingMarketEventCount += 1;
      missingStrikeTextCount += built.missingStrikeCount;
      if (built.inventoryText) {
        const invW = writeAudit(dir, `${opts.date}-${ticker}.inventory`, built.inventoryText, {
          kind: 'raw_inventory_audit',
          event_ticker: ticker,
          market_count: built.marketCount,
        });
        items.push({ name: `${ticker}.inventory`, ...invW });
      }
      const w = writeAudit(dir, `${opts.date}-${ticker}`, built.text, {
        event_ticker: ticker,
        market_count: built.marketCount,
        missing_markets: built.missingMarkets,
        missing_strike_text_count: built.missingStrikeCount,
        artifact_count: artifacts.length,
        has_composite: Array.isArray(gamePicks) && gamePicks.length > 0,
        kalshi_discovery: kalshiSummary,
        research_prime: primeMeta,
      });
      items.push({ name: ticker, ...w });
    }
  }

  let exitCode = 0;
  if (kalshiEvents.length > 0 && totalMarketCount === 0) {
    console.error(`[${PACKET_TYPE}] FAIL: ${kalshiEvents.length} events but zero markets total.`);
    exitCode = 2;
  }

  console.log(printDryRunSummary({ packetType: PACKET_TYPE, date: opts.date, dir, items }));
  console.log(`[${PACKET_TYPE}] summary event_count=${kalshiEvents.length} total_market_count=${totalMarketCount} packets_written=${items.length} missing_market_count=${missingMarketEventCount} missing_strike_text_count=${missingStrikeTextCount} persisted=${persistedCount} local_artifacts=${artifacts.length}`);
  if (exitCode) process.exit(exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`[${PACKET_TYPE}] error: ${err.message}`);
    process.exit(1);
  });
}
