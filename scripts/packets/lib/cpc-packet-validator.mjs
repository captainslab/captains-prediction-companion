// Shared CPC customer packet contract validator.
// Every outgoing CPC packet type (mentions, MLB, UFC, NASCAR, World Cup)
// must pass this validator or fail closed. No exceptions.
//
// The contract enforces:
//   - "CPC Packet:" in the title/header area
//   - "NOT IN SCORE" market context marker
//   - No raw inventory dump in customer body
//   - No "Rank reflects market implied only" legacy phrase
//   - "Research only" footer
//   - "No trades" statement
//   - Source/provenance line (generated_utc or sources:)
//   - No score=MISSING ranked boards (BLOCKED rows are fine, ranked MISSING is not)

export const CPC_CONTRACT_VERSION = 'cpc_customer_packet_v1';

const DERBY_QUALITY_ORDER = Object.freeze({ F: 0, D: 1, C: 2, B: 3, A: 4 });

const DERBY_EXACT_SECTION_RULES = Object.freeze([
  Object.freeze({ id: 'winner', minimum_quality: 'C', experimental_below_threshold: true, pattern: /^\s*winner probabilities(?:\s+—[^:]*)?:\s*$/i, label: 'winner probabilities' }),
  Object.freeze({ minimum_quality: 'C', allow_labeled_below_threshold: false, pattern: /^\s*round_1_leader probabilities(?:\s+—[^:]*)?:\s*$/i, label: 'Round 1 leader probabilities' }),
  Object.freeze({ minimum_quality: 'C', allow_labeled_below_threshold: false, pattern: /^\s*qualifier probabilities(?:\s+—[^:]*)?:\s*$/i, label: 'qualifier probabilities' }),
  Object.freeze({ minimum_quality: 'C', allow_labeled_below_threshold: false, pattern: /^\s*finals (?:matchup|result) probabilities(?:\s+—[^:]*)?:\s*$/i, label: 'finals probabilities' }),
  Object.freeze({ minimum_quality: 'C', allow_labeled_below_threshold: false, pattern: /^\s*(?:longest-HR|highest-EV) player probabilities(?:\s+—[^:]*)?:\s*$/i, label: 'player outcome probabilities' }),
  Object.freeze({ minimum_quality: 'B', allow_labeled_below_threshold: false, pattern: /^\s*round_1_hr_totals(?:\s+—[^:]*)?:\s*$/i, label: 'Round 1 HR distributions' }),
  Object.freeze({ minimum_quality: 'B', allow_labeled_below_threshold: false, pattern: /^\s*total HRs distribution(?:\s+—[^:]*)?:\s*$/i, label: 'tournament HR distribution' }),
  Object.freeze({ minimum_quality: 'B', allow_labeled_below_threshold: false, pattern: /^\s*500\+ ft HR count distribution(?:\s+—[^:]*)?:\s*$/i, label: '500+ HR distribution' }),
  Object.freeze({ minimum_quality: 'B', allow_labeled_below_threshold: false, pattern: /^\s*(?:distance_ft|player_distance)(?:\s+—[^:]*)?:\s*$/i, label: 'per-foot distance distribution' }),
  Object.freeze({ minimum_quality: 'B', allow_labeled_below_threshold: false, pattern: /^\s*(?:mph|player_mph)(?:\s+—[^:]*)?:\s*$/i, label: 'exact exit-velocity distribution' }),
]);

