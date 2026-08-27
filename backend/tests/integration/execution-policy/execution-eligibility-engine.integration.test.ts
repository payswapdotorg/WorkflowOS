/**
 * WORK-043 (§33.3) — Execution Eligibility and Constraint Engine PG
 * integration tests.
 *
 * Real-PostgreSQL tests of the constraint-engine persistence + orchestration
 * layer (the mode-constraint-validation pattern: buildAuthStack + the real
 * PgExecutionPolicyRepository + the real DefaultExecutionEligibilityService
 * + the real DefaultExecutionPolicyService with stubbed non-policy deps):
 *
 *   1. migration 0050 — the new policy columns + the DB CHECK backstops
 *      (rate limit requires BOTH halves; the classification ladder is
 *      closed; quotas are non-negative).
 *   2. policy CRUD round-trip for the new fields + the policy-boundary
 *      validation (validateWork043PolicyFields — clean domain errors).
 *   3. usage derivation — countProjectExecutionsSince reads the
 *      AUTHORITATIVE wfos_executions rows (project-wide + provider-scoped,
 *      period-bounded; NO parallel usage ledger).
 *   4. the recommendation path — an exhausted quota EXCLUDES every
 *      candidate with the structured quota_exhausted reason (the §33.3
 *      pre-ranking hard filter, end-to-end through the real service).
 *   5. evaluateCandidateEligibility — the point-in-time single-candidate
 *      seam (eligible verdict, quota-exhausted verdict, and an unknown
 *      provider → the honest configuration_missing verdict).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import {
  DefaultExecutionPolicyService,
  DefaultExecutionEligibilityService,
  DefaultExecutionRecommendationService,
  PgExecutionPolicyRepository,
  validateWork043PolicyFields,
} from '../../../src/execution-policy/index.js';
import { PgExecutionRecordRepository } from '../../../src/modules/agents/internal/pg-execution-repository.js';
import { PgImplementationContextRepository } from '../../../src/modules/work-items/internal/pg-implementation-context-repository.js';
import { DefaultImplementationContextBuilder } from '../../../src/modules/work-items/internal/implementation-context-builder.js';
import type { ExecutionTaskProfile } from '../../../src/execution-policy/types.js';

// ============================================================================
// Stubs (non-policy deps — the mode-constraint-validation pattern)
// ============================================================================

const TASK_PROFILE: ExecutionTaskProfile = {
  language: 'typescript',
  framework: 'nextjs',
  repositorySize: 'medium',
  complexity: 'medium',
  architectureSensitivity: 'low',
  securitySensitivity: 'low',
  browserRequired: false,
  terminalRequired: false,
  repositoryAccess: true,
  externalExecutionAllowed: true,
  nativeExecutionAllowed: true,
  requiredCapabilities: ['coding_agent'],
  humanInterventionLikely: false,
};

describe('WORK-043 — Execution Eligibility and Constraint Engine (PG)', () => {
  let stack: TestAuthStack;
  let repository: PgExecutionPolicyRepository;
  let service: DefaultExecutionPolicyService;
  let executionRecordRepo: PgExecutionRecordRepository;
  let organizationId: string;
  let projectId: string;
  let userId: string;
  // The FK-valid chain for execution creation (project → arch → version →
  // work item → work order → implementation context).
  let workItemId: string;
  let workOrderId: string;
  let contextId: string;
  let execCount = 0;

  beforeAll(async () => {
    stack = await buildAuthStack();
    const db = stack.db.client;
    repository = new PgExecutionPolicyRepository(db);
    executionRecordRepo = new PgExecutionRecordRepository(db);
    service = new DefaultExecutionPolicyService({
      db,
      logger: stack.db.logger,
      repository,
      eligibilityService: new DefaultExecutionEligibilityService(),
      recommendationService: new DefaultExecutionRecommendationService(),
      taskProfileBuilder: { build: () => Promise.resolve(TASK_PROFILE) },
      agentProviderRegistry: {
        getExecutionProviders: () =>
          Promise.resolve([
            {
              name: 'Fake Provider',
              provider: 'fake',
              model: 'fake-model',
              nativeApi: 'ready',
              externalUi: 'not-supported',
            },
            {
              name: 'External Provider',
              provider: 'external-coder',
              model: 'ext-model',
              nativeApi: 'not-configured',
              externalUi: 'available',
            },
          ]),
        isExternalProviderSupported: () => Promise.resolve(true),
      },
      benchmarkEvidenceProvider: {
        historicalPerformanceForCell: () =>
          Promise.resolve({
            sampleSize: 0,
            sufficient: false,
            observedQuality: null,
            ciFirstPassRate: null,
            verificationFirstPassRate: null,
            medianCorrectionCycles: null,
            medianTimeToVerifiedMs: null,
            humanInterventionCount: null,
            evidenceCells: [],
          }),
        aggregateForProject: () =>
          Promise.resolve({
            sampleSize: 0,
            sufficient: false,
            observedQuality: null,
            ciFirstPassRate: null,
            verificationFirstPassRate: null,
            medianCorrectionCycles: null,
            medianTimeToVerifiedMs: null,
            humanInterventionCount: null,
            evidenceCells: [],
          }),
      },
    });

    const org = await stack.organizationRepository.create({ name: 'W043 Constraint Engine Org' });
    organizationId = org.id;
    const user = await stack.userRepository.upsertByExternalId({ externalId: 'w043-user', displayName: 'W043 User' });
    userId = user.id;
    const project = await stack.projectRepository.create({ organizationId, name: 'W043 Engine Project' });
    projectId = project.id;

    // The FK-valid execution chain.
    const arch = await stack.architectureRepository.create({ projectId, name: 'W043 Arch' });
    const version = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: '# W043' });
    const workItem = await stack.workItemRepository.create({
      architectureVersionId: version.id,
      workItemId: 'WORK-W043-001',
      title: 'Constraint engine fixture',
      objective: 'fixture',
      scope: 'src/x.ts',
      outOfScope: 'none',
      metadata: { baseCommit: 'w043-baseline-commit-000000000000000001' },
    });
    workItemId = workItem.id;
    const workOrder = await stack.workOrderRepository.create({
      workItemId: workItem.id,
      projectId,
      architectureVersionId: version.id,
      requirementIds: [],
      criterionIds: [],
      scope: 'src/x.ts',
      verificationRequirements: [],
    });
    workOrderId = workOrder.id;
    // Build the ImplementationContext via the real builder (the executions
    // integrity trigger validates the context belongs to this work item).
    const contextRepo = new PgImplementationContextRepository(db);
    const contextBuilder = new DefaultImplementationContextBuilder(
      stack.workItemRepository,
      stack.workOrderRepository,
      stack.workItemRequirementRepository,
      stack.workItemCriterionRepository,
      stack.workItemDependencyRepository,
      stack.requirementRepository,
      stack.acceptanceCriterionRepository,
      stack.architectureVersionRepository,
      stack.architectureRepository,
      contextRepo,
      async () => null,
      async () => null,
      async () => [],
      async () => [],
    );
    const ctx = await contextBuilder.build(workItem.id);
    contextId = ctx.id;
  });

  afterAll(async () => {
    await stack.teardown();
  });

  /** Insert an execution row (the authoritative usage source). */
  async function insertExecution(provider: string, mode: 'native' | 'external'): Promise<void> {
    const executionId = `wf-w043-${++execCount}`;
    await executionRecordRepo.create({
      executionId,
      projectId,
      workItemId,
      workOrderId,
      implementationContextId: contextId,
      mode,
      provider,
      model: `${provider}-model`,
      prompt: `p-${executionId}`,
      promptDigest: `d-${executionId}`,
      branch: null,
    });
  }

  // -------------------------------------------------------------------------
  // 1. migration 0050 — the columns + the DB CHECK backstops
  // -------------------------------------------------------------------------
  describe('migration 0050 — policy columns + CHECK backstops', () => {
    it('the new columns exist with the documented defaults', async () => {
      await repository.insertDefaultProjectPolicy(organizationId, projectId);
      const policy = await repository.getProjectPolicy(projectId);
      expect(policy).not.toBeNull();
      expect(policy!.maxExecutionsPerMonth).toBeNull();
      expect(policy!.maxExecutionsPerDay).toBeNull();
      expect(policy!.rateLimitMaxRequests).toBeNull();
      expect(policy!.rateLimitWindowSeconds).toBeNull();
      expect(policy!.securityClassification).toBe('standard');
      expect(policy!.externalSecurityCeiling).toBeNull();
    });

    it('DB CHECK: a rate limit with max-requests but NO window is REJECTED (both halves or neither)', async () => {
      await expect(
        stack.db.client.query(
          `UPDATE wfos_execution_policies SET rate_limit_max_requests = 5 WHERE project_id = $1`,
          [projectId],
        ),
      ).rejects.toThrow(/wfos_execution_policy_rate_limit_requires_window/);
    });

    it('DB CHECK: an off-ladder security classification is REJECTED', async () => {
      await expect(
        stack.db.client.query(
          `UPDATE wfos_execution_policies SET security_classification = 'top-secret' WHERE project_id = $1`,
          [projectId],
        ),
      ).rejects.toThrow(/wfos_execution_policy_security_classification_valid/);
    });

    it('DB CHECK: a negative quota is REJECTED', async () => {
      await expect(
        stack.db.client.query(
          `UPDATE wfos_execution_policies SET max_executions_per_month = -1 WHERE project_id = $1`,
          [projectId],
        ),
      ).rejects.toThrow(/wfos_execution_policy_quota_nonnegative/);
    });
  });

  // -------------------------------------------------------------------------
  // 2. policy CRUD + the policy-boundary validation
  // -------------------------------------------------------------------------
  describe('policy CRUD + validateWork043PolicyFields', () => {
    it('PATCH round-trips the new fields', async () => {
      const updated = await service.updateProjectPolicy(projectId, {
        maxExecutionsPerMonth: 100,
        maxExecutionsPerDay: 10,
        rateLimitMaxRequests: 5,
        rateLimitWindowSeconds: 60,
        securityClassification: 'confidential',
        externalSecurityCeiling: 'confidential',
      });
      expect(updated.maxExecutionsPerMonth).toBe(100);
      expect(updated.maxExecutionsPerDay).toBe(10);
      expect(updated.rateLimitMaxRequests).toBe(5);
      expect(updated.rateLimitWindowSeconds).toBe(60);
      expect(updated.securityClassification).toBe('confidential');
      expect(updated.externalSecurityCeiling).toBe('confidential');
      // Clearing back to null round-trips too.
      const cleared = await service.updateProjectPolicy(projectId, {
        maxExecutionsPerMonth: null,
        maxExecutionsPerDay: null,
        rateLimitMaxRequests: null,
        rateLimitWindowSeconds: null,
        securityClassification: 'standard',
        externalSecurityCeiling: null,
      });
      expect(cleared.maxExecutionsPerMonth).toBeNull();
      expect(cleared.rateLimitWindowSeconds).toBeNull();
    });

    it('the MERGED rate-limit pair is validated (max set, window cleared → rejected)', async () => {
      await service.updateProjectPolicy(projectId, { rateLimitMaxRequests: 5, rateLimitWindowSeconds: 60 });
      await expect(
        service.updateProjectPolicy(projectId, { rateLimitWindowSeconds: null }),
      ).rejects.toThrow('execution-policy-invalid-constraint');
      await service.updateProjectPolicy(projectId, { rateLimitMaxRequests: null, rateLimitWindowSeconds: null });
    });

    it('validateWork043PolicyFields: the named rejection cases', () => {
      expect(() =>
        validateWork043PolicyFields({
          maxExecutionsPerMonth: -1, maxExecutionsPerDay: null,
          rateLimitMaxRequests: null, rateLimitWindowSeconds: null,
          securityClassification: 'standard', externalSecurityCeiling: null,
        }),
      ).toThrow('execution-policy-invalid-constraint');
      expect(() =>
        validateWork043PolicyFields({
          maxExecutionsPerMonth: null, maxExecutionsPerDay: null,
          rateLimitMaxRequests: 5, rateLimitWindowSeconds: null,
          securityClassification: 'standard', externalSecurityCeiling: null,
        }),
      ).toThrow('rate limit requires BOTH halves');
      expect(() =>
        validateWork043PolicyFields({
          maxExecutionsPerMonth: null, maxExecutionsPerDay: null,
          rateLimitMaxRequests: null, rateLimitWindowSeconds: null,
          securityClassification: 'cosmic', externalSecurityCeiling: null,
        }),
      ).toThrow('standard | confidential | restricted');
    });
  });

  // -------------------------------------------------------------------------
  // 3. usage derivation (the AUTHORITATIVE wfos_executions source)
  // -------------------------------------------------------------------------
  describe('usage derivation — countProjectExecutionsSince', () => {
    it('counts project-wide and provider-scoped, bounded by the period', async () => {
      await insertExecution('fake', 'native');
      await insertExecution('fake', 'native');
      await insertExecution('external-coder', 'external');

      const now = new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const ancient = new Date(Date.UTC(2000, 0, 1));

      const thisMonth = await repository.countProjectExecutionsSince(projectId, null, monthStart);
      expect(thisMonth).toBe(3); // project-wide: all three executions
      const fakeWindow = await repository.countProjectExecutionsSince(projectId, 'fake', ancient);
      expect(fakeWindow).toBe(2); // provider-scoped
      const otherProject = await repository.countProjectExecutionsSince('00000000-0000-0000-0000-000000000000', null, monthStart);
      expect(otherProject).toBe(0); // tenant-scoped
    });
  });

  // -------------------------------------------------------------------------
  // 4. the recommendation path — the pre-ranking hard filter end-to-end
  // -------------------------------------------------------------------------
  describe('recommend() — the pre-ranking hard filter (end-to-end)', () => {
    // The INTERACTIVE recommendation path keeps §5 semantics (an unknown
    // subscription blocks) — the user configures their access profiles
    // first (exactly what the WORK-033 regression suite models).
    beforeAll(async () => {
      await service.upsertAccessProfile(organizationId, userId, {
        provider: 'fake',
        plan: 'pro',
        codingAgent: 'ready',
        externalUi: 'unverified',
        nativeApi: 'ready',
        statusSource: 'verified',
      });
      await service.upsertAccessProfile(organizationId, userId, {
        provider: 'external-coder',
        plan: 'pro',
        codingAgent: 'ready',
        externalUi: 'ready',
        nativeApi: 'unverified',
        statusSource: 'verified',
      });
    });

    it('an exhausted monthly quota EXCLUDES every candidate with the structured quota_exhausted reason', async () => {
      // Quota 3, usage 3 (the three executions inserted above).
      await service.updateProjectPolicy(projectId, { maxExecutionsPerMonth: 3 });
      const recommendation = await service.recommend({
        organizationId, projectId, workItemId, userId,
      });
      // Every candidate is excluded by the quota family — BEFORE ranking.
      expect(recommendation.eligibleCandidates).toEqual([]);
      expect(recommendation.excludedCandidates.length).toBeGreaterThan(0);
      for (const excluded of recommendation.excludedCandidates) {
        expect(excluded.eligibility.eligible).toBe(false);
        expect(excluded.eligibility.status).toBe('quota_exhausted');
        expect(
          excluded.eligibility.blockingReasons.some((b) => b.constraint === 'monthly_quota_exhausted'),
        ).toBe(true);
      }
      expect(recommendation.recommendedCandidate).toBeNull();
      // Raising the quota re-admits the candidates (usage 3 < 10).
      await service.updateProjectPolicy(projectId, { maxExecutionsPerMonth: 10 });
      const lifted = await service.recommend({ organizationId, projectId, workItemId, userId });
      expect(lifted.eligibleCandidates.length).toBeGreaterThan(0);
      expect(lifted.recommendedCandidate).not.toBeNull();
      await service.updateProjectPolicy(projectId, { maxExecutionsPerMonth: null });
    });

    it('the security ceiling excludes ONLY the external candidates (native passes)', async () => {
      await service.updateProjectPolicy(projectId, {
        securityClassification: 'restricted',
        externalSecurityCeiling: 'confidential',
      });
      const recommendation = await service.recommend({ organizationId, projectId, workItemId, userId });
      const external = recommendation.excludedCandidates.filter((c) => c.executionMode === 'external');
      const native = recommendation.eligibleCandidates.filter((c) => c.executionMode === 'native');
      expect(external.length).toBeGreaterThan(0);
      for (const c of external) {
        expect(c.eligibility.status).toBe('security_blocked');
        expect(c.eligibility.blockingReasons.some((b) => b.constraint === 'external_security_ceiling')).toBe(true);
      }
      expect(native.length).toBeGreaterThan(0);
      await service.updateProjectPolicy(projectId, {
        securityClassification: 'standard',
        externalSecurityCeiling: null,
      });
    });

    it('a per-provider rate limit excludes ONLY the exhausted provider', async () => {
      // 2 dispatches on 'fake' in any window; limit 2 → 'fake' excluded,
      // 'external-coder' (0 dispatches) eligible.
      await service.updateProjectPolicy(projectId, {
        rateLimitMaxRequests: 2,
        rateLimitWindowSeconds: 3_600,
      });
      const recommendation = await service.recommend({ organizationId, projectId, workItemId, userId });
      const fake = recommendation.excludedCandidates.find((c) => c.provider === 'fake');
      expect(fake).toBeDefined();
      expect(fake!.eligibility.status).toBe('rate_limited');
      expect(fake!.eligibility.blockingReasons.some((b) => b.constraint === 'rate_limit_window_exhausted')).toBe(true);
      const external = recommendation.eligibleCandidates.find((c) => c.provider === 'external-coder');
      expect(external).toBeDefined();
      await service.updateProjectPolicy(projectId, {
        rateLimitMaxRequests: null,
        rateLimitWindowSeconds: null,
      });
    });
  });

  // -------------------------------------------------------------------------
  // 5. evaluateCandidateEligibility — the point-in-time seam
  // -------------------------------------------------------------------------
  describe('evaluateCandidateEligibility — the point-in-time seam', () => {
    it('an eligible destination verdict (no constraints active)', async () => {
      const verdict = await service.evaluateCandidateEligibility({
        organizationId, projectId, workItemId,
        provider: 'fake', model: 'fake-model', executionMode: 'native',
        userId,
      });
      expect(verdict.eligibility.eligible).toBe(true);
      expect(verdict.eligibility.status).toBe('eligible');
      expect(verdict.policyVersion).toBeGreaterThan(0);
      // The constraint snapshot is returned for audit records.
      expect(verdict.constraints.quota.monthlyMaxExecutions).toBeNull();
      expect(verdict.constraints.security.projectClassification).toBe('standard');
    });

    it('a quota-exhausted destination verdict (the handoff gate input)', async () => {
      await service.updateProjectPolicy(projectId, { maxExecutionsPerDay: 3 });
      const verdict = await service.evaluateCandidateEligibility({
        projectId, workItemId,
        provider: 'external-coder', model: null, executionMode: 'external',
      });
      expect(verdict.eligibility.eligible).toBe(false);
      expect(verdict.eligibility.status).toBe('quota_exhausted');
      expect(verdict.eligibility.blockingReasons.some((b) => b.constraint === 'daily_quota_exhausted')).toBe(true);
      // No organization context → the agent-policy family is INACTIVE
      // (the handoff's own per-execution gate enforces it).
      expect(verdict.constraints.agentPolicy.externalDecision).toBe('allow');
      await service.updateProjectPolicy(projectId, { maxExecutionsPerDay: null });
    });

    it('an UNKNOWN provider → the honest configuration_missing verdict (no invented capabilities)', async () => {
      const verdict = await service.evaluateCandidateEligibility({
        projectId, workItemId,
        provider: 'never-configured', model: 'm', executionMode: 'native',
      });
      expect(verdict.eligibility.eligible).toBe(false);
      expect(
        verdict.eligibility.blockingReasons.some(
          (b) => b.category === 'availability' && b.constraint === 'configuration_missing',
        ),
      ).toBe(true);
    });

    it('a security-blocked external destination (the ceiling applies at the seam too)', async () => {
      await service.updateProjectPolicy(projectId, {
        securityClassification: 'restricted',
        externalSecurityCeiling: 'standard',
      });
      const verdict = await service.evaluateCandidateEligibility({
        projectId, workItemId,
        provider: 'external-coder', model: null, executionMode: 'external',
      });
      expect(verdict.eligibility.eligible).toBe(false);
      expect(verdict.eligibility.status).toBe('security_blocked');
      await service.updateProjectPolicy(projectId, {
        securityClassification: 'standard',
        externalSecurityCeiling: null,
      });
    });
  });
});
