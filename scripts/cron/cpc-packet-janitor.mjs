#!/usr/bin/env node
// CPC Packet Janitor.
//
// Deterministic delivery QC for customer packet artifacts. This script does
// not rewrite evidence, picks, scores, source layers, rationale, credentials,
// providers, Kalshi auth, Telegram settings, or cron schedules.
//
// Flow: DETECT -> SAFE_REPAIR -> VALIDATE -> SEND_ALLOWED or BLOCK -> REPORT.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateCpcCustomerPacket } from '../packets/lib/cpc-packet-validator.mjs';
import { evaluateNascarPacketText } from '../nascar/lib/race-quality-gate.mjs';

export const JANITOR_VERSION = 'cpc_packet_janitor_v1';

export const DELIVERY_VERDICTS = Object.freeze({
  SEND_ALLOWED: 'SEND_ALLOWED',
  SEND_ALLOWED_AFTER_REPAIR: 'SEND_ALLOWED_AFTER_REPAIR',
  JANITOR_WARNING: 'JANITOR_WARNING',
  JANITOR_BLOCKED: 'JANITOR_BLOCKED',
  // Delivery-time gate: the slate is no longer deliverable (a target game has
  // already started). Fail closed — never send, never mark delivered.
  EXPIRED_SLATE_BLOCKED: 'EXPIRED_SLATE_BLOCKED',
});

const MAX_REPAIR_ATTEMPTS = 1;
const TELEGRAM_DOC_SAFE_CHARS = 3500;

const MENTION_REQUIRED_SECTIONS = [
  'FAST READ',
  'TOP YES CASE',
  'WEAK YES WATCHLIST',
  'WEAK NO / STRONG NO TRAPS',
  'SOURCE GAPS',
  'QUALIFICATION RISK',
  'SETTLEMENT NOTES',
  'FULL STRIKE INVENTORY',
];

const SCORING_SECTION_RE =
  /(CPC COMPOSITE BOARD|TOP WATCH TERMS|RANKED BOARD|TOP RESEARCHED TERMS|RESEARCH GAPS|TOP YES CASE|WEAK YES WATCHLIST|WEAK NO \/ STRONG NO TRAPS|QUALIFICATION RISK|MODEL|MODEL SCORE|SCORING|SCORECARD|RATIONALE|EDGE BASIS|FINAL READ|DECISION BASIS)/i;
const MARKET_SECTION_RE = /(MARKET CONTEXT|NOT IN SCORE|DISPLAY ONLY|DISPLAY-ONLY|LIQUIDITY|INVENTORY ARTIFACT ONLY|INVENTORY-ARTIFACT-ONLY)/i;
const MARKET_ROW_RE = /^\s*(?:[-*]\s*)?(?:raw\s+)?(?:market|market context|liquidity)\s*[:|-]/i;
const MARKET_PLACEHOLDER_RE = /\b(?:price|bid|ask|yes_ask|yes_bid|no_ask|no_bid|last[_ -]?price|volume|open[_ -]?interest|oi)\s*[:=]\s*(?:MISSING|PENDING|N\/A|NA|null|none|unknown)\b/i;
const HARMLESS_MARKET_LANGUAGE_RE =
  /\b(?:market[- ]neutral(?:ity)?|not in score|display only|display-only|inventory artifact only|inventory-artifact-only|raw bid\/ask\/last\/volume\/(?:oi|open interest)|raw market prices? are not in score|market prices? are not in score|price\s*=\s*missing|price is missing|pending source inventory|volume\/accuracy|striking volume|last \d+ starts)\b/i;
const DRY_RUN_RE = /\b(would send|dry-run|dry run|no telegram send|preview only)\b/i;
const WRAPPER_RE = /^\s*(Cronjob Response:|Hermes cron response:|Command output:)\s*/im;
const BAD_SCAFFOLD_RE =
  /\b(scaffold|placeholder|todo:|insert evidence|rewrite this|model-written final packet|final customer text draft)\b/i;
const MENTIONS_LEGACY_RE =
  /\b(Most likely mention terms|TLDR BOARD|TOP EDGE CANDIDATES|CPC COMPOSITE BOARD|TOP WATCH TERMS|RANKED BOARD|TOP RESEARCHED TERMS|PICK\s*:\s*|EVIDENCE_LEAN\s*:|LEAN\b|WATCH\b|NO_CLEAR_PICK\b|source layer(?:s)?\b|event_proximity\b|proximity-only\b|stub\b|scaffold\b|composite score\b|source-backed composite\b)\b/i;
// "RESEARCH GAPS" was the retired section heading (superseded by "SOURCE
// GAPS"). Anchored to a standalone header line, not a bare substring — the
// current renderer's own honest FAST READ prose ("...all remain research
// gaps.") legitimately contains this phrase and must not trip a legacy-format
// leak on that account.
const MENTIONS_LEGACY_HEADER_RE = /^\s*RESEARCH GAPS\s*$/im;
const SOURCE_STALE_MS = 36 * 60 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function sha256(text) {
  return createHash('sha256').update(text ?? '').digest('hex');
}

function safeSlug(input) {
  return String(input || 'packet')
    .replace(/[^a-z0-9._-]/gi, '_')
    .replace(/_+/g, '_')
    .slice(0, 120);
}

function readTextIfExists(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  return readFileSync(filePath, 'utf8');
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function listJsonFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => join(dir, entry));
}

function atomicWriteJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, filePath);
}

function atomicWriteText(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, value, 'utf8');
  renameSync(tmp, filePath);
}

function inferDateFromPath(filePath) {
  const m = String(filePath ?? '').match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  return m ? m[1] : new Date().toISOString().slice(0, 10);
}

function inferPacketType(filePath = '', explicit = '') {
  if (explicit) return explicit;
  const p = String(filePath).toLowerCase();
  if (p.includes('/nascar/') || p.includes('nascar')) return 'nascar-sunday';
  if (p.includes('/mentions/') || p.includes('mention')) return 'mentions-daily';
  if (p.includes('/worldcup/') || p.includes('worldcup')) return 'worldcup-matchday';
  if (p.includes('/ufc/') || p.includes('ufc')) return 'ufc-weekly';
  if (p.includes('/mlb/') || p.includes('mlb') || p.includes('composite-refresh')) return 'mlb-daily';
  return 'unknown';
}

function sportFromPacketType(packetType = '') {
  const p = String(packetType).toLowerCase();
  if (p.includes('mlb')) return 'mlb';
  if (p.includes('ufc')) return 'ufc';
  if (p.includes('worldcup')) return 'worldcup';
  if (p.includes('nascar')) return 'nascar';
  if (p.includes('mention')) return 'mentions';
  return null;
}

function janitorDir(stateRoot, date) {
  return resolve(stateRoot || 'state', 'janitor', date);
}

function candidateBodyStarts(text) {
  const markers = [
    /^===\s*.*CPC Packet:/im,
    /^===\s*Captain\s+(?:MLB|World Cup|UFC|Mentions)/im,
    /^CPC Packet:/im,
    /^Event title:/im,
    /^#\s*Event:/im,
    /^FAST READ\s*$/im,
  ];
  const starts = [];
  for (const re of markers) {
    const m = re.exec(text);
    if (m) starts.push(m.index);
  }
  return starts.sort((a, b) => a - b);
}

