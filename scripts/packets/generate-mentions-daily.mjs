#!/usr/bin/env node
// Mentions daily packet generator.
// One packet per Kalshi Mentions event. No trades. No execution.
// Marks MISSING when source data is unavailable instead of inventing.
//
// Routing rules:
//   * Events are containers. event.event_ticker, title, sub_title, series.
//   * Markets are the contracts. Each gets its own block under the event.
//   * Display strike text comes from market title/subtitle/strike fields,
//     never from ticker shorthand.
//   * Undated long-horizon events are DROPPED from daily windows unless the
//     caller explicitly enables --allow-undated.

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
  KALSHI_SOURCES,
} from './lib/kalshi-discovery.mjs';
import { evaluateDecisionProcess, MARKET_TYPES, renderDecisionProcess } from '../shared/decision-process.mjs';

const PACKET_TYPE = 'mentions-daily';
const DEFAULT_WINDOW_DAYS = 7; // forward-looking week
const PACKET_LIMIT = 60;       // safety cap on packets emitted per run

function firstMarketRules(event) {
  const markets = Array.isArray(event?.markets) ? event.markets : [];
  const m = markets.find((x) => x?.rules_primary || x?.rules_secondary);
  return {
    primary: m?.rules_primary || null,
    secondary: m?.rules_secondary || null,
  };
}

function buildMentionProcess({ event, hasLocalEvidence = false, legacy = null }) {
  const rules = legacy
    ? { primary: legacy.resolution || legacy.resolution_mechanics || null, secondary: null }
    : firstMarketRules(event);
  const marketCount = Array.isArray(event?.markets) ? event.markets.length : 0;
  return evaluateDecisionProcess({
    marketType: MARKET_TYPES.MENTION_MARKET,
    rawDecision: 'WATCH',
    forceWatch: true,
    checked: {
      exact_settlement_wording: Boolean(rules.primary || rules.secondary),
      likely_event_source: Boolean(legacy?.event_context || legacy?.context),
      word_matching_rules_aliases: Boolean(rules.primary || rules.secondary),
      recent_public_statements: hasLocalEvidence,
      official_schedule_event: Boolean(legacy?.official_schedule || legacy?.schedule),
      x_chatter_separated: true,
      market_board_context: marketCount > 0 || Boolean(legacy),
    },
    topEvidence: [
      marketCount > 0 ? `Kalshi board captured with ${marketCount} market(s).` : null,
      rules.primary ? 'Settlement wording present in source packet.' : null,
      hasLocalEvidence ? 'Legacy source evidence present.' : null,
    ].filter(Boolean),
    settlementRules: rules.primary || rules.secondary || 'MISSING: exact settlement wording not present in packet.',
    verifiedFacts: hasLocalEvidence ? 'Legacy source evidence present; requires research review.' : 'No verified transcript/event facts supplied by packet generator.',
    marketSignalText: marketCount > 0 ? 'Market board captured for research; no pick inferred.' : 'No market board captured.',
    socialChatter: 'Separated: packet generator does not promote X chatter to fact.',
    inference: 'Mention-market inference blocked until exact source, transcript path, and word-match rules are checked.',
    skepticReview: 'MISSING: no skeptic review in packet generator.',
    finalJudgment: 'WATCH only; no pick without exact wording, source/event path, and public statement/schedule evidence.',
    wouldChangeView: [
      'Official event or transcript source is identified.',
      'Exact word-match/alias rules are confirmed.',
      'Recent official/public statement context supports one side.',
    ],
  });
}

export function discoverMentionEvents(stateRoot, date) {
  const roots = [
    resolve(stateRoot, 'mentions', date),
    resolve(stateRoot, 'mentions', 'events', date),
    resolve('channels', 'mentions', date),
  ];
  const events = [];
  for (const root of roots) {
    if (!existsSync(root) || !statSync(root).isDirectory()) continue;
    for (const entry of readdirSync(root)) {
      const p = join(root, entry);
      try {
        if (!statSync(p).isFile()) continue;
        if (!/\.(json|md)$/i.test(entry)) continue;
        const raw = readFileSync(p, 'utf8');
        let parsed = null;
        if (entry.endsWith('.json')) parsed = readJsonIfExists(p);
        events.push({ file: p, name: entry, body: raw, parsed });
      } catch {}
    }
  }
  return events;
}

