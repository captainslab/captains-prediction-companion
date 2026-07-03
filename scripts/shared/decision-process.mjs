// Shared market research decision-process layer.
// Pure helpers only: no I/O, no network, no credentials, no trading.

export const MARKET_TYPES = Object.freeze({
  SPORTS_GAME: 'sports_game',
  PLAYER_PROP: 'player_prop',
  MENTION_MARKET: 'mention_market',
  POLITICS_PERSONNEL: 'politics_personnel',
  ELECTION: 'election',
  AI_NEWS: 'ai_news',
  EARNINGS_COMPANY: 'earnings_company',
  GENERIC_EVENT: 'generic_event',
});

export const DECISION_STATUSES = Object.freeze({
  NO_CLEAR_PICK: 'NO CLEAR PICK',
  WATCH: 'WATCH',
  MARKET_ONLY_LEAN: 'MARKET-ONLY LEAN',
  EVIDENCE_LEAN: 'EVIDENCE LEAN',
  STRONG_EVIDENCE_LEAN: 'STRONG EVIDENCE LEAN',
});

const CHECKLISTS = Object.freeze({
  [MARKET_TYPES.SPORTS_GAME]: Object.freeze([
    ['projected_participants', 'Projected starters/participants'],
    ['lineup_injury_news', 'Lineup/injury/news context when applicable'],
    ['venue_context', 'Weather/venue/park/context when applicable'],
    ['recent_form_matchup', 'Recent form or matchup context'],
    ['market_board_context', 'Market board context'],
    ['evidence_supported_side', 'Final reason side is evidence-supported beyond price'],
  ]),
  [MARKET_TYPES.PLAYER_PROP]: Object.freeze([
    ['player_role_usage_projection', 'Player role/usage/projection'],
    ['opponent_matchup', 'Opponent matchup'],
    ['recent_performance', 'Recent performance'],
    ['injury_status_news', 'Injury/status/news'],
    ['line_ladder_comparison', 'Line/ladder comparison'],
    ['prop_supported_beyond_ladder', 'Reason prop is supported beyond ladder shape'],
  ]),
  [MARKET_TYPES.MENTION_MARKET]: Object.freeze([
    ['exact_settlement_wording', 'Exact settlement wording'],
    ['likely_event_source', 'Likely event/transcript/source where mention would occur'],
    ['word_matching_rules_aliases', 'Word-matching rules and aliases'],
    ['recent_public_statements', 'Recent public statements or agenda context'],
    ['official_schedule_event', 'Official schedule or event evidence'],
    ['x_chatter_separated', 'X chatter separated as signal only'],
    ['market_board_context', 'Market board context'],
  ]),
  [MARKET_TYPES.POLITICS_PERSONNEL]: Object.freeze([
    ['settlement_rule_fit', 'Settlement-rule fit'],
    ['official_evidence', 'Official evidence'],
    ['credible_reporting', 'Credible reporting'],
    ['institutional_procedural_path', 'Institutional/procedural path'],
    ['political_plausibility', 'Political plausibility'],
    ['skeptic_case', 'Skeptic case'],
    ['x_chatter_separated', 'X chatter separated as signal only'],
    ['market_board_context', 'Market board context'],
  ]),
  [MARKET_TYPES.ELECTION]: Object.freeze([
    ['settlement_rule_fit', 'Settlement-rule fit'],
    ['official_evidence', 'Official evidence'],
    ['credible_reporting', 'Credible reporting'],
    ['institutional_procedural_path', 'Institutional/procedural path'],
    ['political_plausibility', 'Political plausibility'],
    ['skeptic_case', 'Skeptic case'],
    ['x_chatter_separated', 'X chatter separated as signal only'],
    ['market_board_context', 'Market board context'],
  ]),
  [MARKET_TYPES.AI_NEWS]: Object.freeze([
    ['settlement_criteria', 'Settlement criteria'],
    ['official_company_product_evidence', 'Official company/product evidence'],
    ['credible_technical_reporting', 'Credible technical or reporting sources'],
    ['timeline_fit', 'Timeline fit'],
    ['conflicting_evidence', 'Conflicting evidence'],
    ['uncertainty_triggers', 'Uncertainty triggers'],
    ['market_board_context', 'Market board context'],
  ]),
  [MARKET_TYPES.EARNINGS_COMPANY]: Object.freeze([
    ['settlement_criteria', 'Settlement criteria'],
    ['official_filings_calendar', 'Official company filings or event calendar'],
    ['earnings_transcript_guidance', 'Earnings call / transcript / guidance context'],
    ['analyst_expectations_context_only', 'Analyst/market expectations as context only'],
    ['timeline_source_reliability', 'Timeline and source reliability'],
    ['skeptic_case', 'Skeptic case'],
    ['market_board_context', 'Market board context'],
  ]),
  [MARKET_TYPES.GENERIC_EVENT]: Object.freeze([
    ['settlement_criteria', 'Settlement criteria'],
    ['verified_facts', 'Verified facts'],
    ['credible_sources', 'Credible sources'],
    ['timeline_fit', 'Timeline fit'],
    ['skeptic_case', 'Skeptic case'],
    ['market_board_context', 'Market board context'],
  ]),
});

