// Pure renderer: branches.json → markdown report. No I/O, no network.
// Same input ⇒ same bytes (pinned by test/politics-market-swarm.test.mjs).

import { classifySource, sortBySourceTier } from './source-classifier.mjs';

const PLACEHOLDER = '(UNKNOWN — branch not run)';
const NO_TRADE = '> No trade recommendation. No bankroll sizing. Research-only.';

function h(level, text) { return `${'#'.repeat(level)} ${text}\n\n`; }
function bullet(s)       { return `- ${s}\n`; }
function code(s)         { return '```\n' + s + '\n```\n\n'; }
function safe(v, fb = PLACEHOLDER) {
  if (v === null || v === undefined || v === '') return fb;
  return v;
}
function arr(v) { return Array.isArray(v) ? v : []; }

function renderTLDR(b) {
  const m = b.market ?? {};
  const j = b.judgment ?? {};
  const ms = b.marketStructure ?? {};
  const board = arr(ms.board);
  const leader = board.length
    ? [...board].sort((a, b) => (b.yesCents ?? 0) - (a.yesCents ?? 0))[0]
    : null;
  let out = h(2, '1. TLDR');
  out += bullet(`Market: ${safe(m.title)} (${safe(m.id)})`);
  out += bullet(`URL: ${safe(m.url)}`);
  out += bullet(`As of: ${safe(m.asOf)}`);
  out += bullet(`Current market leader: ${leader ? `${leader.candidate} @ ${leader.yesCents}¢ YES` : PLACEHOLDER}`);
  out += bullet(`Strongest verified non-price signal: ${safe(j.strongestSignal ?? j.bestNonPriceReason)}`);
  out += bullet(`Strongest counter-signal: ${safe(j.strongestCounter)}`);
  out += bullet(`Biggest settlement ambiguity: ${safe(j.biggestSettlementAmbiguity)}`);
  out += bullet(`Biggest uncertainty: ${safe(j.biggestUncertainty)}`);
  out += bullet(`Confidence: ${safe(j.confidence)}`);
  out += '\n' + NO_TRADE + '\n\n';
  return out;
}

function renderSettlement(b) {
  const s = b.settlement ?? {};
  let out = h(2, '2. Settlement Rules');
  out += h(3, 'What counts');
  out += code(safe(s.rules));
  out += h(3, 'Acting / Interim treatment');
  out += code(safe(s.actingInterim));
  out += h(3, 'Ambiguities');
  const ambs = arr(s.ambiguities);
  if (!ambs.length) out += `${PLACEHOLDER}\n\n`;
  else out += ambs.map(a => bullet(a)).join('') + '\n';
  return out;
}

function renderBoard(b) {
  const ms = b.marketStructure ?? {};
  const board = arr(ms.board);
  let out = h(2, '3. Candidate Board');
  if (!board.length) { out += `${PLACEHOLDER}\n\n`; return out; }
  const rows = board.map(c =>
    `${(c.candidate ?? '?').padEnd(28)}  YES ${String(c.yesCents ?? '?').padStart(3)}¢  NO ${String(c.noCents ?? '?').padStart(3)}¢  vol=${c.vol ?? '?'}  oi=${c.oi ?? '?'}`
  ).join('\n');
  out += code(rows);
  return out;
}

function renderOfficial(b) {
  const facts = sortBySourceTier(arr(b.official?.facts));
  let out = h(2, '4. Official Evidence');
  if (!facts.length) { out += `${PLACEHOLDER}\n\n`; return out; }
  const verified   = facts.filter(f => f.verified);
  const unverified = facts.filter(f => !f.verified);
  out += h(3, 'Verified');
  out += verified.length
    ? verified.map(f => bullet(`[${f.date ?? '?'}] ${f.claim} — ${classifySource(f.source).label}: ${f.source ?? '?'}`)).join('') + '\n'
    : `${PLACEHOLDER}\n\n`;
  out += h(3, 'Reported but not officially confirmed');
  out += unverified.length
    ? unverified.map(f => bullet(`[${f.date ?? '?'}] ${f.claim} — ${classifySource(f.source).label}: ${f.source ?? '?'}`)).join('') + '\n'
    : `${PLACEHOLDER}\n\n`;
  return out;
}

function renderXSignal(b) {
  const ns = arr(b.xSignal?.narratives);
  let out = h(2, '5. X Signal');
  out += `> X chatter is signal, never fact.\n\n`;
  if (!ns.length) { out += `${PLACEHOLDER}\n\n`; return out; }
  out += ns.map(n => bullet(
    `[tier=${n.tier ?? '?'}${n.repeated ? ', repeated' : ''}] ${n.claim}${n.source ? ' — ' + n.source : ''}`
  )).join('') + '\n';
  return out;
}

