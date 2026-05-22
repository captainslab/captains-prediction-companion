// Pure rendering of the per-game pre-lock report section.
// Inputs are normalized markets from slate discovery. No external calls.
// The decision posture defaults to NO CLEAR PICK / WATCH when context
// inputs required for a defensible LEAN are not present. This matches the
// project rule against naive-Poisson LEANs and against forcing picks.

import { MLB_SERIES } from './series-discovery.mjs';
import { analyzeGame } from './market-engine.mjs';
import {
  evaluateDecisionProcess,
  MARKET_TYPES,
  renderDecisionProcess,
} from '../../shared/decision-process.mjs';

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

function propHasLean(decision) {
  return decision === 'CLEAR' || decision === 'LEAN';
}

function playerPropProcess(rawDecision = 'NO CLEAR PICK', reason = '') {
  return evaluateDecisionProcess({
    marketType: MARKET_TYPES.PLAYER_PROP,
    rawDecision,
    checked: { line_ladder_comparison: true },
    forceWatch: rawDecision === 'WATCH',
    topEvidence: propHasLean(rawDecision) ? [`Line/ladder signal: ${reason}`] : [],
    marketSignalText: propHasLean(rawDecision)
      ? reason
      : 'No player-prop signal beyond posted ladder/line shape.',
    settlementRules: 'Player-prop settlement rules not independently pulled by this report.',
    verifiedFacts: 'Player-specific role, usage, opponent matchup, recent form, and injury/status context not pulled by this report.',
    inference: propHasLean(rawDecision)
      ? 'Ladder signal only; no player-projection inference is claimed.'
      : 'No prop inference claimed.',
    skepticReview: 'MISSING: report does not pull player role/usage, opponent matchup, recent form, or injury/status news.',
    finalJudgment: propHasLean(rawDecision)
      ? 'MARKET-ONLY LEAN only; not a player-prop pick without domain evidence.'
      : rawDecision,
    wouldChangeView: [
      'Confirmed player role/usage and status support the same prop side.',
      'Opponent matchup and recent performance support the same prop side.',
      'Line/ladder signal disappears or contradicts updated domain context.',
    ],
  });
}

function renderPropDecision(lines, d, level = 2) {
  const process = playerPropProcess(d.decision, d.reason);
  const pad = indent(level);
  if (propHasLean(d.decision)) {
    lines.push(`${pad}- Raw ladder decision: ${d.decision}`);
    lines.push(`${pad}- Decision status: ${process.decisionStatus}`);
    lines.push(`${pad}- Why not a real prop pick: required player role, matchup, recent form, and status evidence is incomplete.`);
  } else {
    lines.push(`${pad}- Decision status: ${process.decisionStatus}`);
  }
  lines.push(`${pad}- Reasoning: ${d.reason}`);
}

function renderHrSection(game, analysis) {
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
  const decByName = new Map(analysis.sections.hr.perPlayer.map((p) => [p.name, p]));
  const groups = groupPlayerMarkets(s.markets);
  for (const [tok, mks] of groups) {
    const name = playerNameFromMarket(mks[0]) || tok;
    lines.push(`  - Player: ${name}`);
    for (const m of mks.sort((a, b) => (a.floor_strike ?? 0) - (b.floor_strike ?? 0))) {
      const thresh = m.floor_strike != null ? `${m.floor_strike}+ HR` : 'HR';
      lines.push(`    - ${thresh}: ${bestQuote(m)}`);
    }
    const d = decByName.get(name) || { decision: 'NO CLEAR PICK', reason: 'No analysis for this player.' };
    renderPropDecision(lines, d, 2);
  }
  return lines;
}

function renderKsSection(game, side /* 'away' | 'home' */, analysis) {
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
  const sectionAnalysis = side === 'away' ? analysis.sections.ks_away : analysis.sections.ks_home;
  const decByName = new Map((sectionAnalysis.perPitcher || []).map((p) => [p.name, p]));
  const groups = groupPlayerMarkets(sideMarkets);
  for (const [tok, mks] of groups) {
    const name = playerNameFromMarket(mks[0]) || tok;
    const ladder = mks
      .sort((a, b) => (a.floor_strike ?? 0) - (b.floor_strike ?? 0))
      .map((m) => `${m.floor_strike != null ? m.floor_strike + 0.5 : '?'}+: ${bestQuote(m)}`)
      .join(' | ');
    lines.push(`  - Pitcher: ${name}`);
    lines.push(`  - Ceiling: ${ladder}`);
    const d = decByName.get(name) || { decision: 'WATCH', reason: 'No analysis for this pitcher.' };
    renderPropDecision(lines, d, 1);
  }
  return lines;
}

function renderYfriSection(game, analysis) {
  const s = game.series.rfi;
  if (!s) {
    return ['- Pick: MISSING — KXMLBRFI event not in slate',
            '- Reasoning: YFRI/NFRI market unavailable for this game'];
  }
  if (!s.markets.length) {
    return ['- Pick: UNQUOTED', '- Reasoning: KXMLBRFI event has no markets'];
  }
  const m = s.markets[0];
  const d = analysis.sections.yfri;
  return [
    `- Pick: NFRI vs YFRI quote: ${bestQuote(m)}`,
    `- Decision: ${d.decision}`,
    `- Reasoning: ${d.reason}`,
  ];
}

