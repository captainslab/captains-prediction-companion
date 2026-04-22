export const DEFAULT_MODEL_NAME = 'openrouter/free';

export function resolveModelName(envVar, fallback = DEFAULT_MODEL_NAME) {
  const configured = process.env[envVar];
  if (typeof configured !== 'string') return fallback;
  const cleaned = configured.trim();
  return cleaned || fallback;
}

export const DEFAULT_OPENROUTER_MODEL = DEFAULT_MODEL_NAME;
export const resolveOpenRouterModel = resolveModelName;