const DERBY_RAW_EXACT_ROW_RULES = Object.freeze([
  Object.freeze({ minimum_quality: 'B', allow_labeled_below_threshold: false, pattern: /\b\d+(?:\.\d+)?\s*(?:HR|home runs|ft|feet|foot|mph|miles per hour)[.)]?\s*$/i, label: 'exact absolute HR, distance, or exit-velocity value' }),
  Object.freeze({ minimum_quality: 'B', allow_labeled_below_threshold: false, pattern: /^\s*(?:-\s*)?\d+(?:\.\d+)?\s*:\s*.*(?:\bprobability\s*=|"probability"\s*:)/i, label: 'numeric absolute-distribution bin' }),
  Object.freeze({ minimum_quality: 'B', allow_labeled_below_threshold: false, pattern: /^\s*(?:-\s*)?\d+(?:\.\d+)?(?:\s*(?:HR|ft|mph))?\s*:\s*\d+(?:\.\d+)?%\s*$/i, label: 'bare numeric absolute-distribution percent bin' }),
  Object.freeze({ minimum_quality: 'B', allow_labeled_below_threshold: false, pattern: /^\s*(?:-\s*)?[^:\n]{1,120}:\s*\d+(?:\.\d+)?\s*(?:HR|ft|mph)\b/i, label: 'named exact HR, distance, or exit-velocity point row' }),
  Object.freeze({ minimum_quality: 'B', allow_labeled_below_threshold: false, pattern: /^\s*(?:-\s*)?[A-Za-z][^\n]{0,120}(?::|—|-)\s*\d+(?:\.\d+)?\s*(?:HR|ft|mph)\b/i, label: 'renamed exact HR, distance, or exit-velocity point row' }),
  Object.freeze({ minimum_quality: 'B', allow_labeled_below_threshold: false, pattern: /\b(?:expected|projected|forecast|estimated|mean|median)\b[^:\n]*:\s*\d+(?:\.\d+)?\s*(?:HR|ft|mph)\b/i, label: 'exact HR, distance, or exit-velocity point estimate' }),
  Object.freeze({ minimum_quality: 'B', allow_labeled_below_threshold: false, pattern: /\b(?:expectation|expected|projected|forecast|estimated|mean|median)\b[^\n]*\d+(?:\.\d+)?\s*(?:HR|ft|mph)\b/i, label: 'renamed exact HR, distance, or exit-velocity expectation' }),
  Object.freeze({ minimum_quality: 'B', allow_labeled_below_threshold: false, pattern: /\b(?:tournament (?:home run|HR) total|longest(?: home run|-HR| HR)|highest(?: exit velocity|-EV| EV))\b[^:\n]*:\s*\d+(?:\.\d+)?\s*(?:HR|ft|mph)\b/i, label: 'exact named HR, distance, or exit-velocity point output' }),
  Object.freeze({ minimum_quality: 'B', allow_labeled_below_threshold: false, pattern: /^(?=.*(?:500\+|500\s*[- ]?\s*(?:ft|foot|feet)))(?=.*\b\d+(?:\.\d+)?%).*$/i, label: 'exact 500+ home-run probability' }),
  Object.freeze({ minimum_quality: 'B', allow_labeled_below_threshold: false, pattern: /\b\d+(?:\.\d+)?\s*(?:HR|ft|mph)\b.*(?:\bprobability\s*=|\b\d+(?:\.\d+)?%)/i, label: 'raw exact HR, distance, or exit-velocity row' }),
  Object.freeze({ minimum_quality: 'B', allow_labeled_below_threshold: false, pattern: /"(?:round_1_hr_totals|total_home_runs|distance_ft|player_distance|home_runs_500_plus|mph|player_mph)"\s*:/i, label: 'raw exact absolute-output JSON' }),
]);

const DERBY_RAW_PROBABILITY_ROW = /(?:\bprobability\s*=|"probability"\s*:|^\s*(?:-\s*)?[A-Za-z][^\n]{0,120}(?::|—|-|\s)\s*\d+(?:\.\d+)?%\s*$)/i;

function isDerbySectionBoundary(line) {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (/^[A-Z][A-Z0-9 /+—-]+:?$/.test(trimmed)) return true;
  return /^\S.*:\s*$/.test(line);
}