const HARD_SETTLEMENT_TYPES = new Set([
  MARKET_TYPES.MENTION_MARKET,
  MARKET_TYPES.POLITICS_PERSONNEL,
  MARKET_TYPES.ELECTION,
]);

const MARKET_ONLY_ITEMS = new Set([
  'market_board_context',
  'line_ladder_comparison',
]);

const DECISION_STATUS_DISPLAY = Object.freeze({
  [DECISION_STATUSES.NO_CLEAR_PICK]: 'no rated view',
  [DECISION_STATUSES.WATCH]: 'monitor only',
  [DECISION_STATUSES.MARKET_ONLY_LEAN]: 'market signal only',
  [DECISION_STATUSES.EVIDENCE_LEAN]: 'higher-rated model view',
  [DECISION_STATUSES.STRONG_EVIDENCE_LEAN]: 'top-rated model view',
});

function normalizeText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function includesAny(text, patterns) {
  return patterns.some((rx) => rx.test(text));
}

export function classifyMarketType(input = {}) {
  const explicit = typeof input === 'string' ? null : input.marketType;
  if (explicit && CHECKLISTS[explicit]) return explicit;

  const text = normalizeText(input).toLowerCase();
  const series = String(input?.series_ticker ?? input?.series ?? '').toUpperCase();
  const ticker = String(input?.event_ticker ?? input?.ticker ?? input?.id ?? '').toUpperCase();

  if (/KXMLB(HR|KS)\b/.test(series) || /KXMLB(HR|KS)-/.test(ticker)) return MARKET_TYPES.PLAYER_PROP;
  if (/KXMLB(GAME|SPREAD|TOTAL|RFI)\b/.test(series) || /KXMLB(GAME|SPREAD|TOTAL|RFI)-/.test(ticker)) return MARKET_TYPES.SPORTS_GAME;
  if (/KXUFCFIGHT|KXNASCARRACE/.test(series) || /KXUFCFIGHT-|KXNASCARRACE-/.test(ticker)) return MARKET_TYPES.SPORTS_GAME;

  if (includesAny(text, [/\bmention(s|ed)?\b/, /\bexact[- ]string\b/, /\btranscript\b/, /\bsay(s|ing)?\b/])) {
    return MARKET_TYPES.MENTION_MARKET;
  }
  if (includesAny(text, [/\bnext\s+(attorney general|ag|secretary|chair|director|administrator|nominee)\b/, /\bcabinet\b/, /\bconfirmed\b/, /\bpersonnel\b/, /\bappointment\b/])) {
    return MARKET_TYPES.POLITICS_PERSONNEL;
  }
  if (includesAny(text, [/\belection\b/, /\bpresident\b/, /\bsenate\b/, /\bhouse\b/, /\bgovernor\b/, /\bmayor\b/, /\bparty\b/, /\bseat(s)?\b/])) {
    return MARKET_TYPES.ELECTION;
  }
  if (includesAny(text, [/\bopenai\b/, /\banthropic\b/, /\bai\b/, /\bgpt\b/, /\bmodel\b/, /\bproduct launch\b/, /\brelease\b/])) {
    return MARKET_TYPES.AI_NEWS;
  }
  if (includesAny(text, [/\bearnings\b/, /\beps\b/, /\brevenue\b/, /\bguidance\b/, /\b10-q\b/, /\b10-k\b/, /\bcompany filing\b/])) {
    return MARKET_TYPES.EARNINGS_COMPANY;
  }
  return MARKET_TYPES.GENERIC_EVENT;
}

export function getRequiredChecklist(marketType) {
  return CHECKLISTS[marketType] ?? CHECKLISTS[MARKET_TYPES.GENERIC_EVENT];
}