function buildKalshiEventPacket({ date, event, sourceUrl }) {
  const s = summarizeEvent(event);
  const block = renderMarketBlocks(event, { limit: PACKET_LIMIT });
  const process = buildMentionProcess({ event });
  const header = packetHeader({
    title: 'Captain Mentions — Daily Event Packet',
    date,
    packetType: PACKET_TYPE,
    sources: [sourceUrl, KALSHI_SOURCES.mentions.page_url],
  });
  const lines = [];
  lines.push('TLDR:');
  lines.push(`  market_type: ${process.marketType}`);
  lines.push(`  decision_status: ${process.decisionStatus}`);
  lines.push('  note: no pick without exact wording, source/event path, and transcript/public-statement evidence.');
  lines.push('');
  lines.push(renderDecisionProcess(process, { heading: 'Research Completeness' }));
  lines.push('');
  lines.push(`event_ticker: ${s.ticker}`);
  lines.push(`event_title: ${s.title}`);
  lines.push(`event_sub_title: ${s.sub_title || 'MISSING'}`);
  lines.push(`series_ticker: ${s.series}`);
  lines.push(`market_count: ${s.marketCount}`);
  lines.push(`close_time_utc: ${s.close}`);
  lines.push('');
  lines.push('markets:');
  for (const l of block.lines) lines.push(l);
  lines.push('');
  lines.push('resolution_mechanics:');
  lines.push('  See market.rules_primary/rules_secondary per Kalshi listing.');
  lines.push('  Verify exact-string mention criteria before publishing.');
  lines.push('');
  lines.push('verified_vs_inference: MISSING (research-only packet; verification required by mentions-researcher)');
  lines.push(`decision_status: ${process.decisionStatus}`);
  lines.push('posture: WATCH (insufficient verified evidence; not a real pick)');
  return {
    text: header + lines.join('\n') + packetFooter(),
    marketCount: block.marketCount,
    missingStrikeCount: block.missingStrikeCount,
    missingMarkets: block.missingMarkets,
  };
}

function buildLegacyEventPacket({ date, event }) {
  const p = event.parsed || {};
  const process = buildMentionProcess({ event: null, hasLocalEvidence: Boolean((p.evidence || p.sources || []).length), legacy: p });
  const header = packetHeader({
    title: 'Captain Mentions — Daily Event Packet (legacy artifact)',
    date,
    packetType: PACKET_TYPE,
    sources: [event.file],
  });
  const lines = [];
  lines.push('TLDR:');
  lines.push(`  market_type: ${process.marketType}`);
  lines.push(`  decision_status: ${process.decisionStatus}`);
  lines.push('  note: legacy artifact requires settlement/source review before any lean.');
  lines.push('');
  lines.push(renderDecisionProcess(process, { heading: 'Research Completeness' }));
  lines.push('');
  lines.push(`event_id: ${p.event_id || p.id || 'MISSING'}`);
  lines.push(`target_phrase: ${p.target_phrase || p.phrase || 'MISSING'}`);
  lines.push(`speaker_or_company: ${p.speaker || p.company || p.entity || 'MISSING'}`);
  lines.push(`event_context: ${p.context || p.event_context || 'MISSING'}`);
  lines.push('');
  lines.push('resolution_mechanics:');
  lines.push(`  ${p.resolution || p.resolution_mechanics || 'MISSING'}`);
  lines.push('');
  lines.push('source_evidence:');
  const evidence = p.evidence || p.sources || [];
  if (Array.isArray(evidence) && evidence.length) {
    for (const e of evidence) lines.push(`  - ${typeof e === 'string' ? e : JSON.stringify(e)}`);
  } else {
    lines.push('  MISSING');
  }
  lines.push('');
  lines.push(`verified_vs_inference: ${p.verified_vs_inference || 'MISSING'}`);
  lines.push(`decision_status: ${process.decisionStatus}`);
  lines.push(`posture: ${p.posture || 'WATCH (insufficient verified evidence; not a real pick)'}`);
  return header + lines.join('\n') + packetFooter();
}

