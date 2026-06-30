const TERMINAL_PASS = 'PASS_READY_TO_SEND';
const TERMINAL_BLOCKED = 'BLOCKED';
const TERMINAL_DUPLICATE = 'HELD_DUPLICATE';

const CHECKPOINTS = [
  'RESEARCH_CHECK',
  'RENDER',
  'EVIDENCE_CHECK',
  'AUDIT',
  'PRICE_ISOLATION',
  'IDEMPOTENCY',
];

const CHECKPOINT_CONFIG = {
  RESEARCH_CHECK: {
    adapter: 'research',
    isClean: (result) => {
      if (result?.status === 'unavailable') return result?.explicit === true;
      if (result?.ok === false) return false;
      return result?.status === 'present' || result?.ok === true;
    },
    fallbackFingerprint: 'research.failed',
  },
  RENDER: {
    adapter: 'render',
    isClean: (result) => result?.ok !== false && result?.nonEmpty !== false && result?.failClosed !== true,
    fallbackFingerprint: 'render.failed',
  },
  EVIDENCE_CHECK: {
    adapter: 'evidence',
    isClean: (result) => result?.ok !== false && result?.layersMatchRoute !== false,
    fallbackFingerprint: 'evidence.failed',
  },
  AUDIT: {
    adapter: 'audit',
    isClean: (result) => result?.ok !== false && Number(result?.survivingBlockers ?? 0) === 0,
    fallbackFingerprint: 'audit.failed',
  },
  PRICE_ISOLATION: {
    adapter: 'priceIsolation',
    isClean: (result) => result?.ok !== false && result?.leak !== true,
    fallbackFingerprint: 'price.failed',
  },
  IDEMPOTENCY: {
    adapter: 'idempotency',
    isClean: (result) => result?.ok !== false && result?.duplicate !== true,
    fallbackFingerprint: 'idempotency.failed',
  },
};

const LESSON_REQUIRED_FIELDS = [
  'source_run_id',
  'blocker_fingerprint',
  'repair_attempted',
  'outcome',
  'safe_to_automate_next_time',
  'required_proof_before_reuse',
];

function normalizeRunId(subject = {}) {
  return subject.runId ?? subject.run_id ?? `esc_${Date.now()}`;
}

function fingerprintFor(checkpoint, result = {}) {
  if (checkpoint === 'PRICE_ISOLATION' && result?.leak === true) {
    const parts = [];
    if (typeof result?.field === 'string' && result.field) parts.push(`field=${result.field}`);
    if (typeof result?.fingerprint === 'string' && result.fingerprint && !result.fingerprint.startsWith('price.leak')) {
      parts.push(result.fingerprint);
    }
    if (typeof result?.fingerprint === 'string' && result.fingerprint.startsWith('price.leak')) {
      return result.fingerprint;
    }
    return ['price.leak', ...parts].join(':');
  }

  if (typeof result?.fingerprint === 'string' && result.fingerprint) {
    return result.fingerprint;
  }

  return CHECKPOINT_CONFIG[checkpoint]?.fallbackFingerprint ?? `${checkpoint.toLowerCase()}.failed`;
}

function normalizeErrorResult(checkpoint, error) {
  const name = error?.name ?? 'Error';
  const message = error?.message ?? String(error);
  return {
    ok: false,
    fingerprint: `${CHECKPOINT_CONFIG[checkpoint]?.fallbackFingerprint ?? checkpoint.toLowerCase()}.exception:${name}`,
    error: message,
  };
}

export function validateLesson(obj) {
  if (!obj || typeof obj !== 'object') return false;

  for (const field of LESSON_REQUIRED_FIELDS) {
    if (!(field in obj)) return false;
  }

  if (typeof obj.safe_to_automate_next_time !== 'boolean') return false;

  return LESSON_REQUIRED_FIELDS.every((field) => {
    if (field === 'safe_to_automate_next_time') return true;
    return obj[field] !== '' && obj[field] !== null && obj[field] !== undefined;
  });
}

export function step(state, checkpointResult) {
  const checkpoint = state?.checkpoint;
  const config = CHECKPOINT_CONFIG[checkpoint];
  if (!config) {
    throw new Error(`Unknown checkpoint: ${checkpoint}`);
  }

  if (checkpoint === 'IDEMPOTENCY' && checkpointResult?.duplicate === true) {
    return { decision: 'held', terminalState: TERMINAL_DUPLICATE };
  }

  if (checkpoint === 'PRICE_ISOLATION' && checkpointResult?.leak === true) {
    return {
      decision: 'block',
      terminalState: TERMINAL_BLOCKED,
      blockerFingerprint: fingerprintFor(checkpoint, checkpointResult),
      handedUp: false,
    };
  }

  if (config.isClean(checkpointResult)) {
    return { decision: 'advance' };
  }

  const blockerFingerprint = fingerprintFor(checkpoint, checkpointResult);
  if (checkpointResult?.requiresNoTouch === true) {
    return {
      decision: 'block',
      terminalState: TERMINAL_BLOCKED,
      blockerFingerprint,
      handedUp: true,
    };
  }

  if ((state?.repairAttempts ?? 0) > 0 && state?.lastFingerprint === blockerFingerprint) {
    return {
      decision: 'block',
      terminalState: TERMINAL_BLOCKED,
      blockerFingerprint,
      handedUp: false,
    };
  }

  if ((state?.repairAttempts ?? 0) >= 2) {
    return {
      decision: 'block',
      terminalState: TERMINAL_BLOCKED,
      blockerFingerprint,
      handedUp: false,
    };
  }

  return {
    decision: 'retry',
    repairAttempts: (state?.repairAttempts ?? 0) + 1,
    blockerFingerprint,
    handedUp: false,
  };
}

