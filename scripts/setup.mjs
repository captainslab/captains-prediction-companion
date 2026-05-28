#!/usr/bin/env node
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const MIN_NODE_MAJOR = 18;
const [major] = process.versions.node.split('.').map(Number);

console.log('Captains Prediction Companion — setup\n');
let ok = true;

if (major < MIN_NODE_MAJOR) {
  console.error(`✗ Node.js ${MIN_NODE_MAJOR}+ required. Found ${process.versions.node}.`);
  console.error('  Download: https://nodejs.org');
  ok = false;
} else {
  console.log(`✓ Node.js ${process.versions.node}`);
}

const envFile = resolve(ROOT, '.env');
const exampleFile = resolve(ROOT, '.env.example');

if (existsSync(envFile)) {
  console.log('✓ .env already exists — skipping copy');
} else if (existsSync(exampleFile)) {
  copyFileSync(exampleFile, envFile);
  console.log('✓ Copied .env.example → .env');
  console.log('  ⚠ Edit .env and set GEMINI_API_KEY before running npm start');
} else {
  console.error('✗ .env.example not found');
  ok = false;
}

const dataDir = resolve(ROOT, 'data');
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
  console.log('✓ Created data/ directory');
} else {
  console.log('✓ data/ directory exists');
}

if (!existsSync(resolve(ROOT, 'node_modules'))) {
  console.log('\n  node_modules missing — run `npm install` next.');
} else {
  console.log('✓ node_modules installed');
}

if (ok) {
  console.log('\nSetup complete. Next steps:');
  console.log('  1. Edit .env and set GEMINI_API_KEY');
  console.log('  2. npm install   (if not already done)');
  console.log('  3. npm start');
  console.log('  4. npm run doctor   (to verify)');
} else {
  console.error('\nSetup failed. Fix the errors above and try again.');
  process.exit(1);
}
