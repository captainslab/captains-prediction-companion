#!/usr/bin/env node
// Packet sender — script-owned Telegram delivery, no LLM agent.
//
// Reads state/packets/<date>/<type>/ produced by the matching
// scripts/packets/generate-<type>.mjs and delivers one message per
// packet. Mentions packets are sent as a short notice plus one .txt document;
// other packet types may still use pre-split .chunk-N.txt files when present.
//
// Rules:
//   * .inventory.txt and *.meta.json are audit artifacts — never delivered.
//   * Idempotent: a delivery ledger in the packet dir records sent files;
//     re-runs skip anything already delivered.
//   * No-events day -> a single short status message, also ledger-guarded.
//   * Routine output goes to stdout (cron wrapper logs it). Hard failures go
//     to stderr with a non-zero exit so cron alerting fires.
//   * No trades. No bankroll advice. Sender never edits packet content.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  DELIVERY_VERDICTS,
  inspectPacketFile,
} from '../cron/cpc-packet-janitor.mjs';
import {
  NASCAR_PACKET_INCOMPLETE,
  evaluateNascarPacketText,
} from '../nascar/lib/race-quality-gate.mjs';

const TELEGRAM_SAFE_CHARS = 3500;

const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const checkOnly = args.includes('--check-only');
const documentOnly = args.includes('--document-only');
const customCaption = argValue('--caption');
const customIdempotencyKey = argValue('--idempotency-key');
const date = argValue('--date') || new Date().toISOString().slice(0, 10);
const stateRoot = argValue('--state-root') || 'state';
const packetType = argValue('--type') || 'mentions-daily';
// --only stem1,stem2 — deliver ONLY these packet stems (e.g. 2026-06-11-KXFOO-26JUN11).
// Incremental callers (mentions-watch) must scope sends this way so stale or
// out-of-scope artifacts sitting in the same dir can never ride along.
const onlyStems = (() => {
  const v = argValue('--only');
  if (!v) return null;
  return new Set(String(v).split(',').map(s => s.trim()).filter(Boolean));
})();
// --exclude stem1,stem2 — drop these stems from the final delivery plan.
// This is applied after --only so callers can pass a narrow allow-list and
// then carve out a manual hold list without changing the delivery ledger.
const excludeStems = (() => {
  const v = argValue('--exclude');
  if (!v) return null;
  return new Set(String(v).split(',').map(s => s.trim()).filter(Boolean));
})();
const correctionMode = Boolean(customCaption || customIdempotencyKey || documentOnly || checkOnly);

function validateCorrectionOptions() {
  if (!correctionMode) return;
  if (packetType !== 'nascar-sunday') throw new Error('correction delivery options are supported only for --type nascar-sunday');
  if (!onlyStems || onlyStems.size !== 1) throw new Error('correction delivery requires exactly one --only packet stem');
  if (!customCaption || !customIdempotencyKey || !documentOnly) {
    throw new Error('correction delivery requires --caption, --idempotency-key, and --document-only');
  }
  if (force) throw new Error('correction delivery refuses --force');
  if (dryRun && checkOnly) throw new Error('use --check-only without --dry-run');
}

// Load env from project .env if present (same pattern as scripts/mlb/_send-due.mjs)
function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    const v = m[2].replace(/^['"]|['"]$/g, '');
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}
let envLoaded = false;
function loadTelegramEnvOnce() {
  if (envLoaded) return;
  envLoaded = true;
  loadEnv('.env');
  loadEnv('.env.local');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const SEND_PACING_MS = 1500; // stay under Telegram's per-chat rate limit

function resolveTelegramEnv() {
  loadTelegramEnvOnce();
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_HOME_CHANNEL;
  if (!token || !chat) throw new Error('telegram env missing (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)');
  return { token, chat };
}

export async function tgSendMessage(text, { fetchImpl = fetch, sleepImpl = sleep } = {}) {
  const { token, chat } = resolveTelegramEnv();
  for (let attempt = 1; ; attempt += 1) {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    });
    let j = null;
    let bodyText = '';
    try {
      j = await res.json();
    } catch {
      try {
        bodyText = await res.text();
      } catch {
        bodyText = '';
      }
    }
    if (j?.ok) return j.result.message_id;
    const retryAfter = Number(
      j?.parameters?.retry_after ??
      j?.retry_after ??
      res.headers?.get?.('retry-after') ??
      res.headers?.get?.('Retry-After'),
    );
    const rateLimited = res.status === 429 || j?.error_code === 429;
    if (rateLimited && attempt <= 3 && Number.isFinite(retryAfter)) {
      console.log(`telegram 429: waiting ${retryAfter}s (attempt ${attempt}/3)`);
      await sleepImpl((retryAfter + 1) * 1000);
      continue;
    }
    throw new Error('telegram fail: ' + JSON.stringify(j ?? { status: res.status, body: bodyText }));
  }
}

