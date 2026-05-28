#!/usr/bin/env node
/**
 * cap — Captains Prediction Companion launcher
 *
 * Wraps install, run, doctor, demo, and code-agent attach in one CLI.
 * Pure stdlib. No new runtime deps.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PID_DIR = resolve(ROOT, '.runtime');
const PID_FILE = resolve(PID_DIR, 'cap.pid');
const LOG_FILE = resolve(PID_DIR, 'cap.log');

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', mag: '\x1b[35m',
};
const say = (s) => process.stdout.write(s + '\n');
const ok = (s) => say(`${C.green}✓${C.reset} ${s}`);
const bad = (s) => say(`${C.red}✗${C.reset} ${s}`);
const note = (s) => say(`${C.dim}${s}${C.reset}`);
const head = (s) => say(`\n${C.bold}${C.cyan}${s}${C.reset}`);

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
}

function port() { return Number(process.env.PORT ?? 3000); }

function ping(path, timeoutMs = 1500) {
  return new Promise((res) => {
    const req = http.get(`http://localhost:${port()}${path}`, { timeout: timeoutMs }, (r) => {
      let body = ''; r.on('data', c => body += c);
      r.on('end', () => res({ status: r.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); res({ status: 0, body: '' }); });
    req.on('error', () => res({ status: 0, body: '' }));
  });
}

function readPid() {
  if (!existsSync(PID_FILE)) return null;
  const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
  if (!pid) return null;
  try { process.kill(pid, 0); return pid; } catch { return null; }
}

// ── commands ──────────────────────────────────────────────────────────────

async function cmdInstall() {
  head('cap install');
  if (!existsSync(resolve(ROOT, 'node_modules'))) {
    say('Installing npm dependencies...');
    const r = run('npm', ['install']);
    if (r.status !== 0) { bad('npm install failed'); process.exit(r.status ?? 1); }
  } else {
    ok('node_modules present');
  }
  run('node', ['scripts/setup.mjs']);
  say('');
  ok('install complete');
  note('next: edit .env (set GEMINI_API_KEY), then `cap start`');
}

async function cmdStart() {
  head('cap start');
  const existing = readPid();
  if (existing) { ok(`already running (pid ${existing}) on :${port()}`); return; }
  if (!existsSync(resolve(ROOT, '.env'))) {
    bad('.env missing — run `cap install` first');
    process.exit(1);
  }
  mkdirSync(PID_DIR, { recursive: true });
  const fs = await import('node:fs');
  const fd = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env },
  });
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
  // wait for /health
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 250));
    const p = await ping('/health', 500);
    if (p.status === 200) {
      ok(`server up on http://localhost:${port()} (pid ${child.pid})`);
      note(`logs: ${LOG_FILE}`);
      return;
    }
  }
  bad('server did not become healthy in 10s');
  note(`tail logs: tail -f ${LOG_FILE}`);
  process.exit(1);
}

async function cmdStop() {
  head('cap stop');
  const pid = readPid();
  if (!pid) { note('not running'); return; }
  try { process.kill(pid, 'SIGTERM'); ok(`stopped pid ${pid}`); } catch (e) { bad(String(e.message)); }
  try { unlinkSync(PID_FILE); } catch {}
}

async function cmdStatus() {
  head('cap status');
  const pid = readPid();
  if (pid) ok(`running, pid ${pid}, port ${port()}`); else note('not running');
  const h = await ping('/health');
  if (h.status === 200) ok(`/health 200 → ${h.body.slice(0, 120)}`);
  else note(`/health unreachable (status ${h.status})`);
}

async function cmdDoctor() { run('node', ['scripts/doctor.mjs']); }
async function cmdDemo()   { run('node', ['scripts/demo.mjs']); }

async function cmdAgent(args) {
  const name = (args[0] || '').toLowerCase();
  const passthrough = args.slice(1);
  const agents = {
    claude:   { bin: 'claude',   help: 'https://docs.claude.com/claude-code' },
    codex:    { bin: 'codex',    help: 'https://github.com/openai/codex' },
    opencode: { bin: 'opencode', help: 'https://opencode.ai' },
    gemini:   { bin: 'gemini',   help: 'https://github.com/google-gemini/gemini-cli' },
  };
  if (!name || !agents[name]) {
    head('cap agent <name>');
    say('Attach a code agent to this repo. Available adapters:');
    for (const [k, v] of Object.entries(agents)) say(`  ${C.cyan}${k}${C.reset}  — ${v.help}`);
    say('\nThe agent must already be installed on PATH.');
    say('Usage: cap agent claude [...args passed through]');
    return;
  }
  const { bin } = agents[name];
  const which = spawnSync('which', [bin]);
  if (which.status !== 0) {
    bad(`${bin} not found on PATH`);
    note(`install it first: ${agents[name].help}`);
    process.exit(127);
  }
  head(`cap agent ${name}`);
  note(`spawning \`${bin}\` in ${ROOT}`);
  const r = run(bin, passthrough);
  process.exit(r.status ?? 0);
}

function cmdHelp() {
  say(`${C.bold}cap${C.reset} — Captains Prediction Companion launcher

${C.bold}USAGE${C.reset}
  cap <command> [args]

${C.bold}COMMANDS${C.reset}
  ${C.cyan}install${C.reset}       npm install + scaffold .env / data dirs
  ${C.cyan}start${C.reset}         start MCP server in background (PID tracked)
  ${C.cyan}stop${C.reset}          stop background server
  ${C.cyan}status${C.reset}        show pid + /health
  ${C.cyan}doctor${C.reset}        run health diagnostics
  ${C.cyan}demo${C.reset}          smoke-test the server
  ${C.cyan}agent <name>${C.reset}  attach a code agent (claude|codex|opencode|gemini)
  ${C.cyan}help${C.reset}          show this

${C.bold}TYPICAL FLOW${C.reset}
  git clone … && cd captains-prediction-companion
  cap install
  $EDITOR .env          # set GEMINI_API_KEY
  cap start
  cap agent claude      # or codex / opencode / gemini

${C.dim}repo: ${ROOT}${C.reset}`);
}

// ── dispatch ──────────────────────────────────────────────────────────────

const [, , sub, ...rest] = process.argv;
const table = {
  install: cmdInstall, setup: cmdInstall,
  start: cmdStart, up: cmdStart,
  stop: cmdStop, down: cmdStop,
  status: cmdStatus, ps: cmdStatus,
  doctor: cmdDoctor,
  demo: cmdDemo,
  agent: () => cmdAgent(rest),
  help: cmdHelp, '--help': cmdHelp, '-h': cmdHelp, '': cmdHelp,
};
const fn = table[sub ?? ''];
if (!fn) { bad(`unknown command: ${sub}`); cmdHelp(); process.exit(2); }
Promise.resolve(fn()).catch(e => { bad(String(e?.stack || e)); process.exit(1); });
