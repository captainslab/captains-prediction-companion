/**
 * researchCache.js
 * In-memory + JSON-file cache for CPC sports research artifacts.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const CACHE_DIR = path.resolve(
  process.env.CPC_SPORTS_RESEARCH_CACHE_DIR
    || process.env.SPORTS_RESEARCH_CACHE_DIR
    || path.join('state', 'sports-research-cache'),
);

const memoryCache = new Map();

function cacheKey(sport, eventId) {
  return `${sport}::${eventId}`;
}

function ensureCacheDir() {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  } catch {
    // Non-fatal: file cache unavailable, memory-only mode.
  }
}

function artifactPath(key) {
  const safe = key.replace(/[^a-z0-9_\-:.]/gi, '_');
  return path.join(CACHE_DIR, `${safe}.json`);
}

function setArtifact(sport, eventId, artifact, ttlMs = DEFAULT_TTL_MS) {
  const key = cacheKey(sport, eventId);
  const expiresAt = Date.now() + ttlMs;
  memoryCache.set(key, { artifact, expiresAt });

  ensureCacheDir();
  try {
    const diskPayload = { key, expiresAt, artifact, written_utc: new Date().toISOString() };
    fs.writeFileSync(artifactPath(key), JSON.stringify(diskPayload, null, 2), 'utf8');
  } catch {
    // Non-fatal.
  }
}

function getArtifact(sport, eventId) {
  const key = cacheKey(sport, eventId);
  const mem = memoryCache.get(key);
  if (mem && mem.expiresAt > Date.now()) return mem.artifact;

  try {
    const filePath = artifactPath(key);
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (raw.expiresAt > Date.now()) {
        memoryCache.set(key, { artifact: raw.artifact, expiresAt: raw.expiresAt });
        return raw.artifact;
      }
    }
  } catch {
    // Non-fatal: treat as miss.
  }

  return null;
}

function invalidateArtifact(sport, eventId) {
  const key = cacheKey(sport, eventId);
  memoryCache.delete(key);
  try {
    const filePath = artifactPath(key);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Non-fatal.
  }
}

module.exports = {
  setArtifact,
  getArtifact,
  invalidateArtifact,
  cacheKey,
  DEFAULT_TTL_MS,
};
