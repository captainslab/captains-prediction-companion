// Packet-generation model routing.
//
// There is intentionally NO hard-coded model/provider default here. When no
// explicit override is configured (env var, run option, or scoped config),
// resolveModelName returns null so the caller omits --provider/-m and the
// Hermes CLI uses its own ACTIVE default provider/model/reasoning. This keeps
// cron and manual packet generation on whatever Hermes is currently configured
// to use (e.g. copilot / claude-opus-4.8 / reasoning=on) and follows future
// default changes automatically — instead of pinning a stale Gemini/Opus model.
export const DEFAULT_MODEL_NAME = null;

export function resolveModelName(envVar, fallback = DEFAULT_MODEL_NAME) {
  const configured = process.env[envVar];
  if (typeof configured !== 'string') return fallback;
  const cleaned = configured.trim();
  return cleaned || fallback;
}

export const DEFAULT_OPENROUTER_MODEL = DEFAULT_MODEL_NAME;
export const resolveOpenRouterModel = resolveModelName;
