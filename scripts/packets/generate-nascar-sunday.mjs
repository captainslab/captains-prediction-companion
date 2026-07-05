#!/usr/bin/env node
// NASCAR Sunday packet generator. One packet per Kalshi NASCAR Cup race event.
// Filters to product_metadata.competition === 'NASCAR Cup Series' — drops
// Truck/Xfinity/Auto Parts events. Events are containers; markets are per-driver
// win contracts (and other lanes). No trades.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { detectSourceHealthDisclosure, CACHE_ONLY_DISCLOSURE_LINE } from '../cron/cpc-packet-janitor.mjs';
import {
  parsePacketArgs,
  ensurePacketDir,
  writeAudit,
  packetHeader,
  packetFooter,
  printDryRunSummary,
  readJsonIfExists,
} from './lib/common.mjs';
import {
  fetchKalshiEvents,
  filterByEventDate,
  filterNascarCupOnly,
  persistEventArtifacts,
  summarizeEvent,
  KALSHI_SOURCES,
} from './lib/kalshi-discovery.mjs';
import { evaluateDecisionProcess, MARKET_TYPES, renderDecisionProcess, describeDecisionStatus } from '../shared/decision-process.mjs';
import { routeNascarMarket } from '../nascar/lib/router.mjs';
import {
  buildDecisionRow,
  renderSectionedPacket,
  buildInventoryArtifact,
  EDGE_STATUS,
  CONFIDENCE,
} from '../shared/decision-packet.mjs';

const PACKET_TYPE = 'nascar-sunday';
const SUPPORTED_LANES = ['win', 'top3', 'top5', 'top10', 'top20', 'fastest_lap'];

// Map a NASCAR ceiling-board lane status to the shared edge vocabulary. The
// ceiling model is the authority on driver posture; the shared row carries it
// as statusOverride so the generic threshold logic does not relitigate it.
const NASCAR_STATUS_TO_EDGE = Object.freeze({
  PICK: EDGE_STATUS.PICK,
  EVIDENCE_LEAN: EDGE_STATUS.LEAN,
  'EVIDENCE LEAN': EDGE_STATUS.LEAN,
  LEAN: EDGE_STATUS.LEAN,
  WATCH: EDGE_STATUS.WATCH,
  MARKET_ONLY: EDGE_STATUS.WATCH,
  'MARKET ONLY': EDGE_STATUS.WATCH,
  'NO CLEAR PICK': EDGE_STATUS.PASS,
  NO_CLEAR_PICK: EDGE_STATUS.PASS,
});

const NASCAR_STATUS_TO_POSTURE = Object.freeze({
  PICK: 'PICK',
  EVIDENCE_LEAN: 'EVIDENCE_LEAN',
  'EVIDENCE LEAN': 'EVIDENCE_LEAN',
  LEAN: 'LEAN',
  WATCH: 'WATCH',
  MARKET_ONLY: 'MARKET_ONLY_LEAN',
  'MARKET ONLY': 'MARKET_ONLY_LEAN',
  'NO CLEAR PICK': 'NO_CLEAR_PICK',
  NO_CLEAR_PICK: 'NO_CLEAR_PICK',
});