function checkedSetFrom(input) {
  if (Array.isArray(input)) return new Set(input);
  if (!input || typeof input !== 'object') return new Set();
  return new Set(Object.entries(input).filter(([, v]) => Boolean(v)).map(([k]) => k));
}

function hasEvidenceBeyondMarket(checked) {
  for (const item of checked) {
    if (!MARKET_ONLY_ITEMS.has(item)) return true;
  }
  return false;
}

function settlementItemFor(marketType) {
  if (marketType === MARKET_TYPES.MENTION_MARKET) return 'exact_settlement_wording';
  if (marketType === MARKET_TYPES.POLITICS_PERSONNEL || marketType === MARKET_TYPES.ELECTION) return 'settlement_rule_fit';
  return null;
}

export function describeDecisionStatus(status) {
  return DECISION_STATUS_DISPLAY[status] ?? 'no rated view';
}

function completeEnoughForEvidenceLean(marketType, checked, missing) {
  if (!hasEvidenceBeyondMarket(checked)) return false;
  if (HARD_SETTLEMENT_TYPES.has(marketType)) {
    const settlementItem = settlementItemFor(marketType);
    if (settlementItem && !checked.has(settlementItem)) return false;
  }
  if (marketType === MARKET_TYPES.SPORTS_GAME) {
    return checked.has('projected_participants')
      && checked.has('lineup_injury_news')
      && checked.has('venue_context')
      && checked.has('recent_form_matchup')
      && checked.has('market_board_context')
      && checked.has('evidence_supported_side');
  }
  if (marketType === MARKET_TYPES.PLAYER_PROP) {
    return checked.has('player_role_usage_projection')
      && checked.has('opponent_matchup')
      && checked.has('recent_performance')
      && checked.has('injury_status_news')
      && checked.has('line_ladder_comparison')
      && checked.has('prop_supported_beyond_ladder');
  }
  return missing.length === 0;
}

function rawHasLean(rawDecision) {
  return rawDecision === 'CLEAR'
    || rawDecision === 'LEAN'
    || rawDecision === DECISION_STATUSES.MARKET_ONLY_LEAN
    || rawDecision === DECISION_STATUSES.EVIDENCE_LEAN
    || rawDecision === DECISION_STATUSES.STRONG_EVIDENCE_LEAN;
}

export function evaluateDecisionProcess(input = {}) {
  const marketType = input.marketType && CHECKLISTS[input.marketType]
    ? input.marketType
    : classifyMarketType(input);
  const checklist = getRequiredChecklist(marketType);
  const checked = checkedSetFrom(input.checked);
  const checkedItems = checklist.filter(([id]) => checked.has(id)).map(([id, label]) => ({ id, label }));
  const missingItems = checklist.filter(([id]) => !checked.has(id)).map(([id, label]) => ({ id, label }));
  const missing = missingItems.map((x) => x.label);
  const rawDecision = input.rawDecision ?? input.decision ?? null;
  const hasMarketSignal = input.hasMarketSignal ?? input.marketSignal ?? rawHasLean(rawDecision);
  const hardSettlementItem = settlementItemFor(marketType);
  const settlementMissing = hardSettlementItem ? !checked.has(hardSettlementItem) : false;
  const evidenceReady = completeEnoughForEvidenceLean(marketType, checked, missingItems);
  const strongReady = evidenceReady && Boolean(input.skepticReviewPassed ?? input.strongEvidence ?? input.allLayersAgree);

  let decisionStatus = DECISION_STATUSES.NO_CLEAR_PICK;
  if (rawDecision === DECISION_STATUSES.NO_CLEAR_PICK || rawDecision === 'NO CLEAR PICK' || rawDecision === 'PASS') {
    decisionStatus = DECISION_STATUSES.NO_CLEAR_PICK;
  } else if (settlementMissing && HARD_SETTLEMENT_TYPES.has(marketType)) {
    decisionStatus = hasMarketSignal ? DECISION_STATUSES.WATCH : DECISION_STATUSES.NO_CLEAR_PICK;
  } else if (hasMarketSignal && strongReady) {
    decisionStatus = DECISION_STATUSES.STRONG_EVIDENCE_LEAN;
  } else if (hasMarketSignal && evidenceReady) {
    decisionStatus = DECISION_STATUSES.EVIDENCE_LEAN;
  } else if (hasMarketSignal) {
    decisionStatus = DECISION_STATUSES.MARKET_ONLY_LEAN;
  } else if (checked.size > 0 || input.forceWatch) {
    decisionStatus = DECISION_STATUSES.WATCH;
  }

  const topEvidence = input.topEvidence?.filter(Boolean) ?? [];
  const missingEvidence = input.missingEvidence?.filter(Boolean) ?? missing;
  const whyNotPriceOnly = input.whyNotPriceOnly
    ?? (decisionStatus === DECISION_STATUSES.MARKET_ONLY_LEAN
      ? 'It is not an evidence-based pick: the board signal exists, but required real-world or settlement evidence is incomplete.'
      : evidenceReady
        ? 'Market signal is cross-checked against required real-world and settlement evidence.'
        : 'No final pick is claimed because price, liquidity, movement, and ladder shape are insufficient by themselves.');
  const sourceQuality = input.sourceQuality
    ?? (evidenceReady ? 'complete-enough for evidence lean' : 'incomplete; downgrade required');
  const wouldChangeView = input.wouldChangeView?.filter(Boolean) ?? [];

  return {
    marketType,
    decisionStatus,
    rawDecision,
    checklist: checklist.map(([id, label]) => ({ id, label, checked: checked.has(id) })),
    checkedItems,
    missingItems,
    missingEvidence,
    topEvidence,
    sourceQuality,
    whyNotPriceOnly,
    wouldChangeView,
    settlementMissing,
    evidenceReady,
    hasMarketSignal,
    sections: {
      settlementRules: input.settlementRules ?? (settlementMissing ? 'MISSING / not verified' : 'Checked when required'),
      verifiedFacts: input.verifiedFacts ?? 'MISSING / not supplied',
      marketSignal: input.marketSignalText ?? (hasMarketSignal ? 'Market signal present' : 'No actionable market signal'),
      socialChatter: input.socialChatter ?? 'Not used as verified fact',
      inference: input.inference ?? 'Inference withheld unless evidence checklist supports it',
      skepticReview: input.skepticReview ?? (input.skepticReviewPassed ? 'Passed' : 'MISSING / not supplied'),
      finalJudgment: input.finalJudgment ?? decisionStatus,
    },
  };
}

