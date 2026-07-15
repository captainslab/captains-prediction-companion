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
//   9 MODEL-MARKET SNAPSHOTS
//
// Market quotes are display-only context attached after model rows are frozen
// and hashed; they never enter research, history, scoring, or ranking.
// All user-facing times are America/Chicago.

import {
  formatPmtAdvisoryContext,
} from './pmt-advisory-context.mjs';
import {
  classifyEdnqRisk,
  normalizeQualificationResult,
} from './qualification-risk.mjs';
import { sanitizeUnsupportedClaim } from './mentions-research-perplexity.mjs';
import { attachMarketSnapshots } from './market-snapshot.mjs';
import {
  validateMentionPacketIntegrity,
  validateCanonicalMentionIdentity,
} from './event-integrity.mjs';

export const SECTION_ORDER = Object.freeze([
  '1. FAST READ',
  '2. TOP YES CASE',
  '3. WEAK YES WATCHLIST',
  '4. WEAK NO / STRONG NO TRAPS',
  '5. SOURCE GAPS',
  '6. QUALIFICATION RESULT / EDNQ RISK',
  '7. SETTLEMENT NOTES',
  '8. FULL STRIKE INVENTORY',
  '9. MODEL-MARKET SNAPSHOTS',
]);

const CENTRAL_TZ = 'America/Chicago';
export const CUSTOMER_PACKET_CONTRACT_V2 = 'mentions_customer_packet_v2';
export const CUSTOMER_RENDERER_ID = 'renderMentionPacket/v2';
const GAP_STATE = 'research gap';
const GAP_LABEL = 'RESEARCH GAP';
const QUALIFICATION_STATE = 'qualification fallback';
const QUALIFICATION_LABEL = 'QUALIFICATION RISK';
const TIER_RANK = Object.freeze({ 'STRONG YES': 4, 'WEAK YES': 3, 'WEAK NO': 2, 'STRONG NO': 1, [GAP_LABEL]: 0 });
const FORBIDDEN_CUSTOMER_JARGON_RE = /(?:\bEVIDENCE[ _]LEAN\b|\bNO[ _]CLEAR[ _]PICK\b|\bWATCH\b|\bLEAN\b|\bLEANS\b|\bpick\b|\bfade\b|\bbest bet\b|\bwager\b|\bbankroll\b|Call:|Market board|Side \/ market|\bsource layer(?:s)?\b|\bevent_proximity\b|\bproximity-only\b|\bstub\b|\bscaffold\b|\bcomposite score\b|\bsource-backed composite\b)/i;
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
  const d = new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return 'MISSING';
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  return fmt.format(d);
}