function stripWrapperText(text) {
  if (!WRAPPER_RE.test(text)) return null;
  const starts = candidateBodyStarts(text);
  const wrapper = WRAPPER_RE.exec(text);
  const bodyStart = starts.find((idx) => idx > wrapper.index);
  if (bodyStart == null) return null;
  const repaired = text.slice(bodyStart).trimStart();
  return repaired ? { text: repaired, rule: 'strip_cron_wrapper_text' } : null;
}

function stripDryRunChatter(text) {
  const lines = text.split(/\r?\n/);
  const removed = [];
  const kept = [];
  for (const line of lines) {
    if (/^\s*(\[dry-run\]|\[dry run\]|would send|No trades placed\. No Telegram send\.)/i.test(line)) {
      removed.push(line);
      continue;
    }
    kept.push(line);
  }
  if (!removed.length) return null;
  const repaired = kept.join('\n').trim();
  return repaired ? { text: repaired, rule: 'remove_raw_dry_run_chatter' } : null;
}

function normalizeHeader(text) {
  const lines = text.split(/\r?\n/);
  if (!lines.length) return null;
  const first = lines[0].trim();
  if (/^===\s*CPC Packet:/i.test(first)) return null;
  if (/^CPC Packet:/i.test(first)) {
    lines[0] = `=== ${first.replace(/\s*===\s*$/, '')} ===`;
    return { text: lines.join('\n'), rule: 'normalize_title_header_formatting' };
  }
  if (/^===\s*Daily Decision Board:/i.test(first)) {
    lines[0] = first.replace(/Daily Decision Board:/i, 'CPC Packet: Daily Decision Board:');
    return { text: lines.join('\n'), rule: 'normalize_title_header_formatting' };
  }
  return null;
}

function restoreNotInScoreLabel(text) {
  if (/NOT IN SCORE/i.test(text)) return null;
  const lines = text.split(/\r?\n/);
  let changed = false;
  const next = lines.map((line) => {
    if (/market context/i.test(line)) {
      changed = true;
      return line.replace(/market context/i, 'Market Context - NOT IN SCORE');
    }
    return line;
  });
  return changed ? { text: next.join('\n'), rule: 'restore_required_not_in_score_label' } : null;
}

function sectionHeaderRegex(section) {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`^\\s*(?:#{1,3}\\s*)?${escaped}\\s*$`, 'im');
}

function fixMentionsSectionOrder(text) {
  const positions = MENTION_REQUIRED_SECTIONS.map((section) => {
    const m = sectionHeaderRegex(section).exec(text);
    return m ? { section, index: m.index, header: m[0] } : null;
  });
  if (positions.some((p) => !p)) return null;
  const idxs = positions.map((p) => p.index);
  const sorted = [...idxs].sort((a, b) => a - b);
  if (idxs.every((idx, i) => idx === sorted[i])) return null;

  const preamble = text.slice(0, Math.min(...idxs)).trimEnd();
  const blocks = new Map();
  const byIndex = [...positions].sort((a, b) => a.index - b.index);
  for (let i = 0; i < byIndex.length; i += 1) {
    const current = byIndex[i];
    const next = byIndex[i + 1];
    blocks.set(current.section, text.slice(current.index, next ? next.index : text.length).trim());
  }
  const repaired = [
    preamble,
    ...MENTION_REQUIRED_SECTIONS.map((section) => blocks.get(section)),
  ].filter(Boolean).join('\n\n');
  return { text: repaired.trimEnd() + '\n', rule: 'fix_section_order_existing_sections_only' };
}

function deterministicRepairs(text, context) {
  const repairs = [
    stripWrapperText,
    stripDryRunChatter,
    normalizeHeader,
    restoreNotInScoreLabel,
  ];
  if (/mention/i.test(context.packetType ?? '')) repairs.push(fixMentionsSectionOrder);
  return repairs;
}

function applyOneSafeRepair(text, context) {
  for (const repair of deterministicRepairs(text, context)) {
    const result = repair(text, context);
    if (result?.text && result.text !== text) return result;
  }
  return null;
}

function discoverSourceHealthPaths(context) {
  const explicit = [
    ...(context.sourceHealthPaths ?? []),
    context.sourceHealthPath,
  ].filter(Boolean);
  if (explicit.length) return explicit;
  const date = context.date ?? inferDateFromPath(context.filePath);
  const stateRoot = context.stateRoot ?? 'state';
  const packetType = inferPacketType(context.filePath, context.packetType);
  const sport = sportFromPacketType(packetType);
  const paths = [];
  if (sport === 'mlb') {
    paths.push(...listJsonFiles(resolve(stateRoot, 'mlb', date, 'discovery')));
    paths.push(resolve(stateRoot, 'mlb', date, 'slate-run-plan.json'));
  } else if (sport === 'ufc') {
    paths.push(...listJsonFiles(resolve(stateRoot, 'ufc', date, 'source-manifests')));
    paths.push(...listJsonFiles(resolve(stateRoot, 'ufc', date, 'discovery')));
  } else if (sport === 'worldcup') {
    paths.push(...listJsonFiles(resolve(stateRoot, 'worldcup', date, 'discovery')));
    paths.push(...listJsonFiles(resolve(stateRoot, 'packets', date, 'worldcup-matchday'))
      .filter((p) => /audit/i.test(basename(p))));
  } else if (sport === 'nascar') {
    paths.push(resolve(stateRoot, 'nascar', date, 'source_registry.json'));
    paths.push(resolve(stateRoot, 'nascar', date, 'discovery.json'));
  } else if (sport === 'mentions') {
    paths.push(...listJsonFiles(resolve(stateRoot, 'mentions', date, 'sources')));
    paths.push(...listJsonFiles(resolve(stateRoot, 'mentions', date, 'research')));
    // Blocker artifacts are delivery outcomes, not source-health inputs.
  }
  return [...new Set(paths)].filter((p) => existsSync(p));
}

function arrayRecordCount(value) {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== 'object') return 0;
  for (const key of ['records', 'events', 'markets', 'games', 'matches', 'fights', 'items', 'sources', 'results']) {
    if (Array.isArray(value[key])) return value[key].length;
  }
  return Object.keys(value).length ? 1 : 0;
}

function sourceTimestamp(value) {
  if (!value || typeof value !== 'object') return null;
  const candidates = [
    value.generated_utc,
    value.generated_at,
    value.produced_at,
    value.discovered_at,
    value.updated_utc,
    value.updated_at,
    value.fetched_utc,
    value.created_utc,
    value.checked_at_utc,
    value.checked_at,
    value.timestamp,
  ].filter(Boolean);
  for (const candidate of candidates) {
    const ms = Date.parse(candidate);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

function hasLiveFetchTimestamp(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => hasLiveFetchTimestamp(entry, seen));
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:live_)?(?:fetch|fetched|source_fetch|source_fetched|retrieved)_(?:utc|at)$|^live_fetched_utc$/i.test(key)) {
      if (typeof child === 'string' && Number.isFinite(Date.parse(child))) return true;
    }
    if (child && typeof child === 'object' && hasLiveFetchTimestamp(child, seen)) return true;
  }
  return false;
}

