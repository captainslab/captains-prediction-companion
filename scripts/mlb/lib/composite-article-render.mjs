// composite-article-render.mjs
//
// Substack-article rendering for the MLB composite refresh.
// Same inputs as renderCompactRefresh in late-slate-composite-refresh.mjs;
// different audience. The compact board stays the audit/backtest artifact —
// this is the reader-facing edition sent to Telegram.
//
// Style rules:
//   - Headline + one-line dek, then narrative prose. No icons, no key:value
//     rows, no engine vocabulary ("composite", "layer", "signal", "diff")
//     in the body prose — those live only in the closing methodology note.
//   - One short titled block per pick, written as sentences.
//   - NEVER any pricing fields (market-neutral by construction).
//
// Pure functions. No network, no fs.

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function prettyDate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAYS[dt.getUTCDay()]}, ${MONTHS[m - 1]} ${d}`;
}

function ledgerDetail(ledger, category) {
  const row = ledger?.evidence_ledger?.find((r) => r.category === category);
  return row?.present ? (row.detail ?? null) : null;
}

// "Logan Gilbert, ERA 3.79, FIP 4.17 [mlb_sabermetrics], K% 26%" → prose
function pitcherSentence(detail, { possessive = false } = {}) {
  if (!detail) return null;
  const clean = detail.replace(/\s*\[[^\]]*\]/g, '');
  const name = clean.split(',')[0].trim();
  const rest = clean.split(',').slice(1).map((s) => s.trim()).filter(Boolean);
  if (!name) return null;
  const statText = rest.length ? ` (${rest.join(', ')})` : '';
  return possessive ? `${name}${statText}` : `${name} starts${statText}`;
}

// "L10 7-3 trend: hot" → "a 7-3 run over the last ten"
function formSentence(detail) {
  if (!detail) return null;
  const m = /L10\s+(\d+-\d+)\s+trend:\s*(\w+)/.exec(detail);
  if (!m) return null;
  const [, record, trend] = m;
  if (trend === 'hot') return `the team comes in hot at ${record} over its last ten`;
  if (trend === 'cold') return `the team is cold, ${record} over its last ten`;
  return `the team sits at ${record} over its last ten`;
}

function pickTier(status) {
  if (status === 'EVIDENCE_LEAN') return 'a strong lean';
  if (status === 'LEAN') return 'a soft lean';
  return 'a read';
}

// "SEA@BAL" → { away: "SEA", home: "BAL" }
function splitLabel(label) {
  const [away, home] = String(label).split('@');
  return { away: away ?? label, home: home ?? '' };
}

function pickHeadline(label, tp, ouLine) {
  const { away, home } = splitLabel(label);
  let what = tp.label;
  if (ouLine != null && (tp.lane === 'total_over' || tp.lane === 'total_under')) {
    what = `${tp.label.replace(/^Total /, '')} ${ouLine}`;
  }
  return `${away} at ${home} — ${what}`;
}

function pickBody(tp, board, gameLedger) {
  const strongerLedger = board.stronger_side === 'away' ? gameLedger.away : gameLedger.home;
  const weakerLedger = board.stronger_side === 'away' ? gameLedger.home : gameLedger.away;

  const sentences = [];
  const pitcher = pitcherSentence(ledgerDetail(strongerLedger, 'starting_pitcher_signal'));
  const isPitcherLane = /NRFI|YFRI|UNDER|OVER/i.test(tp.label);
  if (pitcher) {
    sentences.push(isPitcherLane
      ? `${pitcher}, which is what drives this read.`
      : `The case starts on the mound: ${pitcher}.`);
  }
  const form = formSentence(ledgerDetail(strongerLedger, 'recent_form'));
  if (form) sentences.push(`Behind him, ${form}.`);

  const oppPitcher = pitcherSentence(ledgerDetail(weakerLedger, 'starting_pitcher_signal'), { possessive: true });
  if (oppPitcher && !isPitcherLane) sentences.push(`The other side counters with ${oppPitcher}.`);

  const vsOpp = ledgerDetail(strongerLedger, 'pitcher_vs_this_opponent');
  if (vsOpp) sentences.push(`History against this opponent leans the same way: ${vsOpp.split(',')[0].trim()}.`);

  sentences.push(`Call it ${pickTier(tp.status)}.`);
  return sentences.join(' ');
}

function countByStatus(results) {
  const counts = { EVIDENCE_LEAN: 0, LEAN: 0 };
  const picks = [];
  for (const { result, label, ouLine } of results) {
    const tp = result?.board?.top_pick;
    if (!tp || tp.status === 'NO CLEAR PICK' || tp.status === 'WATCH') continue;
    counts[tp.status] = (counts[tp.status] ?? 0) + 1;
    picks.push({ label, tp, board: result.board, gameLedger: result.gameLedger, ouLine });
  }
  return { counts, picks };
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
function numWord(n, capitalize = false) {
  const w = NUMBER_WORDS[n] ?? String(n);
  return capitalize ? w.charAt(0).toUpperCase() + w.slice(1) : w;
}

function lede(date, counts, picks, watchCount) {
  const total = picks.length;
  const parts = [];
  if (total === 0) {
    parts.push(`No game on the ${prettyDate(date)} slate cleared the evidence bar today.`);
    parts.push('That is a finding, not a failure — when the inputs are thin, the right read is no read.');
    return parts.join(' ');
  }
  const strong = counts.EVIDENCE_LEAN ?? 0;
  const soft = counts.LEAN ?? 0;
  const opener = `${numWord(total, true)} game${total === 1 ? '' : 's'} on today's slate cleared the evidence bar`;
  const mix = strong && soft
    ? `${numWord(strong)} with strong evidence behind ${strong === 1 ? 'it' : 'them'} and ${numWord(soft)} on softer footing`
    : strong ? 'all with strong evidence behind them' : 'all on softer footing';
  parts.push(`${opener} — ${mix}.`);
  if (picks[0]) {
    const { away, home } = splitLabel(picks[0].label);
    parts.push(`The read of the day is ${away} at ${home}.`);
  }
  if (watchCount > 0) {
    parts.push(`${watchCount === 1 ? 'One more game is' : `${numWord(watchCount, true)} more games are`} still waiting on lineups further down.`);
  }
  return parts.join(' ');
}