function wrapText(value, fallback = 'MISSING') {
  if (Array.isArray(value)) return value.length ? value.join('; ') : fallback;
  if (value == null || value === '') return fallback;
  return String(value);
}

export function renderDecisionProcess(process, options = {}) {
  const indent = options.indent ?? '';
  const heading = options.heading ?? 'Decision Process';
  const bullet = `${indent}- `;
  const sub = `${indent}  - `;
  const lines = [];
  lines.push(`${indent}${heading}`);
  lines.push(`${bullet}Market type: ${process.marketType}`);
  lines.push(`${bullet}Decision status: ${process.decisionStatus}`);
  lines.push(`${bullet}Required checklist:`);
  for (const item of process.checklist) {
    lines.push(`${sub}[${item.checked ? 'x' : ' '}] ${item.label}`);
  }
  lines.push(`${bullet}Checked items: ${process.checkedItems.length ? process.checkedItems.map((x) => x.label).join('; ') : 'none'}`);
  lines.push(`${bullet}Missing evidence: ${process.missingEvidence.length ? process.missingEvidence.join('; ') : 'none'}`);
  lines.push(`${bullet}Source quality: ${process.sourceQuality}`);
  lines.push(`${bullet}Top evidence: ${wrapText(process.topEvidence, 'none')}`);
  lines.push(`${bullet}Why it is not price-only: ${process.whyNotPriceOnly}`);
  lines.push(`${bullet}What would change the view: ${wrapText(process.wouldChangeView, 'fresh domain evidence or settlement-rule clarification')}`);
  lines.push(`${bullet}Settlement rules: ${wrapText(process.sections.settlementRules)}`);
  lines.push(`${bullet}Verified facts: ${wrapText(process.sections.verifiedFacts)}`);
  lines.push(`${bullet}Market signal: ${wrapText(process.sections.marketSignal)}`);
  lines.push(`${bullet}X/social chatter: ${wrapText(process.sections.socialChatter)}`);
  lines.push(`${bullet}Inference: ${wrapText(process.sections.inference)}`);
  lines.push(`${bullet}Skeptic review: ${wrapText(process.sections.skepticReview)}`);
  lines.push(`${bullet}Final judgment: ${wrapText(process.sections.finalJudgment)}`);
  return lines.join('\n');
}

export function checkedObject(keys = []) {
  return Object.fromEntries(keys.map((k) => [k, true]));
}
