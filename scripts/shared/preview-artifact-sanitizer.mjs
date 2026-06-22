// Sanitizer for research artifacts before they are fed into preview builders.
// Pure ESM. No I/O.

export const BANNED_MODEL_INPUT_KEYS = Object.freeze([
  'price',
  'prices',
  'odds',
  'bid',
  'ask',
  'bid_ask',
  'spread',
  'spread_price',
  'spreads',
  'volume',
  'open_interest',
  'oi',
  'liquidity',
  'orderbook',
  'ladder',
  'ladders',
  'implied',
  'implied_prob',
  'money_line',
  'moneyline',
  'last_price',
  'yes_bid',
  'yes_ask',
  'vol',
]);

const BANNED_KEY_SET = new Set(BANNED_MODEL_INPUT_KEYS);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneDeep(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function normalizeKey(key) {
  return String(key ?? '').trim().toLowerCase();
}

function uniquePush(list, seen, value) {
  const text = normalizeKey(value);
  if (!text || seen.has(text)) return;
  seen.add(text);
  list.push(text);
}

function collectNestedRemovals(node, state) {
  if (Array.isArray(node)) {
    node.forEach((item) => collectNestedRemovals(item, state));
    return;
  }
  if (!isObject(node)) return;

  for (const [key, value] of Object.entries(node)) {
    const normalized = normalizeKey(key);
    if (BANNED_KEY_SET.has(normalized) || normalized === 'market_context') {
      uniquePush(state.removed, state.removedSeen, normalized);
    }
    collectNestedRemovals(value, state);
  }
}

function sanitizeNode(node, state, insideModelSafeInputs = false) {
  if (Array.isArray(node)) {
    return node.map((item) => sanitizeNode(item, state, insideModelSafeInputs));
  }

  if (!isObject(node)) return node;

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    const normalized = normalizeKey(key);

    if (insideModelSafeInputs && (BANNED_KEY_SET.has(normalized) || normalized === 'market_context')) {
      uniquePush(state.removed, state.removedSeen, normalized);
      collectNestedRemovals(value, state);
      continue;
    }

    if (!insideModelSafeInputs && normalized === 'market_context') {
      if (isObject(value) && value.display_only === true) {
        out[key] = sanitizeNode(value, state, false);
      } else {
        uniquePush(state.removed, state.removedSeen, normalized);
      }
      continue;
    }

    out[key] = sanitizeNode(value, state, insideModelSafeInputs);
  }
  return out;
}

function mergeFieldLists(existing, removed) {
  const seen = new Set();
  const out = [];
  for (const value of [...(Array.isArray(existing) ? existing : []), ...removed]) {
    const text = normalizeKey(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

export function sanitizeResearchArtifact(artifact) {
  const cloned = cloneDeep(artifact);
  if (!isObject(cloned)) return cloned;

  const state = {
    removed: [],
    removedSeen: new Set(),
  };

  if (Object.prototype.hasOwnProperty.call(cloned, 'model_safe_inputs')) {
    cloned.model_safe_inputs = sanitizeNode(cloned.model_safe_inputs, state, true);
  }

  if (Object.prototype.hasOwnProperty.call(cloned, 'market_context')) {
    if (!(isObject(cloned.market_context) && cloned.market_context.display_only === true)) {
      uniquePush(state.removed, state.removedSeen, 'market_context');
      delete cloned.market_context;
    }
  }

  cloned.unavailable_fields = mergeFieldLists(cloned.unavailable_fields, state.removed);
  cloned.sanitized_removed = mergeFieldLists(cloned.sanitized_removed, state.removed);

  return cloned;
}

export function assertNoMarketLeak(modelSafeInputs) {
  const violations = [];

  function walk(node, path = []) {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, path.concat(String(index))));
      return;
    }
    if (!isObject(node)) return;

    for (const [key, value] of Object.entries(node)) {
      const normalized = normalizeKey(key);
      if (BANNED_KEY_SET.has(normalized)) {
        violations.push(path.concat(key).join('.'));
      }
      walk(value, path.concat(key));
    }
  }

  walk(modelSafeInputs);

  if (violations.length) {
    throw new Error(`market leak detected in model_safe_inputs: ${violations.join(', ')}`);
  }

  return true;
}
