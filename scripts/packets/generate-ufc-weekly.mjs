#!/usr/bin/env node
// UFC weekly packet generator. Saturdays. One packet per Kalshi UFC event.
// Events = the card. Markets = each fighter's win contract. No trades.

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
} from './lib/common.mjs';
import {
  fetchKalshiEvents,
  filterByEventDate,
  persistEventArtifacts,
  summarizeEvent,
  renderMarketBlocks,
  KALSHI_SOURCES,
} from './lib/kalshi-discovery.mjs';
import { assertCpcPacketValid } from './lib/cpc-packet-validator.mjs';
import { evaluateDecisionProcess, MARKET_TYPES, renderDecisionProcess } from '../shared/decision-process.mjs';
import { scoreFight } from '../ufc/lib/matchup-scorer.mjs';
import { renderUfcPacket, renderUfcInventory } from '../ufc/lib/packet-renderer.mjs';
import { buildFighterEntry, } from '../ufc/lib/stats-to-layers.mjs';
import { LAYER_DEFS } from '../ufc/lib/evidence-ledger.mjs';
import { renderUfcModelScores } from '../ufc/lib/model-score-matrix.mjs';

export const PACKET_TYPE = 'ufc-weekly';
const WEEKEND_DAYS = 1; // Sat + Sun -> windowDays=1
export const UFC_MARKET_LANES = Object.freeze({
  winner: 'KXUFCFIGHT',
  method_of_victory: 'KXUFCMOV',
  go_the_distance: 'KXUFCDISTANCE',
  round_of_victory: 'KXUFCVICROUND',
  round_of_finish: 'KXUFCROUNDS',
  method_of_finish: 'KXUFCMOF',
});

export function buildUfcProcess({ event = null, legacy = null, marketCount = 0 }) {
  const hasParticipants = marketCount > 0 || Boolean(legacy?.fights?.length || legacy?.card?.length);
  return evaluateDecisionProcess({
    marketType: MARKET_TYPES.SPORTS_GAME,
    rawDecision: 'WATCH',
    forceWatch: true,
    checked: {
      projected_participants: hasParticipants,
      lineup_injury_news: Boolean(legacy?.injuries || legacy?.status_notes),
      venue_context: Boolean(legacy?.venue || event?.venue),
      recent_form_matchup: Boolean(legacy?.fighter_form || legacy?.matchup_notes),
      market_board_context: marketCount > 0,
      evidence_supported_side: false,
    },
    topEvidence: [
      marketCount > 0 ? `Kalshi fight market set captured with ${marketCount} market(s).` : null,
      legacy?.venue ? `Venue supplied: ${legacy.venue}.` : null,
    ].filter(Boolean),
    settlementRules: 'UFC market settlement criteria not independently pulled by this packet.',
    verifiedFacts: hasParticipants ? 'Participants/market contracts captured; fighter status context still required.' : 'No participants verified.',
    marketSignalText: marketCount > 0 ? 'Price context captured for research; no CPC read inferred from price.' : 'No price context captured.',
    socialChatter: 'Not used as verified fact.',
    inference: 'Fight inference blocked until fighter status, matchup, recent form, and card-change checks are complete.',
    skepticReview: 'MISSING: no skeptic review in packet generator.',
    finalJudgment: 'WATCH only; no CPC read from price context or fight context alone.',
    whyNotPriceOnly: 'Price context is reference-only; no final CPC read is claimed without fighter-status, matchup, and card-change evidence.',
    wouldChangeView: [
      'Official card and fighter status are confirmed.',
      'Recent form and style matchup support the same side as any board signal.',
      'Late scratch, weight miss, or opponent change.',
    ],
  });
}

export function weekendDates(startIso) {
  const d = new Date(`${startIso}T00:00:00Z`);
  const fmt = (dt) => dt.toISOString().slice(0, 10);
  return [0, 1].map((off) => {
    const nd = new Date(d);
    nd.setUTCDate(d.getUTCDate() + off);
    return fmt(nd);
  });
}

