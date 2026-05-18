#!/usr/bin/env node
// MLB pre-lock report generator for one report window (one cluster).
// Inputs: state/mlb/<DATE>/slate-run-plan.json + a target cluster id (or
// the next-due cluster). Writes one text report + meta and (optionally)
// updates the plan to mark the window emitted with its idempotency key.
//
// No trades. No bankroll. No Telegram send by default. --send-telegram is
// reserved for a later wiring; for now it's a no-op stub that errors out.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MLB_SERIES, discoverAllSeries, joinGames } from './lib/series-discovery.mjs';
import { renderGameSection } from './lib/report-render.mjs';

function parseArgs(argv) {
  const opts = {
    date: null, stateRoot: 'state', cluster: null, dryRun: true,
    refresh: true, sendTelegram: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--date') opts.date = argv[++i];
    else if (a === '--state-root') opts.stateRoot = argv[++i];
    else if (a === '--cluster') opts.cluster = argv[++i];
    else if (a === '--no-refresh') opts.refresh = false;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--send-telegram') opts.sendTelegram = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!opts.date) opts.date = new Date().toISOString().slice(0, 10);
  return opts;
}

export function loadPlan(stateRoot, date) {
  const path = resolve(stateRoot, 'mlb', date, 'slate-run-plan.json');
  if (!existsSync(path)) throw new Error(`No slate plan at ${path}. Run slate-check first.`);
  return { path, plan: JSON.parse(readFileSync(path, 'utf8')) };
}

export function pickWindow(plan, clusterId) {
  if (clusterId) {
    const w = plan.report_windows.find((x) => x.cluster_id === clusterId);
    if (!w) throw new Error(`Cluster ${clusterId} not in plan. Available: ${plan.report_windows.map((x) => x.cluster_id).join(', ')}`);
    return w;
  }
  const now = Date.now();
  const pending = plan.report_windows.filter((w) => w.status !== 'sent');
  if (!pending.length) throw new Error('No pending windows in plan.');
  pending.sort((a, b) => Math.abs(Date.parse(a.report_at_utc) - now) - Math.abs(Date.parse(b.report_at_utc) - now));
  return pending[0];
}

async function gatherWindowGames(date, gameKeys, options = {}) {
  // Re-fetch live markets so the report is fresh (UNLESS --no-refresh).
  if (options.useCache && options.cachedGames) {
    const set = new Set(gameKeys);
    return options.cachedGames.filter((g) => set.has(g.game_key));
  }
  const series = await discoverAllSeries(date);
  const games = joinGames(series);
  const set = new Set(gameKeys);
  return games.filter((g) => set.has(g.game_key));
}

export function buildReportText({ plan, window: win, games }) {
  const sections = games.map((g) => ({ game: g, ...renderGameSection(g) }));
  const clearLeanItems = [];
  for (const s of sections) {
    if (s.analysis.clear_lean_count > 0) {
      clearLeanItems.push({
        matchup: `${s.game.away_full || s.game.away} at ${s.game.home_full || s.game.home}`,
        final: s.analysis.final,
        sections: s.analysis.sections,
      });
    }
  }
  const hasPicks = clearLeanItems.length > 0;
  const title = hasPicks
    ? '=== Captain MLB — Pre-Lock Pick Report ==='
    : '=== Captain MLB — NO CLEAR PICK REPORT — board only ===';
  const lines = [];
  lines.push(title);
  lines.push(`date: ${plan.date}`);
  lines.push(`cluster: ${win.cluster_id}`);
  lines.push(`report_at_ct: ${win.report_at_ct}`);
  lines.push(`lead_first_pitch_ct: ${win.lead_first_pitch_ct}`);
  lines.push(`games_in_window: ${games.length}`);
  lines.push(`game_keys: ${win.game_keys.join(', ')}`);
  lines.push(`idempotency_key: ${win.idempotency_key}`);
  lines.push(`mode: ${hasPicks ? 'PICK_REPORT' : 'BOARD_ONLY'}`);
  lines.push(`clear_lean_count: ${clearLeanItems.reduce((n, x) => n + (x.final.decision === 'CLEAR' || x.final.decision === 'LEAN' ? 1 : 0), 0)}`);
  lines.push(`generated_utc: ${new Date().toISOString()}`);
  lines.push('');
  if (hasPicks) {
    lines.push('--- CLEAR / LEAN SUMMARY ---');
    for (const it of clearLeanItems) {
      lines.push(`- [${it.final.decision}] ${it.matchup}`);
      lines.push(`    ${it.final.reason}`);
    }
    lines.push('');
  } else {
    lines.push('No section across any game produced a market-internal CLEAR or LEAN.');
    lines.push('Board attached for review only — no pick is being claimed.');
    lines.push('');
  }
  for (const s of sections) {
    lines.push(s.text);
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  lines.push('No trades placed. No bankroll sizing. Research only.');
  lines.push('Markets covered per game: ML (KXMLBGAME), Spread (KXMLBSPREAD), Total (KXMLBTOTAL), HR (KXMLBHR), K props (KXMLBKS), YFRI/NFRI (KXMLBRFI).');
  return { text: lines.join('\n'), hasPicks, clearLeanCount: clearLeanItems.length };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node scripts/mlb/pre-lock-report.mjs --date YYYY-MM-DD [--cluster W03] [--state-root state] [--dry-run] [--no-refresh]');
    return;
  }
  if (opts.sendTelegram) {
    console.error('[mlb-pre-lock] --send-telegram is intentionally disabled in this build. Use --dry-run.');
    process.exit(2);
  }
  const { plan, path: planPath } = loadPlan(opts.stateRoot, opts.date);
  const win = pickWindow(plan, opts.cluster);
  const games = await gatherWindowGames(opts.date, win.game_keys, { useCache: !opts.refresh });
  if (!games.length) {
    console.error(`[mlb-pre-lock] no games resolved for window ${win.cluster_id} keys=${win.game_keys.join(',')}`);
    process.exit(2);
  }
  const built = buildReportText({ plan, window: win, games });
  const text = built.text;
  const outDir = resolve(opts.stateRoot, 'mlb', opts.date, 'pre-lock-reports');
  mkdirSync(outDir, { recursive: true });
  const base = `${opts.date}-${win.cluster_id}`;
  const txtPath = resolve(outDir, `${base}.txt`);
  const metaPath = resolve(outDir, `${base}.meta.json`);
  writeFileSync(txtPath, text, 'utf8');
  writeFileSync(metaPath, JSON.stringify({
    schema: 'mlb-pre-lock-report/v1',
    date: opts.date,
    cluster_id: win.cluster_id,
    idempotency_key: win.idempotency_key,
    report_at_utc: win.report_at_utc,
    lead_first_pitch_utc: win.lead_first_pitch_utc,
    game_count: games.length,
    game_keys: win.game_keys,
    char_count: text.length,
    has_picks: built.hasPicks,
    clear_lean_count: built.clearLeanCount,
    mode: built.hasPicks ? 'PICK_REPORT' : 'BOARD_ONLY',
    dry_run: true,
    generated_utc: new Date().toISOString(),
  }, null, 2), 'utf8');
  // Mark plan window as rendered (idempotent: same idempotency_key).
  const planObj = plan;
  for (const w of planObj.report_windows) {
    if (w.cluster_id === win.cluster_id) {
      w.status = 'rendered';
      w.last_rendered_utc = new Date().toISOString();
      w.last_artifact = txtPath;
    }
  }
  writeFileSync(planPath, JSON.stringify(planObj, null, 2), 'utf8');
  console.log(`[mlb-pre-lock] cluster=${win.cluster_id} games=${games.length} chars=${text.length}`);
  console.log(`[mlb-pre-lock] report=${txtPath}`);
  console.log('[mlb-pre-lock] No trades placed. No Telegram send.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`[mlb-pre-lock] error: ${err.message}`);
    process.exit(1);
  });
}
