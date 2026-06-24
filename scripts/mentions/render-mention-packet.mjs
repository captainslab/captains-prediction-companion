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
const TRUMP_QUALIFICATION_CHECK = '0. QUALIFICATION CHECK';
const TIER_RANK = Object.freeze({ 'STRONG YES': 4, 'WEAK YES': 3, 'WEAK NO': 2, 'STRONG NO': 1, [GAP_LABEL]: 0 });
const FORBIDDEN_CUSTOMER_JARGON_RE = /\b(EVIDENCE_LEAN|NO_CLEAR_PICK|WATCH|LEAN|source layer(?:s)?|event_proximity|proximity-only|stub|scaffold|composite score|source-backed composite)\b/i;
const COLD_CURRENT_CONTEXT_RE = /\b(no direct current context|weak current context|not a topic|not a focus|not a primary|not primary|not central|not relevant|irrelevant|cold|no current context|current context cold)\b/i;
const SOURCES_META_NOTE = 'Sources: see packet meta/audit artifact.';

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
  return `#${rank} ${term} — ${score} — ${tier}`;
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

function termNarrativeText(term, note = {}) {
  return [
    note.reason,
    note.catalyst,
    term?.research_reason,
    term?.catalyst,
    term?.research_term_note?.catalyst,
  ].filter(Boolean).join(' ').trim();
}

function termHasSourceRefs(term, note = {}) {
  const narrative = termNarrativeText(term, note);
  return /\[\d+\]/.test(narrative)
    || (Array.isArray(note.citations) && note.citations.length > 0)
    || (Array.isArray(term?.research_term_note?.citations) && term.research_term_note.citations.length > 0);
}

function lowerJoined(parts) {
  return parts.map((part) => String(part ?? '').trim()).filter(Boolean).join(' ').toLowerCase();
}

function packetRouteText(input = {}) {
  return lowerJoined([
    input?.research_provenance?.research_route,
    input?.event?.title,
    input?.event?.subtitle ?? input?.event?.sub_title,
  ]);
}

function packetQualificationText(input = {}) {
  return lowerJoined([
    input?.research_provenance?.research_route,
    input?.event?.title,
    input?.event?.subtitle ?? input?.event?.sub_title,
    input?.event?.rules_primary,
    input?.event?.rules_secondary,
  ]);
}

function isTrumpPacket(input = {}) {
  const route = String(input?.research_provenance?.research_route ?? '').trim().toLowerCase();
  if (route.startsWith('trump_')) return true;
  return /\btrump\b/.test(packetRouteText(input));
}

