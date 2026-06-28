/**
 * researchCache.js
 * In-memory + JSON-file cached artifact store for CPC sports research.
 * Stores structured research artifacts with TTL, hit/miss logging,
 * missing-field tracking, provider/model attribution, and cost.
 *
 * File artifacts are written to state/sports-research-cache/ by default.
 * The cache is read-only safe: a miss returns null, never throws.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CACHE_DIR = path.resolve(__dirname, '../../state/sports-research-cache');

// ─── In-memory store ──────────────────────────────────────────────────────────

/** @type {Map<string, { artifact: object, expiresAt: number }>} */
const memoryCache = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Builds a deterministic cache key from sport + eventId.
 * @param {string} sport
 * @param {string} eventId
 * @returns {string}
 */
function cacheKey(sport, eventId) {
  return `${sport}::${eventId}`;
}

/**
 * Ensures the cache directory exists.
 */
function ensureCacheDir() {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  } catch {
    // Non-fatal: file cache unavailable, memory-only mode
  }
}

/**
 * Returns the file path for a cache artifact.
 * @param {string} key
 * @returns {string}
 */
function artifactPath(key) {
  const safe = key.replace(/[^a-z0-9_\-:.]/gi, '_');
  return path.join(CACHE_DIR, `${safe}.json`);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Store a research artifact in memory and on disk.
 *
 * @param {string} sport
 * @param {string} eventId
 * @param {object} artifact — full { _meta, research } object
 * @param {number} [ttlMs]  — override default TTL
 */
function setArtifact(sport, eventId, artifact, ttlMs = DEFAULT_TTL_MS) {
  const key = cacheKey(sport, eventId);
  const expiresAt = Date.now() + ttlMs;

  memoryCache.set(key, { artifact, expiresAt });

  // Persist to disk
  ensureCacheDir();
  try {
    const diskPayload = { key, expiresAt, artifact, written_utc: new Date().toISOString() };
    fs.writeFileSync(artifactPath(key), JSON.stringify(diskPayload, null, 2), 'utf8');
  } catch {
    // Non-fatal
  }

  console.log(`[researchCache] SET sport=${sport} event=${eventId} ttl=${ttlMs}ms`);
}

/**
 * Retrieve a research artifact. Returns null on miss or expiry.
 *
 * @param {string} sport
 * @param {string} eventId
 * @returns {object|null}
 */
function getArtifact(sport, eventId) {
  const key = cacheKey(sport, eventId);

  // ── Memory hit ──
  const mem = memoryCache.get(key);
  if (mem && mem.expiresAt > Date.now()) {
    console.log(`[researchCache] HIT (memory) sport=${sport} event=${eventId}`);
    return mem.artifact;
  }

  // ── Disk hit ──
  try {
    const fpath = artifactPath(key);
    if (fs.existsSync(fpath)) {
      const raw = JSON.parse(fs.readFileSync(fpath, 'utf8'));
      if (raw.expiresAt > Date.now()) {
        console.log(`[researchCache] HIT (disk) sport=${sport} event=${eventId}`);
        // Warm memory cache
        memoryCache.set(key, { artifact: raw.artifact, expiresAt: raw.expiresAt });
        return raw.artifact;
      }
    }
  } catch {
    // Non-fatal: treat as miss
  }

  console.log(`[researchCache] MISS sport=${sport} event=${eventId}`);
  return null;
}

/**
 * Invalidate a cached artifact immediately.
 * @param {string} sport
 * @param {string} eventId
 */
function invalidateArtifact(sport, eventId) {
  const key = cacheKey(sport, eventId);
  memoryCache.delete(key);
  try {
    const fpath = artifactPath(key);
    if (fs.existsSync(fpath)) fs.unlinkSync(fpath);
  } catch {
    // Non-fatal
  }
  console.log(`[researchCache] INVALIDATED sport=${sport} event=${eventId}`);
}

module.exports = {
  setArtifact,
  getArtifact,
  invalidateArtifact,
  cacheKey,
};
