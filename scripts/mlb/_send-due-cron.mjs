#!/usr/bin/env node
// Cron wrapper for _send-due.mjs — forces UTC date so late-night games
// (UTC) are not mis-routed to the previous Chicago date.
// Script-owned delivery only. No LLM. No send_message.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const todayUtc = new Date().toISOString().slice(0, 10);

const r = spawnSync(process.execPath, [
  join(__dirname, '_send-due.mjs'),
  '--date', todayUtc,
], {
  stdio: 'inherit',
  cwd: process.cwd(),
});

process.exit(r.status ?? 0);
