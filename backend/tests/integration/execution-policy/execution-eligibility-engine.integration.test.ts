/**
 * WORK-043 (§33.3) — Execution Eligibility and Constraint Engine PG
 * integration tests.
 *
 * Real-PostgreSQL tests of the constraint-engine persistence + orchestration
 * layer (the mode-constraint-validation pattern: buildAuthStack + the real
 * PgExecutionPolicyRepository + the real DefaultExecutionEligibilityService
 * + the real DefaultExecutionPolicyService with stubbed non-policy deps):
 *
 *   1. migration 0051 — the new policy columns + the DB CHECK backstops
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
      // AR-043-04 (round 4): the REAL project→organization authority (the
      // same adapter the composition root wires — wfos_projects.organization_
      // id via the projects repository). The single-candidate seam resolves
      // the organization scope SERVER-SIDE; no caller supplies it.
      projectOrganizationResolver: {
        resolveProjectOrganization: async (pid: string) => {
          const project = await stack.projectRepository.findById(pid);
          return project?.organizationId ?? null;
        },
      },
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

  /**
   * A minimal valid ExternalExecutionPackage (the dispatch artifact). The
   * `dispatchedAt` (the AR-043-03 AUTHORITATIVE dispatch-event timestamp) is
   * parameterizable so the window-boundary proofs can place the DISPATCH
   * independently of every reservation timestamp — it defaults to NOW.
   */
  function fixturePackage(executionId: string, provider: string, dispatchedAt: Date = new Date()): ExternalExecutionPackage {
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
      dispatchedAt: dispatchedAt.toISOString(),
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
      /**
       * AR-043-03: back-date the handoff-log row's creation — the
       * RESERVATION timestamp. The real flow can sit between the reserve
       * and the actual external dispatch for an arbitrary scheduling gap;
       * the window must gate on the package's dispatchedAt, never here.
       */
      reservedAt?: Date;
    },
  ): Promise<void> {
    await stack.db.client.query(
      `INSERT INTO wfos_execution_mode_handoffs
         (execution_record_id, from_mode, to_mode, reason, actor, source,
          previous_status, resulting_status, previous_agent_run_id,
          previous_external_session_ref, previous_package_json, authorized,
          policy_decision, idempotency_key, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, COALESCE($15, NOW()))`,
      [
        executionRowId, opts.fromMode, opts.toMode, 'fixture', 'test', 'api',
        opts.previousStatus, opts.resultingStatus, null, null,
        opts.previousPackage ? JSON.stringify(opts.previousPackage) : null,
        true, null, `fixture-handoff-${++execCount}`,
        opts.reservedAt ?? null,
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
   *
   * AR-043-03: `opts` places the ENTIRE pre-dispatch history (the execution
   * row creation, the native run row, the handoff-log reservation) at
   * `reservedAt` while the external package's dispatchedAt stays NOW — the
   * architect's problematic sequence (reserve → wait/scheduling gap →
   * submit → package persisted), with the dispatch the only recent event.
   */
  async function insertNativeToExternalHandoff(
    fromProvider = 'fake',
    toProvider = 'external-coder',
    opts: { reservedAt?: Date } = {},
  ): Promise<{ id: string; executionId: string }> {
    const record = await insertExecution(fromProvider, 'native');
    await insertRunRow(record.executionId, fromProvider, 'failed', opts.reservedAt);
    await insertHandoffLogRow(record.id, {
      fromMode: 'native',
      toMode: 'external',
      previousStatus: 'failed',
      resultingStatus: 'handoff_ready',
      previousPackage: null,
      reservedAt: opts.reservedAt,
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
   *
   * AR-043-03: `opts` places the execution row's creation (the reservation)
   * at `rowCreatedAt` independently of the package's dispatchedAt — the
   * snapshot must carry the dispatch's OWN timestamp, never the row's.
   */
  async function insertExternalToNativeHandoff(
    fromProvider = 'external-coder',
    toProvider = 'fake',
    opts: { rowCreatedAt?: Date; dispatchedAt?: Date } = {},
  ): Promise<{ id: string; executionId: string }> {
    const record = await insertExecution(fromProvider, 'external');
    if (opts.rowCreatedAt) {
      await stack.db.client.query(
        `UPDATE wfos_executions SET created_at = $2 WHERE id = $1`,
        [record.id, opts.rowCreatedAt],
      );
    }
    const pkg = fixturePackage(record.executionId, fromProvider, opts.dispatchedAt);
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
   * AR-043-03 — insert a DIRECT-PATH external dispatch with FULLY
   * CONTROLLED times: the execution row's creation (the reservation) AND
   * the package's dispatchedAt (the authoritative dispatch event) are set
   * INDEPENDENTLY, so the window-boundary proofs can straddle them in both
   * directions (a recent dispatch on an old reservation; an old dispatch on
   * a recent reservation).
   */
  async function insertExternalDispatchAt(
    provider: string,
    opts: { rowCreatedAt: Date; dispatchedAt: Date },
  ): Promise<string> {
    const executionId = `wf-w043-${++execCount}`;
    await stack.db.client.query(
      `INSERT INTO wfos_executions
         (execution_id, project_id, work_item_id, work_order_id, implementation_context_id,
          mode, provider, model, status, prompt, prompt_digest, package_json, created_at)
       VALUES ($1, $2, $3, $4, $5, 'external', $6, $7, 'handoff_ready', $8, $9, $10, $11)`,
      [
        executionId, projectId, workItemId, workOrderId, contextId,
        provider, `${provider}-model`, `p-${executionId}`, `d-${executionId}`,
        JSON.stringify(fixturePackage(executionId, provider, opts.dispatchedAt)),
        opts.rowCreatedAt,
      ],
    );
    return executionId;
  }

  // -------------------------------------------------------------------------
  // 1. migration 0051 — the columns + the DB CHECK backstops
  // -------------------------------------------------------------------------
  describe('migration 0051 — policy columns + CHECK backstops', () => {
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

    it('an EXTERNAL dispatch event is gated by the package\'s OWN dispatchedAt — NEVER the row creation (AR-043-03, both boundary directions)', async () => {
      // The architect's boundary case, direction 1: "dispatch happened 10
      // seconds ago but reservation/execution timestamp = 2 minutes ago →
      // incorrectly excluded". The execution row (the reservation) is
      // created in 2000, but the package's dispatchedAt — the AUTHORITATIVE
      // dispatch-event timestamp — is NOW: the recent window MUST count the
      // dispatch (the pre-fix query gated on e.created_at and dropped it).
      await insertExternalDispatchAt('external-coder', {
        rowCreatedAt: new Date(Date.UTC(2000, 0, 1)),
        dispatchedAt: new Date(),
      });
      // Direction 2 (the inverse): the execution row is created NOW, but the
      // dispatch actually happened in 2000 — the recent window must EXCLUDE
      // it (the pre-fix query gated on e.created_at and admitted it).
      await insertExternalDispatchAt('external-coder', {
        rowCreatedAt: new Date(),
        dispatchedAt: new Date(Date.UTC(2000, 0, 1)),
      });

      const externalRecent = await repository.countProjectProviderDispatchesSince(projectId, 'external-coder', recent);
      expect(externalRecent).toBe(4); // ONLY the dispatch at NOW — direction 1 in, direction 2 out
      const externalAncient = await repository.countProjectProviderDispatchesSince(projectId, 'external-coder', ancient);
      expect(externalAncient).toBe(5); // both dispatch events exist — each gated by its OWN time
      // The QUOTA (a different unit) still gates on the ROW creation: only
      // the NOW-created row is inside the recent quota period (the 2000 row
      // is outside it), regardless of either dispatch time.
      const quotaRecent = await repository.countProjectDispatchedExecutionsSince(projectId, recent);
      expect(quotaRecent).toBe(7);
      const quotaAncient = await repository.countProjectDispatchedExecutionsSince(projectId, ancient);
      expect(quotaAncient).toBe(8);
    });

    it('a native->external handoff\'s external dispatch is gated by the package dispatchedAt — NEVER the handoff-log reservation (AR-043-03)', async () => {
      // The architect's problematic sequence:
      //   reserve handoff log → wait/scheduling gap → submit → package
      // persisted. The handoff log row (the RESERVATION) is back-dated to
      // 2000, the native phase's run row with it — but the external
      // dispatch JUST happened (dispatchedAt NOW). The current-phase arm
      // MUST count it in the recent window (the pre-fix query gated on
      // COALESCE(h.created_at, e.created_at) — the reservation — and
      // excluded a 10-seconds-ago dispatch as a 2000 reservation).
      await insertNativeToExternalHandoff('fake', 'external-coder', {
        reservedAt: new Date(Date.UTC(2000, 0, 1)),
      });

      const externalRecent = await repository.countProjectProviderDispatchesSince(projectId, 'external-coder', recent);
      expect(externalRecent).toBe(5); // the recent DISPATCH is IN — despite the 2000 reservation
      const externalAncient = await repository.countProjectProviderDispatchesSince(projectId, 'external-coder', ancient);
      expect(externalAncient).toBe(6); // exactly one event for the handed-off external phase
      // The native phase's OWN event time (its run row, back-dated to 2000
      // with the reservation) gates its window independently.
      const fakeRecent = await repository.countProjectProviderDispatchesSince(projectId, 'fake', recent);
      expect(fakeRecent).toBe(4); // the 2000 native dispatch is OUTSIDE
      const fakeAncient = await repository.countProjectProviderDispatchesSince(projectId, 'fake', ancient);
      expect(fakeAncient).toBe(6); // the 2000 native event exists — its OWN time gates it
    });

    it('the reverse-handoff SNAPSHOT preserves dispatchedAt — the handed-off-away external dispatch is gated by the SNAPSHOT\'s OWN timestamp (AR-043-03)', async () => {
      // An execution row created in 2000 (the reservation), whose external
      // dispatch happened NOW (dispatchedAt NOW), then handed off to native:
      // the append-only log's previous_package_json snapshot PRESERVES the
      // package — dispatchedAt included. The handed-off-away arm MUST gate
      // on that SNAPSHOT timestamp (the pre-fix query gated on e.created_at
      // — attributing the dispatch to the 2000 reservation and excluding a
      // just-made dispatch from the window).
      await insertExternalToNativeHandoff('external-coder', 'fake', {
        rowCreatedAt: new Date(Date.UTC(2000, 0, 1)),
        dispatchedAt: new Date(),
      });

      const externalRecent = await repository.countProjectProviderDispatchesSince(projectId, 'external-coder', recent);
      expect(externalRecent).toBe(6); // the snapshot's dispatchedAt gates it IN
      const externalAncient = await repository.countProjectProviderDispatchesSince(projectId, 'external-coder', ancient);
      expect(externalAncient).toBe(7); // EXACTLY ONCE — never twice from the retained row package
      // The native phase dispatched NOW → its own event is in the window.
      const fakeRecent = await repository.countProjectProviderDispatchesSince(projectId, 'fake', recent);
      expect(fakeRecent).toBe(5);
      const fakeAncient = await repository.countProjectProviderDispatchesSince(projectId, 'fake', ancient);
      expect(fakeAncient).toBe(7);
      // The 2000-created row never enters the recent quota period (the
      // NOW-created rows from the boundary tests above keep it at 8).
      const quotaRecent = await repository.countProjectDispatchedExecutionsSince(projectId, recent);
      expect(quotaRecent).toBe(8);
    });

    it('the reverse-handoff SNAPSHOT\'s OLD dispatchedAt EXCLUDES the event — NEVER the recent handoff reservation (AR-043-03, the inverse boundary)', async () => {
      // The architect's boundary line, direction 2, on the SNAPSHOT arm:
      // "reservation now + dispatch old → excluded". An external dispatch
      // made in 2000 whose external phase was handed off to native JUST NOW
      // (the handoff log row — the native phase's RESERVATION — is created
      // NOW, and the row's history is all 2000): the event must fall OUT of
      // the recent window by the SNAPSHOT's OWN dispatchedAt (2000) — never
      // be admitted by the recent handoff reservation. The SAME handoff's
      // native dispatch (made NOW) is counted at its OWN time — each event
      // of the logical execution gates the window independently.
      const nativeAlt = 'native-alt';
      await insertExternalToNativeHandoff('external-coder', nativeAlt, {
        rowCreatedAt: new Date(Date.UTC(2000, 0, 1)),
        dispatchedAt: new Date(Date.UTC(2000, 0, 1)),
        // the handoff log row (the reservation) defaults to NOW()
      });

      const externalRecent = await repository.countProjectProviderDispatchesSince(projectId, 'external-coder', recent);
      expect(externalRecent).toBe(6); // the 2000 dispatch is EXCLUDED — despite the NOW handoff reservation
      const externalAncient = await repository.countProjectProviderDispatchesSince(projectId, 'external-coder', ancient);
      expect(externalAncient).toBe(8); // the event exists — its OWN (old) time gates it OUT of the recent window
      // The same handoff's NATIVE dispatch happened NOW (a different
      // provider): counted at ITS OWN event time — the contrast proves each
      // dispatch of one logical execution is gated independently.
      const nativeAltRecent = await repository.countProjectProviderDispatchesSince(projectId, nativeAlt, recent);
      expect(nativeAltRecent).toBe(1);
      const nativeAltAncient = await repository.countProjectProviderDispatchesSince(projectId, nativeAlt, ancient);
      expect(nativeAltAncient).toBe(1);
      // The 2000-created row never enters the recent quota period (its unit
      // is the LOGICAL EXECUTION, gated by the row creation — one unit, and
      // only inside the ancient period).
      const quotaRecent = await repository.countProjectDispatchedExecutionsSince(projectId, recent);
      expect(quotaRecent).toBe(8);
      const quotaAncient = await repository.countProjectDispatchedExecutionsSince(projectId, ancient);
      expect(quotaAncient).toBe(11);
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
      // Quota 5, usage 8 — the EIGHT DISPATCHED LOGICAL EXECUTIONS created
      // this period (the non-dispatched records — created or rejected-before-
      // dispatch — never count, and the two 2000-created boundary rows from
      // the AR-043-03 proofs fall outside the month; each cross-mode handed-
      // off record is ONE logical execution despite its two dispatch phases).
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
      // Raising the quota re-admits the candidates (usage 8 < 10).
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
      // 6 DISPATCH EVENTS on 'external-coder' in the window (its direct
      // dispatch + the external phase of EACH cross-mode handoff + the
      // AR-043-03 boundary dispatches gated by their OWN dispatchedAt — the
      // 2000-dispatch boundary row is OUTSIDE) and 5 on 'fake' (its two
      // native dispatches + the native phase of each handoff — the two
      // back-dated 2000 run rows are OUTSIDE by their OWN event times).
      // Limit 6 → 'external-coder' (6 >= 6) excluded, 'fake' (5 < 6)
      // eligible. Every event is gated by ITS OWN authoritative dispatch
      // timestamp (AR-043-03) — never a reservation timestamp.
      await service.updateProjectPolicy(projectId, {
        rateLimitMaxRequests: 6,
        rateLimitWindowSeconds: 3_600,
      });
      const recommendation = await service.recommend({ organizationId, projectId, workItemId, userId });
      const external = recommendation.excludedCandidates.find((c) => c.provider === 'external-coder');
      expect(external).toBeDefined();
      expect(external!.eligibility.status).toBe('rate_limited');
      expect(external!.eligibility.blockingReasons.some((b) => b.constraint === 'rate_limit_window_exhausted')).toBe(true);
      const fake = recommendation.eligibleCandidates.find((c) => c.provider === 'fake');
      expect(fake).toBeDefined();
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
        // AR-043-04: NO organizationId — the seam resolves the org scope
        // server-side from the project authority.
        projectId, workItemId,
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
      // WORK-043 remediation: the organization scope is REQUIRED + resolved
      // authoritatively; with no agent-policy gate wired for this suite the
      // family's default verdict is 'allow' (the handoff's own per-execution
      // gate remains the stricter external-domain enforcer).
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

  // -------------------------------------------------------------------------
  // PR #48 round 4 — AR-043-03 (the READ-ONLY seam) + AR-043-04 (the
  // SERVER-SIDE organization scope). Two new projects are provisioned per
  // test (a policy-LESS project for the read-only proof; a two-org pair for
  // the scope proof) — no cross-test usage pollution.
  // -------------------------------------------------------------------------
  describe('PR #48 round 4 — AR-043-03: the eligibility seam is READ-ONLY', () => {
    it('an eligibility evaluation against a policy-LESS project creates NO policy row (zero rows, version state untouched) — the in-memory default mirror', async () => {
      const fresh = await stack.projectRepository.create({
        organizationId,
        name: 'W043 R4 Read-Only Project',
      });
      // BEFORE: no policy row exists for the fresh project.
      expect(await repository.getProjectPolicy(fresh.id)).toBeNull();

      // The evaluation runs (a real verdict — not a throw, not a skip)...
      const verdict = await service.evaluateCandidateEligibility({
        projectId: fresh.id, workItemId,
        provider: 'fake', model: 'fake-model', executionMode: 'native',
        userId,
      });
      // ...against the IN-MEMORY default mirror (the exact defaults
      // insertDefaultProjectPolicy would create — never persisted).
      expect(verdict.eligibility.eligible).toBe(true);
      expect(verdict.eligibility.status).toBe('eligible');
      expect(verdict.policyVersion).toBe(1);
      expect(verdict.constraints.quota.monthlyMaxExecutions).toBeNull();
      expect(verdict.constraints.security.projectClassification).toBe('standard');

      // AFTER: the policy authority is UNCHANGED — zero new policy row.
      expect(await repository.getProjectPolicy(fresh.id)).toBeNull();
      const rows = await stack.db.client.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM wfos_execution_policies WHERE project_id = $1`,
        [fresh.id],
      );
      expect(Number(rows.rows[0]!.c)).toBe(0);

      // Repeated evaluations stay read-only (no hidden lazy creation).
      await service.evaluateCandidateEligibility({
        projectId: fresh.id, workItemId,
        provider: 'fake', model: 'fake-model', executionMode: 'native',
        userId,
      });
      expect(await repository.getProjectPolicy(fresh.id)).toBeNull();

      // CONTRAST — the WRITE path still creates the row (the proof can tell
      // the difference): ensureProjectPolicy is the explicit policy creator.
      const created = await service.ensureProjectPolicy(organizationId, fresh.id);
      expect(created.projectId).toBe(fresh.id);
      expect(await repository.getProjectPolicy(fresh.id)).not.toBeNull();
    });

    it('an evaluation against a project WITH a policy leaves the row + policyVersion UNTOUCHED (no version bump, no updated_at touch)', async () => {
      // The main project carries a policy row by now (the recommendation
      // describe's default insert). Capture the authoritative state.
      const before = await repository.getProjectPolicy(projectId);
      expect(before).not.toBeNull();
      const beforeRow = await stack.db.client.query<{ updated_at: string }>(
        `SELECT updated_at FROM wfos_execution_policies WHERE project_id = $1`,
        [projectId],
      );

      const verdict = await service.evaluateCandidateEligibility({
        projectId, workItemId,
        provider: 'fake', model: 'fake-model', executionMode: 'native',
        userId,
      });
      expect(verdict.policyVersion).toBe(before!.policyVersion);

      const after = await repository.getProjectPolicy(projectId);
      expect(after!.policyVersion).toBe(before!.policyVersion);
      expect(after!.frozen).toBe(before!.frozen);
      const afterRow = await stack.db.client.query<{ updated_at: string }>(
        `SELECT updated_at FROM wfos_execution_policies WHERE project_id = $1`,
        [projectId],
      );
      // The touch trigger never fired — the row was not written at all.
      expect(new Date(afterRow.rows[0]!.updated_at).getTime()).toBe(
        new Date(beforeRow.rows[0]!.updated_at).getTime(),
      );
    });
  });

  describe('PR #48 round 4 — AR-043-04: the organization scope is resolved SERVER-SIDE (two-project/org)', () => {
    /** A second service instance with the ORG-scoped inputs wired. */
    function buildOrgScopedService(opts: {
      orgPolicyResolver?: { resolve(organizationId: string): Promise<unknown> };
      agentPolicyProjectGate?: object;
    }): DefaultExecutionPolicyService {
      return new DefaultExecutionPolicyService({
        db: stack.db.client,
        logger: stack.db.logger,
        repository,
        projectOrganizationResolver: {
          // The REAL project→organization authority (the app.ts adapter).
          resolveProjectOrganization: async (pid: string) => {
            const project = await stack.projectRepository.findById(pid);
            return project?.organizationId ?? null;
          },
        },
        eligibilityService: new DefaultExecutionEligibilityService(),
        recommendationService: new DefaultExecutionRecommendationService(),
        taskProfileBuilder: { build: () => Promise.resolve(TASK_PROFILE) },
        agentProviderRegistry: {
          getExecutionProviders: () => Promise.resolve([
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
            Promise.resolve({ sampleSize: 0, sufficient: false, observedQuality: null, ciFirstPassRate: null, verificationFirstPassRate: null, medianCorrectionCycles: null, medianTimeToVerifiedMs: null, humanInterventionCount: null, evidenceCells: [] }),
          aggregateForProject: () =>
            Promise.resolve({ sampleSize: 0, sufficient: false, observedQuality: null, ciFirstPassRate: null, verificationFirstPassRate: null, medianCorrectionCycles: null, medianTimeToVerifiedMs: null, humanInterventionCount: null, evidenceCells: [] }),
        },
        orgPolicyResolver: opts.orgPolicyResolver as never,
        agentPolicyProjectGate: opts.agentPolicyProjectGate as never,
      });
    }

    it('an ORG-SCOPED policy constraint makes the otherwise-resolved destination INELIGIBLE — the input carries NO organization id (the scope is derived from the project authority)', async () => {
      const orgA = await stack.organizationRepository.create({ name: 'W043 R4 Org A (constrained)' });
      const orgB = await stack.organizationRepository.create({ name: 'W043 R4 Org B (unconstrained)' });
      const projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'W043 R4 Project A' });
      const projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'W043 R4 Project B' });

      // The org-policy resolver constrains ONLY Org A: external-coder is not
      // org-approved there (approved_providers_only excludes it). Org B has
      // no org policy (empty = unconstrained).
      const svc = buildOrgScopedService({
        orgPolicyResolver: {
          resolve: async (orgId: string) =>
            orgId === orgA.id
              ? { allowedProviders: ['some-other-provider'], allowedExecutionModes: ['native', 'external'], externalExecutionAllowed: true, maximumCostCents: null, requiredPrivacyLevel: null }
              : { allowedProviders: [], allowedExecutionModes: ['native', 'external'], externalExecutionAllowed: true, maximumCostCents: null, requiredPrivacyLevel: null },
        },
      });

      // Project A (Org A): the external destination is INELIGIBLE through
      // the ORG-scoped family — no caller supplied the organization; the
      // scope came from wfos_projects.organization_id.
      const verdictA = await svc.evaluateCandidateEligibility({
        projectId: projectA.id, workItemId,
        provider: 'external-coder', model: null, executionMode: 'external',
        userId,
      });
      expect(verdictA.eligibility.eligible).toBe(false);
      expect(verdictA.eligibility.status).toBe('policy_blocked');
      expect(
        verdictA.eligibility.blockingReasons.some(
          (b) => b.category === 'organization' && b.constraint === 'approved_providers_only',
        ),
      ).toBe(true);

      // Project B (Org B — same provider, same mode, same input shape): the
      // destination is ELIGIBLE. The org scope is per-PROJECT authoritative.
      const verdictB = await svc.evaluateCandidateEligibility({
        projectId: projectB.id, workItemId,
        provider: 'external-coder', model: null, executionMode: 'external',
        userId,
      });
      expect(verdictB.eligibility.eligible).toBe(true);
    });

    it('the ORG-SCOPED agent-policy context is ACTIVE at the seam (an org-scoped deny blocks the external destination)', async () => {
      const orgA = await stack.organizationRepository.create({ name: 'W043 R4 Org A (agent-policy deny)' });
      const orgB = await stack.organizationRepository.create({ name: 'W043 R4 Org B (agent-policy allow)' });
      const projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'W043 R4 Project A (agent policy)' });
      const projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'W043 R4 Project B (agent policy)' });

      // The WORK-037 project-scoped external-domain gate — wired in
      // production (app.ts) to the AgentPolicyEngine. Deny for Org A only.
      const svc = buildOrgScopedService({
        agentPolicyProjectGate: {
          evaluateExternalForProject: async (input: { organizationId: string; projectId: string }) =>
            input.organizationId === orgA.id
              ? { decision: 'deny', reason: 'org-scoped agent policy denies external execution', policyVersion: 3, scopeSource: 'organization' }
              : { decision: 'allow', reason: null, policyVersion: 0, scopeSource: 'platform-default' },
        },
      });

      const verdictA = await svc.evaluateCandidateEligibility({
        projectId: projectA.id, workItemId,
        provider: 'external-coder', model: null, executionMode: 'external',
        userId,
      });
      expect(verdictA.eligibility.eligible).toBe(false);
      expect(verdictA.eligibility.status).toBe('agent_policy_blocked');
      expect(
        verdictA.eligibility.blockingReasons.some(
          (b) => b.category === 'agent_policy' && b.constraint === 'external_handoff_denied',
        ),
      ).toBe(true);

      const verdictB = await svc.evaluateCandidateEligibility({
        projectId: projectB.id, workItemId,
        provider: 'external-coder', model: null, executionMode: 'external',
        userId,
      });
      expect(verdictB.eligibility.eligible).toBe(true);
      expect(verdictB.constraints.agentPolicy.externalDecision).toBe('allow');
    });

    it('FAIL-CLOSED: an unresolvable organization scope (an unknown project) rejects the evaluation — the scope cannot be silently declared absent', async () => {
      await expect(
        service.evaluateCandidateEligibility({
          projectId: '00000000-0000-0000-0000-000000000000', workItemId,
          provider: 'external-coder', model: null, executionMode: 'external',
          userId,
        }),
      ).rejects.toThrow(/execution-policy-organization-scope-unresolvable/);
    });
  });
});
