/**
 * V2-005 — the deterministic identity + digest derivations (PURE).
 *
 * Same discipline as the merged V2-002 identity layer: the same authoritative
 * inputs always produce byte-identical identities — no randomness, no clock,
 * no process-local state ever enters identity. Duplicate run submissions and
 * duplicate event delivery therefore converge structurally (divergent
 * duplicate run rows are unrepresentable — the migration's UNIQUE constraints
 * are the persistence-layer defense in depth).
 *
 * The canonical-JSON helper is deliberately module-internal (the recorded
 * W1/W2A finding: canonical-JSON helpers stay module-internal per domain;
 * IG-001 may consolidate them after the merges).
 */
import { createHash } from 'node:crypto';

/** SHA-256 hex (64 lowercase chars) over the UTF-8 bytes of `input`. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Canonical JSON: UTF-8 JSON with deterministic object-key ordering
 * (recursive), no insignificant whitespace. Array order is PRESERVED unless
 * the owning derivation explicitly normalizes (e.g. run input commitments are
 * a SET — sorted before digesting).
 */
export function canonicalJson(value: unknown): string {
  return serializeCanonical(value);
}

function serializeCanonical(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => serializeCanonical(item));
    return `[${items.join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((key) => obj[key] !== undefined)
      .sort();
    const members = keys.map((key) => `${JSON.stringify(key)}:${serializeCanonical(obj[key])}`);
    return `{${members.join(',')}}`;
  }
  throw new Error(`workflow-runs: value of type ${typeof value} is not a canonical-JSON value`);
}

/**
 * The run input digest: SHA-256 over the canonical JSON of the SORTED input
 * commitment set. Input commitments are a SET (order-insensitive); raw
 * parameter values never enter (statement-privacy rules — one-way
 * commitments only).
 */
export function runInputDigest(commitments: readonly string[]): string {
  const sorted = [...commitments].sort();
  return sha256Hex(canonicalJson(sorted));
}

/**
 * The command payload commitment: SHA-256 over the canonical JSON of the
 * payload (object key order normalized — a replay of the same command always
 * digests identically; array order IS preserved because command sequences
 * are not sets). The same command id with a DIFFERENT payload is a typed
 * conflict, never a silent re-execution.
 */
export function commandPayloadDigest(payload: unknown): string {
  return sha256Hex(canonicalJson(payload));
}

/** Identity-kind labels for hash domain separation (internal preimage fields). */
type IdentityKind =
  | 'workflow-run'
  | 'run-attempt'
  | 'run-step'
  | 'run-invocation'
  | 'run-evidence'
  | 'run-event'
  | 'run-command'
  | 'run-attestation-rejection';

const IDENTITY_PREFIX: Record<IdentityKind, string> = {
  'workflow-run': 'wfr_',
  'run-attempt': 'wfra_',
  'run-step': 'wfrs_',
  'run-invocation': 'wfri_',
  'run-evidence': 'wfre_',
  'run-event': 'wfrev_',
  'run-command': 'wfrc_',
  'run-attestation-rejection': 'wfrx_',
};

/** Derive a durable identity: prefixed 32-hex from SHA-256 over the canonical identity object. */
function deriveIdentity(kind: IdentityKind, fields: Record<string, string>): string {
  const preimage: Record<string, string> = { kind, ...fields };
  const digest = sha256Hex(canonicalJson(preimage));
  return `${IDENTITY_PREFIX[kind]}${digest.slice(0, 32)}`;
}

/**
 * The WorkflowRun identity: derived ONLY from the authoritative pin inputs
 * (tenant organization, workflow, immutable version, trigger type+identity,
 * input commitment digest). Duplicate trigger delivery with the same inputs
 * converges on the SAME run identity; the same trigger with different inputs
 * is a distinct run (the input surface is part of run identity).
 */
export function deriveWorkflowRunId(input: {
  organizationId: string;
  workflowId: string;
  versionId: string;
  triggerType: string;
  triggerId: string;
  inputDigest: string;
}): string {
  return deriveIdentity('workflow-run', {
    organizationId: input.organizationId,
    workflowId: input.workflowId,
    versionId: input.versionId,
    triggerType: input.triggerType,
    triggerId: input.triggerId,
    inputDigest: input.inputDigest,
  });
}

/** The attempt identity: (run, attempt number) — one row per execution attempt. */
export function deriveRunAttemptId(input: { runId: string; attemptNumber: number }): string {
  return deriveIdentity('run-attempt', {
    runId: input.runId,
    attemptNumber: String(input.attemptNumber),
  });
}

/** The step execution identity: (run, attempt, step) — one execution record per step per attempt. */
export function deriveRunStepId(input: { runId: string; attemptNumber: number; stepId: string }): string {
  return deriveIdentity('run-step', {
    runId: input.runId,
    attemptNumber: String(input.attemptNumber),
    stepId: input.stepId,
  });
}

/**
 * The capability invocation identity: (run, attempt, step, capability,
 * command id). A RETRIED invocation (a new command) is a NEW invocation
 * identity — retries are first-class distinct invocations.
 */
export function deriveRunInvocationId(input: {
  runId: string;
  attemptNumber: number;
  stepId: string | null;
  capability: string;
  commandId: string;
}): string {
  return deriveIdentity('run-invocation', {
    runId: input.runId,
    attemptNumber: String(input.attemptNumber),
    stepId: input.stepId ?? '',
    capability: input.capability,
    commandId: input.commandId,
  });
}

/**
 * The evidence record identity: (run, class, producer, content commitment).
 * Re-delivered identical evidence converges on the SAME record; the SAME
 * commitment recorded under a DIFFERENT class is a DIFFERENT record (classes
 * never impersonate one another).
 */
export function deriveRunEvidenceId(input: {
  runId: string;
  evidenceClass: string;
  producerKind: string;
  producerId: string;
  contentCommitment: string;
}): string {
  return deriveIdentity('run-evidence', {
    runId: input.runId,
    evidenceClass: input.evidenceClass,
    producerKind: input.producerKind,
    producerId: input.producerId,
    contentCommitment: input.contentCommitment,
  });
}

/**
 * The timeline event identity: (run, event name, subject). Deterministic per
 * (event, subject) pair — re-recording the same subject's event converges on
 * the same timeline row (the command layer prevents duplicate submission
 * anyway; this is defense in depth).
 */
export function deriveRunEventId(input: { runId: string; eventName: string; subject: string }): string {
  return deriveIdentity('run-event', {
    runId: input.runId,
    eventName: input.eventName,
    subject: input.subject,
  });
}

/** The command-log identity: (tenant organization, command id) — the dedupe boundary. */
export function deriveRunCommandId(input: { organizationId: string; commandId: string }): string {
  return deriveIdentity('run-command', {
    organizationId: input.organizationId,
    commandId: input.commandId,
  });
}

/** The attestation-rejection identity: (run, attestation, failure, command). */
export function deriveRunRejectionId(input: {
  runId: string;
  attestationId: string | null;
  failureCode: string;
  commandId: string;
}): string {
  return deriveIdentity('run-attestation-rejection', {
    runId: input.runId,
    attestationId: input.attestationId ?? '',
    failureCode: input.failureCode,
    commandId: input.commandId,
  });
}