export function renderGameSection(game) {
  const analysis = analyzeGame(game);
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
  lines.push(renderDecisionProcess(analysis.final.decision_process, { heading: 'Research Completeness' }));
  lines.push('');
  lines.push('Main pick review:');
  for (const l of renderMlBlock(game)) lines.push(l);
  for (const l of renderSpreadBlock(game)) lines.push(l);
  for (const l of renderTotalBlock(game)) lines.push(l);
  lines.push(`- ML decision: ${analysis.sections.ml.decision}`);
  lines.push(`  - Reasoning: ${analysis.sections.ml.reason}`);
  lines.push(`- Spread decision: ${analysis.sections.spread.decision}`);
  lines.push(`  - Reasoning: ${analysis.sections.spread.reason}`);
  lines.push(`- Total decision: ${analysis.sections.total.decision}`);
  lines.push(`  - Reasoning: ${analysis.sections.total.reason}`);
  // Best side rolls up the strongest of ML / spread / total.
  const mainCandidates = [analysis.sections.ml, analysis.sections.spread, analysis.sections.total];
  const mainBest = pickBest(mainCandidates);
  lines.push(`- Best side: ${mainBest.decision === 'CLEAR' || mainBest.decision === 'LEAN' ? mainBest.reason : 'NO CLEAR PICK'}`);
  lines.push(`- Raw market decision: ${mainBest.decision}`);
  lines.push(`- Decision status: ${analysis.final.decision_status}`);
  lines.push(`- Reasoning: ${mainBest.reason}`);
  lines.push('');
  lines.push('Game total ceiling:');
  const ceil = analysis.sections.ceiling.ceiling;
  lines.push(`- Ceiling: ${ceil ? `Over ${ceil.strike} @ ${ceil.yesAsk}¢ YES` : 'MISSING / no live rung >= 10¢'}`);
  lines.push(`- Reasoning: ${analysis.sections.ceiling.reason}`);
  lines.push('');
  lines.push('Props:');
  const propRawDecisions = [
    ...(analysis.sections.hr.perPlayer || []).map((p) => p.decision),
    ...(analysis.sections.ks_away.perPitcher || []).map((p) => p.decision),
    ...(analysis.sections.ks_home.perPitcher || []).map((p) => p.decision),
  ];
  const propRawDecision = propRawDecisions.some(propHasLean)
    ? 'LEAN'
    : propRawDecisions.includes('WATCH')
      ? 'WATCH'
      : 'NO CLEAR PICK';
  lines.push(renderDecisionProcess(playerPropProcess(propRawDecision), { heading: 'Player Prop Research Completeness' }));
  lines.push('');
  for (const l of renderHrSection(game, analysis)) lines.push(l);
  for (const l of renderKsSection(game, 'away', analysis)) lines.push(l);
  for (const l of renderKsSection(game, 'home', analysis)) lines.push(l);
  lines.push('');
  lines.push('YFRI/NFRI:');
  for (const l of renderYfriSection(game, analysis)) lines.push(l);
  lines.push('');
  lines.push('Game summary and history:');
  lines.push('- Recent form: MISSING (not pulled by this report)');
  lines.push('- Head-to-head or matchup notes: MISSING (not pulled by this report)');
  lines.push('- Bullpen/rest context: MISSING (not pulled by this report)');
  lines.push('- Injury/lineup notes: MISSING (not pulled by this report)');
  lines.push('');
  lines.push('Final game call:');
  lines.push(`- Best available angle: ${analysis.final.best_angle}`);
  lines.push(`- Raw confidence: ${analysis.final.decision}`);
  lines.push(`- Confidence: ${analysis.final.decision_status}`);
  lines.push(`- Decision status: ${analysis.final.decision_status}`);
  if (analysis.final.decision_status === 'NO CLEAR PICK') {
    lines.push('- If no clear pick exists, say: NO CLEAR PICK and explain exactly why.');
    lines.push(`- Why no pick: ${analysis.final.reason}`);
  } else if (analysis.final.decision_status === 'MARKET-ONLY LEAN') {
    lines.push('- Why not a real pick: required MLB evidence is incomplete; price/board structure cannot create an evidence lean.');
    lines.push(`- Board-only reason: ${analysis.final.reason}`);
  } else {
    lines.push(`- Reasoning: ${analysis.final.reason}`);
  }
  return { text: lines.join('\n'), analysis };
}

function pickBest(sections) {
  const order = { CLEAR: 0, LEAN: 1, WATCH: 2, PASS: 3, 'NO CLEAR PICK': 4 };
  return sections.slice().sort((a, b) => (order[a.decision] ?? 9) - (order[b.decision] ?? 9))[0];
}
