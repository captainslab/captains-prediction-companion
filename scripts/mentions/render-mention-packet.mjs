// Deterministic CPC mentions packet renderer.
//
// renderMentionPacket() is the ONLY writer of the final user-facing .txt.
// Models never produce layout — they contribute optional strict-JSON fields
// (analyst narrative, red-team flags) that are validated upstream and slotted
// into fixed sections here. Same input always renders the same text.
//
// Fixed section order (never reordered):
//   1 FAST READ
//   2 CPC COMPOSITE BOARD
//   3 TOP WATCH TERMS
//   4 LOW-SOURCE / TRAP WATCH
//   5 MARKET CONTEXT - NOT IN SCORE
//   6 SOURCE GAPS
//   7 UPGRADE / DOWNGRADE TRIGGERS
//   8 FINAL CPC READ
//
// Market price/liquidity is display-only context (section 5 + board column),
// never a score input. All user-facing times are America/Chicago.

export const SECTION_ORDER = Object.freeze([
  '1. FAST READ',
  '2. CPC COMPOSITE BOARD',
  '3. TOP WATCH TERMS',
  '4. LOW-SOURCE / TRAP WATCH',
  '5. MARKET CONTEXT - NOT IN SCORE',
  '6. SOURCE GAPS',
  '7. UPGRADE / DOWNGRADE TRIGGERS',
  '8. FINAL CPC READ',
]);

const CENTRAL_TZ = 'America/Chicago';

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
  const status = String(term.evidence_status ?? '');
  if (term.bucket === 'blocked/no-source') return 'blocked/no-source';
  if (/proximity scaffold only/i.test(status)) return 'proximity-only';
  const layers = (Array.isArray(term.layers_present) ? term.layers_present : [])
    .filter((l) => !/^\d+\/\d+$/.test(String(l)));
  if (layers.length) return layers.join('+').slice(0, 28);
  const m = status.match(/source evidence present:\s*(.+)/i);
  if (m) return m[1].split(',').map((x) => x.trim()).filter(Boolean).join('+').slice(0, 28);
  const coverage = (Array.isArray(term.layers_present) ? term.layers_present : []).find((l) => /^\d+\/\d+$/.test(String(l)));
  return coverage ? `${coverage} layers` : 'unsourced';
}

function marketCell(term) {
  const mc = term.market_context ?? {};
  return `${cents(mc.bid_cents)}/${cents(mc.ask_cents)} ctx-only`;
}

// Schedule-only evidence must never read like real conviction. Proximity-only
// rows display "scaffold" in the CPC column (raw layer score withheld) so a
// confirmed schedule alone cannot masquerade as a 98-point edge.
function isProximityOnly(term) {
  return sourceLabel(term) === 'proximity-only';
}

function cpcCell(term) {
  if (term.bucket === 'blocked/no-source') return 'n/a';
  if (isProximityOnly(term)) return 'scaffold';
  return maybe(term.cpc_score, 'n/a');
}

const POSTURE_RANK = Object.freeze({ NO_CLEAR_PICK: 0, WATCH: 1, LEAN: 2, EVIDENCE_LEAN: 3, PICK: 4 });

// Post-cap best posture: derived from the rendered rows' final postures
// (already WATCH-capped for proximity-only/stub terms), never from the raw
// pre-cap composite summary.
export function postCapBestPosture(terms) {
  let best = 'NO_CLEAR_PICK';
  for (const t of terms ?? []) {
    const p = String(t.composite_posture ?? 'NO_CLEAR_PICK');
    if ((POSTURE_RANK[p] ?? 0) > (POSTURE_RANK[best] ?? 0)) best = p;
  }
  return best;
}

