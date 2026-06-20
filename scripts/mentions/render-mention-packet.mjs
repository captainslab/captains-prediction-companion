// Deterministic CPC mentions packet renderer.
//
// renderMentionPacket() is the ONLY writer of the final user-facing .txt.
// Models never produce layout — they contribute optional strict-JSON fields
// (analyst narrative, red-team flags) that are validated upstream and slotted
// into fixed sections here. Same input always renders the same text.
//
// Fixed section order (never reordered):
//   1 FAST READ
//   2 RANKED BOARD
//   3 TOP RESEARCHED TERMS
//   4 RESEARCH GAPS
//   5 MARKET CONTEXT - NOT IN SCORE
//   6 SOURCE GAPS
//   7 UPGRADE / DOWNGRADE TRIGGERS
//   8 FINAL CPC READ
//
// Market price/liquidity is display-only context (section 5 + board column),
// never a score input. All user-facing times are America/Chicago.

export const SECTION_ORDER = Object.freeze([
  '1. FAST READ',
  '2. RANKED BOARD',
  '3. TOP RESEARCHED TERMS',
  '4. RESEARCH GAPS',
  '5. MARKET CONTEXT - NOT IN SCORE',
  '6. SOURCE GAPS',
  '7. UPDATE / DOWNGRADE TRIGGERS',
  '8. FINAL READ',
]);

const CENTRAL_TZ = 'America/Chicago';
export const CUSTOMER_PACKET_CONTRACT_V2 = 'mentions_customer_packet_v2';
export const CUSTOMER_RENDERER_ID = 'renderMentionPacket/v2';
const GAP_STATE = 'research gap';
const GAP_LABEL = 'RESEARCH GAP';
const TIER_RANK = Object.freeze({ 'STRONG YES': 4, 'WEAK YES': 3, 'WEAK NO': 2, 'STRONG NO': 1, [GAP_LABEL]: 0 });
const FORBIDDEN_CUSTOMER_JARGON_RE = /\b(EVIDENCE_LEAN|NO_CLEAR_PICK|WATCH|LEAN|PICK|source layer(?:s)?|proximity-only|stub|scaffold|composite score|source-backed composite)\b/i;

function scoreToTier(score) {
  if (score === null || score === undefined || !Number.isFinite(Number(score))) return GAP_LABEL;
  const s = Math.round(Math.max(0, Math.min(100, Number(score))));
  if (s >= 65) return 'STRONG YES';
  if (s >= 50) return 'WEAK YES';
  if (s >= 35) return 'WEAK NO';
  return 'STRONG NO';
}

function researchState(term) {
  if (String(term?.research_state ?? '').trim()) return String(term.research_state).trim();
  if (term?.bucket === 'blocked/no-source') return GAP_STATE;
  return Number.isFinite(Number(term?.cpc_score)) ? 'research-backed' : GAP_STATE;
}

function isResearchBacked(term) {
  return researchState(term) !== GAP_STATE;
}

export function formatCentral(isoOrDate) {
  if (!isoOrDate) return 'MISSING';
  const d = new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return 'MISSING';
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: CENTRAL_TZ,
    year: 'numeric', month: 'short', day: '2-digit',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
  return fmt.format(d);
}

// Short display term: the strike word, not the repeated event title.
export function shortTerm(fullStrikeText, eventTitle = '') {
  const full = String(fullStrikeText ?? '').trim();
  if (!full) return 'MISSING';
  const sep = full.lastIndexOf(' -- ');
  if (sep >= 0) {
    const tail = full.slice(sep + 4).trim();
    if (tail) return tail.slice(0, 40);
  }
  const title = String(eventTitle ?? '').trim();
  if (title && full.startsWith(title)) {
    const rest = full.slice(title.length).replace(/^[\s:—–-]+/, '').trim();
    if (rest) return rest.slice(0, 40);
  }
  return full.slice(0, 40);
}

function maybe(v, fallback = 'MISSING') {
  return v === null || v === undefined || v === '' ? fallback : String(v);
}

function safeCustomerText(value, fallback = null) {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  if (FORBIDDEN_CUSTOMER_JARGON_RE.test(text)) return fallback;
  return text;
}

function cents(v) {
  return v === null || v === undefined ? '-' : `${v}c`;
}

function padCell(s, w) {
  const t = String(s ?? '');
  return t.length >= w ? t.slice(0, w) : t + ' '.repeat(w - t.length);
}

function tableRow(cells, widths) {
  return cells.map((c, i) => padCell(c, widths[i])).join(' | ').replace(/\s+$/, '');
}

function sourceLabel(term) {
  return researchState(term);
}

