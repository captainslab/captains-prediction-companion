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

  return { valid: errors.length === 0, errors };
}

export function assertCpcPacketValid(text, label = 'packet') {
  const result = validateCpcCustomerPacket(text);
  if (!result.valid) {
    throw new Error(`CPC contract violation in ${label}: ${result.errors.join('; ')}`);
  }
  return true;
}
