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

  // ------------------------------------------------------------------------
  // PR #37 review fix (final) — FROZEN-MODE OVERRIDE REJECTION (§9
  // immutability/audit guarantee): a frozen policy's benchmark mode is part
  // of the immutable policy version. A decision must never claim
  // policyVersion N while using a DIFFERENT benchmark mode than the frozen
  // policy — so an explicit ?benchmarkMode= override that differs from the
  // frozen mode is rejected (409). Passing the frozen mode itself is a
  // no-op (allowed), and unfrozen policies keep the §16 request-scoped
  // override.
  // ------------------------------------------------------------------------
  describe('frozen-mode override rejection (§9 immutability/audit guarantee)', () => {
    let frozenProjectId: string;
    let unfrozenProjectId: string;

    beforeAll(async () => {
      frozenProjectId = (await stack.projectRepository.create({ organizationId, name: 'Frozen Mode Project' })).id;
      unfrozenProjectId = (await stack.projectRepository.create({ organizationId, name: 'Unfrozen Override Project' })).id;
      await repository.insertDefaultProjectPolicy(organizationId, frozenProjectId);
      await repository.insertDefaultProjectPolicy(organizationId, unfrozenProjectId);
      // Freeze the frozen project explicitly (the §9 pre-freeze; the
      // freeze-on-start trigger from migration 0032 covers the other path).
      await repository.freezeProjectPolicy(frozenProjectId);
    });

    it('frozen policy + a DIFFERING explicit benchmarkMode → rejected (the decision cannot claim the frozen version under another mode)', async () => {
      // The frozen policy: maximum_capability (policyVersion bumped by the
      // freeze). The reviewer's exact scenario: ?benchmarkMode=cost_constrained
      // would produce a decision claiming that policyVersion while using a
      // different mode than the frozen policy.
      await expect(
        service.recommend({ organizationId, projectId: frozenProjectId, workItemId: 'wi-none', userId, benchmarkMode: 'cost_constrained' }),
      ).rejects.toThrow(/execution-policy-frozen-mode: the project policy is frozen \(policyVersion=\d+, benchmarkMode=maximum_capability\)/);
      // Any differing mode is rejected — not just constrained ones.
      await expect(
        service.recommend({ organizationId, projectId: frozenProjectId, workItemId: 'wi-none', userId, benchmarkMode: 'controlled_comparison' }),
      ).rejects.toThrow('execution-policy-frozen-mode');
      await expect(
        service.recommend({ organizationId, projectId: frozenProjectId, workItemId: 'wi-none', userId, benchmarkMode: 'latency_constrained' }),
      ).rejects.toThrow('execution-policy-frozen-mode');
    });

    it('frozen policy + the SAME explicit benchmarkMode → not a frozen-mode rejection (a no-op override)', async () => {
      // Passing the frozen mode itself is semantically identical to no
      // override — the decision uses exactly the frozen mode + version.
      // (The call proceeds past the frozen-mode + mode-constraint checks; it
      // then fails on the nonexistent work item in the real repository — a
      // DIFFERENT error, proving the override was not rejected as frozen.)
      await expect(
        service.recommend({ organizationId, projectId: frozenProjectId, workItemId: 'wi-none', userId, benchmarkMode: 'maximum_capability' }),
      ).rejects.not.toThrow(/execution-policy-frozen-mode/);
    });

    it('frozen policy + NO explicit benchmarkMode → uses the frozen mode (not rejected)', async () => {
      await expect(
        service.recommend({ organizationId, projectId: frozenProjectId, workItemId: 'wi-none', userId }),
      ).rejects.not.toThrow(/execution-policy-frozen-mode/);
    });

    it('UNFROZEN policy + a differing explicit benchmarkMode → the §16 override still works', async () => {
      // The request-scoped override remains available for unfrozen policies
      // (this is the §16 feature — freezing only locks the mode). Uses
      // controlled_comparison (no cap requirement) so the mode-constraint
      // validation also passes.
      await expect(
        service.recommend({ organizationId, projectId: unfrozenProjectId, workItemId: 'wi-none', userId, benchmarkMode: 'controlled_comparison' }),
      ).rejects.not.toThrow(/execution-policy-frozen-mode/);
      await expect(
        service.recommend({ organizationId, projectId: unfrozenProjectId, workItemId: 'wi-none', userId, benchmarkMode: 'controlled_comparison' }),
      ).rejects.not.toThrow(/execution-policy-invalid-mode-constraint/);
    });
  });