function marketCell(term) {
  const mc = term.market_context ?? {};
  return `${cents(mc.bid_cents)}/${cents(mc.ask_cents)} ctx-only`;
}

function numericScore(term) {
  const raw = Number(term?.cpc_score);
  if (!isResearchBacked(term)) return null;
  return Number.isFinite(raw) ? Math.round(Math.max(0, Math.min(100, raw))) : null;
}

function capReason(term) {
  if (!isResearchBacked(term)) return 'research gap: no usable score';
  return 'research-backed score';
}

function renderedPosture(term) {
  return scoreToTier(numericScore(term));
}

function cpcCell(term) {
  const score = numericScore(term);
  return score === null ? '--' : String(score);
}

// Best rendered tier from the customer board. Research gaps sort last.
export function postCapBestPosture(terms) {
  let best = GAP_LABEL;
  for (const t of terms ?? []) {
    const p = renderedPosture(t);
    if ((TIER_RANK[p] ?? 0) > (TIER_RANK[best] ?? 0)) best = p;
  }
  return best;
}

// Stable ranking: scored terms first (P(YES) desc), then research gaps.
// Pure on input — gate-only terms can never outrank researched terms.
function rankGroup(term) {
  if (!isResearchBacked(term)) return 1;
  return 0;
}

export function rankTerms(terms, eventTitle) {
  return terms
    .map((t) => ({ ...t, _short: shortTerm(t.full_strike_text, eventTitle) }))
    .sort((a, b) => {
      const groupDiff = rankGroup(a) - rankGroup(b);
      if (groupDiff !== 0) return groupDiff;
      const sa = Number.isFinite(Number(a.cpc_score)) ? Number(a.cpc_score) : -1;
      const sb = Number.isFinite(Number(b.cpc_score)) ? Number(b.cpc_score) : -1;
      if (sb !== sa) return sb - sa;
      return a._short.localeCompare(b._short);
    });
}

/**
 * renderMentionPacket — deterministic final .txt.
 *
 * @param {object} input    mentions_watch_user_packet_v1 synthesis input
 *                          (event, summary, terms[]; terms carry cpc_score)
 * @param {object} opts
 * @param {object?} opts.analyst        validated analyst JSON fields (or empty)
 * @param {object?} opts.redteam        validated red-team JSON fields (or null)
 * @param {string?} opts.generatedAtUtc fixed ISO timestamp (injected for determinism)
 * @param {string?} opts.analystTier    'none' | 'standard' | 'premium' (provenance line)
 */
