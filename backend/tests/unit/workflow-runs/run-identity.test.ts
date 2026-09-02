/**
 * V2-005 — deterministic run-family identity derivations (PURE).
 *
 * Mirrors the V2-002 identity discipline: the same authoritative inputs always
 * converge on byte-identical identities; no randomness, clock, or process
 * state ever enters identity. Duplicate run submissions (duplicate trigger
 * delivery) are therefore structurally convergent — divergent duplicate run
 * rows are unrepresentable.
 */
import { describe, it, expect } from 'vitest';
import {
  deriveWorkflowRunId,
  deriveRunAttemptId,
  deriveRunStepId,
  deriveRunInvocationId,
  deriveRunEvidenceId,
  deriveRunEventId,
  deriveRunCommandId,
  deriveRunRejectionId,
  runInputDigest,
} from '../../../src/workflow-runs/internal/identity.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const ORG2 = '22222222-2222-4222-8222-222222222222';
const WF = 'wfw_0123456789abcdef0123456789abcdef';
const WFV = 'wfwv_0123456789abcdef0123456789abcdef';
const CMD = 'cmd-triage-start-0001';

const COMMIT_A = '6a1b31c7a2f04d0c5b8e4c2f6c9d8e0f1a2b3c4d5e6f708192a3b4c5d6e7f809';
const COMMIT_B = 'b7a731c7a2f04d0c5b8e4c2f6c9d8e0f1a2b3c4d5e6f708192a3b4c5d6e7f80a';