function sourceErrorCode(value) {
  const entries = [];
  const visit = (node, path = [], seen = new WeakSet()) => {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) visit(child, path, seen);
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      entries.push({ key, path: [...path, key], value: child });
      if (child && typeof child === 'object') visit(child, [...path, key], seen);
    }
  };
  visit(value);

  const isHttpField = (key, path = []) =>
    /^(?:(?:http_?)?(?:status|status_code|statusCode|code|error|error_code|errorCode|error_message|errorMessage|message|reason)|httpStatus|httpStatusCode)$/i.test(key) ||
    path.some((part) => /^(?:http|response|fetch|request|error|status)$/i.test(part));
  const fieldText = (entry) => `${entry.key}: ${String(entry.value ?? '')}`.slice(0, 500);
  const httpShaped = (text) =>
    /\b(?:http|status|status code|code|error|response|retry-after|retry_after|unauthorized|forbidden|access denied|permission denied|rate limit(?:ed)?)\b/i.test(text);
  const marketLike = (text) =>
    /\b(?:volume|open[_ -]?interest|oi|bid|ask|yes[_ -]?(?:ask|bid|price)|no[_ -]?(?:ask|bid|price)|last[_ -]?price|price)\b/i.test(text) &&
    !/\b(?:http|status|code|error|response|retry-after|unauthorized|forbidden|access denied|permission denied|rate limit(?:ed)?)\b/i.test(text);
  const relevant = entries.filter((entry) => isHttpField(entry.key, entry.path));
  const texts = relevant.map(fieldText).filter((text) => httpShaped(text) && !marketLike(text));
  if (texts.some((text) => /\b(?:429|rate[- ]?limit(?:ed)?|retry-after|retry_after)\b/i.test(text))) return 'FETCH_RATE_LIMITED';
  if (texts.some((text) => /\b(?:401|unauthorized|missing auth|auth[_ -]?blocked|permission denied)\b/i.test(text))) return 'FETCH_AUTH_BLOCKED';
  if (texts.some((text) => /\b(?:403|forbidden|access denied)\b/i.test(text))) return 'FETCH_AUTH_BLOCKED';
  if (texts.some((text) => /\b(schema invalid|invalid schema|parse error|malformed)\b/i.test(text))) return 'FETCH_SOURCE_SCHEMA_INVALID';
  return null;
}

function sourceRequiresJoinKey(value, packetType, sourcePath = '') {
  if (!value || typeof value !== 'object') return false;
  if (/source-manifests|manifest|reference/i.test(sourcePath)) return false;
  if (value.source_type === 'manifest' || value.source_type === 'reference' || value.manifest === true || value.reference === true) return false;
  const perRecordKeys = /^(?:records|events|markets|games|matches|fights|items|results)$/i;
  if (Array.isArray(value)) return value.length > 0;
  return Object.entries(value).some(([key, child]) => perRecordKeys.test(key) && Array.isArray(child) && child.length > 0);
}

function hasJoinKey(value, packetType) {
  const text = JSON.stringify(value ?? {}).slice(0, 100000);
  const shared = /\b(?:event_ticker|market_ticker|espn_event_id)\b/.test(text);
  if (shared) return true;
  if (/mlb/i.test(packetType)) return /\b(?:[a-z0-9]+_)?game_pk\b|\bgamePk\b|\bgame_id\b|\bgameId\b|\bgame_key\b/i.test(text);
  if (/ufc/i.test(packetType)) return /\b(?:fight_id|fightId|fight_key|match_id|matchId|event_ticker|market_ticker)\b/i.test(text);
  if (/worldcup/i.test(packetType)) return /\b(?:match_id|matchId|fixture_id|game_id|gameId|event_ticker|market_ticker)\b/i.test(text);
  if (/mentions/i.test(packetType)) return /\b(?:ticker|event_ticker|market_ticker)\b/i.test(text);
  return true;
}

