#!/usr/bin/env node
// UFC weekly packet generator. Fridays. One packet per event/card.
// No network. No trades. No order placement. MISSING > invention.

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

const PACKET_TYPE = 'ufc-weekly';

function weekendDates(fridayIso) {
  const d = new Date(`${fridayIso}T00:00:00Z`);
  const fmt = (dt) => dt.toISOString().slice(0, 10);
  return [0, 1, 2].map((off) => {
    const nd = new Date(d);
    nd.setUTCDate(d.getUTCDate() + off);
    return fmt(nd);
  });
}

function locateUfcEvents(stateRoot, dates) {
  const root = resolve(stateRoot, 'ufc');
  if (!existsSync(root)) return [];
  const hits = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try { entries = readdirSync(cur); } catch { continue; }
    for (const e of entries) {
      const p = join(cur, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) {
        if (dates.includes(e)) {
          try {
            for (const f of readdirSync(p)) {
              const fp = join(p, f);
              if (statSync(fp).isFile() && f.endsWith('.json')) hits.push({ date: e, file: fp });
            }
          } catch {}
        } else {
          stack.push(p);
        }
      }
    }
  }
  return hits;
}

function buildEventPacket({ weekendDates, event }) {
  const data = readJsonIfExists(event.file) || {};
  const eventName = data.event_name || data.name || event.file.split('/').pop().replace(/\.json$/, '');
  const fights = data.fights || data.card || [];
  const header = packetHeader({
    title: `Captain UFC — Weekend Event Packet: ${eventName}`,
    date: event.date,
    packetType: PACKET_TYPE,
    sources: [event.file],
  });
  const lines = [];
  lines.push(`event_name: ${eventName}`);
  lines.push(`event_date_utc: ${event.date}`);
  lines.push(`weekend_window_utc: ${weekendDates.join(' .. ')}`);
  lines.push(`venue: ${data.venue || 'MISSING'}`);
  lines.push(`broadcast: ${data.broadcast || 'MISSING'}`);
  lines.push('');
  lines.push('card_overview:');
  lines.push(`  ${data.overview || 'MISSING'}`);
  lines.push('');
  lines.push('fights:');
  if (Array.isArray(fights) && fights.length) {
    for (const f of fights) {
      const a = f.fighter_a || f.a || 'MISSING';
      const b = f.fighter_b || f.b || 'MISSING';
      const weight = f.weight_class || f.weight || 'MISSING';
      const slot = f.slot || f.card_position || 'MISSING';
      lines.push(`  - ${a} vs ${b}  |  weight: ${weight}  |  slot: ${slot}`);
    }
  } else {
    lines.push('  MISSING');
  }
  lines.push('');
  lines.push('market_watch_notes (reference-only, not sportsbook quotes):');
  const notes = data.watch_notes || data.notes || [];
  if (Array.isArray(notes) && notes.length) {
    for (const n of notes) lines.push(`  - ${n}`);
  } else {
    lines.push('  MISSING');
  }
  lines.push('');
  lines.push(`source_status: ${data.source_status || 'reference-only'}`);
  return header + lines.join('\n') + packetFooter();
}

function buildEmptyPacket(date, dates) {
  return (
    packetHeader({
      title: 'Captain UFC — Weekend Event Packet',
      date,
      packetType: PACKET_TYPE,
      sources: [],
    }) +
    [
      'status: MISSING',
      `reason: no UFC event artifacts discovered for weekend window ${dates.join(' .. ')}`,
      'expected_root: state/ufc/<date>/*.json',
      '',
      'posture: PASS (no data)',
    ].join('\n') +
    packetFooter()
  );
}

async function main() {
  const opts = parsePacketArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node scripts/packets/generate-ufc-weekly.mjs --date YYYY-MM-DD [--dry-run]');
    return;
  }
  const dir = ensurePacketDir(opts.stateRoot, opts.date, PACKET_TYPE);
  const dates = weekendDates(opts.date);
  const events = locateUfcEvents(opts.stateRoot, dates);
  const items = [];
  if (!events.length) {
    const txt = buildEmptyPacket(opts.date, dates);
    const w = writeAudit(dir, `${opts.date}-no-events`, txt, { event_count: 0, weekend_dates: dates });
    items.push({ name: 'no-events', ...w });
  } else {
    for (const ev of events) {
      const baseName = `${ev.date}-${ev.file.split('/').pop().replace(/\.json$/, '')}`;
      const txt = buildEventPacket({ weekendDates: dates, event: ev });
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