export function renderMentionPacket(input, { analyst = null, redteam = null, generatedAtUtc = null, analystTier = 'none' } = {}) {
  if (!input || typeof input !== 'object') throw new Error('renderMentionPacket: input missing');
  const e = input.event ?? {};
  const summary = input.summary ?? {};
  const ranked = rankTerms(Array.isArray(input.terms) ? input.terms : [], e.title);
  if (!ranked.length) throw new Error('renderMentionPacket: no terms to render');
  const a = analyst ?? {};
  const notes = a.term_notes ?? {};

  const lines = [];
  lines.push(`=== Captain Mentions — CPC Packet: ${maybe(e.title)} ===`);
  lines.push(`event_time_central: ${formatCentral(e.date_time)}`);
  lines.push(`date: ${maybe(input.date)}`);
  if (generatedAtUtc) lines.push(`generated_utc: ${generatedAtUtc}`);
  lines.push(`settlement_source: ${maybe(e.settlement_source_link)}`);
  lines.push(`analyst_tier: ${analystTier}`);
  lines.push('');

  // 1 FAST READ — tier from the rendered rows, never the raw composite summary.
  const bestTier = postCapBestPosture(ranked);
  const researchedCount = ranked.filter(isResearchBacked).length;
  lines.push('1. FAST READ');
  lines.push(safeCustomerText(a.fast_read, `${researchedCount}/${summary.market_count ?? ranked.length} term(s) have research-backed P(YES); best tier ${bestTier}. Research only — no trade.`));
  lines.push('');

  // 2 RANKED BOARD
  lines.push('2. RANKED BOARD');
  const widths = [4, 22, 9, 14, 16, 22, 22, 18];
  lines.push(tableRow(['Rank', 'Term', 'P(YES)', 'Tier', 'Research', 'Catalyst', 'Settlement Fit', 'Market Context'], widths));
  lines.push(tableRow(widths.map((w) => '-'.repeat(w)), widths));
  ranked.forEach((t, i) => {
    const note = notes[t._short] ?? {};
    lines.push(tableRow([
      String(i + 1),
      t._short,
      cpcCell(t),
      renderedPosture(t),
      sourceLabel(t),
      safeCustomerText(note.catalyst, 'MISSING'),
      safeCustomerText(note.settlement_fit, 'MISSING'),
      marketBoardCell(t, ranked),
    ], widths));
  });
  lines.push('note: P(YES) is the deterministic research probability. Research gaps stay as RESEARCH GAP. Market Context is display-only and NEVER a score input.');
  lines.push('');

  // 3 TOP RESEARCHED TERMS
  lines.push('3. TOP RESEARCHED TERMS');
  const top = ranked.filter(isResearchBacked).slice(0, 5);
  if (top.length) {
    for (const t of top) lines.push(`- ${t._short}: ${cpcCell(t)} (${renderedPosture(t)})`);
  } else {
    lines.push('- none');
  }
  lines.push('');

  // 4 RESEARCH GAPS
  lines.push('4. RESEARCH GAPS');
  const gapTerms = ranked.filter((t) => !isResearchBacked(t));
  if (gapTerms.length) {
    for (const t of gapTerms) {
      const trap = notes[t._short]?.trap_risk ?? redteam?.trap_flags?.[t._short] ?? null;
      lines.push(`- ${t._short}: ${capReason(t)}${trap ? ` | trap: ${trap}` : ''}`);
    }
  } else {
  lines.push('- none');
  }
  if (redteam?.narrative_risks?.length) {
    lines.push('red-team narrative flags (advisory only, never re-scores):');
    for (const risk of redteam.narrative_risks) {
      const safeRisk = safeCustomerText(risk, null);
      if (safeRisk) lines.push(`- ${safeRisk}`);
    }
  }
  const xHeat = Object.entries(redteam?.x_narrative_heat ?? {});
  if (xHeat.length) {
    lines.push('X narrative heat (social context only — never source evidence, never a score input):');
    for (const [term, note] of xHeat) {
      const safeNote = safeCustomerText(note, null);
      if (safeNote) lines.push(`- ${term}: ${safeNote}`);
    }
  }
  lines.push('');

  // 5 MARKET CONTEXT - NOT IN SCORE
  lines.push('5. MARKET CONTEXT - NOT IN SCORE');
  lines.push('Kalshi price/liquidity shown for validation only; excluded from all score inputs.');
  if (allOneSided0100(ranked)) {
    lines.push(`- all ${ranked.length} displayed terms show bid=0c / ask=100c; stale/one-sided/closed-looking board context only, NOT IN SCORE.`);
  } else {
    lines.push(`- ${marketSummary(ranked)} Volume/open interest and full contract pricing stay in the audit inventory; NOT IN SCORE.`);
  }
  lines.push('');

  // 6 SOURCE GAPS
  lines.push('6. SOURCE GAPS');
  // Deterministic cache/stale-source disclosure. Present only when the generator
  // detected cache-only/stale/partial source health (same signal the delivery
  // janitor blocks on); price-free freshness statement, never a score input.
  if (input.source_health_disclosure) lines.push(`- ${input.source_health_disclosure}`);
  const analystGaps = Array.isArray(a.source_gaps)
    ? a.source_gaps.map((g) => safeCustomerText(g, null)).filter(Boolean)
    : null;
  const gaps = (analystGaps?.length ? analystGaps : null) ?? deterministicSourceGaps(ranked);
  for (const g of gaps) lines.push(`- ${g}`);
  const provenanceLines = Array.isArray(input.deterministic_provenance_lines)
    ? input.deterministic_provenance_lines.filter(Boolean)
    : [];
  if (provenanceLines.length) {
    lines.push('provenance (outcomes only; market prices excluded):');
    for (const line of provenanceLines) lines.push(`- ${line}`);
  }
  lines.push('');

  // 7 UPDATE / DOWNGRADE TRIGGERS
  lines.push('7. UPDATE / DOWNGRADE TRIGGERS');
  const analystUps = Array.isArray(a.upgrade_triggers)
    ? a.upgrade_triggers.map((u) => safeCustomerText(u, null)).filter(Boolean)
    : null;
  const ups = (analystUps?.length ? analystUps : null) ?? deterministicUpgradeTriggers(ranked);
  for (const u of ups) lines.push(`- upgrade: ${u}`);
  const analystDowns = Array.isArray(a.downgrade_triggers)
    ? a.downgrade_triggers.map((d) => safeCustomerText(d, null)).filter(Boolean)
    : null;
  const downs = analystDowns?.length ? analystDowns : ['settlement wording drifts from listed strike text', 'event schedule slips past close time'];
  for (const d of downs) lines.push(`- downgrade: ${d}`);
  lines.push('');

  // 8 FINAL READ
  lines.push('8. FINAL READ');
  lines.push(safeCustomerText(a.final_read, `Best tier ${bestTier} on the board above. Research only — no trade.`));
  lines.push('');

  // Local completeness appendix: every contract's exact strike text, compact.
  lines.push('--- Full Strike Inventory (exact strike text, every contract) ---');
  for (const t of ranked) lines.push(`- ${maybe(t.full_strike_text)}`);

  lines.push('');
  lines.push('---');
  lines.push(`renderer_contract: ${CUSTOMER_PACKET_CONTRACT_V2}`);
  lines.push('Research only. No trades. No bankroll advice. Market context is never a score input.');
  return lines.join('\n');
}

function centsNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function allOneSided0100(terms) {
  return Array.isArray(terms)
    && terms.length > 0
    && terms.every((t) => centsNumber(t?.market_context?.bid_cents) === 0 && centsNumber(t?.market_context?.ask_cents) === 100);
}

function marketBoardCell(term, ranked) {
  if (allOneSided0100(ranked)) return 'one-sided sec5';
  return marketCell(term);
}

function numericRange(values, suffix = '') {
  const nums = values.map(centsNumber).filter((n) => n !== null);
  if (!nums.length) return 'MISSING';
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  return lo === hi ? `${lo}${suffix}` : `${lo}${suffix}-${hi}${suffix}`;
}

function marketSummary(terms) {
  const bids = terms.map((t) => t?.market_context?.bid_cents);
  const asks = terms.map((t) => t?.market_context?.ask_cents);
  const implied = terms.map((t) => t?.market_context?.implied);
  return `${terms.length} displayed terms; bid range ${numericRange(bids, 'c')}; ask range ${numericRange(asks, 'c')}; implied range ${numericRange(implied)}.`;
}

function deterministicSourceGaps(ranked) {
  const gaps = [];
  for (const t of ranked) {
    if (!isResearchBacked(t)) {
      gaps.push(`${t._short}: research gap remains`);
      continue;
    }
    const missing = Array.isArray(t.missing_research_layers) ? t.missing_research_layers : [];
    if (missing.length) gaps.push(`${t._short}: research gap remains`);
  }
  return gaps.length ? gaps : ['none recorded'];
}

function deterministicUpgradeTriggers(ranked) {
  const ups = [...new Set(ranked.map((t) => t.upgrade_trigger).filter(Boolean))].slice(0, 5);
  return ups.length ? ups : ['exact-source research adds transcript, direct quote, or historical tendency evidence'];
}

// Render-time invariants, enforced by code (never a model).
export function validateRenderedPacket(text, input) {
  let lastIdx = -1;
  for (const section of SECTION_ORDER) {
    const idx = text.indexOf(`\n${section}\n`) >= 0 ? text.indexOf(`\n${section}\n`) : text.indexOf(section);
    if (idx < 0) throw new Error(`rendered packet missing section "${section}"`);
    if (idx < lastIdx) throw new Error(`rendered packet section out of order: "${section}"`);
    lastIdx = idx;
  }
  for (const term of input?.terms ?? []) {
    const full = String(term.full_strike_text ?? '').trim();
    if (full && !text.includes(full)) throw new Error(`rendered packet omitted full strike text: ${full}`);
  }
  if (!/research only/i.test(text)) throw new Error('rendered packet omitted research-only footer');
  if (!text.includes(`renderer_contract: ${CUSTOMER_PACKET_CONTRACT_V2}`)) {
    throw new Error(`rendered packet omitted ${CUSTOMER_PACKET_CONTRACT_V2} contract marker`);
  }
  const legacyPostureLine = text.split(/\r?\n/).find((line) => /\b(EVIDENCE_LEAN|LEAN|WATCH|NO_CLEAR_PICK)\b/i.test(line)) ?? null;
  if (legacyPostureLine) throw new Error(`rendered packet leaked legacy posture jargon: ${legacyPostureLine}`);
  const legacyResearchLine = text.split(/\r?\n/).find((line) => /\b(source layer(?:s)?|proximity-only|stub|scaffold|composite score|source-backed composite)\b/i.test(line)) ?? null;
  if (legacyResearchLine) {
    throw new Error(`rendered packet leaked legacy research jargon: ${legacyResearchLine}`);
  }
  if (/Most likely mention terms/i.test(text)) throw new Error('rendered packet leaked old Most likely mention terms scaffold format');
  if (/\|\s*scaffold\s*\|/i.test(text)) throw new Error('rendered packet leaked scaffold in board column');
  return true;
}
