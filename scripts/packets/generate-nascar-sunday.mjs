#!/usr/bin/env node
// NASCAR Sunday morning packet generator.
// Uses existing nascar-workspace.mjs fixtures-only path (via child process) if no state present.
// No network calls of our own. No trades. No order placement.

import { execFileSync } from 'node:child_process';
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

const PACKET_TYPE = 'nascar-sunday';

const SUPPORTED_LANES = ['win', 'top3', 'top5', 'top10', 'top20', 'fastest_lap'];

function locateNascarArtifacts(stateRoot, date) {
  const root = resolve(stateRoot, 'nascar');
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
        if (e === date) {
          try {
            for (const f of readdirSync(p)) {
              const fp = join(p, f);
              if (statSync(fp).isFile() && (f.endsWith('.json') || f.endsWith('.md'))) hits.push(fp);
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

function tryRunWorkspaceFixturesOnly(date) {
  // Best-effort invocation. Silently swallow if the workspace can't run.
  try {
    const out = execFileSync(
      process.execPath,
      ['scripts/nascar/nascar-workspace.mjs', '--date', date, '--fixtures-only'],
      { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 },
    );
    return { ok: true, output: out.toString('utf8').slice(0, 2000) };
  } catch (err) {
    return { ok: false, error: (err.stderr?.toString() || err.message || 'unknown').slice(0, 500) };
  }
}

function pickCeilingBoard(artifacts) {
  // Look for a ceiling board JSON; fall back to MISSING.
  for (const fp of artifacts) {
    if (!fp.endsWith('.json')) continue;
    const data = readJsonIfExists(fp);
    if (!data) continue;
    const board = data.ceiling_board || data.ceilings || data.board || null;
    if (Array.isArray(board) && board.length) return { board, source: fp };
    if (board && typeof board === 'object') {
      const arr = Object.entries(board).map(([driver_name, ceiling]) => ({ driver_name, ceiling }));
      if (arr.length) return { board: arr, source: fp };
    }
  }
  return null;
}

function pickEventMeta(artifacts) {
  for (const fp of artifacts) {
    if (!fp.endsWith('.json')) continue;
    const data = readJsonIfExists(fp);
    if (!data) continue;
    if (data.event_name || data.race_name || data.event_format) {
      return {
        race_name: data.race_name || data.event_name || 'MISSING',
        event_format: data.event_format || 'MISSING',
        special_event_override: data.special_event_override || null,
        source: fp,
      };
    }
  }
  return null;
}

function buildPacket({ date, artifacts, workspaceResult }) {
  const header = packetHeader({
    title: 'Captain NASCAR — Sunday Morning Race-Market Packet',
    date,
    packetType: PACKET_TYPE,
    sources: artifacts,
  });
  const meta = pickEventMeta(artifacts);
  const ceiling = pickCeilingBoard(artifacts);
  const lines = [];

  lines.push(`race_name: ${meta?.race_name || 'MISSING'}`);
  lines.push(`event_format: ${meta?.event_format || 'MISSING'}`);
  if (meta?.special_event_override) {
    lines.push(`special_event_override: ${meta.special_event_override}`);
  }
  lines.push('');
  lines.push(`supported_market_lanes: ${SUPPORTED_LANES.join(', ')}`);
  lines.push('candidate_pool_concept: top 20 in current points (when applicable)');
  lines.push('field_bucket_concept: FIELD / longshot bucket aggregates remaining drivers');
  lines.push('');
  lines.push('ceiling_board (format: [driver_name] [ceiling]):');
  if (ceiling && ceiling.board.length) {
    for (const row of ceiling.board) {
      lines.push(`  [${row.driver_name || 'MISSING'}] [${row.ceiling ?? 'MISSING'}]`);
    }
    lines.push(`  source: ${ceiling.source}`);
  } else {
    lines.push('  MISSING');
    if (workspaceResult) {
      lines.push(`  workspace_run_ok: ${workspaceResult.ok}`);
      if (!workspaceResult.ok) lines.push(`  workspace_error: ${workspaceResult.error}`);
    }
  }
  return header + lines.join('\n') + packetFooter();
}

async function main() {
  const opts = parsePacketArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node scripts/packets/generate-nascar-sunday.mjs --date YYYY-MM-DD [--dry-run]');
    return;
  }
  const dir = ensurePacketDir(opts.stateRoot, opts.date, PACKET_TYPE);
  let artifacts = locateNascarArtifacts(opts.stateRoot, opts.date);
  let workspaceResult = null;
  if (!artifacts.length) {
    workspaceResult = tryRunWorkspaceFixturesOnly(opts.date);
    artifacts = locateNascarArtifacts(opts.stateRoot, opts.date);
  }
  const txt = buildPacket({ date: opts.date, artifacts, workspaceResult });
  const w = writeAudit(dir, `${opts.date}-nascar-sunday`, txt, {
    artifact_count: artifacts.length,
    workspace_attempt: workspaceResult,
  });
  console.log(printDryRunSummary({ packetType: PACKET_TYPE, date: opts.date, dir, items: [{ name: 'nascar-sunday', ...w }] }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`[${PACKET_TYPE}] error: ${err.message}`);
    process.exit(1);
  });
}
