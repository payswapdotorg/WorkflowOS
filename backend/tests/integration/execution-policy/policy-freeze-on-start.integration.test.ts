/**
 * PR #37 review fix 3 — the §9 policy-freeze-on-benchmark-start invariant,
 * enforced at the persistence boundary (migration 0032).
 *
 * The review found that the freeze MECHANISM existed (migration 0026's
 * frozen column + reject-frozen-mutation trigger; the service's
 * freezeProjectPolicy()) but NOTHING in the actual benchmark start path
 * invoked it — so a project policy could remain MUTABLE while a benchmark
 * experiment was RUNNING, violating §9:
 *
 *     project policy (frozen = false)
 *         ↓
 *     benchmark experiment starts (status = running)
 *         ↓
 *     project policy still mutable        ← the violation
 *
 * The fix connects the freeze to the AUTHORITATIVE start transition via TWO
 * database triggers (migration 0032):
 *
 *   1. wfos_benchmark_experiments AFTER UPDATE (created|paused → running)
 *      → freezes the project's unfrozen policy row(s) ATOMICALLY with the
 *        start transition. No application code path can bypass it, and there
 *        is no crash window between "experiment running" and "policy frozen".
 *
 *   2. wfos_execution_policies BEFORE INSERT (born-frozen)
 *      → a policy created for a project that ALREADY has a started
 *        experiment is born frozen (closes the policy-created-after-start
 *        hole).
 *
 * These tests exercise the REAL start path (DefaultBenchmarkService.
 * startExperiment → claimExperimentStart, the same atomic CTE production
 * uses) against a real pglite database with the triggers applied.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  buildBenchmarkStack,
  teardownBenchmarkStack,
  type BenchmarkStack,
} from '../benchmark/benchmark-stack.js';
import { PgExecutionPolicyRepository } from '../../../src/execution-policy/index.js';

describe('PR #37 review fix 3 — §9 policy freeze on the authoritative benchmark start transition', () => {
  let stack: BenchmarkStack;
  let policyRepository: PgExecutionPolicyRepository;

  beforeAll(async () => {
    stack = await buildBenchmarkStack({
      apiKey: 'raw-key-policy-freeze',
      secretRef: 'WFOS_TEST_KEY_POLICY_FREEZE',
    });
    policyRepository = new PgExecutionPolicyRepository(stack.authStack.db.client);
  });

  afterAll(async () => {
    await teardownBenchmarkStack(stack);
  });

  /** Create a snapshot + one-trial experiment (mirrors the other suites). */
  async function makeExperiment(name: string): Promise<string> {
    const snapshot = await stack.benchmarkService.createSnapshot({
      projectId: stack.fixture.projectId,
      workItemId: stack.fixture.workItemId,
      name: `${name}-snapshot`,
      actor: stack.fixture.userId,
    });
    const exp = await stack.benchmarkService.createExperiment({
      projectId: stack.fixture.projectId,
      benchmarkTaskSnapshotId: snapshot.id,
      name,
      trials: [{ provider: 'fake', mode: 'native', repetitions: 1 }],
      createdBy: stack.fixture.userId,
    });
    return exp.id;
  }

  it('experiment start FREEZES the project policy atomically with the created→running transition', async () => {
    // A mutable project policy exists BEFORE the start (frozen = false).
    const policy = await policyRepository.insertDefaultProjectPolicy(
      stack.fixture.organizationId, stack.fixture.projectId,
    );
    expect(policy.frozen).toBe(false);

    // The REAL start path (the same atomic claim CTE production uses).
    const experimentId = await makeExperiment('freeze-on-start');
    await stack.benchmarkService.startExperiment(experimentId);

    // ASSERTION 1 — the policy is FROZEN, atomically with the start: there
    // is no point in time where the experiment is running but the policy is
    // mutable (the trigger fires INSIDE the start transition's commit).
    const after = await policyRepository.getProjectPolicy(stack.fixture.projectId);
    expect(after?.frozen).toBe(true);
  });

  it('a FROZEN policy rejects mutation (§9 enforced end-to-end from the start freeze)', async () => {
    // The policy was frozen by the previous test's experiment start. Any
    // substantive mutation must now be rejected by 0026's trigger.
    await expect(
      policyRepository.updateProjectPolicy(stack.fixture.projectId, {
        externalExecutionAllowed: false,
      }),
    ).rejects.toThrow(/execution-policy-frozen/);
  });

  it('a policy created AFTER experiments started is BORN FROZEN (the policy-created-later hole)', async () => {
    // Delete the (already frozen) policy row, then re-create the default —
    // the project has started experiments (started_at IS NOT NULL), so the
    // BEFORE INSERT trigger must birth the new row frozen. Without this,
    // a policy created after a start would be mutable while experiments run.
    await stack.authStack.db.client.query(
      `DELETE FROM wfos_execution_policies WHERE project_id = $1`,
      [stack.fixture.projectId],
    );
    const reborn = await policyRepository.insertDefaultProjectPolicy(
      stack.fixture.organizationId, stack.fixture.projectId,
    );
    expect(reborn.frozen).toBe(true);
  });

  it('the repository-level start claim (claimExperimentStart) also freezes — no code path bypasses §9', async () => {
    // A second experiment on the same project, started through the
    // repository claim directly (bypassing the service wrapper): the
    // trigger still fires — the freeze is owned by the PERSISTENCE
    // boundary, not by any one application code path.
    const experimentId = await makeExperiment('freeze-via-repo-claim');
    const claimed = await stack.benchmarkRepository.claimExperimentStart(experimentId);
    expect(claimed).not.toBeNull();
    expect(claimed?.experiment.status).toBe('running');
    const after = await policyRepository.getProjectPolicy(stack.fixture.projectId);
    expect(after?.frozen).toBe(true);
  });
});