export function buildTrumpQualificationCheck(input = {}) {
  if (!isTrumpPacket(input)) return null;
  const text = packetQualificationText(input);

  const highReason = 'Foreign-leader or diplomatic appearances can turn into photo ops, bilateral moments, or side events without stable remarks.';
  const mediumHighReason = 'Formal signing events can be canceled, moved, or converted to non-qualifying paperwork/photo release.';
  const mediumReason = 'Press conferences and formal remarks usually qualify, but the speaking block can narrow or shift.';
  const lowReason = 'Rallies and long-form interviews usually keep Trump speaking continuously, so qualification risk is low.';

  const matches = [
    {
      risk: 'HIGH',
      event_type: 'foreign-leader joint appearance / bilateral / summit side event',
      reason: highReason,
      patterns: [
        /\bpool spray\b/i,
        /\bphoto op\b/i,
        /\bbilateral meeting\b/i,
        /\bforeign[- ]leader(?:\s+joint appearance)?\b/i,
        /\bjoint appearance\b/i,
        /\bforeign[- ]leader press availability\b/i,
        /\bpress availability\b/i,
        /\bsummit side event\b/i,
        /\bclosed[- ]door\b/i,
        /\bschedule[- ]unstable\b/i,
        /\btrade\/treaty\/diplomacy signing\b/i,
        /\btrade signing\b/i,
        /\btreaty signing\b/i,
        /\bdiplomacy signing\b/i,
      ],
    },
    {
      risk: 'MEDIUM-HIGH',
      event_type: 'executive order signing',
      reason: mediumHighReason,
      patterns: [/\bexecutive order signing\b/i],
    },
    {
      risk: 'MEDIUM-HIGH',
      event_type: 'proclamation signing',
      reason: mediumHighReason,
      patterns: [/\bproclamation signing\b/i],
    },
    {
      risk: 'MEDIUM-HIGH',
      event_type: 'formal signing ceremony',
      reason: mediumHighReason,
      patterns: [/\bformal signing ceremony\b/i],
    },
    {
      risk: 'MEDIUM-HIGH',
      event_type: 'bill signing',
      reason: mediumHighReason,
      patterns: [
        /\bsigning\b/i,
      ],
    },
    {
      risk: 'MEDIUM',
      event_type: 'press conference',
      reason: mediumReason,
      patterns: [/\bpress conference\b/i],
    },
    {
      risk: 'MEDIUM',
      event_type: 'major policy speech',
      reason: mediumReason,
      patterns: [/\bmajor policy speech\b/i],
    },
    {
      risk: 'MEDIUM',
      event_type: 'cabinet meeting remarks',
      reason: mediumReason,
      patterns: [/\bcabinet meeting remarks\b/i, /\bcabinet meeting\b/i],
    },
    {
      risk: 'MEDIUM',
      event_type: 'formal public remarks',
      reason: mediumReason,
      patterns: [/\bformal public remarks\b/i, /\bpublic remarks\b/i],
    },
    {
      risk: 'LOW',
      event_type: 'major campaign speech',
      reason: lowReason,
      patterns: [/\bmajor campaign speech\b/i],
    },
    {
      risk: 'LOW',
      event_type: 'campaign rally',
      reason: lowReason,
      patterns: [/\bcampaign rally\b/i],
    },
    {
      risk: 'LOW',
      event_type: 'major rally',
      reason: lowReason,
      patterns: [/\bmajor rally\b/i],
    },
    {
      risk: 'LOW',
      event_type: 'rally',
      reason: lowReason,
      patterns: [/\brally\b/i],
    },
    {
      risk: 'LOW',
      event_type: 'town hall',
      reason: lowReason,
      patterns: [/\btown hall\b/i],
    },
    {
      risk: 'LOW',
      event_type: 'debate',
      reason: lowReason,
      patterns: [/\bdebate\b/i],
    },
    {
      risk: 'LOW',
      event_type: 'long-form TV interview',
      reason: lowReason,
      patterns: [/\blong[- ]form tv interview\b/i, /\btv interview\b/i, /\binterview\b/i],
    },
  ];

  for (const candidate of matches) {
    if (candidate.patterns.some((re) => re.test(text))) {
      const hasSpecificSigning = /\bexecutive order\b/i.test(text)
        || /\bproclamation\b/i.test(text)
        || /\bformal signing ceremony\b/i.test(text);
      const eventType = candidate.event_type === 'bill signing' && !hasSpecificSigning
        ? 'bill signing'
        : candidate.event_type;
      return {
        event_type: eventType,
        ednq_risk: candidate.risk,
        reason: candidate.reason,
        content_term_note: 'Content-term reads are conditional on a qualifying spoken event.',
      };
    }
  }

  return {
    event_type: 'Trump event',
    ednq_risk: 'MEDIUM',
    reason: mediumReason,
    content_term_note: 'Content-term reads are conditional on a qualifying spoken event.',
  };
}

function cardEvidenceLabel(term, note = {}) {
  const provenance = note.provenance ?? term.research_term_note?.provenance ?? null;
  const hasHistory = Boolean(provenance);
  const narrative = termNarrativeText(term, note);
  const coldCurrent = COLD_CURRENT_CONTEXT_RE.test(narrative);
  const hasCurrent = Boolean(narrative) && !coldCurrent;
  const short = String(term?._short ?? term?.short_term ?? term?.full_strike_text ?? '').trim();
  const isCountTerm = (Number.isFinite(Number(term?.required_count)) && Number(term.required_count) > 1)
    || /\(\s*\d+\+\s*times\s*\)/i.test(short)
    || /\brepeat_requirement\b/i.test(String(term?.repeat_requirement ?? ''));

  if (hasHistory && isCountTerm) return 'comparable history only; weak current context.';
  if (hasHistory && coldCurrent) return 'comparable history only; weak current context.';
  if (hasHistory && hasCurrent) return 'current-event context + comparable history.';
  if (hasHistory) return 'comparable history only.';
  if (hasCurrent) return 'current-event context.';
  return 'no direct current context.';
}

function pushCardBlock(lines, label, value, width = 76) {
  const safeValue = safeCustomerText(value, 'MISSING');
  const wrapped = wrapText(safeValue, width);
  lines.push(label);
  if (!wrapped.length) {
    lines.push('MISSING');
    lines.push('');
    return;
  }
  lines.push(wrapped[0]);
  for (const continuation of wrapped.slice(1)) {
    lines.push(continuation);
  }
  lines.push('');
}