function buildEmptyDayPacket(date, primeAttempts = [], discovery = null) {
  const process = evaluateDecisionProcess({
    marketType: MARKET_TYPES.MENTION_MARKET,
    rawDecision: 'NO CLEAR PICK',
    checked: { x_chatter_separated: true },
    settlementRules: 'MISSING: no market/event packet.',
    verifiedFacts: 'MISSING: no events discovered.',
    marketSignalText: 'No market board captured.',
    socialChatter: 'Not used.',
    inference: 'No inference.',
    skepticReview: 'MISSING.',
    finalJudgment: 'NO CLEAR PICK.',
  });
  return (
    packetHeader({
      title: 'Captain Mentions — Daily Event Packet',
      date,
      packetType: PACKET_TYPE,
      sources: discovery?.source ? [discovery.source.api_url, discovery.source.page_url] : [],
    }) +
    [
      'TLDR:',
      `  market_type: ${process.marketType}`,
      `  decision_status: ${process.decisionStatus}`,
      '  note: no events found; no pick or lean.',
      '',
      renderDecisionProcess(process, { heading: 'Research Completeness' }),
      '',
      'research_prime:',
      ...(primeAttempts.length
        ? primeAttempts.flatMap(attempt => [
            `  - command: ${attempt.label}`,
            `    status: ${attempt.ok ? 'ok' : 'MISSING'}`,
            ...(attempt.ok ? [] : [`    error: ${attempt.error || attempt.stderr || 'command unavailable'}`]),
          ])
        : ['  - MISSING: no discovery command attempted']),
      '',
      'kalshi_discovery:',
      `  source_page: ${KALSHI_SOURCES.mentions.page_url}`,
      `  source_api: ${KALSHI_SOURCES.mentions.api_url}`,
      `  reachable: ${discovery?.ok ? 'yes' : 'no'}`,
      ...(discovery?.error ? [`  error: ${discovery.error}`] : []),
      '',
      'status: MISSING',
      `reason: no Kalshi Mentions events found with derived event-date inside window [${date}, +${DEFAULT_WINDOW_DAYS}d].`,
      'posture: PASS (no data)',
    ].join('\n') +
    packetFooter()
  );
}

export function resolveMentionDiscoveryWorkflow(options = {}) {
  const commandPath = resolve('scripts', 'mentions', 'mentions-workspace.mjs');
  if (existsSync(commandPath)) {
    return {
      available: true,
      command: 'node',
      argsForDate: date => [commandPath, 'discover', '--date', date, '--live-readonly'],
      note: 'Detected scripts/mentions/mentions-workspace.mjs.',
    };
  }
  const alternatePath = resolve('scripts', 'mentions', 'discover.mjs');
  if (existsSync(alternatePath)) {
    return {
      available: true,
      command: 'node',
      argsForDate: date => [alternatePath, '--date', date, '--live-readonly'],
      note: 'Detected scripts/mentions/discover.mjs.',
    };
  }
  return {
    available: false,
    missing_interface:
      'No safe mention discovery CLI found. Expected one of: node scripts/mentions/mentions-workspace.mjs discover --date <date> --live-readonly; node scripts/mentions/discover.mjs --date <date> --live-readonly.',
  };
}

export function primeMentionResearch(date, options = {}) {
  const workflow = options.workflow ?? resolveMentionDiscoveryWorkflow();
  if (!workflow.available) {
    return [{ ok: false, skipped: true, label: 'mentions discovery workflow', status: null, stderr: workflow.missing_interface, error: workflow.missing_interface }];
  }
  return [runPacketCommand(workflow.command, workflow.argsForDate(date), { cwd: options.cwd ?? process.cwd(), runner: options.runner })];
}

function parseExtraArgs(argv) {
  // Lets caller pass --allow-undated and --window-days N without breaking parsePacketArgs.
  const passthrough = [];
  const extra = { allowUndated: false, windowDays: DEFAULT_WINDOW_DAYS };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--allow-undated') extra.allowUndated = true;
    else if (a === '--window-days') { extra.windowDays = Number(argv[++i]); }
    else passthrough.push(a);
  }
  if (!Number.isFinite(extra.windowDays)) extra.windowDays = DEFAULT_WINDOW_DAYS;
  return { passthrough, extra };
}

