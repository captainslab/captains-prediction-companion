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
import { evaluateDecisionProcess, MARKET_TYPES, renderDecisionProcess } from '../shared/decision-process.mjs';

export const PACKET_TYPE = 'ufc-weekly';
const WEEKEND_DAYS = 1; // Sat + Sun -> windowDays=1

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
      marketCount > 0 ? `Kalshi fight board captured with ${marketCount} market(s).` : null,
      legacy?.venue ? `Venue supplied: ${legacy.venue}.` : null,
    ].filter(Boolean),
    settlementRules: 'UFC market settlement criteria not independently pulled by this packet.',
    verifiedFacts: hasParticipants ? 'Participants/market contracts captured; fighter status context still required.' : 'No participants verified.',
    marketSignalText: marketCount > 0 ? 'Market board captured for research; no pick inferred.' : 'No market board captured.',
    socialChatter: 'Not used as verified fact.',
    inference: 'Fight inference blocked until fighter status, matchup, recent form, and card-change checks are complete.',
    skepticReview: 'MISSING: no skeptic review in packet generator.',
    finalJudgment: 'WATCH only; no evidence lean from fight board alone.',
    whyNotPriceOnly: 'Market-board data is reference-only; no final pick is claimed without fighter-status, matchup, and card-change evidence.',
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