// Stable ranking: source-backed terms first (CPC desc), then proximity-only
// scaffolds, then blocked/no-source. Within a group: score desc, term asc.
// Pure on input — schedule-only evidence can never outrank real evidence.
function rankGroup(term) {
  if (term.bucket === 'blocked/no-source') return 2;
  if (isProximityOnly(term)) return 1;
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
  const proximityOnly = Boolean(input.synthesis_rules?.all_terms_proximity_only);

  const lines = [];
  lines.push(`=== Captain Mentions — CPC Packet: ${maybe(e.title)} ===`);
  lines.push(`event_time_central: ${formatCentral(e.date_time)}`);
  lines.push(`date: ${maybe(input.date)}`);
  if (generatedAtUtc) lines.push(`generated_utc: ${generatedAtUtc}`);
  lines.push(`settlement_source: ${maybe(e.settlement_source_link)}`);
  lines.push(`analyst_tier: ${analystTier}`);
  lines.push('');

  // 1 FAST READ — posture from post-cap rendered rows, never the raw
  // pre-cap composite summary (a proximity-only board must read WATCH).
  const bestPosture = postCapBestPosture(ranked);
  lines.push('1. FAST READ');
  if (proximityOnly) lines.push('proximity scaffold only -- no pick.');
  lines.push(a.fast_read || `${summary.source_backed_count ?? 0}/${summary.market_count ?? ranked.length} term(s) carry source evidence beyond event proximity; best posture ${bestPosture} (post-cap). Research only — no trade.`);
  lines.push('');

  // 2 CPC COMPOSITE BOARD
  lines.push('2. CPC COMPOSITE BOARD');
  const widths = [4, 22, 9, 13, 18, 22, 22, 18];
  lines.push(tableRow(['Rank', 'Term', 'CPC', 'Posture', 'Source', 'Catalyst', 'Settlement Fit', 'Market Context'], widths));
  lines.push(tableRow(widths.map((w) => '-'.repeat(w)), widths));
  ranked.forEach((t, i) => {
    const note = notes[t._short] ?? {};
    lines.push(tableRow([
      String(i + 1),
      t._short,
      cpcCell(t),
      maybe(t.composite_posture, 'NO_CLEAR_PICK'),
      sourceLabel(t),
      note.catalyst ?? 'MISSING',
      note.settlement_fit ?? 'MISSING',
      marketCell(t),
    ], widths));
  });
  lines.push('note: CPC score is source-layer conviction only. "scaffold" = schedule-only evidence (raw proximity score withheld; not an edge). Market Context column is display-only and NEVER a score input.');
  lines.push('');

  // 3 TOP WATCH TERMS
  lines.push('3. TOP WATCH TERMS');
  const top = ranked.filter((t) => t.bucket !== 'blocked/no-source').slice(0, 5);
  if (top.length) {
    for (const t of top) lines.push(`- ${t._short}: ${maybe(t.evidence_status, 'no evidence status')}`);
  } else {
    lines.push('- none (all terms blocked on missing source layers)');
  }
  lines.push('');

  // 4 LOW-SOURCE / TRAP WATCH
  lines.push('4. LOW-SOURCE / TRAP WATCH');
  const low = ranked.filter((t) => t.bucket === 'blocked/no-source' || sourceLabel(t) === 'proximity-only');
  if (low.length) {
    for (const t of low) {
      const trap = notes[t._short]?.trap_risk ?? redteam?.trap_flags?.[t._short] ?? null;
      lines.push(`- ${t._short}: ${sourceLabel(t)}${trap ? ` | trap: ${trap}` : ''}`);
    }
  } else {
    lines.push('- none');
  }
  if (redteam?.narrative_risks?.length) {
    lines.push('red-team narrative flags (advisory only, never re-scores):');
    for (const risk of redteam.narrative_risks) lines.push(`- ${risk}`);
  }
  const xHeat = Object.entries(redteam?.x_narrative_heat ?? {});
  if (xHeat.length) {
    lines.push('X narrative heat (social context only — never source evidence, never a score input):');
    for (const [term, note] of xHeat) lines.push(`- ${term}: ${note}`);
  }
  lines.push('');

  // 5 MARKET CONTEXT - NOT IN SCORE
  lines.push('5. MARKET CONTEXT - NOT IN SCORE');
  lines.push('Kalshi price/liquidity shown for validation only; excluded from all CPC scoring inputs.');
  for (const t of ranked) {
    const mc = t.market_context ?? {};
    lines.push(`- ${t._short}: bid=${cents(mc.bid_cents)} ask=${cents(mc.ask_cents)} implied=${maybe(mc.implied, '-')}`);
  }
  lines.push('');

  // 6 SOURCE GAPS
  lines.push('6. SOURCE GAPS');
  const gaps = (a.source_gaps?.length ? a.source_gaps : null) ?? deterministicSourceGaps(ranked);
  for (const g of gaps) lines.push(`- ${g}`);
  lines.push('');

  // 7 UPGRADE / DOWNGRADE TRIGGERS
  lines.push('7. UPGRADE / DOWNGRADE TRIGGERS');
  const ups = (a.upgrade_triggers?.length ? a.upgrade_triggers : null) ?? deterministicUpgradeTriggers(ranked);
  for (const u of ups) lines.push(`- upgrade: ${u}`);
  const downs = a.downgrade_triggers?.length ? a.downgrade_triggers : ['settlement wording drifts from listed strike text', 'event schedule slips past close time'];
  for (const d of downs) lines.push(`- downgrade: ${d}`);
  lines.push('');

  // 8 FINAL CPC READ
  lines.push('8. FINAL CPC READ');
  lines.push(a.final_read || (proximityOnly
    ? 'proximity scaffold only -- no pick. No source-backed edge; watch for transcript/quote/history layers before any posture upgrade.'
    : `Best posture ${bestPosture} (post-cap) on the board above. No trade is implied; scores are research conviction only.`));
  lines.push('');

  // Local completeness appendix: every contract's exact strike text, compact.
  lines.push('--- Full Strike Inventory (exact strike text, every contract) ---');
  for (const t of ranked) lines.push(`- ${maybe(t.full_strike_text)}`);

  lines.push('');
  lines.push('---');
  lines.push('Research only. No trades. No bankroll advice. Market context is never a score input.');
  return lines.join('\n');
}

function deterministicSourceGaps(ranked) {
  const gaps = [];
  for (const t of ranked) {
    const missing = Array.isArray(t.missing_research_layers) ? t.missing_research_layers : [];
    if (missing.length) gaps.push(`${t._short}: missing ${missing.join(', ')}`);
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
  return true;
}