async function main() {
  const { passthrough, extra } = parseExtraArgs(process.argv.slice(2));
  const opts = parsePacketArgs(passthrough);
  if (opts.help) {
    console.log('Usage: node scripts/packets/generate-mentions-daily.mjs --date YYYY-MM-DD [--dry-run] [--window-days N] [--allow-undated]');
    return;
  }
  const dir = ensurePacketDir(opts.stateRoot, opts.date, PACKET_TYPE);
  const primeAttempts = primeMentionResearch(opts.date);

  const discovery = await fetchKalshiEvents('mentions');
  const dateFilter = filterByEventDate(opts.date, {
    windowDays: extra.windowDays,
    allowUndated: extra.allowUndated,
  });
  const filteredEvents = discovery.events.filter(dateFilter);

  let persistedCount = 0;
  if (filteredEvents.length) {
    const persisted = persistEventArtifacts({
      stateRoot: opts.stateRoot,
      sport: 'mentions',
      date: opts.date,
      events: filteredEvents,
    });
    persistedCount = persisted.written.length;
  }

  const localEvents = discoverMentionEvents(opts.stateRoot, opts.date);

  let totalMarketCount = 0;
  let missingMarketEventCount = 0;
  let missingStrikeTextCount = 0;
  const items = [];

  if (!localEvents.length && !filteredEvents.length) {
    const txt = buildEmptyDayPacket(opts.date, primeAttempts, discovery);
    const w = writeAudit(dir, `${opts.date}-no-events`, txt, {
      event_count: 0,
      total_market_count: 0,
      missing_market_count: 0,
      missing_strike_text_count: 0,
      window_days: extra.windowDays,
      allow_undated: extra.allowUndated,
      kalshi_discovery: { ok: discovery.ok, error: discovery.error, total_returned: discovery.events.length, window_matched: filteredEvents.length },
      research_prime: primeAttempts.map(({ label, ok, status, stderr, error, skipped }) => ({ label, ok, status, stderr, error, skipped })),
    });
    items.push({ name: 'no-events', ...w });
  } else {
    const seen = new Set();
    for (const ev of filteredEvents) {
      const ticker = ev?.event_ticker;
      if (!ticker || seen.has(ticker)) continue;
      seen.add(ticker);
      const sourcePath = resolve(opts.stateRoot, 'mentions', opts.date, 'kalshi-events', `${ticker.replace(/[^A-Z0-9_-]/gi, '_').slice(0, 80)}.json`);
      const built = buildKalshiEventPacket({ date: opts.date, event: ev, sourceUrl: sourcePath });
      totalMarketCount += built.marketCount;
      if (built.missingMarkets) missingMarketEventCount += 1;
      missingStrikeTextCount += built.missingStrikeCount;
      const w = writeAudit(dir, `${opts.date}-${ticker}`, built.text, {
        event_ticker: ticker,
        market_count: built.marketCount,
        missing_markets: built.missingMarkets,
        missing_strike_text_count: built.missingStrikeCount,
        kalshi_source_api: KALSHI_SOURCES.mentions.api_url,
        kalshi_source_page: KALSHI_SOURCES.mentions.page_url,
      });
      items.push({ name: ticker, ...w });
    }
    for (const ev of localEvents) {
      const baseName = `${opts.date}-${(ev.parsed?.event_id || ev.name).toString()}`;
      const txt = buildLegacyEventPacket({ date: opts.date, event: ev });
      const w = writeAudit(dir, baseName, txt, {
        source_file: ev.file,
        research_prime: primeAttempts.map(({ label, ok, status, stderr, error, skipped }) => ({ label, ok, status, stderr, error, skipped })),
      });
      items.push({ name: baseName, ...w });
    }
  }

  const eventCount = filteredEvents.length + localEvents.length;
  // Guard: event_count > 0 but total_market_count === 0 -> fail (Kalshi side only).
  let exitCode = 0;
  if (filteredEvents.length > 0 && totalMarketCount === 0) {
    console.error(`[${PACKET_TYPE}] FAIL: ${filteredEvents.length} Kalshi events but zero markets across all of them.`);
    exitCode = 2;
  }

  console.log(printDryRunSummary({ packetType: PACKET_TYPE, date: opts.date, dir, items }));
  console.log(`[${PACKET_TYPE}] summary event_count=${eventCount} kalshi_window_matched=${filteredEvents.length} total_market_count=${totalMarketCount} packets_written=${items.length} missing_market_count=${missingMarketEventCount} missing_strike_text_count=${missingStrikeTextCount} persisted=${persistedCount} window_days=${extra.windowDays} allow_undated=${extra.allowUndated}`);
  if (exitCode) process.exit(exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`[${PACKET_TYPE}] error: ${err.message}`);
    process.exit(1);
  });
}
