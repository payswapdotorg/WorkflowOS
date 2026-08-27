/**
 * PR #35 review fix #1 (regression): snapshot `preview()` is READ-ONLY.
 *
 * The previous implementation called `implementationContextBuilder.build()`
 * (which PERSISTS a `wfos_implementation_contexts` row) inside the read-only
 * preview path. It then also called `contextRepository.create()` a SECOND
 * time — a duplicate write that made even the read-only preview mutate project
 * state. The fix:
 *
 *   - `preview()` now calls `implementationContextBuilder.buildPreview()` (no
 *     DB writes — returns the canonical content + computed revision/kind
 *     WITHOUT inserting a row).
 *   - `create()` calls `build()` (persists exactly ONE row — the duplicate
 *     `contextRepository.create()` was removed).
 *   - `BenchmarkSnapshotPreview.implementationContextId` is now `string | null`
 *     (null for previews — the persisted id is only available on the frozen
 *     `BenchmarkTaskSnapshot`).
 *
 * These regression tests prove the preview path does NOT mutate project state
 * by counting `wfos_implementation_contexts` rows + `wfos_audit_events` rows
 * (event_type='BENCHMARK_SNAPSHOT_CREATED') before + after `preview()`, and
 * that `create()` persists exactly ONE context row + emits exactly ONE audit
 * event.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildBenchmarkFixture, type BenchmarkFixture } from './benchmark-fixture.js';
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
import type { BenchmarkService } from '../../../src/benchmark/index.js';

describe('PR #35 fix #1 — snapshot preview is read-only', () => {
  let stack: TestAuthStack;
  let fixture: BenchmarkFixture;
  let benchmarkService: BenchmarkService;
  let queue: InMemoryQueue;
  let worker: WorkerHost;

  const API_KEY = 'raw-key-preview-readonly-a';
  const SECRET_REF = 'WFOS_TEST_KEY_PREVIEW_READONLY_A';

  beforeAll(async () => {
    process.env[SECRET_REF] = API_KEY;
    stack = await buildAuthStack({ [SECRET_REF]: API_KEY });
    fixture = await buildBenchmarkFixture(stack, API_KEY, SECRET_REF);

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
    
      executionAdmission: { admit: async () => ({ admitted: true, reason: 'test-permit', policyVersion: null, blockingReasons: [] }) },
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
  });

  afterAll(async () => {
    await worker.stop();
    await queue.close();
    await stack.teardown();
  });

  /** Count `wfos_implementation_contexts` rows for the template work item. */
  async function countImplementationContexts(workItemId: string): Promise<number> {
    const res = await stack.db.client.query(
      'SELECT COUNT(*)::int AS count FROM wfos_implementation_contexts WHERE work_item_id = $1',
      [workItemId],
    );
    return res.rows[0]?.count ?? 0;
  }

  /** Count `wfos_audit_events` rows of a given event_type for the project. */
  async function countAuditEvents(projectId: string, eventType: string): Promise<number> {
    const res = await stack.db.client.query(
      'SELECT COUNT(*)::int AS count FROM wfos_audit_events WHERE project_id = $1 AND event_type = $2',
      [projectId, eventType],
    );
    return res.rows[0]?.count ?? 0;
  }

  it('preview() does NOT create an implementation_context row (count unchanged)', async () => {
    const before = await countImplementationContexts(fixture.workItemId);
    expect(before).toBe(0);

    await benchmarkService.previewSnapshot({
      projectId: fixture.projectId,
      workItemId: fixture.workItemId,
    });

    const after = await countImplementationContexts(fixture.workItemId);
    // PR #35 fix #1: preview is read-only — no row persisted.
    expect(after).toBe(before);
    expect(after).toBe(0);
  });

  it('preview() does NOT create a context revision (no second row, no revision bump)', async () => {
    // Call preview twice — the count must remain 0 (no row persisted on either call).
    const beforeFirst = await countImplementationContexts(fixture.workItemId);
    await benchmarkService.previewSnapshot({ projectId: fixture.projectId, workItemId: fixture.workItemId });
    const afterFirst = await countImplementationContexts(fixture.workItemId);
    await benchmarkService.previewSnapshot({ projectId: fixture.projectId, workItemId: fixture.workItemId });
    const afterSecond = await countImplementationContexts(fixture.workItemId);
    expect(afterFirst).toBe(beforeFirst);
    expect(afterSecond).toBe(beforeFirst);
  });

  it('preview() does NOT emit a BENCHMARK_SNAPSHOT_CREATED audit event', async () => {
    const before = await countAuditEvents(fixture.projectId, 'BENCHMARK_SNAPSHOT_CREATED');
    expect(before).toBe(0);

    await benchmarkService.previewSnapshot({ projectId: fixture.projectId, workItemId: fixture.workItemId });

    const after = await countAuditEvents(fixture.projectId, 'BENCHMARK_SNAPSHOT_CREATED');
    // PR #35 fix #1: preview emits NO audit event — only `create()` audits.
    expect(after).toBe(before);
    expect(after).toBe(0);
  });

  it('preview() returns implementationContextId = null', async () => {
    const preview = await benchmarkService.previewSnapshot({
      projectId: fixture.projectId,
      workItemId: fixture.workItemId,
    });
    // PR #35 fix #1: preview has no persisted row → null id.
    expect(preview.implementationContextId).toBeNull();
    // The preview still carries the canonical digest + baseline so the UI can
    // show "SAME TASK SNAPSHOT ✓ / SAME PROMPT DIGEST ✓ / SAME BASELINE ✓"
    // before the user clicks [Create Experiment].
    expect(preview.promptDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.baseCommit).toBeTruthy();
    expect(preview.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('create() persists exactly ONE implementation_context row + emits exactly ONE audit event', async () => {
    const ctxBefore = await countImplementationContexts(fixture.workItemId);
    const audBefore = await countAuditEvents(fixture.projectId, 'BENCHMARK_SNAPSHOT_CREATED');

    const snapshot = await benchmarkService.createSnapshot({
      projectId: fixture.projectId,
      workItemId: fixture.workItemId,
      name: 'preview-readonly-create-snapshot',
      actor: 'test-actor',
    });
    expect(snapshot.implementationContextId).toBeTruthy();

    const ctxAfter = await countImplementationContexts(fixture.workItemId);
    const audAfter = await countAuditEvents(fixture.projectId, 'BENCHMARK_SNAPSHOT_CREATED');

    // PR #35 fix #1: create() persists EXACTLY ONE row (the previous
    // implementation called contextRepository.create() TWICE — a duplicate
    // write the fix removed).
    expect(ctxAfter - ctxBefore).toBe(1);
    // create() emits exactly ONE audit event for BENCHMARK_SNAPSHOT_CREATED.
    expect(audAfter - audBefore).toBe(1);
    // The snapshot row references the persisted context id.
    expect(snapshot.implementationContextId).toBeTruthy();
  });

  it('preview after create() returns null id (preview path stays read-only even when a context exists)', async () => {
    // A snapshot was created in the previous test → a context row now exists
    // for the template work item. The preview path must STILL not mutate it.
    const ctxBefore = await countImplementationContexts(fixture.workItemId);
    expect(ctxBefore).toBeGreaterThanOrEqual(1);

    const preview = await benchmarkService.previewSnapshot({
      projectId: fixture.projectId,
      workItemId: fixture.workItemId,
    });
    // Preview id stays null — preview never returns a persisted id.
    expect(preview.implementationContextId).toBeNull();

    // Context count is unchanged — preview did not add a row.
    const ctxAfter = await countImplementationContexts(fixture.workItemId);
    expect(ctxAfter).toBe(ctxBefore);
  });
});
