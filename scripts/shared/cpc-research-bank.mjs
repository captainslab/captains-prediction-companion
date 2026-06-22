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
