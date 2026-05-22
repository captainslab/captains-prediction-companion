// Minimal dependency-free schema validator for branches.json.
// Returns { ok, errors, repaired }. `repair: true` strips unknown top-level
// keys and coerces obvious shape mismatches (e.g. string → [string]).
//
// Keep this lenient: branches are produced by LLMs. We want it to ACCEPT
// reasonable outputs and REJECT structurally broken ones, not bikeshed types.

const BRANCH_KEYS = [
  'market', 'settlement', 'official', 'xSignal',
  'marketStructure', 'plausibility', 'skeptic', 'judgment', 'meta',
];

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function checkMarket(m, errs) {
  if (!isObj(m))             errs.push('market: must be object');
  else {
    if (!m.id)               errs.push('market.id: required');
    if (!m.url)              errs.push('market.url: required');
    if (!m.asOf)             errs.push('market.asOf: required');
  }
}

function checkSettlement(s, errs) {
  if (s === undefined) return;
  if (!isObj(s))             errs.push('settlement: must be object');
  else if (typeof s.rules !== 'string') errs.push('settlement.rules: must be string');
}

function checkOfficial(o, errs, { repair }) {
  if (o === undefined) return;
  if (!isObj(o))             { errs.push('official: must be object'); return; }
  if (!Array.isArray(o.facts)) {
    if (repair && o.facts === undefined) o.facts = [];
    else errs.push('official.facts: must be array');
  } else {
    for (const [i, f] of o.facts.entries()) {
      if (!isObj(f))         errs.push(`official.facts[${i}]: must be object`);
      else if (typeof f.claim !== 'string') errs.push(`official.facts[${i}].claim: must be string`);
    }
  }
}

function checkXSignal(x, errs, { repair }) {
  if (x === undefined) return;
  if (!isObj(x))             { errs.push('xSignal: must be object'); return; }
  if (!Array.isArray(x.narratives)) {
    if (repair && x.narratives === undefined) x.narratives = [];
    else errs.push('xSignal.narratives: must be array');
  }
}

function checkMarketStructure(ms, errs, { repair }) {
  if (ms === undefined) return;
  if (!isObj(ms))            { errs.push('marketStructure: must be object'); return; }
  if (!Array.isArray(ms.board)) {
    if (repair && ms.board === undefined) ms.board = [];
    else errs.push('marketStructure.board: must be array');
  }
}

function checkPlausibility(p, errs, { repair }) {
  if (p === undefined) return;
  if (!isObj(p))             { errs.push('plausibility: must be object'); return; }
  if (!Array.isArray(p.candidates)) {
    if (repair && p.candidates === undefined) p.candidates = [];
    else errs.push('plausibility.candidates: must be array');
  }
}

function checkSkeptic(s, errs, { repair }) {
  if (s === undefined) return;
  if (!isObj(s))             { errs.push('skeptic: must be object'); return; }
  for (const k of ['favoriteWrong', 'secondUnderpriced', 'settlementTraps', 'narrativeTraps']) {
    if (s[k] === undefined && repair) s[k] = [];
    else if (s[k] !== undefined && !Array.isArray(s[k])) errs.push(`skeptic.${k}: must be array`);
  }
}

function checkJudgment(j, errs, { repair }) {
  if (j === undefined) return;
  if (!isObj(j))             { errs.push('judgment: must be object'); return; }
  for (const k of ['strongestSignal', 'strongestCounter', 'biggestSettlementAmbiguity', 'biggestUncertainty', 'confidence']) {
    if (j[k] !== undefined && typeof j[k] !== 'string') errs.push(`judgment.${k}: must be string`);
  }
  for (const k of ['watchlistTriggers', 'wouldChangeView', 'citations']) {
    if (j[k] === undefined && repair) j[k] = [];
    else if (j[k] !== undefined && !Array.isArray(j[k])) errs.push(`judgment.${k}: must be array`);
  }
}

export function validateBranches(input, { repair = false } = {}) {
  const errs = [];
  if (!isObj(input))         return { ok: false, errors: ['root: must be object'], repaired: null };

  const out = repair ? {} : input;
  if (repair) {
    for (const k of BRANCH_KEYS) if (input[k] !== undefined) out[k] = input[k];
  }

  checkMarket(out.market, errs);
  checkSettlement(out.settlement, errs);
  checkOfficial(out.official, errs, { repair });
  checkXSignal(out.xSignal, errs, { repair });
  checkMarketStructure(out.marketStructure, errs, { repair });
  checkPlausibility(out.plausibility, errs, { repair });
  checkSkeptic(out.skeptic, errs, { repair });
  checkJudgment(out.judgment, errs, { repair });

  return { ok: errs.length === 0, errors: errs, repaired: repair ? out : null };
}

// Forbidden-language guard: scans rendered markdown for prescriptive trade,
// sizing, or posting instructions. Disclaimer text is allowed.
const FORBIDDEN = [
  /\bbet\s+\$/i,
  /\bplace\s+(a|the)\s+trade\b/i,
  /\bbuy\s+(yes|no)\b/i,
  /\bkelly\b.*\bsize\b/i,
  /\bbankroll\b(?!\s+sizing\.)/i, // allow the disclaimer phrase
  /\bpost\s+(to|on)\s+(x|twitter|telegram)\b/i,
  /\brecommend(ed)?\s+(buy|sell|bet|trade)\b/i,
];

export function scanForbiddenLanguage(md) {
  const hits = [];
  for (const rx of FORBIDDEN) {
    const m = md.match(rx);
    if (m) hits.push({ pattern: rx.source, match: m[0] });
  }
  return { clean: hits.length === 0, hits };
}
