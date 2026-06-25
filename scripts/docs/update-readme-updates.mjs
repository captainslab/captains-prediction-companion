#!/usr/bin/env node
// Deterministic README auto-block updater for Captains Prediction Companion.
//
// PURPOSE
//   Keep the README "Latest Updates" and "Project Status" blocks in sync with
//   the tracked source of truth (CHANGELOG.md + package.json) WITHOUT a human
//   hand-editing two places. The generated content is a pure function of
//   tracked files only, so:
//     - `npm run docs:update` rewrites just the marked blocks, nothing else.
//     - `npm run docs:check` (this script with --check) fails if the README is
//       stale, and prints the exact fix command. Safe for CI: deterministic,
//       no secrets, no network, no git-hash churn.
//
// HARD RULES
//   - Only the text BETWEEN the markers is ever rewritten. All other README
//     content is preserved byte-for-byte.
//   - No secrets are read, printed, or written. No network. No trades.
//   - Volatile values (commit hash, timestamps) are intentionally NOT written
//     into the committed README so docs:check stays stable across machines and
//     across every commit. Git info is read only for an optional console note.
//
// MARKERS (in README.md)
//   <!-- CPC:UPDATES:START -->  ... generated ...  <!-- CPC:UPDATES:END -->
//   <!-- CPC:STATUS:START -->   ... generated ...  <!-- CPC:STATUS:END -->

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

const README_PATH = resolve(REPO_ROOT, 'README.md');
const CHANGELOG_PATH = resolve(REPO_ROOT, 'CHANGELOG.md');
const PACKAGE_PATH = resolve(REPO_ROOT, 'package.json');

const MARKERS = Object.freeze({
  updates: { start: '<!-- CPC:UPDATES:START -->', end: '<!-- CPC:UPDATES:END -->' },
  status: { start: '<!-- CPC:STATUS:START -->', end: '<!-- CPC:STATUS:END -->' },
});

const UPDATES_MAX_BULLETS = 8;

function readUtf8(path) {
  return readFileSync(path, 'utf8');
}

/**
 * Parse the most recent CHANGELOG entry.
 * Returns { heading, version, bullets[] }.
 * An entry starts at a line like:  ## [Unreleased] — ...   or   ## [0.10.0] — ...
 */
function parseLatestChangelogEntry(changelog) {
  const lines = changelog.split('\n');
  const headingIdx = lines.findIndex((l) => /^##\s+\[/.test(l));
  if (headingIdx === -1) {
    return { heading: 'No changelog entries found', version: 'unreleased', bullets: [] };
  }
  const headingLine = lines[headingIdx].replace(/^##\s+/, '').trim();
  const versionMatch = headingLine.match(/\[([^\]]+)\]/);
  const version = versionMatch ? versionMatch[1] : 'unreleased';

  // Collect bullets until the next "## [" heading.
  const bullets = [];
  let currentGroup = null;
  for (let i = headingIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^##\s+\[/.test(line)) break; // next entry
    const groupMatch = line.match(/^###\s+(.+)\s*$/);
    if (groupMatch) {
      currentGroup = groupMatch[1].trim();
      continue;
    }
    const bulletMatch = line.match(/^[-*]\s+(.+?)\s*$/);
    if (bulletMatch) {
      const tag = currentGroup ? `${currentGroup}: ` : '';
      bullets.push(`${tag}${bulletMatch[1].trim()}`);
    }
  }
  return { heading: headingLine, version, bullets };
}

function buildUpdatesBlock(changelog) {
  const { heading, bullets } = parseLatestChangelogEntry(changelog);
  const shown = bullets.slice(0, UPDATES_MAX_BULLETS);
  const out = [];
  out.push(`**Latest: ${heading}**`);
  out.push('');
  if (!shown.length) {
    out.push('_No changelog bullets yet. Add an entry to `CHANGELOG.md`._');
  } else {
    for (const b of shown) out.push(`- ${b}`);
    if (bullets.length > shown.length) {
      out.push(`- _…and ${bullets.length - shown.length} more — see [CHANGELOG.md](./CHANGELOG.md)_`);
    }
  }
  out.push('');
  out.push('_Auto-generated from `CHANGELOG.md` by `npm run docs:update`. Do not edit by hand._');
  return out.join('\n');
}

function buildStatusBlock(changelog, pkg) {
  const { version: changelogVersion } = parseLatestChangelogEntry(changelog);
  const rows = [
    ['Package version', '`' + (pkg.version ?? 'unknown') + '`'],
    ['Latest changelog', '`' + changelogVersion + '`'],
    ['Node requirement', '`>=18` (developed on Node 22)'],
    ['Trading posture', 'Read-only — **no orders, no execution automation**'],
    ['Composite scoring', 'Market-neutral — market price is **never** a composite input'],
    ['Supported packets', 'MLB · NASCAR · mentions / politics'],
    ['Discord output', 'Dry-run formatter only (offline, no live send)'],
  ];
  const out = [];
  out.push('| Field | Status |');
  out.push('|---|---|');
  for (const [k, v] of rows) out.push(`| ${k} | ${v} |`);
  out.push('');
  out.push('_Auto-generated from `package.json` + `CHANGELOG.md` by `npm run docs:update`. Do not edit by hand._');
  return out.join('\n');
}

/**
 * Replace the text between a marker pair. Throws if either marker is missing so
 * a malformed README is a loud failure, not a silent no-op.
 */
function replaceBlock(content, marker, replacement) {
  const startIdx = content.indexOf(marker.start);
  const endIdx = content.indexOf(marker.end);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error(`README is missing markers: ${marker.start} / ${marker.end}`);
  }
  if (endIdx < startIdx) {
    throw new Error(`README markers out of order: ${marker.start} appears after ${marker.end}`);
  }
  const before = content.slice(0, startIdx + marker.start.length);
  const after = content.slice(endIdx);
  return `${before}\n\n${replacement}\n\n${after}`;
}

function gitNote() {
  // Read-only, best-effort. Never written into the README — console-only.
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
    const hash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
    return `git: ${branch} @ ${hash}`;
  } catch {
    return 'git: (unavailable)';
  }
}

function main() {
  const args = process.argv.slice(2);
  const checkMode = args.includes('--check');

  for (const p of [README_PATH, CHANGELOG_PATH, PACKAGE_PATH]) {
    if (!existsSync(p)) {
      console.error(`docs:update error — missing required file: ${p}`);
      process.exit(2);
    }
  }

  const changelog = readUtf8(CHANGELOG_PATH);
  const pkg = JSON.parse(readUtf8(PACKAGE_PATH));
  const original = readUtf8(README_PATH);

  let next = original;
  next = replaceBlock(next, MARKERS.updates, buildUpdatesBlock(changelog));
  next = replaceBlock(next, MARKERS.status, buildStatusBlock(changelog, pkg));

  const changed = next !== original;

  if (checkMode) {
    if (changed) {
      console.error('✗ README auto-blocks are STALE.');
      console.error('  Run: npm run docs:update');
      process.exit(1);
    }
    console.log('✓ README auto-blocks are up to date.');
    console.log(`  ${gitNote()}`);
    process.exit(0);
  }

  if (changed) {
    writeFileSync(README_PATH, next, 'utf8');
    console.log('✓ README auto-blocks updated (CPC:UPDATES, CPC:STATUS).');
  } else {
    console.log('✓ README auto-blocks already current — no change written.');
  }
  console.log(`  ${gitNote()}`);
}

main();
