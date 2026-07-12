#!/usr/bin/env node
// NASCAR Sunday packet generator. One packet per Kalshi NASCAR Cup race event.
// Filters to product_metadata.competition === 'NASCAR Cup Series' — drops
// Truck/Xfinity/Auto Parts events. Events are containers; markets are per-driver
// win contracts (and other lanes). No trades.

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
import { evaluateDecisionProcess, MARKET_TYPES, renderDecisionProcess } from '../shared/decision-process.mjs';
import { BLOCKED_LIVE_RESEARCH_MISSING, runNascarLiveResearch } from '../nascar/live-research.mjs';
import {
  NASCAR_PACKET_INCOMPLETE,
  evaluateNascarEventIdentity,
  evaluateNascarRaceReadiness,
  formatNascarIncompleteReasons,
} from '../nascar/lib/race-quality-gate.mjs';
import { fetchNascarOfficialLive } from '../nascar/lib/source-adapters/nascar-official-live.mjs';
import { normalizeNascarDriverName } from '../nascar/lib/driver-name.mjs';
import {
  isNascarWinLaneMarket,
  normalizeNascarWinMarkets,
} from '../nascar/lib/win-market-normalization.mjs';
import {
  buildNascarProductionEvidence,
  persistNascarProductionArtifacts,
} from '../nascar/lib/production-evidence.mjs';
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

