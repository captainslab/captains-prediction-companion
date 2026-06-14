#!/usr/bin/env node
// collect-mentions-research.mjs
//
// Reads state/mentions/<date>/kalshi-events/*.json
// Infers mention profile per event
// Collects source-backed evidence via read-only web lookup
// Writes state/mentions/<date>/research/*.json with layer_records + source_ladder_inputs
//
// NEVER includes pricing fields in research records.
// Pure ESM. No trades. No order placement.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Import existing source adapters
import { buildEarningsLayerRecords } from './source-adapters/earnings-calendar-stub.mjs';
import { buildPoliticalLayerRecords } from './source-adapters/political-schedule-stub.mjs';
import { buildSportsBroadcastLayerRecords } from './source-adapters/sports-broadcast-stub.mjs';
import { collectEarningsResearch } from './source-adapters/earnings-research-collector.mjs';
import {
  loadDeclaredSources,
  runBoundedSourceResearch,
  mergeExtractedLayers,
} from './source-research.mjs';
import { ensureSourcesManifest, SOURCE_STATUS } from './discover-sources.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { date: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--date') opts.date = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!opts.date) {
    opts.date = new Date().toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) {
    throw new Error(`Invalid --date: ${opts.date} (expected YYYY-MM-DD)`);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Profile inference (mirrors generate-mentions-daily.mjs logic)
// ---------------------------------------------------------------------------
function asText(value) {
  return value == null ? '' : String(value).trim();
}

function lowerJoined(parts) {
  return parts.map(asText).filter(Boolean).join(' ').toLowerCase();
}

export function inferProfile(event) {
  const text = lowerJoined([
    event?.event_ticker,
    event?.series_ticker,
    event?.title,
    event?.sub_title,
  ]);

  if (/\b(earnings|earnings call|quarterly results|guidance|eps|revenue|cfo|ceo|investor relations|10-k|10-q|sec filing)\b/.test(text)) {
    return 'earnings_mentions';
  }
  if (/\b(announcer|broadcast|commentator|commentary|pregame|postgame|espn|fox sports|tnt|cbs sports|nbc sports|game broadcast|basketball|football|baseball|nba|nfl|mlb|nhl)\b/.test(text)) {
    return 'sports_announcer_mentions';
  }
  if (/\b(president|trump|biden|vance|senate|congress|governor|mayor|election|debate|speech|rally|hearing|white house|secretary|minister|campaign|candidate|hochul|starmer|mamdani)\b/.test(text)) {
    return 'political_mentions';
  }
  return 'political_mentions'; // default
}

// ---------------------------------------------------------------------------
// Extract company/speaker/announcer and keyword from event
// ---------------------------------------------------------------------------
function extractEarningsContext(event) {
  const title = event.title || '';
  // "What will Oracle Corporation say during their next earnings call?"
  const m = title.match(/what will\s+(.+?)\s+say during/i);
  const company = m ? m[1].trim() : title;

  const markets = event.markets || [];
  const keywords = markets
    .map(m => m.custom_strike?.Word || m.yes_sub_title || m.no_sub_title)
    .filter(Boolean)
    .filter(k => k !== 'Event does not qualify');

  return { company, keywords };
}

function extractPoliticalContext(event) {
  const title = event.title || '';
  // "What will Donald Trump say during THE PRESIDENT signs The Secure America Act?"
  const m = title.match(/what will\s+(.+?)\s+say during/i);
  const speaker = m ? m[1].trim() : title;

  const markets = event.markets || [];
  const keywords = markets
    .map(m => m.custom_strike?.Word || m.yes_sub_title || m.no_sub_title)
    .filter(Boolean)
    .filter(k => k !== 'Event does not qualify');

  return { speaker, keywords };
}

function extractSportsContext(event) {
  const title = event.title || '';
  // "What will the announcers say during Spurs vs Knicks Professional Basketball Game?"
  const m = title.match(/what will\s+(.+?)\s+say during/i);
  const announcer = m ? m[1].trim() : 'announcers';

  const markets = event.markets || [];
  const keywords = markets
    .map(m => m.custom_strike?.Word || m.yes_sub_title || m.no_sub_title)
    .filter(Boolean)
    .filter(k => k !== 'Event does not qualify');

  return { announcer, keywords };
}

// ---------------------------------------------------------------------------
// Web search helper (uses child_process to call a search tool)
// ---------------------------------------------------------------------------
async function webSearch(query) {
  // Try to use available search tools
  // First check if hermes web_search is available via HERMES_COMMAND
  const hermesCmd = process.env.HERMES_COMMAND || process.env.HERMES_CLI;
  if (hermesCmd) {
    try {
      const { execSync } = await import('node:child_process');
      const result = execSync(`${hermesCmd} web-search "${query.replace(/"/g, '\\"')}"`, {
        encoding: 'utf8',
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return result.trim();
    } catch {
      // fall through
    }
  }

  // Fallback: return null — caller must handle missing search
  return null;
}

// ---------------------------------------------------------------------------
// Build research JSON for a single event
// ---------------------------------------------------------------------------
async function buildEventResearch(event, profile, { stateRoot = resolve('state'), date = null, env = process.env, deps = {} } = {}) {
  const eventTicker = event.event_ticker;
  const markets = event.markets || [];

  // Bounded source research, once per EVENT: declared URLs only (capped),
  // cached by URL hash, one cheap-tier batch extraction per source document
  // covering every keyword in a single strict-JSON call. No declared sources
  // -> zero fetches, zero model calls, adapters/stubs stand as-is.
  const allKeywords = markets
    .map(m => m.custom_strike?.Word || m.yes_sub_title || m.no_sub_title)
    .filter(Boolean)
    .filter(k => k !== 'Event does not qualify');
  let sourceResearch = { byTerm: {}, stats: null, quality: 'stub', notes: [] };
  let sourceStatus = SOURCE_STATUS.NO_DECLARED_SOURCES;
  let declaredSourceUrls = [];
  if (date && allKeywords.length) {
    // Discovery step: ensure a bounded declared-source manifest exists for this
    // event BEFORE research runs. Idempotent — never clobbers a human-authored
    // sources/<TICKER>.json. Mines official URLs from the Kalshi resolution
    // rules (route-aware), rejecting any price/market host.
    let manifest = null;
    try {
      const ensured = (deps.ensureSourcesManifest ?? ensureSourcesManifest)(event, {
        profile,
        stateRoot,
        date,
        env,
      });
      manifest = ensured.manifest;
      sourceStatus = manifest?.status ?? SOURCE_STATUS.NO_DECLARED_SOURCES;
    } catch (err) {
      console.error(`[collect-mentions-research] ${eventTicker}: source discovery failed: ${err.message}`);
    }

    const declared = (deps.loadDeclaredSources ?? loadDeclaredSources)(stateRoot, date, eventTicker, env);
    declaredSourceUrls = declared;
    if (declared.length) {
      sourceStatus = SOURCE_STATUS.DECLARED;
      sourceResearch = await (deps.runBoundedSourceResearch ?? runBoundedSourceResearch)({
        eventTitle: event.title || '',
        eventTicker,
        profile,
        terms: allKeywords,
        sources: declared,
        stateRoot,
        date,
        env,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.fallbackFetchImpl ? { fallbackFetchImpl: deps.fallbackFetchImpl } : {}),
        ...(deps.chatRunner ? { chatRunner: deps.chatRunner } : {}),
      });
      if (sourceResearch.source_status) sourceStatus = sourceResearch.source_status;
      console.log(`[collect-mentions-research] ${eventTicker}: bounded source research ${JSON.stringify(sourceResearch.stats)}`);
    } else {
      // Explicit verified gap, not a silent stub: discovery ran and found no
      // usable official source URL for this event.
      sourceStatus = SOURCE_STATUS.NO_DECLARED_SOURCES;
      sourceResearch.notes.push('NO_DECLARED_SOURCES: source discovery found no official source URL for this event (no live research performed)');
      console.log(`[collect-mentions-research] ${eventTicker}: NO_DECLARED_SOURCES (no official source URL discovered)`);
    }
  }

  const marketResearches = [];

  for (const market of markets) {
    const keyword = market.custom_strike?.Word || market.yes_sub_title || market.no_sub_title;
    if (!keyword || keyword === 'Event does not qualify') continue;

    const marketTicker = market.ticker;
    let layerRecords = {};
    let sourceLadderInputs = {};
    let researchQuality = 'source_backed';

    if (profile === 'earnings_mentions') {
      const { company } = extractEarningsContext(event);
      
      // Use real source-backed research collector
      try {
        const research = await collectEarningsResearch({
          company,
          keyword,
          earningsEvent: {
            call_date_utc: market.close_time,
            confirmed: true,
            fiscal_quarter: 'next',
            event_ticker: eventTicker,
            source_url: `https://kalshi.com/events/${eventTicker}`,
          },
        });
        layerRecords = research.layerRecords;
        sourceLadderInputs = research.sourceLadderInputs;
      } catch (err) {
        console.error(`[collect-mentions-research] Research collection failed for ${company}/${keyword}: ${err.message}`);
        // Fallback to stub adapter
        researchQuality = 'stub';
        layerRecords = buildEarningsLayerRecords({
          company,
          keyword,
          earningsEvent: {
            call_date_utc: market.close_time,
            confirmed: true,
            fiscal_quarter: 'next',
          },
        });
        sourceLadderInputs = {
          prior_transcript_word_match: { status: 'missing', note: 'transcript search failed' },
          recent_direct_quote_match: { status: 'missing', note: 'quote search failed' },
          current_event_context: { status: 'used', note: `${company} earnings call scheduled`, source_path: `https://kalshi.com/events/${eventTicker}` },
          prompt_likelihood: { status: 'missing', note: 'analyst prompt search failed' },
          formal_document_proxy: { status: 'missing', note: 'SEC filing search failed' },
          qualification_risk: { status: 'used', note: 'earnings call confirmed on calendar', detail: { level: 'low' } },
        };
      }
    } else if (profile === 'political_mentions') {
      researchQuality = 'stub';
      const { speaker } = extractPoliticalContext(event);
      layerRecords = buildPoliticalLayerRecords({
        speaker,
        keyword,
        schedule: {
          event_type: 'speech',
          event_date_utc: market.close_time,
          confirmed: true,
        },
      });

      sourceLadderInputs = {
        prior_transcript_word_match: { status: 'missing', note: 'transcript search not yet performed' },
        recent_direct_quote_match: { status: 'missing', note: 'recent quote search not yet performed' },
        current_event_context: { status: 'used', note: `${speaker} scheduled event confirmed`, source_path: `https://kalshi.com/events/${eventTicker}` },
        prompt_likelihood: { status: 'missing', note: 'event prompt likelihood not assessed' },
        qualification_risk: { status: 'used', note: 'event confirmed on calendar', detail: { level: 'low' } },
      };
    } else if (profile === 'sports_announcer_mentions') {
      researchQuality = 'stub';
      const { announcer } = extractSportsContext(event);
      // Extract game info from title
      const title = event.title || '';
      const gameMatch = title.match(/during\s+(.+?)\s+(?:Professional|Game)/i);
      const game = gameMatch ? gameMatch[1].trim() : title;

      layerRecords = buildSportsBroadcastLayerRecords({
        announcer,
        keyword,
        broadcastEvent: {
          game_date_utc: market.close_time,
          network: 'national broadcast',
          show_type: 'live',
          confirmed: true,
        },
      });

      sourceLadderInputs = {
        prior_transcript_word_match: { status: 'missing', note: 'broadcast transcript search not yet performed' },
        recent_direct_quote_match: { status: 'missing', note: 'recent broadcast quote search not yet performed' },
        current_event_context: { status: 'used', note: `${game} broadcast scheduled`, source_path: `https://kalshi.com/events/${eventTicker}` },
        prompt_likelihood: { status: 'missing', note: 'broadcast prompt likelihood not assessed' },
        qualification_risk: { status: 'used', note: 'game broadcast confirmed on schedule', detail: { level: 'low' } },
      };
    }

    // Merge batch-extracted evidence (fills missing layers only; adapter
    // evidence and pricing exclusion are untouched).
    const extracted = sourceResearch.byTerm[keyword];
    if (extracted && Object.keys(extracted).length) {
      layerRecords = mergeExtractedLayers(layerRecords, extracted);
      researchQuality = 'source_backed';
    } else if (researchQuality === 'stub' && (sourceResearch.stats?.sources_used ?? 0) > 0) {
      // Sources were consulted but yielded nothing for this term: that is a
      // verified gap (no_source), not an unattempted stub.
      researchQuality = 'no_source';
    }

    marketResearches.push({
      market_ticker: marketTicker,
      keyword,
      profile,
      research_quality: researchQuality,
      source_status: sourceStatus,
      research_gap_notes: extracted && Object.keys(extracted).length ? [] : sourceResearch.notes,
      layer_records: layerRecords,
      source_ladder_inputs: sourceLadderInputs,
      rules_primary: market.rules_primary || null,
      rules_secondary: market.rules_secondary || null,
    });
  }

  return {
    event_ticker: eventTicker,
    event_title: event.title || '',
    profile,
    produced_at: new Date().toISOString(),
    produced_by: 'collect-mentions-research.mjs',
    source_status: sourceStatus,
    declared_source_urls: declaredSourceUrls,
    source_research_stats: sourceResearch.stats,
    markets: marketResearches,
  };
}

export { buildEventResearch };

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node scripts/mentions/collect-mentions-research.mjs --date YYYY-MM-DD');
    process.exit(0);
  }

  const stateRoot = resolve('state');
  const kalshiDir = resolve(stateRoot, 'mentions', opts.date, 'kalshi-events');
  const researchDir = resolve(stateRoot, 'mentions', opts.date, 'research');

  if (!existsSync(kalshiDir)) {
    console.error(`[collect-mentions-research] No kalshi-events dir: ${kalshiDir}`);
    process.exit(1);
  }

  mkdirSync(researchDir, { recursive: true });

  const files = readdirSync(kalshiDir).filter(f => f.endsWith('.json'));
  let written = 0;
  let totalMarkets = 0;

  for (const file of files) {
    const path = join(kalshiDir, file);
    let event;
    try {
      event = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      console.error(`[collect-mentions-research] SKIP: failed to parse ${path}: ${err.message}`);
      continue;
    }

    const profile = inferProfile(event);
    const research = await buildEventResearch(event, profile, { stateRoot, date: opts.date });
    totalMarkets += research.markets.length;

    const outPath = join(researchDir, `${event.event_ticker}.json`);
    writeFileSync(outPath, JSON.stringify(research, null, 2), 'utf8');
    written += 1;
    console.log(`[collect-mentions-research] WROTE ${outPath} (${research.markets.length} markets, profile=${profile})`);
  }

  console.log(`[collect-mentions-research] DONE events=${written} markets=${totalMarkets} research_dir=${researchDir}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(err => {
    console.error(`[collect-mentions-research] ERROR: ${err.message}`);
    process.exit(1);
  });
}
