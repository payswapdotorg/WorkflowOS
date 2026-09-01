/**
 * WORK-069 — the governed consequence proofs: the halt/recover signal flow
 * through the WORK-067 authority (the ADVISORY correlation layer), the
 * rollback invocation through the EXISTING-authority port, the /audit
 * forensic trail, and the honest no-signal continue case.
 *
 * The chain pinned here (the Work Order's invariant 3):
 *
 *   WORK-069 halt/recover
 *       ↓ (the failure evidence, through the public intake)
 *   WORK-067 Engineering Signal
 *       ↓ (NOT implemented — WORK-068's future conversion)
 *   governed Work Item
 *
 * WORK-069 NEVER creates the Work Item itself — it stops at the signal.
 */
import { describe, it, expect } from 'vitest';
import {
  buildDecisionStack,
  completedPostReleaseRun,
  decisionRequestFixture,
  invokedRollback,
  RecordingRollbackAuthority,
} from './helpers.js';

describe('WORK-069 — the halt/recover signal flow (the WORK-067 authority consumed)', () => {
  it('a HALT on a failed validation → the run\'s EVERY failure becomes a signal occurrence (ingestValidationRun, source validation)', async () => {
    const stack = buildDecisionStack();
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-failed-1',
      releaseRef: 'release-2026.09.01',
      outcome: 'validation_failure',
    });
    const result = await stack.service.decideProgressiveRelease(
      decisionRequestFixture({
        rolloutStage: 'partial',
        validationRunId: 'run-failed-1',
        releaseObservedAt: '2026-09-01T12:00:00Z',
      }),
    );
    expect(result.decision.decision).toBe('halt');
    expect(result.decision.signalOutcomes).toHaveLength(1);
    const signalOutcome = result.decision.signalOutcomes[0]!;
    expect(signalOutcome.outcome).toBe('signal-created');
    expect(signalOutcome.logicalFailureKey).toBe(
      'validation:journey-rollout-smoke:step-open-dashboard:expectation-dashboard-heading',
    );
    // the signal is READABLE through the WORK-067 authority (the governed chain):
    const signal = await stack.engineeringSignalService.findSignal(signalOutcome.signalId);
    expect(signal).not.toBeNull();
    expect(signal!.sources).toContain('validation');
    // the occurrence preserves the run's RECORDED releaseRef (provenance):
    expect(signal!.occurrences[0]!.releaseRef).toBe('release-2026.09.01');
    expect(signal!.occurrences[0]!.raw).toMatchObject({ failedStepId: 'step-open-dashboard' });
    // the caller-recorded release boundary correlated the signal to the
    // rollout's release through the WORK-067 authority (the occurrence's
    // own recorded releaseRef is the CAUSAL basis — never an inference):
    expect(signal!.releaseCorrelation).toHaveLength(1);
    expect(signal!.releaseCorrelation[0]).toMatchObject({
      releaseRef: 'release-2026.09.01',
      correlated: true,
      causalBasis: 'provenance-release-ref',
    });
  });

  it('a RECOVER on a canary validation failure → the signal + the rollback invocation through the port', async () => {
    const rollback = new RecordingRollbackAuthority(invokedRollback);
    const stack = buildDecisionStack({ rollbackAuthority: rollback });
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-failed-1',
      releaseRef: 'release-2026.09.01',
      outcome: 'validation_failure',
    });
    const result = await stack.service.decideProgressiveRelease(
      decisionRequestFixture({ validationRunId: 'run-failed-1' }),
    );
    expect(result.decision.decision).toBe('recover');
    expect(result.decision.reason).toBe('RECOVER_CANARY_VALIDATION_FAILURE');
    // the failure evidence flowed as a signal:
    expect(result.decision.signalOutcomes).toHaveLength(1);
    // the rollback was invoked ONCE through the port with full provenance:
    expect(rollback.invocations).toHaveLength(1);
    expect(rollback.invocations[0]).toMatchObject({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      releaseRef: 'release-2026.09.01',
      rolloutStage: 'canary',
      reason: 'RECOVER_CANARY_VALIDATION_FAILURE',
    });
    expect(result.decision.rollback).toEqual(invokedRollback);
  });

  it('a HALT on an unhealthy runtime observation → the runtime failure observation (source runtime; the deployment record\'s OWN time)', async () => {
    const stack = buildDecisionStack({
      runtimeObservation: {
        kind: 'deployment',
        deploymentId: 'dpl-broken-1',
        deploymentStatus: 'error',
        observedAt: '2026-09-01T12:30:00Z',
      },
    });
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-healthy-1',
      releaseRef: 'release-2026.09.01',
      outcome: 'healthy',
    });
    const result = await stack.service.decideProgressiveRelease(
      decisionRequestFixture({ rolloutStage: 'partial', validationRunId: 'run-healthy-1' }),
    );
    expect(result.decision.decision).toBe('halt');
    expect(result.decision.reason).toBe('HALT_RUNTIME_UNHEALTHY');
    expect(result.decision.signalOutcomes).toHaveLength(1);
    const signal = await stack.engineeringSignalService.findSignal(result.decision.signalOutcomes[0]!.signalId);
    expect(signal!.sources).toContain('runtime');
    expect(signal!.logicalFailureKey).toBe('progressive-release:runtime-deployment:error');
    // the observation time is the DEPLOYMENT RECORD's own time — never the decision clock:
    expect(signal!.occurrences[0]!.observedAt).toBe('2026-09-01T12:30:00Z');
    expect(signal!.occurrences[0]!.observedAt).not.toBe(result.decision.decidedAt);
    // the raw payload preserves the observation record:
    expect(signal!.occurrences[0]!.raw).toMatchObject({
      deploymentId: 'dpl-broken-1',
      deploymentStatus: 'error',
      rolloutStage: 'partial',
    });
    // the observation reference points at the /runtime authority's record:
    expect(signal!.occurrences[0]!.observationRef).toMatchObject({
      kind: 'runtime-deployment',
      ref: 'dpl-broken-1',
    });
  });

  it('a healthy run is unhealthy at canary → RECOVER via the runtime signal + the rollback port', async () => {
    const rollback = new RecordingRollbackAuthority(invokedRollback);
    const stack = buildDecisionStack({
      rollbackAuthority: rollback,
      runtimeObservation: {
        kind: 'deployment',
        deploymentId: 'dpl-broken-1',
        deploymentStatus: 'canceled',
        observedAt: '2026-09-01T12:30:00Z',
      },
    });
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-healthy-1',
      releaseRef: 'release-2026.09.01',
      outcome: 'healthy',
    });
    const result = await stack.service.decideProgressiveRelease(
      decisionRequestFixture({ validationRunId: 'run-healthy-1' }),
    );
    expect(result.decision.decision).toBe('recover');
    expect(result.decision.reason).toBe('RECOVER_CANARY_RUNTIME_UNHEALTHY');
    // a HEALTHY run records NO validation signal (the honest no-signal case);
    // the runtime failure IS the signal:
    const signals = await stack.engineeringSignalService.listSignalsForProject('project-1');
    expect(signals).toHaveLength(1);
    expect(signals[0]!.sources).toContain('runtime');
    expect(rollback.invocations).toHaveLength(1);
  });

  it('a CONTINUE records NO signal (the honest no-signal case — not a silent conversion)', async () => {
    const stack = buildDecisionStack();
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-healthy-1',
      releaseRef: 'release-2026.09.01',
      outcome: 'healthy',
    });
    const result = await stack.service.decideProgressiveRelease(
      decisionRequestFixture({ validationRunId: 'run-healthy-1' }),
    );
    expect(result.decision.decision).toBe('continue');
    expect(result.decision.signalOutcomes).toHaveLength(0);
    expect(result.decision.rollback).toBeNull();
    const signals = await stack.engineeringSignalService.listSignalsForProject('project-1');
    expect(signals).toHaveLength(0);
  });

  it('a RECOVER with an effect_policy_violation → the CRITICAL-severity signal (the WORK-064 adapter\'s mapping) + rollback', async () => {
    const rollback = new RecordingRollbackAuthority(invokedRollback);
    const stack = buildDecisionStack({ rollbackAuthority: rollback });
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-policy-1',
      releaseRef: 'release-2026.09.01',
      outcome: 'effect_policy_violation',
    });
    const result = await stack.service.decideProgressiveRelease(
      decisionRequestFixture({ rolloutStage: 'full', validationRunId: 'run-policy-1' }),
    );
    expect(result.decision.decision).toBe('recover');
    expect(result.decision.reason).toBe('RECOVER_EFFECT_POLICY_VIOLATION');
    const signal = await stack.engineeringSignalService.findSignal(result.decision.signalOutcomes[0]!.signalId);
    expect(signal!.latestSeverity).toBe('critical');
    expect(rollback.invocations).toHaveLength(1);
    expect(rollback.invocations[0]!.rolloutStage).toBe('full');
  });

  it('every decided record emits ONE /audit event (the forensic trail through the application boundary)', async () => {
    const stack = buildDecisionStack();
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-healthy-1',
      releaseRef: 'release-2026.09.01',
      outcome: 'healthy',
    });
    const result = await stack.service.decideProgressiveRelease(
      decisionRequestFixture({ validationRunId: 'run-healthy-1' }),
    );
    const events = stack.auditWriter.events.filter((e) => e.eventType === 'PROGRESSIVE_RELEASE_DECISION');
    expect(events).toHaveLength(1);
    expect(events[0]!.actor).toBe('progressive-release');
    expect(events[0]!.resourceType).toBe('progressive_release_rollout');
    expect(events[0]!.resourceId).toBe('project-1:release-2026.09.01');
    expect(events[0]!.projectId).toBe('project-1');
    expect(events[0]!.afterState).toMatchObject({
      decisionId: result.decision.decisionId,
      decision: 'continue',
      reason: 'CONTINUE_VALIDATION_HEALTHY_RUNTIME_READY',
    });
    expect(events[0]!.metadata).toMatchObject({ rollbackInvoked: null, signalsEmitted: 0 });
  });

  it('the signal channel fails closed when the WORK-067 authority is unbound (a halt NEVER silently no-ops) — and the failed consequence leaves a PERSISTED pending reservation the re-delivery fails closed on (the PR #108 protocol)', async () => {
    const stack = buildDecisionStack();
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-failed-1',
      releaseRef: 'release-2026.09.01',
      outcome: 'validation_failure',
    });
    const request = decisionRequestFixture({ rolloutStage: 'partial', validationRunId: 'run-failed-1' });
    // sabotage the signal authority binding:
    (stack as unknown as { service: { deps: Record<string, unknown> } }).service.deps.engineeringSignalService = undefined;
    await expect(
      stack.service.decideProgressiveRelease(request),
    ).rejects.toThrowError(/\[PR_SIGNAL_AUTHORITY_UNBOUND\]/);
    // The consequence authority failed AFTER the reservation (the exact
    // crash-window the PR #108 correction covers): the decision record is
    // PERSISTED and PENDING — the re-delivery fails closed with the typed
    // pending tombstone (it does NOT re-attempt the consequences and does
    // NOT report a clean duplicate):
    const history = await stack.decisionRepository.listForRollout('tenant-1', 'project-1', 'release-2026.09.01');
    expect(history).toHaveLength(1);
    expect(history[0]!.decision).toBe('halt');
    expect(history[0]!.consequencePhase).toBe('pending');
    await expect(
      stack.service.decideProgressiveRelease(request),
    ).rejects.toThrowError(/\[PR_DECISION_CONSEQUENCES_PENDING\]/);
    // …and NO consequence/audit side effect was produced for the failed delivery:
    expect(
      stack.auditWriter.events.filter((e) => e.eventType === 'PROGRESSIVE_RELEASE_DECISION'),
    ).toHaveLength(0);
  });
});