function cacheOnlyFinding(value) {
  if (!value || typeof value !== 'object') return null;
  const text = JSON.stringify(value ?? {}).slice(0, 100000);
  if (/\b(?:stale_cache|stale cache|cache_only|cache only)\b/i.test(text)) return 'source health artifact indicates cache-only/stale-cache mode';
  if (/\bfrom_cache["']?\s*:\s*true\b/i.test(text)) return 'source health artifact indicates from_cache=true';
  if (/\bcache_only["']?\s*:\s*true\b/i.test(text)) return 'source health artifact indicates cache_only=true';
  if (/\blive["']?\s*:\s*false\b/i.test(text)) return 'source health artifact indicates live=false';
  // A live-fetch timestamp OR any recognized freshness timestamp (generated_utc,
  // updated_utc, checked_at, etc. — the same fields sourceTimestamp() trusts)
  // means the artifact is not cache-only on its own. Staleness of that timestamp
  // is handled separately by FETCH_SOURCE_STALE. Only the absence of BOTH a
  // live-fetch key and any freshness field indicates a cache-only artifact.
  if (!hasLiveFetchTimestamp(value) && sourceTimestamp(value) == null) {
    return 'source health artifact has no live fetch or freshness timestamp';
  }
  return null;
}

function sourceCoverageFinding(value) {
  if (!value || typeof value !== 'object') return null;
  const total = Number(value.total ?? value.expected_count ?? value.game_count ?? value.fight_count ?? value.match_count);
  const ok = Number(value.ok_count ?? value.covered_count ?? value.records_count ?? value.success_count);
  if (Number.isFinite(total) && total > 0 && Number.isFinite(ok) && ok < total) {
    return { total, ok };
  }
  const missing = value.missing ?? value.missing_layers ?? value.failed ?? value.failures;
  if (Array.isArray(missing) && missing.length) {
    return { total: null, ok: null, missing_count: missing.length };
  }
  return null;
}

function zeroLayerFinding(value) {
  const text = JSON.stringify(value ?? {}).slice(0, 100000);
  if (/\b(?:layers_present|source_layers|layer_coverage|coverage)\s*["']?\s*[:=]\s*["']?0\s*\/\s*\d+/i.test(text)) return true;
  if (/\b0\s*\/\s*(?:10|13|14|84)\b/i.test(text)) return true;
  return false;
}

function validateSourceHealth(context, errors, warnings) {
  if (!context.requireSourceHealth) return [];
  const packetType = inferPacketType(context.filePath, context.packetType);
  const paths = discoverSourceHealthPaths(context);
  if (!paths.length) {
    errors.push({
      code: 'FETCH_SOURCE_MISSING',
      message: 'no source/cache health artifacts found for packet preflight',
    });
    return [];
  }
  const findings = [];
  for (const sourcePath of paths) {
    const parsed = readJsonIfExists(sourcePath);
    if (!parsed) {
      findings.push({ path: sourcePath, code: 'FETCH_SOURCE_SCHEMA_INVALID', message: 'source health artifact is unreadable JSON' });
      continue;
    }
    const recordCount = arrayRecordCount(parsed);
    if (recordCount === 0) {
      findings.push({ path: sourcePath, code: 'FETCH_SOURCE_EMPTY', message: 'source health artifact has zero usable records' });
    }
    const ts = sourceTimestamp(parsed);
    if (ts && Date.now() - ts > SOURCE_STALE_MS) {
      findings.push({ path: sourcePath, code: 'FETCH_SOURCE_STALE', message: 'source health artifact is older than freshness window' });
    }
    const sourceError = sourceErrorCode(parsed);
    if (sourceError) {
      findings.push({ path: sourcePath, code: sourceError, message: 'source health artifact records fetch/auth/rate-limit failure' });
    }
    const cacheOnly = cacheOnlyFinding(parsed);
    if (cacheOnly) {
      findings.push({ path: sourcePath, code: 'FETCH_CACHE_ONLY', message: cacheOnly });
    }
    if (sourceRequiresJoinKey(parsed, packetType, sourcePath) && !hasJoinKey(parsed, packetType)) {
      findings.push({ path: sourcePath, code: 'FETCH_JOIN_KEY_MISSING', message: 'source health artifact lacks required join key' });
    }
    const coverage = sourceCoverageFinding(parsed);
    if (coverage) {
      findings.push({ path: sourcePath, code: 'FETCH_PARTIAL_COVERAGE', message: 'source health artifact reports partial source coverage', coverage });
    }
    if (zeroLayerFinding(parsed)) {
      findings.push({ path: sourcePath, code: 'FETCH_REAL_LAYER_ZERO', message: 'source health artifact indicates zero populated source/model layers' });
    }
  }
  const hard = findings.filter((finding) =>
    [
      'FETCH_SOURCE_EMPTY',
      'FETCH_SOURCE_SCHEMA_INVALID',
      'FETCH_AUTH_BLOCKED',
      'FETCH_RATE_LIMITED',
      'FETCH_JOIN_KEY_MISSING',
      'FETCH_REAL_LAYER_ZERO',
    ].includes(finding.code));
  const partial = findings.filter((finding) => finding.code === 'FETCH_PARTIAL_COVERAGE');
  const stale = findings.filter((finding) => finding.code === 'FETCH_SOURCE_STALE');
  const cacheOnly = findings.filter((finding) => finding.code === 'FETCH_CACHE_ONLY');
  for (const finding of hard) errors.push(finding);
  const sourceDisclosure = hasCacheOnlyDisclosure(context.packetText ?? '');
  if (partial.length || stale.length) {
    if (sourceDisclosure) {
      for (const finding of [...partial, ...stale]) warnings.push(finding);
    } else {
      errors.push({
        code: partial.length ? 'FETCH_PARTIAL_COVERAGE' : 'FETCH_SOURCE_STALE',
        message: 'source health is partial/stale and packet lacks explicit cache/stale-source disclosure',
        details: [...partial, ...stale],
      });
    }
  }
  if (cacheOnly.length) {
    if (sourceDisclosure) {
      for (const finding of cacheOnly) warnings.push(finding);
    } else {
      errors.push({
        code: 'FETCH_CACHE_ONLY',
        message: 'source health is cache-only/stale and packet lacks explicit cache/stale-source disclosure',
        details: cacheOnly,
      });
    }
  }
  return findings;
}

function hasModelScaffoldLeak(text, packetType) {
  if (BAD_SCAFFOLD_RE.test(text)) return true;
  if (/mention/i.test(packetType ?? '')) {
    if (MENTIONS_LEGACY_RE.test(text)) return true;
    if (MENTIONS_LEGACY_HEADER_RE.test(text)) return true;
  }
  return false;
}

// Detects a mentions customer packet that carries NO usable source evidence —
// the product-failure signature where the whole board is proximity-only / no
// research ran (e.g. "0/12 term(s) carry source evidence beyond event
// proximity"). This is a HARD send-time gate and is intentionally NOT
// downgradable by a cache-only / stale-source disclosure: disclosing that the
// cache is stale does not turn "no research" into a valid customer packet.
// Returns a finding object or null. Reads only the customer text — no prices.
export function noUsableSourceEvidenceFinding(text, packetType) {
  if (!/mention/i.test(packetType ?? '')) return null;
  const body = String(text ?? '');
  // Explicit renderer summary: "<n>/<total> term(s) have research-backed P(YES)".
  const m = body.match(/(\d+)\s*\/\s*(\d+)\s+term\(s\)\s+have\s+research-backed\s+P\(YES\)/i);
  if (m) {
    const withEvidence = Number(m[1]);
    const total = Number(m[2]);
    if (Number.isFinite(withEvidence) && Number.isFinite(total) && total > 0 && withEvidence === 0) {
      return {
        code: 'NO_USABLE_SOURCE_EVIDENCE',
        message: `mentions packet has 0/${total} terms with research-backed P(YES) (research gap / no research performed); not a valid customer packet`,
      };
    }
  }
  return null;
}

function mlbAlphaPendingFinding(text, packetType) {
  if (!/mlb/i.test(packetType ?? '')) return null;
  const body = String(text ?? '');
  const mainProjectionSection = body.split(/(?:^|\n)Source Ledger\b/i)[0] ?? body;
  const mainProjectionMissing =
    /(?:^|\n)\s*(?:Win probability|Projected win probability|Run line|Projected run-line|Total runs|Projected total|Projected runs \(Home\)|Projected runs \(Away\)|First-inning run \(YRFI\))\s+—\s+BLOCKED_MODEL_LAYER_MISSING\b/i.test(mainProjectionSection) ||
    /(?:^|\n)\s*MODEL_OUTPUT:\s+UNAVAILABLE\b/i.test(body) ||
    /(?:^|\n)\s*Model summary:\s*model outputs are unavailable\./i.test(body);
  if (!/provisional/i.test(body) && !mainProjectionMissing) return null;
  return {
    code: 'MLB_ALPHA_PENDING',
    message: 'MLB packet is still provisional; required alpha is not fully pulled',
  };
}

function priceLeaksInScoring(text) {
  const leaks = [];
  let inScoreSection = false;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (isDisplayOnlyMarketLine(line)) {
      inScoreSection = false;
      continue;
    }
    if (SCORING_SECTION_RE.test(line)) inScoreSection = true;
    if (inScoreSection && hasRawMarketValue(line)) {
      leaks.push({ line: i + 1, text: line.trim().slice(0, 180) });
    }
  }
  return leaks;
}

function isDisplayOnlyMarketLine(line) {
  return MARKET_SECTION_RE.test(line) || MARKET_ROW_RE.test(line);
}

function hasRawMarketValue(line) {
  const text = String(line ?? '');
  if (!text.trim()) return false;
  if (HARMLESS_MARKET_LANGUAGE_RE.test(text)) return false;
  if (MARKET_PLACEHOLDER_RE.test(text)) return false;
  if (/\b(?:NOT IN SCORE|DISPLAY ONLY|DISPLAY-ONLY|INVENTORY ARTIFACT ONLY|INVENTORY-ARTIFACT-ONLY)\b/i.test(text)) return false;
  return [
    /\b(?:yes|no)_(?:ask|bid|price)\s*[:=]\s*(?:0?\.\d+|[1-9]\d{0,2})(?:\b|%|¢|cents)/i,
    /\b(?:yes|no)\s+(?:ask|bid|price)\s*[:=]?\s*(?:0?\.\d+|[1-9]\d{0,2})(?:\b|%|¢|cents)/i,
    /\blast[_ -]?price\s*[:=]?\s*(?:0?\.\d+|[1-9]\d{0,2})(?:\b|%|¢|cents)/i,
    /\b(?:bid|ask)\s*[:=]?\s*(?:0?\.\d+|[1-9]\d{1,2})(?:\b|%|¢|cents)/i,
    /\b(?:open[_ -]?interest|oi|volume)\s*[:=]?\s*\d+(?:\b|[,.)])/i,
    /\b(?:yes|no)\s*[:=]?\s*\d{1,3}\s*(?:¢|cents|%)\b/i,
    /\b\d{1,3}\s*(?:¢|cents)\b/i,
  ].some((re) => re.test(text));
}

function countNoClear(text) {
  const lines = text.split(/\r?\n/);
  let noClear = 0;
  let total = 0;
  for (const line of lines) {
    if (/\b(?:RESEARCH GAP|NO_CLEAR_PICK)\b/i.test(line)) {
      total += 1;
      noClear += 1;
    } else if (/^\s*(?:#\d+|\*|-|[★◆◇○])\s+/u.test(line)) {
      total += 1;
    }
  }
  return { noClear, total, ratio: total ? noClear / total : 0 };
}

// A UFC no-clear row is "close enough" to be justified when its surrounding
// text shows any one of: explicit close-margin phrasing, a tight numeric score
// pair (e.g. 53-52, abs diff <= 3 — the actual generator format), or
// cancellation/separation language. This recognizes the real packet vocabulary
// instead of only the canonical "close margin" phrasing.
function hasUfcClosenessSignal(scope) {
  const text = String(scope ?? '');
  if (/close (?:composite )?margin|margin\s*(?:<=|<|:)|within\s+\d+(?:\.\d+)?|score margin/i.test(text)) return true;
  if (/edge did not separate|did not separate|fully scored|no clear dominant path/i.test(text)) return true;
  for (const line of text.split(/\r?\n/)) {
    // Skip date/provenance lines so tokens like 2026-06-14 are never read as scores.
    if (/\bdate\b|generated|\b20\d{2}-\d{2}-\d{2}\b/i.test(line)) continue;
    const re = /\b(\d{1,3})\s*-\s*(\d{1,3})\b/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (a <= 100 && b <= 100 && Math.abs(a - b) <= 3) return true;
    }
  }
  return false;
}

function hasNoClearJustification(text, packetType) {
  const hasCoverage = /(research-backed terms|research coverage|research-backed|terms? have research-backed P\(YES\)|research gap section|source layer coverage|source coverage|source-backed|data coverage|coverage\s*[:=])/i.test(text);
  const hasCancellation = /(cancel(?:ing|lation)? evidence|evidence cancels|offsetting|settlement wording|event schedule|research gap|missing research|missing source)/i.test(text);
  const hasBlocker = /(BLOCKED_|blocker artifact|fail-closed|research gap|missing source|NO_USABLE_SOURCE_EVIDENCE)/i.test(text);
  if (/ufc/i.test(packetType ?? '')) return hasCoverage && hasUfcClosenessSignal(text);
  if (/mentions/i.test(packetType ?? '')) return hasBlocker || hasCoverage;
  return hasCoverage && (hasCancellation || hasBlocker);
}

export function hasCacheOnlyDisclosure(text) {
  return /\b(?:cache-only|cache only|from cache|cached coverage|stale cache|stale-source|stale source|stale coverage|live fetch unavailable|live source unavailable|using cached)\b/i.test(text);
}

// Canonical, price-free disclosure line the renderer emits when source health is
// cache-only / stale / partial. It deliberately contains phrases that
// hasCacheOnlyDisclosure() recognizes ("Live fetch unavailable", "cache-only",
// "stale-source", "cached"), so the renderer's disclosure trigger can never drift
// from the janitor's block trigger. Contains NO price/odds/volume tokens — it is
// a freshness statement only and is safe under the price-isolation invariant.
export const CACHE_ONLY_DISCLOSURE_LINE =
  'Source freshness: Live fetch unavailable this run — packet built from cache-only / stale-source coverage; treat research as cached/provisional until live research lands. NOT a score input.';

// Pure detector reused by the mentions renderer. Runs the SAME date-wide source-
// health discovery the janitor uses at send time and reports whether the packet
// must carry a cache/stale-source disclosure. Read-only: it never mutates state,
// never rewrites packets, and never weakens any janitor verdict. Returns
// needsDisclosure=true when any discovered source-health artifact is cache-only,
// stale, or partial — a superset that exactly covers the three janitor branches
// gated by hasCacheOnlyDisclosure (FETCH_CACHE_ONLY, FETCH_SOURCE_STALE,
// FETCH_PARTIAL_COVERAGE).
export function detectSourceHealthDisclosure(context = {}) {
  const packetType = inferPacketType(context.filePath, context.packetType);
  const paths = discoverSourceHealthPaths({ ...context, packetType });
  let cacheOnly = false;
  let stale = false;
  let partial = false;
  for (const sourcePath of paths) {
    const parsed = readJsonIfExists(sourcePath);
    if (!parsed) continue;
    if (cacheOnlyFinding(parsed)) cacheOnly = true;
    const ts = sourceTimestamp(parsed);
    if (ts && Date.now() - ts > SOURCE_STALE_MS) stale = true;
    if (sourceCoverageFinding(parsed)) partial = true;
  }
  const needsDisclosure = cacheOnly || stale || partial;
  return {
    needsDisclosure,
    cacheOnly,
    stale,
    partial,
    disclosureLine: needsDisclosure ? CACHE_ONLY_DISCLOSURE_LINE : null,
  };
}

function ufcNoClearGaps(text) {
  const lines = text.split(/\r?\n/);
  const hasGlobalCoverage = /(source layer coverage|source coverage|source-backed|layers(?:_present)?\s*[:=]\s*\d+\/\d+|layers present|coverage\s*[:=])/i.test(text);
  const gaps = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/\b(NO_CLEAR_PICK|NO CLEAR PICK|NO CLEAR PICKS)\b/i.test(line)) continue;
    const window = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 5)).join('\n');
    const hasCoverage = hasGlobalCoverage || /(source layer coverage|source coverage|source-backed|layers(?:_present)?\s*[:=]\s*\d+\/\d+|layers present|coverage\s*[:=])/i.test(window);
    const hasCloseMargin = hasUfcClosenessSignal(window);
    if (!hasCoverage || !hasCloseMargin) {
      gaps.push({ line: i + 1, text: line.trim().slice(0, 180), hasCoverage, hasCloseMargin });
    }
  }
  return gaps;
}

function contradictionFindings(text) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const scoreMatch =
      line.match(/^\s*#?\d+\.?\s+.+?\s+—\s+P\(YES\)\s*(\d{1,3}|--)\s+—\s+(STRONG YES|WEAK YES|WEAK NO|STRONG NO|RESEARCH GAP)\b/i)
      || line.match(/\bP\(YES\)\s*[:=]?\s*(\d{1,3})\b/i)
      || line.match(/\|\s*(\d{1,3}|--)\s*\|\s*(STRONG YES|WEAK YES|WEAK NO|STRONG NO|RESEARCH GAP)\s*\|/i);
    if (!scoreMatch) continue;
    const score = scoreMatch[1] === '--' ? null : Number(scoreMatch[1]);
    const tier = String(scoreMatch[2] ?? '').toUpperCase();
    if (score !== null && score >= 65 && tier !== 'STRONG YES') {
      findings.push({ line: i + 1, reason: `high P(YES) ${score} paired with ${tier || 'missing'} tier` });
    }
    if (score !== null && score < 35 && tier !== 'STRONG NO') {
      findings.push({ line: i + 1, reason: `low P(YES) ${score} paired with ${tier || 'missing'} tier` });
    }
  }
  return findings;
}

function validateLedger(context, errors, warnings) {
  if (!context.requireLedger) return;
  const ledgerPath = context.ledgerPath;
  if (!ledgerPath || !existsSync(ledgerPath)) {
    errors.push({
      code: 'IDEMPOTENCY_LEDGER_MISSING',
      message: 'missing idempotency ledger; duplicate-send state is uncertain',
    });
    return;
  }
  const ledger = readJsonIfExists(ledgerPath);
  if (!ledger || typeof ledger !== 'object') {
    errors.push({
      code: 'IDEMPOTENCY_LEDGER_INVALID',
      message: 'idempotency ledger is unreadable; duplicate-send state is uncertain',
    });
    return;
  }
  if (!ledger.delivered || typeof ledger.delivered !== 'object') {
    warnings.push({
      code: 'IDEMPOTENCY_LEDGER_EMPTY_SHAPE',
      message: 'idempotency ledger exists but has no delivered object',
    });
  }
  const key = context.idempotencyKey;
  if (key && ledger.delivered?.[key] && !context.force) {
    errors.push({
      code: 'DUPLICATE_SEND_UNCERTAIN',
      message: `idempotency key already present in ledger: ${key}`,
    });
  }
}

function validateCustomerContract(text, context, errors, warnings) {
  const packetType = context.packetType ?? 'unknown';
  if (/mlb-composite/i.test(packetType) || /composite-refresh/i.test(context.filePath ?? '')) {
    if (!/Captain MLB|MLB/i.test(text) || !/Composite/i.test(text)) {
      errors.push({ code: 'MLB_COMPOSITE_HEADER_MISSING', message: 'MLB composite packet missing MLB/composite header' });
    }
    if (!/no trades|no bets placed|no trades executed/i.test(text)) {
      errors.push({ code: 'NO_TRADE_STATEMENT_MISSING', message: 'MLB composite packet missing no-trade statement' });
    }
    return;
  }

  const cpc = validateCpcCustomerPacket(text);
  if (!cpc.valid) {
    for (const error of cpc.errors) {
      errors.push({ code: 'CPC_CONTRACT_VIOLATION', message: error });
    }
  }
  if (text.length > TELEGRAM_DOC_SAFE_CHARS && !context.documentDelivery) {
    warnings.push({
      code: 'OVERSIZED_PACKET',
      message: 'packet exceeds safe message length; deliver as .txt document or clean chunks',
    });
  }
}

export function validatePacketText(text, context = {}) {
  const errors = [];
  const warnings = [];
  const packetType = inferPacketType(context.filePath, context.packetType);

  if (!text || typeof text !== 'string' || !text.trim()) {
    errors.push({ code: 'EMPTY_OR_MISSING_PACKET', message: 'packet text is empty or missing' });
    return {
      ok: false,
      verdict: DELIVERY_VERDICTS.JANITOR_BLOCKED,
      packetType,
      errors,
      warnings,
    };
  }

  if (WRAPPER_RE.test(text)) {
    errors.push({
      code: 'WRAPPER_TEXT_PRESENT',
      message: 'cron/Hermes wrapper text is present before delivery',
    });
  }

  if (DRY_RUN_RE.test(text)) {
    errors.push({
      code: candidateBodyStarts(text).length === 0 ? 'DRY_RUN_ONLY_OUTPUT' : 'DRY_RUN_CHATTER_PRESENT',
      message: candidateBodyStarts(text).length === 0
        ? 'dry-run/send-plan chatter found with no valid packet body'
        : 'dry-run/send-plan chatter is present in packet output',
    });
  }

  if (hasModelScaffoldLeak(text, packetType)) {
    errors.push({
      code: 'MODEL_SCAFFOLD_LEAKAGE',
      message: 'model scaffold or legacy customer-output language leaked into packet',
    });
  }

  const noSourceEvidence = noUsableSourceEvidenceFinding(text, packetType);
  if (noSourceEvidence) {
    // Soft send-time gate: a mentions packet with zero source-backed terms is
    // an honest research gap, not an invalid packet — the renderer already
    // disclosed it plainly (this finding only fires on that disclosure text,
    // meaning identity/malformed-output/render checks below all already
    // passed). Per product rule, missing research depth degrades the packet
    // (JANITOR_WARNING — still delivered) rather than suppressing it; only
    // identity mismatch, malformed output, duplicate delivery, and price
    // leakage (checked separately below) remain hard blocks.
    warnings.push(noSourceEvidence);
  }

  const alphaPending = mlbAlphaPendingFinding(text, packetType);
  if (alphaPending) {
    errors.push(alphaPending);
  }

  const leaks = priceLeaksInScoring(text);
  if (leaks.length) {
    errors.push({
      code: 'MARKET_PRICE_IN_SCORING_SECTION',
      message: 'raw market price/liquidity text appears inside scoring/rationale/model section',
      details: leaks,
    });
  }

  const nascarGate = evaluateNascarPacketText(text, {
    packetType,
    packetPath: context.filePath,
  });
  if (!nascarGate.ok) {
    errors.push(...nascarGate.errors);
  }

  const noClear = countNoClear(text);
  if (noClear.total >= 3 && noClear.ratio >= 0.6 && !hasNoClearJustification(text, packetType)) {
    errors.push({
      code: 'HIGH_NO_CLEAR_PICK_RATIO_WITHOUT_EXPLANATION',
      message: `research gap ratio ${noClear.noClear}/${noClear.total} requires research-backed coverage and gap explanation`,
    });
  }
  const ufcNoClearMissing = /ufc/i.test(packetType) ? ufcNoClearGaps(text) : [];
  if (/ufc/i.test(packetType) && ufcNoClearMissing.length) {
    errors.push({
      code: 'UFC_NO_CLEAR_WITHOUT_CLOSE_MARGIN_COVERAGE',
      message: 'UFC no-clear requires close composite margin and sufficient source coverage',
      details: ufcNoClearMissing,
    });
  }

  const contradictions = contradictionFindings(text);
  if (contradictions.length) {
    errors.push({
      code: 'CONTRADICTORY_SCORE_POSTURE',
      message: 'score and posture contradict each other',
      details: contradictions,
    });
  }

  validateLedger({ ...context, packetType }, errors, warnings);
  const source_health = validateSourceHealth({ ...context, packetType, packetText: text }, errors, warnings);
  validateCustomerContract(text, { ...context, packetType }, errors, warnings);

  const verdict = errors.length
    ? DELIVERY_VERDICTS.JANITOR_BLOCKED
    : warnings.length
      ? DELIVERY_VERDICTS.JANITOR_WARNING
      : DELIVERY_VERDICTS.SEND_ALLOWED;

  return {
    ok: !errors.length,
    verdict,
    packetType,
    no_clear: noClear,
    source_health,
    errors,
    warnings,
  };
}

function chunkCleanPacket(filePath, text) {
  if (text.length <= TELEGRAM_DOC_SAFE_CHARS) return [];
  const dir = dirname(filePath);
  const stem = basename(filePath, extname(filePath));
  const chunks = [];
  let rest = text;
  while (rest.length > TELEGRAM_DOC_SAFE_CHARS) {
    let cut = rest.lastIndexOf('\n', TELEGRAM_DOC_SAFE_CHARS);
    if (cut < TELEGRAM_DOC_SAFE_CHARS / 2) cut = TELEGRAM_DOC_SAFE_CHARS;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.trim()) chunks.push(rest.trimEnd());
  const paths = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const out = join(dir, `${stem}.janitor.chunk-${i + 1}.txt`);
    atomicWriteText(out, `[part ${i + 1}/${chunks.length}]\n${chunks[i]}\n`);
    paths.push(out);
  }
  return paths;
}