describe('V2-005 — run identity derivations', () => {
  it('derives the run identity from exactly the authoritative pin inputs', () => {
    const id = deriveWorkflowRunId({
      organizationId: ORG,
      workflowId: WF,
      versionId: WFV,
      triggerType: 'webhook',
      triggerId: 'delivery-9f2c1',
      inputDigest: runInputDigest([COMMIT_A, COMMIT_B]),
    });
    expect(id).toMatch(/^wfr_[0-9a-f]{32}$/);
    // determinism: identical inputs → identical identity
    expect(
      deriveWorkflowRunId({
        organizationId: ORG,
        workflowId: WF,
        versionId: WFV,
        triggerType: 'webhook',
        triggerId: 'delivery-9f2c1',
        inputDigest: runInputDigest([COMMIT_A, COMMIT_B]),
      }),
    ).toBe(id);
  });

  it('input commitments are a SET: order never changes the run identity', () => {
    const forward = runInputDigest([COMMIT_A, COMMIT_B]);
    const backward = runInputDigest([COMMIT_B, COMMIT_A]);
    expect(forward).toBe(backward);
    expect(forward).toMatch(/^[0-9a-f]{64}$/);
  });

  it('every authoritative input dimension changes the run identity', () => {
    const base = {
      organizationId: ORG,
      workflowId: WF,
      versionId: WFV,
      triggerType: 'webhook' as const,
      triggerId: 'delivery-9f2c1',
      inputDigest: runInputDigest([COMMIT_A]),
    };
    const baseId = deriveWorkflowRunId(base);
    expect(deriveWorkflowRunId({ ...base, organizationId: ORG2 })).not.toBe(baseId);
    expect(deriveWorkflowRunId({ ...base, workflowId: 'wfw_other' })).not.toBe(baseId);
    expect(deriveWorkflowRunId({ ...base, versionId: 'wfwv_other' })).not.toBe(baseId);
    expect(deriveWorkflowRunId({ ...base, triggerType: 'manual' })).not.toBe(baseId);
    expect(deriveWorkflowRunId({ ...base, triggerId: 'delivery-9f2c2' })).not.toBe(baseId);
    expect(deriveWorkflowRunId({ ...base, inputDigest: runInputDigest([COMMIT_B]) })).not.toBe(baseId);
  });

  it('duplicate trigger delivery converges: same trigger identity → same run identity', () => {
    // two DIFFERENT command ids for the same event delivery still describe the
    // SAME run — duplicate event delivery is idempotent at the identity layer.
    const a = deriveWorkflowRunId({
      organizationId: ORG,
      workflowId: WF,
      versionId: WFV,
      triggerType: 'webhook',
      triggerId: 'delivery-9f2c1',
      inputDigest: runInputDigest([COMMIT_A]),
    });
    const b = deriveWorkflowRunId({
      organizationId: ORG,
      workflowId: WF,
      versionId: WFV,
      triggerType: 'webhook',
      triggerId: 'delivery-9f2c1',
      inputDigest: runInputDigest([COMMIT_A]),
    });
    expect(a).toBe(b);
  });

  it('derives attempt/step/invocation/evidence/event/command/rejection identities with stable prefixes', () => {
    const attempt = deriveRunAttemptId({ runId: 'wfr_x', attemptNumber: 1 });
    expect(attempt).toMatch(/^wfra_[0-9a-f]{32}$/);
    expect(deriveRunAttemptId({ runId: 'wfr_x', attemptNumber: 2 })).not.toBe(attempt);

    const step = deriveRunStepId({ runId: 'wfr_x', attemptNumber: 1, stepId: 'notify' });
    expect(step).toMatch(/^wfrs_[0-9a-f]{32}$/);
    expect(deriveRunStepId({ runId: 'wfr_x', attemptNumber: 2, stepId: 'notify' })).not.toBe(step);

    const invocation = deriveRunInvocationId({
      runId: 'wfr_x',
      attemptNumber: 1,
      stepId: 'notify',
      capability: 'messaging.send',
      commandId: CMD,
    });
    expect(invocation).toMatch(/^wfri_[0-9a-f]{32}$/);
    // a retried invocation is a NEW invocation identity (retry = new command)
    expect(
      deriveRunInvocationId({
        runId: 'wfr_x',
        attemptNumber: 1,
        stepId: 'notify',
        capability: 'messaging.send',
        commandId: 'cmd-retry-2',
      }),
    ).not.toBe(invocation);

    const evidence = deriveRunEvidenceId({
      runId: 'wfr_x',
      evidenceClass: 'observation',
      producerKind: 'executor',
      producerId: 'host-1',
      contentCommitment: COMMIT_A,
    });
    expect(evidence).toMatch(/^wfre_[0-9a-f]{32}$/);
    // the SAME evidence re-delivered converges on the SAME identity
    expect(
      deriveRunEvidenceId({
        runId: 'wfr_x',
        evidenceClass: 'observation',
        producerKind: 'executor',
        producerId: 'host-1',
        contentCommitment: COMMIT_A,
      }),
    ).toBe(evidence);

    const event = deriveRunEventId({ runId: 'wfr_x', eventName: 'workflow.run.started', subject: 'attempt:1' });
    expect(event).toMatch(/^wfrev_[0-9a-f]{32}$/);
    expect(deriveRunEventId({ runId: 'wfr_x', eventName: 'workflow.run.paused', subject: 'attempt:1' })).not.toBe(event);

    const command = deriveRunCommandId({ organizationId: ORG, commandId: CMD });
    expect(command).toMatch(/^wfrc_[0-9a-f]{32}$/);
    expect(deriveRunCommandId({ organizationId: ORG, commandId: 'cmd-other' })).not.toBe(command);

    const rejection = deriveRunRejectionId({
      runId: 'wfr_x',
      attestationId: 'wfea_1',
      failureCode: 'ATTESTATION_REPLAYED',
      commandId: CMD,
    });
    expect(rejection).toMatch(/^wfrx_[0-9a-f]{32}$/);
  });

  it('evidence identity separates CLASSES: the same commitment in two classes is two records', () => {
    const observation = deriveRunEvidenceId({
      runId: 'wfr_x',
      evidenceClass: 'observation',
      producerKind: 'executor',
      producerId: 'host-1',
      contentCommitment: COMMIT_A,
    });
    const verification = deriveRunEvidenceId({
      runId: 'wfr_x',
      evidenceClass: 'verification',
      producerKind: 'executor',
      producerId: 'host-1',
      contentCommitment: COMMIT_A,
    });
    expect(observation).not.toBe(verification);
  });
});
