/**
 * WORK-069 — the idempotency/determinism proofs (§13 of the
 * implementation instruction):
 *
 *   same release + same rollout stage + same validation result
 *       → the same logical decision
 *   duplicate delivery → NO duplicate halt action
 *   same release + different project → independent
 *   same rollout + different stage → independent
 *   different releases → independent
 *   new runtime observation (new facts) → a NEW decision event
 *   same identity + moved rollout state → the typed conflict (never a
 *   silent rewrite of the recorded decision)
 */
import { describe, it, expect } from 'vitest';
import {
  buildDecisionStack,
  completedPostReleaseRun,
  decisionRequestFixture,
} from './helpers.js';

describe('WORK-069 — idempotency and decision independence (§13)', () => {
  it('the same request delivered TWICE → the SAME logical decision (duplicate; the recorded record is returned verbatim)', async () => {
    const stack = buildDecisionStack();
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-healthy-1',
      releaseRef: 'release-2026.09.01',
      outcome: 'healthy',
    });
    const request = decisionRequestFixture({ validationRunId: 'run-healthy-1' });
    const first = await stack.service.decideProgressiveRelease(request);
    expect(first.outcome).toBe('decided');
    const second = await stack.service.decideProgressiveRelease(request);
    expect(second.outcome).toBe('duplicate');
    expect(second.decision.decisionId).toBe(first.decision.decisionId);
    expect(second.decision).toEqual(first.decision);
    // exactly ONE decision record exists:
    const history = await stack.service.listDecisionsForRollout('tenant-1', 'project-1', 'release-2026.09.01');
    expect(history).toHaveLength(1);
  });

  it('duplicate delivery of a HALT → NO duplicate halt action (exactly one signal occurrence set, one audit event, one record)', async () => {
    const stack = buildDecisionStack();
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-failed-1',
      releaseRef: 'release-2026.09.01',
      outcome: 'validation_failure',
    });
    const request = decisionRequestFixture({ rolloutStage: 'partial', validationRunId: 'run-failed-1' });
    const first = await stack.service.decideProgressiveRelease(request);
    expect(first.decision.decision).toBe('halt');
    expect(first.decision.signalOutcomes).toHaveLength(1);
    const second = await stack.service.decideProgressiveRelease(request);
    expect(second.outcome).toBe('duplicate');
    // NO duplicate halt action: the WORK-067 signal store holds exactly ONE
    // occurrence for the failure (the ingestion was not re-executed):
    const signals = await stack.engineeringSignalService.listSignalsForProject('project-1');
    expect(signals).toHaveLength(1);
    expect(signals[0]!.occurrences).toHaveLength(1);
    // exactly ONE audit event was emitted (the duplicate path re-emits nothing):
    expect(stack.auditWriter.events.filter((e) => e.eventType === 'PROGRESSIVE_RELEASE_DECISION')).toHaveLength(1);
  });

  it('the same release + a DIFFERENT project → INDEPENDENT decisions (no cross-project coupling)', async () => {
    const stack = buildDecisionStack();
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-healthy-1',
      releaseRef: 'release-2026.09.01',
      outcome: 'healthy',
    });
    const requestA = decisionRequestFixture({ projectId: 'project-1', validationRunId: 'run-healthy-1' });
    const requestB = decisionRequestFixture({ projectId: 'project-2', validationRunId: 'run-healthy-1' });
    const a = await stack.service.decideProgressiveRelease(requestA);
    const b = await stack.service.decideProgressiveRelease(requestB);
    expect(a.outcome).toBe('decided');
    expect(b.outcome).toBe('decided');
    expect(a.decision.decisionId).not.toBe(b.decision.decisionId);
    // the histories are independent:
    const historyA = await stack.service.listDecisionsForRollout('tenant-1', 'project-1', 'release-2026.09.01');
    const historyB = await stack.service.listDecisionsForRollout('tenant-1', 'project-2', 'release-2026.09.01');
    expect(historyA).toHaveLength(1);
    expect(historyB).toHaveLength(1);
  });

  it('the same release + a DIFFERENT rollout stage → INDEPENDENT decisions', async () => {
    const stack = buildDecisionStack();
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-healthy-1',
      releaseRef: 'release-2026.09.01',
      outcome: 'healthy',
    });
    // the canary decision first (continue), then the SAME validation run
    // bound to the NEXT stage:
    const canary = await stack.service.decideProgressiveRelease(
      decisionRequestFixture({ rolloutStage: 'canary', validationRunId: 'run-healthy-1' }),
    );
    expect(canary.decision.decision).toBe('continue');
    const partial = await stack.service.decideProgressiveRelease(
      decisionRequestFixture({ rolloutStage: 'partial', validationRunId: 'run-healthy-1' }),
    );
    expect(partial.outcome).toBe('decided');
    expect(partial.decision.decisionId).not.toBe(canary.decision.decisionId);
    expect(partial.decision.decision).toBe('continue');
    // the rollout history records BOTH (the stage progression):
    const history = await stack.service.listDecisionsForRollout('tenant-1', 'project-1', 'release-2026.09.01');
    expect(history.map((h) => h.rolloutStage)).toEqual(['canary', 'partial']);
  });

  it('a DIFFERENT release → INDEPENDENT decisions (the release identity participates)', async () => {
    const stack = buildDecisionStack();
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-release-1',
      releaseRef: 'release-2026.09.01',
      outcome: 'healthy',
    });
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-release-2',
      releaseRef: 'release-2026.09.02',
      outcome: 'healthy',
    });
    const a = await stack.service.decideProgressiveRelease(
      decisionRequestFixture({ validationRunId: 'run-release-1' }),
    );
    const b = await stack.service.decideProgressiveRelease(
      decisionRequestFixture({ releaseRef: 'release-2026.09.02', validationRunId: 'run-release-2' }),
    );
    expect(a.decision.decisionId).not.toBe(b.decision.decisionId);
    const historyA = await stack.service.listDecisionsForRollout('tenant-1', 'project-1', 'release-2026.09.01');
    const historyB = await stack.service.listDecisionsForRollout('tenant-1', 'project-1', 'release-2026.09.02');
    expect(historyA).toHaveLength(1);
    expect(historyB).toHaveLength(1);
  });

  it('a NEW runtime observation (the deployment state changed) → a NEW decision event (new facts, new decision)', async () => {
    const stack = buildDecisionStack({
      runtimeObservation: {
        kind: 'deployment',
        deploymentId: 'dpl-rollout-1',
        deploymentStatus: 'ready',
        observedAt: '2026-09-01T12:10:00Z',
      },
    });
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-healthy-1',
      releaseRef: 'release-2026.09.01',
      outcome: 'healthy',
    });
    const request = decisionRequestFixture({ validationRunId: 'run-healthy-1' });
    const first = await stack.service.decideProgressiveRelease(request);
    expect(first.decision.decision).toBe('continue');
    // the deployment goes from ready → error at a LATER recorded time:
    stack.runtimeReader.setObservation({
      kind: 'deployment',
      deploymentId: 'dpl-rollout-1',
      deploymentStatus: 'error',
      observedAt: '2026-09-01T13:00:00Z',
    });
    const second = await stack.service.decideProgressiveRelease(request);
    expect(second.outcome).toBe('decided');
    expect(second.decision.decisionId).not.toBe(first.decision.decisionId);
    expect(second.decision.decision).toBe('recover');
    expect(second.decision.reason).toBe('RECOVER_CANARY_RUNTIME_UNHEALTHY');
    // the rollout history records BOTH events:
    const history = await stack.service.listDecisionsForRollout('tenant-1', 'project-1', 'release-2026.09.01');
    expect(history).toHaveLength(2);
  });

  it('the same identity re-delivered AFTER the rollout state moved underneath it → the TYPED CONFLICT (never a silent rewrite)', async () => {
    // Decision X (canary, run-1) continues. Then decision Y (partial, run-2)
    // halts the rollout. A re-delivery of X would NOW derive
    // HALT_ROLLOUT_PREVIOUSLY_HALTED — the same logical event cannot carry
    // two outcomes: the typed conflict, never a rewrite of X's record.
    const stack = buildDecisionStack();
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-healthy-1',
      releaseRef: 'release-2026.09.01',
      outcome: 'healthy',
    });
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-failed-2',
      releaseRef: 'release-2026.09.01',
      outcome: 'validation_failure',
    });
    const x = decisionRequestFixture({ rolloutStage: 'canary', validationRunId: 'run-healthy-1' });
    const first = await stack.service.decideProgressiveRelease(x);
    expect(first.decision.decision).toBe('continue');
    const y = decisionRequestFixture({ rolloutStage: 'partial', validationRunId: 'run-failed-2' });
    const halt = await stack.service.decideProgressiveRelease(y);
    expect(halt.decision.decision).toBe('halt');
    // the re-delivery of X conflicts (its recorded continue cannot become a halt):
    await expect(stack.service.decideProgressiveRelease(x)).rejects.toThrowError(
      /\[PR_DECISION_IDENTITY_CONFLICT\]/,
    );
    // X's record is UNCHANGED (immutable history):
    const found = await stack.service.findDecision(first.decision.decisionId);
    expect(found!.decision).toBe('continue');
  });

  it('the deterministic identity: the same inputs always derive the same decisionId (no randomness)', async () => {
    const stack = buildDecisionStack();
    await completedPostReleaseRun(stack.continuousValidationService, {
      runId: 'run-healthy-1',
      releaseRef: 'release-2026.09.01',
      outcome: 'healthy',
    });
    const ids = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const result = await stack.service.decideProgressiveRelease(
        decisionRequestFixture({ validationRunId: 'run-healthy-1' }),
      );
      ids.add(result.decision.decisionId);
    }
    expect(ids.size).toBe(1);
  });
});
