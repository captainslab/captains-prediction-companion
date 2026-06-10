// cpc-role-route.mjs
//
// CPC role routing helper for Hermes model aliases.
// Reads config/cpc-hermes-routes.json and provides resolved invocation strings.
//
// Usage:
//   import { resolveRole, buildHermesArgs } from './cpc-role-route.mjs';
//   const alpha = resolveRole('alpha_hunter');
//   const args = buildHermesArgs('alpha_hunter', { query: 'research topic', maxTurns: 8 });
//
// Pure ESM. No secrets. Provider/model are verified mappings only.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

let _cachedRoutes = null;

function loadRoutes() {
  if (_cachedRoutes) return _cachedRoutes;
  const path = resolve(__dirname, '../../config/cpc-hermes-routes.json');
  try {
    const raw = readFileSync(path, 'utf8');
    _cachedRoutes = JSON.parse(raw);
    return _cachedRoutes;
  } catch (err) {
    throw new Error(`Failed to load CPC Hermes routes from ${path}: ${err.message}`);
  }
}

function findRouteEntry(identifier) {
  const routes = loadRoutes();
  const roles = routes.roles || {};
  if (!identifier) {
    throw new Error(`Unknown CPC role or alias: "${identifier}". Expected one of: ${Object.keys(roles).join(', ')}`);
  }

  if (roles[identifier]) {
    return { role_key: identifier, entry: roles[identifier] };
  }

  for (const [roleKey, entry] of Object.entries(roles)) {
    if (entry.alias === identifier) {
      return { role_key: roleKey, entry };
    }
  }

  throw new Error(`Unknown CPC role or alias: "${identifier}". Expected one of: ${Object.keys(roles).join(', ')}`);
}

/**
 * Resolve a CPC role or alias to its Hermes alias, provider, and model.
 * @param {string} identifier - 'alpha_hunter', 'market_hunter', 'alpha-hunter', or 'market-hunter'
 * @returns {object} { role_key, alias, provider, model, display_name, firecrawl_available, skills, toolsets }
 */
export function resolveRoute(identifier) {
  const { role_key, entry } = findRouteEntry(identifier);
  return {
    role_key,
    alias: entry.alias,
    provider: entry.provider,
    model: entry.model,
    display_name: entry.display_name,
    firecrawl_available: entry.firecrawl_available,
    skills: entry.skills,
    toolsets: entry.toolsets,
  };
}

/**
 * Backward-compatible alias for role-based callers.
 * @param {string} role - 'alpha_hunter' or 'market_hunter'
 * @returns {object}
 */
export function resolveRole(role) {
  return resolveRoute(role);
}

/**
 * Build Hermes CLI args array for a given role and query.
 * @param {string} role - 'alpha_hunter' or 'market_hunter'
 * @param {object} opts
 * @param {string} opts.query - The research query
 * @param {number} [opts.maxTurns=8] - Max turns
 * @param {string[]} [opts.extraSkills=[]] - Additional skills
 * @param {string[]} [opts.extraToolsets=[]] - Additional toolsets
 * @returns {string[]} CLI args for spawnSync/spawn
 */
export function buildHermesArgs(role, opts = {}) {
  const r = resolveRole(role);
  const skills = [...r.skills, ...(opts.extraSkills || [])];
  const toolsets = [...r.toolsets, ...(opts.extraToolsets || [])];
  const maxTurns = opts.maxTurns ?? 8;

  const args = ['chat', '-Q', '--max-turns', String(maxTurns)];
  args.push('-m', r.alias);
  if (toolsets.length > 0) {
    args.push('-t', toolsets.join(','));
  }
  if (skills.length > 0) {
    args.push('-s', skills.join(','));
  }
  args.push('-q', String(opts.query || ''));
  return args;
}

/**
 * Build a full Hermes command string for logging/documentation.
 * @param {string} role - 'alpha_hunter' or 'market_hunter'
 * @param {string} query - The research query
 * @returns {string} Command string (for display only)
 */
export function buildHermesCommandString(role, query) {
  const args = buildHermesArgs(role, { query });
  const cmd = process.env.HERMES_COMMAND || process.env.HERMES_CLI || 'hermes';
  return `${cmd} ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`;
}

/**
 * List all available CPC roles.
 * @returns {string[]}
 */
export function listRoles() {
  const routes = loadRoutes();
  return Object.keys(routes.roles || {});
}
