/**
 * V2-005 — the Run-boundary attestation verification policy (PURE).
 *
 * The boundary CONSUMES the merged V2-014 verifier — it never redefines
 * attestation semantics (V2-014's frozen contract), never signs, and never
 * re-implements a verification check. This module constructs the verifier's
 * POLICY from run-derived binding expectations:
 *
 *   - the statement must bind the run's EXACT workflow, version, semantic
 *     digest pin, deployment/installation reference (where the run carries
 *     one), run identity, execution attempt, and (where the attach is
 *     step-scoped) the exact step;
 *   - freshness is mandatory: the injected verifier clock + the current
 *     protocol epoch + a REPLAY REGISTRY (the durable run-boundary replay
 *     state — the persisted binding row IS the single-use nonce consumption);
 *   - attester trust and required assurance are caller policy inputs (a
 *     valid signature is never automatic execution truth — registry
 *     authorityRules).
 */
import type {
  AttestationVerificationPolicy,
  AssuranceLevel,
  ReplayRegistry,
} from '../../execution-attestation/index.js';
import type { AttachRunAttestationInput, WorkflowRun } from '../types.js';

/** The run-derived pin the boundary binds verifications to. */
export type RunAttestationPin = Pick<
  WorkflowRun,
  'id' | 'workflowId' | 'versionId' | 'versionSemanticDigest' | 'installationId'
>;

/**
 * Build the run-boundary verification policy: run-derived bindings +
 * injected freshness + the attach policy inputs (attester trust, required
 * assurance, max age).
 */
export function buildRunAttestationVerificationPolicy(
  run: RunAttestationPin,
  attach: Pick<AttachRunAttestationInput, 'attemptNumber' | 'stepId' | 'policy'>,
  freshness: { readonly now: string; readonly currentEpoch: number; readonly replayRegistry: ReplayRegistry },
): AttestationVerificationPolicy {
  return {
    bindings: {
      workflowId: run.workflowId,
      workflowVersionId: run.versionId,
      workflowVersionSemanticDigest: run.versionSemanticDigest,
      ...(run.installationId !== null ? { deploymentId: run.installationId } : {}),
      runId: run.id,
      attemptId: attach.attemptNumber,
      ...(attach.stepId !== undefined ? { stepId: attach.stepId } : {}),
    },
    freshness: {
      now: freshness.now,
      currentEpoch: freshness.currentEpoch,
      replayRegistry: freshness.replayRegistry,
      ...(attach.policy?.maxAgeMs !== undefined ? { maxAgeMs: attach.policy.maxAgeMs } : {}),
    },
    ...(attach.policy?.trustedAttesterKeyIds !== undefined
      ? { attesterKeyIds: attach.policy.trustedAttesterKeyIds }
      : {}),
    ...(attach.policy?.requiredAssurance !== undefined
      ? { requiredAssurance: attach.policy.requiredAssurance as AssuranceLevel }
      : {}),
  };
}
