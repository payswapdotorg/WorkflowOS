/**
 * PR #35 review fix #2 (regression): `POST /benchmarks/compare` authorizes
 * ALL trials, not just `trialIds[0]`.
 *
 * The previous implementation only checked `trialIds[0]`'s project + then
 * returned comparison data for every trial id — leaking cross-tenant trial
 * metadata when the caller mixed trials from different projects. The fix:
 *
 *   1. Load EVERY requested trial (reject missing → 404).
 *   2. Verify all trials share the same projectId + snapshotId
 *      (§27/§28/§29 equality invariants). If they span projects or
 *      snapshots → 403, NO project metadata returned.
 *   3. requireProjectAuthorization on the shared project.
 *   4. Perform the comparison.
 *
 * These regression tests prove the HTTP 403 path: User A submits
 * `[trialA(Project A), trialB(Project B)]` → 403 forbidden +
 * `reason='benchmark-comparison-trials-must-share-snapshot'` + NO project B
 * metadata in the response body.
 *
 * NOTE: this test uses a CUSTOM inline fixture (not `buildBenchmarkFixture`)
 * because `buildBenchmarkFixture` hardcodes `externalId: 'benchmark-user'`
 * for every call — the second call would reuse the same user. We need TWO
 * DISTINCT users (one per project) so the cross-tenant comparison is
 * meaningful (User A's API key cannot authorize Project B).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import {
  DefaultBenchmarkService,
  DefaultBenchmarkSnapshotService,
  DefaultBenchmarkIntegrityService,
  DefaultBenchmarkMetricCollector,
  DefaultBenchmarkTrialOrchestrator,
  DefaultBenchmarkExportService,
  DefaultBenchmarkRecommendationService,
  PgBenchmarkRepository,
  DeterministicNativeBenchmarkProvider,
  DeterministicExternalBenchmarkProvider,
  createBenchmarkTrialJobHandler,
} from '../../../src/benchmark/index.js';
import { InMemoryQueue, WorkerHost, buildHandlerRegistry } from '@platform/index.js';
import { buildServer } from '@api/server.js';
import { DefaultExecutionService } from '../../../src/modules/agents/internal/execution-service.js';
import { DefaultExecutionTaskService } from '../../../src/modules/work-items/internal/execution-task-service.js';
import { DefaultImplementationContextBuilder } from '../../../src/modules/work-items/internal/implementation-context-builder.js';
import { DefaultExecutionPromptBuilder } from '../../../src/modules/work-items/internal/execution-prompt-builder.js';
import { PgImplementationContextRepository } from '../../../src/modules/work-items/internal/pg-implementation-context-repository.js';
import { DefaultWorkflowEngine } from '../../../src/modules/workflows/internal/workflow-engine.js';
import { DefaultAuditService } from '../../../src/modules/audit/internal/audit-service.js';
import { PgAgentRunRepository } from '../../../src/modules/agents/internal/pg-agent-repository.js';
import {
  PgExecutionRecordRepository,
  PgExecutionEventRepository,
  PgExecutionHandoffRepository,
  PgExecutionCallbackRepository,
} from '../../../src/modules/agents/internal/pg-execution-repository.js';
import { DefaultExecutionHandoffService } from '../../../src/modules/agents/internal/execution-handoff-service.js';
import { DefaultExecutionCallbackService } from '../../../src/modules/agents/internal/execution-callback-service.js';
import { DefaultExecutionEventIngestionService } from '../../../src/modules/agents/internal/execution-event-ingestion-service.js';
import { FakeGitHubAdapter } from '../../../src/modules/github/internal/fake-github-adapter.js';
import { PgCiEvidenceIngestionRepository } from '../../../src/modules/github/internal/pg-ci-evidence-repository.js';
import { DefaultReviewService } from '../../../src/modules/reviews/internal/review-service.js';
import { DefaultAuthorizationService } from '../../../src/modules/auth/internal/authorization-service.js';
import { PgProjectGitHubRepositoryRepository } from '../../../src/modules/github/internal/pg-project-github-repository-repository.js';
import type { FastifyInstance } from 'fastify';
import type { BenchmarkService } from '../../../src/benchmark/index.js';

interface ProjectFixture {
  readonly userId: string;
  readonly projectId: string;
  readonly architectureVersionId: string;
  readonly workItemId: string;
  readonly apiKey: string;
}

async function buildProjectFixture(
  stack: TestAuthStack,
  opts: { apiKey: string; secretRef: string; externalId: string; label: string; projectName: string; workItemLabel: string },
): Promise<ProjectFixture> {
  const org = await stack.organizationRepository.create({ name: `Org ${opts.label}` });
  const user = await stack.userRepository.upsertByExternalId({
    externalId: opts.externalId,
    displayName: opts.label,
  });
  await stack.membershipRepository.assign({ userId: user.id, organizationId: org.id, roleId: 'owner' });
  const project = await stack.projectRepository.create({ organizationId: org.id, name: opts.projectName });
  await stack.projectAccessRepository.grant({ userId: user.id, projectId: project.id, roleId: 'owner' });
  await stack.apiKeyProvisioner.provision({
    keyId: `key-${opts.label}`,
    secretRef: opts.secretRef,
    externalId: opts.externalId,
    label: opts.label,
    rawKey: opts.apiKey,
  });

  const arch = await stack.architectureRepository.create({ projectId: project.id, name: `Arch ${opts.label}` });
  const version = await stack.architectureVersionRepository.create({
    architectureId: arch.id,
    contentInline: `# Architecture ${opts.label}`,
  });
  await stack.architectureVersionRepository.transitionState(version.id, 'frozen', user.id);
  const req = await stack.requirementRepository.create({
    architectureVersionId: version.id,
    requirementId: `REQ-${opts.label}-001`,
    title: 'Calculator adds',
    description: 'add(2,3)===5',
  });
  const crit = await stack.acceptanceCriterionRepository.create({
    requirementId: req.id,
    criterionId: `AC-${opts.label}-001`,
    description: 'add(2,3) returns 5',
    verificationExpectation: 'unit-test',
  });
  const workItem = await stack.workItemRepository.create({
    architectureVersionId: version.id,
    workItemId: `WORK-${opts.workItemLabel}-001`,
    title: 'Calculator addition',
    objective: 'Add a calculator.',
    scope: 'src/calc.ts',
    outOfScope: 'sub',
    metadata: { baseCommit: `${opts.label.toLowerCase()}-baseline-commit-000000000000000001` },
  });
  await stack.workItemRequirementRepository.associate(workItem.id, req.id);
  await stack.workItemCriterionRepository.associate(workItem.id, crit.id);
  await stack.workOrderRepository.create({
    workItemId: workItem.id,
    projectId: project.id,
    architectureVersionId: version.id,
    requirementIds: [req.id],
    criterionIds: [crit.id],
    scope: 'src/calc.ts',
    verificationRequirements: ['unit-test: add(2,3)===5'],
  });
  const projectGitHubRepositoryRepository = new PgProjectGitHubRepositoryRepository(stack.db.client);
  await projectGitHubRepositoryRepository.create({
    projectId: project.id,
    installationId: `inst-${opts.label}`,
    owner: `${opts.label.toLowerCase()}-org`,
    repository: `${opts.label.toLowerCase()}-repo`,
    defaultBranch: 'main',
    linkType: 'linked',
  });
  return {
    userId: user.id,
    projectId: project.id,
    architectureVersionId: version.id,
    workItemId: workItem.id,
    apiKey: opts.apiKey,
  };
}

describe('PR #35 fix #2 — compare authorization across tenants', () => {
  let stack: TestAuthStack;
  let fixtureA: ProjectFixture;
  let fixtureB: ProjectFixture;
  let benchmarkService: BenchmarkService;
  let server: FastifyInstance;
  let queue: InMemoryQueue;
  let worker: WorkerHost;

  const API_KEY_A = 'raw-key-compare-authz-a';
  const SECRET_REF_A = 'WFOS_TEST_KEY_COMPARE_AUTHZ_A';
  const API_KEY_B = 'raw-key-compare-authz-b';
  const SECRET_REF_B = 'WFOS_TEST_KEY_COMPARE_AUTHZ_B';

  // Trial ids filled in beforeAll (created by createExperiment).
  let trialAId: string;
  let trialBId: string;
  // Same-project/same-snapshot trials (happy path).
  let sameProjTrial1Id: string;
  let sameProjTrial2Id: string;
  // Same-project DIFFERENT-snapshot trials (different snapshot, same project).
  let diffSnapTrial1Id: string;
  let diffSnapTrial2Id: string;
  // A valid-but-nonexistent trial id (UUID format).
  const NONEXISTENT_TRIAL_ID = '00000000-0000-0000-0000-000000000000';

  beforeAll(async () => {
    process.env[SECRET_REF_A] = API_KEY_A;
    process.env[SECRET_REF_B] = API_KEY_B;
    stack = await buildAuthStack({ [SECRET_REF_A]: API_KEY_A, [SECRET_REF_B]: API_KEY_B });
    fixtureA = await buildProjectFixture(stack, {
      apiKey: API_KEY_A,
      secretRef: SECRET_REF_A,
      externalId: 'compare-authz-user-a',
      label: 'AuthzA',
      projectName: 'Project A',
      workItemLabel: 'AUTHZA',
    });
    fixtureB = await buildProjectFixture(stack, {
      apiKey: API_KEY_B,
      secretRef: SECRET_REF_B,
      externalId: 'compare-authz-user-b',
      label: 'AuthzB',
      projectName: 'Project B',
      workItemLabel: 'AUTHZB',
    });

    // --- wire benchmark service (shared across both projects) ---
    const db = stack.db.client;
    const logger = stack.db.logger;
    const auditService = new DefaultAuditService(db, logger);
    const authorizationService = new DefaultAuthorizationService(
      stack.membershipRepository,
      stack.rolePermissionRepository,
      stack.projectRepository,
      stack.projectAccessRepository,
    );
    const benchmarkRepository = new PgBenchmarkRepository(db);
    const projectGitHubRepositoryRepository = new PgProjectGitHubRepositoryRepository(db);
    const githubAdapter = new FakeGitHubAdapter();
    const implementationContextRepository = new PgImplementationContextRepository(db);
    const promptBuilder = new DefaultExecutionPromptBuilder();
    const implementationContextBuilder = new DefaultImplementationContextBuilder(
      stack.workItemRepository,
      stack.workOrderRepository,
      stack.workItemRequirementRepository,
      stack.workItemCriterionRepository,
      stack.workItemDependencyRepository,
      stack.requirementRepository,
      stack.acceptanceCriterionRepository,
      stack.architectureVersionRepository,
      stack.architectureRepository,
      implementationContextRepository,
      async () => null,
      async () => null,
      async () => [],
      async () => [],
    );
    const snapshotService = new DefaultBenchmarkSnapshotService({
      repository: benchmarkRepository,
      workItemRepository: stack.workItemRepository,
      workOrderRepository: stack.workOrderRepository,
      architectureVersionRepository: stack.architectureVersionRepository,
      architectureRepository: stack.architectureRepository,
      projectRepository: stack.projectRepository,
      implementationContextBuilder,
      contextRepository: implementationContextRepository,
      promptBuilder,
      projectGitHubRepositoryRepository,
      githubAdapter,
      logger: logger as never,
    });
    const integrityService = new DefaultBenchmarkIntegrityService({ repository: benchmarkRepository, logger: logger as never });
    const workflowEngine = new DefaultWorkflowEngine(db, logger);
    const reviewService = new DefaultReviewService(db, stack.workItemRepository, logger);
    const verificationService = {
      listRunsForWorkItem: async () => [],
      listEvidenceForRun: async () => [],
      listMappingsForRun: async () => [],
    } as never;
    const ciEvidenceIngestionRepository = new PgCiEvidenceIngestionRepository(db);
    const agentRunRepository = new PgAgentRunRepository(db);
    const metricCollector = new DefaultBenchmarkMetricCollector({
      repository: benchmarkRepository,
      workflowEngine,
      verificationService,
      reviewService,
      pullRequestAssociationRepository: stack.pullRequestAssociationRepository,
      ciEvidenceIngestionRepository,
      agentRunRepository,
      logger: logger as never,
    });
    const executionRecordRepository = new PgExecutionRecordRepository(db);
    const executionEventRepository = new PgExecutionEventRepository(db);
    const executionHandoffRepository = new PgExecutionHandoffRepository(db);
    const executionCallbackRepository = new PgExecutionCallbackRepository(db);
    const executionTaskService = new DefaultExecutionTaskService({
      workItemRepository: stack.workItemRepository,
      workOrderRepository: stack.workOrderRepository,
      architectureVersionRepository: stack.architectureVersionRepository,
      architectureRepository: stack.architectureRepository,
      implementationContextBuilder,
      contextRepository: implementationContextRepository,
      promptBuilder,
      logger: logger as never,
    });
    const executionHandoffService = new DefaultExecutionHandoffService({
      executionRecordRepository,
      handoffRepository: executionHandoffRepository,
      auditService,
      logger: logger as never,
    });
    void executionHandoffService;
    const executionCallbackService = new DefaultExecutionCallbackService({
      executionRecordRepository,
      callbackRepository: executionCallbackRepository,
      auditService,
      logger: logger as never,
    });
    void executionCallbackService;
    const executionEventIngestionService = new DefaultExecutionEventIngestionService({
      executionRecordRepository,
      eventRepository: executionEventRepository,
      auditService,
      logger: logger as never,
    });
    void executionEventIngestionService;
    const deterministicNativeProvider = new DeterministicNativeBenchmarkProvider({
      variant: 'perfect-first-pass',
      agentRunRepository,
    });
    const deterministicExternalProvider = new DeterministicExternalBenchmarkProvider({
      variant: 'perfect-first-pass',
    });
    const executionService = new DefaultExecutionService({
      executionRecordRepository,
      providers: [deterministicNativeProvider, deterministicExternalProvider],
      auditService,
      logger: logger as never,
    
  });
    const trialOrchestrator = new DefaultBenchmarkTrialOrchestrator({
      repository: benchmarkRepository,
      executionService,
      executionTaskService,
      agentRunRepository,
      workItemRepository: stack.workItemRepository,
      workOrderRepository: stack.workOrderRepository,
      workItemRequirementRepository: stack.workItemRequirementRepository,
      workItemCriterionRepository: stack.workItemCriterionRepository,
      workItemDependencyRepository: stack.workItemDependencyRepository,
      workflowEngine,
      projectGitHubRepositoryRepository,
      githubAdapter,
      logger: logger as never,
    });
    const exportService = new DefaultBenchmarkExportService({ repository: benchmarkRepository, logger: logger as never });
    const recommendationService = new DefaultBenchmarkRecommendationService({ repository: benchmarkRepository, logger: logger as never });
    queue = new InMemoryQueue();
    benchmarkService = new DefaultBenchmarkService({
      db,
      logger: logger as never,
      repository: benchmarkRepository,
      snapshotService,
      integrityService,
      metricCollector,
      trialOrchestrator,
      exportService,
      recommendationService,
      auditService,
      authorizationService,
      queue,
      executionRecordRepository,
      workflowEngine,
    });
    const handlers = buildHandlerRegistry([
      createBenchmarkTrialJobHandler(benchmarkService as never, logger as never),
    ]);
    worker = new WorkerHost(queue, handlers, logger as never, { pollIntervalMs: 5 });
    await worker.start();

    // --- build the Fastify server (just auth + benchmark routes) ---
    server = await buildServer({
      queue,
      logger: logger as never,
      auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
      benchmark: { authorizationService, benchmarkService },
    });
    await server.ready();

    // --- create snapshots + experiments in BOTH projects ---
    const snapA = await benchmarkService.createSnapshot({
      projectId: fixtureA.projectId,
      workItemId: fixtureA.workItemId,
      name: 'compare-authz-snap-a',
      actor: fixtureA.userId,
    });
    const snapB = await benchmarkService.createSnapshot({
      projectId: fixtureB.projectId,
      workItemId: fixtureB.workItemId,
      name: 'compare-authz-snap-b',
      actor: fixtureB.userId,
    });
    // Experiment A → 1 trial in Project A.
    const expA = await benchmarkService.createExperiment({
      projectId: fixtureA.projectId,
      benchmarkTaskSnapshotId: snapA.id,
      name: 'compare-authz-exp-a',
      trials: [{ provider: 'fake', mode: 'native', repetitions: 1 }],
      createdBy: fixtureA.userId,
    });
    trialAId = (await benchmarkService.listTrials(expA.id)).trials[0]!.id;

    // Experiment B → 1 trial in Project B.
    const expB = await benchmarkService.createExperiment({
      projectId: fixtureB.projectId,
      benchmarkTaskSnapshotId: snapB.id,
      name: 'compare-authz-exp-b',
      trials: [{ provider: 'fake', mode: 'native', repetitions: 1 }],
      createdBy: fixtureB.userId,
    });
    trialBId = (await benchmarkService.listTrials(expB.id)).trials[0]!.id;

    // Same-project/same-snapshot experiment → 2 trials (happy path).
    const expSame = await benchmarkService.createExperiment({
      projectId: fixtureA.projectId,
      benchmarkTaskSnapshotId: snapA.id,
      name: 'compare-authz-exp-same',
      trials: [
        { provider: 'fake', mode: 'native', repetitions: 1 },
        { provider: 'fake', mode: 'external', repetitions: 1 },
      ],
      createdBy: fixtureA.userId,
    });
    const trialsSame = (await benchmarkService.listTrials(expSame.id)).trials;
    sameProjTrial1Id = trialsSame[0]!.id;
    sameProjTrial2Id = trialsSame[1]!.id;

    // Same-project DIFFERENT-snapshot trials.
    const snapA2 = await benchmarkService.createSnapshot({
      projectId: fixtureA.projectId,
      workItemId: fixtureA.workItemId,
      name: 'compare-authz-snap-a2',
      actor: fixtureA.userId,
    });
    const expDiffSnap1 = await benchmarkService.createExperiment({
      projectId: fixtureA.projectId,
      benchmarkTaskSnapshotId: snapA.id,
      name: 'compare-authz-exp-diffsnap-1',
      trials: [{ provider: 'fake', mode: 'native', repetitions: 1 }],
      createdBy: fixtureA.userId,
    });
    const expDiffSnap2 = await benchmarkService.createExperiment({
      projectId: fixtureA.projectId,
      benchmarkTaskSnapshotId: snapA2.id,
      name: 'compare-authz-exp-diffsnap-2',
      trials: [{ provider: 'fake', mode: 'native', repetitions: 1 }],
      createdBy: fixtureA.userId,
    });
    diffSnapTrial1Id = (await benchmarkService.listTrials(expDiffSnap1.id)).trials[0]!.id;
    diffSnapTrial2Id = (await benchmarkService.listTrials(expDiffSnap2.id)).trials[0]!.id;
  });

  afterAll(async () => {
    if (server) await server.close();
    if (worker) await worker.stop();
    if (queue) await queue.close();
    if (stack) await stack.teardown();
  });

  /** POST /benchmarks/compare with the given API key + trialIds. */
  async function postCompare(
    apiKey: string,
    trialIds: string[],
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await server.inject({
      method: 'POST',
      url: '/benchmarks/compare',
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
      payload: { trialIds },
    });
    let body: Record<string, unknown>;
    try {
      body = res.json() as Record<string, unknown>;
    } catch {
      body = { raw: res.body };
    }
    return { status: res.statusCode, body };
  }

  it('compareTrials with trials from different projects → 403 + forbidden + no Project B metadata', async () => {
    const { status, body } = await postCompare(API_KEY_A, [trialAId, trialBId]);
    expect(status).toBe(403);
    expect(body.error).toBe('forbidden');
    expect(body.reason).toBe('benchmark-comparison-trials-must-share-snapshot');
    // NO project id / snapshot id / trial metadata from Project B is leaked.
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain(fixtureB.projectId);
    // The body is a tiny `{ error, reason }` payload — no comparison object.
    expect(body.comparison).toBeUndefined();
    expect(body.trials).toBeUndefined();
    expect(body.cells).toBeUndefined();
  });

  it('compareTrials with trials from different snapshots (same project) → 403', async () => {
    // Both trials are in Project A but reference different snapshots.
    const { status, body } = await postCompare(API_KEY_A, [diffSnapTrial1Id, diffSnapTrial2Id]);
    expect(status).toBe(403);
    expect(body.error).toBe('forbidden');
    expect(body.reason).toBe('benchmark-comparison-trials-must-share-snapshot');
  });

  it('compareTrials with a missing trial id → 404 + benchmark-trial-not-found', async () => {
    const { status, body } = await postCompare(API_KEY_A, [trialAId, NONEXISTENT_TRIAL_ID]);
    expect(status).toBe(404);
    const err = String(body.error ?? '');
    expect(err).toContain('benchmark-trial-not-found');
  });

  it('compareTrials with same-project same-snapshot trials → 200 (happy path)', async () => {
    // PR #35 fix #2 must NOT break valid same-project comparisons. The
    // trials were created (status 'queued') — compareTrials loads them
    // regardless of status (the metric lookups tolerate missing metrics).
    const { status, body } = await postCompare(API_KEY_A, [sameProjTrial1Id, sameProjTrial2Id]);
    expect(status).toBe(200);
    expect(body.comparison).toBeTruthy();
    const comparison = body.comparison as { trials: unknown[]; cells: unknown[]; integrityValid: boolean };
    expect(comparison.trials).toHaveLength(2);
    expect(comparison.cells.length).toBeGreaterThan(0);
  });
});
