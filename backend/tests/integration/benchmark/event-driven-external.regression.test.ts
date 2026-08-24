/**
 * PR #35 review fix v2 / Blocker A (regression): external execution MUST
 * NOT have a hard 30-second timeout. The previous implementation polled
 * `executionRecordRepository.findByExecutionId` with a bounded
 * `deadline = Date.now() + (externalTimeoutMs ?? 30_000)` + returned
 * `'expired'` when the deadline elapsed, marking the trial failed
 * (infrastructure). Real external (Z.ai/Codex/Claude Code) work takes
 * minutes/hours. A bounded poll that expires is WRONG.
 *
 * The fix: REMOVE the bounded poll entirely. `runTrialJob` does NOT
 * block-wait on external execution. After the orchestrator submits an
 * external execution (trial 'running' + executionId), `runTrialJob`
 * RETURNS. The trial is re-advanced when the authoritative
 * `ExecutionEventIngestionService.ingest()` ingests a terminal event for
 * that executionId — via the `onExecutionTerminal` composition hook on
 * the ingestion service, wired in app.ts to call
 * `benchmarkService.advanceTrialsForExecution(executionId)`, which
 * enqueues a `benchmark.trial` job for matching trials.
 *
 * These regression tests prove:
 *   1. An external trial stays 'running' with NO timeout — well over the
 *      old 30s budget is tolerated (the test uses a shorter real-time
 *      wait + asserts the absence of the 'expired' / 'external-execution-
 *      expired' failure reason + that the trial is still 'running' after
 *      the orchestrator with no ingestion event).
 *   2. When the ingestion event fires, the trial advances (to the
 *      delivery phase — execution-complete ≠ delivery-complete).
 *   3. NO `externalTimeoutMs` is consumed / no bounded poll exists.
 *      Assert the `externalTimeoutMs` deps field is GONE (grep the
 *      service file → 0 hits).
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
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('PR #35 fix v2 / Blocker A — event-driven external (NO bounded poll)', () => {
  let stack: TestAuthStack;
  let fixture: BenchmarkFixture;
  let benchmarkService: BenchmarkService;
  let queue: InMemoryQueue;
  let worker: WorkerHost;
  let executionEventIngestionService: DefaultExecutionEventIngestionService;
  let workflowEngine: WorkflowEngine;

  const API_KEY = 'raw-key-event-driven-ext-a';
  const SECRET_REF = 'WFOS_TEST_KEY_EVENT_DRIVEN_EXT_A';

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
    // PR #35 review fix v2 / Blocker A: wire the `onExecutionTerminal`
    // composition hook so the benchmark service is auto-re-advanced when
    // an external execution reaches a terminal state. This mirrors
    // production (app.ts) wiring — the integration test asserts the
    // event-driven path works end-to-end.
    executionEventIngestionService = new DefaultExecutionEventIngestionService({
      executionRecordRepository, eventRepository: executionEventRepository, auditService, logger: logger as never,
      onExecutionTerminal: async (execId, _state) => {
        if (benchmarkService) {
          await benchmarkService.advanceTrialsForExecution(execId);
        }
      },
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

  /** Create a snapshot + experiment with one external trial. */
  async function makeExperiment(name: string): Promise<{ experimentId: string; snapshotId: string }> {
    const snapshot = await benchmarkService.createSnapshot({
      projectId: fixture.projectId, workItemId: fixture.workItemId, name: `${name}-snapshot`, actor: fixture.userId,
    });
    const exp = await benchmarkService.createExperiment({
      projectId: fixture.projectId, benchmarkTaskSnapshotId: snapshot.id, name,
      trials: [{ provider: 'fake', mode: 'external', repetitions: 1 }], createdBy: fixture.userId,
    });
    return { experimentId: exp.id, snapshotId: snapshot.id };
  }

  it('external trial stays running with NO timeout (NO expired failure reason ever)', async () => {
    const { experimentId } = await makeExperiment('event-driven-no-timeout');
    await benchmarkService.startExperiment(experimentId);

    // Wait for the external trial to reach handoff_ready (executionId set).
    await waitFor(async () => {
      const { trials } = await benchmarkService.listTrials(experimentId);
      return trials.length > 0 && !!trials[0]!.executionId;
    }, { timeoutMs: 10_000, intervalMs: 10 });

    // PR #35 fix v2 / Blocker A: the trial stays 'running' with NO
    // timeout. The OLD 30s `externalTimeoutMs` is GONE — there is NO
    // bounded poll that could expire. Wait briefly (well over the old
    // 25ms poll interval, well under the old 30s budget — but the
    // assertion is the trial does NOT time out, NOT that 30s has
    // elapsed). Assert: trial is STILL 'running' + failureReason is
    // null/empty + does NOT contain 'expired' or 'external-execution-
    // expired'.
    await new Promise((r) => setTimeout(r, 500));
    const exp = await benchmarkService.getExperiment(experimentId);
    expect(exp?.status).toBe('running');

    const { trials } = await benchmarkService.listTrials(experimentId);
    expect(trials[0]!.status).toBe('running');
    expect(trials[0]!.executionId).toBeTruthy();
    // NO 'expired' failure reason ever appears.
    expect(trials[0]!.failureReason ?? '').not.toMatch(/expired/);
    expect(trials[0]!.failureReason ?? '').not.toMatch(/external-execution-expired/);
    expect(trials[0]!.failureKind).toBeNull();

    // Cleanup: drive the external completion + delivery lifecycle so the
    // experiment finalizes + the test doesn't leak state into the next.
    await driveExternalCompletions(benchmarkService, executionEventIngestionService, experimentId);
    await driveDeliveryLifecycle(benchmarkService, workflowEngine, queue, experimentId);
    await awaitExperimentCompleted(benchmarkService, experimentId);
  });

  it('ingestion event advances the trial to the delivery phase (NOT completed)', async () => {
    const { experimentId } = await makeExperiment('event-driven-ingest-advances');
    await benchmarkService.startExperiment(experimentId);

    // Wait for the external trial to reach handoff_ready.
    let trialId: string | null = null;
    let executionId: string | null = null;
    await waitFor(async () => {
      const { trials } = await benchmarkService.listTrials(experimentId);
      if (trials.length === 0) return false;
      if (trials[0]!.executionId) {
        trialId = trials[0]!.id;
        executionId = trials[0]!.executionId;
        return true;
      }
      return false;
    }, { timeoutMs: 10_000, intervalMs: 10 });
    expect(trialId).not.toBeNull();
    expect(executionId).not.toBeNull();

    // Before ingestion: trial is 'running' (handoff_ready, not terminal).
    const beforeTrial = (await benchmarkService.listTrials(experimentId)).trials[0]!;
    expect(beforeTrial.status).toBe('running');

    // Ingest the `completed` event. The `onExecutionTerminal` callback
    // (wired in beforeAll) auto-re-advances the trial via
    // `benchmarkService.advanceTrialsForExecution(executionId)` →
    // enqueues `benchmark.trial` → worker re-enters `runTrialJob` →
    // EXECUTION PHASE reads the now-terminal execution record → DELIVERY
    // PHASE reads workflowEngine.getState(workItemId) (still 'ready' →
    // not terminal) → trial stays 'running' (delivery phase).
    await executionEventIngestionService.ingest({
      executionId: executionId!,
      eventType: 'completed',
      commitRef: `${executionId}-commit-0`,
      pullRequestRef: `${executionId}-pr-1`,
      idempotencyKey: `${executionId}-completed`,
    });

    // Wait briefly for the worker to process the auto-enqueued job. The
    // trial stays 'running' (delivery phase — workflow state is the
    // authority, NOT execution state).
    await new Promise((r) => setTimeout(r, 200));
    const midTrial = (await benchmarkService.listTrials(experimentId)).trials[0]!;
    expect(midTrial.status).toBe('running'); // NOT 'completed' — delivery phase
    expect(midTrial.failureKind).toBeNull();

    // Cleanup: drive the delivery lifecycle → workflow to `verified` →
    // trial 'completed' + experiment 'completed'.
    await driveDeliveryLifecycle(benchmarkService, workflowEngine, queue, experimentId);
    await awaitExperimentCompleted(benchmarkService, experimentId);
    const expFinal = await benchmarkService.getExperiment(experimentId);
    expect(expFinal?.status).toBe('completed');
    const finalTrial = (await benchmarkService.listTrials(experimentId)).trials[0]!;
    expect(finalTrial.status).toBe('completed');
  });

  it('NO externalTimeoutMs / awaitExternalCompletion in the benchmark service file (grep code, not comments)', async () => {
    // PR #35 fix v2 / Blocker A: the `externalTimeoutMs` deps field +
    // `awaitExternalCompletion` private method are GONE from the
    // benchmark service CODE. The docstrings still MENTION these tokens
    // (explaining that they were removed) — that's expected. We strip
    // comments before grepping so we assert the CODE is clean.
    const stripComments = (src: string): string =>
      src
        .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
        .replace(/^[ \t]*\/\/.*$/gm, '');    // line comments
    const servicePath = path.resolve(
      process.cwd(),
      'src/benchmark/internal/benchmark-service.ts',
    );
    const src = stripComments(fs.readFileSync(servicePath, 'utf8'));
    expect(src).not.toMatch(/externalTimeoutMs/);
    expect(src).not.toMatch(/awaitExternalCompletion/);
    // The deps interface (in benchmark.types.ts) is also clean.
    const typesPath = path.resolve(
      process.cwd(),
      'src/benchmark/internal/benchmark.types.ts',
    );
    const typesSrc = stripComments(fs.readFileSync(typesPath, 'utf8'));
    expect(typesSrc).not.toMatch(/externalTimeoutMs/);
    // The app.ts composition root no longer references the field in code.
    const appPath = path.resolve(process.cwd(), 'src/app.ts');
    const appSrc = stripComments(fs.readFileSync(appPath, 'utf8'));
    expect(appSrc).not.toMatch(/externalTimeoutMs/);
    expect(appSrc).not.toMatch(/benchmarkExternalTimeoutMs/);
  });
});