/**
 * Renders the composite refresh as a Substack-style article.
 * Same input contract as renderCompactRefresh.
 */
export function renderArticleRefresh({ date, results, watchGames = [] }) {
  const { counts, picks } = countByStatus(results);
  const lines = [];

  lines.push(`Captain's MLB Read — ${prettyDate(date)}`);
  lines.push(picks.length
    ? 'What the evidence likes today, and why.'
    : 'A quiet board, and why that is the honest answer.');
  lines.push('');
  lines.push(lede(date, counts, picks, watchGames.length));

  for (const p of picks) {
    lines.push('');
    lines.push(pickHeadline(p.label, p.tp, p.ouLine));
    lines.push(pickBody(p.tp, p.board, p.gameLedger));
  }

  if (watchGames.length > 0) {
    lines.push('');
    lines.push('Still waiting on lineups');
    const names = watchGames.map((w) => String(w).replace(/\s*\([^)]*\)/g, '')).join(', ');
    lines.push(
      `${names} ${watchGames.length === 1 ? 'has' : 'have'} not posted confirmed lineups yet, `
      + 'so they stay off the board. A game does not get scored here without a confirmed lineup '
      + 'and source-backed pitcher stats — no exceptions, even when the matchup looks obvious.'
    );
  }

  lines.push('');
  lines.push('How to read this');
  lines.push(
    'These are evidence scores from a market-neutral 13-layer model: pitching, form, matchup '
    + 'history, bullpen load, and lineup handedness, with no market prices anywhere in the score. '
    + 'A strong lean means several independent layers point the same way; a soft lean means the '
    + 'evidence tilts but thinner. Model output, not betting advice. No trades placed.'
  );
  lines.push('');
  lines.push('— Captain’s Prediction Companion');

  return lines.join('\n');
}
