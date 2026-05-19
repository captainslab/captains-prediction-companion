// Article-style rendering for MLB pre-lock reports.
// Pure functions. No network, no fs. Consumes joined game objects + analysis
// from market-engine.analyzeGame().
//
// Rules:
//   - No invented lineup / weather / starter / park context. If the underlying
//     report did not surface it, the article notes it as MISSING.
//   - HR / K props are not promoted to "strong pick" tier here. They remain
//     descriptive unless analyzeGame() returned a CLEAR/LEAN with reason text.
//   - When no CLEAR/LEAN exists at any level we still produce an article;
//     it just plainly says NO CLEAR PICK and explains the board state.
//   - Renderer is pure: same inputs -> same text. Caller controls the date /
//     headline timestamp by passing them in.

import { MLB_SERIES } from './series-discovery.mjs';

const SERIES_LABEL = {
  ml: 'Moneyline',
  spread: 'Spread',
  total: 'Total',
  hr: 'Home Runs',
  ks: 'Pitcher Strikeouts',
  rfi: 'YFRI / NFRI',
};

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

function renderMarketOverview(game) {
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

export function buildGameArticle({ date, game, analysis }) {
  const matchup = safeMatchup(game);
  const tickers = eventTickersFor(game);
  const best = bestSection(analysis);
  const finalLabel = decisionLabel(analysis.final.decision);
  const headline = finalLabel === 'CLEAR' || finalLabel === 'LEAN'
    ? `${matchup} — ${finalLabel}: ${analysis.final.best_angle}`
    : `${matchup} — NO CLEAR PICK (board only)`;

  const lines = [];
  lines.push(headline);
  lines.push('='.repeat(Math.min(headline.length, 80)));
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
  lines.push(renderMarketOverview(game));
  lines.push('');

  lines.push('Best angle');
  lines.push(`  Label: ${finalLabel}`);
  lines.push(`  Source: ${best.key} section`);
  lines.push(`  Reason: ${analysis.final.reason}`);
  lines.push('');

  lines.push('Pick summary');
  if (finalLabel === 'CLEAR' || finalLabel === 'LEAN') {
    lines.push(`  Side / market: ${analysis.final.best_angle}`);
    lines.push(`  Confidence: ${finalLabel}`);
    lines.push(`  Why: ${analysis.final.reason}`);
  } else {
    lines.push('  No defensible market-internal pick at this time.');
    lines.push(`  Section postures: ML=${analysis.sections.ml.decision}, Spread=${analysis.sections.spread.decision}, Total=${analysis.sections.total.decision}, YFRI=${analysis.sections.yfri.decision}`);
  }
  lines.push('');

  lines.push('Evidence');
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

  if (propAlerts.length) {
    lines.push('');
    lines.push('Prop Market Watchlist (anomalies — not game picks)');
    for (const a of hrAlerts) {
      lines.push(`  - HR ${a.name}: MARKET ANOMALY (raw=${a.raw_decision}) — ${a.reason}`);
    }
    for (const a of kAlerts) {
      lines.push(`  - K ${a.name} (${a.side}): MARKET ANOMALY (raw=${a.raw_decision}) — ${a.reason}`);
    }
    lines.push('  Caveat: Prop anomalies are not official picks without liquidity, lineup, starter, and context confirmation.');
  }
  lines.push('');

  lines.push('Risk notes');
  lines.push('  Lineups: MISSING (this report does not pull lineups).');
  lines.push('  Weather/park: MISSING (not pulled).');
  lines.push('  Starters: MISSING (not pulled beyond market presence).');
  lines.push('  Thin liquidity / stale rungs may have been filtered by the engine; see section reasons above.');
  lines.push('');

  lines.push('Final call');
  if (finalLabel === 'CLEAR' || finalLabel === 'LEAN') {
    lines.push(`  ${finalLabel}: ${analysis.final.best_angle}`);
  } else {
    lines.push('  NO CLEAR PICK. Board attached for review only. No pick is being claimed.');
  }
  lines.push('  No trades placed. No bankroll sizing. Research only.');

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

export function buildSlateArticle({ date, items, planMeta = {} }) {
  // items: [{ game, analysis, gameArticle }]
  const ranked = items
    .map((it) => ({
      game_key: it.game.game_key,
      matchup: shortMatchup(it.game),
      decision: decisionLabel(it.analysis.final.decision),
      best_angle: it.analysis.final.best_angle,
      reason: it.analysis.final.reason,
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
  lines.push(`  CLEAR: ${clears.length}`);
  lines.push(`  LEAN: ${leans.length}`);
  lines.push(`  WATCH: ${watches.length}`);
  lines.push(`  PASS / NO CLEAR PICK: ${passes.length}`);
  if (planMeta.cluster_count != null) lines.push(`  Plan clusters: ${planMeta.cluster_count}`);
  lines.push('');

  lines.push('Ranked picks');
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

  lines.push('Best 3 angles of the slate');
  const top3 = [...clears, ...leans, ...watches].slice(0, 3);
  if (!top3.length) {
    lines.push('  None — no game produced a defensible angle on market structure alone.');
  } else {
    for (const r of top3) lines.push(`  - [${r.decision}] ${r.matchup}: ${r.best_angle} — ${r.reason}`);
  }
  lines.push('');

  lines.push('Games with no pick and why');
  if (!passes.length) {
    lines.push('  (none — all games produced at least a WATCH-level posture)');
  } else {
    for (const r of passes) lines.push(`  - ${r.matchup} (${r.game_key}): ${r.reason}`);
  }
  lines.push('');

  // Prop Market Watchlist: HR/K ladder anomalies are NOT slate picks.
  // They never count toward CLEAR/LEAN totals or the slate headline.
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
  lines.push('  All decisions are market-internal: quote gaps, OI/liquidity, spread confirmation, ladder behavior.');
  lines.push('  Soft-LEAN ML promotion requires quote gap + OI ratio + spread confirmation; HR/K props are not soft-LEANed.');
  lines.push('  No trades. No bankroll sizing. Research only.');
  lines.push('');

  lines.push('Final slate conclusion');
  if (pickCount === 0) {
    lines.push('  Slate is board-only. No defensible market-internal CLEAR/LEAN. Watch live for movement.');
  } else if (clears.length) {
    lines.push(`  Lead with the ${clears.length} CLEAR angle(s); LEANs are secondary. Re-check liquidity before lock.`);
  } else {
    lines.push(`  Slate has ${leans.length} LEAN angle(s) only. Treat as soft reads; nothing here justifies oversizing.`);
  }

  return {
    headline,
    text: lines.join('\n'),
    ranked,
    counts: { clear: clears.length, lean: leans.length, watch: watches.length, pass: passes.length },
  };
}
