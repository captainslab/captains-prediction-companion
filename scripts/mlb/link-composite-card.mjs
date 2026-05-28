#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { routeMlbMarket } from './router-core.mjs';
import { loadDynamicCompositeSlate, runComposite } from './late-slate-composite-refresh.mjs';
import { lookupMlbTeam, parseEventTickerTeams, parseMarketTickerTeam } from '../packets/lib/mlb-teams.mjs';

const MLB_COMPOSITE_PIPELINE = 'mlb_composite';
const COMPOSITE_ENTRYPOINT = 'scripts/mlb/late-slate-composite-refresh.mjs#runComposite';

const ROUTED_LANE_KEYS = Object.freeze({
  moneyline: ['moneyline_away', 'moneyline_home'],
  run_line: ['run_line_away', 'run_line_home'],
  game_total: ['total_over', 'total_under'],
  yrfi_nrfi: ['yrfi', 'nrfi'],
});

const TICKER_LANE_HINTS = Object.freeze([
  [/KXMLB(?:GAME|ML|MONEYLINE)/, 'moneyline'],
  [/KXMLB(?:SPREAD|RUNLINE|RL)/, 'run_line'],
  [/KXMLB(?:TOTAL|OU)/, 'game_total'],
  [/KXMLB(?:YRFI|NRFI|RFI)/, 'yrfi_nrfi'],
  [/KXMLB(?:HR|HOMER)/, 'home_run_hitter'],
  [/KXMLB(?:K|SO|STRIKEOUT)/, 'pitcher_strikeouts'],
]);

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeText(value) {
  return cleanString(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function wordsFromSlug(value) {
  return cleanString(value)
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function findTicker(segments) {
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = cleanString(segments[i]).toUpperCase();
    if (/^KX[A-Z0-9-]+$/.test(segment)) return segment;
  }
  return null;
}

function inferTickerLane(ticker) {
  if (!ticker) return null;
  for (const [pattern, lane] of TICKER_LANE_HINTS) {
    if (pattern.test(ticker)) return lane;
  }
  return null;
}

function deriveEventTicker(marketTicker) {
  if (!marketTicker) return null;
  const suffix = parseMarketTickerTeam(marketTicker, null);
  if (suffix && marketTicker.endsWith(`-${suffix}`)) {
    return marketTicker.slice(0, -suffix.length - 1);
  }
  const parts = marketTicker.split('-');
  return parts.length > 1 ? parts.slice(0, -1).join('-') : marketTicker;
}

function teamsFromEventTicker(eventTicker) {
  const teams = parseEventTickerTeams(eventTicker);
  if (!teams) return { awayAbbrev: null, homeAbbrev: null, away: null, home: null };
  const [awayAbbrev, homeAbbrev] = teams;
  return {
    awayAbbrev,
    homeAbbrev,
    away: lookupMlbTeam(awayAbbrev),
    home: lookupMlbTeam(homeAbbrev),
  };
}

function buildMarketTitle({ segments, marketTicker, eventTicker, teams }) {
  const slugText = segments
    .filter(segment => !/^KX[A-Z0-9-]+$/i.test(segment))
    .map(wordsFromSlug)
    .filter(Boolean)
    .join(' ');
  const laneHint = inferTickerLane(marketTicker);
  const matchup = teams.away && teams.home ? `${teams.away} vs ${teams.home}` : '';

  if (laneHint === 'moneyline' && matchup) return `${matchup} winner`;
  if (laneHint === 'run_line' && matchup) return `${matchup} run line`;
  if (laneHint === 'game_total' && matchup) return `${matchup} total runs`;
  if (laneHint === 'yrfi_nrfi' && matchup) return `${matchup} first inning run`;
  if (laneHint === 'home_run_hitter') return `${slugText} home run`;
  if (laneHint === 'pitcher_strikeouts') return `${slugText} pitcher strikeouts`;

  return [slugText, marketTicker, eventTicker].filter(Boolean).join(' ');
}

export function parseMarketLink(url) {
  const parsed = parseUrl(url);
  if (!parsed) {
    return {
      valid: false,
      url: cleanString(url),
      reason_code: 'invalid_url',
      reason: 'Need a valid market URL.',
    };
  }

  const segments = parsed.pathname.split('/').map(decodeURIComponent).filter(Boolean);
  const marketTicker = findTicker(segments);
  const eventTicker = deriveEventTicker(marketTicker);
  const teams = teamsFromEventTicker(eventTicker);
  const host = parsed.hostname.toLowerCase();
  const pathText = normalizeText(parsed.pathname);
  const tickerText = normalizeText(marketTicker ?? eventTicker ?? '');
  const title = buildMarketTitle({ segments, marketTicker, eventTicker, teams });
  const isKalshi = host === 'kalshi.com' || host.endsWith('.kalshi.com');
  const isMlb =
    tickerText.includes('kxmlb') ||
    pathText.includes('mlb') ||
    pathText.includes('baseball') ||
    Boolean(teams.away && teams.home);

  return {
    valid: true,
    url: parsed.toString(),
    isKalshi,
    isMlb,
    market_ticker: marketTicker,
    event_ticker: eventTicker,
    market_title: title,
    event_title: teams.away && teams.home ? `${teams.away} vs ${teams.home}` : null,
    teams,
  };
}

function routeFromParsed(parsed) {
  return routeMlbMarket({
    kalshi_url: parsed.url,
    event_ticker: parsed.event_ticker,
    market_ticker: parsed.market_ticker,
    event_title: parsed.event_title,
    market_title: parsed.market_title,
    teams: {
      away: parsed.teams?.away ?? null,
      home: parsed.teams?.home ?? null,
    },
  });
}

function normalizeTeam(value) {
  return normalizeText(value);
}

function gameMatchesParsed(input, parsed) {
  if (!input || !parsed?.teams) return false;
  const away = normalizeTeam(input.away_team);
  const home = normalizeTeam(input.home_team);
  const parsedAway = normalizeTeam(parsed.teams.away);
  const parsedHome = normalizeTeam(parsed.teams.home);
  if (parsedAway && parsedHome && away === parsedAway && home === parsedHome) return true;

  const label = normalizeText(input.label);
  if (parsed.teams.awayAbbrev && parsed.teams.homeAbbrev) {
    const compact = normalizeText(`${parsed.teams.awayAbbrev} ${parsed.teams.homeAbbrev}`);
    const atLabel = normalizeText(`${parsed.teams.awayAbbrev} @ ${parsed.teams.homeAbbrev}`);
    return label === compact || label === atLabel;
  }

  return false;
}

function selectGameInput({ parsed, gameInputs }) {
  return gameInputs.find(input => gameMatchesParsed(input, parsed)) ?? null;
}

function selectLane(board, marketLane) {
  const keys = ROUTED_LANE_KEYS[marketLane] ?? [];
  const candidates = keys.map(key => board?.lanes?.[key]).filter(Boolean);
  if (!candidates.length) return null;

  const ranked = [...candidates].sort((left, right) => {
    const score = { PICK: 4, EVIDENCE_LEAN: 3, LEAN: 2, WATCH: 1, 'NO CLEAR PICK': 0 };
    const statusDelta = (score[right.status] ?? 0) - (score[left.status] ?? 0);
    if (statusDelta !== 0) return statusDelta;
    return (Number(right.score) || 0) - (Number(left.score) || 0);
  });
  return ranked[0];
}

function compactLane(lane) {
  if (!lane) return null;
  return {
    label: lane.label ?? null,
    status: lane.status ?? null,
    direction: lane.direction ?? null,
    score: lane.score ?? null,
    differential: lane.differential ?? null,
    reasons: Array.isArray(lane.reasons) ? lane.reasons.slice(0, 3) : [],
  };
}

function blockedResult({ parsed, route = null, reasonCode, reason, handled = true }) {
  return {
    schema_version: 'cpc_market_link_composite_v1',
    handled,
    ok: false,
    status: 'blocked',
    reason_code: reasonCode,
    reason,
    source: {
      platform: parsed?.isKalshi ? 'Kalshi' : null,
      url: parsed?.url ?? null,
      market_id: parsed?.market_ticker ?? null,
    },
    route: route
      ? {
          route_status: route.route_status,
          market_lane: route.market_lane,
          candidate_lanes: route.candidate_lanes,
          needed_context: route.needed_clarification,
        }
      : null,
    compact_card: {
      status: 'blocked',
      reason_code: reasonCode,
      reason,
      pipeline: MLB_COMPOSITE_PIPELINE,
      market_lane: route?.market_lane ?? null,
      matchup: parsed?.event_title ?? null,
      research_only: true,
      price_inputs_used: false,
    },
  };
}

function readyResult({ parsed, route, compositeResult, lane }) {
  const board = compositeResult.board;
  return {
    schema_version: 'cpc_market_link_composite_v1',
    handled: true,
    ok: true,
    status: 'ready',
    source: {
      platform: 'Kalshi',
      url: parsed.url,
      market_id: parsed.market_ticker,
    },
    pipeline: MLB_COMPOSITE_PIPELINE,
    composite_entrypoint: COMPOSITE_ENTRYPOINT,
    route: {
      route_status: route.route_status,
      market_lane: route.market_lane,
      confidence: route.confidence,
      side_hint: route.side_hint,
    },
    compact_card: {
      status: 'ready',
      pipeline: MLB_COMPOSITE_PIPELINE,
      source_url: parsed.url,
      market_id: parsed.market_ticker,
      market_lane: route.market_lane,
      matchup: `${board.away_team} @ ${board.home_team}`,
      signal: compactLane(lane),
      composite: {
        away_team: board.away_team,
        home_team: board.home_team,
        away_score: board.away_composite_score,
        home_score: board.home_composite_score,
        differential: board.score_differential,
        stronger_side: board.stronger_side,
        data_quality: board.combined_data_quality,
      },
      research_only: true,
      price_inputs_used: false,
    },
  };
}

export async function analyzeCompositeMarketLink({
  url,
  date = new Date().toISOString().slice(0, 10),
  stateRoot = 'state',
  gameInputs = null,
  forceHandle = false,
  compositeRunner = runComposite,
} = {}) {
  const parsed = parseMarketLink(url);
  if (!parsed.valid) {
    return blockedResult({
      parsed,
      reasonCode: parsed.reason_code,
      reason: parsed.reason,
      handled: true,
    });
  }

  if (!parsed.isMlb) {
    return blockedResult({
      parsed,
      reasonCode: 'not_mlb_composite',
      reason: 'The link is outside the MLB composite pipeline.',
      handled: forceHandle,
    });
  }

  const route = routeFromParsed(parsed);
  if (route.route_status !== 'ROUTED') {
    return blockedResult({
      parsed,
      route,
      reasonCode: route.route_status === 'AMBIGUOUS' ? 'ambiguous_market_lane' : 'unsupported_market_link',
      reason: route.needed_clarification?.[0] ?? route.reject_signals?.[0] ?? 'The link could not be routed to a supported MLB composite lane.',
      handled: true,
    });
  }

  if (!ROUTED_LANE_KEYS[route.market_lane]) {
    return blockedResult({
      parsed,
      route,
      reasonCode: 'lane_not_composite_supported',
      reason: 'This MLB lane needs player-specific context that the composite game model does not emit yet.',
      handled: true,
    });
  }

  const inputs = Array.isArray(gameInputs)
    ? gameInputs
    : loadDynamicCompositeSlate({ date, stateRoot }).inputs;
  const input = selectGameInput({ parsed, gameInputs: inputs });

  if (!input) {
    return blockedResult({
      parsed,
      route,
      reasonCode: 'game_context_missing',
      reason: 'The market routed to MLB composite, but no matching source-backed game context is available for this date.',
      handled: true,
    });
  }

  const compositeResult = compositeRunner(input);
  const lane = selectLane(compositeResult.board, route.market_lane);
  if (!lane) {
    return blockedResult({
      parsed,
      route,
      reasonCode: 'lane_output_missing',
      reason: 'The composite model ran, but the requested lane was not present in the board output.',
      handled: true,
    });
  }

  return readyResult({ parsed, route, compositeResult, lane });
}

function parseArgs(argv) {
  const opts = { url: null, date: null, stateRoot: 'state' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--url') opts.url = argv[++i];
    else if (arg === '--date') opts.date = argv[++i];
    else if (arg === '--state-root') opts.stateRoot = argv[++i];
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (!opts.url) opts.url = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.url) {
    console.log('Usage: node scripts/mlb/link-composite-card.mjs --url <kalshi-market-url> [--date YYYY-MM-DD] [--state-root state]');
    return;
  }

  const result = await analyzeCompositeMarketLink({
    url: opts.url,
    date: opts.date ?? new Date().toISOString().slice(0, 10),
    stateRoot: opts.stateRoot,
    forceHandle: true,
  });
  console.log(JSON.stringify(result.compact_card, null, 2));
  if (!result.ok) process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
