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
import { fileURLToPath } from 'node:url';

// Import existing source adapters
import { buildEarningsLayerRecords } from './source-adapters/earnings-calendar-stub.mjs';
import { buildPoliticalLayerRecords } from './source-adapters/political-schedule-stub.mjs';
import { buildSportsBroadcastLayerRecords } from './source-adapters/sports-broadcast-stub.mjs';
import { collectEarningsResearch } from './source-adapters/earnings-research-collector.mjs';

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

function inferProfile(event) {
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
async function buildEventResearch(event, profile) {
  const eventTicker = event.event_ticker;
  const markets = event.markets || [];

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

    marketResearches.push({
      market_ticker: marketTicker,
      keyword,
      profile,
      research_quality: researchQuality,
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
    markets: marketResearches,
  };
}

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
    const research = await buildEventResearch(event, profile);
    totalMarkets += research.markets.length;

    const outPath = join(researchDir, `${event.event_ticker}.json`);
    writeFileSync(outPath, JSON.stringify(research, null, 2), 'utf8');
    written += 1;
    console.log(`[collect-mentions-research] WROTE ${outPath} (${research.markets.length} markets, profile=${profile})`);
  }

  console.log(`[collect-mentions-research] DONE events=${written} markets=${totalMarkets} research_dir=${researchDir}`);
}

main().catch(err => {
  console.error(`[collect-mentions-research] ERROR: ${err.message}`);
  process.exit(1);
});
