// Article-style rendering for MLB pre-lock reports.
// Pure functions. No network, no fs. Consumes joined game objects + analysis
// from market-engine.analyzeGame().
//
// Output target: readable Telegram betting-market articles. The numeric
// engine evidence (quote gap, OI ratio, soft-LEAN logic, gate thresholds,
// market-internal labels) is preserved in a compact Evidence Box. The
// surrounding prose stays plain English so the article does not read like
// a debug log.
//
// Style rules enforced here:
//   - Main prose (Market Read, Why ...) mentions "gap" at most once and
//     "OI ratio" at most once. Repeating those phrases is what made the
//     old output read like engine output.
//   - The strings "soft-LEAN", "gate", and "market-internal" only appear
//     inside the Evidence Box or the System Caveats line.
//   - No invented lineup / weather / starter / park / injury context.
//   - HR / K props stay in a Prop Market Watchlist; never a Tier 1 pick.

import { MLB_SERIES } from './series-discovery.mjs';

function dollarsToCents(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function fmtCents(c) {
  return c == null ? 'MISSING' : `${c}\u00a2`;
}

function quoteLine(m) {
  const y = dollarsToCents(m.yes_ask_dollars);
  const n = dollarsToCents(m.no_ask_dollars);
  const oi = m.open_interest_fp ?? '?';
  const vol = m.volume_fp ?? '?';
  return `YES ${fmtCents(y)} / NO ${fmtCents(n)}  (oi=${oi} vol=${vol})`;
}

function teamFromSuffix(market, eventTicker) {
  const t = market.ticker || '';
  if (!eventTicker || !t.startsWith(`${eventTicker}-`)) return null;
  return t.slice(eventTicker.length + 1);
}

function safeMatchup(game) {
  if (game.away_full && game.home_full) return `${game.away_full} at ${game.home_full}`;
  return `${game.away ?? '?'} at ${game.home ?? '?'}`;
}

function shortMatchup(game) {
  return `${game.away ?? '?'} @ ${game.home ?? '?'}`;
}

function eventTickersFor(game) {
  const out = {};
  for (const sid of Object.keys(MLB_SERIES)) {
    const s = game.series?.[sid];
    out[sid] = s ? s.event_ticker : null;
  }
  return out;
}

function fmtInt(n) {
  if (n == null || !Number.isFinite(Number(n))) return '?';
  return Math.round(Number(n)).toLocaleString('en-US');
}

// Extract ML favorite/dog snapshot (by YES ask price) plus OI.
function mlSnapshot(game) {
  const ml = game.series?.ml;
  if (!ml || !ml.markets?.length) return null;
  const rows = ml.markets.map((m) => ({
    team: teamFromSuffix(m, ml.event_ticker) || 'YES',
    yes_c: dollarsToCents(m.yes_ask_dollars),
    no_c: dollarsToCents(m.no_ask_dollars),
    oi: Number(m.open_interest_fp ?? 0),
    vol: Number(m.volume_fp ?? 0),
  }));
  if (rows.length < 2) return { rows };
  // Favorite = higher YES ask (more expensive to buy YES on).
  const sorted = [...rows].sort((a, b) => (b.yes_c ?? 0) - (a.yes_c ?? 0));
  const fav = sorted[0];
  const dog = sorted[1];
  return { rows, fav, dog };
}

function totalsSnapshot(game) {
  const tot = game.series?.total;
  if (!tot || !tot.markets?.length) return null;
  // Find the line whose YES ask is closest to 50¢ — that is the "main" total.
  const rows = tot.markets.map((m) => ({
    label: (m.yes_sub_title || m.title || '').trim(),
    yes_c: dollarsToCents(m.yes_ask_dollars),
    no_c: dollarsToCents(m.no_ask_dollars),
    oi: Number(m.open_interest_fp ?? 0),
  }));
  const valid = rows.filter((r) => r.yes_c != null);
  if (!valid.length) return null;
  valid.sort((a, b) => Math.abs((a.yes_c ?? 0) - 50) - Math.abs((b.yes_c ?? 0) - 50));
  return { main: valid[0], rows };
}

function rfiSnapshot(game) {
  const rfi = game.series?.rfi;
  if (!rfi || !rfi.markets?.length) return null;
  const m = rfi.markets[0];
  return {
    yes_c: dollarsToCents(m.yes_ask_dollars),
    no_c: dollarsToCents(m.no_ask_dollars),
    oi: Number(m.open_interest_fp ?? 0),
  };
}

// Find any spread market that confirms the favorite (favorite -1.5 YES ≥ 30¢).
function spreadConfirmation(game, favTeam) {
  const sp = game.series?.spread;
  if (!sp || !sp.markets?.length || !favTeam) return { confirms: null };
  let best = null;
  for (const m of sp.markets) {
    const label = (m.yes_sub_title || m.title || '').toLowerCase();
    if (!label.includes('1.5')) continue;
    // Heuristic: the suffix team on the ticker matches favorite.
    const team = teamFromSuffix(m, sp.event_ticker) || '';
    const matches = team === favTeam || label.includes(favTeam.toLowerCase());
    if (!matches) continue;
    const y = dollarsToCents(m.yes_ask_dollars);
    if (y == null) continue;
    if (!best || y > best.yes_c) best = { yes_c: y, label: m.yes_sub_title || m.title };
  }
  if (!best) return { confirms: null };
  return { confirms: best.yes_c >= 30, yes_c: best.yes_c, label: best.label };
}

function renderMarketOverview(game) {
  // Kept as a compact factual ledger inside Evidence Box (and the Game info
  // block above it). Not the lead prose.
  const lines = ['Market overview'];
  const ml = game.series?.ml;
  if (!ml || !ml.markets?.length) {
    lines.push('  ML: MISSING / UNQUOTED');
  } else {
    for (const m of ml.markets) {
      const team = teamFromSuffix(m, ml.event_ticker) || 'YES';
      lines.push(`  ML ${team}: ${quoteLine(m)}`);
    }
  }
  const sp = game.series?.spread;
  if (!sp || !sp.markets?.length) {
    lines.push('  Spread: MISSING / UNQUOTED');
  } else {
    for (const m of sp.markets) {
      const label = (m.yes_sub_title || m.title || m.ticker || '?').trim();
      lines.push(`  Spread ${label}: ${quoteLine(m)}`);
    }
  }
  const tot = game.series?.total;
  if (!tot || !tot.markets?.length) {
    lines.push('  Total: MISSING / UNQUOTED');
  } else {
    for (const m of tot.markets) {
      const label = (m.yes_sub_title || m.title || m.ticker || '?').trim();
      lines.push(`  Total ${label}: ${quoteLine(m)}`);
    }
  }
  const hr = game.series?.hr;
  if (!hr || !hr.markets?.length) {
    lines.push('  HR props: MISSING / UNQUOTED');
  } else {
    lines.push(`  HR props: ${hr.markets.length} player markets posted`);
  }
  const ks = game.series?.ks;
  if (!ks || !ks.markets?.length) {
    lines.push('  K props: MISSING / UNQUOTED');
  } else {
    lines.push(`  K props: ${ks.markets.length} starter ladders posted`);
  }
  const rfi = game.series?.rfi;
  if (!rfi || !rfi.markets?.length) {
    lines.push('  YFRI/NFRI: MISSING / UNQUOTED');
  } else {
    const m = rfi.markets[0];
    lines.push(`  YFRI/NFRI: ${quoteLine(m)}`);
  }
  return lines.join('\n');
}

function bestSection(analysis) {
  const order = { CLEAR: 0, LEAN: 1, WATCH: 2, PASS: 3, 'NO CLEAR PICK': 4 };
  const cand = [
    { key: 'ML', sec: analysis.sections.ml },
    { key: 'Spread', sec: analysis.sections.spread },
    { key: 'Total', sec: analysis.sections.total },
    { key: 'YFRI', sec: analysis.sections.yfri },
  ];
  cand.sort((a, b) => (order[a.sec.decision] ?? 9) - (order[b.sec.decision] ?? 9));
  return cand[0];
}

function decisionLabel(d) {
  if (d === 'CLEAR' || d === 'LEAN' || d === 'WATCH' || d === 'PASS') return d;
  return 'NO CLEAR PICK';
}

// Build the natural-language Market Read paragraph. This is the lead prose
// of the article. It MUST stay free of repeated engine vocabulary.
function renderMarketRead(game, mlSnap, totSnap, rfiSnap, spreadConf) {
  const sentences = [];
  if (mlSnap?.fav && mlSnap?.dog) {
    sentences.push(
      `The moneyline prices ${mlSnap.fav.team} as the favorite at ${fmtCents(mlSnap.fav.yes_c)}, with ${mlSnap.dog.team} on the other side at ${fmtCents(mlSnap.dog.yes_c)}.`,
    );
    if (mlSnap.fav.oi && mlSnap.dog.oi) {
      const heavier = mlSnap.fav.oi >= mlSnap.dog.oi ? mlSnap.fav : mlSnap.dog;
      const lighter = heavier === mlSnap.fav ? mlSnap.dog : mlSnap.fav;
      const dom = heavier.oi >= 2 * lighter.oi ? 'far heavier' : heavier.oi >= 1.3 * lighter.oi ? 'meaningfully heavier' : 'roughly balanced';
      sentences.push(
        `Open interest sits ${dom} on ${heavier.team} (${fmtInt(heavier.oi)} vs ${fmtInt(lighter.oi)}).`,
      );
    }
  } else if (mlSnap?.rows?.length) {
    sentences.push('Moneyline is posted but the pair is incomplete or unpriced.');
  } else {
    sentences.push('No moneyline quotes were available for this game.');
  }
  if (spreadConf?.confirms === true) {
    sentences.push(`The spread ladder backs that read: ${spreadConf.label} sits at ${fmtCents(spreadConf.yes_c)}.`);
  } else if (spreadConf?.confirms === false) {
    sentences.push(`The spread ladder is thin on the favorite side (${spreadConf.label} only ${fmtCents(spreadConf.yes_c)}), so it does not back the moneyline read.`);
  } else {
    sentences.push('The spread ladder does not give a usable favorite-side read at -1.5.');
  }
  if (totSnap?.main) {
    sentences.push(`Total sits around ${totSnap.main.label} at ${fmtCents(totSnap.main.yes_c)} YES.`);
  }
  if (rfiSnap) {
    sentences.push(`YFRI/NFRI is posted at ${fmtCents(rfiSnap.yes_c)} / ${fmtCents(rfiSnap.no_c)}.`);
  }
  return sentences.join(' ');
}

function renderWhyPick(analysis, mlSnap, spreadConf) {
  const d = analysis.final.decision;
  if (d === 'CLEAR' || d === 'LEAN') {
    const side = mlSnap?.fav?.team || 'the favorite';
    const points = [];
    points.push(`price separation favors ${side}`);
    if (mlSnap?.fav?.oi && mlSnap?.dog?.oi && mlSnap.fav.oi >= 1.3 * mlSnap.dog.oi) {
      points.push('open interest is one-sided in the same direction');
    }
    if (spreadConf?.confirms === true) points.push('the spread ladder agrees');
    else if (spreadConf?.confirms === false) points.push('the spread ladder is not contradicting outright');
    const joined = points.length ? points.join(', ') : 'the market reads one-sided on price and depth';
    return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}. Nothing about lineups, weather, starters, or park is folded in — this is a read on what the market itself is showing.`;
  }
  // PASS / NO CLEAR PICK
  return 'Prices, depth, spread shape, total and first-inning markets all read close to fair given what is posted. No side here is defensible without outside context this report does not pull (lineups, weather, starters, park).';
}

function renderBottomLine(analysis, mlSnap) {
  const d = analysis.final.decision;
  if (d === 'CLEAR') {
    const side = mlSnap?.fav?.team || 'favorite';
    return `Call: CLEAR — ${side}. Re-check liquidity before lock. No trades placed, no sizing.`;
  }
  if (d === 'LEAN') {
    const side = mlSnap?.fav?.team || 'favorite';
    return `Call: LEAN — ${side}. Treat as a soft read; nothing here justifies oversizing. No trades placed, no sizing.`;
  }
  return 'Call: PASS — board only. Nothing actionable from the market alone. No trades placed, no sizing.';
}

export function buildGameArticle({ date, game, analysis }) {
  const matchup = safeMatchup(game);
  const tickers = eventTickersFor(game);
  const best = bestSection(analysis);
  const finalLabel = decisionLabel(analysis.final.decision);

  const mlSnap = mlSnapshot(game);
  const totSnap = totalsSnapshot(game);
  const rfiSnap = rfiSnapshot(game);
  const spreadConf = spreadConfirmation(game, mlSnap?.fav?.team);

  const headline = finalLabel === 'CLEAR' || finalLabel === 'LEAN'
    ? `${matchup} — ${finalLabel} ${mlSnap?.fav?.team ?? ''}`.trim()
    : `${matchup} — NO CLEAR PICK`;

  const finalCallLine = finalLabel === 'CLEAR' || finalLabel === 'LEAN'
    ? `${finalLabel} on ${mlSnap?.fav?.team ?? 'favorite'} moneyline`
    : 'PASS — board only, no defensible side';

  const lines = [];
  lines.push(headline);
  lines.push('='.repeat(Math.min(headline.length, 80)));
  lines.push('');

  lines.push('Final Call');
  lines.push(`  ${finalCallLine}`);
  lines.push('');

  lines.push('Game info');
  lines.push(`  Date: ${date}`);
  lines.push(`  Matchup: ${matchup}`);
  lines.push(`  First pitch: ${game.start_ct ?? game.first_pitch_ct ?? 'MISSING'}  /  ${game.start_utc ?? game.first_pitch_utc ?? 'MISSING'}`);
  lines.push(`  Game key: ${game.game_key ?? 'MISSING'}`);
  lines.push(`  ML event: ${tickers.ml ?? 'MISSING'}`);
  lines.push(`  Spread event: ${tickers.spread ?? 'MISSING'}`);
  lines.push(`  Total event: ${tickers.total ?? 'MISSING'}`);
  lines.push(`  HR event: ${tickers.hr ?? 'MISSING'}`);
  lines.push(`  K event: ${tickers.ks ?? 'MISSING'}`);
  lines.push(`  YFRI event: ${tickers.rfi ?? 'MISSING'}`);
  lines.push('');

  lines.push('Market Read');
  lines.push('  ' + renderMarketRead(game, mlSnap, totSnap, rfiSnap, spreadConf));
  lines.push('');

  const whyHeader = (finalLabel === 'CLEAR' || finalLabel === 'LEAN') ? 'Why This Side' : 'Why No Pick';
  lines.push(whyHeader);
  lines.push('  ' + renderWhyPick(analysis, mlSnap, spreadConf));
  lines.push('');

  // Evidence Box: the engine-vocabulary stuff lives here. Numbers + reasons.
  lines.push('Evidence Box');
  lines.push(`  Best angle source: ${best.key} section — engine label ${finalLabel}`);
  lines.push(`  Engine reason: ${analysis.final.reason}`);
  lines.push(`  ML: ${analysis.sections.ml.decision} — ${analysis.sections.ml.reason}`);
  lines.push(`  Spread: ${analysis.sections.spread.decision} — ${analysis.sections.spread.reason}`);
  lines.push(`  Total: ${analysis.sections.total.decision} — ${analysis.sections.total.reason}`);
  lines.push(`  YFRI: ${analysis.sections.yfri.decision} — ${analysis.sections.yfri.reason}`);
  const propAlerts = analysis.final.prop_watchlist || [];
  const hrAlerts = propAlerts.filter((a) => a.kind === 'HR');
  const kAlerts = propAlerts.filter((a) => a.kind === 'K');
  lines.push('  HR props: ' + (hrAlerts.length
    ? `${hrAlerts.length} ladder anomaly(ies) — see Prop Market Watchlist (not a game pick).`
    : 'no CLEAR/LEAN promotion (kept conservative without context).'));
  lines.push('  K props: ' + (kAlerts.length
    ? `${kAlerts.length} ladder anomaly(ies) — see Prop Market Watchlist (not a game pick).`
    : 'no CLEAR/LEAN promotion (kept conservative without context).'));
  lines.push('');
  // Compact ledger appended so the Evidence Box is self-contained for audit.
  lines.push(renderMarketOverview(game));
  lines.push('');

  if (propAlerts.length) {
    lines.push('Prop Market Watchlist (anomalies — not game picks)');
    for (const a of hrAlerts) {
      lines.push(`  - HR ${a.name}: MARKET ANOMALY (raw=${a.raw_decision}) — ${a.reason}`);
    }
    for (const a of kAlerts) {
      lines.push(`  - K ${a.name} (${a.side}): MARKET ANOMALY (raw=${a.raw_decision}) — ${a.reason}`);
    }
    lines.push('  Caveat: Prop anomalies are not official picks without liquidity, lineup, starter, and context confirmation.');
    lines.push('');
  }

  lines.push('Risk Notes');
  lines.push('  Lineups: MISSING (this report does not pull lineups).');
  lines.push('  Weather/park: MISSING (not pulled).');
  lines.push('  Starters: MISSING (not pulled beyond market presence).');
  lines.push('  Thin liquidity or stale rungs may have been filtered by the engine; see Evidence Box.');
  lines.push('');

  lines.push('Bottom Line');
  lines.push('  ' + renderBottomLine(analysis, mlSnap));

  // Legacy section anchors so older audit tooling still grepable for these
  // labels without changing pick logic.
  lines.push('');
  lines.push('Pick summary');
  if (finalLabel === 'CLEAR' || finalLabel === 'LEAN') {
    lines.push(`  Side / market: ${analysis.final.best_angle}`);
    lines.push(`  Confidence: ${finalLabel}`);
  } else {
    lines.push('  No defensible market-internal pick at this time.');
    lines.push(`  Section postures: ML=${analysis.sections.ml.decision}, Spread=${analysis.sections.spread.decision}, Total=${analysis.sections.total.decision}, YFRI=${analysis.sections.yfri.decision}`);
  }
  lines.push('');
  lines.push('Best angle');
  lines.push(`  Label: ${finalLabel}`);
  lines.push(`  Source: ${best.key} section`);
  lines.push('');
  lines.push('Evidence');
  lines.push('  See Evidence Box above.');
  lines.push('');
  lines.push('Risk notes');
  lines.push('  See Risk Notes above.');
  lines.push('');
  lines.push('Final call');
  lines.push('  ' + (finalLabel === 'CLEAR' || finalLabel === 'LEAN'
    ? `${finalLabel}: ${analysis.final.best_angle}`
    : 'NO CLEAR PICK. Board attached for review only.'));

  const text = lines.join('\n');
  return {
    headline,
    text,
    decision: finalLabel,
    best_angle: analysis.final.best_angle,
    reason: analysis.final.reason,
    game_key: game.game_key ?? null,
  };
}

function rankPriority(d) {
  const order = { CLEAR: 0, LEAN: 1, WATCH: 2, PASS: 3, 'NO CLEAR PICK': 4 };
  return order[d] ?? 9;
}

// Short prose blurb for a game on the slate article.
function slateBlurb(it) {
  const d = decisionLabel(it.analysis.final.decision);
  const snap = mlSnapshot(it.game);
  const fav = snap?.fav?.team;
  const dog = snap?.dog?.team;
  const matchup = shortMatchup(it.game);
  if (d === 'CLEAR' || d === 'LEAN') {
    const priceBit = (snap?.fav && snap?.dog)
      ? ` (${fav} ${fmtCents(snap.fav.yes_c)} vs ${dog} ${fmtCents(snap.dog.yes_c)})`
      : '';
    return `${matchup}: ${d} ${fav ?? 'favorite'}${priceBit}. Price and depth lean the same way.`;
  }
  if (d === 'WATCH') {
    return `${matchup}: WATCH — board has a wrinkle but nothing clean enough to call.`;
  }
  return `${matchup}: PASS — moneyline, spread, total and first-inning all read close to fair.`;
}

export function buildSlateArticle({ date, items, planMeta = {} }) {
  const ranked = items
    .map((it) => ({
      game_key: it.game.game_key,
      matchup: shortMatchup(it.game),
      decision: decisionLabel(it.analysis.final.decision),
      best_angle: it.analysis.final.best_angle,
      reason: it.analysis.final.reason,
      _it: it,
    }))
    .sort((a, b) => rankPriority(a.decision) - rankPriority(b.decision));

  const clears = ranked.filter((r) => r.decision === 'CLEAR');
  const leans = ranked.filter((r) => r.decision === 'LEAN');
  const watches = ranked.filter((r) => r.decision === 'WATCH');
  const passes = ranked.filter((r) => r.decision === 'PASS' || r.decision === 'NO CLEAR PICK');

  const pickCount = clears.length + leans.length;
  const headline = pickCount
    ? `MLB ${date} Slate — ${clears.length} CLEAR / ${leans.length} LEAN across ${items.length} games`
    : `MLB ${date} Slate — Board only, no CLEAR/LEAN across ${items.length} games`;

  const lines = [];
  lines.push(headline);
  lines.push('='.repeat(Math.min(headline.length, 80)));
  lines.push('');

  lines.push('Slate overview');
  lines.push(`  Date: ${date}`);
  lines.push(`  Games covered: ${items.length}`);
  lines.push(`  CLEAR: ${clears.length}   LEAN: ${leans.length}   WATCH: ${watches.length}   PASS / NO CLEAR PICK: ${passes.length}`);
  if (planMeta.cluster_count != null) lines.push(`  Plan clusters: ${planMeta.cluster_count}`);
  lines.push('');

  lines.push('Best angles ranked');
  const top = [...clears, ...leans, ...watches];
  if (!top.length) {
    lines.push('  None — no game produced a defensible angle on the market alone.');
  } else {
    let i = 1;
    for (const r of top) {
      const snap = mlSnapshot(r._it.game);
      const fav = snap?.fav?.team ?? 'favorite';
      lines.push(`  ${i}. [${r.decision}] ${r.matchup} — side: ${fav}.`);
      i++;
    }
  }
  lines.push('');

  lines.push('Tiered ranking');
  lines.push('  Tier 1 — CLEAR');
  if (!clears.length) lines.push('    (none)');
  for (const r of clears) lines.push(`    - ${r.matchup} (${r.game_key}): ${r.best_angle}`);
  lines.push('  Tier 2 — LEAN');
  if (!leans.length) lines.push('    (none)');
  for (const r of leans) lines.push(`    - ${r.matchup} (${r.game_key}): ${r.best_angle}`);
  lines.push('  Tier 3 — WATCH');
  if (!watches.length) lines.push('    (none)');
  for (const r of watches) lines.push(`    - ${r.matchup} (${r.game_key}): ${r.best_angle}`);
  lines.push('  Tier 4 — PASS / NO CLEAR PICK');
  if (!passes.length) lines.push('    (none)');
  for (const r of passes) lines.push(`    - ${r.matchup} (${r.game_key})`);
  lines.push('');

  lines.push('Game-by-game');
  for (const r of ranked) {
    lines.push('  ' + slateBlurb(r._it));
  }
  lines.push('');

  lines.push('Pass / no-pick games');
  if (!passes.length) {
    lines.push('  (none — every game produced at least a WATCH-level read)');
  } else {
    for (const r of passes) lines.push(`  - ${r.matchup} (${r.game_key})`);
  }
  lines.push('');

  // Prop Market Watchlist: HR/K ladder anomalies are NOT slate picks.
  lines.push('Prop Market Watchlist (anomalies — not game picks)');
  let propCount = 0;
  for (const it of items) {
    const alerts = it.analysis.final.prop_watchlist || [];
    if (!alerts.length) continue;
    lines.push(`  ${shortMatchup(it.game)} (${it.game.game_key}):`);
    for (const a of alerts) {
      const tag = a.kind === 'K' ? `K ${a.name} (${a.side})` : `HR ${a.name}`;
      lines.push(`    - ${tag}: MARKET ANOMALY (raw=${a.raw_decision}) — ${a.reason}`);
      propCount++;
    }
  }
  if (!propCount) lines.push('  No prop ladder anomalies detected on the slate.');
  lines.push('  Caveat: Prop anomalies are not official picks without liquidity, lineup, starter, and context confirmation.');
  lines.push('');

  lines.push('System caveats');
  lines.push('  No lineup, weather, park, starter form, or bullpen context was pulled.');
  lines.push('  All decisions are market-internal: quote separation, OI/liquidity, spread confirmation, ladder behavior.');
  lines.push('  Soft-LEAN ML promotion requires price separation + OI + spread confirmation; HR/K props are never soft-LEANed.');
  lines.push('  No trades. No bankroll sizing. Research only.');
  lines.push('');

  lines.push('Final slate conclusion');
  if (pickCount === 0) {
    lines.push('  Slate is board-only. No defensible CLEAR/LEAN. Watch live for movement.');
  } else if (clears.length) {
    lines.push(`  Lead with the ${clears.length} CLEAR angle(s); LEANs are secondary. Re-check liquidity before lock.`);
  } else {
    lines.push(`  Slate has ${leans.length} LEAN angle(s) only. Treat as soft reads; nothing here justifies oversizing.`);
  }

  // Strip the temporary _it back-references so output is JSON-safe in callers.
  const cleanRanked = ranked.map(({ _it, ...rest }) => rest);

  return {
    headline,
    text: lines.join('\n'),
    ranked: cleanRanked,
    counts: { clear: clears.length, lean: leans.length, watch: watches.length, pass: passes.length },
  };
}
