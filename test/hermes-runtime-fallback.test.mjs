import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BLOCKED_MODEL_FALLBACK_UNAVAILABLE,
  NO_MODEL_OUTPUT,
  runHermesChat,
} from '../src/hermesRuntime.js';

function makeSpawnStub(responses, calls) {
  let index = 0;
  return (_cmd, args) => {
    calls.push(args);
    const response = responses[Math.min(index, responses.length - 1)] ?? responses[responses.length - 1] ?? {
      stdout: '',
      stderr: 'no stub response',
      status: 1,
      error: null,
    };
    index += 1;
    return response;
  };
}

function cleanupDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test('explicit primary options win over env overrides when fallback is disabled', () => {
  const calls = [];
  const result = runHermesChat('prompt', {
    env: {
      HERMES_PROVIDER: 'gemini',
      HERMES_MODEL: 'gemini-2.0-flash',
      HERMES_SOURCE: 'test',
    },
    provider: 'openai-codex',
    model: 'gpt-5.4',
    enableClaudeFallback: false,
    inputArtifactPaths: ['/tmp/request.json'],
    usedInScore: true,
    spawnSyncImpl: makeSpawnStub([
      { stdout: '{"ok":true}', stderr: '', status: 0, error: null },
    ], calls),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][calls[0].indexOf('--provider') + 1], 'openai-codex');
  assert.equal(calls[0][calls[0].indexOf('-m') + 1], 'gpt-5.4');
  assert.equal(result.ok, true);
  assert.equal(result.error_code, null);
  assert.equal(result.invocation.provider, 'openai-codex');
  assert.equal(result.invocation.model_id, 'gpt-5.4');
  assert.equal(result.invocation.retry_count, 0);
  assert.equal(result.invocation.used_in_score, true);
});

test('env primary target is used when explicit options omit provider and model', () => {
  const calls = [];
  const result = runHermesChat('prompt', {
    env: {
      HERMES_PROVIDER: 'openrouter',
      HERMES_MODEL: 'anthropic/claude-sonnet-4.6',
      HERMES_SOURCE: 'test',
    },
    enableClaudeFallback: false,
    spawnSyncImpl: makeSpawnStub([
      { stdout: '{"ok":true}', stderr: '', status: 0, error: null },
    ], calls),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][calls[0].indexOf('--provider') + 1], 'openrouter');
  assert.equal(calls[0][calls[0].indexOf('-m') + 1], 'anthropic/claude-sonnet-4.6');
  assert.equal(result.ok, true);
  assert.equal(result.error_code, null);
  assert.equal(result.invocation.provider, 'openrouter');
  assert.equal(result.invocation.model_id, 'anthropic/claude-sonnet-4.6');
});

test('primary chat emits no provider or model flags when neither options nor env provide them', () => {
  const calls = [];
  const result = runHermesChat('prompt', {
    env: {
      HERMES_SOURCE: 'test',
    },
    enableClaudeFallback: false,
    spawnSyncImpl: makeSpawnStub([
      { stdout: '{"ok":true}', stderr: '', status: 0, error: null },
    ], calls),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].includes('--provider'), false);
  assert.equal(calls[0].includes('-m'), false);
  assert.equal(result.ok, true);
  assert.equal(result.error_code, null);
  assert.equal(result.invocation.provider, null);
  assert.equal(result.invocation.model_id, null);
});

test('missing Claude fallback fails closed with BLOCKED_MODEL_FALLBACK_UNAVAILABLE', () => {
  const calls = [];
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'hermes-fallback-missing-'));
  try {
    const result = runHermesChat('prompt', {
      env: {
        HERMES_SOURCE: 'test',
      },
      enableClaudeFallback: true,
      hermesRuntimeContext: {
        activeProfile: 'missing-profile',
        profileRoot: join(runtimeRoot, 'no-such-profile'),
      },
      spawnSyncImpl: makeSpawnStub([
        { stdout: '', stderr: 'primary failed', status: 1, error: null },
      ], calls),
    });

    assert.equal(calls.length, 1);
    assert.equal(result.ok, false);
    assert.equal(result.error_code, BLOCKED_MODEL_FALLBACK_UNAVAILABLE);
    assert.equal(result.fallback_used, false);
    assert.equal(result.invocation.fallback_reason, BLOCKED_MODEL_FALLBACK_UNAVAILABLE);
    assert.equal(result.invocation.model_id, null);
    assert.equal(result.invocation.retry_count, 0);
  } finally {
    cleanupDir(runtimeRoot);
  }
});