function rebuildMetaIfMissing(filePath, text, context) {
  const metaPath = filePath.replace(/\.txt$/i, '.meta.json');
  if (!/\.txt$/i.test(filePath) || existsSync(metaPath)) return null;
  atomicWriteJson(metaPath, {
    generated_at: nowIso(),
    rebuilt_by: JANITOR_VERSION,
    source_txt: filePath,
    sha256: sha256(text),
    char_count: text.length,
    no_trades_placed: true,
    packet_type: inferPacketType(filePath, context.packetType),
  });
  return metaPath;
}

function writeJanitorArtifacts(result, context) {
  const date = context.date ?? inferDateFromPath(context.filePath);
  const outDir = janitorDir(context.stateRoot, date);
  const stem = safeSlug(context.idempotencyKey ?? basename(context.filePath ?? 'packet'));
  const sidecarPath = join(outDir, `${stem}.janitor.json`);
  const debugPath = join(outDir, `${stem}.debug.txt`);
  const record = {
    schema: JANITOR_VERSION,
    generated_utc: nowIso(),
    date,
    packet_type: result.packetType ?? context.packetType ?? 'unknown',
    file: context.filePath ? resolve(context.filePath) : null,
    file_relative: context.filePath ? relative(process.cwd(), resolve(context.filePath)) : null,
    idempotency_key: context.idempotencyKey ?? null,
    verdict: result.verdict,
    repair_attempted: result.repair_attempted ?? false,
    repair_attempt_count: result.repair_attempt_count ?? 0,
    repair_rule: result.repair_rule ?? null,
    repaired_path: result.repaired_path ?? null,
    original_sha256: result.original_sha256 ?? null,
    repaired_sha256: result.repaired_sha256 ?? null,
    meta_rebuilt_path: result.meta_rebuilt_path ?? null,
    chunk_paths: result.chunk_paths ?? [],
    generator_result: result.generator_result ?? null,
    source_health: result.source_health ?? [],
    errors: result.errors ?? [],
    warnings: result.warnings ?? [],
    no_clear: result.no_clear ?? null,
  };
  atomicWriteJson(sidecarPath, record);
  result.sidecar_path = sidecarPath;
  if (result.verdict === DELIVERY_VERDICTS.JANITOR_BLOCKED) {
    const lines = [
      `schema: ${JANITOR_VERSION}`,
      `generated_utc: ${record.generated_utc}`,
      `verdict: ${record.verdict}`,
      `file: ${record.file_relative ?? record.file ?? '(none)'}`,
      `idempotency_key: ${record.idempotency_key ?? '(none)'}`,
      '',
      'errors:',
      ...record.errors.map((err) => `- ${err.code}: ${err.message}`),
      '',
      'warnings:',
      ...(record.warnings.length ? record.warnings.map((warn) => `- ${warn.code}: ${warn.message}`) : ['- none']),
    ];
    atomicWriteText(debugPath, `${lines.join('\n')}\n`);
    result.debug_path = debugPath;
  }
  return record;
}

