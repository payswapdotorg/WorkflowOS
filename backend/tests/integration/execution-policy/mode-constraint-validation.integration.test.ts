/**
 * PR #37 review fix (final correction) — constrained benchmark modes must
 * be MEANINGFUL: a mode is rejected at the POLICY BOUNDARY when its
 * constraint is absent, rather than silently falling back to unconstrained
 * behavior.
 *
 * The previous fixes made eligibility fail closed when a cap is ACTIVE and
 * the evidence is unknown — but the system could still persist + return:
 *
 *     benchmarkMode = COST_CONSTRAINED    with maxCostCents  = NULL
 *     benchmarkMode = LATENCY_CONSTRAINED with maxDurationMs = NULL
 *
 * In both cases the fail-closed logic correctly does nothing (no active
 * cap) — the policy is labeled constrained while imposing no constraint,
 * violating the meaning of the benchmark modes (§8).
 *
 * The invariant is enforced at TWO boundaries:
 *   * the SERVICE (validateBenchmarkModeConstraint — a clear domain error,
 *     validating the MERGED policy on update + the RESOLVED mode on
 *     recommendation);
 *   * the DATABASE (migration 0033's CHECK constraint — no write path can
 *     persist a meaningless combination, including REMOVING the cap while
 *     the mode stays constrained).
 *
 * The reviewer's required coverage:
 *   COST_CONSTRAINED + null maxCost     → rejected
 *   LATENCY_CONSTRAINED + null maxDuration → rejected
 *   valid constrained mode + cap        → accepted
 * plus the merged-update directions + the recommendation-time rejection +
 * the DB backstop.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { DefaultExecutionPolicyService } from '../../../src/execution-policy/internal/default-execution-policy-service.js';
import { PgExecutionPolicyRepository } from '../../../src/execution-policy/index.js';

describe('PR #37 review fix — constrained benchmark modes require their caps (policy-boundary rejection)', () => {
  let stack: TestAuthStack;
  let service: DefaultExecutionPolicyService;
  let repository: PgExecutionPolicyRepository;
  let organizationId: string;
  let projectId: string;
  let userId: string;

  beforeAll(async () => {
    stack = await buildAuthStack();
    repository = new PgExecutionPolicyRepository(stack.db.client);
    service = new DefaultExecutionPolicyService({
      db: stack.db.client,
      logger: stack.db.logger,
      repository,
      eligibilityService: { evaluate: () => ({ status: 'eligible', eligible: true, blockingReasons: [], satisfiedConstraints: [] }) } as never,
      recommendationService: { rank: () => ({ ranked: [], recommended: null, why: { recommendedCandidateId: null, headline: '', reasons: [], alternatives: [] } }) } as never,
      taskProfileBuilder: { build: () => Promise.resolve({}) } as never,
      agentProviderRegistry: { getExecutionProviders: () => Promise.resolve([]) } as never,
      benchmarkEvidenceProvider: { historicalPerformanceForCell: () => Promise.resolve(null as never), aggregateForProject: () => Promise.resolve(null as never) } as never,
    });
    const org = await stack.organizationRepository.create({ name: 'Mode Constraint Org' });
    organizationId = org.id;
    const user = await stack.userRepository.upsertByExternalId({ externalId: 'mode-constraint-user', displayName: 'Mode Constraint User' });
    userId = user.id;
    const project = await stack.projectRepository.create({ organizationId, name: 'Mode Constraint Project' });
    projectId = project.id;
  });

  afterAll(async () => {
    await stack.teardown();
  });

  // -------------------------------------------------------------------------
  // The reviewer's three required scenarios
  // -------------------------------------------------------------------------
  it('COST_CONSTRAINED + null maxCost → rejected (policy update)', async () => {
    await repository.insertDefaultProjectPolicy(organizationId, projectId);
    await expect(
      service.updateProjectPolicy(projectId, { defaultBenchmarkMode: 'cost_constrained' }),
    ).rejects.toThrow('execution-policy-invalid-mode-constraint: COST_CONSTRAINED requires a cost cap');
    // The policy is UNCHANGED (not silently persisted as a meaningless mode).
    const policy = await repository.getProjectPolicy(projectId);
    expect(policy?.defaultBenchmarkMode).toBe('maximum_capability');
  });

  it('LATENCY_CONSTRAINED + null maxDuration → rejected (policy update)', async () => {
    await expect(
      service.updateProjectPolicy(projectId, { defaultBenchmarkMode: 'latency_constrained' }),
    ).rejects.toThrow('execution-policy-invalid-mode-constraint: LATENCY_CONSTRAINED requires a duration cap');
    const policy = await repository.getProjectPolicy(projectId);
    expect(policy?.defaultBenchmarkMode).toBe('maximum_capability');
  });

  it('valid constrained mode + cap → accepted (both orders: cap-then-mode and mode-then-cap)', async () => {
    // Order A: set the cap FIRST, then the constrained mode.
    await service.updateProjectPolicy(projectId, { maxCostPerTaskCents: 500 });
    const costConstrained = await service.updateProjectPolicy(projectId, { defaultBenchmarkMode: 'cost_constrained' });
    expect(costConstrained.defaultBenchmarkMode).toBe('cost_constrained');
    expect(costConstrained.maxCostPerTaskCents).toBe(500);

    // Order B: switch to latency-constrained by setting BOTH in one patch
    // (mode + its cap atomically valid).
    const latencyConstrained = await service.updateProjectPolicy(projectId, {
      defaultBenchmarkMode: 'latency_constrained',
      maxTimeToPrMs: 600_000,
    });
    expect(latencyConstrained.defaultBenchmarkMode).toBe('latency_constrained');
    expect(latencyConstrained.maxTimeToPrMs).toBe(600_000);

    // Reset to the unconstrained default for the later tests.
    await service.updateProjectPolicy(projectId, {
      defaultBenchmarkMode: 'maximum_capability',
      maxCostPerTaskCents: null,
      maxTimeToPrMs: null,
    });
  });

  // -------------------------------------------------------------------------
  // The merged-update directions (the cap and the mode can race in either
  // order across separate patches)
  // -------------------------------------------------------------------------
  it('removing the cap while the mode is COST_CONSTRAINED → rejected (merged validation)', async () => {
    await service.updateProjectPolicy(projectId, { maxCostPerTaskCents: 500, defaultBenchmarkMode: 'cost_constrained' });
    await expect(
      service.updateProjectPolicy(projectId, { maxCostPerTaskCents: null }),
    ).rejects.toThrow('execution-policy-invalid-mode-constraint');
    const policy = await repository.getProjectPolicy(projectId);
    expect(policy?.maxCostPerTaskCents).toBe(500);
    // Cleanup.
    await service.updateProjectPolicy(projectId, { defaultBenchmarkMode: 'maximum_capability', maxCostPerTaskCents: null });
  });

  it('recommendation with an explicit constrained mode on a capless project → rejected (no silent unconstrained fallback)', async () => {
    // The project policy is maximum_capability with NO caps. An explicit
    // ?benchmarkMode=cost_constrained request must be REJECTED — not
    // silently evaluated as an unconstrained-but-labeled-constrained policy.
    await expect(
      service.recommend({ organizationId, projectId, workItemId: 'wi-none', userId, benchmarkMode: 'cost_constrained' }),
    ).rejects.toThrow('execution-policy-invalid-mode-constraint: COST_CONSTRAINED requires a cost cap');
    await expect(
      service.recommend({ organizationId, projectId, workItemId: 'wi-none', userId, benchmarkMode: 'latency_constrained' }),
    ).rejects.toThrow('execution-policy-invalid-mode-constraint: LATENCY_CONSTRAINED requires a duration cap');
  });

  it('recommendation with a constrained mode + the cap present → proceeds past validation', async () => {
    await service.updateProjectPolicy(projectId, { maxCostPerTaskCents: 500, defaultBenchmarkMode: 'cost_constrained' });
    // Past mode-constraint validation (the task-profile builder stub throws
    // for the nonexistent work item — a DIFFERENT failure, proving the
    // mode validation passed).
    await expect(
      service.recommend({ organizationId, projectId, workItemId: 'wi-none', userId, benchmarkMode: 'cost_constrained' }),
    ).rejects.not.toThrow('execution-policy-invalid-mode-constraint');
    // Cleanup.
    await service.updateProjectPolicy(projectId, { defaultBenchmarkMode: 'maximum_capability', maxCostPerTaskCents: null });
  });

  // -------------------------------------------------------------------------
  // The database backstop (migration 0033 CHECK) — no write path can bypass
  // -------------------------------------------------------------------------
  it('DB CHECK rejects COST_CONSTRAINED with a null cap (raw SQL bypasses the service)', async () => {
    await expect(
      stack.db.client.query(
        `UPDATE wfos_execution_policies
            SET default_benchmark_mode = 'cost_constrained'
          WHERE project_id = $1`,
        [projectId],
      ),
    ).rejects.toThrow(/wfos_execution_policy_constrained_mode_requires_cap/);
  });

  it('DB CHECK rejects LATENCY_CONSTRAINED with a null duration (raw SQL)', async () => {
    await expect(
      stack.db.client.query(
        `UPDATE wfos_execution_policies
            SET default_benchmark_mode = 'latency_constrained'
          WHERE project_id = $1`,
        [projectId],
      ),
    ).rejects.toThrow(/wfos_execution_policy_constrained_mode_requires_cap/);
  });

  it('DB CHECK rejects removing the cap while COST_CONSTRAINED (raw SQL, symmetric)', async () => {
    await stack.db.client.query(
      `UPDATE wfos_execution_policies
          SET default_benchmark_mode = 'cost_constrained', max_cost_per_task_cents = 500
        WHERE project_id = $1`,
      [projectId],
    );
    await expect(
      stack.db.client.query(
        `UPDATE wfos_execution_policies
            SET max_cost_per_task_cents = NULL
          WHERE project_id = $1`,
        [projectId],
      ),
    ).rejects.toThrow(/wfos_execution_policy_constrained_mode_requires_cap/);
  });

  it('the DEFAULT policy (maximum_capability + null caps) remains valid', async () => {
    // The default insert must not trip the constraint (no caps + an
    // unconstrained mode is semantically fine).
    const project2 = await stack.projectRepository.create({ organizationId, name: 'Mode Constraint Project 2' });
    const policy = await repository.insertDefaultProjectPolicy(organizationId, project2.id);
    expect(policy.defaultBenchmarkMode).toBe('maximum_capability');
    expect(policy.maxCostPerTaskCents).toBeNull();
    expect(policy.maxTimeToPrMs).toBeNull();
  });
});