export function validateCpcCustomerPacket(text, options = {}) {
  if (!text || typeof text !== 'string') {
    return { valid: false, errors: ['packet text is empty or not a string'] };
  }
  const errors = [];
  const header = text.slice(0, 600);

  if (!/CPC Packet:/i.test(header)) {
    errors.push('missing "CPC Packet:" in title/header (first 600 chars)');
  }

  if (!/NOT IN SCORE/i.test(text)) {
    errors.push('missing "NOT IN SCORE" market context marker');
  }

  if (/RAW CONTRACT INVENTORY/i.test(text)) {
    errors.push('raw inventory dump leaked into customer packet');
  }

  if (/Rank reflects market implied only/i.test(text)) {
    errors.push('contains legacy phrase "Rank reflects market implied only"');
  }

  if (!/research only/i.test(text)) {
    errors.push('missing "research only" footer');
  }

  if (!/no trades/i.test(text)) {
    errors.push('missing "no trades" statement');
  }

  if (!/generated_utc:|generated:|Generated:/i.test(text)) {
    errors.push('missing source/provenance line (generated_utc or Generated:)');
  }

  const lines = text.split('\n');
  let lastRowStatus = null;
  let blockedMissingCount = 0;
  for (const line of lines) {
    const rowMatch = line.match(/^#\d+\s+\[(\w+)\]/);
    if (rowMatch) lastRowStatus = rowMatch[1];
    if (/score=MISSING/.test(line) && /^\s+model:/.test(line)) {
      if (lastRowStatus && lastRowStatus !== 'BLOCKED') {
        errors.push(`ranked board row [${lastRowStatus}] has score=MISSING`);
      }
      if (lastRowStatus === 'BLOCKED') blockedMissingCount++;
    }
  }
  if (blockedMissingCount > 10) {
    errors.push(`${blockedMissingCount} BLOCKED rows with score=MISSING — use compact event-level block instead`);
  }

  const isDerby = options.product === 'mlb_hr_derby' || /CPC Packet:.*Home Run Derby/i.test(header);
  if (isDerby) {
    const headerClaimsBlocked = /Home Run Derby.*BLOCKED/i.test(header);
    const structurallyBlocked = headerClaimsBlocked && /BLOCKED — NO IMPUTED PROBABILITIES/i.test(text);
    const textQuality = text.match(/^data_quality:\s*([ABCDF])\s*$/mi)?.[1] ?? null;
    const quality = textQuality ?? options.data_quality ?? (structurallyBlocked ? 'F' : null);
    if (options.status === 'blocked' && !structurallyBlocked) {
      errors.push('Home Run Derby validator status=blocked without a structurally blocked packet');
    }
    if (headerClaimsBlocked && !structurallyBlocked) {
      errors.push('Home Run Derby BLOCKED header missing compact no-imputed-probabilities block');
    }
    if (!structurallyBlocked && !textQuality) {
      errors.push('Home Run Derby ready packet must declare data_quality in packet text');
    }
    if (!quality || !(quality in DERBY_QUALITY_ORDER)) {
      errors.push('Home Run Derby packet missing valid data_quality A/B/C/D/F');
    } else {
      if (textQuality && options.data_quality && textQuality !== options.data_quality) {
        errors.push(`Home Run Derby data_quality mismatch: header=${textQuality} validator=${options.data_quality}`);
      }
      let activeExactSection = null;
      for (const line of lines) {
        const sectionRule = DERBY_EXACT_SECTION_RULES.find((rule) => rule.pattern.test(line));
        if (sectionRule) {
          const meetsThreshold = DERBY_QUALITY_ORDER[quality] >= DERBY_QUALITY_ORDER[sectionRule.minimum_quality];
          const experimentalWinner = sectionRule.experimental_below_threshold === true
            && !structurallyBlocked
            && /EXPERIMENTAL/i.test(line);
          const permitted = meetsThreshold || experimentalWinner;
          activeExactSection = { rule: sectionRule, permitted, experimentalWinner };
          if (!permitted) {
            const reason = sectionRule.experimental_below_threshold
              ? 'without an EXPERIMENTAL section label'
              : 'even though the field is suppressed below threshold';
            errors.push(`quality ${quality} Home Run Derby packet exposes ${sectionRule.label} ${reason} (requires ${sectionRule.minimum_quality})`);
          }
          continue;
        }

        if (isDerbySectionBoundary(line)) activeExactSection = null;

        if (DERBY_RAW_PROBABILITY_ROW.test(line)) {
          const exactOutcomesEligible = DERBY_QUALITY_ORDER[quality] >= DERBY_QUALITY_ORDER.C;
          const inEligibleOutcomeSection = activeExactSection?.permitted === true
            && DERBY_QUALITY_ORDER[activeExactSection.rule.minimum_quality] <= DERBY_QUALITY_ORDER.C;
          const inExperimentalWinnerSection = activeExactSection?.rule.id === 'winner'
            && activeExactSection.experimentalWinner === true;
          if (structurallyBlocked
            || (!exactOutcomesEligible && !inExperimentalWinnerSection)
            || (quality === 'C' && !inEligibleOutcomeSection)) {
            errors.push(`quality ${quality} Home Run Derby packet exposes raw exact probability row outside an eligible exact-outcome section (requires C or an EXPERIMENTAL winner section)`);
          }
        }

        for (const rule of DERBY_RAW_EXACT_ROW_RULES) {
          if (DERBY_QUALITY_ORDER[quality] >= DERBY_QUALITY_ORDER[rule.minimum_quality]) continue;
          if (!rule.pattern.test(line)) continue;
          errors.push(`quality ${quality} Home Run Derby packet exposes ${rule.label} (requires ${rule.minimum_quality})`);
        }
      }
    }
    if (!structurallyBlocked && !/Monte Carlo sampling uncertainty/i.test(text)) {
      errors.push('Home Run Derby packet does not distinguish Monte Carlo sampling uncertainty');
    }
    if (!structurallyBlocked && !/Model\/assumption uncertainty/i.test(text)) {
      errors.push('Home Run Derby packet does not distinguish model/assumption uncertainty');
    }
  }

  return { valid: errors.length === 0, errors };
}

export function assertCpcPacketValid(text, label = 'packet', options = {}) {
  const result = validateCpcCustomerPacket(text, options);
  if (!result.valid) {
    throw new Error(`CPC contract violation in ${label}: ${result.errors.join('; ')}`);
  }
  return true;
}