export async function tgSendDocument(filePath, { caption = '', fetchImpl = fetch, sleepImpl = sleep } = {}) {
  const { token, chat } = resolveTelegramEnv();
  for (let attempt = 1; ; attempt += 1) {
    const body = new FormData();
    body.set('chat_id', chat);
    if (caption) body.set('caption', caption);
    body.set('document', new Blob([readFileSync(filePath)], { type: 'text/plain' }), basename(filePath));
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendDocument`, {
      method: 'POST',
      body,
    });
    let j = null;
    let bodyText = '';
    try {
      j = await res.json();
    } catch {
      try {
        bodyText = await res.text();
      } catch {
        bodyText = '';
      }
    }
    if (j?.ok) return j.result.message_id;
    const retryAfter = Number(
      j?.parameters?.retry_after ??
      j?.retry_after ??
      res.headers?.get?.('retry-after') ??
      res.headers?.get?.('Retry-After'),
    );
    const rateLimited = res.status === 429 || j?.error_code === 429;
    if (rateLimited && attempt <= 3 && Number.isFinite(retryAfter)) {
      console.log(`telegram 429: waiting ${retryAfter}s (attempt ${attempt}/3)`);
      await sleepImpl((retryAfter + 1) * 1000);
      continue;
    }
    throw new Error('telegram sendDocument fail: ' + JSON.stringify(j ?? { status: res.status, body: bodyText }));
  }
}

function chunkText(text) {
  if (text.length <= TELEGRAM_SAFE_CHARS) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > TELEGRAM_SAFE_CHARS) {
    let cut = rest.lastIndexOf('\n', TELEGRAM_SAFE_CHARS);
    if (cut < TELEGRAM_SAFE_CHARS / 2) cut = TELEGRAM_SAFE_CHARS;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function planDeliveries(dir, dateStr, options = {}) {
  // Returns [{ name, files }] — one entry per event packet, in stable order.
  // Audit artifacts (.inventory.txt, *.meta.json) are excluded by design.
  const preferBaseFile = options.preferBaseFile === true;
  // Most packet types name files <date>-...; worldcup-matchday uses
  // worldcup-<date>-... — accept either, still pinned to the requested date.
  const prefixes = options.prefixes ?? [`${dateStr}-`, `worldcup-${dateStr}-`];
  const all = readdirSync(dir).sort();
  const bases = all.filter((f) =>
    prefixes.some((p) => f.startsWith(p)) &&
    f.endsWith('.txt') &&
    !f.endsWith('.inventory.txt') &&
    !/\.chunk-\d+\.txt$/.test(f),
  );
  const plan = [];
  for (const base of bases) {
    const stem = base.replace(/\.txt$/, '');
    const chunks = all
      .filter((f) => f.startsWith(`${stem}.chunk-`) && f.endsWith('.txt'))
      .sort((a, b) => {
        const na = Number(a.match(/\.chunk-(\d+)\.txt$/)[1]);
        const nb = Number(b.match(/\.chunk-(\d+)\.txt$/)[1]);
        return na - nb;
      });
    plan.push({ name: stem, files: preferBaseFile ? [base] : (chunks.length ? chunks : [base]) });
  }
  return plan;
}

export function filterDeliveryPlan(plan, { onlyStems = null, excludeStems = null } = {}) {
  return plan.filter((entry) => {
    if (onlyStems && !onlyStems.has(entry.name)) return false;
    if (excludeStems && excludeStems.has(entry.name)) return false;
    return true;
  });
}

export function filterAlreadyDeliveredPlan(plan, ledger, { force = false } = {}) {
  return plan.filter((entry) => force || !ledger.delivered[entry.name]);
}

function isMentionsPacketType(type) {
  return type === 'mentions-daily' || type === 'mentions-watchlist';
}

// All CPC packet types are delivered as one short notice + the base .txt as
// an attached document (never chunked text messages). This is the uniform
// CPC customer packet delivery contract.
const CPC_DOCUMENT_TYPES = new Set([
  'mentions-daily',
  'mentions-watchlist',
  'worldcup-matchday',
  'nascar-sunday',
  'ufc-weekly',
  'mlb-daily',
]);

function isDocumentPacketType(type) {
  return CPC_DOCUMENT_TYPES.has(type);
}

function buildJanitorOptions({ packetType, dryRun, ledgerPath, force }) {
  return {
    requireLedger: dryRun ? existsSync(ledgerPath) : true,
    requireSourceHealth: packetType === 'mlb-daily' ? false : true,
    documentDelivery: isDocumentPacketType(packetType),
    force,
    dryRun,
  };
}

function logDryRunVerdict(entryName, janitor, { notice = null, documentName = null, pieceCount = null } = {}) {
  const wouldBlock = janitor.verdict === DELIVERY_VERDICTS.JANITOR_BLOCKED;
  console.log(`[dry-run] would-block=${wouldBlock ? 'YES' : 'NO'} entry=${entryName} verdict=${janitor.verdict}`);
  console.log(
    `[dry-run] would-send=${wouldBlock ? 'NO' : 'YES'}` +
    `${notice ? ` notice=${notice}` : ''}` +
    `${documentName ? ` document=${documentName}` : ''}` +
    `${pieceCount != null ? ` pieces=${pieceCount}` : ''}`,
  );
}

export function cpcPacketCaption(packetText = '', stem = '', packetType = '') {
  const lines = packetText.split(/\r?\n/).map(line => line.trim());
  const eventLine = lines.find(line =>
    /^Event title:/i.test(line) ||
    /^#\s*Event:/i.test(line));
  const gameTitleLine = lines.find(line =>
    /^Captain MLB\s*[—-]\s*.+\s+Game Board$/i.test(line));
  const slateTitleLine = lines.find(line =>
    /^Captain MLB\s*[—-]\s*(?:CPC Packet:\s*)?Daily Slate Board$/i.test(line));
  const packetLine = lines.find(line =>
    /^=== .*CPC Packet:/i.test(line) ||
    /^=== .*Mentions/i.test(line));
  const source = eventLine || gameTitleLine || slateTitleLine || packetLine || stem;
  let label = source
    .replace(/^Event title:\s*/i, '')
    .replace(/^#\s*Event:\s*/i, '')
    .replace(/^===\s*/, '')
    .replace(/\s*===\s*$/, '')
    .replace(/^Captain\s+\w+\s*[—-]\s*/i, '')
    .replace(/^CPC Packet:\s*/i, '')
    .replace(/^Daily Decision Board:\s*/i, '')
    .trim();
  if (gameTitleLine) {
    const m = gameTitleLine.match(/^Captain MLB\s*[—-]\s*(.+\s+Game Board)$/i);
    if (m?.[1]) label = m[1].trim();
  } else if (slateTitleLine) {
    label = 'Daily Slate Board';
  }
  if (/trump/i.test(source) && /tele-rally/i.test(source)) label = 'Trump Tele-Rally';
  if (!label) label = stem;
  return `New CPC packet: ${label} -- attached .txt`;
}

export function mentionsPacketNotice(packetText = '', stem = '') {
  return cpcPacketCaption(packetText, stem, 'mentions');
}

function loadLedger(path) {
  if (!existsSync(path)) return { delivered: {} };
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { delivered: {} };
  }
}

function saveLedger(path, ledger) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(ledger, null, 2));
  renameSync(tmp, path);
}

function ensureLedgerFile(path, ledger) {
  if (existsSync(path)) return;
  saveLedger(path, {
    ...ledger,
    schema: 'cpc_packet_delivery_ledger_v1',
    created_utc: new Date().toISOString(),
    delivered: ledger.delivered ?? {},
  });
}

function janitorAlert(entryName, janitor) {
  return `JANITOR_BLOCKED ${entryName}: ${janitor.errors?.[0]?.code ?? 'PACKET_QC_FAILED'}`;
}

// ---------------------------------------------------------------------------
// Slate-expiry gate — fail closed when a game has already started.
//
// A CPC packet is a PRE-GAME read. Once first pitch has passed the packet is no
// longer deliverable, so delivery must fail closed: never send, never mark the
// packet delivered, and record why it was blocked. Detection is delivery-time
// only and reads solely the customer text (no market/price data).
// ---------------------------------------------------------------------------

// Returns { present, ms, raw } for the packet's "First pitch: <ISO>Z" line.
// present=false → no such line (gate not applicable). ms=NaN → line present but
// unparseable (fail closed).
export function parseFirstPitchUtc(packetText) {
  const text = packetText ?? '';
  if (!/First pitch:/i.test(text)) return { present: false, ms: null, raw: null };
  const m = /First pitch:\s*(\S+)/i.exec(text);
  const raw = m ? m[1] : null;
  const ms = raw ? Date.parse(raw) : NaN;
  return { present: true, ms: Number.isFinite(ms) ? ms : NaN, raw };
}

function parseMatchup(packetText) {
  const text = packetText ?? '';
  const titled = /Captain MLB\s*[—-]\s*(.+?)\s+(?:CPC Read|Pre-Final-Lineup|Game Board)\b/.exec(text);
  if (titled) return titled[1].trim();
  const bare = /^([A-Za-z .'()-]+ at [A-Za-z .'()-]+)\s*$/m.exec(text);
  return bare ? bare[1].trim() : 'unknown matchup';
}

function parseGameDate(packetText) {
  const m = /Date:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/.exec(packetText ?? '');
  return m ? m[1] : 'unknown date';
}

// Pure decision: is this packet's slate still deliverable at nowMs?
export function evaluateSlateExpiry({ packetText, nowMs }) {
  const fp = parseFirstPitchUtc(packetText);
  if (!fp.present) {
    return { blocked: false, verdict: DELIVERY_VERDICTS.SEND_ALLOWED, firstPitchUtc: null, reason: null };
  }
  if (!Number.isFinite(fp.ms)) {
    return {
      blocked: true,
      verdict: DELIVERY_VERDICTS.EXPIRED_SLATE_BLOCKED,
      firstPitchUtc: null,
      reason: 'unparseable first pitch (fail-closed)',
    };
  }
  const firstPitchUtc = new Date(fp.ms).toISOString();
  if (fp.ms <= nowMs) {
    return {
      blocked: true,
      verdict: DELIVERY_VERDICTS.EXPIRED_SLATE_BLOCKED,
      firstPitchUtc,
      reason: `${parseMatchup(packetText)} (${parseGameDate(packetText)}) already started at ${firstPitchUtc} — EXPIRED_SLATE_BLOCKED`,
    };
  }
  return { blocked: false, verdict: DELIVERY_VERDICTS.SEND_ALLOWED, firstPitchUtc, reason: null };
}

export function evaluateNascarRaceExpiry({ packetText, nowMs }) {
  const match = /^official_start_utc:\s*(\S+)\s*$/im.exec(packetText ?? '');
  if (!match) {
    return {
      blocked: true,
      verdict: DELIVERY_VERDICTS.EXPIRED_SLATE_BLOCKED,
      firstPitchUtc: null,
      reason: 'NASCAR official_start_utc is missing (fail-closed)',
    };
  }
  const startMs = Date.parse(match[1]);
  if (!Number.isFinite(startMs)) {
    return {
      blocked: true,
      verdict: DELIVERY_VERDICTS.EXPIRED_SLATE_BLOCKED,
      firstPitchUtc: null,
      reason: 'NASCAR official_start_utc is unparseable (fail-closed)',
    };
  }
  const startUtc = new Date(startMs).toISOString();
  if (startMs <= nowMs) {
    return {
      blocked: true,
      verdict: DELIVERY_VERDICTS.EXPIRED_SLATE_BLOCKED,
      firstPitchUtc: startUtc,
      reason: `NASCAR race already started at ${startUtc} — EXPIRED_SLATE_BLOCKED`,
    };
  }
  return { blocked: false, verdict: DELIVERY_VERDICTS.SEND_ALLOWED, firstPitchUtc: startUtc, reason: null };
}

// Deliver one document-type packet entry. Runs the slate-expiry gate FIRST, so
// an expired slate never reaches the janitor or Telegram and is never marked
// delivered. Send functions are injectable for testing. Returns a status:
// 'sent' | 'blocked_expired' | 'blocked_janitor' | 'dryrun'.
export async function deliverDocumentEntry({
  entry,
  dir,
  packetType,
  date,
  stateRoot,
  ledgerPath,
  ledger,
  force,
  dryRun,
  pace = false,
  nowMs = Date.now(),
  sendMessage = tgSendMessage,
  sendDocument = tgSendDocument,
  inspect = inspectPacketFile,
  idempotencyKey = entry.name,
  caption = null,
  documentOnly = false,
  checkOnly = false,
  correctionMode = false,
}) {
  const fileName = entry.files.find((f) => f === `${entry.name}.txt`) ?? entry.files[0];
  const filePath = join(dir, fileName);
  const packetText = readFileSync(filePath, 'utf8');

  const nascarPreflight = evaluateNascarPacketText(packetText, {
    packetType,
    packetPath: filePath,
    requirePersistedState: correctionMode,
    stateRoot,
    date,
  });
  if (!nascarPreflight.ok) {
    return {
      status: 'blocked_incomplete',
      verdict: DELIVERY_VERDICTS.JANITOR_BLOCKED,
      reason: nascarPreflight.errors.map((error) => error.code).join(', ') || NASCAR_PACKET_INCOMPLETE,
    };
  }

  // Fail-closed gate — before any janitor call or any Telegram request.
  const expiry = packetType === 'nascar-sunday'
    ? evaluateNascarRaceExpiry({ packetText, nowMs })
    : evaluateSlateExpiry({ packetText, nowMs });
  if (expiry.blocked) {
    console.error(`EXPIRED_SLATE_BLOCKED ${entry.name}: ${expiry.reason}`);
    if (!correctionMode) {
      ledger.blocked = ledger.blocked || {};
      ledger.blocked[entry.name] = {
        utc: new Date().toISOString(),
        verdict: expiry.verdict,
        reason: expiry.reason,
        first_pitch_utc: expiry.firstPitchUtc,
      };
      if (!dryRun) saveLedger(ledgerPath, ledger);
    }
    return { status: 'blocked_expired', verdict: expiry.verdict, reason: expiry.reason };
  }

  const janitor = inspect(filePath, {
    date,
    stateRoot,
    packetType,
    ledgerPath,
    idempotencyKey,
    ...buildJanitorOptions({
      packetType,
      dryRun: correctionMode ? true : dryRun,
      ledgerPath,
      force,
    }),
    ...(correctionMode ? { requireLedger: false, force: false, dryRun: true } : {}),
  });
  if (janitor?.verdict === DELIVERY_VERDICTS.JANITOR_BLOCKED) {
    console.error(`${janitorAlert(entry.name, janitor)} debug=${janitor.debug_path ?? '(none)'}`);
    return { status: 'blocked_janitor', verdict: janitor.verdict };
  }
  if (ledger.delivered?.[idempotencyKey]) {
    return {
      status: 'duplicate_suppressed',
      verdict: DELIVERY_VERDICTS.SEND_ALLOWED,
      idempotency_key: idempotencyKey,
    };
  }
  const deliveryPath = janitor?.repaired_path ?? filePath;
  const deliveryName = basename(deliveryPath);
  const text = readFileSync(deliveryPath, 'utf8');
  const notice = caption ?? cpcPacketCaption(text, entry.name, packetType);
  if (checkOnly) {
    return {
      status: 'check_only_ready',
      verdict: janitor?.verdict ?? DELIVERY_VERDICTS.SEND_ALLOWED,
      idempotency_key: idempotencyKey,
      notice,
      document_file: deliveryName,
    };
  }
  if (dryRun) {
    return {
      status: 'dryrun',
      verdict: janitor?.verdict ?? DELIVERY_VERDICTS.SEND_ALLOWED,
      notice,
      document_file: deliveryName,
    };
  }
  if (pace) await sleep(SEND_PACING_MS);
  let noticeId = null;
  if (!documentOnly) {
    noticeId = await sendMessage(notice);
    await sleep(SEND_PACING_MS);
  }
  const documentId = await sendDocument(deliveryPath, documentOnly ? { caption: notice } : undefined);
  ledger.delivered = ledger.delivered || {};
  ledger.delivered[idempotencyKey] = {
    utc: new Date().toISOString(),
    message_ids: noticeId === null ? [documentId] : [noticeId, documentId],
    notice_message_id: noticeId ?? undefined,
    document_message_id: documentId,
    document_file: deliveryName,
    delivery_mode: 'document_txt',
    janitor_verdict: janitor.verdict,
    janitor_sidecar: janitor.sidecar_path,
    janitor_repaired_path: janitor.repaired_path ?? undefined,
    forced: force || undefined,
    source_packet_stem: entry.name,
    idempotency_key: idempotencyKey,
    caption: documentOnly ? notice : undefined,
    correction: correctionMode || undefined,
  };
  saveLedger(ledgerPath, ledger);
  return {
    status: 'sent',
    verdict: janitor.verdict,
    message_ids: noticeId === null ? [documentId] : [noticeId, documentId],
    document_message_id: documentId,
    idempotency_key: idempotencyKey,
    document_file: deliveryName,
  };
}

async function main() {
  validateCorrectionOptions();
  const dir = resolve(stateRoot, 'packets', date, packetType);
  const ledgerPath = join(dir, '.delivery-ledger.json');

  if (!existsSync(dir)) {
    if (correctionMode) throw new Error(`correction packet directory missing: ${dir}`);
    console.log(`${packetType} ${date}: no packet directory — nothing to send`);
    return;
  }

  const ledger = loadLedger(ledgerPath);
  if (correctionMode && (!existsSync(ledgerPath) || !ledger?.delivered || typeof ledger.delivered !== 'object')) {
    throw new Error('correction delivery requires an existing valid delivery ledger');
  }
  if (!dryRun && !checkOnly && !correctionMode) ensureLedgerFile(ledgerPath, ledger);
  let plan = planDeliveries(dir, date, { preferBaseFile: isDocumentPacketType(packetType) });

  if (onlyStems || excludeStems) {
    plan = filterDeliveryPlan(plan, { onlyStems, excludeStems });
    if (!plan.length) {
      if (correctionMode) throw new Error('correction --only stem matched no packet');
      console.log(`${packetType} ${date}: --only matched no packets — nothing to send`);
      if (dryRun) {
        console.log(`${packetType} ${date}: dry-run would_send=NO would_block=NO would_send_count=0 would_block_count=0 total_packets=0`);
      }
      return;
    }
  }

  const noEventsOnly = plan.length === 1 && plan[0].name === `${date}-no-events`;

  if (correctionMode && (plan.length !== 1 || noEventsOnly)) {
    throw new Error('correction delivery requires exactly one real event packet');
  }

  if (plan.length === 0 || noEventsOnly) {
    const key = `${date}-no-events-status`;
    if (ledger.delivered[key]) {
      console.log(`${packetType} ${date}: no-events status already delivered — skip`);
      return;
    }
    const msg = `${packetType} ${date}: no events discovered.`;
    if (dryRun) {
      console.log(`[dry-run] would send status: ${msg}`);
      console.log(`${packetType} ${date}: dry-run would_send=YES would_block=NO would_send_count=1 would_block_count=0 total_packets=1`);
      return;
    }
    await tgSendMessage(msg);
    ledger.delivered[key] = { utc: new Date().toISOString() };
    saveLedger(ledgerPath, ledger);
    console.log(`${packetType} ${date}: sent no-events status`);
    return;
  }

  if (!correctionMode) plan = filterAlreadyDeliveredPlan(plan, ledger, { force });

  let sent = 0;
  let skipped = 0;
  let wouldSend = 0;
  let wouldBlock = 0;
  const blockedEntries = [];
  for (const entry of plan) {
    if (entry.name === `${date}-no-events`) continue;
    if (!correctionMode && ledger.delivered[entry.name] && !force) {
      skipped += 1;
      continue;
    }
    if (isDocumentPacketType(packetType)) {
      const outcome = await deliverDocumentEntry({
        entry,
        dir,
        packetType,
        date,
        stateRoot,
        ledgerPath,
        ledger,
        force,
        dryRun,
        pace: sent > 0,
        idempotencyKey: correctionMode ? customIdempotencyKey : entry.name,
        caption: correctionMode ? customCaption : null,
        documentOnly: correctionMode ? documentOnly : false,
        checkOnly: correctionMode ? checkOnly : false,
        correctionMode,
      });
      if (outcome.status === 'sent') {
        sent += 1;
        console.log(correctionMode
          ? `sent ${entry.name} — 1 corrected document (${outcome.document_file}) document_id=${outcome.document_message_id} idempotency_key=${outcome.idempotency_key} janitor=${outcome.verdict}`
          : `sent ${entry.name} — notice + 1 document (${outcome.document_file}) janitor=${outcome.verdict}`);
      } else if (outcome.status === 'dryrun') {
        wouldSend += 1;
        logDryRunVerdict(entry.name, { verdict: outcome.verdict }, {
          notice: outcome.notice,
          documentName: outcome.document_file,
        });
      } else if (outcome.status === 'check_only_ready') {
        console.log(`CHECK_ONLY_READY idempotency_key=${outcome.idempotency_key} document=${outcome.document_file}`);
      } else if (outcome.status === 'duplicate_suppressed') {
        skipped += 1;
        console.log(`DUPLICATE_SUPPRESSED idempotency_key=${outcome.idempotency_key}`);
      } else if (outcome.status === 'blocked_expired' || outcome.status === 'blocked_janitor' || outcome.status === 'blocked_incomplete') {
        if (dryRun) {
          wouldBlock += 1;
          logDryRunVerdict(entry.name, { verdict: outcome.verdict });
        }
        blockedEntries.push(entry.name);
      }
      continue;
    }
    const pieces = [];
    for (const f of entry.files) {
      const filePath = join(dir, f);
      const janitor = inspectPacketFile(filePath, {
        date,
        stateRoot,
        packetType,
        ledgerPath,
        idempotencyKey: entry.name,
        ...buildJanitorOptions({ packetType, dryRun, ledgerPath, force }),
      });
      if (janitor?.verdict === DELIVERY_VERDICTS.JANITOR_BLOCKED) {
        if (dryRun) {
          wouldBlock += 1;
          logDryRunVerdict(entry.name, janitor, { pieceCount: entry.files.length });
        } else {
          console.error(`${janitorAlert(entry.name, janitor)} debug=${janitor.debug_path ?? '(none)'}`);
        }
        blockedEntries.push(entry.name);
        continue;
      }
      const deliveryPath = janitor?.repaired_path ?? filePath;
      const text = readFileSync(deliveryPath, 'utf8');
      pieces.push(...chunkText(text));
    }
    if (!pieces.length) continue;
    if (dryRun) {
      wouldSend += 1;
      logDryRunVerdict(entry.name, { verdict: DELIVERY_VERDICTS.SEND_ALLOWED }, { pieceCount: pieces.length });
      continue;
    }
    const ids = [];
    for (const piece of pieces) {
      if (ids.length || sent) await sleep(SEND_PACING_MS);
      ids.push(await tgSendMessage(piece));
    }
    ledger.delivered[entry.name] = { utc: new Date().toISOString(), message_ids: ids };
    saveLedger(ledgerPath, ledger);
    sent += 1;
    console.log(`sent ${entry.name} — ${ids.length} message(s)`);
  }
  if (dryRun) {
    console.log(`${packetType} ${date}: dry-run would_send=${wouldSend > 0 ? 'YES' : 'NO'} would_block=${wouldBlock > 0 ? 'YES' : 'NO'} would_send_count=${wouldSend} would_block_count=${wouldBlock} total_packets=${plan.length}`);
    return;
  }
  if (plan.length === 1 && blockedEntries.length === 1 && sent === 0) {
    throw new Error(`janitor blocked sole packet ${blockedEntries[0]}`);
  }
  if (checkOnly) {
    console.log(`${packetType} ${date}: check-only complete total_packets=${plan.length}`);
    return;
  }
  console.log(`${packetType} ${date}: delivered=${sent} skipped_already_delivered=${skipped} total_packets=${plan.length}`);
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isDirectRun) {
  main().catch((err) => {
    console.error(`${packetType} sender failed: ${err.message}`);
    process.exit(1);
  });
}
