/**
 * WORK-069 §3 — the deterministic decision identity (no randomness, no
 * implicit clock — the WORK-066 scheduling-identity / WORK-067
 * signal-identity precedent).
 */
import { createHash } from 'node:crypto';
import type {
  DecideProgressiveReleaseInput,
  ProgressiveRolloutStage,
} from '../types.js';
import { ProgressiveReleaseError } from '../types.js';

/** The canonical validation of the decision request (fail closed on every dimension). */
export function requireValidDecisionRequest(input: DecideProgressiveReleaseInput): void {
  if (typeof input.tenantId !== 'string' || input.tenantId.trim().length === 0) {
    throw new ProgressiveReleaseError('PR_INPUT_TENANT_REQUIRED', 'the decision request requires a non-empty tenantId scope');
  }
  if (typeof input.projectId !== 'string' || input.projectId.trim().length === 0) {
    throw new ProgressiveReleaseError('PR_INPUT_PROJECT_REQUIRED', 'the decision request requires a non-empty projectId scope');
  }
  if (typeof input.environmentId !== 'string' || input.environmentId.trim().length === 0) {
    throw new ProgressiveReleaseError('PR_INPUT_ENVIRONMENT_REQUIRED', 'the decision request requires a non-empty environmentId (the rollout target environment)');
  }
  if (typeof input.releaseRef !== 'string' || input.releaseRef.trim().length === 0) {
    throw new ProgressiveReleaseError('PR_INPUT_RELEASE_REF_REQUIRED', 'the decision request requires the RECORDED releaseRef (never invented here)');
  }
  if (typeof input.validationRunId !== 'string' || input.validationRunId.trim().length === 0) {
    throw new ProgressiveReleaseError('PR_INPUT_VALIDATION_RUN_ID_REQUIRED', 'the decision request requires the WORK-064 validationRunId binding');
  }
  if (input.releaseObservedAt !== undefined) {
    const parsed = Date.parse(input.releaseObservedAt);
    if (typeof input.releaseObservedAt !== 'string' || Number.isNaN(parsed)) {
      throw new ProgressiveReleaseError(
        'PR_INPUT_RELEASE_OBSERVED_AT_INVALID',
        'releaseObservedAt, when supplied, must be the caller-RECORDED ISO-8601 release boundary time (never inferred here)',
      );
    }
  }
}

/**
 * The logical reference of the runtime observation within the decision
 * identity: the observation EVENT identity (deployment + the record's own
 * observed time — a status change is a NEW observation event and therefore
 * a NEW logical decision event). 'unavailable' when the observation is
 * missing (repeated unavailable deliveries are then idempotent).
 */
export function runtimeObservationReference(observation: {
  kind: 'deployment';
  deploymentId: string;
  observedAt: string;
} | null): string {
  if (observation === null) return 'runtime-observation:unavailable';
  return `runtime-observation:${observation.kind}:${observation.deploymentId}:${observation.observedAt}`;
}

/** The identity inputs (the logical decision event's scope dimensions). */
export interface DecisionIdentityInput {
  readonly tenantId: string;
  readonly projectId: string;
  readonly releaseRef: string;
  readonly rolloutStage: ProgressiveRolloutStage;
  readonly validationRunId: string;
  /** The runtime observation's logical reference (participates — new facts, new decision). */
  readonly runtimeObservationRef: string;
}

/**
 * The deterministic decision identity: sha256 over the canonical field
 * order. The SAME logical decision event (same release, stage, validation
 * run, runtime observation, scope) always yields the SAME identity —
 * duplicate delivery converges; different scope/release/stage/run/
 * observation are INDEPENDENT decisions.
 */
export function deriveDecisionIdentity(input: DecisionIdentityInput): {
  decisionId: string;
  identityFingerprint: string;
} {
  const canonical = [
    'workflowos.progressive-release.decision.v1',
    input.tenantId,
    input.projectId,
    input.releaseRef,
    input.rolloutStage,
    input.validationRunId,
    input.runtimeObservationRef,
  ].join('\n');
  const fingerprint = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return {
    decisionId: `prd_${fingerprint.slice(0, 24)}`,
    identityFingerprint: fingerprint,
  };
}

/**
 * The content fingerprint: identity + the DERIVED decision + reason +
 * policy version. A re-delivery with the SAME identity but a DIFFERENT
 * content fingerprint is a typed conflict — the same logical decision
 * event cannot carry two different outcomes (the WORK-066 claim-store
 * conflict semantics, mirrored).
 */
export function deriveContentFingerprint(input: {
  identityFingerprint: string;
  decision: string;
  reason: string;
  policyVersion: string;
  validationOutcomeKind: string | null;
}): string {
  const canonical = [
    'workflowos.progressive-release.decision-content.v1',
    input.identityFingerprint,
    input.decision,
    input.reason,
    input.policyVersion,
    input.validationOutcomeKind ?? 'none',
  ].join('\n');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