function formatGeneratedCentralStamp(isoOrDate) {
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
  return `#${rank} ${term} — CPC YES SCORE: ${score === '--' ? 'UNAVAILABLE' : `${score}/100`} — ${tier}`;
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

export function buildTrumpQualificationCheck(input = {}) {
  const route = String(input?.research_provenance?.research_route ?? '').trim().toLowerCase();
  const text = lowerJoined([
    route,
    input?.event?.title,
    input?.event?.subtitle ?? input?.event?.sub_title,
    input?.event?.rules_primary,
    input?.event?.rules_secondary,
  ]);
  if (!route.startsWith('trump_') && !/\btrump\b/.test(text)) return null;

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
        /\bworking lunch\b/i,
        /\bmulti[- ]party\b/i,
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
  const familyTier = term?.earnings_family_history?.tier;
  const hasFamilyHistory = familyTier === 'earnings_family' || familyTier === 'exact_series';
  const hasHistory = Boolean(provenance) || hasFamilyHistory;
  const familyHistoryLabel = familyTier === 'earnings_family'
    ? 'cross-company earnings family history (no same-company history)'
    : 'comparable history';
  const familyHistoryOnlyLabel = familyTier === 'earnings_family'
    ? 'cross-company earnings family history only (no same-company history)'
    : 'comparable history only';
  const narrative = termNarrativeText(term, note);
  const coldCurrent = COLD_CURRENT_CONTEXT_RE.test(narrative);
  const hasCurrent = Boolean(narrative) && !coldCurrent;
  const short = String(term?._short ?? term?.short_term ?? term?.full_strike_text ?? '').trim();
  const isCountTerm = (Number.isFinite(Number(term?.required_count)) && Number(term.required_count) > 1)
    || /\(\s*\d+\+\s*times\s*\)/i.test(short)
    || /\brepeat_requirement\b/i.test(String(term?.repeat_requirement ?? ''));

  if (hasHistory && isCountTerm) return `${familyHistoryOnlyLabel}; weak current context.`;
  if (hasHistory && coldCurrent) return `${familyHistoryOnlyLabel}; weak current context.`;
  if (hasHistory && hasCurrent) return `current-event context + ${familyHistoryLabel}.`;
  if (hasHistory) return `${familyHistoryOnlyLabel}.`;
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

function renderPmtAdvisoryBlock(lines, context) {
  const advisoryLines = formatPmtAdvisoryContext(context)
    .map((line) => safeCustomerText(line, null))
    .filter(Boolean);
  if (!advisoryLines.length) return;
  lines.push('');
  for (const line of advisoryLines) {
    lines.push(line);
  }
  lines.push('');
}

function renderTermCard(lines, term, index, note = {}, { tierOverride = null } = {}) {
  const tier = tierOverride ?? renderedPosture(term);
  const rank = index + 1;
  const score = cpcCell(term);
  lines.push(sectionLabelHeader(rank, term._short, score, tier));
  lines.push('');
  const whyText = sanitizeUnsupportedClaim(note.catalyst ?? term.catalyst ?? term.research_reason ?? 'MISSING', {
    hasSourceSupport: termHasSourceRefs(term, note),
  });
  pushCardBlock(lines, 'Why:', whyText);
  pushCardBlock(lines, 'Settlement:', note.settlement_fit ?? term.settlement_fit ?? 'MISSING');
  pushCardBlock(lines, 'Evidence:', cardEvidenceLabel(term, note));
  const provenance = note.provenance ?? term.research_term_note?.provenance ?? null;
  if (provenance) {
    pushCardBlock(lines, 'Provenance:', provenance);
  }
}

function renderGapSummary(gapTerms) {
  if (!gapTerms.length) return [];
  const names = gapTerms.map((term) => term._short).filter(Boolean);
  const sample = names.slice(0, 3).join(', ');
  const more = names.length > 3 ? `, +${names.length - 3} more` : '';
  return [
    `- ${names.length} research gap${names.length === 1 ? '' : 's'} remain: ${sample}${more}.`,
    '  These strikes stay out of the YES/NO cards until research-backed evidence lands.',
  ];
}

// Explicit per-strike evidence-availability gaps. A term that scores on
// current-context only (no settled comparables, no transcript word-match)
// must produce an explicit SOURCE GAPS line naming WHICH source is missing
// and WHY — so absence is visible, not silently flattened into "research-
// backed". Reads the evidence_availability record plumbed from the decision
// row (generate-mentions-daily.mjs: computeEvidenceAvailability). Never
// emits a price-shaped field or value.
function evidenceGapLine(term) {
  const ev = term?.evidence_availability;
  if (!ev) return null;
  const short = term?._short ?? term?.short_term ?? 'unknown';
  const parts = [];
  const family = term?.earnings_family_history;
  if (family?.tier === 'lookup_failed') {
    parts.push(`earnings family lookup failed${family.error ? ` (${family.error})` : ''}; family history is unavailable, not verified zero`);
  } else if (family?.tier === 'earnings_family') {
    const hitRate = family.hit_rate == null ? 'n/a' : Number(family.hit_rate).toFixed(2);
    const penalty = family.penalty == null ? 'n/a' : Number(family.penalty).toFixed(2);
    parts.push(`same-company settled history absent (n<2); using cross-company earnings family fallback n=${family.n} hits=${family.hits} misses=${family.misses} hit_rate=${hitRate} penalty=${penalty}`);
  } else if (family?.tier === 'none') {
    parts.push('same-company settled history absent (n<2); no earnings family history with n>=2');
  }
  const se = ev.settled_evidence;
  if (se && se.status !== 'present') {
    const why = se.status === 'none_for_series'
      ? 'no settled comparables for this series'
      : se.status === 'store_missing'
        ? 'settled-history store not ingested'
        : se.status === 'error'
          ? 'settled-history lookup failed'
          : se.status === 'unavailable'
            ? 'settled-history lookup could not be completed'
            : 'no settled comparables';
    parts.push(`settled history: ${why} (n=${se.n ?? 0})`);
  }
  const te = ev.transcript_evidence;
  if (te && te.status !== 'present') {
    parts.push('transcript source not available');
  }
  if (!parts.length) return null;
  return `- ${short}: ${parts.join('; ')}`;
}

function renderEvidenceAvailabilityGaps(terms) {
  const gapLines = [];
  for (const term of terms) {
    if (isQualificationRisk(term)) continue;
    const line = evidenceGapLine(term);
    if (line) gapLines.push(line);
  }
  if (!gapLines.length) return [];
  return [
    'evidence availability gaps (declared absence, not fabricated):',
    ...gapLines,
  ];
}

// Surface a non-silent confidence cap so the customer can see WHY a score
// was clamped. Reads confidence_cap_reason plumbed from the decision row.
function renderConfidenceCapNotes(terms) {
  const capped = terms.filter((t) => t?.confidence_cap_reason);
  if (!capped.length) return [];
  const lines = ['confidence cap (current-context-only evidence, score capped below STRONG YES):'];
  for (const term of capped) {
    const short = term?._short ?? term?.short_term ?? 'unknown';
    lines.push(`- ${short}: ${term.confidence_cap_reason}`);
  }
  return lines;
}

function renderQualificationRiskSection(lines, risk) {
  lines.push('6. QUALIFICATION RESULT / EDNQ RISK');
  lines.push(`- EDNQ result: ${risk.result_label} is a separate event-level result/outcome, not a spoken-term strike.`);
  lines.push(`- CPC Read: ${normalizeQualificationResult(risk.cpc_read)}`);
  lines.push('- Why EDNQ could happen:');
  for (const line of risk.why_ednq?.length ? risk.why_ednq : ['No clear qualification-pathway indicator is confirmed yet.']) {
    lines.push(`  - ${line}`);
  }
  lines.push('- Current qualification check:');
  for (const line of risk.current_check?.length ? risk.current_check : ['Trusted event time not yet confirmed; do not treat settlement expiration as the event start.']) {
    lines.push(`  - ${line}`);
  }
  lines.push(`- Historical EDNQ pattern note: ${risk.historical_note}`);
  if (risk.active_blockers?.length) {
    lines.push('- Active metadata/source-window blockers:');
    for (const blocker of risk.active_blockers) {
      lines.push(`  - ${blocker}`);
    }
  } else {
    lines.push('- Active metadata/source-window blockers: none');
  }
  lines.push(`- Qualification term inventory: ${risk.qualification_term_count > 0 ? risk.qualification_term_labels.join(', ') : 'none'}`);
  lines.push('');
}

function renderInventoryLabel(term) {
  if (isQualificationRisk(term)) return null;
  // The inventory is the exact contract surface; card labels may be compact,
  // but this section must never truncate or normalize the accepted strike.
  return maybe(term?.full_strike_text ?? term?._short ?? term?.short_term ?? '');
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
export function renderMentionPacket(input, {
  analyst = null,
  redteam = null,
  generatedAtUtc = null,
  analystTier = 'none',
  marketQuotes = [],
  marketSnapshotUtc = null,
} = {}) {
  if (!input || typeof input !== 'object') throw new Error('renderMentionPacket: input missing');
  if (input?.presentation?.blocked) {
    const code = input.presentation.blocker_code ?? 'BLOCKED_EVENT_METADATA_MISMATCH';
    const reason = input.presentation.reason ?? 'event metadata mismatch';
    throw new Error(`renderMentionPacket: ${code}: ${reason}`);
  }
  const e = input.event ?? {};
  const summary = input.summary ?? {};
  const modelTerms = (Array.isArray(input.terms) ? input.terms : []).map((term) => ({
    ...term,
    composite_score: term?.cpc_score ?? null,
  }));
  const snapshotAttachment = attachMarketSnapshots({
    modelRows: modelTerms.map((term) => ({
      ...term,
      market_ticker: term?.market_ticker ?? term?.marketTicker ?? term?.ticker ?? null,
      cpc_score: term?.cpc_score ?? null,
    })),
    quotes: marketQuotes,
    nowUtc: marketSnapshotUtc ?? generatedAtUtc,
  });
  const ranked = rankTerms(snapshotAttachment.rows, e.title);
  if (!ranked.length) throw new Error('renderMentionPacket: no terms to render');
  const a = analyst ?? {};
  const notes = collectNotes(ranked, a);
  const qualificationTerms = ranked.filter(isQualificationRisk);
  const contentTerms = ranked.filter((term) => !isQualificationRisk(term));
  const ednqRisk = classifyEdnqRisk({
    event: e,
    researchRoute: input?.research_provenance?.event_format
      ?? input?.research_provenance?.research_route
      ?? null,
    qualificationTerms,
    presentation: input?.presentation ?? null,
  });
  const pmtAdvisoryContext = input?.research_provenance?.pmt_advisory_context
    ?? ranked.find((term) => term?.pmt_advisory_context)?.pmt_advisory_context
    ?? null;

  const lines = [];
  lines.push(`=== Captain Mentions — CPC Packet: ${maybe(e.title)} ===`);
  const canonical = input?.canonical_event
    ?? input?.presentation?.canonical_event
    ?? input?.event?.canonical_event
    ?? null;
  const presentedEventIso = canonical?.event_time_central?.iso ?? input?.presentation?.event_time_iso ?? e.date_time ?? null;
  lines.push(`kalshi_event_ticker: ${maybe(canonical?.kalshi_event_ticker ?? e.kalshi_event_ticker)}`);
  lines.push(`kalshi_series_ticker: ${maybe(canonical?.kalshi_series_ticker ?? e.kalshi_series_ticker)}`);
  lines.push(`kalshi_event_url: ${canonical?.kalshi_event_url ?? 'UNAVAILABLE'}`);
  lines.push(`declared_source_url: ${canonical?.declared_source_url ?? e.declared_source_url ?? 'UNAVAILABLE'}`);
  lines.push(`event_date: ${maybe(canonical?.event_date ?? input.date)}`);
  lines.push(`event_time_central: ${presentedEventIso ? formatCentral(presentedEventIso) : 'UNCONFIRMED'}`);
  lines.push(`generated_utc: ${canonical?.generated_utc ? formatGeneratedStamp(canonical.generated_utc) : 'UNAVAILABLE'}`);
  lines.push(`generated_central: ${canonical?.generated_central ? formatGeneratedCentralStamp(canonical.generated_central) : 'UNAVAILABLE'}`);
  lines.push(`research_timestamp: ${canonical?.research_timestamp ? formatGeneratedStamp(canonical.research_timestamp) : 'UNAVAILABLE'}`);
  lines.push(`settlement_source: ${canonical?.settlement_source ?? e.settlement_source_link ?? 'UNAVAILABLE'}`);
  lines.push(`analyst_tier: ${analystTier}`);
  lines.push('Market Context - NOT IN SCORE: display-only context; never a score input.');
  lines.push('Content terms are words likely to be said; count terms are the exact token plus the required repeat count; EDNQ is a separate settlement path if the event or rules do not qualify.');
  lines.push(`Content term count: ${contentTerms.length} content term${contentTerms.length === 1 ? '' : 's'}${qualificationTerms.length ? ` + ${qualificationTerms.length} EDNQ result${qualificationTerms.length === 1 ? '' : 's'}` : ''}.`);
  lines.push('');

  const bestTier = postCapBestPosture(contentTerms);
  const researchedCount = contentTerms.filter(isResearchBacked).length;
  lines.push('1. FAST READ');
  const fastReadFallback = researchedCount === 0
    ? `RESEARCH GAP — 0/${contentTerms.length} term(s) have research-backed P(YES); all remain research gaps. Research only — no trade.`
    : `${researchedCount}/${contentTerms.length} term(s) have a researched P(YES) read; best tier ${bestTier}. Research only — no trade.`;
  lines.push(safeCustomerText(a.fast_read, fastReadFallback));
  renderPmtAdvisoryBlock(lines, pmtAdvisoryContext);
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
  const researchGapLines = renderGapSummary(gapTerms.length ? gapTerms : contentTerms.filter((t) => !isResearchBacked(t)));
  const evidenceGapLines = renderEvidenceAvailabilityGaps(contentTerms);
  const confidenceCapLines = renderConfidenceCapNotes(contentTerms);
  if (!researchGapLines.length && !evidenceGapLines.length && !confidenceCapLines.length) {
    lines.push('- none');
  } else {
    lines.push(...researchGapLines, ...evidenceGapLines, ...confidenceCapLines);
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

  renderQualificationRiskSection(lines, ednqRisk);

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
  for (const t of contentTerms) {
    const label = renderInventoryLabel(t);
    if (label) lines.push(`- ${label}`);
  }
  lines.push('');

  lines.push('9. MODEL-MARKET SNAPSHOTS');
  lines.push('Post-score display-only snapshot. MODEL-MARKET GAP = CPC YES SCORE minus YES midpoint; it is not an edge and never enters any decision.');
  lines.push(`model_rows_sha256: ${snapshotAttachment.model_hash_before}`);
  lines.push(`model_hash_unchanged_after_quote_attachment: ${snapshotAttachment.hash_unchanged}`);
  for (const term of ranked) {
    const snapshot = term.market_snapshot ?? {};
    const value = (v) => v === null || v === undefined ? 'UNAVAILABLE' : String(v);
    lines.push(`- ${term.market_ticker ?? 'UNAVAILABLE'} | yes_bid_cents=${value(snapshot.yes_bid_cents)} | yes_ask_cents=${value(snapshot.yes_ask_cents)} | yes_midpoint_cents=${value(snapshot.yes_midpoint_cents)} | spread_cents=${value(snapshot.bid_ask_spread_cents)} | snapshot_utc=${value(snapshot.market_snapshot_utc)} | snapshot_central=${value(snapshot.market_snapshot_central)} | MODEL-MARKET GAP=${value(snapshot.model_market_gap_points)} | quote_status=${snapshot.quote_status ?? 'UNAVAILABLE'}`);
  }
  lines.push('');

  lines.push('---');
  lines.push(`renderer_contract: ${CUSTOMER_PACKET_CONTRACT_V2}`);
  lines.push('Research only. No trades. Price context is display-only and never a score input.');
  return lines.join('\n');
}

// Render-time invariants, enforced by code (never a model).
export function validateRenderedPacket(text, input) {
  const identity = input?.canonical_event ?? input?.presentation?.canonical_event;
  if (identity) {
    const identityCheck = validateCanonicalMentionIdentity(identity);
    if (!identityCheck.ok) throw new Error(`rendered packet identity gate failed: ${identityCheck.source_gaps.join('; ')}`);
    const routeCheck = validateMentionPacketIntegrity({
      identity,
      packetText: text,
      route: input?.research_provenance?.research_route ?? null,
      allowedTerms: (input?.terms ?? []).map((term) => term?.full_strike_text),
    });
    if (!routeCheck.ok) throw new Error(`rendered packet isolation gate failed: ${routeCheck.source_gaps.join('; ')}`);
  }
  let lastIdx = -1;
  for (const section of SECTION_ORDER) {
    const idx = text.indexOf(`\n${section}\n`) >= 0 ? text.indexOf(`\n${section}\n`) : text.indexOf(section);
    if (idx < 0) throw new Error(`rendered packet missing section "${section}"`);
    if (idx < lastIdx) throw new Error(`rendered packet section out of order: "${section}"`);
    lastIdx = idx;
  }
  if (!/research only/i.test(text)) throw new Error('rendered packet omitted research-only footer');
  if (!text.includes(`renderer_contract: ${CUSTOMER_PACKET_CONTRACT_V2}`)) {
    throw new Error(`rendered packet omitted ${CUSTOMER_PACKET_CONTRACT_V2} contract marker`);
  }
  for (const term of (input?.terms ?? [])) {
    const score = term?.cpc_score;
    const researchGap = term?.bucket === 'blocked/no-source'
      || term?.research_state === 'research gap'
      || term?.evidence_status === 'research gap';
    if (!researchGap && score !== null && score !== undefined && Number.isFinite(Number(score))) {
      const marker = `CPC YES SCORE: ${Math.round(Number(score))}/100`;
      if (!text.includes(marker)) throw new Error(`rendered packet omitted final score marker for ${term?.short_term ?? term?.full_strike_text}`);
    }
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
  const inputTerms = Array.isArray(input?.terms) ? input.terms : [];
  const contentTerms = inputTerms.filter((term) => !isQualificationRisk(term));
  const qualificationTerms = inputTerms.filter(isQualificationRisk);
  for (const term of contentTerms) {
    const label = String(term?.full_strike_text ?? term?.short_term ?? term?._short ?? '').trim();
    if (label && !text.includes(label)) throw new Error(`rendered packet omitted short strike text: ${label}`);
  }
  const inventoryBlock = text.split('8. FULL STRIKE INVENTORY')[1] ?? '';
  for (const term of qualificationTerms) {
    const label = String(term?.short_term ?? term?._short ?? shortTerm(term?.full_strike_text, input?.event?.title)).trim();
    if (label && inventoryBlock.includes(label)) throw new Error(`rendered packet leaked EDNQ term into full strike inventory: ${label}`);
  }
  if (qualificationTerms.length && !/6\. QUALIFICATION RESULT \/ EDNQ RISK/.test(text)) {
    throw new Error('rendered packet omitted EDNQ qualification section');
  }
  return true;
}
