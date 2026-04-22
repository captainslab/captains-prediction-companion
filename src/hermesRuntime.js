import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
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

export function runHermesChat(query, options = {}) {
  const skills = normalizeList(options.skills, DEFAULT_HERMES_SKILLS);
  const toolsets = normalizeList(options.toolsets, DEFAULT_HERMES_TOOLSETS);
  const args = ['chat', '-Q', '--max-turns', String(options.maxTurns ?? DEFAULT_HERMES_MAX_TURNS)];

  if (options.provider) {
    args.push('--provider', String(options.provider));
  }
  if (options.model) {
    args.push('-m', String(options.model));
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

  const result = spawnSync(resolveHermesCommand(), args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 120000,
    env: {
      ...process.env,
      HERMES_SOURCE: options.source ?? 'pipeline',
    },
  });

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const parsed = extractJsonFromHermesOutput(stdout);

  return {
    ok: !result.error && result.status === 0 && parsed != null,
    parsed,
    stdout,
    stderr,
    status: result.status ?? null,
    error: result.error ?? null,
    sessionId: extractSessionId(stdout),
  };
}
