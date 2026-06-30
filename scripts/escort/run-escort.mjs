#!/usr/bin/env node

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runEscort } from './escort-state-machine.mjs';

function parseArgs(argv) {
  const args = {
    fake: false,
    runId: `esc_cli_${Date.now()}`,
    route: 'mentions',
    subject: null,
    adapters: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--fake') {
      args.fake = true;
    } else if (token === '--run-id') {
      args.runId = argv[index + 1];
      index += 1;
    } else if (token === '--route') {
      args.route = argv[index + 1];
      index += 1;
    } else if (token === '--subject') {
      args.subject = JSON.parse(argv[index + 1]);
      index += 1;
    } else if (token === '--adapters') {
      args.adapters = argv[index + 1];
      index += 1;
    }
  }

  return args;
}

async function exists(path) {
  if (!path) return false;
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readText(path) {
  if (!(await exists(path))) return '';
  return readFile(path, 'utf8');
}

function buildProofWriter(baseDir = '/tmp/escort/runs') {
  return async (artifact) => {
    const path = `${baseDir}/${artifact.run_id}.json`;
    await mkdir(baseDir, { recursive: true });
    await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    return { ok: true, path };
  };
}

function buildFilesystemAdapters(subject) {
  return {
    research: async () => {
      if (subject.researchStatus === 'unavailable') {
        return { ok: true, status: 'unavailable', explicit: true };
      }

      if (subject.researchPath && (await exists(subject.researchPath))) {
        return { ok: true, status: 'present', artifact: subject.researchPath };
      }

      return {
        ok: false,
        status: 'missing',
        fingerprint: 'research.missing',
        requiresNoTouch: subject.researchRequiresNoTouch === true,
      };
    },
    render: async () => {
      const renderBody = await readText(subject.renderPath);
      const nonEmpty = renderBody.trim().length > 0;
      return {
        ok: nonEmpty,
        nonEmpty,
        failClosed: nonEmpty ? false : subject.renderFailClosed !== false,
        path: subject.renderPath,
        fingerprint: nonEmpty ? undefined : 'render.empty',
        requiresNoTouch: subject.renderRequiresNoTouch === true,
      };
    },
    evidence: async () => ({
      ok: subject.evidenceOk !== false,
      layersMatchRoute: subject.layersMatchRoute !== false,
      fingerprint: subject.evidenceFingerprint,
      requiresNoTouch: subject.evidenceRequiresNoTouch === true,
    }),
    audit: async () => ({
      ok: subject.auditOk !== false,
      survivingBlockers: Number(subject.survivingBlockers ?? 0),
      fingerprint: subject.auditFingerprint,
      requiresNoTouch: subject.auditRequiresNoTouch === true,
    }),
    priceIsolation: async () => ({
      ok: subject.priceLeak !== true,
      leak: subject.priceLeak === true,
      field: subject.priceLeakField,
      fingerprint: subject.priceFingerprint,
    }),
    idempotency: async () => ({
      ok: true,
      duplicate: subject.duplicate === true,
      fingerprint: subject.idempotencyFingerprint,
    }),
    writeProof: buildProofWriter(subject.proofDir),
  };
}

function buildFakeAdapters() {
  return {
    research: async () => ({ ok: true, status: 'present', artifact: '/tmp/escort/research.json' }),
    render: async () => ({ ok: true, nonEmpty: true, failClosed: false, path: '/tmp/escort/render.txt' }),
    evidence: async () => ({ ok: true, layersMatchRoute: true }),
    audit: async () => ({ ok: true, survivingBlockers: 0 }),
    priceIsolation: async () => ({ ok: true, leak: false }),
    idempotency: async () => ({ ok: true, duplicate: false }),
    writeProof: buildProofWriter(),
  };
}

async function loadAdapters(args, subject) {
  if (args.adapters) {
    const modulePath = resolve(process.cwd(), args.adapters);
    const loaded = await import(modulePath);
    if (typeof loaded.buildAdapters === 'function') {
      return loaded.buildAdapters(args);
    }
    if (loaded.default && typeof loaded.default === 'object') {
      return loaded.default;
    }
    if (loaded.adapters && typeof loaded.adapters === 'object') {
      return loaded.adapters;
    }
    throw new Error(`Adapter module did not export buildAdapters(), default, or adapters: ${modulePath}`);
  }

  if (args.fake) {
    return buildFakeAdapters();
  }

  return buildFilesystemAdapters(subject);
}

const args = parseArgs(process.argv.slice(2));
const subject = { runId: args.runId, route: args.route, ...(args.subject ?? {}) };
const adapters = await loadAdapters(args, subject);
const result = await runEscort(subject, adapters);

console.log(JSON.stringify(result, null, 2));

if (result.proofArtifact?.path) {
  console.log(`proof_artifact_path=${result.proofArtifact.path}`);
}

if (result.terminalState === 'BLOCKED') {
  process.exitCode = 1;
}
