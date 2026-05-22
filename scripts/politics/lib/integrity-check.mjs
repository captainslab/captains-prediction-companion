// Cross-branch integrity checks. Run AFTER schema validation, BEFORE render.
//
// Errors (return ok=false):
//   - judgment.citations[*].branch must exist in merged JSON and resolve to a
//     non-empty branch (i.e., the judgment cannot cite a branch that was
//     never produced).
//
// Warnings (return ok=true with warnings populated):
//   - official.facts[*].source whose classification is X_SOCIAL or UNKNOWN.
//     These belong in xSignal, not official. Surfacing them prevents X
//     chatter from being silently promoted to "verified fact".
//
// Pure, dependency-free. Tested in test/politics-market-swarm.test.mjs.

import { classifySource, TIERS } from './source-classifier.mjs';

const CITABLE_BRANCHES = new Set([
  'settlement', 'official', 'xSignal', 'marketStructure', 'plausibility', 'skeptic',
]);

function branchHasContent(merged, key) {
  const v = merged?.[key];
  if (v === undefined || v === null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return Boolean(v);
}

export function crossCheckBranches(merged) {
  const errors = [];
  const warnings = [];

  // --- judgment.citations integrity ---
  const cites = Array.isArray(merged?.judgment?.citations) ? merged.judgment.citations : [];
  for (let i = 0; i < cites.length; i++) {
    const c = cites[i];
    const b = c?.branch;
    if (!b || typeof b !== 'string') {
      errors.push(`judgment.citations[${i}]: missing branch field`);
      continue;
    }
    if (!CITABLE_BRANCHES.has(b)) {
      errors.push(`judgment.citations[${i}]: unknown branch "${b}" (allowed: ${[...CITABLE_BRANCHES].join(', ')})`);
      continue;
    }
    if (!branchHasContent(merged, b)) {
      errors.push(`judgment.citations[${i}]: branch "${b}" is empty/missing in merged JSON — judgment cannot cite an absent branch`);
    }
  }

  // --- official.facts source-tier guard ---
  const facts = Array.isArray(merged?.official?.facts) ? merged.official.facts : [];
  for (let i = 0; i < facts.length; i++) {
    const f = facts[i];
    const tier = classifySource(f?.source).tier;
    if (tier === TIERS.X_SOCIAL) {
      warnings.push(`official.facts[${i}]: source is X_SOCIAL ("${f.source}") — move to xSignal.narratives, not official`);
    } else if (tier === TIERS.UNKNOWN && f?.verified === true) {
      warnings.push(`official.facts[${i}]: source classifies as UNKNOWN ("${f.source ?? ''}") but is marked verified=true — verify or downgrade`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export const __CITABLE_BRANCHES__ = CITABLE_BRANCHES;
