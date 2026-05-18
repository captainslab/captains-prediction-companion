// Phase A — Market-internal pick engine.
//
// Pure functions. No external API calls. No lineup/weather/starter/park context.
// We only look at the Kalshi price structure for a single game's markets and
// surface CLEAR / LEAN / WATCH / PASS based on:
//
//   - CLEAR: cross-side arbitrage on a 2-sided pair (YES_A_ask + YES_B_ask < 100¢)
//            or strict ladder violations exceeding noise threshold (e.g. a higher
//            strike priced strictly above a lower strike on the same ladder).
//   - LEAN : weak ladder inversion (>= 1¢) or wide-but-priced asymmetry that
//            survives a noise cushion. We do NOT call de-vig favoritism a LEAN.
//   - WATCH: ladder is monotone and spread is wide / liquidity is thin / market
//            posted but resolution context (which we deliberately ignore here)
//            would be required for a CLEAR.
//   - PASS : ladder is monotone and prices are unremarkable.
//   - NO CLEAR PICK: the market is missing/unquoted entirely.
//
// Hard rules enforced in this module:
//   1. "Favorite is favored" is NEVER a CLEAR or LEAN reason.
//   2. We never assume a fair probability from a Poisson model; the only "fair"
//      we touch is the no-vig re-normalization of an *observed* 2-sided pair.
//   3. Every CLEAR/LEAN reason string names the exact market-internal evidence
//      (which strikes, which prices, the inversion size in cents).

// ---- helpers ----------------------------------------------------------------

