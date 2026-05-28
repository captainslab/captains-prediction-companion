#!/usr/bin/env node
/**
 * Starts the backend server, verifies key endpoints, then exits.
 * Demonstrates that the server starts and responds correctly.
 */
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PORT = Number(process.env.PORT ?? 3000);

function ping(path) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${PORT}${path}`, { timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', chunk => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', () => resolve({ status: 0, body: 'connection refused' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

console.log('Captains Prediction Companion — demo\n');
console.log('Starting server...\n');

const server = spawn(process.execPath, [resolve(ROOT, 'src/server.js')], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env },
});

server.stdout.on('data', (d) => process.stdout.write(d));
server.stderr.on('data', (d) => process.stderr.write(d));

await sleep(2500);

const checks = [
  { path: '/health', label: 'health check' },
  { path: '/pipeline/status', label: 'pipeline status' },
  { path: '/mcp', label: 'MCP endpoint (expects 400 without body — that is OK)' },
];

let allOk = true;
console.log('\nEndpoint checks:');

for (const { path, label } of checks) {
  const result = await ping(path);
  const acceptable = result.status >= 200 && result.status < 500;
  if (acceptable) {
    console.log(`  ✓ GET ${path} → HTTP ${result.status}  (${label})`);
  } else {
    console.log(`  ✗ GET ${path} → ${result.status || result.body}  (${label})`);
    allOk = false;
  }
}

server.kill();
await sleep(200);

console.log('');
if (allOk) {
  console.log('Demo passed. Server starts and all endpoints respond.');
  console.log(`\nTo run the full server:  npm start`);
  console.log(`Then open:               http://localhost:${PORT}/`);
  console.log(`Health check:            http://localhost:${PORT}/health`);
  console.log(`MCP endpoint:            http://localhost:${PORT}/mcp`);
} else {
  console.log('Demo failed. Check the errors above.');
  console.log('Run `npm run doctor` for a full diagnostic.');
  process.exit(1);
}
