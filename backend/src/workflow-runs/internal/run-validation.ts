/**
 * V2-005 — typed, fail-closed input validation (PURE). Every rejection is a
 * discriminated WorkflowRunError code — never a bare throw across the public
 * boundary, never string parsing by callers.
 */
import { WorkflowRunError, type RunCommandEnvelope, type RunEvidenceClass, type RunExecutionClass, type RunTriggerType } from '../types.js';
import { RUN_TRIGGER_TYPES } from '../types.js';
import {
  isCanonicalCapability,
  isCanonicalEvidenceClass,
  isCanonicalExecutionClass,
} from './registry-vocabulary.js';
import { commandPayloadDigest, sha256Hex } from './identity.js';

const COMMAND_ID_MAX = 256;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A non-empty trimmed string of at most 256 characters. */
function isIdentityText(value: string): boolean {
  return value.trim().length > 0 && value.length <= COMMAND_ID_MAX;
}

/** Validate the command envelope: deterministic idempotency + correlation identity. */
export function assertRunCommandEnvelope(envelope: RunCommandEnvelope): void {
  if (typeof envelope.commandId !== 'string' || !isIdentityText(envelope.commandId)) {
    throw new WorkflowRunError(
      'RUN_COMMAND_ID_INVALID',
      `commandId must be a non-empty string of at most ${COMMAND_ID_MAX} characters (got: ${JSON.stringify(envelope.commandId)})`,
    );
  }
  if (typeof envelope.correlationId !== 'string' || !isIdentityText(envelope.correlationId)) {
    throw new WorkflowRunError(
      'RUN_COMMAND_CORRELATION_ID_INVALID',
      `correlationId must be a non-empty string of at most ${COMMAND_ID_MAX} characters — every command carries deterministic correlation (got: ${JSON.stringify(envelope.correlationId)})`,
    );
  }
  if (envelope.causationId !== undefined && (typeof envelope.causationId !== 'string' || !isIdentityText(envelope.causationId))) {
    throw new WorkflowRunError(
      'RUN_COMMAND_CORRELATION_ID_INVALID',
      `causationId, when present, must be a non-empty string of at most ${COMMAND_ID_MAX} characters (got: ${JSON.stringify(envelope.causationId)})`,
    );
  }
}

/** The command payload commitment: canonical-JSON sha-256 (deterministic). */
export { commandPayloadDigest };

/** Validate a trigger: closed category vocabulary + external trigger identity. */
export function assertRunTrigger(trigger: { type: unknown; id: unknown }): asserts trigger is { type: RunTriggerType; id: string } {
  if (typeof trigger.type !== 'string' || !(RUN_TRIGGER_TYPES as readonly string[]).includes(trigger.type)) {
    throw new WorkflowRunError(
      'RUN_INVALID_TRIGGER_TYPE',
      `trigger.type must be one of ${RUN_TRIGGER_TYPES.join('|')} (constitution §11 trigger categories; got: ${JSON.stringify(trigger.type)})`,
    );
  }
  if (typeof trigger.id !== 'string' || !isIdentityText(trigger.id)) {
    throw new WorkflowRunError(
      'RUN_INVALID_TRIGGER_TYPE',
      `trigger.id (the external trigger/event identity — the duplicate-delivery dedupe key) must be a non-empty string of at most ${COMMAND_ID_MAX} characters (got: ${JSON.stringify(trigger.id)})`,
    );
  }
}

/** Validate a commitment list: sha-256 hex values only (never raw payloads). */
export function assertRunCommitmentList(commitments: readonly unknown[]): void {
  for (const commitment of commitments) {
    if (typeof commitment !== 'string' || !SHA256_HEX.test(commitment)) {
      throw new WorkflowRunError(
        'RUN_INVALID_INPUT_COMMITMENTS',
        `commitments must be lowercase 64-hex sha-256 values (one-way commitments — raw parameter/secret values never enter; got: ${JSON.stringify(commitment)})`,
      );
    }
  }
}

/** Validate an evidence class: the closed registry evidence vocabulary. */
export function assertRunEvidenceClass(value: unknown): asserts value is RunEvidenceClass {
  if (!isCanonicalEvidenceClass(typeof value === 'string' ? value : '')) {
    throw new WorkflowRunError(
      'RUN_EVIDENCE_CLASS_INVALID',
      `evidenceClass must be one of the canonical registry evidence classes intent|observation|claim|verification|human_confirmation (got: ${JSON.stringify(value)})`,
    );
  }
}

/** Validate evidence provenance: producer kind + identity are REQUIRED. */
export function assertRunEvidenceProducer(producer: { producerKind: unknown; producerId: unknown }): void {
  if (
    typeof producer.producerKind !== 'string' ||
    producer.producerKind.trim().length === 0 ||
    producer.producerKind.length > COMMAND_ID_MAX
  ) {
    throw new WorkflowRunError(
      'RUN_EVIDENCE_PRODUCER_REQUIRED',
      `producerKind is REQUIRED provenance (a non-empty string of at most ${COMMAND_ID_MAX} characters; got: ${JSON.stringify(producer.producerKind)})`,
    );
  }
  if (
    typeof producer.producerId !== 'string' ||
    producer.producerId.trim().length === 0 ||
    producer.producerId.length > COMMAND_ID_MAX
  ) {
    throw new WorkflowRunError(
      'RUN_EVIDENCE_PRODUCER_REQUIRED',
      `producerId is REQUIRED provenance (a non-empty string of at most ${COMMAND_ID_MAX} characters; got: ${JSON.stringify(producer.producerId)})`,
    );
  }
}

/**
 * The registry timeline projection for an evidence class: observation →
 * observation.recorded; verification → verification.completed; the other
 * classes are evidence records with NO registry event name (they never
 * masquerade as protocol events).
 */
export function evidenceTimelineEventName(
  evidenceClass: RunEvidenceClass,
): 'observation.recorded' | 'verification.completed' | null {
  if (evidenceClass === 'observation') return 'observation.recorded';
  if (evidenceClass === 'verification') return 'verification.completed';
  return null;
}

/** Validate a capability invocation: canonical registry name, verbatim. */
export function assertRunCapabilityName(capability: unknown): asserts capability is string {
  if (typeof capability !== 'string' || !isCanonicalCapability(capability)) {
    throw new WorkflowRunError(
      'RUN_CAPABILITY_NON_CANONICAL',
      `capability must be a canonical registry capability name (verbatim — aliases are forbidden; got: ${JSON.stringify(capability)})`,
    );
  }
}

/** Validate an execution class: the four canonical registry identifiers. */
export function assertRunExecutionClass(value: unknown): asserts value is RunExecutionClass {
  if (typeof value !== 'string' || !isCanonicalExecutionClass(value)) {
    throw new WorkflowRunError(
      'RUN_EXECUTION_CLASS_INVALID',
      `executionClass must be one of deterministic_api|agentic_computer_use|human|subworkflow (canonical registry execution classes; got: ${JSON.stringify(value)})`,
    );
  }
}

/** Content commitment of an arbitrary value (one-way; never raw content). */
export function contentCommitmentOf(value: string): string {
  return sha256Hex(value);
}
