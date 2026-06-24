// Deterministic CPC mentions packet renderer.
//
// renderMentionPacket() is the ONLY writer of the final user-facing .txt.
// Models never produce layout - they contribute optional strict-JSON fields
// (analyst narrative, red-team flags) that are validated upstream and slotted
// into fixed sections here. Same input always renders the same text.
//
// Fixed section order (never reordered):
//   1 FAST READ
//   2 TOP YES CASE
//   3 WEAK YES WATCHLIST
//   4 WEAK NO / STRONG NO TRAPS
//   5 SOURCE GAPS
//   6 QUALIFICATION RISK
//   7 SETTLEMENT NOTES
//   8 FULL STRIKE INVENTORY
//
// Market price/liquidity is display-only context and never a score input.
// All user-facing times are America/Chicago.

export const SECTION_ORDER = Object.freeze([
  '1. FAST READ',
  '2. TOP YES CASE',
  '3. WEAK YES WATCHLIST',
  '4. WEAK NO / STRONG NO TRAPS',
  '5. SOURCE GAPS',
  '6. QUALIFICATION RISK',
  '7. SETTLEMENT NOTES',
  '8. FULL STRIKE INVENTORY',
]);

const CENTRAL_TZ = 'America/Chicago';
export const CUSTOMER_PACKET_CONTRACT_V2 = 'mentions_customer_packet_v2';
export const CUSTOMER_RENDERER_ID = 'renderMentionPacket/v2';
const GAP_STATE = 'research gap';
const GAP_LABEL = 'RESEARCH GAP';
const QUALIFICATION_STATE = 'qualification fallback';
const QUALIFICATION_LABEL = 'QUALIFICATION RISK';
const TIER_RANK = Object.freeze({ 'STRONG YES': 4, 'WEAK YES': 3, 'WEAK NO': 2, 'STRONG NO': 1, [GAP_LABEL]: 0 });
const FORBIDDEN_CUSTOMER_JARGON_RE = /\b(EVIDENCE_LEAN|NO_CLEAR_PICK|WATCH|LEAN|PICK|source layer(?:s)?|event_proximity|proximity-only|stub|scaffold|composite score|source-backed composite)\b/i;

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
  if (isQualificationRisk(term)) return QUALIFICATION_STATE;
  if (term?.bucket === 'blocked/no-source') return GAP_STATE;
  return Number.isFinite(Number(term?.cpc_score)) ? 'research-backed' : GAP_STATE;
}

function isQualificationRisk(term) {
  // Only the structural EDNQ strike is a qualification term. Do NOT trust
  // term.market_type === 'ednq' here: detectMarketType folds event-level
  // cancellation boilerplate into every market, so that flag is set on normal
  // content terms too. Key on the explicit flag (derived from the strike text
  // upstream) and the strike text itself.
  return term?.is_qualification_term === true
    || /event does not qualify/i.test(String(term?.full_strike_text ?? ''));
}

function isResearchBacked(term) {
  return !isQualificationRisk(term) && researchState(term) !== GAP_STATE;
}

export function formatCentral(isoOrDate) {
  if (!isoOrDate) return 'MISSING';
  const d = new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return 'MISSING';
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: CENTRAL_TZ,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  return fmt.format(d);
}