function addNoPickSummary(lines, { sourcesChecked, missingInputs, noPickReason }) {
  lines.push(`  sources_checked: ${sourcesChecked}`);
  lines.push(`  missing_inputs: ${missingInputs}`);
  lines.push('  anti_price_statement: market-board data is reference-only and cannot support a pick by itself.');
  lines.push(`  no_pick_reason: ${noPickReason}`);
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
  lines.push('TLDR:');
  lines.push(`  market_type: ${process.marketType}`);
  lines.push(`  decision_status: ${process.decisionStatus}`);
  lines.push('  note: fight board only; no evidence lean without fighter status and matchup context.');
  addNoPickSummary(lines, {
    sourcesChecked: 'Kalshi UFC event/market board; persisted source JSON when available.',
    missingInputs: 'fighter status, recent form, matchup context, card-change checks, settlement criteria.',
    noPickReason: 'fighter evidence is incomplete; no side is evidence-supported beyond market data.',
  });
  lines.push('');
  lines.push(renderDecisionProcess(process, { heading: 'Research Completeness' }));
  lines.push('');
  addEdgeBasisSection(lines);
  lines.push('');
  addMarketContextHeader(lines);
  lines.push(`event_ticker: ${s.ticker}`);
  lines.push(`event_title: ${s.title}`);
  lines.push(`event_sub_title: ${s.sub_title || 'MISSING'}`);
  lines.push(`series_ticker: ${s.series}`);
  lines.push(`window_utc: ${dates.join(' .. ')}`);
  lines.push(`market_count: ${s.marketCount}`);
  lines.push(`close_time_utc: ${s.close}`);
  lines.push('');
  lines.push('markets:');
  for (const l of block.lines) lines.push(l);
  lines.push('');
  lines.push('market_watch_notes (reference-only, not sportsbook quotes):');
  lines.push('  - confirm fighter records vs Kalshi market titles before publication (hard gate).');
  lines.push('  - check for last-minute card changes (scratches, weight misses).');
  return {
    text: header + lines.join('\n') + packetFooter(),
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
  lines.push('TLDR:');
  lines.push(`  market_type: ${process.marketType}`);
  lines.push(`  decision_status: ${process.decisionStatus}`);
  lines.push('  note: legacy fight packet; no evidence lean without complete fight context.');
  addNoPickSummary(lines, {
    sourcesChecked: 'local UFC event JSON.',
    missingInputs: 'Kalshi market board, fighter status, recent form, matchup context, card-change checks, settlement criteria.',
    noPickReason: 'complete fight context is unavailable; no side is evidence-supported beyond supplied event data.',
  });
  lines.push('');
  lines.push(renderDecisionProcess(process, { heading: 'Research Completeness' }));
  lines.push('');
  addEdgeBasisSection(lines);
  lines.push('');
  addMarketContextHeader(lines);
  lines.push(`event_name: ${eventName}`);
  lines.push(`event_date_utc: ${event.date}`);
  lines.push(`weekend_window_utc: ${wd.join(' .. ')}`);
  lines.push(`venue: ${data.venue || 'MISSING'}`);
  lines.push(`broadcast: ${data.broadcast || 'MISSING'}`);
  lines.push('');
  lines.push('fights:');
  if (Array.isArray(fights) && fights.length) {
    for (const f of fights) {
      const a = f.fighter_a || f.a || 'MISSING';
      const b = f.fighter_b || f.b || 'MISSING';
      const weight = f.weight_class || f.weight || 'MISSING';
      const slot = f.slot || f.card_position || 'MISSING';
      lines.push(`  - ${a} vs ${b}  |  weight: ${weight}  |  slot: ${slot}`);
    }
  } else {
    lines.push('  MISSING');
  }
  return header + lines.join('\n') + packetFooter();
}

export function buildEmptyPacket(date, dates, discovery) {
  const process = evaluateDecisionProcess({
    marketType: MARKET_TYPES.SPORTS_GAME,
    rawDecision: 'NO CLEAR PICK',
    checked: {},
    settlementRules: 'MISSING: no UFC event packet.',
    verifiedFacts: 'MISSING: no UFC events discovered.',
    marketSignalText: 'No market board captured.',
    socialChatter: 'Not used.',
    inference: 'No inference.',
    skepticReview: 'MISSING.',
    finalJudgment: 'NO CLEAR PICK.',
    whyNotPriceOnly: 'No final pick is claimed without verified UFC event and fighter evidence.',
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
      `  decision_status: ${process.decisionStatus}`,
      '  note: no UFC events found; no pick or lean.',
      '  sources_checked: Kalshi UFC API and calendar page.',
      '  missing_inputs: UFC event, fighter status, recent form, matchup context, card-change checks, settlement criteria.',
      '  anti_price_statement: market-board data is reference-only and cannot support a pick by itself.',
      '  no_pick_reason: no UFC event data was discovered inside the weekend window.',
      '  telegram_send: disabled',
      '',
      renderDecisionProcess(process, { heading: 'Research Completeness' }),
      '',
      '--- Edge Basis ---',
      '- No evidence edge basis available. UFC event and fighter evidence are incomplete.',
      '',
      '--- Market Context - NOT IN SCORE ---',
      'anti_price_statement: price, volume, open interest, and line movement are market context only; they are NOT IN SCORE.',
      'line_movement: MISSING (no market board captured).',
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

  const discovery = await fetchKalshiEvents('ufc');
  const dateFilter = filterByEventDate(opts.date, { windowDays: WEEKEND_DAYS, allowUndated: false });
  const kalshiEvents = discovery.events.filter(dateFilter);
  let persisted = { written: [] };
  if (kalshiEvents.length) {
    persisted = persistEventArtifacts({
      stateRoot: opts.stateRoot,
      sport: 'ufc',
      date: opts.date,
      events: kalshiEvents,
    });
  }

  const localEvents = locateUfcArtifacts(opts.stateRoot, dates);
  let totalMarketCount = 0;
  let missingMarketEventCount = 0;
  let missingStrikeTextCount = 0;
  const items = [];

  if (!kalshiEvents.length && !localEvents.length) {
    const txt = buildEmptyPacket(opts.date, dates, discovery);
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
    for (const ev of kalshiEvents) {
      const ticker = ev?.event_ticker;
      if (!ticker) continue;
      const sourcePath = resolve(opts.stateRoot, 'ufc', opts.date, 'kalshi-events', `${ticker.replace(/[^A-Z0-9_-]/gi, '_').slice(0, 80)}.json`);
      const built = buildKalshiEventPacket({ event: ev, dates, sourcePath });
      totalMarketCount += built.marketCount;
      if (built.missingMarkets) missingMarketEventCount += 1;
      missingStrikeTextCount += built.missingStrikeCount;
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
    for (const ev of localEvents) {
      const baseName = `${ev.date}-${ev.file.split('/').pop().replace(/\.json$/, '')}`;
      const txt = buildLegacyEventPacket({ weekendDates: dates, event: ev });
      const w = writeAudit(dir, baseName, txt, { source_file: ev.file });
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
