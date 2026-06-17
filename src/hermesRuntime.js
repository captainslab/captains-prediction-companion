import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function resolveHermesCommand() {
  return process.env.HERMES_COMMAND ?? process.env.HERMES_CLI ?? 'hermes';
}

export const HERMES_RESEARCH_PACKET = resolve(__dirname, '../prompts/hermes-kalshi-mention-research.md');
export const HERMES_ORACLE_PACKET = resolve(__dirname, '../prompts/hermes-kalshi-oracle-decision.md');
export const DEFAULT_HERMES_SKILLS = [
  'research-source-scraping',
  'last30days-research',
  'self-improving-agent-skills',
];
export const DEFAULT_HERMES_TOOLSETS = ['web', 'browser', 'terminal', 'file', 'skills'];
export const DEFAULT_HERMES_MAX_TURNS = 8;
export const BLOCKED_MODEL_FALLBACK_UNAVAILABLE = 'BLOCKED_MODEL_FALLBACK_UNAVAILABLE';
export const NO_MODEL_OUTPUT = 'no_model_output';
const DEFAULT_HERMES_RUNTIME = 'hermes-cli';
const HERMES_HOME = resolve(homedir(), '.hermes');
const HERMES_ACTIVE_PROFILE_FILE = resolve(HERMES_HOME, 'active_profile');
const FALLBACK_ENV_KEYS = [
  'HERMES_ENABLE_CLAUDE_FALLBACK',
  'HERMES_ENABLE_MODEL_FALLBACK',
  'HERMES_CLAUDE_FALLBACK',
];
const FALLBACK_LIST_ENV_KEYS = [
  'HERMES_FALLBACK_MODELS',
  'HERMES_CLAUDE_FALLBACK_MODELS',
  'HERMES_CLAUDE_MODEL_ALIASES',
];

function normalizeList(values, fallback) {
  const source = Array.isArray(values)
    ? values
    : typeof values === 'string'
      ? values.split(',')
      : fallback;

  return source
    .map(value => String(value).trim())
    .filter(Boolean);
}