// ============================================================================
// PR #37 review fix (TOCTOU) — ATOMIC SNAPSHOT VALIDATION of the decision
// write. The read-time frozen-mode guard is correct for a single request
// but NOT race-safe:
//
//     recommend() reads policy vN (frozen=false)
//         ↓ validate mode (passes — valid for unfrozen)
//         ↓ compute candidates / evidence
//         ↓ [CONCURRENT: policy mutates to vN+1 and/or freezes]
//         ↓ persist decision claiming vN        ← the stale-write race
//
// The decision record is the authoritative audit of policyVersion /
// benchmarkMode / candidates / why / evidence — it must describe ONE
// COHERENT policy snapshot. The fix: the decision INSERT is atomically
// conditioned on the CURRENT policy row (same version + not-frozen-or-
// same-mode). A mutation/freeze during the recommendation → no row → the
// retryable stale-snapshot error. The race is simulated by a
// taskProfileBuilder hook that mutates the policy MID-recommendation
// (task profile building runs AFTER the policy read + BEFORE the decision
// insert — exactly the reviewer's window).
// ============================================================================

describe('PR #37 review fix — atomic decision snapshot validation (TOCTOU elimination)', () => {
  /** Build a recommend()-shaped service with a MID-RECOMMENDATION policy-mutation hook. */
  function buildRacingService(mutateMidRecommendation: () => Promise<void>): DefaultExecutionPolicyService {
    return new DefaultExecutionPolicyService({
      db: stack.db.client,
      logger: stack.db.logger,
      repository,
      eligibilityService: { evaluate: () => ({ status: 'eligible', eligible: true, blockingReasons: [], satisfiedConstraints: [] }) } as never,
      recommendationService: { rank: () => ({ ranked: [], recommended: null, why: { recommendedCandidateId: null, headline: '', reasons: [], alternatives: [] } }) } as never,
      taskProfileBuilder: {
        // Runs AFTER the policy read + BEFORE the decision insert — the
        // TOCTOU window. Mutating the policy here simulates the concurrent
        // request that races the recommendation.
        build: async () => {
          await mutateMidRecommendation();
          return {};
        },
      } as never,
      agentProviderRegistry: { getExecutionProviders: () => Promise.resolve([]) } as never,
      benchmarkEvidenceProvider: { historicalPerformanceForCell: () => Promise.resolve(null as never), aggregateForProject: () => Promise.resolve(null as never) } as never,
    });
  }

  let toctouWorkItemId: string;

  beforeAll(async () => {
    // One shared work item for the TOCTOU tests (the decisions table has a
    // UUID FK to wfos_work_items, so a real row is required; a single id is
    // shared — the decision's work_item_id need only be a valid work item).
    const project = await stack.projectRepository.create({ organizationId, name: 'TOCTOU Fixture Project' });
    const arch = await stack.architectureRepository.create({ projectId: project.id, name: 'TOCTOU Arch' });
    const version = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: '# TOCTOU' });
    const workItem = await stack.workItemRepository.create({
      architectureVersionId: version.id,
      workItemId: 'WORK-TOCTOU-001',
      title: 'TOCTOU fixture', objective: 'fixture', scope: 'src/x.ts', outOfScope: 'none',
      metadata: { baseCommit: 'toctou-baseline-commit-000000000000000001' },
    });
    toctouWorkItemId = workItem.id;
  });

  async function countDecisions(projectId: string): Promise<number> {
    const res = await stack.db.client.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM wfos_execution_policy_decisions WHERE project_id = $1`,
      [projectId],
    );
    return Number(res.rows[0]?.c ?? 0);
  }

  it('policy MUTATED during the recommendation → the decision insert is REJECTED (no stale policyVersion persists) → retryable', async () => {
    const project = await stack.projectRepository.create({ organizationId, name: 'TOCTOU Mutate Project' });
    await repository.insertDefaultProjectPolicy(organizationId, project.id);
    const before = await repository.getProjectPolicy(project.id);
    expect(before?.policyVersion).toBe(1);

    // The concurrent request mutates the policy (any substantive UPDATE
    // bumps the version) while the recommendation is in flight.
    const racing = buildRacingService(async () => {
      await repository.updateProjectPolicy(project.id, { externalExecutionAllowed: false });
    });
    await expect(
      racing.recommend({ organizationId, projectId: project.id, workItemId: toctouWorkItemId, userId }),
    ).rejects.toThrow(/execution-policy-snapshot-stale: the project policy changed during the recommendation \(snapshot v1 is no longer the current authoritative version\)/);

    // ASSERTION — NO decision persisted (the atomic guard rejected the
    // stale-snapshot write; the decision audit never claims v1).
    expect(await countDecisions(project.id)).toBe(0);
    // The mutation itself committed (v2).
    const after = await repository.getProjectPolicy(project.id);
    expect(after?.policyVersion).toBe(2);
  });

  it('policy FROZEN during the recommendation (with a request-scoped mode) → the decision insert is REJECTED', async () => {
    const project = await stack.projectRepository.create({ organizationId, name: 'TOCTOU Freeze Project' });
    await repository.insertDefaultProjectPolicy(organizationId, project.id);

    // The request uses a request-scoped override (valid at read time — the
    // policy is unfrozen); a concurrent experiment start freezes the policy
    // mid-recommendation. The freeze bumps the version (the touch trigger)
    // → the version clause rejects; the frozen/mode clause is the
    // belt-and-braces backstop.
    const racing = buildRacingService(async () => {
      await repository.freezeProjectPolicy(project.id);
    });
    await expect(
      racing.recommend({ organizationId, projectId: project.id, workItemId: toctouWorkItemId, userId, benchmarkMode: 'controlled_comparison' }),
    ).rejects.toThrow('execution-policy-snapshot-stale');
    expect(await countDecisions(project.id)).toBe(0);

    // The RETRY (the reviewer's recovery path) reads the fresh policy — now
    // frozen — and the frozen-mode guard rejects the differing override
    // with the precise frozen-mode error (not a silent success).
    const retry = buildRacingService(async () => {});
    await expect(
      retry.recommend({ organizationId, projectId: project.id, workItemId: toctouWorkItemId, userId, benchmarkMode: 'controlled_comparison' }),
    ).rejects.toThrow('execution-policy-frozen-mode');
    expect(await countDecisions(project.id)).toBe(0);
  });

  it('NO mutation during the recommendation → the decision persists with the CURRENT version (the happy path survives the guard)', async () => {
    const project = await stack.projectRepository.create({ organizationId, name: 'TOCTOU Happy Project' });
    await repository.insertDefaultProjectPolicy(organizationId, project.id);

    const service = buildRacingService(async () => {});
    const rec = await service.recommend({ organizationId, projectId: project.id, workItemId: toctouWorkItemId, userId });
    expect(rec.decisionId).toBeTruthy();
    expect(await countDecisions(project.id)).toBe(1);
    // The persisted decision claims the version that was — and still is —
    // authoritative.
    const decisions = await repository.listDecisions(toctouWorkItemId);
    expect(decisions[0]?.policyVersion).toBe(1);
  });

  it('repository-level guard: each clause in isolation (version stale / frozen+differing mode / both pass)', async () => {
    const project = await stack.projectRepository.create({ organizationId, name: 'TOCTOU Guard Clauses Project' });
    await repository.insertDefaultProjectPolicy(organizationId, project.id);
    // Freeze the policy (the touch trigger bumps the version to 2).
    await repository.freezeProjectPolicy(project.id);
    const frozen = await repository.getProjectPolicy(project.id);
    expect(frozen?.frozen).toBe(true);
    expect(frozen?.policyVersion).toBe(2);

    const rowFor = (mode: string) => ({
      policyVersion: 2,
      benchmarkMode: mode,
      taskProfile: {},
      eligibleCandidates: [],
      excludedCandidates: [],
      recommendedCandidate: null,
      whyExplanation: 'fixture',
      scores: {},
      benchmarkEvidence: {},
    });

    // (a) VERSION CLAUSE alone: snapshot v1 (stale — the current row is v2)
    // + the frozen default mode → rejected by the version predicate.
    expect(await repository.insertDecision(
      organizationId, project.id, toctouWorkItemId, userId,
      { ...rowFor('maximum_capability'), policyVersion: 1 },
      { snapshotPolicyVersion: 1 },
    )).toBeNull();

    // (b) FROZEN/MODE CLAUSE alone: snapshot v2 (CURRENT — version matches)
    // + a DIFFERING effective mode → rejected by the frozen/mode predicate
    // even though the version is exact (the belt-and-braces clause).
    expect(await repository.insertDecision(
      organizationId, project.id, toctouWorkItemId, userId,
      rowFor('cost_constrained'),
      { snapshotPolicyVersion: 2 },
    )).toBeNull();

    // (c) BOTH pass: snapshot v2 (current) + the frozen default mode →
    // the decision persists claiming the exact current version.
    const allowed = await repository.insertDecision(
      organizationId, project.id, toctouWorkItemId, userId,
      rowFor('maximum_capability'),
      { snapshotPolicyVersion: 2 },
    );
    expect(allowed).not.toBeNull();
    expect(allowed?.policyVersion).toBe(2);
    expect(await countDecisions(project.id)).toBe(1);
  });
});
});