function toCents(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function num(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Inversion noise threshold in cents — anything <= this is treated as quote
// noise, not signal.
const NOISE_CENTS = 1;
const LEAN_CENTS = 2;
const CLEAR_CENTS = 4;

// Wide spread threshold for WATCH (yes_ask - yes_bid).
const WIDE_SPREAD_CENTS = 8;

// ---- ML ----------------------------------------------------------------------

/**
 * Analyze the ML pair for one game.
 * Inputs: array of two markets (or one — degenerate).
 * Output: { decision, reason, evidence }
 */
export function analyzeMl(markets) {
  if (!markets || markets.length === 0) {
    return { decision: 'NO CLEAR PICK', reason: 'ML market missing for this game.' };
  }
  if (markets.length === 1) {
    return { decision: 'WATCH', reason: 'Only one side of ML is posted; pair de-vig impossible.' };
  }
  // Pick the two ML markets (typically exactly 2).
  const a = markets[0];
  const b = markets[1];
  const aYesAsk = toCents(a.yes_ask_dollars);
  const bYesAsk = toCents(b.yes_ask_dollars);
  const aYesBid = toCents(a.yes_bid_dollars);
  const bYesBid = toCents(b.yes_bid_dollars);
  if (aYesAsk == null || bYesAsk == null) {
    return { decision: 'WATCH', reason: 'ML pair missing ask quotes; cannot de-vig.' };
  }
  const sumYesAsk = aYesAsk + bYesAsk;
  // Cross-side arbitrage: pay < 100¢ to own both YES legs.
  if (sumYesAsk < 100 - CLEAR_CENTS) {
    return {
      decision: 'CLEAR',
      reason: `ML cross-side arb: YES(${a.ticker})=${aYesAsk}¢ + YES(${b.ticker})=${bYesAsk}¢ = ${sumYesAsk}¢ < 100¢.`,
      evidence: { sumYesAsk, a: aYesAsk, b: bYesAsk },
    };
  }
  if (sumYesAsk < 100) {
    return {
      decision: 'LEAN',
      reason: `ML near-arb: YES asks total ${sumYesAsk}¢ (< 100¢, within noise band).`,
      evidence: { sumYesAsk },
    };
  }
  // Wide spread → WATCH.
  const spreadA = aYesAsk != null && aYesBid != null ? aYesAsk - aYesBid : null;
  const spreadB = bYesAsk != null && bYesBid != null ? bYesAsk - bYesBid : null;
  if ((spreadA != null && spreadA > WIDE_SPREAD_CENTS) || (spreadB != null && spreadB > WIDE_SPREAD_CENTS)) {
    return {
      decision: 'WATCH',
      reason: `ML quote spread wide: ${a.ticker} ${spreadA ?? '?'}¢ / ${b.ticker} ${spreadB ?? '?'}¢ — liquidity, not edge.`,
    };
  }
  return {
    decision: 'PASS',
    reason: `ML pair fair within market: YES asks total ${sumYesAsk}¢ (overround = ${sumYesAsk - 100}¢); favoritism alone is not a pick.`,
  };
}

// ---- ladder analysis --------------------------------------------------------

/**
 * Given a list of {strike, yesAsk, ticker, label} sorted by strike ascending,
 * detect any inversion where YES rises with strike on a YES-Over style ladder.
 * Returns the worst inversion or null.
 */
export function findLadderInversion(rungs) {
  if (!rungs || rungs.length < 2) return null;
  let worst = null;
  for (let i = 1; i < rungs.length; i += 1) {
    const lo = rungs[i - 1];
    const hi = rungs[i];
    if (lo.yesAsk == null || hi.yesAsk == null) continue;
    // For YES = "OVER strike", higher strike must have YES <= lower strike YES.
    const delta = hi.yesAsk - lo.yesAsk;
    if (delta > NOISE_CENTS && (!worst || delta > worst.delta)) {
      worst = { lo, hi, delta };
    }
  }
  return worst;
}

function classifyInversion(delta) {
  if (delta >= CLEAR_CENTS) return 'CLEAR';
  if (delta >= LEAN_CENTS) return 'LEAN';
  return null;
}

// ---- spread ------------------------------------------------------------------

function bucketSpreadByTeam(markets, awayAbbrev, homeAbbrev) {
  // Use yes_sub_title text like "Chicago C wins by over 3.5 runs" or
  // "Milwaukee wins by over 1.5 runs" plus ticker as fallback.
  const buckets = new Map(); // team -> [{strike, yesAsk, ticker, label}]
  for (const m of markets) {
    const label = (m.yes_sub_title || m.title || m.ticker || '').trim();
    const lower = label.toLowerCase();
    const match = lower.match(/by over (\d+(?:\.\d+)?)/);
    if (!match) continue;
    const strike = Number(match[1]);
    // Team detection: look for known team words at start; fall back to "team1"/"team2" by order.
    let team = null;
    // crude heuristic: which side of "wins"
    const teamWord = lower.split(' wins by')[0].trim();
    team = teamWord || 'unknown';
    const yesAsk = toCents(m.yes_ask_dollars);
    if (!buckets.has(team)) buckets.set(team, []);
    buckets.get(team).push({ strike, yesAsk, ticker: m.ticker, label });
  }
  for (const arr of buckets.values()) arr.sort((a, b) => a.strike - b.strike);
  return buckets;
}

export function analyzeSpread(markets) {
  if (!markets || markets.length === 0) {
    return { decision: 'NO CLEAR PICK', reason: 'Spread market missing for this game.' };
  }
  const buckets = bucketSpreadByTeam(markets);
  let bestInversion = null;
  let bestTeam = null;
  for (const [team, rungs] of buckets) {
    const inv = findLadderInversion(rungs);
    if (inv && (!bestInversion || inv.delta > bestInversion.delta)) {
      bestInversion = inv;
      bestTeam = team;
    }
  }
  if (bestInversion) {
    const cls = classifyInversion(bestInversion.delta);
    if (cls) {
      return {
        decision: cls,
        reason: `Spread ladder inverted for ${bestTeam}: ${bestInversion.hi.label} (${bestInversion.hi.yesAsk}¢) priced above ${bestInversion.lo.label} (${bestInversion.lo.yesAsk}¢) by ${bestInversion.delta}¢ — fade YES on the higher strike or buy NO.`,
        evidence: bestInversion,
      };
    }
  }
  return {
    decision: 'PASS',
    reason: 'Spread ladders monotone within noise; no market-internal edge.',
  };
}

// ---- total / game ceiling ----------------------------------------------------

function parseTotalRungs(markets) {
  const rungs = [];
  for (const m of markets) {
    const label = (m.yes_sub_title || m.title || m.ticker || '').trim();
    const match = label.toLowerCase().match(/over (\d+(?:\.\d+)?)\s+runs?/);
    if (!match) continue;
    rungs.push({
      strike: Number(match[1]),
      yesAsk: toCents(m.yes_ask_dollars),
      ticker: m.ticker,
      label,
    });
  }
  rungs.sort((a, b) => a.strike - b.strike);
  return rungs;
}

export function analyzeTotal(markets) {
  if (!markets || markets.length === 0) {
    return { decision: 'NO CLEAR PICK', reason: 'Total market missing for this game.' };
  }
  const rungs = parseTotalRungs(markets);
  const inv = findLadderInversion(rungs);
  if (inv) {
    const cls = classifyInversion(inv.delta);
    if (cls) {
      return {
        decision: cls,
        reason: `Total ladder inverted: ${inv.hi.label} (${inv.hi.yesAsk}¢) above ${inv.lo.label} (${inv.lo.yesAsk}¢) by ${inv.delta}¢ — fade YES on the higher Over.`,
        evidence: inv,
      };
    }
  }
  return {
    decision: 'PASS',
    reason: `Total ladder monotone across ${rungs.length} rungs; no inversion above ${LEAN_CENTS}¢ noise.`,
  };
}

// Game total "ceiling" — purely market-internal: find the highest Over strike
// still trading >= 10¢ YES ask. This is descriptive, not predictive.
export function analyzeTotalCeiling(markets) {
  if (!markets || markets.length === 0) {
    return { decision: 'NO CLEAR PICK', ceiling: null, reason: 'Total market missing.' };
  }
  const rungs = parseTotalRungs(markets);
  const live = rungs.filter((r) => r.yesAsk != null && r.yesAsk >= 10);
  const ceiling = live.length ? live[live.length - 1] : null;
  return {
    decision: 'PASS',
    ceiling,
    reason: ceiling
      ? `Market-implied ceiling rung: Over ${ceiling.strike} still bid at ${ceiling.yesAsk}¢ YES; above that, market prices it as tail.`
      : 'No Over rung trades >= 10¢ YES; market expects a low-scoring environment.',
  };
}

// ---- HR props ---------------------------------------------------------------

function groupByPlayer(markets) {
  const groups = new Map();
  for (const m of markets) {
    const t = m.ticker || '';
    const parts = t.split('-');
    const playerTok = parts.length >= 3 ? parts[parts.length - 2] : t;
    if (!groups.has(playerTok)) groups.set(playerTok, []);
    groups.get(playerTok).push(m);
  }
  return groups;
}

function playerName(m) {
  const t = m.title || m.yes_sub_title || '';
  const idx = t.indexOf(':');
  if (idx > 0) return t.slice(0, idx).trim();
  return null;
}

export function analyzeHr(markets) {
  if (!markets || markets.length === 0) {
    return { perPlayer: [], decision: 'NO CLEAR PICK', reason: 'HR market missing for this game.' };
  }
  const groups = groupByPlayer(markets);
  const perPlayer = [];
  let bestLean = null;
  for (const [tok, mks] of groups) {
    const name = playerName(mks[0]) || tok;
    const rungs = mks
      .map((m) => ({
        strike: num(m.floor_strike),
        yesAsk: toCents(m.yes_ask_dollars),
        ticker: m.ticker,
        label: m.floor_strike != null ? `${m.floor_strike}+ HR` : 'HR',
      }))
      .filter((r) => r.strike != null)
      .sort((a, b) => a.strike - b.strike);
    const inv = findLadderInversion(rungs);
    const cls = inv ? classifyInversion(inv.delta) : null;
    if (cls) {
      const entry = {
        name, decision: cls,
        reason: `HR ladder inverted: ${inv.hi.label} ${inv.hi.yesAsk}¢ > ${inv.lo.label} ${inv.lo.yesAsk}¢ by ${inv.delta}¢.`,
      };
      perPlayer.push(entry);
      if (!bestLean || (inv.delta > (bestLean._delta ?? 0))) {
        bestLean = { ...entry, _delta: inv.delta };
      }
    } else {
      perPlayer.push({
        name, decision: 'NO CLEAR PICK',
        reason: 'HR ladder monotone; lineup/park/weather/handedness context required for any LEAN — not modeled here.',
      });
    }
  }
  return {
    perPlayer,
    decision: bestLean ? bestLean.decision : 'NO CLEAR PICK',
    reason: bestLean ? `HR section best signal: ${bestLean.name} — ${bestLean.reason}` : 'No HR ladder inversion exceeds noise; no market-internal pick.',
  };
}

// ---- K props ----------------------------------------------------------------

export function analyzeKs(markets, sideAbbrev) {
  if (!markets || markets.length === 0) {
    return { perPitcher: [], decision: 'NO CLEAR PICK', reason: 'K-prop market missing for this game.' };
  }
  const sideMks = markets.filter((m) => {
    const parts = (m.ticker || '').split('-');
    const playerTok = parts.length >= 3 ? parts[parts.length - 2] : '';
    return playerTok.startsWith(sideAbbrev || '___NEVER___');
  });
  if (!sideMks.length) {
    return { perPitcher: [], decision: 'NO CLEAR PICK', reason: 'Starter K ladder not posted at report time.' };
  }
  const groups = groupByPlayer(sideMks);
  const perPitcher = [];
  let bestLean = null;
  for (const [tok, mks] of groups) {
    const name = playerName(mks[0]) || tok;
    const rungs = mks
      .map((m) => ({
        strike: num(m.floor_strike),
        yesAsk: toCents(m.yes_ask_dollars),
        ticker: m.ticker,
        label: m.floor_strike != null ? `${m.floor_strike + 0.5}+` : 'K',
      }))
      .filter((r) => r.strike != null)
      .sort((a, b) => a.strike - b.strike);
    const inv = findLadderInversion(rungs);
    const cls = inv ? classifyInversion(inv.delta) : null;
    if (cls) {
      const entry = {
        name, decision: cls,
        reason: `K ladder inverted: ${inv.hi.label} ${inv.hi.yesAsk}¢ > ${inv.lo.label} ${inv.lo.yesAsk}¢ by ${inv.delta}¢ — fade YES on the higher rung.`,
      };
      perPitcher.push(entry);
      if (!bestLean || inv.delta > (bestLean._delta ?? 0)) bestLean = { ...entry, _delta: inv.delta };
    } else {
      perPitcher.push({
        name, decision: 'WATCH',
        reason: 'K ladder monotone; projected IP, opp K% vs handedness, park, ump/weather NOT checked — required before any LEAN.',
      });
    }
  }
  return {
    perPitcher,
    decision: bestLean ? bestLean.decision : 'WATCH',
    reason: bestLean ? `Best K signal: ${bestLean.name} — ${bestLean.reason}` : 'K ladders monotone; context gates unchecked.',
  };
}

// ---- YFRI/NFRI --------------------------------------------------------------

export function analyzeYfri(markets) {
  if (!markets || markets.length === 0) {
    return { decision: 'NO CLEAR PICK', reason: 'YFRI/NFRI market missing.' };
  }
  const m = markets[0];
  const yesAsk = toCents(m.yes_ask_dollars);
  const noAsk = toCents(m.no_ask_dollars);
  if (yesAsk == null || noAsk == null) {
    return { decision: 'WATCH', reason: 'YFRI/NFRI quotes incomplete; cannot evaluate.' };
  }
  const sum = yesAsk + noAsk;
  if (sum < 100 - CLEAR_CENTS) {
    return {
      decision: 'CLEAR',
      reason: `YFRI/NFRI cross-side arb: YES ${yesAsk}¢ + NO ${noAsk}¢ = ${sum}¢ < 100¢.`,
    };
  }
  return {
    decision: 'PASS',
    reason: 'YFRI/NFRI single 2-sided market; without 1st-inning xWOBA, lineup top-3 hand, weather, park 1st-inning factor, no market-internal edge.',
  };
}

// ---- whole-game aggregation -------------------------------------------------

export function analyzeGame(game) {
  const mlAnalysis = analyzeMl(game.series.ml?.markets || []);
  const spreadAnalysis = analyzeSpread(game.series.spread?.markets || []);
  const totalAnalysis = analyzeTotal(game.series.total?.markets || []);
  const ceilingAnalysis = analyzeTotalCeiling(game.series.total?.markets || []);
  const hrAnalysis = analyzeHr(game.series.hr?.markets || []);
  const ksAwayAnalysis = analyzeKs(game.series.ks?.markets || [], game.away);
  const ksHomeAnalysis = analyzeKs(game.series.ks?.markets || [], game.home);
  const yfriAnalysis = analyzeYfri(game.series.rfi?.markets || []);

  const sectionDecisions = [mlAnalysis, spreadAnalysis, totalAnalysis, hrAnalysis, ksAwayAnalysis, ksHomeAnalysis, yfriAnalysis];
  const clearLeanItems = sectionDecisions.filter((s) => s.decision === 'CLEAR' || s.decision === 'LEAN');

  // Best overall angle = strongest CLEAR > strongest LEAN > otherwise NO CLEAR PICK.
  let finalDecision = 'NO CLEAR PICK';
  let finalReason = 'No section produced a market-internal CLEAR or LEAN; modeled fair-value / lineup / weather / starter context required for further calls.';
  let bestAngle = 'NO CLEAR PICK';
  const clears = clearLeanItems.filter((x) => x.decision === 'CLEAR');
  const leans = clearLeanItems.filter((x) => x.decision === 'LEAN');
  if (clears.length) {
    finalDecision = 'CLEAR';
    finalReason = clears[0].reason;
    bestAngle = clears[0].reason;
  } else if (leans.length) {
    finalDecision = 'LEAN';
    finalReason = leans[0].reason;
    bestAngle = leans[0].reason;
  }

  return {
    sections: {
      ml: mlAnalysis,
      spread: spreadAnalysis,
      total: totalAnalysis,
      ceiling: ceilingAnalysis,
      hr: hrAnalysis,
      ks_away: ksAwayAnalysis,
      ks_home: ksHomeAnalysis,
      yfri: yfriAnalysis,
    },
    final: { decision: finalDecision, reason: finalReason, best_angle: bestAngle },
    clear_lean_count: clearLeanItems.length,
  };
}

export function aggregateClusterAnalyses(gameAnalyses) {
  let total = 0;
  const items = [];
  for (const ga of gameAnalyses) {
    total += ga.analysis.clear_lean_count;
    if (ga.analysis.clear_lean_count > 0) {
      items.push({ matchup: ga.matchup, final: ga.analysis.final, sections: ga.analysis.sections });
    }
  }
  return { clear_lean_total: total, items };
}

export const _internal = { NOISE_CENTS, LEAN_CENTS, CLEAR_CENTS, WIDE_SPREAD_CENTS };