function normalizeConfiguredString(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  return cleaned || null;
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function normalizeArtifactPaths(value) {
  if (typeof value === 'string') {
    const cleaned = value.trim();
    return cleaned ? [cleaned] : [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .map(item => normalizeConfiguredString(item))
    .filter(Boolean);
}

function readTextFileMaybe(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function readJsonFileMaybe(path) {
  const text = readTextFileMaybe(path);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readActiveHermesProfileName(env = process.env) {
  const explicit = normalizeConfiguredString(env.HERMES_PROFILE);
  if (explicit) return explicit;
  const text = readTextFileMaybe(HERMES_ACTIVE_PROFILE_FILE);
  return normalizeConfiguredString(text);
}

function normalizeTargetLike(value, defaults = {}) {
  if (!value) return null;
  if (typeof value === 'string') {
    const cleaned = normalizeConfiguredString(value);
    if (!cleaned) return null;
    return {
      provider: defaults.provider ?? null,
      model_id: cleaned,
    };
  }

  if (typeof value !== 'object') return null;
  const provider = normalizeConfiguredString(value.provider ?? value.runtime_provider ?? value.provider_id);
  const modelId =
    normalizeConfiguredString(value.model_id) ??
    normalizeConfiguredString(value.model) ??
    normalizeConfiguredString(value.alias) ??
    normalizeConfiguredString(value.model_alias) ??
    normalizeConfiguredString(value.id);
  if (!provider && !modelId) return null;
  return {
    provider: provider ?? defaults.provider ?? null,
    model_id: modelId ?? defaults.model_id ?? null,
  };
}

function extractClaudeTargetsFromCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object') return [];
  const providers = catalog.providers;
  if (!providers || typeof providers !== 'object') return [];

  const targets = [];
  for (const [providerKey, providerConfig] of Object.entries(providers)) {
    const models = Array.isArray(providerConfig?.models) ? providerConfig.models : [];
    for (const entry of models) {
      const modelId = normalizeConfiguredString(entry?.id);
      if (!modelId || !/claude/i.test(modelId)) continue;
      targets.push({
        provider: providerKey,
        model_id: modelId,
      });
    }
  }

  return targets;
}

function resolveHermesPrimaryTarget(options = {}, env = process.env) {
  const provider =
    normalizeConfiguredString(options.provider) ??
    normalizeConfiguredString(env.HERMES_PROVIDER) ??
    null;
  const modelId =
    normalizeConfiguredString(options.model) ??
    normalizeConfiguredString(options.alias) ??
    normalizeConfiguredString(options.modelAlias) ??
    normalizeConfiguredString(env.HERMES_MODEL) ??
    normalizeConfiguredString(env.HERMES_ALIAS) ??
    normalizeConfiguredString(env.HERMES_MODEL_ALIAS) ??
    null;

  return {
    provider,
    model_id: modelId,
  };
}

function resolveFallbackEnabled(options = {}, env = process.env) {
  if (normalizeBoolean(options.enableClaudeFallback) || normalizeBoolean(options.enableFallback)) {
    return true;
  }

  if (FALLBACK_ENV_KEYS.some(key => normalizeBoolean(env[key]))) {
    return true;
  }

  return FALLBACK_LIST_ENV_KEYS.some(key => normalizeConfiguredString(env[key]));
}

function loadApprovedClaudeTargets(options = {}, env = process.env, runtimeContext = {}) {
  if (Array.isArray(options.approvedClaudeTargets) && options.approvedClaudeTargets.length > 0) {
    return options.approvedClaudeTargets
      .map(target => normalizeTargetLike(target, { provider: 'openrouter' }))
      .filter(Boolean);
  }

  const envList = FALLBACK_LIST_ENV_KEYS
    .map(key => normalizeConfiguredString(env[key]))
    .find(Boolean);
  if (envList) {
    const defaultProvider = normalizeConfiguredString(env.HERMES_CLAUDE_FALLBACK_PROVIDER) ?? null;
    return normalizeList(envList, [])
      .map(modelId => normalizeTargetLike({ model_id: modelId, provider: defaultProvider }, { provider: defaultProvider }))
      .filter(Boolean);
  }

  if (Array.isArray(runtimeContext.approvedClaudeTargets) && runtimeContext.approvedClaudeTargets.length > 0) {
    return runtimeContext.approvedClaudeTargets
      .map(target => normalizeTargetLike(target, { provider: 'openrouter' }))
      .filter(Boolean);
  }

  const activeProfile = normalizeConfiguredString(runtimeContext.activeProfile) ?? readActiveHermesProfileName(env);
  if (!activeProfile) return [];

  const profileRoot = runtimeContext.profileRoot ?? resolve(HERMES_HOME, 'profiles', activeProfile);
  const catalogPath = runtimeContext.modelCatalogPath ?? resolve(profileRoot, 'cache', 'model_catalog.json');
  const catalog = runtimeContext.modelCatalog ?? readJsonFileMaybe(catalogPath);
  const catalogTargets = extractClaudeTargetsFromCatalog(catalog);
  if (catalogTargets.length > 0) {
    return catalogTargets;
  }

  return [];
}

function resolveHermesFallbackTarget(options = {}, env = process.env, runtimeContext = {}) {
  const explicitTargets = Array.isArray(options.fallbackTargets) ? options.fallbackTargets : null;
  if (explicitTargets?.length) {
    const first = explicitTargets
      .map(target => normalizeTargetLike(target, { provider: 'openrouter' }))
      .find(Boolean);
    if (first) return first;
  }

  const approvedTargets = loadApprovedClaudeTargets(options, env, runtimeContext);
  return approvedTargets[0] ?? null;
}

function shouldUseSchemaValidator(options = {}, env = process.env) {
  return resolveFallbackEnabled(options, env) && typeof options.validateOutput === 'function';
}

function schemaIsValid(parsed, options = {}) {
  if (typeof options.validateOutput === 'function') {
    try {
      return Boolean(options.validateOutput(parsed));
    } catch {
      return false;
    }
  }
  return parsed != null;
}

function classifyFailureReason(attempt = {}, options = {}) {
  if (attempt?.error?.code === 'ETIMEDOUT') return 'timeout';
  const stderr = normalizeConfiguredString(attempt?.stderr)?.toLowerCase() ?? '';
  if (/\b(429|rate limit|quota|exhaust|too many requests)\b/i.test(stderr)) {
    return 'rate_exhaustion';
  }
  if (shouldUseSchemaValidator(options, options.env ?? process.env) && attempt?.parsed != null && !schemaIsValid(attempt.parsed, options)) {
    return 'schema_invalid';
  }
  if (!attempt?.parsed || !attempt?.ok) {
    return stderr ? 'missing_output' : 'primary_failure';
  }
  return 'primary_failure';
}

function buildInvocationMetadata({
  provider = null,
  runtime = DEFAULT_HERMES_RUNTIME,
  model_id = null,
  fallback_reason = null,
  input_artifact_paths = [],
  output_schema_valid = null,
  retry_count = 0,
  used_in_score = false,
}) {
  return {
    provider,
    runtime,
    model_id,
    fallback_reason,
    input_artifact_paths: normalizeArtifactPaths(input_artifact_paths),
    output_schema_valid,
    retry_count,
    used_in_score: Boolean(used_in_score),
  };
}

export function readHermesResearchPacket() {
  try {
    return readFileSync(HERMES_RESEARCH_PACKET, 'utf8');
  } catch {
    return '';
  }
}

export function readHermesOraclePacket() {
  try {
    return readFileSync(HERMES_ORACLE_PACKET, 'utf8');
  } catch {
    return '';
  }
}

export function stringifyCompactJson(value) {
  return JSON.stringify(value, null, 2);
}

export function extractSessionId(output) {
  if (typeof output !== 'string' || !output.trim()) return null;
  const match = output.match(/session_id:\s*([A-Za-z0-9_.:-]+)/i);
  return match?.[1] ?? null;
}

export function extractJsonFromHermesOutput(output) {
  if (typeof output !== 'string') return null;

  const trimmed = output.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue to heuristics.
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (
      (line.startsWith('{') && line.endsWith('}')) ||
      (line.startsWith('[') && line.endsWith(']'))
    ) {
      try {
        return JSON.parse(line);
      } catch {
        // Continue searching.
      }
    }
  }

  const jsonMatch = trimmed.match(/(\{[\s\S]*\}|\[[\s\S]*\])\s*$/);
  if (jsonMatch?.[1]) {
    try {
      return JSON.parse(jsonMatch[1]);
    } catch {
      return null;
    }
  }

  return null;
}

function executeHermesChatAttempt(query, options = {}, target = {}) {
  const spawnImpl = options.spawnSyncImpl ?? spawnSync;
  const runtimeEnv = options.env ?? process.env;
  const skills = normalizeList(options.skills, DEFAULT_HERMES_SKILLS);
  const toolsets = normalizeList(options.toolsets, DEFAULT_HERMES_TOOLSETS);
  const args = ['chat', '-Q', '--max-turns', String(options.maxTurns ?? DEFAULT_HERMES_MAX_TURNS)];

  if (target.provider) {
    args.push('--provider', String(target.provider));
  }
  if (target.model_id) {
    args.push('-m', String(target.model_id));
  }
  if (toolsets.length > 0) {
    args.push('-t', toolsets.join(','));
  }
  if (skills.length > 0) {
    args.push('-s', skills.join(','));
  }
  if (options.source) {
    args.push('--source', String(options.source));
  }
  if (options.passSessionId) {
    args.push('--pass-session-id');
  }
  args.push('-q', String(query));

  const result = spawnImpl(resolveHermesCommand(), args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 120000,
    env: {
      ...runtimeEnv,
      HERMES_SOURCE: options.source ?? 'pipeline',
    },
  });

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const parsed = extractJsonFromHermesOutput(stdout);

  // Hermes CLI may exit with SIGABRT (status null) even on successful output.
  // Trust the parsed output when status is null/0 and there's no spawn error.
  const ok = !result.error && (result.status === 0 || result.status === null) && parsed != null;
  return {
    ok,
    parsed,
    stdout,
    stderr,
    status: result.status ?? null,
    error: result.error ?? null,
    sessionId: extractSessionId(stdout),
  };
}

function buildBlockedFallbackResult({
  attempt = null,
  primaryAttempt = null,
  runtime = DEFAULT_HERMES_RUNTIME,
  target = null,
  reason = BLOCKED_MODEL_FALLBACK_UNAVAILABLE,
  inputArtifactPaths = [],
  usedInScore = false,
}) {
  const fallbackReason = reason === BLOCKED_MODEL_FALLBACK_UNAVAILABLE
    ? BLOCKED_MODEL_FALLBACK_UNAVAILABLE
    : classifyFailureReason(primaryAttempt ?? attempt ?? {}, { validateOutput: null });
  return {
    ok: false,
    parsed: null,
    stdout: attempt?.stdout ?? primaryAttempt?.stdout ?? '',
    stderr: attempt?.stderr ?? primaryAttempt?.stderr ?? 'Claude fallback unavailable',
    status: attempt?.status ?? primaryAttempt?.status ?? null,
    error: attempt?.error ?? primaryAttempt?.error ?? null,
    sessionId: attempt?.sessionId ?? primaryAttempt?.sessionId ?? null,
    error_code: reason,
    fallback_used: false,
    invocation: buildInvocationMetadata({
      provider: target?.provider ?? null,
      runtime,
      model_id: target?.model_id ?? null,
      fallback_reason: fallbackReason,
      input_artifact_paths: inputArtifactPaths,
      output_schema_valid: false,
      retry_count: 0,
      used_in_score: usedInScore,
    }),
  };
}

function buildNoModelOutputResult({
  attempt = null,
  primaryAttempt = null,
  runtime = DEFAULT_HERMES_RUNTIME,
  target = null,
  fallbackReason = NO_MODEL_OUTPUT,
  inputArtifactPaths = [],
  usedInScore = false,
}) {
  return {
    ok: false,
    parsed: null,
    stdout: attempt?.stdout ?? primaryAttempt?.stdout ?? '',
    stderr: attempt?.stderr ?? primaryAttempt?.stderr ?? 'Claude output failed schema validation or returned no usable JSON.',
    status: attempt?.status ?? primaryAttempt?.status ?? null,
    error: attempt?.error ?? primaryAttempt?.error ?? null,
    sessionId: attempt?.sessionId ?? primaryAttempt?.sessionId ?? null,
    error_code: NO_MODEL_OUTPUT,
    fallback_used: true,
    invocation: buildInvocationMetadata({
      provider: target?.provider ?? null,
      runtime,
      model_id: target?.model_id ?? null,
      fallback_reason: fallbackReason,
      input_artifact_paths: inputArtifactPaths,
      output_schema_valid: false,
      retry_count: 1,
      used_in_score: usedInScore,
    }),
  };
}

export function resolveHermesChatTarget(options = {}, env = process.env) {
  return resolveHermesPrimaryTarget(options, env);
}

export function resolveHermesClaudeFallbackTarget(options = {}, env = process.env, runtimeContext = {}) {
  return resolveHermesFallbackTarget(options, env, runtimeContext);
}

export function runHermesChat(query, options = {}) {
  const runtimeEnv = options.env ?? process.env;
  const runtime = normalizeConfiguredString(options.runtime) ?? DEFAULT_HERMES_RUNTIME;
  const inputArtifactPaths = normalizeArtifactPaths(options.inputArtifactPaths);
  const fallbackEnabled = resolveFallbackEnabled(options, runtimeEnv);
  const primaryTarget = resolveHermesPrimaryTarget(options, runtimeEnv);
  const primaryAttempt = executeHermesChatAttempt(query, options, primaryTarget);
  const primarySchemaValid = fallbackEnabled ? schemaIsValid(primaryAttempt.parsed, options) : primaryAttempt.parsed != null;

  if (primaryAttempt.ok && (!fallbackEnabled || primarySchemaValid)) {
    return {
      ...primaryAttempt,
      fallback_used: false,
      error_code: null,
      invocation: buildInvocationMetadata({
        provider: primaryTarget.provider,
        runtime,
        model_id: primaryTarget.model_id,
        fallback_reason: null,
        input_artifact_paths: inputArtifactPaths,
        output_schema_valid: primarySchemaValid,
        retry_count: 0,
        used_in_score: options.usedInScore ?? false,
      }),
    };
  }

  if (!fallbackEnabled) {
    return {
      ...primaryAttempt,
      fallback_used: false,
      error_code: null,
      invocation: buildInvocationMetadata({
        provider: primaryTarget.provider,
        runtime,
        model_id: primaryTarget.model_id,
        fallback_reason: null,
        input_artifact_paths: inputArtifactPaths,
        output_schema_valid: primarySchemaValid,
        retry_count: 0,
        used_in_score: options.usedInScore ?? false,
      }),
    };
  }

  const runtimeContext = options.hermesRuntimeContext ?? options.runtimeContext ?? {};
  const fallbackTarget = resolveHermesFallbackTarget(options, runtimeEnv, runtimeContext);
  if (!fallbackTarget) {
    return buildBlockedFallbackResult({
      primaryAttempt,
      runtime,
      reason: BLOCKED_MODEL_FALLBACK_UNAVAILABLE,
      inputArtifactPaths,
      usedInScore: options.usedInScore ?? false,
    });
  }

  const fallbackReason = classifyFailureReason(primaryAttempt, options);
  const fallbackAttempt = executeHermesChatAttempt(query, options, fallbackTarget);
  const fallbackSchemaValid = schemaIsValid(fallbackAttempt.parsed, options);

  if (fallbackAttempt.ok && fallbackSchemaValid) {
    return {
      ...fallbackAttempt,
      fallback_used: true,
      error_code: null,
      invocation: buildInvocationMetadata({
        provider: fallbackTarget.provider,
        runtime,
        model_id: fallbackTarget.model_id,
        fallback_reason: fallbackReason,
        input_artifact_paths: inputArtifactPaths,
        output_schema_valid: fallbackSchemaValid,
        retry_count: 1,
        used_in_score: options.usedInScore ?? false,
      }),
    };
  }

  if (fallbackSchemaValid === false || fallbackAttempt.parsed == null) {
    return buildNoModelOutputResult({
      attempt: fallbackAttempt,
      primaryAttempt,
      runtime,
      target: fallbackTarget,
      fallbackReason: fallbackSchemaValid === false ? 'schema_invalid' : fallbackReason,
      inputArtifactPaths,
      usedInScore: options.usedInScore ?? false,
    });
  }

  return buildNoModelOutputResult({
    attempt: fallbackAttempt,
    primaryAttempt,
    runtime,
    target: fallbackTarget,
    fallbackReason,
    inputArtifactPaths,
    usedInScore: options.usedInScore ?? false,
  });
}
