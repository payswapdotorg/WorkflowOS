/**
 * PR #35 review fix #4 (regression): the benchmark trial lifecycle is
 * EVENT-DRIVEN + ASYNCHRONOUS. `startExperiment()` enqueues
 * `benchmark.trial` jobs + returns IMMEDIATELY (experiment 'running'). The
 * WorkerHost picks up each job and calls `runTrialJob(trialId)`.
 *
 * The core correctness invariant: an experiment is NEVER marked 'completed'
 * while ANY trial is still 'running'/'handoff_ready'. The experiment only
 * completes when EVERY trial reaches a terminal state
 * (completed/failed/unavailable).
 *
 * For external trials:
 *   - The orchestrator runs (clone → branch → submit) + marks the trial
 *     'running' (handoff_ready). The executionId is set on the trial row.
 *   - The job handler polls `executionRecordRepository.findByExecutionId()`
 *     until the record reaches a terminal state (completed/failed/expired).
 *   - When the record is terminal, the trial is marked terminal + metrics
 *     are collected + experiment completion is checked.
 *
 * These regression tests prove:
 *   1. An external trial does NOT prematurely complete the experiment
 *      (no completion event ingested → experiment stays 'running').
 *   2. A `completed` ingestion event moves the trial → 'completed' + the
 *      experiment → 'completed'.
 *   3. The experiment remains 'running' while a native trial is done but
 *      an external trial is still 'handoff_ready'. Only when the external
 *      trial reaches terminal does the experiment finalize.
 *   4. Metrics are collected ONLY after the authoritative outcome — before
 *      the `completed` event, `getTrialMetrics(trialId)` returns null.
 *      After, metrics exist + `collectedAt` is after the completion event.
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
import {
  driveExternalCompletions,
  awaitExperimentCompleted,
} from './benchmark-async-helpers.js';
import { waitFor } from '../../helpers/test-app.js';
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

describe('PR #35 fix #4 — async trial lifecycle', () => {
  let stack: TestAuthStack;
  let fixture: BenchmarkFixture;
  let benchmarkService: BenchmarkService;
  let queue: InMemoryQueue;
  let worker: WorkerHost;
  let executionEventIngestionService: DefaultExecutionEventIngestionService;

  const API_KEY = 'raw-key-async-lifecycle-a';
  const SECRET_REF = 'WFOS_TEST_KEY_ASYNC_LIFECYCLE_A';

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
    executionEventIngestionService = new DefaultExecutionEventIngestionService({
      executionRecordRepository,
      eventRepository: executionEventRepository,
      auditService,
      logger: logger as never,
    });
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
      externalTimeoutMs: 30_000,
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

  /** Create a snapshot + experiment (helper). */
  async function makeExperiment(
    name: string,
    trials: { provider: string; mode: 'native' | 'external'; repetitions: number }[],
  ): Promise<{ experimentId: string; snapshotId: string }> {
    const snapshot = await benchmarkService.createSnapshot({
      projectId: fixture.projectId,
      workItemId: fixture.workItemId,
      name: `${name}-snapshot`,
      actor: fixture.userId,
    });
    const exp = await benchmarkService.createExperiment({
      projectId: fixture.projectId,
      benchmarkTaskSnapshotId: snapshot.id,
      name,
      trials,
      createdBy: fixture.userId,
    });
    return { experimentId: exp.id, snapshotId: snapshot.id };
  }

  it('external handoff_ready trial does NOT complete the experiment', async () => {
    const { experimentId } = await makeExperiment('async-no-completion', [
      { provider: 'fake', mode: 'external', repetitions: 1 },
    ]);
    // Start the experiment (enqueues jobs + returns immediately).
    await benchmarkService.startExperiment(experimentId);

    // Wait for the external trial to reach handoff_ready (executionId set).
    await waitFor(async () => {
      const { trials } = await benchmarkService.listTrials(experimentId);
      return trials.length > 0 && !!trials[0]!.executionId;
    }, { timeoutMs: 10_000, intervalMs: 10 });

    // PR #35 fix #4: the experiment is STILL 'running' (NOT 'completed') —
    // the external trial is handoff_ready but the companion has not yet
    // reported completion. The job handler is polling the execution record,
    // but no terminal state has been observed yet.
    const exp = await benchmarkService.getExperiment(experimentId);
    expect(exp?.status).toBe('running');

    const { trials } = await benchmarkService.listTrials(experimentId);
    expect(trials[0]!.status).toBe('running');
    expect(trials[0]!.executionId).toBeTruthy();

    // Drive completion NOW (otherwise the experiment would stay 'running'
    // for the full 30s external timeout, which would slow this test).
    await driveExternalCompletions(benchmarkService, executionEventIngestionService, experimentId);
    await awaitExperimentCompleted(benchmarkService, experimentId);
  });

  it('callback completion event moves the trial + experiment to completed', async () => {
    const { experimentId } = await makeExperiment('async-callback-completes', [
      { provider: 'fake', mode: 'external', repetitions: 1 },
    ]);
    // Start the experiment + wait for the external trial to reach handoff_ready.
    await benchmarkService.startExperiment(experimentId);
    await waitFor(async () => {
      const { trials } = await benchmarkService.listTrials(experimentId);
      return trials.length > 0 && !!trials[0]!.executionId;
    }, { timeoutMs: 10_000, intervalMs: 10 });

    // Before the completion event, the trial + experiment are still running.
    const beforeExp = await benchmarkService.getExperiment(experimentId);
    expect(beforeExp?.status).toBe('running');

    // Ingest the `completed` event via the ingestion service — this is the
    // authoritative signal the job handler polls for.
    await driveExternalCompletions(benchmarkService, executionEventIngestionService, experimentId);

    // PR #35 fix #4: the trial reaches 'completed' + the experiment reaches
    // 'completed' AFTER the callback event.
    await awaitExperimentCompleted(benchmarkService, experimentId);
    const exp = await benchmarkService.getExperiment(experimentId);
    expect(exp?.status).toBe('completed');

    const { trials } = await benchmarkService.listTrials(experimentId);
    expect(trials[0]!.status).toBe('completed');
  });

  it('experiment remains running until ALL trials terminal (native done + external still running)', async () => {
    // 1 native + 1 external trial. The native completes quickly; the
    // external is handoff_ready (no completion event ingested).
    const { experimentId } = await makeExperiment('async-mixed-pending', [
      { provider: 'fake', mode: 'native', repetitions: 1 },
      { provider: 'fake', mode: 'external', repetitions: 1 },
    ]);
    await benchmarkService.startExperiment(experimentId);

    // Wait for BOTH trials to reach their first terminal-or-handoff state:
    // native → 'completed'; external → 'running' (handoff_ready, executionId set).
    await waitFor(async () => {
      const { trials } = await benchmarkService.listTrials(experimentId);
      if (trials.length !== 2) return false;
      const native = trials.find((t) => t.executionMode === 'native');
      const external = trials.find((t) => t.executionMode === 'external');
      return !!native && native.status === 'completed' && !!external && !!external.executionId;
    }, { timeoutMs: 10_000, intervalMs: 10 });

    // PR #35 fix #4: even though the native is done, the experiment is STILL
    // 'running' because the external trial is still handoff_ready.
    const exp = await benchmarkService.getExperiment(experimentId);
    expect(exp?.status).toBe('running');

    // Now drive the external completion → the experiment reaches 'completed'.
    await driveExternalCompletions(benchmarkService, executionEventIngestionService, experimentId);
    await awaitExperimentCompleted(benchmarkService, experimentId);
    const finalExp = await benchmarkService.getExperiment(experimentId);
    expect(finalExp?.status).toBe('completed');
  });

  it('metrics collected only AFTER authoritative outcome', async () => {
    const { experimentId } = await makeExperiment('async-metrics-after-outcome', [
      { provider: 'fake', mode: 'external', repetitions: 1 },
    ]);
    await benchmarkService.startExperiment(experimentId);

    // Wait for the external trial to reach handoff_ready.
    let trialId: string | null = null;
    await waitFor(async () => {
      const { trials } = await benchmarkService.listTrials(experimentId);
      if (trials.length === 0) return false;
      if (trials[0]!.executionId) {
        trialId = trials[0]!.id;
        return true;
      }
      return false;
    }, { timeoutMs: 10_000, intervalMs: 10 });
    expect(trialId).not.toBeNull();

    // BEFORE the completion event, the metrics collector has not run → no
    // metrics row exists for the trial.
    const metricsBefore = await benchmarkService.getTrialMetrics(trialId!);
    expect(metricsBefore).toBeNull();

    // Capture the ingestion timestamp so we can assert metrics.collectedAt
    // is after the authoritative outcome.
    const beforeOutcomeAt = new Date();

    // Ingest the completion event + wait for the trial to reach 'completed'
    // (the job handler runs the metric collector inside `runTrialJob` AFTER
    // the trial reaches terminal state).
    await driveExternalCompletions(benchmarkService, executionEventIngestionService, experimentId);
    await waitFor(async () => {
      const { trials } = await benchmarkService.listTrials(experimentId);
      return trials[0]?.status === 'completed';
    }, { timeoutMs: 10_000, intervalMs: 10 });

    // AFTER the completion event, metrics exist + collectedAt is after the
    // outcome timestamp.
    const metricsAfter = await benchmarkService.getTrialMetrics(trialId!);
    expect(metricsAfter).not.toBeNull();
    expect(metricsAfter!.collectedAt.getTime()).toBeGreaterThanOrEqual(beforeOutcomeAt.getTime());
  });
});
