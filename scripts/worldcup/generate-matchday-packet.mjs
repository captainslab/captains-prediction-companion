#!/usr/bin/env node
// World Cup matchday packet generator.
//
// Usage:
//   node scripts/worldcup/generate-matchday-packet.mjs [--date YYYY-MM-DD] [--state-root state] [--refresh-lineups] [--dry-run]
//
// Flow:
//   1. Load static structure for date
//   2. Load team baselines
//   3. For each match today:
//      a. Build opponent-adjusted matchup
//      b. Load matchday data (lineups/injuries)
//      c. Run composite model (evidence ledger)
//      d. Run multi-lane ceiling board
//      e. Attach market context (if available)
//   4. Render packet sections
//   5. Write packet + audit artifacts
//   6. If lineups confirmed, also write lineup-locked packet

import { resolve, dirname, join } from 'node:path';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { fetchStaticStructure } from './source-adapters/static-structure.mjs';
import { fetchTeamBaseline } from './source-adapters/team-baseline.mjs';
import { buildOpponentMatchup, loadCachedMatchup } from './source-adapters/opponent-matchup.mjs';
import { fetchMatchdayData, loadCachedMatchday } from './source-adapters/matchday-data.mjs';
import { loadCachedMarketContext, normalizeMarketContext } from './source-adapters/market-context.mjs';
import { runWorldCupPerplexityResearch } from './source-adapters/perplexity-research.mjs';
import { composeEvidenceLedgerForGame } from './lib/evidence-ledger.mjs';
import { composeMultiLaneCeilingBoard } from './lib/multi-lane-ceiling.mjs';
import { buildWorldCupResearchSummary } from './lib/perplexity-attachment-contract.mjs';
import { renderWorldCupPacket, writeWorldCupPacket } from './lib/packet-renderer.mjs';
import { CPC_MATCHDAY_TIMEZONE, localDateInTimeZone, filterMatchesForLocalDate } from './lib/matchday-window.mjs';
import { findLatestPriorBaseline } from './lib/composite-baseline.mjs';
import { evaluateLineupCacheFreshness, isFreshLineupCache } from './lib/lineup-freshness.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LINEUP_FETCHER = join(__dirname, 'source-adapters', 'fetch-official-lineups.mjs');

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function parseArgs(argv) {
  const opts = { date: null, stateRoot: 'state', dryRun: false, help: false, matchId: null, packetStage: null, refreshLineups: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') opts.date = argv[++i];
    else if (a === '--state-root') opts.stateRoot = argv[++i];
    else if (a === '--match-id') opts.matchId = argv[++i];
    else if (a === '--packet-stage') opts.packetStage = argv[++i];
    else if (a === '--refresh-lineups') opts.refreshLineups = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!opts.date) {
    // Default to "today" in the operating timezone, not UTC.
    opts.date = localDateInTimeZone(new Date().toISOString(), CPC_MATCHDAY_TIMEZONE);
  }
  return opts;
}

function readJsonIfExists(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function researchKeyToken(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  return slugify(text);
}

function researchPairKey(homeTeam, awayTeam) {
  const home = researchKeyToken(homeTeam);
  const away = researchKeyToken(awayTeam);
  if (!home || !away) return null;
  return `pair:${home}|${away}`;
}

function researchRecordKeys(record = {}) {
  const keys = [];
  const push = (prefix, value) => {
    const token = researchKeyToken(value);
    if (token) keys.push(`${prefix}:${token}`);
  };

  push('match_id', record.match_id ?? record.matchId);
  push('event_id', record.event_id ?? record.eventId ?? record.source_event_id);
  push('event_ticker', record.event_ticker ?? record.eventTicker ?? record.market_ticker ?? record.marketTicker);

  const pair = researchPairKey(
    record.home_team ?? record.homeTeam,
    record.away_team ?? record.awayTeam,
  );
  if (pair) keys.push(pair);

  return [...new Set(keys)];
}

function researchMatchKeys(match = {}, matchday = null) {
  const keys = [];
  const push = (prefix, value) => {
    const token = researchKeyToken(value);
    if (token) keys.push(`${prefix}:${token}`);
  };

  push('match_id', match.match_id);
  push('event_id', matchday?.source?.event_id ?? match?.event_id ?? match?.source_event_id);
  push('event_ticker', match?.event_ticker ?? match?.market_context?.event_ticker ?? match?.market_context?.ticker);

  const pair = researchPairKey(match?.home_team, match?.away_team);
  if (pair) keys.push(pair);

  return [...new Set(keys)];
}

function buildResearchIndex(researchArtifact = {}) {
  return (Array.isArray(researchArtifact?.records) ? researchArtifact.records : []).map((record, index) => ({
    record,
    index,
    keys: researchRecordKeys(record),
    used: false,
  }));
}

function normalizeResearchSummary(value, max = 200) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return 'summary unavailable';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
}

