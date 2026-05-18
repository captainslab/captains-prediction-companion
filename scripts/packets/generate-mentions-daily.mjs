#!/usr/bin/env node
// Mentions daily packet generator.
// One packet per mention event (politician + earnings-call). No trades. No execution.
// Marks MISSING when source data is unavailable instead of inventing.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parsePacketArgs,
  ensurePacketDir,
  writeAudit,
  packetHeader,
  packetFooter,
  printDryRunSummary,
  readJsonIfExists,
} from './lib/common.mjs';

const PACKET_TYPE = 'mentions-daily';

function discoverMentionEvents(stateRoot, date) {
  // Look for upstream research artifacts under conventional locations.
  // The repo has agents/mentions-researcher/ and agents/mentions-mcp-forecaster/.
  // Packet stays source-of-truth-only — never fabricates events.
  const roots = [
    resolve(stateRoot, 'mentions', date),
    resolve(stateRoot, 'mentions', 'events', date),
    resolve('channels', 'mentions', date),
  ];
  const events = [];
  for (const root of roots) {
    if (!existsSync(root) || !statSync(root).isDirectory()) continue;
    for (const entry of readdirSync(root)) {
      const p = join(root, entry);
      try {
        if (!statSync(p).isFile()) continue;
        if (!/\.(json|md)$/i.test(entry)) continue;
        const raw = readFileSync(p, 'utf8');
        let parsed = null;
        if (entry.endsWith('.json')) parsed = readJsonIfExists(p);
        events.push({ file: p, name: entry, body: raw, parsed });
      } catch {}
    }
  }
  return events;
}

function buildEventPacket({ date, event }) {
  const p = event.parsed || {};
  const header = packetHeader({
    title: 'Captain Mentions — Daily Event Packet',
    date,
    packetType: PACKET_TYPE,
    sources: [event.file],
  });
  const lines = [];
  lines.push(`event_id: ${p.event_id || p.id || 'MISSING'}`);
  lines.push(`target_phrase: ${p.target_phrase || p.phrase || 'MISSING'}`);
  lines.push(`speaker_or_company: ${p.speaker || p.company || p.entity || 'MISSING'}`);
  lines.push(`event_context: ${p.context || p.event_context || 'MISSING'}`);
  lines.push('');
  lines.push('resolution_mechanics:');
  lines.push(`  ${p.resolution || p.resolution_mechanics || 'MISSING'}`);
  lines.push('');
  lines.push('source_evidence:');
  const evidence = p.evidence || p.sources || [];
  if (Array.isArray(evidence) && evidence.length) {
    for (const e of evidence) lines.push(`  - ${typeof e === 'string' ? e : JSON.stringify(e)}`);
  } else {
    lines.push('  MISSING');
  }
  lines.push('');
  lines.push(`verified_vs_inference: ${p.verified_vs_inference || 'MISSING'}`);
  lines.push(`posture: ${p.posture || 'PASS (insufficient verified evidence)'}  // WATCH / LEAN / PASS only`);
  lines.push('');
  if (!event.parsed) {
    lines.push('raw_excerpt:');
    lines.push(event.body.slice(0, 600));
    lines.push('');
  }
  return header + lines.join('\n') + packetFooter();
}

function buildEmptyDayPacket(date) {
  return (
    packetHeader({
      title: 'Captain Mentions — Daily Event Packet',
      date,
      packetType: PACKET_TYPE,
      sources: [],
    }) +
    [
      'status: MISSING',
      'reason: no mention-event source artifacts discovered for this date.',
      'expected_roots:',
      '  - state/mentions/<date>/',
      '  - state/mentions/events/<date>/',
      '  - channels/mentions/<date>/',
      '',
      'posture: PASS (no data)',
    ].join('\n') +
    packetFooter()
  );
}

async function main() {
  const opts = parsePacketArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node scripts/packets/generate-mentions-daily.mjs --date YYYY-MM-DD [--dry-run]');
    return;
  }
  const dir = ensurePacketDir(opts.stateRoot, opts.date, PACKET_TYPE);
  const events = discoverMentionEvents(opts.stateRoot, opts.date);
  const items = [];
  if (!events.length) {
    const txt = buildEmptyDayPacket(opts.date);
    const w = writeAudit(dir, `${opts.date}-no-events`, txt, { event_count: 0 });
    items.push({ name: 'no-events', ...w });
  } else {
    for (const ev of events) {
      const baseName = `${opts.date}-${(ev.parsed?.event_id || ev.name).toString()}`;
      const txt = buildEventPacket({ date: opts.date, event: ev });
      const w = writeAudit(dir, baseName, txt, { source_file: ev.file });
      items.push({ name: baseName, ...w });
    }
  }
  console.log(printDryRunSummary({ packetType: PACKET_TYPE, date: opts.date, dir, items }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`[${PACKET_TYPE}] error: ${err.message}`);
    process.exit(1);
  });
}