test('Claude schema failure returns no_model_output and stops after one fallback attempt', () => {
  const calls = [];
  const result = runHermesChat('prompt', {
    env: {
      HERMES_SOURCE: 'test',
    },
    enableClaudeFallback: true,
    fallbackTargets: [{ provider: 'openrouter', model_id: 'anthropic/claude-opus-4.8' }],
    inputArtifactPaths: ['/tmp/request.json', '/tmp/context.json'],
    validateOutput: (parsed) => Boolean(parsed && parsed.allowed === true),
    spawnSyncImpl: makeSpawnStub([
      { stdout: '', stderr: 'primary missing output', status: 1, error: null },
      { stdout: '{"allowed":false}', stderr: '', status: 0, error: null },
    ], calls),
  });

  assert.equal(calls.length, 2);
  assert.equal(result.ok, false);
  assert.equal(result.error_code, NO_MODEL_OUTPUT);
  assert.equal(result.fallback_used, true);
  assert.equal(result.invocation.fallback_reason, 'schema_invalid');
  assert.equal(result.invocation.output_schema_valid, false);
  assert.equal(result.invocation.retry_count, 1);
});

test('fallback target resolution stays env-driven and model-flexible', () => {
  const calls = [];
  const result = runHermesChat('prompt', {
    env: {
      HERMES_SOURCE: 'test',
      HERMES_CLAUDE_FALLBACK: 'true',
      HERMES_CLAUDE_FALLBACK_PROVIDER: 'openrouter',
      HERMES_CLAUDE_FALLBACK_MODELS: 'anthropic/claude-opus-4.8,anthropic/claude-sonnet-4.6',
    },
    provider: 'openai-codex',
    model: 'gpt-5.4',
    enableClaudeFallback: true,
    spawnSyncImpl: makeSpawnStub([
      { stdout: '', stderr: 'primary failed', status: 1, error: null },
      { stdout: '{"ok":true}', stderr: '', status: 0, error: null },
    ], calls),
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0][calls[0].indexOf('--provider') + 1], 'openai-codex');
  assert.equal(calls[0][calls[0].indexOf('-m') + 1], 'gpt-5.4');
  assert.equal(calls[1][calls[1].indexOf('--provider') + 1], 'openrouter');
  assert.equal(calls[1][calls[1].indexOf('-m') + 1], 'anthropic/claude-opus-4.8');
  assert.equal(result.ok, true);
  assert.equal(result.fallback_used, true);
  assert.equal(result.error_code, null);
  assert.equal(result.invocation.provider, 'openrouter');
  assert.equal(result.invocation.model_id, 'anthropic/claude-opus-4.8');
  assert.equal(result.invocation.fallback_reason, 'missing_output');
  assert.equal(result.invocation.retry_count, 1);
});

test('fallback metadata records provider, runtime, model_id, artifact paths, and retry count', () => {
  const calls = [];
  const result = runHermesChat('prompt', {
    env: {
      HERMES_SOURCE: 'test',
    },
    enableClaudeFallback: true,
    fallbackTargets: [{ provider: 'openrouter', model_id: 'anthropic/claude-opus-4.8' }],
    inputArtifactPaths: ['/tmp/input-one.json', '/tmp/input-two.json'],
    validateOutput: (parsed) => Boolean(parsed && parsed.allowed === true),
    spawnSyncImpl: makeSpawnStub([
      { stdout: '', stderr: 'timed out', status: 1, error: { code: 'ETIMEDOUT' } },
      { stdout: '{"allowed":true}', stderr: '', status: 0, error: null },
    ], calls),
  });

  assert.equal(calls.length, 2);
  assert.equal(result.ok, true);
  assert.equal(result.error_code, null);
  assert.equal(result.invocation.provider, 'openrouter');
  assert.equal(result.invocation.runtime, 'hermes-cli');
  assert.equal(result.invocation.model_id, 'anthropic/claude-opus-4.8');
  assert.equal(result.invocation.fallback_reason, 'timeout');
  assert.deepEqual(result.invocation.input_artifact_paths, ['/tmp/input-one.json', '/tmp/input-two.json']);
  assert.equal(result.invocation.output_schema_valid, true);
  assert.equal(result.invocation.retry_count, 1);
  assert.equal(result.invocation.used_in_score, false);
});