export function attachWorldCupResearchContext(match, {
  matchday = null,
  researchIndex = [],
  researchStatus = 'ok',
  sourceId = 'perplexity',
  sourceLabel = 'Perplexity research',
} = {}) {
  const keys = researchMatchKeys(match, matchday);
  const entry = researchIndex.find((candidate) =>
    !candidate.used && candidate.keys.some((key) => keys.includes(key)),
  );

  if (!entry) {
    return {
      ...match,
      live_context: {
        status: 'unavailable',
        source_id: sourceId,
        source_label: sourceLabel,
        reason: researchStatus === 'ok'
          ? 'no live context attached to this match'
          : `research ${researchStatus}`,
      },
    };
  }

  entry.used = true;
  const record = entry.record ?? {};
  return {
    ...match,
    live_context: {
      status: 'gathered',
      source_id: sourceId,
      source_label: sourceLabel,
      matched_by: entry.keys.find((key) => keys.includes(key)) ?? 'match_id',
      match_keys: keys,
      record_index: entry.index,
      match_id: String(match.match_id ?? record.match_id ?? '').trim() || null,
      event_id: String(matchday?.source?.event_id ?? match?.event_id ?? '').trim() || null,
      source_quality: record.source_quality ?? null,
      lineup_status: record.lineup_status ?? null,
      summary: normalizeResearchSummary(record.summary ?? record.note ?? ''),
      team_news: Array.isArray(record.team_news) ? record.team_news : (record.team_news ? [record.team_news] : []),
      injuries: Array.isArray(record.injuries) ? record.injuries : (record.injuries ? [record.injuries] : []),
      suspensions: Array.isArray(record.suspensions) ? record.suspensions : (record.suspensions ? [record.suspensions] : []),
      citations: Array.isArray(record.citations) ? record.citations : [],
      notes: record.notes ?? null,
    },
  };
}