function updateManifest(record, context) {
  const date = context.date ?? inferDateFromPath(context.filePath);
  const outDir = janitorDir(context.stateRoot, date);
  const manifestPath = join(outDir, 'delivery-manifest.json');
  const manifest = readJsonIfExists(manifestPath) ?? {
    schema: JANITOR_VERSION,
    date,
    generated_utc: nowIso(),
    entries: [],
  };
  manifest.updated_utc = nowIso();
  manifest.entries = (manifest.entries ?? []).filter((entry) =>
    !(entry.file === record.file && entry.idempotency_key === record.idempotency_key));
  manifest.entries.push(record);
  atomicWriteJson(manifestPath, manifest);
  return manifestPath;
}

function runGeneratorOnce(context) {
  const generator = context.generatorCommand;
  if (!generator?.length) return null;
  const [cmd, ...args] = generator;
  const result = spawnSync(cmd, args, {
    cwd: context.cwd ?? process.cwd(),
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    command: generator.join(' '),
    status: result.status,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    ok: result.status === 0,
  };
}

export function inspectPacketFile(filePath, options = {}) {
  const context = {
    ...options,
    filePath,
    date: options.date ?? inferDateFromPath(filePath),
    packetType: inferPacketType(filePath, options.packetType),
  };
  const dryRun = context.dryRun === true;
  let text = readTextIfExists(filePath);
  let generator_result = null;
  if (text == null && options.generatorCommand && !options.generatorAlreadyRan) {
    generator_result = runGeneratorOnce(context);
    text = readTextIfExists(filePath);
  }

  const originalText = text ?? '';
  const original_sha256 = text == null ? null : sha256(text);
  let result = validatePacketText(text, context);
  result.original_sha256 = original_sha256;
  result.generator_result = generator_result;

  if (!result.ok && text != null && options.allowRepair !== false) {
    const repair = applyOneSafeRepair(text, context);
    if (repair) {
      const repairedValidation = validatePacketText(repair.text, {
        ...context,
        repairRule: repair.rule,
      });
      result.repair_attempted = true;
      result.repair_attempt_count = MAX_REPAIR_ATTEMPTS;
      result.repair_rule = repair.rule;
      if (repairedValidation.ok) {
        const repairedPath = filePath.replace(/\.txt$/i, '.janitor-repaired.txt');
        result = {
          ...repairedValidation,
          verdict: DELIVERY_VERDICTS.SEND_ALLOWED_AFTER_REPAIR,
          repair_attempted: true,
          repair_attempt_count: MAX_REPAIR_ATTEMPTS,
          repair_rule: repair.rule,
          repaired_path: dryRun ? null : repairedPath,
          repaired_sha256: sha256(repair.text),
          original_sha256,
          meta_rebuilt_path: null,
          chunk_paths: [],
          dry_run: dryRun,
        };
        if (!dryRun) {
          atomicWriteText(repairedPath, repair.text.endsWith('\n') ? repair.text : `${repair.text}\n`);
          const metaPath = rebuildMetaIfMissing(repairedPath, repair.text, context);
          const chunkPaths = chunkCleanPacket(repairedPath, repair.text);
          result.meta_rebuilt_path = metaPath;
          result.chunk_paths = chunkPaths;
        }
      } else {
        result.errors = [
          ...(result.errors ?? []),
          {
            code: 'REPAIR_ATTEMPT_FAILED',
            message: `one allowed repair (${repair.rule}) did not produce a valid packet`,
            validation_errors_after_repair: repairedValidation.errors,
          },
        ];
        result.verdict = DELIVERY_VERDICTS.JANITOR_BLOCKED;
      }
    }
  }

  if (dryRun) {
    result.dry_run = true;
    return result;
  }

  const record = writeJanitorArtifacts(result, context);
  result.manifest_path = updateManifest(record, context);
  return result;
}

function hasMentionBlockers(stateRoot, date) {
  const dir = resolve(stateRoot || 'state', 'mentions', date, 'blockers');
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((entry) => entry.endsWith('.json'));
}

export function inspectPacketDir(dir, options = {}) {
  const date = options.date ?? inferDateFromPath(dir);
  const packetType = inferPacketType(dir, options.packetType);
  const stateRoot = options.stateRoot ?? 'state';
  const entries = [];
  if (!existsSync(dir)) {
    const errors = [];
    if (/mentions/i.test(packetType) && hasMentionBlockers(stateRoot, date)) {
      const result = {
        ok: true,
        verdict: DELIVERY_VERDICTS.JANITOR_WARNING,
        packetType,
        errors: [],
        warnings: [{ code: 'MENTIONS_FAIL_CLOSED_WITH_BLOCKERS', message: 'no packet directory, but blocker artifacts exist' }],
      };
      const record = writeJanitorArtifacts(result, { ...options, date, stateRoot, packetType, filePath: dir, idempotencyKey: `${packetType}-missing-dir` });
      result.manifest_path = updateManifest(record, { ...options, date, stateRoot, filePath: dir });
      return { ok: true, verdict: result.verdict, entries: [result], manifest_path: result.manifest_path };
    }
    errors.push({ code: 'PACKET_DIRECTORY_MISSING', message: `packet directory missing: ${dir}` });
    const result = { ok: false, verdict: DELIVERY_VERDICTS.JANITOR_BLOCKED, packetType, errors, warnings: [] };
    const record = writeJanitorArtifacts(result, { ...options, date, stateRoot, packetType, filePath: dir, idempotencyKey: `${packetType}-missing-dir` });
    result.manifest_path = updateManifest(record, { ...options, date, stateRoot, filePath: dir });
    return { ok: false, verdict: result.verdict, entries: [result], manifest_path: result.manifest_path };
  }

  const files = readdirSync(dir)
    .filter((entry) =>
      entry.endsWith('.txt') &&
      !entry.endsWith('.inventory.txt') &&
      !/\.chunk-\d+\.txt$/i.test(entry) &&
      !/\.janitor(?:-repaired)?(?:\.chunk-\d+)?\.txt$/i.test(entry))
    .sort();

  if (!files.length && /mentions/i.test(packetType) && hasMentionBlockers(stateRoot, date)) {
    const result = {
      ok: true,
      verdict: DELIVERY_VERDICTS.JANITOR_WARNING,
      packetType,
      errors: [],
      warnings: [{ code: 'MENTIONS_FAIL_CLOSED_WITH_BLOCKERS', message: 'no deliverable mentions packet, but blocker artifacts explain fail-closed state' }],
    };
    const record = writeJanitorArtifacts(result, { ...options, date, stateRoot, packetType, filePath: dir, idempotencyKey: `${packetType}-fail-closed` });
    result.manifest_path = updateManifest(record, { ...options, date, stateRoot, filePath: dir });
    return { ok: true, verdict: result.verdict, entries: [result], manifest_path: result.manifest_path };
  }

  for (const file of files) {
    const full = join(dir, file);
    entries.push(inspectPacketFile(full, {
      ...options,
      date,
      packetType,
      stateRoot,
      idempotencyKey: options.idempotencyKey ?? basename(file, '.txt'),
    }));
  }
  const blocked = entries.some((entry) => entry.verdict === DELIVERY_VERDICTS.JANITOR_BLOCKED);
  const repaired = entries.some((entry) => entry.verdict === DELIVERY_VERDICTS.SEND_ALLOWED_AFTER_REPAIR);
  const warning = entries.some((entry) => entry.verdict === DELIVERY_VERDICTS.JANITOR_WARNING);
  return {
    ok: !blocked,
    verdict: blocked
      ? DELIVERY_VERDICTS.JANITOR_BLOCKED
      : repaired
        ? DELIVERY_VERDICTS.SEND_ALLOWED_AFTER_REPAIR
        : warning
          ? DELIVERY_VERDICTS.JANITOR_WARNING
          : DELIVERY_VERDICTS.SEND_ALLOWED,
    entries,
    manifest_path: entries[entries.length - 1]?.manifest_path ?? join(janitorDir(stateRoot, date), 'delivery-manifest.json'),
  };
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  const opts = {
    command,
    stateRoot: 'state',
    allowRepair: true,
    requireLedger: false,
    documentDelivery: true,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--file') opts.file = rest[++i];
    else if (a === '--dir') opts.dir = rest[++i];
    else if (a === '--date') opts.date = rest[++i];
    else if (a === '--state-root') opts.stateRoot = rest[++i];
    else if (a === '--packet-type' || a === '--type') opts.packetType = rest[++i];
    else if (a === '--ledger') opts.ledgerPath = rest[++i];
    else if (a === '--idempotency-key') opts.idempotencyKey = rest[++i];
    else if (a === '--require-ledger') opts.requireLedger = true;
    else if (a === '--require-source-health') opts.requireSourceHealth = true;
    else if (a === '--source-health') {
      if (!opts.sourceHealthPaths) opts.sourceHealthPaths = [];
      opts.sourceHealthPaths.push(rest[++i]);
    }
    else if (a === '--force') opts.force = true;
    else if (a === '--no-repair') opts.allowRepair = false;
    else if (a === '--generator-command') opts.generatorCommand = rest[++i].split(/\s+/).filter(Boolean);
    else if (a === '--cwd') opts.cwd = rest[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/cron/cpc-packet-janitor.mjs validate-file --file PATH [--date YYYY-MM-DD] [--type TYPE]',
    '  node scripts/cron/cpc-packet-janitor.mjs repair-file --file PATH [--date YYYY-MM-DD] [--type TYPE]',
    '  node scripts/cron/cpc-packet-janitor.mjs validate-dir --dir PATH [--date YYYY-MM-DD] [--type TYPE]',
    '  node scripts/cron/cpc-packet-janitor.mjs preflight --date YYYY-MM-DD --type TYPE [--state-root state]',
    '  node scripts/cron/cpc-packet-janitor.mjs postflight --date YYYY-MM-DD --type TYPE [--state-root state]',
  ].join('\n');
}

function defaultPacketDir(opts) {
  if (opts.dir) return resolve(opts.dir);
  if (!opts.date || !opts.packetType) throw new Error('preflight/postflight require --date and --type unless --dir is provided');
  return resolve(opts.stateRoot, 'packets', opts.date, opts.packetType);
}

async function main() {
  const opts = parseCli(process.argv.slice(2));
  if (!opts.command || opts.help) {
    console.log(usage());
    return;
  }
  let result;
  if (opts.command === 'validate-file') {
    if (!opts.file) throw new Error('validate-file requires --file');
    result = inspectPacketFile(resolve(opts.file), opts);
  } else if (opts.command === 'repair-file') {
    if (!opts.file) throw new Error('repair-file requires --file');
    result = inspectPacketFile(resolve(opts.file), { ...opts, allowRepair: true });
  } else if (opts.command === 'validate-dir') {
    if (!opts.dir) throw new Error('validate-dir requires --dir');
    result = inspectPacketDir(resolve(opts.dir), opts);
  } else if (opts.command === 'preflight' || opts.command === 'postflight') {
    result = inspectPacketDir(defaultPacketDir(opts), opts);
  } else {
    throw new Error(`Unknown command: ${opts.command}`);
  }
  const line = [
    `verdict=${result.verdict}`,
    `ok=${result.ok}`,
    result.manifest_path ? `manifest=${result.manifest_path}` : null,
  ].filter(Boolean).join(' ');
  console.log(line);
  if (result.entries) {
    for (const entry of result.entries) {
      console.log(`- ${entry.verdict} ${entry.sidecar_path ?? ''}${entry.debug_path ? ` debug=${entry.debug_path}` : ''}${entry.repaired_path ? ` repaired=${entry.repaired_path}` : ''}`);
    }
  } else {
    console.log(`sidecar=${result.sidecar_path ?? '(none)'}`);
    if (result.debug_path) console.log(`debug=${result.debug_path}`);
    if (result.repaired_path) console.log(`repaired=${result.repaired_path}`);
  }
  if (!result.ok) process.exitCode = 1;
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  main().catch((err) => {
    console.error(`cpc-packet-janitor failed: ${err.message}`);
    process.exit(1);
  });
}
