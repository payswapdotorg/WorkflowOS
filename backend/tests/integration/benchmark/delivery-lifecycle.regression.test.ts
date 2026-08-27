/**
 * PR #35 review fix v2 / Blocker B (regression): trial/experiment
 * completion is too early. The benchmark measures COMPLETED SOFTWARE
 * (PR → CI → Verification → Review → Merge → VERIFIED), NOT completed
 * execution. The previous implementation marked the trial `completed`
 * immediately when execution completed (native synchronously; external
 * when `awaitExternalCompletion` returned `'completed'`), then collected
 * metrics + checked experiment completion. Execution completion ≠
 * delivery completion.
 *
 * The authoritative signal: the workflow engine state for the trial's
 * cloned `workItemId`. `verified` (WorkflowState terminal success) →
 * trial `completed`. Terminal failure states (`verification_failed`,
 * `implementation_blocked`) → trial `failed` (engineering).
 *
 * The fix: rewrite `runTrialJob` as a NON-BLOCKING, RE-ENTRANT state
 * machine. The DELIVERY PHASE reads `workflowEngine.getState(workItemId)`
 * — if `verified` → trial `completed`; if a terminal failure state →
 * trial `failed` (engineering); otherwise → return (wait for the
 * `onTransition` composition hook on the workflow engine to re-advance
 * the trial when the work item reaches a terminal state).
 *
 * The orchestrator NO LONGER marks native trials `completed` at submit
 * time — native trials are `running` (execution done, awaiting delivery).
 *
 * These regression tests prove:
 *   1. After execution completes (native: orchestrator ran; external:
 *      ingest `completed` event), the trial is STILL `running` (NOT
 *      `completed`) — execution-complete ≠ delivery-complete.
 *   2. The experiment is STILL `running` (not all trials terminal).
 *   3. After driving the cloned work item's workflow to `verified` (via
 *      the legal intermediate states — `ready` → `assigned` →
 *      `implementing` → `pr_open` → `verifying` → `architect_review` →
 *      `approved` → `merged` → `verified`), the `benchmark.trial`
 *      re-trigger (enqueued by `driveDeliveryLifecycle`) moves the
 *      trial to `completed` + the experiment to `completed`.
 *   4. Metrics are collected ONLY after `verified` (getTrialMetrics
 *      returns null before, non-null after).
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
  driveDeliveryLifecycle,
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
import type { WorkflowEngine } from '../../../src/modules/workflows/index.js';

describe('PR #35 fix v2 / Blocker B — delivery lifecycle (verified drives completion)', () => {
  let stack: TestAuthStack;
  let fixture: BenchmarkFixture;
  let benchmarkService: BenchmarkService;
  let queue: InMemoryQueue;
  let worker: WorkerHost;
  let executionEventIngestionService: DefaultExecutionEventIngestionService;
  let workflowEngine: WorkflowEngine;

  const API_KEY = 'raw-key-delivery-lifecycle-a';
  const SECRET_REF = 'WFOS_TEST_KEY_DELIVERY_LIFECYCLE_A';

  beforeAll(async () => {
    process.env[SECRET_REF] = API_KEY;
    stack = await buildAuthStack({ [SECRET_REF]: API_KEY });
    fixture = await buildBenchmarkFixture(stack, API_KEY, SECRET_REF);

    const db = stack.db.client;
    const logger = stack.db.logger;
    const auditService = new DefaultAuditService(db, logger);
    const authorizationService = new DefaultAuthorizationService(
      stack.membershipRepository, stack.rolePermissionRepository, stack.projectRepository, stack.projectAccessRepository,
    );
    const benchmarkRepository = new PgBenchmarkRepository(db);
    const projectGitHubRepositoryRepository = new PgProjectGitHubRepositoryRepository(db);
    const githubAdapter = new FakeGitHubAdapter();
    const implementationContextRepository = new PgImplementationContextRepository(db);
    const promptBuilder = new DefaultExecutionPromptBuilder();
    const implementationContextBuilder = new DefaultImplementationContextBuilder(
      stack.workItemRepository, stack.workOrderRepository, stack.workItemRequirementRepository,
      stack.workItemCriterionRepository, stack.workItemDependencyRepository, stack.requirementRepository,
      stack.acceptanceCriterionRepository, stack.architectureVersionRepository, stack.architectureRepository,
      implementationContextRepository, async () => null, async () => null, async () => [], async () => [],
    );
    const snapshotService = new DefaultBenchmarkSnapshotService({
      repository: benchmarkRepository, workItemRepository: stack.workItemRepository, workOrderRepository: stack.workOrderRepository,
      architectureVersionRepository: stack.architectureVersionRepository, architectureRepository: stack.architectureRepository,
      projectRepository: stack.projectRepository, implementationContextBuilder, contextRepository: implementationContextRepository,
      promptBuilder, projectGitHubRepositoryRepository, githubAdapter, logger: logger as never,
    });
    const integrityService = new DefaultBenchmarkIntegrityService({ repository: benchmarkRepository, logger: logger as never });
    workflowEngine = new DefaultWorkflowEngine(db, logger);
    const reviewService = new DefaultReviewService(db, stack.workItemRepository, logger);
    const verificationService = { listRunsForWorkItem: async () => [], listEvidenceForRun: async () => [], listMappingsForRun: async () => [] } as never;
    const ciEvidenceIngestionRepository = new PgCiEvidenceIngestionRepository(db);
    const agentRunRepository = new PgAgentRunRepository(db);
    const metricCollector = new DefaultBenchmarkMetricCollector({
      repository: benchmarkRepository, workflowEngine, verificationService, reviewService,
      pullRequestAssociationRepository: stack.pullRequestAssociationRepository,
      ciEvidenceIngestionRepository, agentRunRepository, logger: logger as never,
    });
    const executionRecordRepository = new PgExecutionRecordRepository(db);
    const executionEventRepository = new PgExecutionEventRepository(db);
    const executionHandoffRepository = new PgExecutionHandoffRepository(db);
    const executionCallbackRepository = new PgExecutionCallbackRepository(db);
    const executionTaskService = new DefaultExecutionTaskService({
      workItemRepository: stack.workItemRepository, workOrderRepository: stack.workOrderRepository,
      architectureVersionRepository: stack.architectureVersionRepository, architectureRepository: stack.architectureRepository,
      implementationContextBuilder, contextRepository: implementationContextRepository, promptBuilder, logger: logger as never,
    });
    const executionHandoffService = new DefaultExecutionHandoffService({
      executionRecordRepository, handoffRepository: executionHandoffRepository, auditService, logger: logger as never,
    });
    void executionHandoffService;
    const executionCallbackService = new DefaultExecutionCallbackService({
      executionRecordRepository, callbackRepository: executionCallbackRepository, auditService, logger: logger as never,
    });
    void executionCallbackService;
    executionEventIngestionService = new DefaultExecutionEventIngestionService({
      executionRecordRepository, eventRepository: executionEventRepository, auditService, logger: logger as never,
    });
    const deterministicNativeProvider = new DeterministicNativeBenchmarkProvider({ variant: 'perfect-first-pass', agentRunRepository });
    const deterministicExternalProvider = new DeterministicExternalBenchmarkProvider({ variant: 'perfect-first-pass' });
    const executionService = new DefaultExecutionService({
      executionRecordRepository, providers: [deterministicNativeProvider, deterministicExternalProvider], auditService, logger: logger as never,
    
  });
    const trialOrchestrator = new DefaultBenchmarkTrialOrchestrator({
      repository: benchmarkRepository, executionService, executionTaskService, agentRunRepository,
      workItemRepository: stack.workItemRepository, workOrderRepository: stack.workOrderRepository,
      workItemRequirementRepository: stack.workItemRequirementRepository, workItemCriterionRepository: stack.workItemCriterionRepository,
      workItemDependencyRepository: stack.workItemDependencyRepository, workflowEngine,
      projectGitHubRepositoryRepository, githubAdapter, logger: logger as never,
    });
    const exportService = new DefaultBenchmarkExportService({ repository: benchmarkRepository, logger: logger as never });
    const recommendationService = new DefaultBenchmarkRecommendationService({ repository: benchmarkRepository, logger: logger as never });
    queue = new InMemoryQueue();
    benchmarkService = new DefaultBenchmarkService({
      db, logger: logger as never, repository: benchmarkRepository, snapshotService, integrityService, metricCollector,
      trialOrchestrator, exportService, recommendationService, auditService, authorizationService,
      queue, executionRecordRepository, workflowEngine,
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

  it('native trial stays running after orchestrator (execution-done ≠ delivery-complete)', async () => {
    // Create a native-only experiment.
    const snapshot = await benchmarkService.createSnapshot({
      projectId: fixture.projectId, workItemId: fixture.workItemId, name: 'delivery-native-snapshot', actor: fixture.userId,
    });
    const experiment = await benchmarkService.createExperiment({
      projectId: fixture.projectId, benchmarkTaskSnapshotId: snapshot.id, name: 'delivery-native-exp',
      trials: [{ provider: 'fake', mode: 'native', repetitions: 1 }], createdBy: fixture.userId,
    });
    await benchmarkService.startExperiment(experiment.id);

    // Wait for the native trial to reach 'running' (orchestrator ran —
    // execution done, awaiting delivery). The orchestrator NO LONGER
    // marks native trials 'completed' at submit time.
    let trialId: string | null = null;
    await waitFor(async () => {
      const { trials } = await benchmarkService.listTrials(experiment.id);
      if (trials.length === 0) return false;
      if (trials[0]!.status === 'running' && trials[0]!.workItemId) {
        trialId = trials[0]!.id;
        return true;
      }
      return false;
    }, { timeoutMs: 10_000, intervalMs: 10 });
    expect(trialId).not.toBeNull();

    // PR #35 fix v2 / Blocker B: the native trial is STILL 'running'
    // (NOT 'completed') — execution-complete ≠ delivery-complete.
    const trial = (await benchmarkService.listTrials(experiment.id)).trials[0]!;
    expect(trial.status).toBe('running');
    expect(trial.workItemId).toBeTruthy();
    expect(trial.executionId).toBeTruthy();
    expect(trial.agentRunId).toBeTruthy();

    // The experiment is STILL 'running' (the trial is not terminal).
    const exp = await benchmarkService.getExperiment(experiment.id);
    expect(exp?.status).toBe('running');

    // Metrics are NOT yet collected (the trial is not terminal).
    const metricsBefore = await benchmarkService.getTrialMetrics(trialId!);
    expect(metricsBefore).toBeNull();

    // Drive the delivery lifecycle → workflow to `verified` → trial
    // 'completed' + experiment 'completed'.
    await driveDeliveryLifecycle(benchmarkService, workflowEngine, queue, experiment.id);
    await awaitExperimentCompleted(benchmarkService, experiment.id);

    // After `verified`: trial 'completed' + metrics exist.
    const finalTrial = (await benchmarkService.listTrials(experiment.id)).trials[0]!;
    expect(finalTrial.status).toBe('completed');
    const metricsAfter = await benchmarkService.getTrialMetrics(trialId!);
    expect(metricsAfter).not.toBeNull();
    // The metric collector reads `verifiedAt` from the workflow history.
    expect(metricsAfter!.verifiedAt).not.toBeNull();
    expect(metricsAfter!.timeToVerifiedMs).not.toBeNull();
  });

  it('external trial stays running after ingestion (execution-complete ≠ delivery-complete)', async () => {
    const snapshot = await benchmarkService.createSnapshot({
      projectId: fixture.projectId, workItemId: fixture.workItemId, name: 'delivery-external-snapshot', actor: fixture.userId,
    });
    const experiment = await benchmarkService.createExperiment({
      projectId: fixture.projectId, benchmarkTaskSnapshotId: snapshot.id, name: 'delivery-external-exp',
      trials: [{ provider: 'fake', mode: 'external', repetitions: 1 }], createdBy: fixture.userId,
    });
    await benchmarkService.startExperiment(experiment.id);

    // Wait for the external trial to reach handoff_ready.
    let trialId: string | null = null;
    await waitFor(async () => {
      const { trials } = await benchmarkService.listTrials(experiment.id);
      if (trials.length === 0) return false;
      if (trials[0]!.executionId) {
        trialId = trials[0]!.id;
        return true;
      }
      return false;
    }, { timeoutMs: 10_000, intervalMs: 10 });
    expect(trialId).not.toBeNull();

    // Ingest the `completed` event. The trial advances to the delivery
    // phase but is NOT yet 'completed'.
    await driveExternalCompletions(benchmarkService, executionEventIngestionService, experiment.id);
    // Re-enqueue so the worker re-enters runTrialJob + reads the
    // now-terminal execution record + enters the DELIVERY PHASE.
    await queue.enqueue('benchmark.trial', { trialId: trialId! });
    await waitFor(async () => {
      const { trials } = await benchmarkService.listTrials(experiment.id);
      return trials[0]?.status === 'running';
    }, { timeoutMs: 2_000, intervalMs: 10 });

    // PR #35 fix v2 / Blocker B: the external trial is STILL 'running'
    // (NOT 'completed') after the ingestion event — execution-complete ≠
    // delivery-complete. The trial is in the DELIVERY PHASE.
    const trial = (await benchmarkService.listTrials(experiment.id)).trials[0]!;
    expect(trial.status).toBe('running');

    // The experiment is STILL 'running'.
    const exp = await benchmarkService.getExperiment(experiment.id);
    expect(exp?.status).toBe('running');

    // Metrics are NOT yet collected.
    const metricsBefore = await benchmarkService.getTrialMetrics(trialId!);
    expect(metricsBefore).toBeNull();

    // Drive the delivery lifecycle → workflow to `verified` → trial
    // 'completed' + experiment 'completed'.
    await driveDeliveryLifecycle(benchmarkService, workflowEngine, queue, experiment.id);
    await awaitExperimentCompleted(benchmarkService, experiment.id);
    const finalTrial = (await benchmarkService.listTrials(experiment.id)).trials[0]!;
    expect(finalTrial.status).toBe('completed');
    const metricsAfter = await benchmarkService.getTrialMetrics(trialId!);
    expect(metricsAfter).not.toBeNull();
    expect(metricsAfter!.verifiedAt).not.toBeNull();
  });

  it('mixed (1 native + 1 external) → both running until both workflows verified', async () => {
    const snapshot = await benchmarkService.createSnapshot({
      projectId: fixture.projectId, workItemId: fixture.workItemId, name: 'delivery-mixed-snapshot', actor: fixture.userId,
    });
    const experiment = await benchmarkService.createExperiment({
      projectId: fixture.projectId, benchmarkTaskSnapshotId: snapshot.id, name: 'delivery-mixed-exp',
      trials: [
        { provider: 'fake', mode: 'native', repetitions: 1 },
        { provider: 'fake', mode: 'external', repetitions: 1 },
      ],
      createdBy: fixture.userId,
    });
    await benchmarkService.startExperiment(experiment.id);

    // Wait for BOTH trials to reach 'running' (orchestrator ran for both).
    await waitFor(async () => {
      const { trials } = await benchmarkService.listTrials(experiment.id);
      if (trials.length !== 2) return false;
      const native = trials.find((t) => t.executionMode === 'native');
      const external = trials.find((t) => t.executionMode === 'external');
      return !!native && native.status === 'running' && !!native.workItemId &&
        !!external && external.status === 'running' && !!external.executionId;
    }, { timeoutMs: 10_000, intervalMs: 10 });

    // Both trials are 'running' — execution-done ≠ delivery-complete.
    const trialsMid = (await benchmarkService.listTrials(experiment.id)).trials;
    expect(trialsMid.every((t) => t.status === 'running')).toBe(true);

    // Drive external completion + delivery for ALL trials → experiment
    // reaches 'completed'.
    await driveExternalCompletions(benchmarkService, executionEventIngestionService, experiment.id);
    await driveDeliveryLifecycle(benchmarkService, workflowEngine, queue, experiment.id);
    await awaitExperimentCompleted(benchmarkService, experiment.id);
    const finalExp = await benchmarkService.getExperiment(experiment.id);
    expect(finalExp?.status).toBe('completed');
    const finalTrials = (await benchmarkService.listTrials(experiment.id)).trials;
    expect(finalTrials.every((t) => t.status === 'completed')).toBe(true);
    for (const t of finalTrials) {
      const m = await benchmarkService.getTrialMetrics(t.id);
      expect(m).not.toBeNull();
      expect(m!.verifiedAt).not.toBeNull();
    }
  });
});