function renderTrumpQualificationCheck(lines, input) {
  const gate = buildTrumpQualificationCheck(input);
  if (!gate) return false;
  lines.push(TRUMP_QUALIFICATION_CHECK);
  lines.push('');
  pushCardBlock(lines, 'Event type:', gate.event_type ?? 'MISSING');
  pushCardBlock(lines, 'EDNQ risk:', gate.ednq_risk ?? 'MISSING');
  pushCardBlock(lines, 'Reason:', gate.reason ?? 'MISSING');
  pushCardBlock(lines, 'Content-term reads:', gate.content_term_note ?? 'Content-term reads are conditional on a qualifying spoken event.');
  return true;
}

function renderTermCard(lines, term, index, note = {}, { tierOverride = null } = {}) {
  const tier = tierOverride ?? renderedPosture(term);
  const rank = index + 1;
  const score = cpcCell(term);
  lines.push(sectionLabelHeader(rank, term._short, score, tier));
  lines.push('');
  pushCardBlock(lines, 'Why:', note.catalyst ?? term.catalyst ?? 'MISSING');
  pushCardBlock(lines, 'Settlement:', note.settlement_fit ?? term.settlement_fit ?? 'MISSING');
  pushCardBlock(lines, 'Evidence:', cardEvidenceLabel(term, note));
  const provenance = note.provenance ?? term.research_term_note?.provenance ?? null;
  if (provenance) {
    pushCardBlock(lines, 'Provenance:', provenance);
  }
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
    lines.push('');
    pushCardBlock(lines, 'Settlement:', 'EDNQ is a separate settlement path if the event/rules do not qualify. This is not a content-term pick.');
    pushCardBlock(lines, 'Read:', proven ? `YES-leaning qualification risk proven (${status || 'unknown'})` : 'Neutral fallback, not a pick.');
  }
}

function renderInventoryLabel(term) {
  if (isQualificationRisk(term)) return 'Event does not qualify';
  return maybe(term?._short ?? term?.short_term ?? shortTerm(term?.full_strike_text, ''));
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
  lines.push('');
  if (!terms.length) {
    lines.push('- none');
    lines.push('');
    return;
  }
  terms.forEach((term) => {
    const idx = ranked.indexOf(term);
    renderTermCard(lines, term, idx, notes[term._short] ?? {}, tierFilter ? { tierOverride: tierFilter(term) } : {});
  });
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
  renderTrumpQualificationCheck(lines, input);

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
  if (ranked.some((term) => termHasSourceRefs(term, notes[term._short] ?? {}))) {
    lines.push(SOURCES_META_NOTE);
  }
  lines.push('');

  lines.push('8. FULL STRIKE INVENTORY');
  for (const t of ranked) lines.push(`- ${renderInventoryLabel(t)}`);
  lines.push('');

  lines.push('---');
  lines.push(`renderer_contract: ${CUSTOMER_PACKET_CONTRACT_V2}`);
  lines.push('Research only. No trades. No bankroll advice. Market context is never a score input.');
  return lines.join('\n');
}

// Render-time invariants, enforced by code (never a model).
export function validateRenderedPacket(text, input) {
  const trumpGate = buildTrumpQualificationCheck(input);
  let lastIdx = -1;
  const sections = trumpGate ? [TRUMP_QUALIFICATION_CHECK, ...SECTION_ORDER] : SECTION_ORDER;
  for (const section of sections) {
    const idx = text.indexOf(`\n${section}\n`) >= 0 ? text.indexOf(`\n${section}\n`) : text.indexOf(section);
    if (idx < 0) throw new Error(`rendered packet missing section "${section}"`);
    if (idx < lastIdx) throw new Error(`rendered packet section out of order: "${section}"`);
    lastIdx = idx;
  }
  if (trumpGate) {
    const gateIdx = text.indexOf(TRUMP_QUALIFICATION_CHECK);
    const fastReadIdx = text.indexOf('1. FAST READ');
    if (gateIdx < 0 || gateIdx > fastReadIdx) {
      throw new Error('rendered packet omitted Trump qualification check before FAST READ');
    }
  } else if (text.includes(TRUMP_QUALIFICATION_CHECK)) {
    throw new Error('rendered packet rendered Trump qualification check for a non-Trump packet');
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
  if (/\[\d+\]/.test(text)) {
    if (!text.includes(SOURCES_META_NOTE)) {
      throw new Error('rendered packet included bracket refs but omitted compact sources note');
    }
  }
  for (const term of input?.terms ?? []) {
    const label = String(term?.is_qualification_term === true
      ? 'Event does not qualify'
      : term?.short_term ?? term?._short ?? shortTerm(term?.full_strike_text, input?.event?.title)).trim();
    if (label && !text.includes(label)) throw new Error(`rendered packet omitted short strike text: ${label}`);
  }
  return true;
}