function formatGeneratedStamp(isoOrDate) {
  return formatCentral(isoOrDate);
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

function wrapText(text, width) {
  const raw = String(text ?? '').trim();
  if (!raw) return [];
  const words = raw.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (!line || next.length <= width) {
      line = next;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function pushWrapped(lines, label, value, width = 76, indent = '   ') {
  const safeValue = safeCustomerText(value, 'MISSING');
  const wrapped = wrapText(safeValue, Math.max(20, width - indent.length - label.length));
  if (!wrapped.length) {
    lines.push(`${indent}${label} MISSING`);
    return;
  }
  lines.push(`${indent}${label} ${wrapped[0]}`);
  for (const continuation of wrapped.slice(1)) {
    lines.push(`${indent}${' '.repeat(label.length)} ${continuation}`);
  }
}

function sectionLabelHeader(rank, term, score, tier) {
  // "#N" rank prefix keeps per-strike cards visually distinct from the numbered
  // section headers (e.g. section "3. WEAK YES WATCHLIST" vs card "#3 Democrat").
  return `#${rank} ${term} — P(YES) ${score} — ${tier}`;
}

function cpcCell(term) {
  const score = numericScore(term);
  return score === null ? '--' : String(score);
}

function numericScore(term) {
  const raw = Number(term?.cpc_score);
  if (!isResearchBacked(term)) return null;
  return Number.isFinite(raw) ? Math.round(Math.max(0, Math.min(100, raw))) : null;
}

function renderedPosture(term) {
  return scoreToTier(numericScore(term));
}

function cardResearchLabel(term) {
  return isResearchBacked(term) ? 'source-backed / fresh' : 'research gap';
}

function cardReasonLabel(tier) {
  return tier === 'STRONG NO' || tier === 'WEAK NO' ? 'Why it reads NO' : 'Why it could hit';
}

function renderTermCard(lines, term, index, note = {}, { tierOverride = null } = {}) {
  const tier = tierOverride ?? renderedPosture(term);
  const rank = index + 1;
  const score = cpcCell(term);
  lines.push(sectionLabelHeader(rank, term._short, score, tier));
  pushWrapped(lines, `${cardReasonLabel(tier)}:`, note.catalyst ?? term.catalyst ?? 'MISSING');
  pushWrapped(lines, 'Settlement fit:', note.settlement_fit ?? term.settlement_fit ?? 'MISSING');
  const provenance = note.provenance ?? term.research_term_note?.provenance ?? null;
  if (provenance) {
    pushWrapped(lines, 'Provenance:', provenance);
  }
  lines.push(`   Research: ${cardResearchLabel(term)}`);
}

function renderGapSummary(lines, gapTerms) {
  if (!gapTerms.length) {
    lines.push('- none');
    return;
  }
  const names = gapTerms.map((term) => term._short).filter(Boolean);
  const sample = names.slice(0, 3).join(', ');
  const more = names.length > 3 ? `, +${names.length - 3} more` : '';
  lines.push(`- ${names.length} research gap${names.length === 1 ? '' : 's'} remain: ${sample}${more}.`);
  lines.push('  These strikes stay out of the YES/NO cards until research-backed evidence lands.');
}

function renderQualificationRiskSection(lines, qualificationTerms) {
  lines.push('6. QUALIFICATION RISK');
  if (!qualificationTerms.length) {
    lines.push('- none');
    lines.push('');
    return;
  }
  for (const term of qualificationTerms) {
    const status = String(term?.qualification_status ?? '').trim().toLowerCase();
    const proven = status === 'high' || status === 'medium';
    lines.push(`- ${maybe(term._short)}`);
    lines.push('  Settlement fit: EDNQ is a separate settlement path if the event/rules do not qualify. This is not a content-term pick.');
    lines.push(`  Read: ${proven ? `YES-leaning qualification risk proven (${status || 'unknown'})` : 'neutral fallback, not a pick.'}`);
  }
  lines.push('');
}

// Best rendered tier from the customer board. Research gaps sort last.
export function postCapBestPosture(terms) {
  let best = GAP_LABEL;
  for (const t of terms ?? []) {
    if (isQualificationRisk(t)) continue;
    const p = renderedPosture(t);
    if ((TIER_RANK[p] ?? 0) > (TIER_RANK[best] ?? 0)) best = p;
  }
  return best;
}

// Stable ranking: scored terms first (P(YES) desc), then research gaps.
// Pure on input - gate-only terms can never outrank researched terms.
function rankGroup(term) {
  if (isQualificationRisk(term)) return 2;
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

function collectNotes(ranked, analyst) {
  const notes = Object.create(null);
  for (const term of ranked) {
    const researchNote = term.research_term_note;
    if (researchNote && typeof researchNote === 'object') {
      notes[term._short] = researchNote;
    }
  }
  for (const term of ranked) {
    if (!isResearchBacked(term)) continue;
    if (notes[term._short]) continue;
    const analystNote = analyst?.term_notes?.[term._short];
    if (analystNote && typeof analystNote === 'object') {
      notes[term._short] = analystNote;
    }
  }
  return notes;
}

function renderCardSection(lines, heading, terms, ranked, notes, { tierFilter = null, includeWeakYesLead = false } = {}) {
  lines.push(heading);
  if (!terms.length) {
    lines.push('- none');
    lines.push('');
    return;
  }
  terms.forEach((term) => {
    const idx = ranked.indexOf(term);
    renderTermCard(lines, term, idx, notes[term._short] ?? {}, tierFilter ? { tierOverride: tierFilter(term) } : {});
    lines.push('');
  });
  if (lines[lines.length - 1] === '') lines.pop();
  lines.push('');
}

/**
 * renderMentionPacket - deterministic final .txt.
 *
 * @param {object} input mentions_watch_user_packet_v1 synthesis input
 * @param {object} opts
 * @param {object?} opts.analyst validated analyst JSON fields (or empty)
 * @param {object?} opts.redteam validated red-team JSON fields (or null)
 * @param {string?} opts.generatedAtUtc fixed ISO timestamp (injected for determinism)
 * @param {string?} opts.analystTier 'none' | 'standard' | 'premium' (provenance line)
 */
export function renderMentionPacket(input, { analyst = null, redteam = null, generatedAtUtc = null, analystTier = 'none' } = {}) {
  if (!input || typeof input !== 'object') throw new Error('renderMentionPacket: input missing');
  const e = input.event ?? {};
  const summary = input.summary ?? {};
  const ranked = rankTerms(Array.isArray(input.terms) ? input.terms : [], e.title);
  if (!ranked.length) throw new Error('renderMentionPacket: no terms to render');
  const a = analyst ?? {};
  const notes = collectNotes(ranked, a);
  const qualificationTerms = ranked.filter(isQualificationRisk);
  const contentTerms = ranked.filter((term) => !isQualificationRisk(term));

  const lines = [];
  lines.push(`=== Captain Mentions — CPC Packet: ${maybe(e.title)} ===`);
  lines.push(`event_time_central: ${formatCentral(e.date_time)}`);
  lines.push(`date: ${maybe(input.date)}`);
  if (generatedAtUtc) lines.push(`generated_utc: ${formatGeneratedStamp(generatedAtUtc)}`);
  lines.push(`settlement_source: ${maybe(e.settlement_source_link)}`);
  lines.push(`analyst_tier: ${analystTier}`);
  lines.push('Market Context - NOT IN SCORE: display-only context; never a score input.');
  lines.push('Content terms are words likely to be said; count terms are the exact token plus the required repeat count; EDNQ is a separate settlement path if the event or rules do not qualify.');
  lines.push('');

  const bestTier = postCapBestPosture(contentTerms);
  const researchedCount = contentTerms.filter(isResearchBacked).length;
  lines.push('1. FAST READ');
  lines.push(safeCustomerText(a.fast_read, `${researchedCount}/${contentTerms.length} term(s) have research-backed P(YES); best tier ${bestTier}. Research only — no trade.`));
  lines.push('');

  const strongYes = [];
  const weakYes = [];
  const weakNo = [];
  const strongNo = [];
  const gapTerms = [];
  for (const term of contentTerms) {
    const tier = renderedPosture(term);
    if (!isResearchBacked(term)) {
      gapTerms.push(term);
    } else if (tier === 'STRONG YES') {
      strongYes.push(term);
    } else if (tier === 'WEAK YES') {
      weakYes.push(term);
    } else if (tier === 'WEAK NO') {
      weakNo.push(term);
    } else if (tier === 'STRONG NO') {
      strongNo.push(term);
    } else {
      gapTerms.push(term);
    }
  }

  const topYes = [...strongYes, ...(weakYes.length ? [weakYes[0]] : [])];
  renderCardSection(lines, '2. TOP YES CASE', topYes, ranked, notes);

  renderCardSection(lines, '3. WEAK YES WATCHLIST', weakYes.slice(1), ranked, notes);

  renderCardSection(lines, '4. WEAK NO / STRONG NO TRAPS', [...weakNo, ...strongNo], ranked, notes);

  lines.push('5. SOURCE GAPS');
  renderGapSummary(lines, gapTerms.length ? gapTerms : contentTerms.filter((t) => !isResearchBacked(t)));
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

  renderQualificationRiskSection(lines, qualificationTerms);

  lines.push('7. SETTLEMENT NOTES');
  const provenanceLines = Array.isArray(input.deterministic_provenance_lines)
    ? input.deterministic_provenance_lines.filter(Boolean)
    : [];
  if (provenanceLines.length) {
    lines.push('provenance (outcomes only; market prices excluded):');
    for (const line of provenanceLines) lines.push(`- ${line}`);
  } else {
    lines.push('- none');
  }
  lines.push('');

  lines.push('8. FULL STRIKE INVENTORY');
  for (const t of ranked) lines.push(`- ${maybe(t.full_strike_text)}`);
  lines.push('');

  lines.push('---');
  lines.push(`renderer_contract: ${CUSTOMER_PACKET_CONTRACT_V2}`);
  lines.push('Research only. No trades. No bankroll advice. Market context is never a score input.');
  return lines.join('\n');
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
  const legacyResearchLine = text.split(/\r?\n/).find((line) => /\b(source layer(?:s)?|event_proximity|proximity-only|stub|scaffold|composite score|source-backed composite)\b/i.test(line)) ?? null;
  if (legacyResearchLine) {
    throw new Error(`rendered packet leaked legacy research jargon: ${legacyResearchLine}`);
  }
  if (/Most likely mention terms/i.test(text)) throw new Error('rendered packet leaked old Most likely mention terms scaffold format');
  if (/\|\s*scaffold\s*\|/i.test(text)) throw new Error('rendered packet leaked scaffold in board column');
  return true;
}