function compactText(value) {
  if (value === null || value === undefined) return null;
  const text = Array.isArray(value) ? value.join(' ') : String(value);
  const cleaned = text.replace(/\r?\n+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

function truncateText(value, limit = 180) {
  const text = compactText(value);
  if (!text) return null;
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function getLiveResearchArtifact(liveResearch = null) {
  if (!liveResearch) return null;
  if (liveResearch.artifact && typeof liveResearch.artifact === 'object') return liveResearch.artifact;
  return liveResearch;
}

function renderLiveResearchSection(liveResearch = null) {
  const artifact = getLiveResearchArtifact(liveResearch);
  if (!artifact) return null;

  const layers = artifact.layers && typeof artifact.layers === 'object' ? artifact.layers : {};
  const layerNames = [
    'race_event_identity',
    'entry_list_drivers',
    'qualifying_starting_order',
    'practice_speed',
    'recent_driver_form',
    'track_history_gen7_comparables',
    'team_manufacturer_notes',
    'penalties_inspection_news',
    'weather_track_condition',
  ];
  const sourceUrls = Array.isArray(artifact.source_urls) ? artifact.source_urls : [];
  const driverNotes = Array.isArray(artifact.drivers) ? artifact.drivers : [];
  const missingLayers = [];
  const lines = ['--- Current Event Evidence ---'];
  lines.push(`generated_utc: ${artifact.generated_utc ?? liveResearch?.generated_utc ?? 'unknown'}`);
  lines.push(`event_ticker: ${artifact.event_ticker ?? 'unknown'}`);
  lines.push(`model: ${artifact.model ?? 'unknown'}`);
  lines.push('');
  lines.push('source_urls:');
  if (sourceUrls.length) {
    for (const source of sourceUrls) {
      const title = compactText(source?.title);
      const url = compactText(source?.url) ?? 'unknown';
      lines.push(title ? `- ${url} (${title})` : `- ${url}`);
    }
  } else {
    lines.push('- none returned');
  }
  lines.push('');
  lines.push('evidence_ledger:');
  for (const layerName of layerNames) {
    const layer = layers[layerName] ?? { status: 'missing', notes: null, sources: [], fetched_utc: artifact.generated_utc ?? liveResearch?.generated_utc ?? 'unknown' };
    const sourceCount = Array.isArray(layer.sources) ? layer.sources.length : 0;
    const rawStatus = String(layer.status ?? 'missing').toLowerCase();
    const status = rawStatus === 'ok' ? 'ok' : rawStatus === 'source_unavailable' ? 'source_unavailable' : 'missing';
    if (status !== 'ok') missingLayers.push(layerName);
    lines.push(`- ${layerName}: ${status} (${sourceCount} source${sourceCount === 1 ? '' : 's'})`);
    const notes = truncateText(layer.notes, 220);
    if (notes) lines.push(`  notes: ${notes}`);
    if (layer.source_id ?? layer.source_adapter) lines.push(`  source_adapter: ${layer.source_id ?? layer.source_adapter}`);
    if (layer.data_as_of_utc) lines.push(`  data_as_of_utc: ${layer.data_as_of_utc}`);
  }
  lines.push('');
  lines.push('per-driver notes:');
  if (driverNotes.length) {
    for (const note of driverNotes) {
      const driver = compactText(note?.driver) ?? 'unknown driver';
      const summary = truncateText(note?.notes, 200) ?? 'no note returned';
      const sourceCount = Array.isArray(note?.sources) ? note.sources.length : 0;
      lines.push(`- ${driver}: ${summary} (${sourceCount} source${sourceCount === 1 ? '' : 's'})`);
    }
  } else {
    lines.push('- none returned');
  }
  lines.push('');
  lines.push('confidence_limits: narrative-only display context; live research does not set score, ranking, posture, or ceiling math.');
  lines.push('Missing layers:');
  if (missingLayers.length) {
    for (const layerName of missingLayers) lines.push(`- ${layerName}`);
  } else {
    lines.push('- none');
  }

  return lines.join('\n');
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
  const supplied = candidates
    .map((candidate) => ({
      name: normalizeNascarDriverName(candidate.driver_name),
      probability: nascarNum(candidate.fair_win_probability),
    }));
  if (supplied.length && supplied.every((candidate) => candidate.name && candidate.probability !== null && candidate.probability >= 0)) {
    return new Map(supplied.map((candidate) => [candidate.name, candidate.probability]));
  }
  const scored = candidates
    .map((c) => ({ name: normalizeNascarDriverName(c.driver_name), score: nascarNum(c.composite_score) }))
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
  return isNascarWinLaneMarket(m);
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
  const markets = normalizeNascarWinMarkets(event);
  // Win lane = per-driver binary race-winner markets only. Same-event top3/
  // top5/top10/top20/fastest_lap contracts also carry a per-driver
  // yes_sub_title, so a bare `yes_sub_title || expiration_value` test wrongly
  // pulls those finishing-position lanes onto the win board. Use the tested
  // NASCAR router to classify each market and keep only the win lane; markets
  // the router cannot resolve to a non-win lane stay on the board (fail-open)
  // so unclassifiable winner listings are never silently dropped.
  const winMarkets = markets;
  if (!winMarkets.length) return null;

  const candidatesByName = new Map();
  if (ceiling?.candidates?.length) {
    for (const c of ceiling.candidates) candidatesByName.set(normalizeNascarDriverName(c.driver_name), c);
  }
  const fairWin = ceiling?.candidates?.length ? fairWinProbabilities(ceiling.candidates) : new Map();
  const mode = candidatesByName.size ? 'JOINED' : 'MARKET_ONLY';

  const rows = [];
  let joined = 0;
  for (const m of winMarkets) {
    const driver = (m.yes_sub_title || m.expiration_value || 'MISSING').trim();
    const cand = candidatesByName.get(normalizeNascarDriverName(driver)) ?? null;
    if (cand) joined += 1;
    const winLane = cand?.lanes?.win ?? null;
    const laneStatus = (winLane?.status ?? '').toUpperCase();
    const fairProb = fairWin.get(normalizeNascarDriverName(driver)) ?? null;

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
    const cov = cand ? nascarNum(cand.fundamentals_layer_coverage ?? cand.layers_present) : null;
    const missingLayers = [];

    if (cand) {
      statusOverride = NASCAR_STATUS_TO_EDGE[laneStatus] ?? undefined;
      posture = NASCAR_STATUS_TO_POSTURE[laneStatus] ?? 'WATCH';
      if (cov !== null && cov < 3) missingLayers.push(`fundamentals_coverage=${cov}/3`);
      const breakdownMissing = /Missing layers:\s*([^.]+)/.exec(cand.score_reasoning || '');
      if (breakdownMissing) missingLayers.push(...breakdownMissing[1].split(',').map((s) => s.trim()).filter(Boolean));
      if (Array.isArray(cand.missing_or_low_evidence_flags)) missingLayers.push(...cand.missing_or_low_evidence_flags);
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
        layersPresent: cand ? cov : 0,
        layersTotal: cand?.layer_breakdown?.length ?? 4,
        topEvidenceLayers: cand?.score_breakdown?.inputs_used?.map((x) => x.layer)
          ?? cand?.layer_breakdown?.filter((x) => x.value !== null).map((x) => x.layer)
          ?? [],
        missingLayers,
        modelProbability: fairProb,
      },
      market: marketHalf,
      fair: fairProb !== null ? { probability: fairProb } : {},
      confidence: cand
        ? (cand.confidence ?? (cov >= 3 ? CONFIDENCE.MEDIUM : CONFIDENCE.LOW))
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
      marketCount > 0 ? `Kalshi NASCAR board captured with ${marketCount} market(s).` : null,
      ceiling?.candidates?.length ? `Ceiling board captured from ${ceiling.source}.` : null,
      artifacts.length ? `${artifacts.length} local artifact(s) available.` : null,
    ].filter(Boolean),
    settlementRules: 'NASCAR market settlement criteria not independently pulled by this packet.',
    verifiedFacts: ceiling?.candidates?.length ? 'Ceiling board present; qualifying/practice and entry status still required.' : 'No verified race-context facts supplied by packet generator.',
    marketSignalText: marketCount > 0 ? 'Market board captured for research; no pick inferred.' : 'No market board captured.',
    socialChatter: 'Not used as verified fact.',
    inference: 'Race inference blocked until official entry/status, practice/qualifying, track, and recent performance context are complete.',
    skepticReview: 'MISSING: no skeptic review in packet generator.',
    finalJudgment: 'WATCH only; no evidence lean from race board or ceiling board alone.',
    wouldChangeView: [
      'Official entry list and race status are confirmed.',
      'Practice/qualifying and track-form context support a side.',
      'Inspection/driver change/news invalidates the setup.',
    ],
  });
}

function readFieldSummary({ rows, quality }) {
  const startByName = quality?.context?.startByName ?? new Map();
  const byStart = rows
    .map((row) => {
      const driver = String(row.side_target ?? '').replace(/\s+—\s+WIN$/, '').trim();
      const start = startByName.get(normalizeNascarDriverName(driver)) ?? null;
      return { row, driver, start: Number.isInteger(start) ? start : 99 };
    })
    .sort((a, b) => a.start - b.start || b.row.composite_score - a.row.composite_score)
    .map(({ row, driver, start }) =>
      `- P${String(start).padStart(2, '0')} ${driver} | posture=${row.composite_posture ?? 'WATCH'} | score=${row.composite_score ?? 'n/a'} | confidence=${row.confidence}`);
  const ranked = rows
    .slice()
    .sort((a, b) => (Number(b.composite_score) || -1) - (Number(a.composite_score) || -1))
    .map((row, index) => {
      const driver = String(row.side_target ?? '').replace(/\s+—\s+WIN$/, '').trim();
      return `- #${index + 1} ${driver} | posture=${row.composite_posture ?? 'WATCH'} | score=${row.composite_score ?? 'n/a'} | fair=${row.fair_probability_or_range ?? 'n/a'}`;
    });
  return { ranked, byStart };
}

function modelPosture(row) {
  return String(row?.composite_posture ?? row?.model_posture ?? '').trim().toUpperCase().replace(/\s+/g, '_');
}

function modelScore(row) {
  const score = Number(row?.composite_score);
  return Number.isFinite(score) ? score : null;
}

function classifyRows(rows = []) {
  const strongest = [];
  const secondary = [];
  const longshots = [];
  const fades = [];
  const ranked = rows.slice().sort((a, b) =>
    (modelScore(b) ?? -1) - (modelScore(a) ?? -1)
    || modelPosture(b).localeCompare(modelPosture(a))
    || String(a.side_target ?? '').localeCompare(String(b.side_target ?? '')));
  for (const row of ranked) {
    const posture = modelPosture(row);
    const score = modelScore(row);
    if (posture === 'NO_CLEAR_PICK' || (score !== null && score < 40)) {
      fades.push(row);
      continue;
    }
    if (posture === 'PICK' || posture === 'STRONG_EVIDENCE_LEAN' || posture === 'EVIDENCE_LEAN') {
      if (strongest.length < 3) strongest.push(row);
      else secondary.push(row);
      continue;
    }
    if (posture === 'LEAN' || (score !== null && score >= 60)) secondary.push(row);
    else longshots.push(row);
  }
  return { strongest, secondary, longshots, fades };
}

function renderDriverBullets(rows = [], { emptyLabel, includeWhy = false } = {}) {
  if (!rows.length) return ['- none'];
  return rows.map((row) => {
    const driver = String(row.side_target ?? '').replace(/\s+—\s+WIN$/, '').trim();
    const base = `- ${driver} | posture=${row.composite_posture ?? row.model_posture ?? 'WATCH'} | score=${row.composite_score ?? 'n/a'} | fair=${row.fair_probability_or_range ?? 'n/a'}`;
    if (!includeWhy) return base;
    return `${base} | why=${compactText(row.analysis_brief ?? row.analysis_reason ?? row.analysis ?? 'model support present')}`;
  });
}

function buildBlockedPacket({ date, event, sourcePath, liveResearch = null, reasons = [] }) {
  const s = summarizeEvent(event);
  const body = [
    renderLiveResearchSection(liveResearch),
    '',
    'TLDR BOARD:',
    `  ${NASCAR_PACKET_INCOMPLETE}`,
    `  reason_count: ${reasons.length}`,
    '',
    `=== ${NASCAR_PACKET_INCOMPLETE} ===`,
    ...reasons.map((reason) => `- ${reason}`),
    '',
    '=== EVIDENCE ===',
    '- Official race identity, active field, final starting order, and deterministic market joins must all be present.',
    '',
    '=== CONFIDENCE ===',
    '- Packet blocked fail-closed. Customer delivery is not allowed for this race build.',
    '',
    '=== LIMITS ===',
    '- Market Context - NOT IN SCORE. Market prices remain display-only and cannot rescue missing official/model coverage.',
    '- Delivery remains blocked, no delivery ledger write occurs, and no implied pick is emitted while this marker is present.',
  ].filter(Boolean).join('\n');

  return {
    text: [packetHeader({
      title: `Captain NASCAR — CPC Packet: ${s.title}`,
      date,
      packetType: PACKET_TYPE,
      sources: [sourcePath, KALSHI_SOURCES.nascar.page_url].filter(Boolean),
    }), body, packetFooter()].join('\n\n'),
    inventoryText: '',
    marketCount: 0,
    missingStrikeCount: 0,
    missingMarkets: true,
  };
}

function buildReadyRacePacket({ date, event, sourcePath, liveResearch = null, built, quality, ceiling = null }) {
  const s = summarizeEvent(event);
  const grouped = classifyRows(built.rows);
  const fieldLines = readFieldSummary({ rows: built.rows, quality });
  const identity = quality.context.packetIdentity;
  const gridCount = quality.context.startByName?.size ?? 0;
  const candidateCount = Array.isArray(ceiling?.candidates) ? ceiling.candidates.length : 0;
  const evidenceLines = [
    `- Official race identity confirmed: ${quality.context.officialRaceName} at ${quality.context.officialTrack} (${quality.context.officialStartUtc}).`,
    `- Active field and final starting order cover ${quality.context.activeFieldCount} drivers with full discovered win-market coverage.`,
    `- Deterministic join complete: ${built.joined}/${built.marketCount} drivers matched across official field, final order, and ceiling model.`,
  ];
  const confidenceLines = [
    '- Composite score and fair win probability come only from the ceiling model.',
    '- Live research is narrative-only support; it does not set score, ranking, or posture.',
  ];
  const sourceFreshnessLines = [
    `- Official race identity checked: ${quality.context.loaded.officialEnvelope?.checked_at_utc ?? 'missing'}.`,
    `- Active field checked: ${quality.context.loaded.activeFieldEnvelope?.checked_at_utc ?? 'missing'}; final order checked: ${quality.context.loaded.practiceEnvelope?.checked_at_utc ?? 'missing'}.`,
    `- Narrative research generated: ${quality.context.loaded.liveResearch?.generated_utc ?? 'missing'}.`,
    '- Adapter check timestamps are aligned and current; historical data-as-of timestamps are disclosed per evidence layer and are never represented as live.',
  ];
  const limitLines = [
    '- Market Context - NOT IN SCORE. Market prices are display-only and remain in the audit inventory, not the customer board.',
    '- Packet sends only when official identity, full field, final order, timestamps, and joins are all complete.',
  ];

  const body = [
    renderLiveResearchSection(liveResearch),
    '',
    'TLDR BOARD:',
    '  RACE_READY',
    `event_ticker: ${identity.event_ticker}`,
    `race_id: ${identity.race_id}`,
    `track_id: ${identity.track_id}`,
    `series_id: ${identity.series_id}`,
    `race_name: ${identity.race_name}`,
    `track: ${identity.track}`,
    `official_start_utc: ${identity.scheduled_start_utc}`,
    `official_race_date: ${identity.race_date}`,
    `field_size: ${quality.context.activeFieldCount}`,
    `grid_count: ${gridCount}`,
    `market_count: ${built.marketCount}`,
    `candidate_count: ${candidateCount}`,
    `ranked_count: ${built.rows.length}`,
    `joined_drivers: ${built.joined}/${built.marketCount}`,
    'market_context: display-only audit context; never a model input.',
    '',
    '=== FULL FIELD ===',
    ...fieldLines.byStart,
    '',
    '=== RANKED BOARD ===',
    ...fieldLines.ranked,
    '',
    '=== STRONGEST ===',
    ...renderDriverBullets(grouped.strongest, { emptyLabel: 'none', includeWhy: true }),
    '',
    '=== SECONDARY ===',
    ...renderDriverBullets(grouped.secondary, { emptyLabel: 'none', includeWhy: true }),
    '',
    '=== LONGSHOTS ===',
    ...renderDriverBullets(grouped.longshots, { emptyLabel: 'none' }),
    '',
    '=== FADES ===',
    ...renderDriverBullets(grouped.fades, { emptyLabel: 'none' }),
    '',
    '=== EVIDENCE ===',
    ...evidenceLines,
    '',
    '=== CONFIDENCE ===',
    ...confidenceLines,
    'source_freshness:',
    ...sourceFreshnessLines,
    '',
    '=== LIMITS ===',
    ...limitLines,
  ].filter(Boolean).join('\n');

  const inventoryLines = built.rows.map((r, i) =>
    `#${i + 1} [${r.edge_status}] ${r.market_ticker} :: ${r.side_target} | fair=${r.fair_probability_or_range} score=${r.composite_score} implied=${r.implied_probability} ask=${r.market_yes_ask} edge=${r.edge_cents_or_pp === null ? 'MISSING' : `${r.edge_cents_or_pp}pp`} conf=${r.confidence}`);
  const inventoryText = buildInventoryArtifact({
    marketType: 'nascar_win',
    date,
    eventTicker: s.ticker,
    inventoryLines,
    meta: {
      mode: built.mode,
      joined: built.joined,
      win_markets: built.marketCount,
      ceiling_source: quality?.context?.loaded?.officialEnvelope?.source_id ?? 'MISSING',
    },
  });

  return {
    text: [packetHeader({
      title: `Captain NASCAR — CPC Packet: ${s.title}`,
      date,
      packetType: PACKET_TYPE,
      sources: [sourcePath, KALSHI_SOURCES.nascar.page_url, ceiling?.source].filter(Boolean),
    }), body, packetFooter()].join('\n\n'),
    inventoryText,
    marketCount: built.marketCount,
    missingStrikeCount: 0,
    missingMarkets: false,
  };
}

function buildCeilingOnlyPacket({ date, event, sourcePath, ceiling, marketCount, stateRoot = 'state', liveResearch = null }) {
  const s = summarizeEvent(event);
  const userFacing = Array.isArray(ceiling.userFacingLines) && ceiling.userFacingLines.length
    ? ceiling.userFacingLines
    : ceiling.ceilings.map((entry) => `${entry.driver_name} ${entry.ceiling_label}`);
  const disclosure = detectSourceHealthDisclosure({ packetType: PACKET_TYPE, date, stateRoot });
  const body = [
    renderLiveResearchSection(liveResearch),
    '',
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
  ].filter(Boolean).join('\n');

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

function tryRunWorkspaceFixturesOnly(date, stateRoot = 'state') {
  try {
    const out = execFileSync(
      process.execPath,
      ['scripts/nascar/nascar-workspace.mjs', '--date', date, '--state-root', stateRoot, '--fixtures-only'],
      { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 },
    );
    return { ok: true, output: out.toString('utf8').slice(0, 2000) };
  } catch (err) {
    return { ok: false, error: (err.stderr?.toString() || err.message || 'unknown').slice(0, 500) };
  }
}

export function buildRacePacket({
  date,
  event,
  sourcePath,
  artifacts = [],
  workspaceResult,
  stateRoot = 'state',
  liveResearch = null,
  officialEnvelope = null,
  sourceRegistry = null,
  discovery = null,
  activeFieldEnvelope = null,
  practiceEnvelope = null,
  ceiling: suppliedCeiling = null,
  maxSourceAgeMs,
  nowMs = Date.now(),
}) {
  const identity = evaluateNascarEventIdentity({
    date,
    event,
    stateRoot,
    liveResearch,
    officialEnvelope,
    sourceRegistry,
    discovery,
    activeFieldEnvelope,
    practiceEnvelope,
  });
  if (!identity.ok) {
    const earlyQuality = evaluateNascarRaceReadiness({
      date,
      event,
      ceiling: null,
      winMarkets: [],
      stateRoot,
      liveResearch,
      officialEnvelope,
      sourceRegistry,
      discovery,
      activeFieldEnvelope,
      practiceEnvelope,
      nowMs,
      maxSourceAgeMs,
    });
    const earlyErrors = new Map();
    for (const error of [...identity.errors, ...earlyQuality.errors]) {
      earlyErrors.set(`${error.code}:${error.message}`, error);
    }
    const reasons = formatNascarIncompleteReasons([...earlyErrors.values()]);
    if (identity.errors.some((error) => error.code === 'OFFICIAL_RACE_IDENTITY_MISSING')) {
      reasons.unshift('OFFICIAL_ADAPTER_NOT_FETCHED: no official NASCAR race adapter data is loaded for this packet, so event identity cannot be claimed or inferred.');
    }
    if (!artifacts.length && Array.isArray(event?.markets) && event.markets.length) {
      reasons.push('BLOCKED_MODEL_LAYER_MISSING: no ceiling-board composite was available for the discovered driver markets.');
    }
    return buildBlockedPacket({
      date,
      event,
      sourcePath,
      liveResearch,
      reasons,
    });
  }

  // Official event identity is validated before the ceiling board is loaded
  // or any driver-market join is attempted.
  const ceiling = suppliedCeiling ?? loadNascarCeiling(artifacts);
  const built = buildNascarRows({ event, ceiling });

  // No win markets at all -> fall back to a research-completeness note (no dump).
  if (!built || !built.rows.length) {
    return buildBlockedPacket({
      date,
      event,
      sourcePath,
      liveResearch,
      reasons: ['WIN_MARKETS_MISSING: no per-driver NASCAR win markets were available for a full-field packet.'],
    });
  }

  const quality = evaluateNascarRaceReadiness({
    date,
    event,
    ceiling,
    winMarkets: built.rows.map((row) => ({
      ticker: row.market_ticker,
      driver_name: String(row.side_target ?? '').replace(/\s+—\s+WIN$/, '').trim(),
    })),
    stateRoot,
    liveResearch,
    officialEnvelope,
    sourceRegistry,
    discovery,
    activeFieldEnvelope,
    practiceEnvelope,
    nowMs,
    maxSourceAgeMs,
  });
  if (!quality.ok || built.mode !== 'JOINED') {
    const reasons = [
      ...(built.mode !== 'JOINED'
        ? [
            'CEILING_MODEL_MISSING: full-field win packet requires a deterministic ceiling-model join for every discovered driver.',
            'BLOCKED_MODEL_LAYER_MISSING: one or more discovered driver markets have no ceiling-board composite.',
          ]
        : []),
      ...(quality.errors.some((error) => error.code === 'OFFICIAL_RACE_IDENTITY_MISSING')
        ? ['OFFICIAL_ADAPTER_NOT_FETCHED: no official NASCAR race adapter data is loaded for this packet, so event identity cannot be claimed or inferred.']
        : []),
      ...formatNascarIncompleteReasons(quality.errors),
    ];
    return buildBlockedPacket({ date, event, sourcePath, liveResearch, reasons });
  }
  return buildReadyRacePacket({ date, event, sourcePath, liveResearch, built, quality, ceiling });
}

function buildEmptyPacket({ date, artifacts, workspaceResult, discovery, matchedCount }) {
  const process = evaluateDecisionProcess({
    marketType: MARKET_TYPES.SPORTS_GAME,
    rawDecision: 'NO CLEAR PICK',
    checked: {},
    settlementRules: 'MISSING: no NASCAR Cup event packet.',
    verifiedFacts: 'MISSING: no matching NASCAR Cup events discovered.',
    marketSignalText: 'No market board captured.',
    socialChatter: 'Not used.',
    inference: 'No inference.',
    skepticReview: 'MISSING.',
    finalJudgment: 'NO CLEAR PICK.',
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
  lines.push(`  decision_status: ${process.decisionStatus}`);
  lines.push('  note: no NASCAR Cup event found; no pick or lean.');
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
  const rawArgs = process.argv.slice(2);
  const fixturesOnly = rawArgs.includes('--fixtures')
    || /^(1|true|yes)$/i.test(String(process.env.CPC_NASCAR_FIXTURES_ONLY ?? ''));
  const opts = parsePacketArgs(rawArgs.filter((arg) => arg !== '--fixtures'));
  if (opts.help) {
    console.log('Usage: node scripts/packets/generate-nascar-sunday.mjs --date YYYY-MM-DD [--dry-run] [--fixtures]');
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

  const ceilingPath = resolve(opts.stateRoot, 'nascar', opts.date, 'ceiling_board.json');
  let artifacts = [];
  let workspaceResult = null;
  let officialIngestion = null;
  if (fixturesOnly) {
    workspaceResult = tryRunWorkspaceFixturesOnly(opts.date, opts.stateRoot);
  } else if (cupEvents.length) {
    officialIngestion = await fetchNascarOfficialLive({
      date: opts.date,
      season: opts.date.slice(0, 4),
      outputDir: resolve(opts.stateRoot, 'nascar', opts.date, 'discovery'),
    });
  }
  // Existing ceiling/discovery artifacts are eligible only in the explicit
  // fixture lane. Production always rebuilds the selected event in-memory and
  // replaces the current-event artifacts before packet construction.
  if (fixturesOnly && existsSync(ceilingPath)) artifacts = [ceilingPath];

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
      official_ingestion: officialIngestion ? { ok: officialIngestion.ok, status: officialIngestion.status, reason: officialIngestion.reason } : null,
      kalshi_discovery: { ok: discovery.ok, error: discovery.error, total: discovery.events.length, cup_matched: 0 },
    });
    items.push({ name: 'nascar-sunday-MISSING', ...w });
  } else {
    for (const ev of cupEvents) {
      const ticker = ev?.event_ticker;
      if (!ticker) continue;
      const sourcePath = resolve(opts.stateRoot, 'nascar', opts.date, 'kalshi-events', `${ticker.replace(/[^A-Z0-9_-]/gi, '_').slice(0, 80)}.json`);
      let liveResearch = await runNascarLiveResearch({
        date: opts.date,
        event: ev,
        stateRoot: opts.stateRoot,
      });
      if (!liveResearch?.ok) {
        if (fixturesOnly) {
          console.error(`${BLOCKED_LIVE_RESEARCH_MISSING} event=${ticker} reason=${liveResearch?.reason ?? 'unknown'}`);
          process.exit(1);
        }
        console.error(`LIVE_RESEARCH_OPTIONAL_UNAVAILABLE event=${ticker} reason=${liveResearch?.reason ?? 'unknown'}`);
        liveResearch = {
          ok: false,
          generated_utc: new Date().toISOString(),
          event_ticker: ticker,
          model: 'source_unavailable',
          source_urls: [],
          layers: {},
          drivers: [],
          _adapter_status: 'source_unavailable',
          reason: liveResearch?.reason ?? 'live narrative research unavailable',
        };
      }
      let production = null;
      if (!fixturesOnly) {
        if (!officialIngestion?.ok) {
          console.error(`OFFICIAL_ADAPTER_NOT_FETCHED event=${ticker} reason=${officialIngestion?.reason ?? 'unknown'}`);
          process.exit(1);
        }
        production = buildNascarProductionEvidence({
          date: opts.date,
          event: ev,
          officialEnvelope: officialIngestion.envelopes.official,
          activeFieldEnvelope: officialIngestion.envelopes.activeField,
          practiceEnvelope: officialIngestion.envelopes.practiceQualifying,
          liveResearch: liveResearch.artifact ?? liveResearch,
          checkedAtUtc: officialIngestion.envelopes.official.checked_at_utc,
        });
        persistNascarProductionArtifacts({
          stateRoot: opts.stateRoot,
          date: opts.date,
          built: production,
        });
      }
      const built = buildRacePacket({
        date: opts.date,
        event: ev,
        sourcePath,
        artifacts,
        workspaceResult,
        officialEnvelope: officialIngestion?.envelopes?.official ?? null,
        activeFieldEnvelope: officialIngestion?.envelopes?.activeField ?? null,
        practiceEnvelope: officialIngestion?.envelopes?.practiceQualifying ?? null,
        sourceRegistry: production?.sourceRegistry ?? null,
        discovery: production?.discovery ?? null,
        ceiling: production?.ceiling ?? null,
        stateRoot: opts.stateRoot,
        liveResearch: production?.evidenceArtifact ?? liveResearch,
      });
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
        artifact_count: production ? 5 : artifacts.length,
        production_model_schema: production?.ceiling?.schema_version ?? null,
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
