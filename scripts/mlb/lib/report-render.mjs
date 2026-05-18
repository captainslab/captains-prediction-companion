// Pure rendering of the per-game pre-lock report section.
// Inputs are normalized markets from slate discovery. No external calls.
// The decision posture defaults to NO CLEAR PICK / WATCH when context
// inputs required for a defensible LEAN are not present. This matches the
// project rule against naive-Poisson LEANs and against forcing picks.

import { MLB_SERIES } from './series-discovery.mjs';

function dollarsToCents(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function fmtCents(c) {
  return c == null ? 'MISSING' : `${c}¢`;
}

function bestQuote(market) {
  // Return "YES X¢ / NO Y¢" using ask side for entry view.
  const y = dollarsToCents(market.yes_ask_dollars);
  const n = dollarsToCents(market.no_ask_dollars);
  const last = dollarsToCents(market.last_price_dollars);
  const tag = `last=${fmtCents(last)} liq=${market.liquidity_dollars ?? '?'} oi=${market.open_interest_fp ?? '?'} vol=${market.volume_fp ?? '?'}`;
  return `YES ${fmtCents(y)} / NO ${fmtCents(n)}  (${tag})`;
}

function indent(level) { return '  '.repeat(level); }

function renderMlBlock(game) {
  const s = game.series.ml;
  if (!s) return ['- ML: MISSING — KXMLBGAME event not in slate'];
  if (!s.markets.length) return ['- ML: UNQUOTED — event has no markets[]'];
  const lines = ['- ML:'];
  for (const m of s.markets) {
    // YES side = the team in market ticker suffix; full label already
    // resolved via existing mlb-teams enrichment, but for the report we
    // keep it text-only using yes_sub_title fallback when sensible, and
    // the rules_primary always names the team unambiguously.
    const team = teamFromMarketTicker(m.ticker, s.event_ticker) || 'YES';
    lines.push(`  - ${team}: ${bestQuote(m)}`);
  }
  return lines;
}

function teamFromMarketTicker(mt, et) {
  if (!mt || !et || !mt.startsWith(`${et}-`)) return null;
  const suf = mt.slice(et.length + 1);
  // Suffix is the team abbrev for KXMLBGAME; pass through unchanged.
  return suf;
}

function renderSpreadBlock(game) {
  const s = game.series.spread;
  if (!s) return ['- Spread: MISSING — KXMLBSPREAD event not in slate'];
  if (!s.markets.length) return ['- Spread: UNQUOTED'];
  const lines = ['- Spread:'];
  for (const m of s.markets) {
    const label = (m.yes_sub_title || m.title || m.ticker || '?').trim();
    lines.push(`  - ${label}: ${bestQuote(m)}`);
  }
  return lines;
}

function renderTotalBlock(game) {
  const s = game.series.total;
  if (!s) return ['- Total: MISSING — KXMLBTOTAL event not in slate'];
  if (!s.markets.length) return ['- Total: UNQUOTED'];
  const lines = ['- Total:'];
  for (const m of s.markets) {
    const label = (m.yes_sub_title || m.title || m.ticker || '?').trim();
    lines.push(`  - ${label}: ${bestQuote(m)}`);
  }
  return lines;
}

function groupPlayerMarkets(markets) {
  // Group HR / K markets by player using the ticker pattern <...>-<TEAMCODEPLAYERTOKEN>-<N>
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

function playerNameFromMarket(m) {
  // Prefer the human name parsed from market.title, e.g. "Corbin Carroll: 1+ home runs?"
  const t = m.title || m.yes_sub_title || '';
  const idx = t.indexOf(':');
  if (idx > 0) return t.slice(0, idx).trim();
  return null;
}

function renderHrSection(game) {
  const s = game.series.hr;
  const lines = ['- Home runs:'];
  if (!s) {
    lines.push('  - MISSING — KXMLBHR event not in slate');
    return lines;
  }
  if (!s.markets.length) {
    lines.push('  - UNQUOTED — event has no markets');
    return lines;
  }
  const groups = groupPlayerMarkets(s.markets);
  for (const [tok, mks] of groups) {
    const name = playerNameFromMarket(mks[0]) || tok;
    lines.push(`  - Player: ${name}`);
    for (const m of mks.sort((a, b) => (a.floor_strike ?? 0) - (b.floor_strike ?? 0))) {
      const thresh = m.floor_strike != null ? `${m.floor_strike}+ HR` : 'HR';
      lines.push(`    - ${thresh}: ${bestQuote(m)}`);
    }
    lines.push('    - Decision: NO CLEAR PICK');
    lines.push('    - Reasoning: lineup/park/weather/handedness context not modeled in this report');
  }
  return lines;
}

function renderKsSection(game, side /* 'away' | 'home' */) {
  const s = game.series.ks;
  const heading = side === 'away'
    ? '- Away starter strikeout ceiling:'
    : '- Home starter strikeout ceiling:';
  const lines = [heading];
  if (!s) {
    lines.push('  - Ceiling: MISSING — KXMLBKS event not in slate');
    lines.push('  - Decision: NO CLEAR PICK');
    lines.push('  - Reasoning: no Kalshi K-prop event for this game');
    return lines;
  }
  const sideAbbrev = side === 'away' ? game.away : game.home;
  const sideMarkets = s.markets.filter((m) => {
    const parts = (m.ticker || '').split('-');
    const playerTok = parts.length >= 3 ? parts[parts.length - 2] : '';
    return playerTok.startsWith(sideAbbrev || '___NEVER___');
  });
  if (!sideMarkets.length) {
    lines.push('  - Ceiling: UNQUOTED — no ladder for this starter');
    lines.push('  - Decision: NO CLEAR PICK');
    lines.push('  - Reasoning: starter K ladder not posted at report time');
    return lines;
  }
  const groups = groupPlayerMarkets(sideMarkets);
  for (const [tok, mks] of groups) {
    const name = playerNameFromMarket(mks[0]) || tok;
    const ladder = mks
      .sort((a, b) => (a.floor_strike ?? 0) - (b.floor_strike ?? 0))
      .map((m) => `${m.floor_strike != null ? m.floor_strike + 0.5 : '?'}+: ${bestQuote(m)}`)
      .join(' | ');
    lines.push(`  - Pitcher: ${name}`);
    lines.push(`  - Ceiling: ${ladder}`);
    lines.push('  - Decision: WATCH');
    lines.push('  - Reasoning: projected IP, opposing lineup K-rate vs handedness, park, and ump/weather context NOT checked in this report — required before any LEAN');
  }
  return lines;
}

function renderYfriSection(game) {
  const s = game.series.rfi;
  const lines = ['- Pick:'];
  if (!s) {
    return ['- Pick: MISSING — KXMLBRFI event not in slate',
            '- Reasoning: YFRI/NFRI market unavailable for this game'];
  }
  if (!s.markets.length) {
    return ['- Pick: UNQUOTED', '- Reasoning: KXMLBRFI event has no markets'];
  }
  const m = s.markets[0];
  return [
    `- Pick: NFRI vs YFRI quote: ${bestQuote(m)}`,
    '- Reasoning: NO CLEAR PICK — lineup top-3 handedness, both starters\' 1st-inning xWOBA, weather, and park 1st-inning run rate NOT checked in this report',
  ];
}

export function renderGameSection(game) {
  const matchup = game.away_full && game.home_full
    ? `${game.away_full} at ${game.home_full}`
    : `${game.away ?? '?'} at ${game.home ?? '?'}`;
  const lines = [];
  lines.push('Game:');
  lines.push(`- Matchup: ${matchup}`);
  lines.push(`- First pitch: ${game.start_ct ?? 'MISSING'}  /  ${game.start_utc ?? 'MISSING'}`);
  lines.push('- Venue/weather: MISSING (not pulled by this report)');
  lines.push('- Probable starters: MISSING (not pulled by this report)');
  lines.push('- Market snapshot:');
  for (const sid of Object.keys(MLB_SERIES)) {
    const s = game.series[sid];
    const tag = s ? `${s.event_ticker} (${s.market_count} markets${s.priced ? '' : ', UNQUOTED'})` : 'MISSING';
    lines.push(`  - ${MLB_SERIES[sid].label}: ${tag}`);
  }
  lines.push('');
  lines.push('Main pick review:');
  for (const l of renderMlBlock(game)) lines.push(l);
  for (const l of renderSpreadBlock(game)) lines.push(l);
  for (const l of renderTotalBlock(game)) lines.push(l);
  lines.push('- Best side: NO CLEAR PICK');
  lines.push('- Decision: PASS');
  lines.push('- Reasoning: pre-lock report scaffolding only — model probabilities, weather, lineup, and starter splits NOT integrated yet, so no defensible edge');
  lines.push('');
  lines.push('Game total ceiling:');
  lines.push('- Ceiling: MISSING');
  lines.push('- Reasoning: park run-environment, weather (wind/temp), and projected starter IP NOT modeled in this report');
  lines.push('');
  lines.push('Props:');
  for (const l of renderHrSection(game)) lines.push(l);
  for (const l of renderKsSection(game, 'away')) lines.push(l);
  for (const l of renderKsSection(game, 'home')) lines.push(l);
  lines.push('');
  lines.push('YFRI/NFRI:');
  for (const l of renderYfriSection(game)) lines.push(l);
  lines.push('');
  lines.push('Game summary and history:');
  lines.push('- Recent form: MISSING (not pulled by this report)');
  lines.push('- Head-to-head or matchup notes: MISSING (not pulled by this report)');
  lines.push('- Bullpen/rest context: MISSING (not pulled by this report)');
  lines.push('- Injury/lineup notes: MISSING (not pulled by this report)');
  lines.push('');
  lines.push('Final game call:');
  lines.push('- Best available angle: NO CLEAR PICK');
  lines.push('- Confidence: PASS');
  lines.push('- If no clear pick exists, say: NO CLEAR PICK and explain exactly why.');
  lines.push('- Why no pick: this report exposes the full Kalshi market board for ML, spread, total, HR, K props, and YFRI/NFRI; modeled fair-value, lineup, park, weather, ump, and starter-context inputs are not yet integrated, so no LEAN or CLEAR can be defended.');
  return lines.join('\n');
}
