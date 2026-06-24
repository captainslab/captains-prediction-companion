// Append-only CPC research artifact bank.
// Historical memory only — NOT live truth. Banked source facts may be reused
// only with freshness checks; banked narrative informs style/continuity only
// and is never evidence. Market/price fields never enter the bank's lineage.
//
// Layout: state/research/<date>/<packet_family>/<packet_type>/<event_id>/
//   raw.perplexity.json  normalized.json  sanitized.json
//   builder-input.json   preview.txt      metadata.json

import fs from 'node:fs';
import path from 'node:path';

import { CPC_RESEARCH_ARTIFACT_SCHEMA } from './cpc-research-artifact-schema.mjs';
import { SANITIZER_VERSION } from './preview-artifact-sanitizer.mjs';

export const RESEARCH_BANK_FILES = Object.freeze({
  raw: 'raw.perplexity.json',
  normalized: 'normalized.json',
  sanitized: 'sanitized.json',
  builderInput: 'builder-input.json',
  preview: 'preview.txt',
  metadata: 'metadata.json',
});

export function researchBankRoot(root) {
  return root || path.join(process.cwd(), 'state', 'research');
}

function safeSegment(value, fallback) {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  // Keep path segments filesystem-safe and free of traversal.
  return text.replace(/[^A-Za-z0-9._:-]/g, '_');
}