function buildLineupAdjustment(matchday, lineupLockedVerified) {
  const missingFields = ['player_ratings', 'key_absence_flags', 'expected_starters'];
  if (lineupLockedVerified) {
    return {
      status: 'blocked',
      flag: 'LINEUP_ADJUSTED_MODEL_MISSING',
      basis: 'baseline composite',
      missing_fields: missingFields,
      reason: 'matchday artifact only exposes starting XI names/positions/numbers',
    };
  }
  return {
    status: 'unavailable',
    flag: 'LINEUP_ADJUSTED_MODEL_MISSING',
    basis: 'baseline composite',
    missing_fields: missingFields,
    reason: matchday?.ok ? 'official starting lineup not verified' : 'matchday data not loaded',
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node scripts/worldcup/generate-matchday-packet.mjs [--date YYYY-MM-DD] [--state-root state] [--match-id ID] [--packet-stage STAGE] [--refresh-lineups] [--dry-run]');
    process.exit(0);
  }

  const date = opts.date;
  const stateRoot = opts.stateRoot;

  console.log(`[worldcup] generating matchday packet for ${date}`);

  // 1. Load static structure
  const structPath = resolve(stateRoot, 'worldcup', date, 'discovery', 'static_structure.json');
  let structure = readJsonIfExists(structPath);
  if (!structure) {
    console.log(`[worldcup] no cached structure; fetching...`);
    structure = await fetchStaticStructure({ stateRoot, date });
    if (!structure.ok || structure.match_count === 0) {
      console.error(`[worldcup] ERROR: cannot fetch structure. Errors: ${(structure.errors || []).join('; ')}`);
      process.exit(1);
    }
  }

  // 2. Load team baselines
  let compositeProvenance = null;
  const baselinePath = resolve(stateRoot, 'worldcup', date, 'discovery', 'team_baseline.json');
  let baseline = readJsonIfExists(baselinePath);
  if (!baseline) {
    console.log(`[worldcup] no cached baseline; fetching...`);
    baseline = await fetchTeamBaseline({ stateRoot, date });
    if (!baseline.ok) {
      // Pre-lock fallback: reuse the most recent PRIOR baseline (last available
      // composite) rather than emitting an empty all-BLOCKED board. Labeled
      // provisional in the packet; never fabricated.
      const prior = findLatestPriorBaseline(stateRoot, date);
      if (prior) {
        console.log(`[worldcup] team baseline unavailable for ${date}; using PRIOR baseline from ${prior.sourceDate} (PRE_LOCK / provisional).`);
        baseline = prior.baseline;
        compositeProvenance = { source_date: prior.sourceDate, provisional: true };
      } else {
        console.log(`[worldcup] WARNING: no team baseline (current or prior) available. Using empty fallback.`);
        baseline = { teams: [], team_count: 0 };
      }
    }
  }
  const teamBaselines = Object.fromEntries((baseline.teams || []).map(t => [t.team_name, t]));

  // 3. Filter matches for today (operating timezone = America/Chicago, not UTC).
  let todayMatches = filterMatchesForLocalDate(structure.matches, date, CPC_MATCHDAY_TIMEZONE);
  const shouldRefreshLineups = !opts.dryRun && (
    opts.refreshLineups
    || opts.packetStage === 'lineup_lock'
    || opts.packetStage === 'lineup_locked'
  );
  const lineupRefreshStartedAt = shouldRefreshLineups ? new Date().toISOString() : null;

  if (shouldRefreshLineups) {
    console.log('[worldcup] refreshing official lineups before lineup-sensitive calculations...');
    const refresh = spawnSync(process.execPath, [LINEUP_FETCHER, '--date', date, '--state-root', stateRoot], { stdio: 'inherit' });
    if (refresh.status !== 0) {
      throw new Error(`official lineup refresh failed with status ${refresh.status}`);
    }
  }

  // Optional single-match mode: emit a standalone packet for one fixture,
  // written under a distinct base name so it never collides with or
  // overwrites the full-slate packet/audit.
  let nameSuffix = '';
  if (opts.matchId) {
    todayMatches = todayMatches.filter(m => String(m.match_id) === String(opts.matchId));
    if (todayMatches.length === 0) {
      console.error(`[worldcup] --match-id ${opts.matchId} not in today's slate (${date}). Exiting.`);
      process.exit(1);
    }
    const m = todayMatches[0];
    nameSuffix = `-${slugify(`${m.home_team}-${m.away_team}`)}`;
  }

  if (todayMatches.length === 0) {
    console.log(`[worldcup] no matches today (${date}). Exiting.`);
    process.exit(0);
  }

  console.log(`[worldcup] ${todayMatches.length} match(es) today`);
  const research = await runWorldCupPerplexityResearch({
    date,
    matches: todayMatches,
    stateRoot,
  });
  const researchRecords = research.artifact?.records ?? [];
  const researchIndex = buildResearchIndex(research.artifact);
  let attachedResearchCount = 0;
  let attachedResearchMatchIds = [];

  const boards = [];
  const auditRecords = [];

  for (const match of todayMatches) {
    console.log(`[worldcup] processing ${match.home_team} vs ${match.away_team}`);

    // 3a. Opponent matchup
    const matchup = buildOpponentMatchup({
      homeTeam: match.home_team,
      awayTeam: match.away_team,
      teamBaselines,
      historicalH2H: [], // TODO: load from cache
    });

    // 3b. Matchday data
    const matchday = loadCachedMatchday(stateRoot, date, match.match_id);
    const lineupFreshness = evaluateLineupCacheFreshness(matchday, {
      matchId: match.match_id,
      kickoffUtc: match.kickoff_utc,
      refreshStartedAtIso: shouldRefreshLineups ? lineupRefreshStartedAt : null,
    });
    if (shouldRefreshLineups && !lineupFreshness.verified) {
      throw new Error(`stale lineup cache for match ${match.match_id}; lineup_lock packets require the refreshed official XI snapshot`);
    }
    const rawLineupStatus = matchday.ok
      ? ((matchday.home?.lineup_status === 'lineup_confirmed' && matchday.away?.lineup_status === 'lineup_confirmed')
        ? 'lineup_confirmed'
        : (matchday.home?.lineup_status || matchday.away?.lineup_status || 'lineup_pending'))
      : 'lineup_pending';
    const lineupLockedVerified = rawLineupStatus === 'lineup_confirmed' && lineupFreshness.verified === true;
    const lineupStatus = lineupLockedVerified ? 'lineup_confirmed' : 'lineup_pending';
    const lineupAdjustment = buildLineupAdjustment(matchday, lineupLockedVerified);
    match.lineup_status = lineupStatus;
    match.lineup_locked_verified = lineupLockedVerified;
    // A fresh official XI unlocks the public forecast; the separate
    // lineup-adjusted model remains blocked until the missing layers exist.
    match.model_consumes_lineup = lineupLockedVerified;
    match.lineup_freshness = lineupFreshness;
    match.lineup_adjustment = lineupAdjustment;
    // Expose the (price-free) lineup payload to the renderer for the
    // lineup-locked block. Only specific fields are read downstream.
    match.matchday = matchday.ok ? matchday : null;
    const researchAttachedMatch = attachWorldCupResearchContext(match, {
      matchday: match.matchday,
      researchIndex,
      researchStatus: research.status,
      sourceId: research.artifact?.source_id ?? 'perplexity',
      sourceLabel: 'Perplexity research',
    });
    Object.assign(match, researchAttachedMatch);
    if (match.live_context?.status === 'gathered') {
      attachedResearchCount += 1;
      attachedResearchMatchIds.push(match.match_id);
    }

    // 3c. Build composite input
    // Layer scores must be 0-100. Team baselines carry normalized 0-100
    // ratings (attack_rating/defense_rating = normalized Elo); raw FIFA
    // points (~800-1900) must never be fed in directly or the clamp
    // saturates every team at 100.
    const homeBase = teamBaselines[match.home_team] || {};
    const awayBase = teamBaselines[match.away_team] || {};
    const quality = (b) => b.quality_score_0_100 ?? b.attack_rating ?? null;

    const homeEntry = {
      team_quality_baseline: { present: quality(homeBase) != null, score: quality(homeBase), basis: 'normalized Elo / FIFA quality (0-100)' },
      recent_form: { present: false, score: null, basis: 'recent international form', missing_reason: 'not yet sourced' },
      attacking_strength: { present: homeBase.attack_rating != null, score: homeBase.attack_rating ?? null, basis: 'normalized attack rating (0-100)' },
      defensive_strength: { present: homeBase.defense_rating != null, score: homeBase.defense_rating ?? null, basis: 'normalized defense rating (0-100)' },
      opponent_adjusted_attack: { present: !!matchup.ok, score: matchup.home?.attack_vs_opponent_defense?.score ?? null, basis: matchup.home?.attack_vs_opponent_defense?.basis },
      opponent_adjusted_defense: { present: !!matchup.ok, score: matchup.home?.defense_vs_opponent_attack?.score ?? null, basis: matchup.home?.defense_vs_opponent_attack?.basis },
      opponent_style_fit: { present: !!matchup.ok, score: matchup.home?.style_fit?.score ?? null, basis: matchup.home?.style_fit?.basis },
      set_piece_matchup: { present: !!matchup.ok, score: matchup.home?.set_piece_vs_opponent?.score ?? null, basis: matchup.home?.set_piece_vs_opponent?.basis },
      goalkeeper_edge: { present: !!matchup.ok, score: matchup.home?.goalkeeper_vs_opponent_chance_quality?.score ?? null, basis: matchup.home?.goalkeeper_vs_opponent_chance_quality?.basis },
      squad_availability: { present: matchday.ok, score: null, basis: 'squad availability', missing_reason: matchday.ok ? null : 'matchday data not loaded' },
      lineup_strength_delta: { present: false, score: null, basis: 'baseline composite', missing_reason: lineupLockedVerified
        ? `LINEUP_ADJUSTED_MODEL_MISSING: ${lineupAdjustment.reason}; missing_fields=${lineupAdjustment.missing_fields.join(', ')}`
        : (matchday.ok ? 'lineups not confirmed or lineup cache not verified' : 'matchday data not loaded') },
      rest_travel_venue_climate: { present: false, score: null, basis: 'rest/travel/venue/climate', missing_reason: 'not yet sourced' },
      tournament_incentive_state: { present: false, score: null, basis: 'tournament incentive', missing_reason: 'not yet sourced' },
      knockout_extra_time_penalty: { present: false, score: null, basis: 'knockout extra time / penalties', missing_reason: (!match.stage || match.stage === 'group') ? 'group stage' : 'not yet sourced' },
    };

    const awayEntry = {
      team_quality_baseline: { present: quality(awayBase) != null, score: quality(awayBase), basis: 'normalized Elo / FIFA quality (0-100)' },
      recent_form: { present: false, score: null, basis: 'recent international form', missing_reason: 'not yet sourced' },
      attacking_strength: { present: awayBase.attack_rating != null, score: awayBase.attack_rating ?? null, basis: 'normalized attack rating (0-100)' },
      defensive_strength: { present: awayBase.defense_rating != null, score: awayBase.defense_rating ?? null, basis: 'normalized defense rating (0-100)' },
      opponent_adjusted_attack: { present: !!matchup.ok, score: matchup.away?.attack_vs_opponent_defense?.score ?? null, basis: matchup.away?.attack_vs_opponent_defense?.basis },
      opponent_adjusted_defense: { present: !!matchup.ok, score: matchup.away?.defense_vs_opponent_attack?.score ?? null, basis: matchup.away?.defense_vs_opponent_attack?.basis },
      opponent_style_fit: { present: !!matchup.ok, score: matchup.away?.style_fit?.score ?? null, basis: matchup.away?.style_fit?.basis },
      set_piece_matchup: { present: !!matchup.ok, score: matchup.away?.set_piece_vs_opponent?.score ?? null, basis: matchup.away?.set_piece_vs_opponent?.basis },
      goalkeeper_edge: { present: !!matchup.ok, score: matchup.away?.goalkeeper_vs_opponent_chance_quality?.score ?? null, basis: matchup.away?.goalkeeper_vs_opponent_chance_quality?.basis },
      squad_availability: { present: matchday.ok, score: null, basis: 'squad availability', missing_reason: matchday.ok ? null : 'matchday data not loaded' },
      lineup_strength_delta: { present: false, score: null, basis: 'baseline composite', missing_reason: lineupLockedVerified
        ? `LINEUP_ADJUSTED_MODEL_MISSING: ${lineupAdjustment.reason}; missing_fields=${lineupAdjustment.missing_fields.join(', ')}`
        : (matchday.ok ? 'lineups not confirmed or lineup cache not verified' : 'matchday data not loaded') },
      rest_travel_venue_climate: { present: false, score: null, basis: 'rest/travel/venue/climate', missing_reason: 'not yet sourced' },
      tournament_incentive_state: { present: false, score: null, basis: 'tournament incentive', missing_reason: 'not yet sourced' },
      knockout_extra_time_penalty: { present: false, score: null, basis: 'knockout extra time / penalties', missing_reason: (!match.stage || match.stage === 'group') ? 'group stage' : 'not yet sourced' },
    };

    const isKnockout = match.stage && match.stage !== 'group';

    // 3d. Run composite model
    const ledger = composeEvidenceLedgerForGame(homeEntry, awayEntry, { isKnockout });

    // 3e. Load market context (post-score reference only). Cache file may be
    // a single contract or { markets: [...] }; every contract is normalized
    // (family/period/side/line/settlement parsed from TEXT, prices stripped
    // to implied_probability).
    const marketCtx = loadCachedMarketContext(stateRoot, date, match.match_id);
    const rawMarkets = marketCtx.ok
      ? (Array.isArray(marketCtx.markets) ? marketCtx.markets : [marketCtx])
      : [];
    const marketContexts = rawMarkets
      .map(m => normalizeMarketContext(m, { homeTeam: match.home_team, awayTeam: match.away_team }))
      .filter(Boolean);

    // 3f. Run multi-lane ceiling board
    const board = composeMultiLaneCeilingBoard({
      homeLedger: ledger.home,
      awayLedger: ledger.away,
      marketContexts,
      isKnockout,
      lineupConfirmed: lineupLockedVerified,
    });

    boards.push(board);
    auditRecords.push({
      match,
      ledger,
      board,
      matchup: matchup.ok ? matchup : null,
      matchday: matchday.ok ? matchday : null,
      live_context: match.live_context ?? null,
      market_context: marketCtx.ok ? marketCtx : null,
      parsed_markets: marketContexts, // family / period / side / line / settlement / normalized_target
      lineup_freshness: lineupFreshness,
      lineup_locked_verified: lineupLockedVerified,
      model_consumes_lineup: lineupLockedVerified,
      lineup_adjustment: lineupAdjustment,
    });
  }

  // 4. Render packet
  const packetStage = opts.packetStage
    || (todayMatches.some(m => m.lineup_status === 'lineup_confirmed')
      ? 'lineup_locked'
      : 'morning_board');

  const packetText = renderWorldCupPacket({
    matches: todayMatches,
    boards,
    meta: {
      date,
      packet_stage: packetStage,
      composite_provenance: compositeProvenance,
      research: {
        status: research.status,
        ok: research.ok,
        outPath: research.outPath,
        match_count: todayMatches.length,
        record_count: researchRecords.length,
        attached_count: attachedResearchCount,
        attached_match_ids: attachedResearchMatchIds,
        source_quality: research.artifact?.source_quality ?? null,
        reason: research.artifact?.reason ?? null,
      },
    },
  });
  const researchSummary = buildWorldCupResearchSummary(research, todayMatches);

  // 5. Write packet + audit artifacts
  const packetDir = resolve(stateRoot, 'packets', date, 'worldcup-matchday');
  mkdirSync(packetDir, { recursive: true });

  if (!opts.dryRun) {
    const { txtPath, metaPath } = writeWorldCupPacket({
      dir: packetDir,
      baseName: `worldcup-${date}-${packetStage}${nameSuffix}`,
      packetText,
      meta: {
        date,
        packet_stage: packetStage,
        match_count: todayMatches.length,
        composite_provenance: compositeProvenance,
        research: researchSummary,
      },
    });
    console.log(`[worldcup] packet written: ${txtPath}`);
    console.log(`[worldcup] meta written: ${metaPath}`);

    // Audit artifact
    const auditPath = resolve(packetDir, `worldcup-${date}-audit${nameSuffix}.json`);
    writeFileSync(auditPath, JSON.stringify({
      generated_at: new Date().toISOString(),
      date,
      packet_stage: packetStage,
      records: auditRecords,
      research: research.artifact,
    }, null, 2), 'utf8');
    console.log(`[worldcup] audit written: ${auditPath}`);
  } else {
    console.log(`[worldcup] DRY RUN — packet would be written to ${packetDir}`);
    console.log('--- PACKET PREVIEW ---');
    console.log(packetText.slice(0, 2000));
    console.log('--- END PREVIEW ---');
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
