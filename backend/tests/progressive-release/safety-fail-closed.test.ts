/**
 * WORK-069 — the fail-closed safety proofs (§14 of the implementation
 * instruction): every unsafe/unknown state produces a TYPED non-continue
 * outcome; a missing required condition NEVER silently becomes continue;
 * missing runtime evidence NEVER becomes healthy.
 *
 * The 2026-08-31 customer dogfooding experiment (spec/architecture/v1.1/
 * dogfooding-evidence/2026-08-31-full-customer-experiment.md, F-8) is the
 * realistic negative case: NO product surface drives validation or
 * recording today, so a real-world decision request against a rollout
 * whose validation run was never recorded fails closed with
 * HALT_VALIDATION_RUN_NOT_FOUND — never a fabricated continue.
 */
import { describe, it, expect } from 'vitest';
import {
  buildDecisionStack,
  completedPostReleaseRun,
  admitPostReleaseRun,
  decisionRequestFixture,
  syntheticTenant1,
  authenticatedRolloutJourney,
} from './helpers.js';
import { describeEnvironment } from '../../src/continuous-validation/index.js';

describe('WORK-069 — fail-closed safety (§14: every unsafe/unknown state is a typed non-continue)', () => {
  it('MISSING validation (the run was never recorded) → typed HALT_VALIDATION_RUN_NOT_FOUND + the evidence-gap signal', async () => {
    const stack = buildDecisionStack();
    const result = await stack.service.decideProgressiveRelease(decisionRequestFixture());
    expect(result.outcome).toBe('decided');
    expect(result.decision.decision).toBe('halt');
    expect(result.decision.reason).toBe('HALT_VALIDATION_RUN_NOT_FOUND');
    expect(result.decision.validationOutcomeKind).toBeNull();
    // the evidence gap itself is recorded as an Engineering Signal:
    expect(result.decision.signalOutcomes).toHaveLength(1);
    expect(result.decision.signalOutcomes[0]!.logicalFailureKey).toBe(
      'progressive-release:evidence-gap:HALT_VALIDATION_RUN_NOT_FOUND',
    );
  });

  it('MISSING validation is NEVER a continue even with a healthy runtime observation (the dogfooding F-8 reality)', async () => {
    const stack = buildDecisionStack({
      runtimeObservation: {
        kind: 'deployment',
        deploymentId: 'dpl-ready-1',
        deploymentStatus: 'ready',
        observedAt: '2026-09-01T12:10:00Z',
      },
    });
    const result = await stack.service.decideProgressiveRelease(decisionRequestFixture());
    expect(result.decision.decision).toBe('halt');
    expect(result.decision.reason).toBe('HALT_VALIDATION_RUN_NOT_FOUND');
  });

  it('INCOMPLETE validation (admitted but not completed) → typed HALT_VALIDATION_RUN_NOT_COMPLETED', async () => {
    const stack = buildDecisionStack();
    await admitPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-rollout-1',
      releaseRef: 'release-2026.09.01',
    });
    const result = await stack.service.decideProgressiveRelease(decisionRequestFixture());
    expect(result.decision.decision).toBe('halt');
    expect(result.decision.reason).toBe('HALT_VALIDATION_RUN_NOT_COMPLETED');
  });

  it('WRONG MODE (a CONTINUOUS run, not POST_RELEASE) → typed HALT_VALIDATION_MODE_NOT_POST_RELEASE', async () => {
    const stack = buildDecisionStack();
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-rollout-1',
      releaseRef: 'release-2026.09.01',
      mode: 'CONTINUOUS',
      trigger: 'SCHEDULED',
      outcome: 'healthy',
    });
    const result = await stack.service.decideProgressiveRelease(decisionRequestFixture());
    expect(result.decision.decision).toBe('halt');
    expect(result.decision.reason).toBe('HALT_VALIDATION_MODE_NOT_POST_RELEASE');
  });

  it('WRONG TRIGGER (a POST_RELEASE run admitted through the SECURITY_FINDING trigger, not RELEASE) → typed HALT_VALIDATION_TRIGGER_NOT_RELEASE', async () => {
    const stack = buildDecisionStack();
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-rollout-1',
      releaseRef: 'release-2026.09.01',
      trigger: 'SECURITY_FINDING',
      outcome: 'healthy',
    });
    const result = await stack.service.decideProgressiveRelease(decisionRequestFixture());
    expect(result.decision.decision).toBe('halt');
    expect(result.decision.reason).toBe('HALT_VALIDATION_TRIGGER_NOT_RELEASE');
  });

  it('WRONG RELEASE identity (the run covers a DIFFERENT release) → typed HALT_VALIDATION_RELEASE_REF_MISMATCH', async () => {
    const stack = buildDecisionStack();
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-rollout-1',
      releaseRef: 'release-OTHER.2026.09.01',
      outcome: 'healthy',
    });
    const result = await stack.service.decideProgressiveRelease(decisionRequestFixture());
    expect(result.decision.decision).toBe('halt');
    expect(result.decision.reason).toBe('HALT_VALIDATION_RELEASE_REF_MISMATCH');
  });

  it('CROSS-TENANT evidence (the run is bound to another tenant) → typed HALT_VALIDATION_TENANT_MISMATCH', async () => {
    const stack = buildDecisionStack();
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-rollout-1',
      releaseRef: 'release-2026.09.01',
      identitySource: syntheticTenant1,
      journey: authenticatedRolloutJourney,
      outcome: 'healthy',
    });
    // The request declares a DIFFERENT tenant than the run's binding:
    const result = await stack.service.decideProgressiveRelease(
      decisionRequestFixture({ tenantId: 'tenant-2' }),
    );
    expect(result.decision.decision).toBe('halt');
    expect(result.decision.reason).toBe('HALT_VALIDATION_TENANT_MISMATCH');
  });

  it('WRONG ENVIRONMENT (the run validated a different environment than the rollout target) → typed HALT_VALIDATION_ENVIRONMENT_MISMATCH', async () => {
    const stack = buildDecisionStack();
    const otherEnvironment = describeEnvironment({
      id: 'env-prod-OTHER',
      kind: 'production',
      acceptedPolicies: ['READ_ONLY'],
    });
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-rollout-1',
      releaseRef: 'release-2026.09.01',
      environment: otherEnvironment,
      outcome: 'healthy',
    });
    // The request declares the rollout target env-prod-rollout (the fixture):
    const result = await stack.service.decideProgressiveRelease(decisionRequestFixture());
    expect(result.decision.decision).toBe('halt');
    expect(result.decision.reason).toBe('HALT_VALIDATION_ENVIRONMENT_MISMATCH');
  });

  it('MISSING runtime observation (no deployment recorded / the port unbound) → typed HALT_RUNTIME_OBSERVATION_UNAVAILABLE', async () => {
    const stack = buildDecisionStack({ runtimeObservation: null });
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-rollout-1',
      releaseRef: 'release-2026.09.01',
      outcome: 'healthy',
    });
    const result = await stack.service.decideProgressiveRelease(decisionRequestFixture());
    expect(result.decision.decision).toBe('halt');
    expect(result.decision.reason).toBe('HALT_RUNTIME_OBSERVATION_UNAVAILABLE');
    expect(result.decision.runtimeObservation).toBeNull();
    // the missing runtime evidence is itself an Engineering Signal:
    expect(result.decision.signalOutcomes.some((s) => s.logicalFailureKey.includes('evidence-gap:HALT_RUNTIME_OBSERVATION_UNAVAILABLE'))).toBe(true);
  });

  it('AMBIGUOUS runtime state (queued/building — not yet observable) → typed HALT_RUNTIME_OBSERVATION_NOT_READY', async () => {
    for (const status of ['queued', 'building'] as const) {
      const stack = buildDecisionStack({
        runtimeObservation: {
          kind: 'deployment',
          deploymentId: 'dpl-inflight-1',
          deploymentStatus: status,
          observedAt: '2026-09-01T12:10:00Z',
        },
      });
      await completedPostReleaseRun(stack.continuousValidationService, {
        runId: 'run-rollout-1',
        releaseRef: 'release-2026.09.01',
        outcome: 'healthy',
      });
      const result = await stack.service.decideProgressiveRelease(decisionRequestFixture());
      expect(result.decision.decision, `status ${status}`).toBe('halt');
      expect(result.decision.reason, `status ${status}`).toBe('HALT_RUNTIME_OBSERVATION_NOT_READY');
    }
  });

  it('ALREADY HALTED rollout → typed HALT_ROLLOUT_PREVIOUSLY_HALTED (even with a fresh healthy run)', async () => {
    const stack = buildDecisionStack();
    // The first decision halts (a failed validation at partial):
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-failed-1',
      releaseRef: 'release-2026.09.01',
      outcome: 'validation_failure',
    });
    await stack.service.decideProgressiveRelease(
      decisionRequestFixture({ rolloutStage: 'partial', validationRunId: 'run-failed-1' }),
    );
    // A FRESH healthy run + a fresh request for the same rollout:
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-healthy-2',
      releaseRef: 'release-2026.09.01',
      outcome: 'healthy',
    });
    const result = await stack.service.decideProgressiveRelease(
      decisionRequestFixture({ rolloutStage: 'partial', validationRunId: 'run-healthy-2' }),
    );
    expect(result.decision.decision).toBe('halt');
    expect(result.decision.reason).toBe('HALT_ROLLOUT_PREVIOUSLY_HALTED');
    // a meta-halt records the decision but NO new signal (no new failure evidence):
    expect(result.decision.signalOutcomes).toHaveLength(0);
  });

  it('ALREADY RECOVERED rollout → typed HALT_ROLLOUT_PREVIOUSLY_RECOVERED', async () => {
    const stack = buildDecisionStack();
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-failed-1',
      releaseRef: 'release-2026.09.01',
      outcome: 'validation_failure',
    });
    const first = await stack.service.decideProgressiveRelease(
      decisionRequestFixture({ validationRunId: 'run-failed-1' }),
    );
    expect(first.decision.decision).toBe('recover');
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-healthy-2',
      releaseRef: 'release-2026.09.01',
      outcome: 'healthy',
    });
    const result = await stack.service.decideProgressiveRelease(
      decisionRequestFixture({ validationRunId: 'run-healthy-2' }),
    );
    expect(result.decision.decision).toBe('halt');
    expect(result.decision.reason).toBe('HALT_ROLLOUT_PREVIOUSLY_RECOVERED');
  });

  it('INVALID stage transition (canary requested AFTER partial was judged) → typed HALT_INVALID_STAGE_TRANSITION', async () => {
    const stack = buildDecisionStack();
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-partial-1',
      releaseRef: 'release-2026.09.01',
      outcome: 'healthy',
    });
    const partial = await stack.service.decideProgressiveRelease(
      decisionRequestFixture({ rolloutStage: 'partial', validationRunId: 'run-partial-1' }),
    );
    expect(partial.decision.decision).toBe('continue');
    // A canary request for the SAME release AFTER partial was judged:
    const result = await stack.service.decideProgressiveRelease(
      decisionRequestFixture({ rolloutStage: 'canary', validationRunId: 'run-partial-1' }),
    );
    expect(result.decision.decision).toBe('halt');
    expect(result.decision.reason).toBe('HALT_INVALID_STAGE_TRANSITION');
  });

  it('AMBIGUOUS request input (a foreign stage) → the typed input rejection (never an unknown journey through the policy)', async () => {
    const stack = buildDecisionStack();
    await expect(
      stack.service.decideProgressiveRelease(decisionRequestFixture({ rolloutStage: 'blue-green' })),
    ).rejects.toThrowError(/\[PR_INPUT_STAGE_INVALID\]/);
  });
});
