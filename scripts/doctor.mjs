#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const MIN_NODE_MAJOR = 18;

let pass = 0;
let fail = 0;
let warn = 0;

function checkOk(msg) { console.log(`  ✓ ${msg}`); pass++; }
function checkFail(msg) { console.log(`  ✗ ${msg}`); fail++; }
function checkWarn(msg) { console.log(`  ⚠ ${msg}`); warn++; }

function loadEnvFile(filePath) {
  const vars = {};
  if (!existsSync(filePath)) return vars;
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match) vars[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return vars;
}

function pingHealth(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/health`, { timeout: 4000 }, (res) => {
      let body = '';
      res.on('data', chunk => (body += chunk));
      res.on('end', () => {
        try {
          resolve({ ok: JSON.parse(body).ok === true, status: res.statusCode });
        } catch {
          resolve({ ok: false, status: res.statusCode });
        }
      });
    });
    req.on('error', () => resolve({ ok: false, error: 'connection refused' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}

console.log('Captains Prediction Companion — doctor\n');

// 1. Node version
const [major] = process.versions.node.split('.').map(Number);
if (major >= MIN_NODE_MAJOR) {
  checkOk(`Node.js ${process.versions.node}`);
} else {
  checkFail(`Node.js ${MIN_NODE_MAJOR}+ required — found ${process.versions.node} (https://nodejs.org)`);
}

// 2. .env
const envPath = resolve(ROOT, '.env');
const envExists = existsSync(envPath);
if (envExists) {
  checkOk('.env found');
} else {
  checkFail('.env not found — run `npm run setup` to create it');
}

// 3. Recommended env vars
const envVars = envExists ? loadEnvFile(envPath) : {};
const geminiKey = envVars['GEMINI_API_KEY'] ?? process.env.GEMINI_API_KEY ?? '';
if (geminiKey && geminiKey.length > 4) {
  checkOk('GEMINI_API_KEY is set');
} else {
  checkWarn('GEMINI_API_KEY not set — market analysis will not work without it');
}

// 4. node_modules
if (existsSync(resolve(ROOT, 'node_modules'))) {
  checkOk('node_modules installed');
} else {
  checkFail('node_modules not found — run `npm install`');
}

// 5. Hermes CLI
const hermesCmd = envVars['HERMES_COMMAND'] ?? process.env.HERMES_COMMAND ?? 'hermes';
const hermesCheck = spawnSync(hermesCmd, ['--version'], { encoding: 'utf8', timeout: 5000 });
if (hermesCheck.status === 0 || (hermesCheck.stdout && hermesCheck.stdout.length > 0)) {
  checkOk(`Hermes CLI found (${hermesCmd})`);
} else {
  checkWarn(`Hermes CLI not found (${hermesCmd}) — AI market analysis requires Hermes. Server still starts without it.`);
}

// 6. Server health
const port = Number(envVars['PORT'] ?? process.env.PORT ?? 3000);
const health = await pingHealth(port);
if (health.ok) {
  checkOk(`Server responding at http://localhost:${port}/health`);
} else if (health.error === 'connection refused') {
  checkWarn(`Server not running on port ${port} — start with \`npm start\`, then re-run doctor`);
} else {
  checkFail(`Server health check failed: ${health.error ?? `HTTP ${health.status}`}`);
}

console.log('');
console.log(`Results: ${pass} passed, ${warn} advisory, ${fail} failed`);

if (fail > 0) {
  console.log('\nFix the failing checks above, then re-run `npm run doctor`.');
  process.exit(1);
} else if (warn > 0) {
  console.log('\nAdvisory items are not blockers — the server starts without them.');
  console.log('Full market analysis requires GEMINI_API_KEY + Hermes CLI.');
} else {
  console.log('\nAll checks passed.');
}