function renderMarket(b) {
  const ms = b.marketStructure ?? {};
  let out = h(2, '6. Market Structure');
  out += h(3, 'Movement');
  out += code(safe(ms.movement));
  out += h(3, 'Why price alone is insufficient');
  out += code(safe(ms.limitations,
    'Kalshi is thin on personnel markets; small fills move prices, public chatter can dominate, and resolution language can diverge from "who the press calls the favorite."'));
  return out;
}

function renderPlausibility(b) {
  const cs = arr(b.plausibility?.candidates);
  let out = h(2, '7. Political Plausibility');
  out += `> Inference. Label-only — not fact.\n\n`;
  if (!cs.length) { out += `${PLACEHOLDER}\n\n`; return out; }
  for (const c of cs) {
    out += h(3, c.name ?? '?');
    out += '**Strengths**\n';
    out += (arr(c.strengths).map(s => bullet(s)).join('') || `${PLACEHOLDER}\n`) + '\n';
    out += '**Weaknesses**\n';
    out += (arr(c.weaknesses).map(s => bullet(s)).join('') || `${PLACEHOLDER}\n`) + '\n';
    out += '**Process obstacles**\n';
    out += (arr(c.obstacles).map(s => bullet(s)).join('') || `${PLACEHOLDER}\n`) + '\n';
  }
  return out;
}

function renderSkeptic(b) {
  const s = b.skeptic ?? {};
  let out = h(2, '8. Skeptic Review');
  out += h(3, 'Strongest reason the favorite may be wrong');
  out += code(safe(s.favoriteWrongReason));
  out += h(3, 'Strongest reason a non-favorite may be underpriced');
  out += code(safe(s.underpricedReason));
  out += h(3, 'Settlement-rule traps');
  out += (arr(s.settlementTraps).map(t => bullet(t)).join('') || `${PLACEHOLDER}\n`) + '\n';
  out += h(3, 'Narrative traps');
  out += (arr(s.narrativeTraps).map(t => bullet(t)).join('') || `${PLACEHOLDER}\n`) + '\n';
  return out;
}

function renderJudgment(b) {
  const j = b.judgment ?? {};
  let out = h(2, '9. Final Research Judgment');
  out += bullet(`Confidence: ${safe(j.confidence)}`);
  out += bullet(`Strongest verified non-price signal: ${safe(j.strongestSignal ?? j.bestNonPriceReason)}`);
  out += bullet(`Strongest counter-signal: ${safe(j.strongestCounter)}`);
  out += bullet(`Biggest settlement ambiguity: ${safe(j.biggestSettlementAmbiguity)}`);
  out += bullet(`Biggest uncertainty: ${safe(j.biggestUncertainty)}`);
  out += '\n**Watchlist triggers (what to monitor next)**\n';
  out += (arr(j.watchlistTriggers ?? j.monitorNext).map(s => bullet(s)).join('') || `${PLACEHOLDER}\n`) + '\n';
  out += '**What would change the view**\n';
  out += (arr(j.wouldChangeView).map(s => bullet(s)).join('') || `${PLACEHOLDER}\n`) + '\n';
  if (Array.isArray(j.citations) && j.citations.length) {
    out += '**Citations (branches used)**\n';
    out += j.citations.map(c => bullet(`${c.branch}${c.ref ? ' → ' + c.ref : ''}`)).join('') + '\n';
  }
  out += '> Research-only. No trade recommendation. No bankroll sizing. No candidate ranking as a pick.\n';
  out += NO_TRADE + '\n';
  return out;
}

function renderMeta(b) {
  const m = b.meta ?? {};
  let out = h(2, 'Meta');
  out += bullet(`x_search available: ${m.xSearchAvailable ?? 'unknown'}`);
  out += bullet(`x_search used:      ${m.xSearchUsed ?? 'unknown'}`);
  out += '\n**Not checked / out of scope this run**\n';
  out += (arr(m.notChecked).map(s => bullet(s)).join('') || `${PLACEHOLDER}\n`);
  return out;
}

export function renderReport(branches = {}) {
  const m = branches.market ?? {};
  const head = h(1, `Politics-Market Research Report — ${safe(m.title, m.id ?? 'unknown market')}`);
  return head +
    renderTLDR(branches) +
    renderSettlement(branches) +
    renderBoard(branches) +
    renderOfficial(branches) +
    renderXSignal(branches) +
    renderMarket(branches) +
    renderPlausibility(branches) +
    renderSkeptic(branches) +
    renderJudgment(branches) +
    renderMeta(branches);
}

export const __NO_TRADE__ = NO_TRADE;
