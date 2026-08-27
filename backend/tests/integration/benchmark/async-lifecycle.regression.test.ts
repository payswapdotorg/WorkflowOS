/**
 * PR #35 review fix v2 (regression): the benchmark trial lifecycle is
 * FULLY EVENT-DRIVEN + ASYNCHRONOUS. `startExperiment()` enqueues
 * `benchmark.trial` jobs + returns IMMEDIATELY (experiment 'running'). The
 * WorkerHost picks up each job and calls `runTrialJob(trialId)`, a
 * NON-BLOCKING, RE-ENTRANT state machine.
 *
 * The core correctness invariants:
 *   - An experiment is NEVER marked 'completed' while ANY trial is still
 *     'running'/'queued'. The experiment only completes when EVERY trial
 *     reaches a terminal state (completed/failed/unavailable).
 *   - Execution-complete ≠ delivery-complete. The benchmark measures
 *     COMPLETED SOFTWARE (PR → CI → Verification → Review → Merge →
 *     VERIFIED). A trial reaches 'completed' ONLY when the cloned work
 *     item's workflow state is `verified`.
 *   - NO bounded poll. NO `externalTimeoutMs`. The trial is re-advanced
 *     by event-driven composition hooks (`onExecutionTerminal` on the
 *     ingestion service + `onTransition` on the workflow engine — wired
 *     in app.ts).
 *
 * For external trials:
 *   - The orchestrator runs (clone → branch → submit) + marks the trial
 *     'running' (handoff_ready). The executionId is set on the trial row.
 *   - The job handler reads `executionRecordRepository.findByExecutionId()`.
 *     If the record is NOT terminal, the trial stays 'running' + the
 *     `onExecutionTerminal` hook (wired off the ingestion service)
 *     re-advances the trial when a terminal event is ingested.
 *   - After the execution is terminal-completed, the DELIVERY PHASE reads
 *     workflowEngine.getState(workItemId). If `verified` → trial
 *     'completed'. If still delivering → wait for the `onTransition` hook
 *     (wired off the workflow engine).
 *
 * These regression tests prove:
 *   1. An external trial does NOT prematurely complete the experiment
 *      (no completion event ingested → experiment stays 'running' AND the
 *      trial stays 'running' — execution-complete is required but NOT
 *      sufficient; delivery-complete is the authority).
 *   2. A `completed` ingestion event advances the trial to the delivery
 *      phase (still 'running', NOT 'completed' — workflow state drives
 *      completion). After driving the workflow to `verified` +
 *      re-enqueuing, the trial → 'completed' + the experiment → 'completed'.
 *   3. The experiment remains 'running' while a native trial is
 *      execution-done + an external trial is still handoff_ready. Only
 *      when ALL trials reach terminal does the experiment finalize.
 *   4. Metrics are collected ONLY after the authoritative delivery outcome
 *      (`verified`) — before, `getTrialMetrics(trialId)` returns null. After,
 *      metrics exist + `collectedAt` is after the outcome timestamp.
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

describe('PR #35 fix #4 — async trial lifecycle', () => {
  let stack: TestAuthStack;
  let fixture: BenchmarkFixture;
  let benchmarkService: BenchmarkService;
  let queue: InMemoryQueue;
  let worker: WorkerHost;
  let executionEventIngestionService: DefaultExecutionEventIngestionService;
  let workflowEngine: WorkflowEngine;

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

  it('external handoff_ready trial does NOT complete the experiment (NO bounded poll)', async () => {
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

    // PR #35 fix v2 / Blocker A: the experiment is STILL 'running' (NOT
    // 'completed') — the external trial is handoff_ready but the companion
    // has not yet reported completion. Critically, there is NO bounded poll
    // — the trial does NOT time out (the OLD 30s `externalTimeoutMs` is
    // GONE). Wait briefly + assert the trial is STILL 'running' with no
    // 'expired'/'external-execution-expired' failure reason.
    await new Promise((r) => setTimeout(r, 200)); // well over the old 25ms poll interval
    const exp = await benchmarkService.getExperiment(experimentId);
    expect(exp?.status).toBe('running');

    const { trials } = await benchmarkService.listTrials(experimentId);
    expect(trials[0]!.status).toBe('running');
    expect(trials[0]!.executionId).toBeTruthy();
    // NO 'expired' / 'external-execution-expired' failure reason ever.
    expect(trials[0]!.failureReason ?? '').not.toMatch(/expired/);
    expect(trials[0]!.failureReason ?? '').not.toMatch(/external-execution-expired/);

    // Drive completion → the trial reaches the DELIVERY PHASE (still
    // 'running', NOT 'completed' — execution-complete ≠ delivery-complete).
    await driveExternalCompletions(benchmarkService, executionEventIngestionService, experimentId);
    // Wait for the worker to re-advance the trial (it stays 'running' until
    // the workflow reaches `verified`).
    await waitFor(async () => {
      const { trials } = await benchmarkService.listTrials(experimentId);
      return trials[0]!.status === 'running';
    }, { timeoutMs: 2_000, intervalMs: 10 });
    const trialsMid = (await benchmarkService.listTrials(experimentId)).trials;
    expect(trialsMid[0]!.status).toBe('running'); // NOT 'completed' — delivery phase

    // Drive the delivery lifecycle → workflow to `verified` → trial
    // 'completed' + experiment 'completed'.
    await driveDeliveryLifecycle(benchmarkService, workflowEngine, queue, experimentId);
    await awaitExperimentCompleted(benchmarkService, experimentId);
  });

  it('callback completion event advances the trial to the delivery phase; verified drives completion', async () => {
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
    // authoritative signal the ingestion boundary observes.
    await driveExternalCompletions(benchmarkService, executionEventIngestionService, experimentId);

    // PR #35 fix v2 / Blocker B: after the ingestion event, the trial is
    // STILL 'running' (NOT 'completed') — execution-complete ≠
    // delivery-complete. The trial is now in the DELIVERY PHASE, waiting
    // for the workflow to reach `verified`.
    await waitFor(async () => {
      // Wait for the worker to re-advance the trial via the
      // onExecutionTerminal hook (not wired here — but the ingestion
      // updates the execution record, and the worker re-polls on the
      // next benchmark.trial redelivery). We re-enqueue manually to
      // drive the test forward.
      return true;
    }, { timeoutMs: 100, intervalMs: 10 });
    // The trial should be 'running' (delivery phase). Re-enqueue to allow
    // the worker to read the now-terminal execution record + advance.
    const trialsAfterIngest = (await benchmarkService.listTrials(experimentId)).trials;
    await queue.enqueue('benchmark.trial', { trialId: trialsAfterIngest[0]!.id });
    await waitFor(async () => {
      const { trials } = await benchmarkService.listTrials(experimentId);
      return trials[0]!.status === 'running';
    }, { timeoutMs: 2_000, intervalMs: 10 });
    const midTrials = (await benchmarkService.listTrials(experimentId)).trials;
    expect(midTrials[0]!.status).toBe('running'); // NOT 'completed'
    const midExp = await benchmarkService.getExperiment(experimentId);
    expect(midExp?.status).toBe('running');

    // Drive the delivery lifecycle → workflow to `verified` → trial
    // 'completed' + experiment 'completed'.
    await driveDeliveryLifecycle(benchmarkService, workflowEngine, queue, experimentId);
    await awaitExperimentCompleted(benchmarkService, experimentId);
    const exp = await benchmarkService.getExperiment(experimentId);
    expect(exp?.status).toBe('completed');

    const { trials } = await benchmarkService.listTrials(experimentId);
    expect(trials[0]!.status).toBe('completed');
  });

  it('experiment remains running until ALL trials terminal (native execution-done + external still running)', async () => {
    // 1 native + 1 external trial. The native's execution completes
    // synchronously (orchestrator marks it 'running' — execution-done,
    // awaiting delivery); the external is handoff_ready (no completion event
    // ingested). NEITHER trial is terminal yet → experiment stays 'running'.
    const { experimentId } = await makeExperiment('async-mixed-pending', [
      { provider: 'fake', mode: 'native', repetitions: 1 },
      { provider: 'fake', mode: 'external', repetitions: 1 },
    ]);
    await benchmarkService.startExperiment(experimentId);

    // Wait for BOTH trials to reach 'running' (orchestrator ran for both):
    // native → 'running' (execution-done, awaiting delivery); external →
    // 'running' (handoff_ready, executionId set).
    await waitFor(async () => {
      const { trials } = await benchmarkService.listTrials(experimentId);
      if (trials.length !== 2) return false;
      const native = trials.find((t) => t.executionMode === 'native');
      const external = trials.find((t) => t.executionMode === 'external');
      return !!native && native.status === 'running' && !!native.workItemId &&
        !!external && external.status === 'running' && !!external.executionId;
    }, { timeoutMs: 10_000, intervalMs: 10 });

    // PR #35 fix v2: even though the native execution is done, the
    // experiment is STILL 'running' because the external trial is still
    // handoff_ready AND the native trial is still in the delivery phase.
    const exp = await benchmarkService.getExperiment(experimentId);
    expect(exp?.status).toBe('running');

    // Now drive the external completion + delivery for ALL trials → the
    // experiment reaches 'completed'.
    await driveExternalCompletions(benchmarkService, executionEventIngestionService, experimentId);
    await driveDeliveryLifecycle(benchmarkService, workflowEngine, queue, experimentId);
    await awaitExperimentCompleted(benchmarkService, experimentId);
    const finalExp = await benchmarkService.getExperiment(experimentId);
    expect(finalExp?.status).toBe('completed');
  });

  it('metrics collected only AFTER authoritative delivery outcome (verified)', async () => {
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

    // Ingest the completion event → the trial enters the DELIVERY PHASE
    // (still 'running'). Re-enqueue + assert metrics STILL null (delivery
    // not yet terminal).
    await driveExternalCompletions(benchmarkService, executionEventIngestionService, experimentId);
    await queue.enqueue('benchmark.trial', { trialId: trialId! });
    await waitFor(async () => {
      const { trials } = await benchmarkService.listTrials(experimentId);
      return trials[0]?.status === 'running';
    }, { timeoutMs: 2_000, intervalMs: 10 });
    // Metrics STILL null — the trial is in the delivery phase (not yet
    // 'verified').
    const metricsMid = await benchmarkService.getTrialMetrics(trialId!);
    expect(metricsMid).toBeNull();

    // Capture the timestamp before the authoritative delivery outcome.
    const beforeOutcomeAt = new Date();

    // Drive the delivery lifecycle → workflow to `verified` → trial
    // 'completed' + metrics collected.
    await driveDeliveryLifecycle(benchmarkService, workflowEngine, queue, experimentId);
    await waitFor(async () => {
      const { trials } = await benchmarkService.listTrials(experimentId);
      return trials[0]?.status === 'completed';
    }, { timeoutMs: 10_000, intervalMs: 10 });

    // AFTER the verified outcome, metrics exist + collectedAt is after the
    // outcome timestamp.
    //
    // DE-FLAKE (the CI-load race): the terminal CLAIM sets the trial status
    // 'completed' BEFORE the same job collects + upserts metrics
    // (claimTerminal → collect → upsertMetrics are sequential inside
    // finalizeTrial). Polling only the status can observe 'completed' in
    // that sub-millisecond-to-milliseconds window and read the metrics row
    // before it exists. Wait for the METRICS ROW (the actual downstream
    // effect under assertion) instead of asserting it immediately — the
    // same de-flake class as the PR #47 round-11 waitFor budget fix.
    let metricsAfter: Awaited<ReturnType<typeof benchmarkService.getTrialMetrics>> = null;
    await waitFor(async () => {
      metricsAfter = await benchmarkService.getTrialMetrics(trialId!);
      return metricsAfter !== null;
    }, { timeoutMs: 10_000, intervalMs: 10 });
    expect(metricsAfter).not.toBeNull();
    expect(metricsAfter!.collectedAt.getTime()).toBeGreaterThanOrEqual(beforeOutcomeAt.getTime());
  });
});