function locateUfcArtifacts(stateRoot, dates) {
  const root = resolve(stateRoot, 'ufc');
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
        if (dates.includes(e)) {
          try {
            for (const f of readdirSync(p)) {
              const fp = join(p, f);
              if (statSync(fp).isFile() && f.endsWith('.json')) hits.push({ date: e, file: fp });
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

function slugText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function fighterToken(value) {
  const parts = String(value || '').replace(/['’]/g, '').split(/\s+/).map(slugText).filter(Boolean);
  return parts[parts.length - 1] || '';
}

function fightKeyFromNames(a, b) {
  const tokens = [fighterToken(a), fighterToken(b)].filter(Boolean).sort();
  return tokens.length === 2 ? tokens.join('-vs-') : null;
}

function fightNamesFromTitle(title) {
  const m = String(title || '').match(/([^:]+?\s+vs\.?\s+[^:]+)(?::|$)/i);
  const fightText = m ? m[1].trim() : '';
  const parts = fightText.split(/\s+vs\.?\s+/i);
  if (parts.length !== 2) return null;
  return { a: parts[0].trim(), b: parts[1].trim() };
}

function fightKeyFromEvent(event) {
  const titleNames = fightNamesFromTitle(event?.title);
  if (titleNames) return fightKeyFromNames(titleNames.a, titleNames.b);
  const markets = event?.markets || [];
  if (markets[0]?.yes_sub_title && markets[1]?.yes_sub_title) {
    return fightKeyFromNames(markets[0].yes_sub_title, markets[1].yes_sub_title);
  }
  return null;
}

function seriesFromEventTicker(ticker) {
  const m = String(ticker || '').match(/^([A-Z0-9]+)-/);
  return m ? m[1] : null;
}

function laneForSeries(series) {
  for (const [lane, ticker] of Object.entries(UFC_MARKET_LANES)) {
    if (ticker === series) return lane;
  }
  return null;
}

function loadCachedLaneEvents(stateRoot, date) {
  const eventDir = resolve(stateRoot, 'ufc', date, 'kalshi-events');
  if (!existsSync(eventDir)) return [];
  const out = [];
  for (const file of readdirSync(eventDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const event = JSON.parse(readFileSync(join(eventDir, file), 'utf8'));
      if (event?.event_ticker) out.push(event);
    } catch {}
  }
  return out;
}

function mergeEvents(...groups) {
  const seen = new Set();
  const merged = [];
  for (const group of groups) {
    for (const event of group || []) {
      const key = event?.event_ticker;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(event);
    }
  }
  return merged;
}

function marketEventsByFightKey(events) {
  const byFight = new Map();
  for (const event of events) {
    const lane = laneForSeries(seriesFromEventTicker(event?.event_ticker));
    if (!lane) continue;
    const fightKey = fightKeyFromEvent(event);
    if (!fightKey) continue;
    if (!byFight.has(fightKey)) byFight.set(fightKey, []);
    byFight.get(fightKey).push({ lane, event });
  }
  return byFight;
}

function loadCachedStats(fighterName, cacheDir) {
  const slug = slugText(fighterName);
  const cachePath = resolve(cacheDir, `${slug}.json`);
  if (!existsSync(cachePath)) return null;
  try {
    const data = JSON.parse(readFileSync(cachePath, 'utf8'));
    return data.stats || null;
  } catch {
    return null;
  }
}

function buildMarketContext(pair, laneEventsByFight) {
  const mc = { fighter_a_market: null, fighter_b_market: null, lane_events: [] };
  for (const m of pair.markets) {
    const entry = {
      ticker: m.ticker,
      yes_bid: m.yes_bid_dollars ?? null,
      yes_ask: m.yes_ask_dollars ?? null,
      last_price: m.last_price_dollars ?? null,
      volume: m.volume_fp ?? null,
    };
    if (m.yes_sub_title === pair.fighterAName) mc.fighter_a_market = entry;
    else if (m.yes_sub_title === pair.fighterBName) mc.fighter_b_market = entry;
  }
  for (const linked of laneEventsByFight.get(pair.fightKey) || []) {
    mc.lane_events.push({
      lane: linked.lane,
      event_ticker: linked.event.event_ticker,
      market_count: linked.event.markets?.length ?? 0,
      price_detail: 'inventory_only',
    });
  }
  return mc;
}

function emptyFighterEntry(reason = 'source data not fetched') {
  const emptyEntry = {};
  for (const def of LAYER_DEFS) {
    emptyEntry[def.key] = { present: false, score: null, missing_reason: reason };
  }
  return emptyEntry;
}

export function buildCompositeCard({ kalshiEvents, allLaneEvents = kalshiEvents, cacheDir, date }) {
  const pairs = [];
  for (const ev of kalshiEvents) {
    const markets = ev.markets || [];
    if (markets.length < 2) continue;
    const fighterAName = markets[0]?.yes_sub_title;
    const fighterBName = markets[1]?.yes_sub_title;
    if (!fighterAName || !fighterBName) continue;
    pairs.push({
      fighterAName,
      fighterBName,
      eventTicker: ev.event_ticker,
      eventTitle: ev.title,
      markets,
      fightKey: fightKeyFromEvent(ev),
    });
  }
  if (pairs.length === 0) return null;

  const laneEventsByFight = marketEventsByFightKey(allLaneEvents);
  const fights = [];
  const blockedFighters = [];

  for (const pair of pairs) {
    const aStats = loadCachedStats(pair.fighterAName, cacheDir);
    const bStats = loadCachedStats(pair.fighterBName, cacheDir);
    const marketContext = buildMarketContext(pair, laneEventsByFight);
    if (!aStats || !bStats) {
      if (!aStats) blockedFighters.push(pair.fighterAName);
      if (!bStats) blockedFighters.push(pair.fighterBName);
      fights.push(scoreFight({
        fighterA: aStats && bStats ? buildFighterEntry(aStats, bStats) : emptyFighterEntry(),
        fighterB: bStats && aStats ? buildFighterEntry(bStats, aStats) : emptyFighterEntry(),
        fighterAName: pair.fighterAName,
        fighterBName: pair.fighterBName,
        marketContext,
      }));
      continue;
    }
    const aEntry = buildFighterEntry(aStats, bStats);
    const bEntry = buildFighterEntry(bStats, aStats);
    fights.push(scoreFight({
      fighterA: aEntry,
      fighterB: bEntry,
      fighterAName: pair.fighterAName,
      fighterBName: pair.fighterBName,
      marketContext,
    }));
  }

  return {
    cardTitle: kalshiEvents[0]?.title?.replace(/:\s.*/, '') || 'UFC Card',
    fights,
    blockedFighters,
    totalFights: fights.length,
    scoredFights: fights.filter((f) => f.posture !== 'BLOCKED').length,
  };
}

function addNoPickSummary(lines, { sourcesChecked, missingInputs, noPickReason }) {
  lines.push(`  sources_checked: ${sourcesChecked}`);
  lines.push(`  missing_inputs: ${missingInputs}`);
  lines.push('  anti_price_statement: price context is reference-only and cannot create a CPC read by itself.');
  lines.push(`  no_rated_view_reason: ${noPickReason}`);
  lines.push('  telegram_send: disabled');
}

function addEdgeBasisSection(lines) {
  lines.push('--- Edge Basis ---');
  lines.push('- No evidence edge basis available. Fighter status, recent form, matchup context, and card-change checks are incomplete.');
}

function addMarketContextHeader(lines) {
  lines.push('--- Market Context - NOT IN SCORE ---');
  lines.push('anti_price_statement: price, volume, open interest, and line movement are market context only; they are NOT IN SCORE.');
  lines.push('line_movement: MISSING (not fetched by this packet).');
}

export function buildKalshiEventPacket({ event, dates, sourcePath }) {
  const s = summarizeEvent(event);
  const block = renderMarketBlocks(event, { limit: 40 });
  const process = buildUfcProcess({ event, marketCount: block.marketCount });
  const eventDate = (s.close && s.close.slice(0, 10)) || dates[0];
  const header = packetHeader({
    title: `Captain UFC — CPC Packet: ${s.title}`,
    date: eventDate,
    packetType: PACKET_TYPE,
    sources: [sourcePath, KALSHI_SOURCES.ufc.page_url],
  });
  const lines = [];
  lines.push('TLDR BOARD:');
  lines.push('  BLOCKED_MODEL_LAYER_MISSING');
  lines.push('');
  lines.push('=== BLOCKED — MODEL LAYER MISSING ===');
  lines.push(`No composite scoring available for this UFC event (${s.title}).`);
  lines.push(`Fight markets discovered: ${block.marketCount}`);
  lines.push('Next step: build UFC scoring pipeline (fighter status, matchup, recent form, card-change checks).');
  lines.push('Per-fighter market pricing is available in the audit inventory only.');
  lines.push('');
  lines.push('--- Market Context - NOT IN SCORE ---');
  lines.push('Market data stored in audit artifact for reference; not displayed in customer packet without model layer.');

  const inventoryLines = [];
  inventoryLines.push(renderDecisionProcess(process, { heading: 'Research Completeness' }));
  inventoryLines.push('');
  addEdgeBasisSection(inventoryLines);
  inventoryLines.push('');
  addMarketContextHeader(inventoryLines);
  inventoryLines.push(`event_ticker: ${s.ticker}`);
  inventoryLines.push(`event_title: ${s.title}`);
  inventoryLines.push(`event_sub_title: ${s.sub_title || 'MISSING'}`);
  inventoryLines.push(`series_ticker: ${s.series}`);
  inventoryLines.push(`window_utc: ${dates.join(' .. ')}`);
  inventoryLines.push(`market_count: ${s.marketCount}`);
  inventoryLines.push(`close_time_utc: ${s.close}`);
  inventoryLines.push('');
  inventoryLines.push('markets:');
  for (const l of block.lines) inventoryLines.push(l);
  inventoryLines.push('');
  inventoryLines.push('market_watch_notes (reference-only, not sportsbook quotes):');
  inventoryLines.push('  - confirm fighter records vs Kalshi market titles before publication (hard gate).');
  inventoryLines.push('  - check for last-minute card changes (scratches, weight misses).');

  return {
    text: header + lines.join('\n') + packetFooter(),
    inventoryText: inventoryLines.join('\n'),
    marketCount: block.marketCount,
    missingStrikeCount: block.missingStrikeCount,
    missingMarkets: block.missingMarkets,
  };
}

export function buildLegacyEventPacket({ weekendDates: wd, event }) {
  const data = readJsonIfExists(event.file) || {};
  const process = buildUfcProcess({ legacy: data, marketCount: 0 });
  const eventName = data.event_name || data.name || event.file.split('/').pop().replace(/\.json$/, '');
  const fights = data.fights || data.card || [];
  const header = packetHeader({
    title: `Captain UFC — CPC Packet: ${eventName}`,
    date: event.date,
    packetType: PACKET_TYPE,
    sources: [event.file],
  });
  const lines = [];
  lines.push('TLDR BOARD:');
  lines.push('  BLOCKED_MODEL_LAYER_MISSING');
  lines.push('');
  lines.push('=== BLOCKED — MODEL LAYER MISSING ===');
  lines.push(`No composite scoring available for this UFC event (${eventName}).`);
  lines.push('Fight markets discovered: 0 (legacy artifact only)');
  lines.push('Next step: build UFC scoring pipeline (fighter status, matchup, recent form, card-change checks).');
  lines.push('Per-fighter data is available in the audit inventory only.');
  lines.push('');
  lines.push('--- Market Context - NOT IN SCORE ---');
  lines.push('Market data stored in audit artifact for reference; not displayed in customer packet without model layer.');

  const inventoryLines = [];
  inventoryLines.push(renderDecisionProcess(process, { heading: 'Research Completeness' }));
  inventoryLines.push('');
  addEdgeBasisSection(inventoryLines);
  inventoryLines.push('');
  addMarketContextHeader(inventoryLines);
  inventoryLines.push(`event_name: ${eventName}`);
  inventoryLines.push(`event_date_utc: ${event.date}`);
  inventoryLines.push(`weekend_window_utc: ${wd.join(' .. ')}`);
  inventoryLines.push(`venue: ${data.venue || 'MISSING'}`);
  inventoryLines.push(`broadcast: ${data.broadcast || 'MISSING'}`);
  inventoryLines.push('');
  inventoryLines.push('fights:');
  if (Array.isArray(fights) && fights.length) {
    for (const f of fights) {
      const a = f.fighter_a || f.a || 'MISSING';
      const b = f.fighter_b || f.b || 'MISSING';
      const weight = f.weight_class || f.weight || 'MISSING';
      const slot = f.slot || f.card_position || 'MISSING';
      inventoryLines.push(`  - ${a} vs ${b}  |  weight: ${weight}  |  slot: ${slot}`);
    }
  } else {
    inventoryLines.push('  MISSING');
  }

  return {
    text: header + lines.join('\n') + packetFooter(),
    inventoryText: inventoryLines.join('\n'),
  };
}

export function buildEmptyPacket(date, dates, discovery) {
  const process = evaluateDecisionProcess({
    marketType: MARKET_TYPES.SPORTS_GAME,
    rawDecision: 'PASS',
    checked: {},
    settlementRules: 'MISSING: no UFC event packet.',
    verifiedFacts: 'MISSING: no UFC events discovered.',
    marketSignalText: 'No price context captured.',
    socialChatter: 'Not used.',
    inference: 'No inference.',
    skepticReview: 'MISSING.',
    finalJudgment: 'PASS.',
    whyNotPriceOnly: 'No final rated view is claimed without verified UFC event and fighter evidence.',
  });
  return (
    packetHeader({
      title: 'Captain UFC — CPC Packet: No Events',
      date,
      packetType: PACKET_TYPE,
      sources: [KALSHI_SOURCES.ufc.api_url, KALSHI_SOURCES.ufc.page_url],
    }) +
    [
      'TLDR:',
      `  market_type: ${process.marketType}`,
      '  decision_status: no rated view',
      '  note: no UFC events found; no rated view.',
      '  sources_checked: Kalshi UFC API and calendar page.',
      '  missing_inputs: UFC event, fighter status, recent form, matchup context, card-change checks, settlement criteria.',
      '  anti_price_statement: price context is reference-only and cannot create a CPC read by itself.',
      '  no_rated_view_reason: no UFC event data was discovered inside the weekend window.',
      '  telegram_send: disabled',
      '',
      renderDecisionProcess(process, { heading: 'Research Completeness' }),
      '',
      '--- Edge Basis ---',
      '- No evidence edge basis available. UFC event and fighter evidence are incomplete.',
      '',
      '--- Market Context - NOT IN SCORE ---',
      'anti_price_statement: price, volume, open interest, and line movement are market context only; they are NOT IN SCORE.',
      'line_movement: MISSING (no price context captured).',
      '',
      'kalshi_discovery:',
      `  source_page: ${KALSHI_SOURCES.ufc.page_url}`,
      `  source_api: ${KALSHI_SOURCES.ufc.api_url}`,
      `  reachable: ${discovery.ok ? 'yes' : 'no'}`,
      `  total_events: ${discovery.events.length}`,
      ...(discovery.error ? [`  error: ${discovery.error}`] : []),
      '',
      'status: MISSING',
      `reason: no Kalshi UFC events with derived event-date inside weekend window ${dates.join(' .. ')}.`,
      'posture: PASS (no data)',
    ].join('\n') +
    packetFooter()
  );
}

async function main() {
  const opts = parsePacketArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node scripts/packets/generate-ufc-weekly.mjs --date YYYY-MM-DD [--dry-run]');
    return;
  }
  const dir = ensurePacketDir(opts.stateRoot, opts.date, PACKET_TYPE);
  const dates = weekendDates(opts.date);
  const cacheDir = resolve(opts.stateRoot, 'ufc', 'sources');

  const discovery = await fetchKalshiEvents('ufc');
  const dateFilter = filterByEventDate(opts.date, { windowDays: WEEKEND_DAYS, allowUndated: false });
  const liveWinnerEvents = discovery.events.filter(dateFilter);
  const cachedLaneEvents = loadCachedLaneEvents(opts.stateRoot, opts.date).filter(dateFilter);
  const cachedWinnerEvents = cachedLaneEvents.filter((ev) => seriesFromEventTicker(ev.event_ticker) === UFC_MARKET_LANES.winner);
  const kalshiEvents = mergeEvents(liveWinnerEvents, cachedWinnerEvents);
  const allLaneEvents = mergeEvents(cachedLaneEvents, liveWinnerEvents);
  let persisted = { written: [] };
  if (liveWinnerEvents.length) {
    persisted = persistEventArtifacts({
      stateRoot: opts.stateRoot,
      sport: 'ufc',
      date: opts.date,
      events: liveWinnerEvents,
    });
  }

  const localEvents = locateUfcArtifacts(opts.stateRoot, dates);
  let totalMarketCount = 0;
  let missingMarketEventCount = 0;
  let missingStrikeTextCount = 0;
  const items = [];

  if (!kalshiEvents.length && !localEvents.length) {
    const txt = buildEmptyPacket(opts.date, dates, discovery);
    assertCpcPacketValid(txt, 'ufc-empty');
    const w = writeAudit(dir, `${opts.date}-no-events`, txt, {
      event_count: 0,
      total_market_count: 0,
      missing_market_count: 0,
      missing_strike_text_count: 0,
      weekend_dates: dates,
      kalshi_discovery: { ok: discovery.ok, error: discovery.error, total: discovery.events.length, matched: 0 },
    });
    items.push({ name: 'no-events', ...w });
  } else {
    const compositeResult = buildCompositeCard({ kalshiEvents, allLaneEvents, cacheDir, date: opts.date });
    if (compositeResult && compositeResult.scoredFights > 0) {
      const packetText = renderUfcPacket({
        cardTitle: compositeResult.cardTitle,
        date: opts.date,
        card: { fights: compositeResult.fights },
        sources: ['UFCStats.com', KALSHI_SOURCES.ufc.page_url],
      });
      const inventoryText = renderUfcInventory({
        cardTitle: compositeResult.cardTitle,
        date: opts.date,
        card: { fights: compositeResult.fights },
        kalshiEvents,
      });
      const modelScoresText = renderUfcModelScores({
        cardTitle: compositeResult.cardTitle,
        date: opts.date,
        card: { fights: compositeResult.fights },
      });
      assertCpcPacketValid(packetText, 'ufc-composite');

      const stem = `${opts.date}-composite`;
      const invW = writeAudit(dir, `${stem}.inventory`, inventoryText, {
        kind: 'raw_inventory_audit',
        scored_fights: compositeResult.scoredFights,
        blocked_fighters: compositeResult.blockedFighters,
      });
      items.push({ name: `${stem}.inventory`, ...invW });
      const modelScoresW = writeAudit(dir, `${stem}.model-scores`, modelScoresText, {
        kind: 'model_score_matrix',
        scored_fights: compositeResult.scoredFights,
        total_fights: compositeResult.totalFights,
        pricing_excluded: true,
      });
      items.push({ name: `${stem}.model-scores`, ...modelScoresW });
      const w = writeAudit(dir, stem, packetText, {
        scored_fights: compositeResult.scoredFights,
        total_fights: compositeResult.totalFights,
        blocked_fighters: compositeResult.blockedFighters,
        kalshi_lane_event_count: allLaneEvents.length,
      });
      items.push({ name: stem, ...w });
      totalMarketCount = allLaneEvents.reduce((s, e) => s + (e.markets?.length || 0), 0);
    } else {
      for (const ev of kalshiEvents) {
      const ticker = ev?.event_ticker;
      if (!ticker) continue;
      const sourcePath = resolve(opts.stateRoot, 'ufc', opts.date, 'kalshi-events', `${ticker.replace(/[^A-Z0-9_-]/gi, '_').slice(0, 80)}.json`);
      const built = buildKalshiEventPacket({ event: ev, dates, sourcePath });
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
      assertCpcPacketValid(built.text, `ufc-${ticker}`);
      const w = writeAudit(dir, `${opts.date}-${ticker}`, built.text, {
        event_ticker: ticker,
        market_count: built.marketCount,
        missing_markets: built.missingMarkets,
        missing_strike_text_count: built.missingStrikeCount,
        kalshi_source_api: KALSHI_SOURCES.ufc.api_url,
        kalshi_source_page: KALSHI_SOURCES.ufc.page_url,
      });
      items.push({ name: ticker, ...w });
    }
    }
    for (const ev of localEvents) {
      const baseName = `${ev.date}-${ev.file.split('/').pop().replace(/\.json$/, '')}`;
      const built = buildLegacyEventPacket({ weekendDates: dates, event: ev });
      if (built.inventoryText) {
        const invW = writeAudit(dir, `${baseName}.inventory`, built.inventoryText, {
          kind: 'raw_inventory_audit',
          source_file: ev.file,
        });
        items.push({ name: `${baseName}.inventory`, ...invW });
      }
      assertCpcPacketValid(built.text, `ufc-${baseName}`);
      const w = writeAudit(dir, baseName, built.text, { source_file: ev.file });
      items.push({ name: baseName, ...w });
    }
  }

  let exitCode = 0;
  if (kalshiEvents.length > 0 && totalMarketCount === 0) {
    console.error(`[${PACKET_TYPE}] FAIL: ${kalshiEvents.length} events but zero markets total.`);
    exitCode = 2;
  }

  console.log(printDryRunSummary({ packetType: PACKET_TYPE, date: opts.date, dir, items }));
  console.log(`[${PACKET_TYPE}] summary event_count=${kalshiEvents.length} total_market_count=${totalMarketCount} packets_written=${items.length} missing_market_count=${missingMarketEventCount} missing_strike_text_count=${missingStrikeTextCount} persisted=${persisted.written.length} local=${localEvents.length}`);
  if (exitCode) process.exit(exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`[${PACKET_TYPE}] error: ${err.message}`);
    process.exit(1);
  });
}
