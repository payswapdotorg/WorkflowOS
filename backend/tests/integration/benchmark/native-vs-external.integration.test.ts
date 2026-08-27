/**
 * WORK-032: Native vs External Execution Benchmark integration test.
 *
 * Proves, against a REAL database + the REAL benchmark service:
 *   1. A snapshot can be frozen from a fixture work item (promptDigest +
 *      baselineCommit + snapshotHash).
 *   2. An experiment can be created with multiple trial specs (native +
 *      external, multiple providers).
 *   3. The experiment creates isolated trials (per-trial branch + cloned
 *      work item) with promptDigest + baselineCommit copied from the snapshot.
 *   4. Starting the experiment runs the trials through the deterministic
 *      benchmark providers (§37/§38) — no real LLM/browser needed.
 *   5. Metrics are collected from AUTHORITATIVE state (agent runs, etc.).
 *   6. Integrity is valid (promptDigest + baselineCommit identical across
 *      trials — §27/§28).
 *   7. The comparison view works (§26).
 *   8. Export (JSON + CSV) works (§40).
 *   9. Recommendation works (§42).
 *
 * The deterministic providers replace the real NativeExecutionProvider +
 * ExternalExecutionProvider so CI can run without real provider accounts. The
 * benchmark machinery (snapshot, experiment, trial, metrics, integrity,
 * export, recommendation) is the SAME code path production uses.
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
import { startAndAwaitExperiment } from './benchmark-async-helpers.js';
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
import type { WorkflowEngine } from '../../../src/modules/workflows/index.js';

describe('WORK-032 — native vs external execution benchmark', () => {
  let stack: TestAuthStack;
  let fixture: BenchmarkFixture;
  let benchmarkService: BenchmarkService;
  let queue: InMemoryQueue;
  let worker: WorkerHost;
  let executionEventIngestionService: DefaultExecutionEventIngestionService;
  let workflowEngine: WorkflowEngine;

  const API_KEY = 'raw-key-benchmark-a';
  const SECRET_REF = 'WFOS_TEST_KEY_BENCHMARK_A';

  beforeAll(async () => {
    process.env[SECRET_REF] = API_KEY;
    stack = await buildAuthStack({ [SECRET_REF]: API_KEY });
    fixture = await buildBenchmarkFixture(stack, API_KEY, SECRET_REF);

    // Wire the benchmark service with DETERMINISTIC providers (§37/§38).
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
      // optional resolvers (callbacks to avoid module cycle)
      async () => null, // repositoryResolver
      async () => null, // pullRequestResolver
      async () => [],   // agentRunResolver
      async () => [],   // reviewResolver
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

    workflowEngine = new DefaultWorkflowEngine(db, logger);
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

    // ExecutionService with DETERMINISTIC providers (replaces real ones).
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
    void executionHandoffService; // kept for DI completeness (external handoff path)
    const executionCallbackService = new DefaultExecutionCallbackService({
      executionRecordRepository,
      callbackRepository: executionCallbackRepository,
      auditService,
      logger: logger as never,
    });
    void executionCallbackService;
    executionEventIngestionService = new DefaultExecutionEventIngestionService({
      executionRecordRepository,
      eventRepository: executionEventRepository,
      auditService,
      logger: logger as never,
    });

    // The DETERMINISTIC native benchmark provider (§38) — replaces the real
    // NativeExecutionProvider. The deterministic external benchmark provider
    // (§37) replaces the real ExternalExecutionProvider.
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

    // PR #35 review fix #4: async trial lifecycle — `startExperiment()`
    // enqueues `benchmark.trial` jobs + returns immediately (experiment
    // 'running'). The WorkerHost picks them up + calls runTrialJob(trialId),
    // which advances each trial to terminal + collects metrics + checks
    // experiment completion.
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

  it('freezes a snapshot with promptDigest + baselineCommit + snapshotHash', async () => {
    const preview = await benchmarkService.previewSnapshot({
      projectId: fixture.projectId,
      workItemId: fixture.workItemId,
    });
    expect(preview.promptDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.baseCommit).toBeTruthy();
    expect(preview.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.promptExcerpt).toContain('Implementation Instructions');

    const snapshot = await benchmarkService.createSnapshot({
      projectId: fixture.projectId,
      workItemId: fixture.workItemId,
      name: 'bench-addition',
      description: 'Calculator addition benchmark',
    });
    expect(snapshot.promptDigest).toBe(preview.promptDigest);
    expect(snapshot.baseCommit).toBe(preview.baseCommit);
    expect(snapshot.snapshotHash).toBe(preview.snapshotHash);
    expect(snapshot.harnessVersion).toBe('work-032-v1');
    expect(snapshot.scoringVersion).toBe('v1');
  });

  it('creates an experiment with isolated trials (§6, §27, §28)', async () => {
    const snapshot = await benchmarkService.createSnapshot({
      projectId: fixture.projectId,
      workItemId: fixture.workItemId,
      name: 'bench-addition-2',
    });
    const experiment = await benchmarkService.createExperiment({
      projectId: fixture.projectId,
      benchmarkTaskSnapshotId: snapshot.id,
      name: 'WORK-BENCH provider comparison',
      description: 'Compare native vs external on the calculator task',
      trials: [
        { provider: 'fake', mode: 'native', repetitions: 1 },
        { provider: 'fake', mode: 'external', repetitions: 1 },
      ],
      createdBy: fixture.userId,
    });
    expect(experiment.status).toBe('created');
    expect(experiment.repetitions).toBe(1);

    const { trials } = await benchmarkService.listTrials(experiment.id);
    expect(trials).toHaveLength(2);
    // §6: each trial has its own isolated branch.
    expect(new Set(trials.map((t) => t.trialBranch)).size).toBe(2);
    // §27: all trials share the snapshot's promptDigest.
    const digestSet = new Set(trials.map((t) => t.promptDigest));
    expect(digestSet.size).toBe(1);
    expect([...digestSet][0]).toBe(snapshot.promptDigest);
    // §28: all trials share the snapshot's baselineCommit.
    const commitSet = new Set(trials.map((t) => t.baselineCommit));
    expect(commitSet.size).toBe(1);
    expect([...commitSet][0]).toBe(snapshot.baseCommit);
    // §29: all trials share the snapshotId.
    const snapshotIdSet = new Set(trials.map((t) => t.benchmarkTaskSnapshotId));
    expect(snapshotIdSet.size).toBe(1);
    expect([...snapshotIdSet][0]).toBe(snapshot.id);
  });

  it('runs the experiment + collects metrics + validates integrity (§8, §9, §32)', async () => {
    const snapshot = await benchmarkService.createSnapshot({
      projectId: fixture.projectId,
      workItemId: fixture.workItemId,
      name: 'bench-addition-run',
    });
    const experiment = await benchmarkService.createExperiment({
      projectId: fixture.projectId,
      benchmarkTaskSnapshotId: snapshot.id,
      name: 'WORK-BENCH run',
      trials: [
        { provider: 'fake', mode: 'native', repetitions: 1 },
      ],
      createdBy: fixture.userId,
    });

    // Start the experiment + wait for the async trial lifecycle to complete
    // (PR #35 review fix v2: startExperiment enqueues benchmark.trial jobs +
    // returns immediately; the WorkerHost drives each trial through the
    // orchestrator → execution → delivery phases. driveExternalCompletions
    // simulates the Companion for external trials; driveDeliveryLifecycle
    // drives the workflow to `verified` for ALL trials (native + external).)
    await startAndAwaitExperiment(benchmarkService, executionEventIngestionService, experiment.id, { workflowEngine, queue });
    const exp = await benchmarkService.getExperiment(experiment.id);
    expect(exp?.status).toBe('completed');

    const { trials } = await benchmarkService.listTrials(experiment.id);
    expect(trials).toHaveLength(1);
    const trial = trials[0]!;
    // §6: the trial cloned a fresh work item (different from the template).
    expect(trial.workItemId).toBeTruthy();
    expect(trial.workItemId).not.toBe(fixture.workItemId);
    expect(trial.status).toBe('completed');
    expect(trial.executionId).toBeTruthy();
    expect(trial.agentRunId).toBeTruthy();

    // Metrics collected.
    const metrics = await benchmarkService.getTrialMetrics(trial.id);
    expect(metrics).not.toBeNull();
    expect(metrics!.agentRuns).toBe(1);
    expect(metrics!.scoreVersion).toBe('v1');
    expect(metrics!.engineeringQualityScore).toBeGreaterThanOrEqual(0);
    expect(metrics!.engineeringQualityScore).toBeLessThanOrEqual(100);

    // §32: integrity is valid.
    const integrity = await benchmarkService.getIntegrity(experiment.id);
    expect(integrity).not.toBeNull();
    expect(integrity!.valid).toBe(true);
    expect(integrity!.promptDigest).toBe(snapshot.promptDigest);
    expect(integrity!.baselineCommit).toBe(snapshot.baseCommit);
  });

  it('compares trials side-by-side (§26) + validates equality invariants', async () => {
    const snapshot = await benchmarkService.createSnapshot({
      projectId: fixture.projectId,
      workItemId: fixture.workItemId,
      name: 'bench-addition-compare',
    });
    const experiment = await benchmarkService.createExperiment({
      projectId: fixture.projectId,
      benchmarkTaskSnapshotId: snapshot.id,
      name: 'WORK-BENCH compare',
      trials: [
        { provider: 'fake', mode: 'native', repetitions: 1 },
        { provider: 'fake', mode: 'external', repetitions: 1 },
      ],
      createdBy: fixture.userId,
    });
    await startAndAwaitExperiment(benchmarkService, executionEventIngestionService, experiment.id, { workflowEngine, queue });
    const { trials } = await benchmarkService.listTrials(experiment.id);
    expect(trials.length).toBeGreaterThanOrEqual(2);

    const comparison = await benchmarkService.compareTrials([trials[0]!.id, trials[1]!.id]);
    // §27/§28/§29: all trials share the same task.
    expect(comparison.promptDigest).toBe(snapshot.promptDigest);
    expect(comparison.baselineCommit).toBe(snapshot.baseCommit);
    expect(comparison.integrityValid).toBe(true);
    expect(comparison.trials).toHaveLength(2);
    expect(comparison.cells.length).toBeGreaterThan(0);
  });

  it('exports results as JSON + CSV (§40) — no credentials in export', async () => {
    const snapshot = await benchmarkService.createSnapshot({
      projectId: fixture.projectId,
      workItemId: fixture.workItemId,
      name: 'bench-addition-export',
    });
    const experiment = await benchmarkService.createExperiment({
      projectId: fixture.projectId,
      benchmarkTaskSnapshotId: snapshot.id,
      name: 'WORK-BENCH export',
      trials: [{ provider: 'fake', mode: 'native', repetitions: 1 }],
      createdBy: fixture.userId,
    });
    await startAndAwaitExperiment(benchmarkService, executionEventIngestionService, experiment.id, { workflowEngine, queue });

    const json = await benchmarkService.exportExperiment(experiment.id, 'json');
    expect(json.contentType).toBe('application/json');
    expect(json.filename).toMatch(/\.json$/);
    const payload = JSON.parse(json.body);
    expect(payload.experiment.name).toBe('WORK-BENCH export');
    expect(payload.snapshot.promptDigest).toBe(snapshot.promptDigest);
    // §33/§40: no credentials in the export.
    expect(JSON.stringify(payload)).not.toMatch(/(?:password|api_?key|secret|credential|cookie|callback_token|handoff_token)/i);

    const csv = await benchmarkService.exportExperiment(experiment.id, 'csv');
    expect(csv.contentType).toBe('text/csv');
    expect(csv.filename).toMatch(/\.csv$/);
    expect(csv.body).toContain('trialId');
    expect(csv.body).toContain('provider');
  });

  it('recommends a cell with explicit evidence (§41, §42)', async () => {
    const snapshot = await benchmarkService.createSnapshot({
      projectId: fixture.projectId,
      workItemId: fixture.workItemId,
      name: 'bench-addition-recommend',
    });
    const experiment = await benchmarkService.createExperiment({
      projectId: fixture.projectId,
      benchmarkTaskSnapshotId: snapshot.id,
      name: 'WORK-BENCH recommend',
      trials: [{ provider: 'fake', mode: 'native', repetitions: 1 }],
      createdBy: fixture.userId,
    });
    await startAndAwaitExperiment(benchmarkService, executionEventIngestionService, experiment.id, { workflowEngine, queue });

    const recommendation = await benchmarkService.recommend(experiment.id);
    expect(recommendation).not.toBeNull();
    // §41: never automatically declares "X is best" with a simplistic score.
    // §42: shows the underlying evidence.
    expect(recommendation!.evidence.length).toBeGreaterThan(0);
    expect(recommendation!.sampleSize).toBeGreaterThan(0);
  });

  it('supports optional trial ordering randomization (§21)', async () => {
    const snapshot = await benchmarkService.createSnapshot({
      projectId: fixture.projectId,
      workItemId: fixture.workItemId,
      name: 'bench-addition-randomize',
    });
    const experiment = await benchmarkService.createExperiment({
      projectId: fixture.projectId,
      benchmarkTaskSnapshotId: snapshot.id,
      name: 'WORK-BENCH randomize',
      trials: [
        { provider: 'fake', mode: 'native', repetitions: 1 },
        { provider: 'fake', mode: 'external', repetitions: 1 },
      ],
      randomizeOrder: true,
      randomizationSeed: 'test-seed-12345',
      createdBy: fixture.userId,
    });
    expect(experiment.randomizationSeed).toBe('test-seed-12345');
    const { trials } = await benchmarkService.listTrials(experiment.id);
    // The execution_order values should be a permutation of [0, 1].
    const orders = trials.map((t) => t.executionOrder).sort((a, b) => a - b);
    expect(orders).toEqual([0, 1]);
    // The same seed always produces the same order (reproducibility §20).
    // Re-run with the same seed → same order.
    const experiment2 = await benchmarkService.createExperiment({
      projectId: fixture.projectId,
      benchmarkTaskSnapshotId: snapshot.id,
      name: 'WORK-BENCH randomize 2',
      trials: [
        { provider: 'fake', mode: 'native', repetitions: 1 },
        { provider: 'fake', mode: 'external', repetitions: 1 },
      ],
      randomizeOrder: true,
      randomizationSeed: 'test-seed-12345',
      createdBy: fixture.userId,
    });
    const { trials: trials2 } = await benchmarkService.listTrials(experiment2.id);
    const orders1 = trials.map((t) => ({ p: t.provider, m: t.executionMode, o: t.executionOrder }));
    const orders2 = trials2.map((t) => ({ p: t.provider, m: t.executionMode, o: t.executionOrder }));
    // Same seed → same relative ordering of (provider, mode) cells.
    expect(orders1.sort((a, b) => a.o - b.o).map((x) => `${x.p}-${x.m}`))
      .toEqual(orders2.sort((a, b) => a.o - b.o).map((x) => `${x.p}-${x.m}`));
  });
});
