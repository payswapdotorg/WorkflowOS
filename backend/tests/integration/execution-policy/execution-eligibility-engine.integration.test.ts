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
 *   3. usage derivation — countProjectDispatchesSince applies the AR-043-01
 *      DISPATCH PREDICATE over the AUTHORITATIVE records (an AgentRun
 *      ledger row — native — or the persisted external package):
 *      created-without-dispatch and rejected-before-dispatch records are
 *      NOT counted; actual dispatches are counted EXACTLY ONCE (a record
 *      carrying BOTH artifacts counts once). NO parallel usage ledger.
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
import type { ExternalExecutionPackage } from '../../../src/modules/agents/internal/execution.types.js';
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

    // The access profiles every recommend() call in this file needs (the §5
    // interactive subscription posture) — upserted ONCE in the outer scope so
    // the AR-043-02 end-to-end describe (which runs before the recommendation
    // describe) can call recommend() too.
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

  afterAll(async () => {
    await stack.teardown();
  });

  /**
   * Insert a NON-DISPATCHED execution row (status 'created' — the record
   * exists but NO provider dispatch was ever initiated: no AgentRun ledger
   * row, no external package).
   */
  async function insertExecution(provider: string, mode: 'native' | 'external'): Promise<{ id: string; executionId: string }> {
    const executionId = `wf-w043-${++execCount}`;
    const record = await executionRecordRepo.create({
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
    return { id: record.id, executionId: record.executionId };
  }

  /**
   * Mark a record REJECTED BEFORE DISPATCH — the provider-submit failure
   * shape (status 'failed' + failureStage 'provider-submit'): the dispatch
   * never initiated, so NO run row / package artifact is ever written.
   */
  async function rejectBeforeDispatch(id: string): Promise<void> {
    await executionRecordRepo.updateStatus(id, {
      status: 'failed',
      completedAt: new Date(),
      benchmarkMetadata: { failureStage: 'provider-submit', errorMessage: 'fixture: rejected before dispatch' },
    });
  }

  /**
   * Insert a NATIVE-DISPATCHED execution: the AgentRun ledger row (created
   * by the gateway BEFORE the adapter invocation — a FAILED run still
   * proves the provider operation initiated). This is the durable native
   * provider-operation record; the run row's OWN provider column is the
   * dispatch attribution (immutable — updateSuccess/updateFailed never
   * touch it) and the run row's OWN created_at is the dispatch event time.
   */
  async function insertNativeDispatch(provider: string, runStatus: 'success' | 'failed' | 'in_progress', runCreatedAt?: Date): Promise<{ id: string; executionId: string }> {
    const record = await insertExecution(provider, 'native');
    await insertRunRow(record.executionId, provider, runStatus, runCreatedAt);
    return record;
  }

  /** The AgentRun ledger row (optionally back-dated for window-edge proofs). */
  async function insertRunRow(executionId: string, provider: string, status: string, createdAt?: Date): Promise<void> {
    await stack.db.client.query(
      `INSERT INTO wfos_agent_runs (execution_id, work_item_id, work_order_id, provider, status, created_at)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, NOW()))`,
      [executionId, workItemId, workOrderId, provider, status, createdAt ?? null],
    );
  }

  /** A minimal valid ExternalExecutionPackage (the dispatch artifact). */
  function fixturePackage(executionId: string, provider: string): ExternalExecutionPackage {
    return {
      executionId,
      mode: 'external',
      projectId,
      workItemId,
      workItemLabel: 'WORK-W043-001',
      workOrderId,
      implementationContextId: contextId,
      provider,
      model: `${provider}-model`,
      repository: { owner: null, name: null, url: null, defaultBranch: null },
      branch: 'feat/w043',
      prompt: `p-${executionId}`,
      structuredInstructions: [],
      verificationRequirements: [],
      expectedOutputs: [],
      browserTestRequirements: [],
      returnCallback: {
        eventsPath: `/api/executions/${executionId}/events`,
        eventTypes: ['started', 'progress', 'completed', 'failed'],
        auth: 'callback-token',
        note: 'fixture',
      },
      expiration: new Date(Date.now() + 60_000).toISOString(),
    };
  }

  /**
   * Insert an EXTERNAL-DISPATCHED execution: the package persisted through
   * the handoff_ready outcome write (the artifact written ONLY after
   * ExternalExecutionProvider.submit() succeeded).
   */
  async function insertExternalDispatch(provider: string): Promise<{ id: string; executionId: string }> {
    const record = await insertExecution(provider, 'external');
    await executionRecordRepo.updateStatus(record.id, {
      status: 'handoff_ready',
      packageValue: fixturePackage(record.executionId, provider),
      expiresAt: new Date(Date.now() + 60_000),
    });
    return record;
  }

  /**
   * Insert the append-only cross-mode handoff LOG row — the exact shape the
   * handoff service writes at reservation time (wfos_execution_mode_handoffs;
   * UNIQUE(execution_record_id) + UNIQUE(idempotency_key); immutable).
   */
  async function insertHandoffLogRow(
    executionRowId: string,
    opts: {
      fromMode: 'native' | 'external';
      toMode: 'native' | 'external';
      previousStatus: string;
      resultingStatus: string;
      previousPackage: ExternalExecutionPackage | null;
    },
  ): Promise<void> {
    await stack.db.client.query(
      `INSERT INTO wfos_execution_mode_handoffs
         (execution_record_id, from_mode, to_mode, reason, actor, source,
          previous_status, resulting_status, previous_agent_run_id,
          previous_external_session_ref, previous_package_json, authorized,
          policy_decision, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        executionRowId, opts.fromMode, opts.toMode, 'fixture', 'test', 'api',
        opts.previousStatus, opts.resultingStatus, null, null,
        opts.previousPackage ? JSON.stringify(opts.previousPackage) : null,
        true, null, `fixture-handoff-${++execCount}`,
      ],
    );
  }

  /**
   * Insert a CROSS-MODE HANDED-OFF execution (native -> external): the full
   * durable end state of the WORK-042 flow — the native phase's AgentRun
   * ledger row (dispatch 1, attributed to `fromProvider`), the append-only
   * handoff log row (native→external), the transitionMode mutate
   * (mode=external + provider=`toProvider`), and the external phase's
   * package outcome write (dispatch 2, attributed to `toProvider` — the
   * package is self-describing). TWO provider dispatches, TWO providers.
   */
  async function insertNativeToExternalHandoff(
    fromProvider = 'fake',
    toProvider = 'external-coder',
  ): Promise<{ id: string; executionId: string }> {
    const record = await insertExecution(fromProvider, 'native');
    await insertRunRow(record.executionId, fromProvider, 'failed');
    await insertHandoffLogRow(record.id, {
      fromMode: 'native',
      toMode: 'external',
      previousStatus: 'failed',
      resultingStatus: 'handoff_ready',
      previousPackage: null,
    });
    const mutated = await executionRecordRepo.transitionMode(record.id, {
      mode: 'external',
      status: 'handoff_ready',
      provider: toProvider,
      model: `${toProvider}-model`,
    });
    expect(mutated).not.toBeNull();
    await executionRecordRepo.updateStatus(record.id, {
      status: 'handoff_ready',
      packageValue: fixturePackage(record.executionId, toProvider),
      expiresAt: new Date(Date.now() + 60_000),
    });
    return record;
  }

  /**
   * Insert a CROSS-MODE HANDED-OFF execution (external -> native): the full
   * durable end state — the external phase's direct dispatch (the package
   * on the row), the append-only handoff log row (external→native) whose
   * previous_package_json snapshots the external package, the
   * transitionMode mutate (mode=native + provider=`toProvider` — COALESCE
   * RETAINS the external package on the row), and the native phase's
   * AgentRun ledger row (provider=`toProvider`). The external dispatch is
   * attributed through the LOG SNAPSHOT (the row's retained package
   * belongs to a handed-off-away phase — mode='native' excludes it from
   * the current-phase arm).
   */
  async function insertExternalToNativeHandoff(
    fromProvider = 'external-coder',
    toProvider = 'fake',
  ): Promise<{ id: string; executionId: string }> {
    const record = await insertExecution(fromProvider, 'external');
    const pkg = fixturePackage(record.executionId, fromProvider);
    await executionRecordRepo.updateStatus(record.id, {
      status: 'handoff_ready',
      packageValue: pkg,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await insertHandoffLogRow(record.id, {
      fromMode: 'external',
      toMode: 'native',
      previousStatus: 'handoff_ready',
      resultingStatus: 'running',
      previousPackage: pkg,
    });
    const mutated = await executionRecordRepo.transitionMode(record.id, {
      mode: 'native',
      status: 'running',
      provider: toProvider,
      model: `${toProvider}-model`,
    });
    expect(mutated).not.toBeNull();
    await insertRunRow(record.executionId, toProvider, 'in_progress');
    return record;
  }

  /**
   * Insert a BACK-DATED external dispatch: an execution row created at
   * 2000-01-01 (outside every modern window) carrying the package artifact
   * — the direct external path's dispatch is anchored at the row's creation
   * (the row is created immediately before the synchronous submit).
   */
  async function insertOldExternalDispatch(provider: string): Promise<string> {
    const executionId = `wf-w043-${++execCount}`;
    await stack.db.client.query(
      `INSERT INTO wfos_executions
         (execution_id, project_id, work_item_id, work_order_id, implementation_context_id,
          mode, provider, model, status, prompt, prompt_digest, package_json, created_at)
       VALUES ($1, $2, $3, $4, $5, 'external', $6, $7, 'handoff_ready', $8, $9, $10, '2000-01-01T00:00:00Z')`,
      [
        executionId, projectId, workItemId, workOrderId, contextId,
        provider, `${provider}-model`, `p-${executionId}`, `d-${executionId}`,
        JSON.stringify(fixturePackage(executionId, provider)),
      ],
    );
    return executionId;
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
  // 3a. usage derivation — NON-DISPATCHED records never count (AR-043-01)
  //     (runs FIRST: the dispatched-records describes below accumulate on
  //     these rows — the clean-zero proofs need an empty dispatched state)
  // -------------------------------------------------------------------------
  describe('usage derivation — non-dispatched records never count (AR-043-01)', () => {
    // The trailing window covering every fixture (the rate-limit shape).
    const ancient = new Date(Date.UTC(2000, 0, 1));

    it('a created execution WITHOUT dispatch → NOT counted (either mode, either model)', async () => {
      // The records exist — but existence is not dispatch: no AgentRun
      // ledger row, no persisted package. They must NOT consume quota or
      // window capacity (the pre-fix defect counted them).
      await insertExecution('fake', 'native');
      await insertExecution('external-coder', 'external');

      const quota = await repository.countProjectDispatchedExecutionsSince(projectId, ancient);
      expect(quota).toBe(0);
      const fakeWindow = await repository.countProjectProviderDispatchesSince(projectId, 'fake', ancient);
      expect(fakeWindow).toBe(0);
      const externalWindow = await repository.countProjectProviderDispatchesSince(projectId, 'external-coder', ancient);
      expect(externalWindow).toBe(0);
    });

    it('rejected before dispatch → NOT counted (the provider-submit failure shape)', async () => {
      // status 'failed' with failureStage 'provider-submit' — the attempt
      // died BEFORE the provider boundary (no run row / no package was ever
      // written). A failure that never reached the provider is not a
      // dispatch and must not count against either usage model.
      const native = await insertExecution('fake', 'native');
      await rejectBeforeDispatch(native.id);
      const external = await insertExecution('external-coder', 'external');
      await rejectBeforeDispatch(external.id);

      const quota = await repository.countProjectDispatchedExecutionsSince(projectId, ancient);
      expect(quota).toBe(0);
      const fakeWindow = await repository.countProjectProviderDispatchesSince(projectId, 'fake', ancient);
      expect(fakeWindow).toBe(0);
      const externalWindow = await repository.countProjectProviderDispatchesSince(projectId, 'external-coder', ancient);
      expect(externalWindow).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // 3b. AR-043-02 — per-provider dispatch accounting for cross-mode
  //     handoffs: the MINIMAL scenario, proven end-to-end (the architect's
  //     four-line table). Runs before the accumulation describes so the
  //     project carries exactly ONE dispatched execution: the handed-off
  //     record itself.
  // -------------------------------------------------------------------------
  describe('AR-043-02 — cross-mode per-provider dispatch accounting (the minimal scenario, end-to-end)', () => {
    const ancient = new Date(Date.UTC(2000, 0, 1));

    it('native A dispatch + external B handoff → A window = 1, B window = 1 — and BOTH providers are blocked at limit 1', async () => {
      // The handed-off execution dispatched TWICE — natively to A ('fake')
      // and externally to B ('external-coder'). The row's current provider
      // is B; the pre-fix defect counted the ROW once and attributed it
      // ONLY to B, leaving A's window understated (AR-043-02).
      await insertNativeToExternalHandoff('fake', 'external-coder');

      // The architect's table, lines 1-2: each ACTUAL dispatch lands in the
      // window of the provider that dispatched it.
      const fakeWindow = await repository.countProjectProviderDispatchesSince(projectId, 'fake', ancient);
      expect(fakeWindow).toBe(1);
      const externalWindow = await repository.countProjectProviderDispatchesSince(projectId, 'external-coder', ancient);
      expect(externalWindow).toBe(1);

      // The table's blocked lines: with limit 1, each provider's NEXT
      // dispatch is blocked (used >= max) — A because its window already
      // holds the native dispatch, B because its window already holds the
      // external dispatch. BOTH candidates rate_limited, BEFORE ranking.
      await service.updateProjectPolicy(projectId, {
        rateLimitMaxRequests: 1,
        rateLimitWindowSeconds: 3_600,
      });
      const recommendation = await service.recommend({
        organizationId, projectId, workItemId, userId,
      });
      expect(recommendation.eligibleCandidates).toEqual([]);
      expect(recommendation.recommendedCandidate).toBeNull();
      for (const provider of ['fake', 'external-coder']) {
        const excluded = recommendation.excludedCandidates.find((c) => c.provider === provider);
        expect(excluded, `${provider} must be excluded`).toBeDefined();
        expect(excluded!.eligibility.eligible).toBe(false);
        expect(excluded!.eligibility.status).toBe('rate_limited');
        expect(excluded!.eligibility.blockingReasons.some((b) => b.constraint === 'rate_limit_window_exhausted')).toBe(true);
      }
      await service.updateProjectPolicy(projectId, {
        rateLimitMaxRequests: null,
        rateLimitWindowSeconds: null,
      });
    });

    it('the same handed-off execution is ONE logical execution → ONE unit of quota', async () => {
      // QUOTA's unit is the LOGICAL EXECUTION (max_executions_per_month/
      // day): the two dispatch phases consume ONE quota unit together —
      // the QUOTA and RATE-LIMIT usage models are DISTINCT (AR-043-02).
      const quota = await repository.countProjectDispatchedExecutionsSince(projectId, ancient);
      expect(quota).toBe(1); // NOT 2 — one logical execution
    });
  });

  // -------------------------------------------------------------------------
  // 3c. usage derivation — dispatched records: LOGICAL EXECUTIONS (quota)
  //     vs PROVIDER DISPATCH EVENTS (rate). Accumulates on the records
  //     created above (the suite convention — documented running totals).
  // -------------------------------------------------------------------------
  describe('usage derivation — dispatched records: logical executions (quota) vs provider dispatch events (rate)', () => {
    const ancient = new Date(Date.UTC(2000, 0, 1));
    // A recent trailing window (the rate-limit shape) — every fixture below
    // is created NOW except the explicit back-dated window-edge ones.
    const recent = new Date(Date.now() - 60_000);

    it('an actual NATIVE dispatch → one provider dispatch event (the AgentRun ledger row; a FAILED run still dispatched)', async () => {
      // The gateway creates the run row BEFORE the adapter invocation —
      // one dispatch succeeded, one FAILED AT THE PROVIDER. Both initiated
      // the provider operation; both consume provider capacity; both count
      // in 'fake''s window. Quota grows by TWO logical executions.
      await insertNativeDispatch('fake', 'success');
      await insertNativeDispatch('fake', 'failed');

      const quota = await repository.countProjectDispatchedExecutionsSince(projectId, ancient);
      expect(quota).toBe(3); // 1 handed-off + 2 native
      const fakeWindow = await repository.countProjectProviderDispatchesSince(projectId, 'fake', ancient);
      expect(fakeWindow).toBe(3); // 1 handoff native phase + 2 native dispatches
      const externalWindow = await repository.countProjectProviderDispatchesSince(projectId, 'external-coder', ancient);
      expect(externalWindow).toBe(1); // only the handoff's external phase
    });

    it('an actual EXTERNAL dispatch → one provider dispatch event (the persisted package artifact)', async () => {
      await insertExternalDispatch('external-coder');

      const quota = await repository.countProjectDispatchedExecutionsSince(projectId, ancient);
      expect(quota).toBe(4);
      const externalWindow = await repository.countProjectProviderDispatchesSince(projectId, 'external-coder', ancient);
      expect(externalWindow).toBe(2);
      const fakeWindow = await repository.countProjectProviderDispatchesSince(projectId, 'fake', ancient);
      expect(fakeWindow).toBe(3);
    });

    it('REVERSE cross-mode handoff (external B → native A): the external dispatch is attributed through the log snapshot, counted EXACTLY ONCE', async () => {
      // The external phase's package is RETAINED on the row (transitionMode
      // COALESCE) but the row's mode is now 'native' — the current-phase
      // arm must SKIP it and the handed-off-away arm must count it from the
      // append-only log's previous_package_json: exactly one event for
      // 'external-coder' (never two), plus one native event for 'fake'.
      await insertExternalToNativeHandoff('external-coder', 'fake');

      const quota = await repository.countProjectDispatchedExecutionsSince(projectId, ancient);
      expect(quota).toBe(5); // ONE logical execution — not 2
      const externalWindow = await repository.countProjectProviderDispatchesSince(projectId, 'external-coder', ancient);
      expect(externalWindow).toBe(3); // EXACTLY ONCE via the log snapshot
      const fakeWindow = await repository.countProjectProviderDispatchesSince(projectId, 'fake', ancient);
      expect(fakeWindow).toBe(4);
    });

    it('a dispatch event falls out of the window by ITS OWN event time (native: the run row creation — not the execution row creation)', async () => {
      // The execution row is created NOW, but its AgentRun ledger row is
      // back-dated to 2000: the dispatch EVENT happened then, so a recent
      // window excludes it while an ancient window includes it. (The quota
      // still counts the logical execution — the row was created this
      // period and it dispatched.)
      await insertNativeDispatch('fake', 'success', new Date(Date.UTC(2000, 0, 1)));

      const quotaThisMonth = await repository.countProjectDispatchedExecutionsSince(projectId, recent);
      expect(quotaThisMonth).toBe(6);
      const fakeRecent = await repository.countProjectProviderDispatchesSince(projectId, 'fake', recent);
      expect(fakeRecent).toBe(4); // the back-dated run is OUTSIDE
      const fakeAncient = await repository.countProjectProviderDispatchesSince(projectId, 'fake', ancient);
      expect(fakeAncient).toBe(5); // the event exists — its OWN time gates it
    });

    it('a back-dated external dispatch (direct path) also falls out of the window by its own event time (the row creation)', async () => {
      // The direct external path anchors its dispatch at the row's creation
      // (created immediately before the synchronous submit): a row created
      // in 2000 carrying the package is outside every modern window.
      await insertOldExternalDispatch('external-coder');

      const externalRecent = await repository.countProjectProviderDispatchesSince(projectId, 'external-coder', recent);
      expect(externalRecent).toBe(3);
      const externalAncient = await repository.countProjectProviderDispatchesSince(projectId, 'external-coder', ancient);
      expect(externalAncient).toBe(4);
      // The quota period (this month) excludes it too — created in 2000.
      const quotaThisMonth = await repository.countProjectDispatchedExecutionsSince(projectId, recent);
      expect(quotaThisMonth).toBe(6);
    });

    it('the usage is tenant-scoped (another project counts 0 in both models)', async () => {
      const otherProject = '00000000-0000-0000-0000-000000000000';
      const quota = await repository.countProjectDispatchedExecutionsSince(otherProject, ancient);
      expect(quota).toBe(0);
      const fakeWindow = await repository.countProjectProviderDispatchesSince(otherProject, 'fake', ancient);
      expect(fakeWindow).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // 4. the recommendation path — the pre-ranking hard filter end-to-end
  // -------------------------------------------------------------------------
  describe('recommend() — the pre-ranking hard filter (end-to-end)', () => {
    // The INTERACTIVE recommendation path keeps §5 semantics (an unknown
    // subscription blocks) — the access profiles were upserted in the
    // outer beforeAll (the user configured them — exactly what the
    // WORK-033 regression suite models).

    it('an exhausted monthly quota EXCLUDES every candidate with the structured quota_exhausted reason', async () => {
      // Quota 5, usage 6 — the SIX DISPATCHED LOGICAL EXECUTIONS above (the
      // non-dispatched records — created or rejected-before-dispatch — and
      // the back-dated 2000 row never count; each cross-mode handed-off
      // record is ONE logical execution despite its two dispatch phases).
      await service.updateProjectPolicy(projectId, { maxExecutionsPerMonth: 5 });
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
      // Raising the quota re-admits the candidates (usage 6 < 10).
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
      // 4 DISPATCH EVENTS on 'fake' in the window (its two native
      // dispatches + the native phase of EACH cross-mode handoff) and 3 on
      // 'external-coder' (its direct dispatch + the external phase of EACH
      // handoff) — the two handed-off records contribute to BOTH
      // providers' windows (AR-043-02: each actual dispatch attributed to
      // the provider that dispatched it). Limit 4 → 'fake' (4 >= 4)
      // excluded, 'external-coder' (3 < 4) eligible. The back-dated events
      // and the non-dispatched records consume no window capacity —
      // counting them was the AR-043-01 defect.
      await service.updateProjectPolicy(projectId, {
        rateLimitMaxRequests: 4,
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
