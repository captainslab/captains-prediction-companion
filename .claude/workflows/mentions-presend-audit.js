export const meta = {
  name: 'mentions-presend-audit',
  description: 'Audit each rendered mentions packet for invariant violations before send; adversarially verify each finding',
  whenToUse: 'Before sending a day\'s mentions packets — sweeps every packet for price leaks, stale-cache renders, and lexical-gate bypasses, then refutes each finding so only real blockers survive.',
  phases: [
    { title: 'Discover' },
    { title: 'Audit' },
    { title: 'Verify' },
  ],
}

// args: { date: "2026-06-27" }  — the slate to audit (America/Chicago).
// Pass it via the Workflow tool's `args` field as a real JSON object.
const DATE = (args && args.date) || 'today'

// --- Schemas: agents are FORCED to return these shapes (validated at the tool layer) ---
const PACKET_LIST = {
  type: 'object',
  required: ['packets'],
  properties: {
    packets: {
      type: 'array',
      items: {
        type: 'object',
        required: ['event_id', 'packet_path'],
        properties: {
          event_id: { type: 'string' },
          packet_path: { type: 'string' },
        },
      },
    },
  },
}

const FINDINGS = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['event_id', 'kind', 'severity', 'evidence', 'quote'],
        properties: {
          event_id: { type: 'string' },
          kind: { type: 'string', enum: ['price_leak', 'stale_cache', 'lexical_bypass', 'utc_date', 'other'] },
          severity: { type: 'string', enum: ['block', 'warn'] },
          evidence: { type: 'string' },          // file:line
          quote: { type: 'string' },             // the offending text
        },
      },
    },
  },
}

const VERDICT = {
  type: 'object',
  required: ['event_id', 'kind', 'is_real', 'reason'],
  properties: {
    event_id: { type: 'string' },
    kind: { type: 'string' },
    is_real: { type: 'boolean' },
    reason: { type: 'string' },
  },
}

const INVARIANTS = `
INVARIANTS (CPC):
- price_leak: market price/odds/bid/ask/volume/OI/price-movement appears in any
  reasoning, scoring, posture, ranking, or upgrade/downgrade text. Display/log lines are OK.
- stale_cache: packet was rendered from a prior-day cache instead of fresh research this run.
- lexical_bypass: a conviction/PICK survives without the literal-token lexical gate clearing
  (mentions are exact-token events, not topic relevance); or n<2 history but not marked NO_TRADE.
- utc_date: any slate/date logic resolved in UTC instead of America/Chicago.
Quote the exact offending text and give a file:line in evidence.`

// ---------------------------------------------------------------------------
phase('Discover')
const discovered = await agent(
  `List every rendered mentions packet for slate ${DATE}. Look under state/mentions/${DATE}/
   (and per-event subdirs). Return one entry per packet with its event_id and packet_path.
   Read render-mention-packet.mjs only if you need to learn the output path convention.`,
  { label: 'discover-packets', phase: 'Discover', schema: PACKET_LIST }
)

const packets = (discovered && discovered.packets) || []
log(`Discovered ${packets.length} packet(s) for ${DATE}`)
if (!packets.length) return { date: DATE, packets: 0, blockers: [] }

// Pipeline: each packet is audited, and its findings verify as soon as that audit lands.
// No barrier — packet B audits while packet A's findings are already being refuted.
const results = await pipeline(
  packets,
  (p) => agent(
    `Audit this single mentions packet for CPC invariant violations.
     Packet: ${p.packet_path} (event ${p.event_id}).
     ${INVARIANTS}
     Read ONLY this packet (and the renderer/lexical-gate source if you must confirm a rule).
     Return findings (may be empty). Do not edit anything.`,
    { label: `audit:${p.event_id}`, phase: 'Audit', schema: FINDINGS }
  ),
  (audit, p) => parallel(
    ((audit && audit.findings) || []).map((f) => () =>
      agent(
        `Adversarially verify this audit finding. Try to REFUTE it; default to is_real=false
         if the evidence is weak or the quoted text is actually a display/log line.
         Finding: ${JSON.stringify(f)}
         Packet: ${p.packet_path}
         ${INVARIANTS}`,
        { label: `verify:${p.event_id}:${f.kind}`, phase: 'Verify', schema: VERDICT }
      ).then((v) => ({ ...f, ...v }))
    )
  )
)

const confirmed = results
  .flat()
  .filter(Boolean)
  .filter((f) => f.is_real && f.severity === 'block')

log(`Confirmed ${confirmed.length} blocking violation(s)`)
return { date: DATE, packets: packets.length, blockers: confirmed }