export function researchBankDir({ date, packet_family, packet_type, event_id, root } = {}) {
  return path.join(
    researchBankRoot(root),
    safeSegment(date, 'undated'),
    safeSegment(packet_family, 'unknown_family'),
    safeSegment(packet_type, 'unknown_type'),
    safeSegment(event_id, 'unknown_event'),
  );
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Write the six lineage'd artifact files for one event into the bank.
 * Append-only: only this event's directory is created/rewritten; sibling
 * event directories are never deleted.
 *
 * @returns {{ dir: string, files: Record<string,string> }}
 */
export function writeResearchBankArtifacts({
  date,
  packet_family,
  packet_type,
  event_id,
  route,
  submarket,
  raw,
  normalized,
  sanitized,
  builderInput,
  previewText,
  lineage = {},
  root,
} = {}) {
  const dir = researchBankDir({ date, packet_family, packet_type, event_id, root });
  fs.mkdirSync(dir, { recursive: true });

  const files = {
    raw: path.join(dir, RESEARCH_BANK_FILES.raw),
    normalized: path.join(dir, RESEARCH_BANK_FILES.normalized),
    sanitized: path.join(dir, RESEARCH_BANK_FILES.sanitized),
    builderInput: path.join(dir, RESEARCH_BANK_FILES.builderInput),
    preview: path.join(dir, RESEARCH_BANK_FILES.preview),
    metadata: path.join(dir, RESEARCH_BANK_FILES.metadata),
  };

  writeJson(files.raw, raw ?? null);
  writeJson(files.normalized, normalized ?? null);
  writeJson(files.sanitized, sanitized ?? null);
  writeJson(files.builderInput, builderInput ?? null);
  fs.writeFileSync(files.preview, `${String(previewText ?? '')}\n`, 'utf8');

  const metadata = {
    generated_at: lineage.generated_at ?? sanitized?.generated_at ?? 'unavailable',
    source_id: lineage.source_id ?? sanitized?.source_id ?? 'perplexity',
    source_urls: lineage.source_urls ?? sanitized?.source_urls ?? [],
    source_titles: lineage.source_titles ?? sanitized?.source_titles ?? [],
    source_freshness: lineage.source_freshness ?? sanitized?.source_freshness ?? [],
    packet_family,
    packet_type,
    route: route ?? sanitized?.route ?? 'unavailable',
    submarket: submarket ?? sanitized?.submarket ?? 'unavailable',
    event_id,
    schema_version: CPC_RESEARCH_ARTIFACT_SCHEMA,
    sanitizer_version: SANITIZER_VERSION,
    narrative_is_evidence: false,
    note: 'Generated narrative is style/continuity only and is NOT evidence.',
  };
  writeJson(files.metadata, metadata);

  return { dir, files };
}

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// Days between two ISO-ish timestamps; returns null if either is unparseable.
function daysBetween(fromIso, toIso) {
  const a = new Date(fromIso);
  const b = new Date(toIso);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.abs(b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24);
}

/**
 * Classify how fresh a banked artifact is RELATIVE to a packet date.
 * The research bank is historical memory, NOT live truth: an artifact is only
 * treated as a confirmed fresh fact when its sources are recent AND its
 * generated_at is within the freshness window of the packet date. Anything
 * older, undated, or self-labeled stale is returned as a non-fresh status so
 * callers render it as labeled historical context, never as fresh evidence.
 *
 * @returns {{ status: 'fresh'|'aging'|'stale'|'unknown', fresh: boolean, reason: string }}
 */
export function classifyResearchFreshness({ metadata, sanitized, packetDate, freshWindowDays = 1, agingWindowDays = 7 } = {}) {
  const meta = metadata || {};
  const freshnessEntries = Array.isArray(meta.source_freshness)
    ? meta.source_freshness
    : Array.isArray(sanitized?.source_freshness)
      ? sanitized.source_freshness
      : [];
  const generatedAt = meta.generated_at ?? sanitized?.generated_at ?? 'unavailable';

  if (!generatedAt || generatedAt === 'unavailable') {
    return { status: 'unknown', fresh: false, reason: 'no generated_at timestamp on banked artifact' };
  }

  const labels = freshnessEntries
    .map((entry) => String(entry?.freshness ?? '').trim().toLowerCase())
    .filter(Boolean);
  const hasRecentLabel = labels.some((l) => l === 'same_day' || l === '1d');
  const allStaleOrUndated = labels.length > 0 && labels.every((l) => l === 'stale' || l === 'undated');

  // Age of the artifact relative to the packet date (or now if no packetDate).
  const reference = packetDate ? `${packetDate}T23:59:59Z` : new Date().toISOString();
  const ageDays = daysBetween(generatedAt, reference);

  if (allStaleOrUndated) {
    return { status: 'stale', fresh: false, reason: 'all banked sources are stale/undated' };
  }
  if (ageDays === null) {
    return { status: 'unknown', fresh: false, reason: 'unparseable timestamps' };
  }
  if (ageDays <= freshWindowDays && (hasRecentLabel || labels.length === 0)) {
    return { status: 'fresh', fresh: true, reason: `artifact within ${freshWindowDays}d of packet date` };
  }
  if (ageDays <= agingWindowDays) {
    return { status: 'aging', fresh: false, reason: `artifact ${ageDays.toFixed(1)}d old; within aging window` };
  }
  return { status: 'stale', fresh: false, reason: `artifact ${ageDays.toFixed(1)}d old; beyond ${agingWindowDays}d` };
}

/**
 * Read a banked artifact for one event, if present. Returns the sanitized
 * artifact, its lineage metadata, and a freshness classification. Returns null
 * when no artifact has been banked for the identity. Never throws on missing
 * or malformed files — a missing artifact is a clean "no research" signal.
 *
 * @returns {{ dir: string, sanitized: object|null, metadata: object|null, builderInput: object|null, previewText: string|null, freshness: object }|null}
 */
export function readResearchBankArtifact({ date, packet_family, packet_type, event_id, root, freshWindowDays, agingWindowDays } = {}) {
  const dir = researchBankDir({ date, packet_family, packet_type, event_id, root });
  const sanitized = readJsonIfExists(path.join(dir, RESEARCH_BANK_FILES.sanitized));
  const metadata = readJsonIfExists(path.join(dir, RESEARCH_BANK_FILES.metadata));
  if (!sanitized && !metadata) return null;

  let previewText = null;
  try {
    const p = path.join(dir, RESEARCH_BANK_FILES.preview);
    if (fs.existsSync(p)) previewText = fs.readFileSync(p, 'utf8');
  } catch {
    previewText = null;
  }

  const freshness = classifyResearchFreshness({
    metadata,
    sanitized,
    packetDate: date,
    freshWindowDays,
    agingWindowDays,
  });

  return {
    dir,
    sanitized: sanitized ?? null,
    metadata: metadata ?? null,
    builderInput: readJsonIfExists(path.join(dir, RESEARCH_BANK_FILES.builderInput)),
    previewText,
    freshness,
  };
}