function nascarNum(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Load a NASCAR ceiling board (the model signal) for a date from located
 * artifacts. Prefers the real `ceilings[]` board shape, but still accepts the
 * older scored `candidates[]` shape for legacy fixtures. Read-only.
 */
export function loadNascarCeiling(artifacts = []) {
  for (const fp of artifacts) {
    if (!fp.endsWith('.json')) continue;
    const data = readJsonIfExists(fp);
    if (!data) continue;
    if (Array.isArray(data.ceilings) && data.ceilings.length) {
      return {
        ceilings: data.ceilings,
        source: fp,
        lanes: data.supported_market_lanes ?? data.lanes ?? [],
        fieldBucket: data.field_bucket ?? null,
        userFacingLines: data.user_facing_lines ?? [],
        schemaVersion: data.schema_version ?? null,
      };
    }
    if (Array.isArray(data.candidates) && data.candidates.length) {
      return { candidates: data.candidates, source: fp, lanes: data.lanes ?? [] };
    }
  }
  return null;
}

/**
 * Field-normalize ceiling composite scores into a fair WIN probability that
 * sums to ~1 across the candidate field. This is a MODEL-ONLY transform — it
 * never reads market price. Used only as the fair anchor for edge comparison.
 */
function fairWinProbabilities(candidates = []) {
  const scored = candidates
    .map((c) => ({ name: (c.driver_name || '').trim(), score: nascarNum(c.composite_score) }))
    .filter((c) => c.name && c.score !== null && c.score > 0);
  const total = scored.reduce((s, c) => s + c.score, 0);
  const map = new Map();
  if (total > 0) {
    for (const c of scored) map.set(c.name, c.score / total);
  }
  return map;
}

/**
 * True when a Kalshi market is a per-driver outright RACE-WINNER contract, as
 * opposed to a same-event top3/top5/top10/top20 finishing-position or
 * fastest_lap contract (which also carry a per-driver yes_sub_title).
 *
 * Strategy: a win market must first look like a per-driver binary (has a
 * yes_sub_title or expiration_value). Then we run the tested NASCAR router over
 * the market's title/rules text. We EXCLUDE only markets the router positively
 * routes to a non-win lane (top3/top5/top10/top20/fastest_lap). Anything the
 * router leaves as win / ambiguous / blocked stays on the board so genuine
 * winner listings with sparse text are never dropped (fail-open).
 *
 * Market price fields are never read here — classification is wording-only.
 */
export function isWinLaneMarket(m) {
  if (!m || (!m.yes_sub_title && !m.expiration_value)) return false;
  const title = m.title ?? m.yes_sub_title ?? '';
  const rules = m.rules_primary ?? m.rules_summary ?? '';
  if (!title && !rules) return true; // no wording to classify -> keep (fail-open)
  const route = routeNascarMarket({ market_title: title, rules_summary: rules });
  const lane = route?.market_lane ?? null;
  if (lane && lane !== 'win') return false; // positively a non-win lane -> drop
  return true;
}

/**
 * Build the ranked NASCAR decision board from the ceiling model + Kalshi win
 * markets. Two modes:
 *   - JOINED:      ceiling candidates present -> per-driver rows with model
 *                  posture + fair win prob vs market implied (real edge).
 *   - MARKET_ONLY: no ceiling candidates -> ranked rows sorted by market
 *                  implied prob, each BLOCKED on the missing ceiling model with
 *                  an explicit trigger. NEVER a 38-row forceWatch dump.
 * Returns { rows, mode, joined, marketCount } or null when no win markets.
 */
export function buildNascarRows({ event, ceiling = null }) {
  const markets = Array.isArray(event?.markets) ? event.markets : [];
  // Win lane = per-driver binary race-winner markets only. Same-event top3/
  // top5/top10/top20/fastest_lap contracts also carry a per-driver
  // yes_sub_title, so a bare `yes_sub_title || expiration_value` test wrongly
  // pulls those finishing-position lanes onto the win board. Use the tested
  // NASCAR router to classify each market and keep only the win lane; markets
  // the router cannot resolve to a non-win lane stay on the board (fail-open)
  // so unclassifiable winner listings are never silently dropped.
  const winMarkets = markets.filter((m) => isWinLaneMarket(m));
  if (!winMarkets.length) return null;

  const candidatesByName = new Map();
  if (ceiling?.candidates?.length) {
    for (const c of ceiling.candidates) candidatesByName.set((c.driver_name || '').trim(), c);
  }
  const fairWin = ceiling?.candidates?.length ? fairWinProbabilities(ceiling.candidates) : new Map();
  const mode = candidatesByName.size ? 'JOINED' : 'MARKET_ONLY';

  const rows = [];
  let joined = 0;
  for (const m of winMarkets) {
    const driver = (m.yes_sub_title || m.expiration_value || 'MISSING').trim();
    const cand = candidatesByName.get(driver) ?? null;
    if (cand) joined += 1;
    const winLane = cand?.lanes?.win ?? null;
    const laneStatus = (winLane?.status ?? '').toUpperCase();
    const fairProb = fairWin.get(driver) ?? null;

    // Pass both Kalshi price shapes straight through. buildDecisionRow (and
    // impliedProbabilityFromMarket) already resolve `yes_bid ?? yes_bid_dollars`
    // and normalize cents (1..100) vs dollars (0..1). Flattening only the
    // *_dollars fields here silently dropped live Kalshi `yes_bid`/`yes_ask`/
    // `last_price` (cents) shapes, leaving the market half null mid-session.
    const marketHalf = {
      yes_bid: m.yes_bid ?? m.yes_bid_dollars ?? null,
      yes_bid_dollars: m.yes_bid_dollars ?? null,
      yes_ask: m.yes_ask ?? m.yes_ask_dollars ?? null,
      yes_ask_dollars: m.yes_ask_dollars ?? null,
      last_price: m.last_price ?? m.last_price_dollars ?? null,
      last_price_dollars: m.last_price_dollars ?? null,
      volume: m.volume ?? m.volume_fp ?? null,
      open_interest: m.open_interest ?? m.open_interest_fp ?? null,
    };

    let statusOverride;
    let blocker = null;
    let posture;
    let analysis;
    let trigger;
    const missingLayers = [];

    if (cand) {
      statusOverride = NASCAR_STATUS_TO_EDGE[laneStatus] ?? undefined;
      posture = NASCAR_STATUS_TO_POSTURE[laneStatus] ?? 'WATCH';
      const cov = nascarNum(cand.fundamentals_layer_coverage);
      if (cov !== null && cov < 3) missingLayers.push(`fundamentals_coverage=${cov}/3`);
      const breakdownMissing = /Missing layers:\s*([^.]+)/.exec(cand.score_reasoning || '');
      if (breakdownMissing) missingLayers.push(...breakdownMissing[1].split(',').map((s) => s.trim()).filter(Boolean));
      analysis = winLane?.narrative
        ? winLane.narrative
        : `composite ${cand.composite_score} (${cand.fundamentals_layer_coverage_label || 'coverage n/a'}); win lane ${laneStatus || 'n/a'}`;
      trigger = {
        price: null,
        event: laneStatus === 'PICK' || laneStatus === 'EVIDENCE_LEAN'
          ? 'confirm practice/qualifying then enter on value'
          : 'await stronger model lane (practice/qualifying upgrade)',
      };
    } else {
      // No model: do not fabricate a verdict. Block on the missing ceiling
      // layer but keep the market priced and ranked so it is still useful.
      statusOverride = EDGE_STATUS.BLOCKED;
      blocker = 'BLOCKED_MODEL_LAYER_MISSING: no ceiling-board composite for this driver';
      posture = 'NO_CLEAR_PICK';
      missingLayers.push('ceiling_board_composite', 'fundamentals_layers');
      analysis = 'Market priced; ceiling model absent for this date — not a model edge.';
      trigger = { price: null, event: 'run NASCAR ceiling board (scripts/nascar/nascar-workspace.mjs) for this race date' };
    }

    rows.push(buildDecisionRow({
      marketTicker: m.ticker ?? 'MISSING',
      sideTarget: `${driver} — WIN`,
      marketType: 'nascar_win',
      settlementSummary: m.rules_primary ? String(m.rules_primary).slice(0, 120) : 'NASCAR Cup race winner per Kalshi listing',
      composite: {
        score: cand ? nascarNum(cand.composite_score) : null,
        posture,
        layersPresent: cand ? nascarNum(cand.fundamentals_layer_coverage) : 0,
        layersTotal: cand ? 4 : 4,
        topEvidenceLayers: cand?.score_breakdown?.inputs_used?.map((x) => x.layer) ?? [],
        missingLayers,
        modelProbability: fairProb,
      },
      market: marketHalf,
      fair: fairProb !== null ? { probability: fairProb } : {},
      confidence: cand
        ? (nascarNum(cand.fundamentals_layer_coverage) >= 3 ? CONFIDENCE.MEDIUM : CONFIDENCE.LOW)
        : CONFIDENCE.LOW,
      analysis,
      trigger,
      statusOverride,
      blocker,
    }));
  }

  return { rows, mode, joined, marketCount: winMarkets.length };
}

function buildNascarProcess({ event = null, marketCount = 0, ceiling = null, artifacts = [] }) {
  return evaluateDecisionProcess({
    marketType: MARKET_TYPES.SPORTS_GAME,
    rawDecision: 'WATCH',
    forceWatch: true,
    checked: {
      projected_participants: marketCount > 0,
      lineup_injury_news: false,
      venue_context: Boolean(event?.product_metadata?.competition),
      recent_form_matchup: Boolean(ceiling?.candidates?.length),
      market_board_context: marketCount > 0,
      evidence_supported_side: false,
    },
    topEvidence: [
      marketCount > 0 ? `Kalshi NASCAR market set captured with ${marketCount} market(s).` : null,
      ceiling?.candidates?.length ? `Ceiling model captured from ${ceiling.source}.` : null,
      artifacts.length ? `${artifacts.length} local artifact(s) available.` : null,
    ].filter(Boolean),
    settlementRules: 'NASCAR market settlement criteria not independently pulled by this packet.',
    verifiedFacts: ceiling?.candidates?.length ? 'Ceiling board present; qualifying/practice and entry status still required.' : 'No verified race-context facts supplied by packet generator.',
    marketSignalText: marketCount > 0 ? 'Price context captured for research; no CPC read inferred from price.' : 'No price context captured.',
    socialChatter: 'Not used as verified fact.',
    inference: 'Race inference blocked until official entry/status, practice/qualifying, track, and recent performance context are complete.',
    skepticReview: 'MISSING: no skeptic review in packet generator.',
    finalJudgment: 'WATCH only; no CPC read from price context or ceiling model alone.',
    wouldChangeView: [
      'Official entry list and race status are confirmed.',
      'Practice/qualifying and track-form context support a side.',
      'Inspection/driver change/news invalidates the setup.',
    ],
  });
}

function buildCeilingOnlyPacket({ date, event, sourcePath, ceiling, marketCount, stateRoot = 'state' }) {
  const s = summarizeEvent(event);
  const userFacing = Array.isArray(ceiling.userFacingLines) && ceiling.userFacingLines.length
    ? ceiling.userFacingLines
    : ceiling.ceilings.map((entry) => `${entry.driver_name} ${entry.ceiling_label}`);
  const disclosure = detectSourceHealthDisclosure({ packetType: PACKET_TYPE, date, stateRoot });
  const body = [
    'TLDR BOARD:',
    '  CEILING_BOARD_PRESENT',
    `  ceiling_source: ${ceiling.source}`,
    `  ceilings: ${ceiling.ceilings.length}`,
    `  win_markets_discovered: ${marketCount}`,
    '',
    '=== CEILING BOARD ===',
    ...userFacing.map((line) => `- ${line}`),
    '',
    '=== FIELD / LONGSHOTS ===',
    `- ${ceiling.fieldBucket?.summary ?? 'no field bucket summary available.'}`,
    '',
    '--- Market Context - NOT IN SCORE ---',
    'Market pricing remains audit-only until a scored join exists. The ceiling board is the source of truth for this packet.',
    ...(disclosure.needsDisclosure ? ['', '--- Source Freshness ---', disclosure.disclosureLine ?? CACHE_ONLY_DISCLOSURE_LINE] : []),
  ].join('\n');

  const inventoryText = buildInventoryArtifact({
    marketType: 'nascar_win',
    date,
    eventTicker: s.ticker,
    inventoryLines: ceiling.ceilings.map((entry) =>
      `- ${entry.driver_name} | ${entry.ceiling_label} | lane=${entry.lane_type} | pool=${entry.pool_entry_reason} | basis=${entry.basis}`),
    meta: {
      mode: 'CEILINGS_ONLY',
      ceiling_source: ceiling.source,
      ceiling_count: ceiling.ceilings.length,
      win_markets: marketCount,
    },
  });

  return {
    text: [packetHeader({
      title: `Captain NASCAR — CPC Packet: ${s.title}`,
      date,
      packetType: PACKET_TYPE,
      sources: [sourcePath, KALSHI_SOURCES.nascar.page_url, ceiling.source].filter(Boolean),
    }), body, packetFooter()].join('\n\n'),
    inventoryText,
    marketCount,
    missingStrikeCount: 0,
    missingMarkets: false,
  };
}

function locateNascarArtifacts(stateRoot, date) {
  const root = resolve(stateRoot, 'nascar');
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
        if (e === date) {
          try {
            for (const f of readdirSync(p)) {
              const fp = join(p, f);
              if (statSync(fp).isFile() && (f.endsWith('.json') || f.endsWith('.md'))) hits.push(fp);
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

function tryRunWorkspaceFixturesOnly(date) {
  try {
    const out = execFileSync(
      process.execPath,
      ['scripts/nascar/nascar-workspace.mjs', '--date', date, '--fixtures-only'],
      { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 },
    );
    return { ok: true, output: out.toString('utf8').slice(0, 2000) };
  } catch (err) {
    return { ok: false, error: (err.stderr?.toString() || err.message || 'unknown').slice(0, 500) };
  }
}

export function buildRacePacket({ date, event, sourcePath, artifacts, workspaceResult, stateRoot = 'state' }) {
  const s = summarizeEvent(event);
  const ceiling = loadNascarCeiling(artifacts);
  if (ceiling?.ceilings?.length && !ceiling?.candidates?.length) {
    return buildCeilingOnlyPacket({ date, event, sourcePath, ceiling, marketCount: s.marketCount, stateRoot });
  }
  const built = buildNascarRows({ event, ceiling });
  const header = packetHeader({
    title: `Captain NASCAR — CPC Packet: ${s.title}`,
    date,
    packetType: PACKET_TYPE,
    sources: [sourcePath, KALSHI_SOURCES.nascar.page_url, ceiling?.source].filter(Boolean),
  });

  // No win markets at all -> fall back to a research-completeness note (no dump).
  if (!built || !built.rows.length) {
    const proc = buildNascarProcess({ event, marketCount: s.marketCount, ceiling, artifacts });
    const body = [
      'TLDR BOARD:',
      `  no per-driver win markets parsed for ${s.title}; nothing to rank.`,
      '',
      renderDecisionProcess(proc, { heading: 'Research Completeness' }),
    ].join('\n');
    return {
      text: [header, body, packetFooter()].join('\n\n'),
      inventoryText: buildInventoryArtifact({ marketType: 'nascar_win', date, eventTicker: s.ticker, inventoryLines: [], meta: { mode: 'NO_WIN_MARKETS' } }),
      marketCount: 0,
      missingStrikeCount: 0,
      missingMarkets: true,
    };
  }

  // MARKET_ONLY mode: ceiling model absent. Render a compact event-level
  // BLOCKED section instead of dumping 30+ individual BLOCKED driver rows.
  // Per-driver market pricing goes to the audit inventory only.
  if (built.mode === 'MARKET_ONLY') {
    const body = [
      'TLDR BOARD:',
      '  BLOCKED_MODEL_LAYER_MISSING',
      '',
      '=== BLOCKED — MODEL LAYER MISSING ===',
      `No ceiling-board composite available for this race date (${s.title}).`,
      `Win markets discovered: ${built.marketCount}`,
      'Next step: run NASCAR ceiling board (scripts/nascar/nascar-workspace.mjs) for this race date.',
      'Per-driver market pricing is available in the audit inventory only.',
      '',
      '--- Market Context - NOT IN SCORE ---',
      'Market data stored in audit artifact for reference; not displayed in customer packet without model layer.',
    ].join('\n');
    return {
      text: [header, body, packetFooter()].join('\n\n'),
      inventoryText: buildInventoryArtifact({ marketType: 'nascar_win', date, eventTicker: s.ticker, inventoryLines: built.rows.map((r, i) =>
        `#${i + 1} [${r.edge_status}] ${r.market_ticker} :: ${r.side_target} | implied=${r.implied_probability} ask=${r.market_yes_ask} bid=${r.market_yes_bid} conf=${r.confidence}`),
        meta: { mode: 'MARKET_ONLY', win_markets: built.marketCount, ceiling_source: 'MISSING' },
      }),
      marketCount: built.marketCount,
      missingStrikeCount: 0,
      missingMarkets: false,
    };
  }

  const modeNote = `Ceiling model joined for ${built.joined}/${built.marketCount} drivers (source: ${ceiling.source}). Edge = model fair win − market implied.`;

  const body = renderSectionedPacket(built.rows, {
    tldrNote: modeNote,
    auditArtifacts: [`${date}-${s.ticker}.inventory.txt`, sourcePath].filter(Boolean),
    perSectionLimit: 16,
  });

  const inventoryLines = built.rows.map((r, i) =>
    `#${i + 1} [${r.edge_status}] ${r.market_ticker} :: ${r.side_target} | fair=${r.fair_probability_or_range} score=${r.composite_score} implied=${r.implied_probability} ask=${r.market_yes_ask} edge=${r.edge_cents_or_pp === null ? 'MISSING' : `${r.edge_cents_or_pp}pp`} conf=${r.confidence}`);
  const inventoryText = buildInventoryArtifact({
    marketType: 'nascar_win',
    date,
    eventTicker: s.ticker,
    inventoryLines,
    meta: { mode: built.mode, joined: built.joined, win_markets: built.marketCount, ceiling_source: ceiling?.source ?? 'MISSING' },
  });

  return {
    text: [header, body, packetFooter()].join('\n\n'),
    inventoryText,
    marketCount: built.marketCount,
    missingStrikeCount: 0,
    missingMarkets: false,
  };
}

function buildEmptyPacket({ date, artifacts, workspaceResult, discovery, matchedCount }) {
  const process = evaluateDecisionProcess({
    marketType: MARKET_TYPES.SPORTS_GAME,
    rawDecision: 'PASS',
    checked: {},
    settlementRules: 'MISSING: no NASCAR Cup event packet.',
    verifiedFacts: 'MISSING: no matching NASCAR Cup events discovered.',
    marketSignalText: 'No price context captured.',
    socialChatter: 'Not used.',
    inference: 'No inference.',
    skepticReview: 'MISSING.',
    finalJudgment: 'PASS.',
  });
  const header = packetHeader({
    title: 'Captain NASCAR — CPC Packet: No Events',
    date,
    packetType: PACKET_TYPE,
    sources: [KALSHI_SOURCES.nascar.api_url, KALSHI_SOURCES.nascar.page_url, ...artifacts],
  });
  const lines = [];
  lines.push('TLDR:');
  lines.push(`  market_type: ${process.marketType}`);
  lines.push(`  decision_status: ${describeDecisionStatus(process.decisionStatus)}`);
  lines.push('  note: no NASCAR Cup event found; no CPC read or rated view.');
  lines.push('');
  lines.push(renderDecisionProcess(process, { heading: 'Research Completeness' }));
  lines.push('');
  lines.push('kalshi_discovery:');
  lines.push(`  source_page: ${KALSHI_SOURCES.nascar.page_url}`);
  lines.push(`  source_api: ${KALSHI_SOURCES.nascar.api_url}`);
  lines.push(`  reachable: ${discovery.ok ? 'yes' : 'no'}`);
  lines.push(`  total_events: ${discovery.events.length}`);
  lines.push(`  cup_in_window_matched: ${matchedCount}`);
  if (discovery.error) lines.push(`  error: ${discovery.error}`);
  lines.push('');
  lines.push('status: MISSING');
  lines.push(`reason: no NASCAR Cup race derived event-date matches ${date} window and no local race artifacts present.`);
  if (workspaceResult) {
    lines.push(`workspace_run_ok: ${workspaceResult.ok}`);
    if (!workspaceResult.ok) lines.push(`workspace_error: ${workspaceResult.error}`);
  }
  return header + lines.join('\n') + packetFooter();
}

async function main() {
  const opts = parsePacketArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node scripts/packets/generate-nascar-sunday.mjs --date YYYY-MM-DD [--dry-run]');
    return;
  }
  const dir = ensurePacketDir(opts.stateRoot, opts.date, PACKET_TYPE);

  const discovery = await fetchKalshiEvents('nascar');
  const dateFilter = filterByEventDate(opts.date, { windowDays: 1, allowUndated: false });
  const cupEvents = discovery.events.filter(filterNascarCupOnly).filter(dateFilter);
  let persistedCount = 0;
  if (cupEvents.length) {
    const p = persistEventArtifacts({ stateRoot: opts.stateRoot, sport: 'nascar', date: opts.date, events: cupEvents });
    persistedCount = p.written.length;
  }

  let artifacts = locateNascarArtifacts(opts.stateRoot, opts.date);
  let workspaceResult = null;
  if (!artifacts.length) {
    workspaceResult = tryRunWorkspaceFixturesOnly(opts.date);
    artifacts = locateNascarArtifacts(opts.stateRoot, opts.date);
  }

  let totalMarketCount = 0;
  let missingMarketEventCount = 0;
  let missingStrikeTextCount = 0;
  const items = [];

  if (!cupEvents.length) {
    const txt = buildEmptyPacket({
      date: opts.date,
      artifacts,
      workspaceResult,
      discovery,
      matchedCount: 0,
    });
    const w = writeAudit(dir, `${opts.date}-nascar-sunday-MISSING`, txt, {
      event_count: 0,
      total_market_count: 0,
      missing_market_count: 0,
      missing_strike_text_count: 0,
      artifact_count: artifacts.length,
      workspace_attempt: workspaceResult,
      kalshi_discovery: { ok: discovery.ok, error: discovery.error, total: discovery.events.length, cup_matched: 0 },
    });
    items.push({ name: 'nascar-sunday-MISSING', ...w });
  } else {
    for (const ev of cupEvents) {
      const ticker = ev?.event_ticker;
      if (!ticker) continue;
      const sourcePath = resolve(opts.stateRoot, 'nascar', opts.date, 'kalshi-events', `${ticker.replace(/[^A-Z0-9_-]/gi, '_').slice(0, 80)}.json`);
      const built = buildRacePacket({ date: opts.date, event: ev, sourcePath, artifacts, workspaceResult, stateRoot: opts.stateRoot });
      totalMarketCount += built.marketCount;
      if (built.missingMarkets) missingMarketEventCount += 1;
      missingStrikeTextCount += built.missingStrikeCount;
      // Raw per-driver inventory -> audit artifact only (never the packet body).
      if (built.inventoryText) {
        const invW = writeAudit(dir, `${opts.date}-${ticker}.inventory`, built.inventoryText, {
          kind: 'raw_inventory_audit',
          event_ticker: ticker,
        });
        items.push({ name: `${ticker}.inventory`, ...invW });
      }
      const w = writeAudit(dir, `${opts.date}-${ticker}`, built.text, {
        event_ticker: ticker,
        market_count: built.marketCount,
        missing_markets: built.missingMarkets,
        missing_strike_text_count: built.missingStrikeCount,
        artifact_count: artifacts.length,
        workspace_attempt: workspaceResult,
        kalshi_source_api: KALSHI_SOURCES.nascar.api_url,
        kalshi_source_page: KALSHI_SOURCES.nascar.page_url,
      });
      items.push({ name: ticker, ...w });
    }
  }

  let exitCode = 0;
  if (cupEvents.length > 0 && totalMarketCount === 0) {
    console.error(`[${PACKET_TYPE}] FAIL: ${cupEvents.length} cup events but zero markets total.`);
    exitCode = 2;
  }

  console.log(printDryRunSummary({ packetType: PACKET_TYPE, date: opts.date, dir, items }));
  console.log(`[${PACKET_TYPE}] summary event_count=${cupEvents.length} total_market_count=${totalMarketCount} packets_written=${items.length} missing_market_count=${missingMarketEventCount} missing_strike_text_count=${missingStrikeTextCount} persisted=${persistedCount} artifacts=${artifacts.length} kalshi_total=${discovery.events.length}`);
  if (exitCode) process.exit(exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`[${PACKET_TYPE}] error: ${err.message}`);
    process.exit(1);
  });
}