async function callAdapter(adapterName, subject, adapters, machineState) {
  const adapter = adapters?.[adapterName];
  if (typeof adapter !== 'function') {
    return {
      ok: false,
      fingerprint: `${adapterName}.missing`,
      error: `Missing adapter: ${adapterName}`,
      requiresNoTouch: adapterName === 'writeProof',
    };
  }

  try {
    return await adapter(subject, machineState);
  } catch (error) {
    return normalizeErrorResult(machineState.checkpoint, error);
  }
}

async function writeProofArtifact(adapters, artifact) {
  if (typeof adapters?.writeProof !== 'function') {
    return {
      ok: false,
      fingerprint: 'writeProof.missing',
      error: 'Missing adapter: writeProof',
    };
  }

  try {
    return await adapters.writeProof(artifact);
  } catch (error) {
    return {
      ok: false,
      fingerprint: 'proof.write_failed',
      error: error?.message ?? String(error),
    };
  }
}

export async function runEscort(subject = {}, adapters = {}) {
  const normalizedSubject = { ...subject, runId: normalizeRunId(subject) };
  const repairState = Object.fromEntries(CHECKPOINTS.map((checkpoint) => [checkpoint, { repairAttempts: 0, lastFingerprint: null }]));
  const events = [];

  const finalize = async ({
    terminalState,
    blockerFingerprint,
    handedUp = false,
  }) => {
    const artifact = {
      run_id: normalizedSubject.runId,
      subject: normalizedSubject,
      terminal_state: terminalState,
      blocker_fingerprint: blockerFingerprint,
      handed_up: handedUp,
      events,
      repair_state: repairState,
      sent_something: false,
      generated_at: new Date().toISOString(),
    };

    let proofArtifact;
    try {
      proofArtifact = await writeProofArtifact(adapters, artifact);
    } catch (error) {
      proofArtifact = {
        ok: false,
        fingerprint: 'proof.write_failed',
        error: error?.message ?? String(error),
      };
    }

    let finalTerminalState = terminalState;
    let finalBlockerFingerprint = blockerFingerprint;
    if (proofArtifact?.ok === false) {
      finalTerminalState = TERMINAL_BLOCKED;
      finalBlockerFingerprint = finalBlockerFingerprint ?? proofArtifact.fingerprint ?? 'proof.write_failed';
    }

    return {
      terminalState: finalTerminalState,
      proofArtifact,
      blockerFingerprint: finalBlockerFingerprint,
      handedUp,
    };
  };

  for (const checkpoint of CHECKPOINTS) {
    const config = CHECKPOINT_CONFIG[checkpoint];

    while (true) {
      const machineState = {
        checkpoint,
        repairAttempts: repairState[checkpoint].repairAttempts,
        lastFingerprint: repairState[checkpoint].lastFingerprint,
      };

      const result = await callAdapter(config.adapter, normalizedSubject, adapters, machineState);
      const transition = step(machineState, result);
      events.push({
        checkpoint,
        adapter: config.adapter,
        repairAttempt: machineState.repairAttempts,
        result,
        decision: transition.decision,
        blockerFingerprint: transition.blockerFingerprint,
      });

      if (transition.decision === 'advance') break;
      if (transition.decision === 'held') {
        return finalize({ terminalState: TERMINAL_DUPLICATE });
      }
      if (transition.decision === 'block') {
        return finalize({
          terminalState: TERMINAL_BLOCKED,
          blockerFingerprint: transition.blockerFingerprint,
          handedUp: transition.handedUp === true,
        });
      }

      repairState[checkpoint] = {
        repairAttempts: transition.repairAttempts,
        lastFingerprint: transition.blockerFingerprint,
      };

      events.push({
        checkpoint: `REPAIR(${checkpoint})`,
        repairAttempt: transition.repairAttempts,
        blockerFingerprint: transition.blockerFingerprint,
      });
    }
  }

  return finalize({ terminalState: TERMINAL_PASS });
}

export const TERMINAL_STATES = {
  PASS_READY_TO_SEND: TERMINAL_PASS,
  BLOCKED: TERMINAL_BLOCKED,
  HELD_DUPLICATE: TERMINAL_DUPLICATE,
};
