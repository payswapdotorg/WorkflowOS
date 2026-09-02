import { describe, it, expect } from 'vitest';
import { composeOptimizationService } from './helpers.js';
import type { WorkflowRunHistory } from '../../../src/workflow-runs/index.js';

/**
 * V2-011 — the empirical baseline-vs-optimized run comparison.
 *
 * REAL V2-005 run histories (read-only records — the declared
 * implementation dependency) compared deterministically: CORRECTNESS
 * FIRST (both runs terminal-completed with the same step set and
 * statuses), then the resource cost signals (invocation counts — the
 * agentic observe→act loop costs more invocations than the direct API
 * call) and the maintainability signals.
 */
interface StepSpec {
  readonly stepId: string;
}

interface InvocationSpec {
  readonly stepId: string | null;
  readonly capability: string;
}

function buildRunHistory(input: {
  readonly runId: string;
  readonly state: 'completed' | 'failed' | 'requested';
  readonly steps: ReadonlyArray<StepSpec & { status: 'completed' | 'failed' }>;
  readonly invocations: ReadonlyArray<InvocationSpec>;
}): WorkflowRunHistory {
  const timestamp = '2026-01-06T09:00:00.000Z';
  return {
    run: {
      id: input.runId,
      organizationId: 'org-v2-011',
      workflowId: 'wf-v2-011',
      versionId: `wfv-${input.runId}`,
      versionContentDigest: `content-${input.runId}`,
      versionSemanticDigest: `semantic-${input.runId}`,
      installationId: null,
      trigger: { type: 'manual', id: `delivery-${input.runId}` },
      triggeredByUserId: 'user-v2-011',
      inputCommitments: ['commitment-v2-011'],
      inputDigest: 'inputdigest-v2-011',
      state: input.state,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    timeline: [],
    attempts: [],
    steps: input.steps.map((step, index) => ({
      id: `step-${input.runId}-${index}`,
      runId: input.runId,
      attemptNumber: 1,
      stepId: step.stepId,
      status: step.status,
      inputCommitments: ['commitment-v2-011'],
      outputCommitments: [`output-${step.stepId}`],
      outcome: step.status === 'completed' ? ('succeeded' as const) : ('failed' as const),
      startedAt: timestamp,
      completedAt: timestamp,
    })),
    invocations: input.invocations.map((invocation, index) => ({
      id: `inv-${input.runId}-${index}`,
      runId: input.runId,
      attemptNumber: 1,
      stepId: invocation.stepId,
      capability: invocation.capability,
      executionClass: 'deterministic_api' as const,
      inputCommitments: ['commitment-v2-011'],
      outputCommitments: [`output-${invocation.stepId ?? 'run'}`],
      outcome: 'succeeded' as const,
      requestedAt: timestamp,
      completedAt: timestamp,
    })),
    evidence: [],
    attestations: [],
    attestationRejections: [],
    commands: [],
  };
}

const BASELINE_STEPS = [
  { stepId: 'fetch_tickets', status: 'completed' as const },
  { stepId: 'scan_board', status: 'completed' as const },
  { stepId: 'approve_digest', status: 'completed' as const },
  { stepId: 'send_digest', status: 'completed' as const },
];

const BASELINE_INVOCATIONS = [
  { stepId: 'fetch_tickets', capability: 'github.repository.read' },
  // the agentic computer-use loop: observe, then act
  { stepId: 'scan_board', capability: 'browser.observe' },
  { stepId: 'scan_board', capability: 'github.repository.read' },
  { stepId: 'send_digest', capability: 'messaging.send' },
];

const OPTIMIZED_INVOCATIONS = [
  { stepId: 'fetch_tickets', capability: 'github.repository.read' },
  // the direct deterministic API call: no observation round-trip
  { stepId: 'scan_board', capability: 'github.repository.read' },
  { stepId: 'send_digest', capability: 'messaging.send' },
];

describe('V2-011 — correctness FIRST, then resource cost and maintainability', () => {
  it('the optimized run with the same steps is equivalent and cheaper', () => {
    const { service } = composeOptimizationService();
    const baseline = buildRunHistory({
      runId: 'run-baseline',
      state: 'completed',
      steps: BASELINE_STEPS,
      invocations: BASELINE_INVOCATIONS,
    });
    const optimized = buildRunHistory({
      runId: 'run-optimized',
      state: 'completed',
      steps: BASELINE_STEPS,
      invocations: OPTIMIZED_INVOCATIONS,
    });

    const comparison = service.compareRunHistories(baseline, optimized);
    // CORRECTNESS FIRST: all four correctness flags true
    expect(comparison.correctness).toEqual({
      baselineCompleted: true,
      optimizedCompleted: true,
      sameStepSet: true,
      sameStepStatuses: true,
      equivalent: true,
    });
    // resource cost: 4 baseline invocations (the agentic loop) vs 3 optimized
    expect(comparison.resourceCost).toEqual({
      baselineInvocationCount: 4,
      optimizedInvocationCount: 3,
      invocationDelta: -1,
    });
    // maintainability signals
    expect([...comparison.maintainabilitySignals.baselineDistinctCapabilities].sort()).toEqual([
      'browser.observe',
      'github.repository.read',
      'messaging.send',
    ]);
    expect([...comparison.maintainabilitySignals.optimizedDistinctCapabilities].sort()).toEqual([
      'github.repository.read',
      'messaging.send',
    ]);
    expect(comparison.maintainabilitySignals.baselineStepCount).toBe(4);
    expect(comparison.maintainabilitySignals.optimizedStepCount).toBe(4);
  });

  it('an optimized run that FAILED is not equivalent (correctness gate closes first)', () => {
    const { service } = composeOptimizationService();
    const baseline = buildRunHistory({
      runId: 'run-baseline',
      state: 'completed',
      steps: BASELINE_STEPS,
      invocations: BASELINE_INVOCATIONS,
    });
    const failed = buildRunHistory({
      runId: 'run-optimized',
      state: 'failed',
      steps: BASELINE_STEPS,
      invocations: OPTIMIZED_INVOCATIONS,
    });
    const comparison = service.compareRunHistories(baseline, failed);
    expect(comparison.correctness.optimizedCompleted).toBe(false);
    expect(comparison.correctness.equivalent).toBe(false);
  });

  it('a different step set is not equivalent', () => {
    const { service } = composeOptimizationService();
    const baseline = buildRunHistory({
      runId: 'run-baseline',
      state: 'completed',
      steps: BASELINE_STEPS,
      invocations: BASELINE_INVOCATIONS,
    });
    const divergent = buildRunHistory({
      runId: 'run-optimized',
      state: 'completed',
      steps: [
        ...BASELINE_STEPS,
        { stepId: 'extra_step', status: 'completed' as const },
      ],
      invocations: OPTIMIZED_INVOCATIONS,
    });
    const comparison = service.compareRunHistories(baseline, divergent);
    expect(comparison.correctness.sameStepSet).toBe(false);
    expect(comparison.correctness.equivalent).toBe(false);
  });

  it('a different step status is not equivalent', () => {
    const { service } = composeOptimizationService();
    const baseline = buildRunHistory({
      runId: 'run-baseline',
      state: 'completed',
      steps: BASELINE_STEPS,
      invocations: BASELINE_INVOCATIONS,
    });
    const divergent = buildRunHistory({
      runId: 'run-optimized',
      state: 'completed',
      steps: BASELINE_STEPS.map((step, index) =>
        index === 1 ? { ...step, status: 'failed' as const } : step,
      ),
      invocations: OPTIMIZED_INVOCATIONS,
    });
    const comparison = service.compareRunHistories(baseline, divergent);
    expect(comparison.correctness.sameStepStatuses).toBe(false);
    expect(comparison.correctness.equivalent).toBe(false);
  });

  it('the run comparison is deterministic', () => {
    const { service } = composeOptimizationService();
    const baseline = buildRunHistory({
      runId: 'run-baseline',
      state: 'completed',
      steps: BASELINE_STEPS,
      invocations: BASELINE_INVOCATIONS,
    });
    const optimized = buildRunHistory({
      runId: 'run-optimized',
      state: 'completed',
      steps: BASELINE_STEPS,
      invocations: OPTIMIZED_INVOCATIONS,
    });
    expect(service.compareRunHistories(baseline, optimized)).toEqual(
      service.compareRunHistories(baseline, optimized),
    );
  });
});
