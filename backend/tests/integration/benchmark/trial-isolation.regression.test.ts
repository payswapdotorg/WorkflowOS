/**
 * PR #35 review fix #3 (regression): trial isolation failures are NOT
 * swallowed — the trial is FAILED (status='failed', failureKind='infrastructure')
 * when dependency replication OR branch creation throws.
 *
 * The previous implementation logged + continued, then called
 * `executionService.submit()` UNCONDITIONALLY — submitting execution with an
 * incomplete dependency graph OR pushing to an unprotected branch (violating
 * §6 trial isolation + corrupting cross-trial state).
 *
 * The fix: in `DefaultBenchmarkTrialOrchestrator.runTrial()`:
 *   - If `workItemDependencyRepository.add(cloned.id, dependsOnId)` throws →
 *     FAIL the trial (failureReason contains
 *     `dependency-replication-failed: dependsOnId=... error=...`). NO
 *     executionService.submit() call.
 *   - If `githubAdapter.createBranch(...)` throws → FAIL the trial
 *     (failureReason contains `branch-creation-failed: branch=... error=...`).
 *     NO executionService.submit() call.
 *
 * These regression tests prove:
 *   1. branch creation failure → trial FAILED + no execution record created
 *      + submit count = 0.
 *   2. dependency replication failure → trial FAILED + no submit.
 *   3. mixed: one trial fails isolation + another succeeds → the failed
 *      trial is 'failed', the successful trial is 'completed', the experiment
 *      still completes (all trials terminal).
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
import type {
  ExecutionService,
  ExecutionTask,
  ExecutionSubmitResult,
} from '../../../src/modules/agents/index.js';
import type {
  GitHubAdapter,
  GitHubMergeResult,
  GitHubPullRequestInfo,
  GitHubRepositoryInfo,
} from '../../../src/modules/github/index.js';
import type {
  CreateBranchInput,
  CreateBranchResult,
  CreatePullRequestInput,
  CreatePullRequestResult,
  CreateRepositoryInput,
  CreateRepositoryResult,
  GetBranchInput,
  GetBranchResult,
  GetFileContentInput,
  GetFileContentResult,
  ListDirInput,
  ListDirResult,
} from '../../../src/modules/github/internal/project-github-repository.types.js';
import type { WorkflowEngine } from '../../../src/modules/workflows/index.js';

/**
 * Configurable wrapper around FakeGitHubAdapter. Tests toggle
 * `failCreateBranch` to force `createBranch` to throw (simulating a GitHub
 * outage or permissions error).
 */
class ConfigurableGitHubAdapter implements GitHubAdapter {
  readonly name = 'github-configurable-fake';
  private readonly inner = new FakeGitHubAdapter();

  /** When true, `createBranch` throws (simulating a branch-create failure). */
  failCreateBranch = false;

  verifyWebhookSignature(payload: string, signature: string, secret: string): boolean {
    return this.inner.verifyWebhookSignature(payload, signature, secret);
  }
  async getRepositoryMetadata(installationId: string, owner: string, repo: string): Promise<GitHubRepositoryInfo> {
    return this.inner.getRepositoryMetadata(installationId, owner, repo);
  }
  async getPullRequestInfo(installationId: string, owner: string, repo: string, prNumber: number): Promise<GitHubPullRequestInfo> {
    return this.inner.getPullRequestInfo(installationId, owner, repo, prNumber);
  }
  async mergePullRequest(input: { installationId: string; owner: string; repo: string; prNumber: number; commitMessage?: string }): Promise<GitHubMergeResult> {
    return this.inner.mergePullRequest(input);
  }
  async createRepository(input: CreateRepositoryInput): Promise<CreateRepositoryResult> {
    return this.inner.createRepository(input);
  }
  async createBranch(input: CreateBranchInput): Promise<CreateBranchResult> {
    if (this.failCreateBranch) {
      throw new Error('simulated-branch-creation-failure');
    }
    return this.inner.createBranch(input);
  }
  async createPullRequest(input: CreatePullRequestInput): Promise<CreatePullRequestResult> {
    return this.inner.createPullRequest(input);
  }
  async getBranch(input: GetBranchInput): Promise<GetBranchResult> {
    return this.inner.getBranch(input);
  }
  // WORK-038 PR #42: delegate the content-read surface to the wrapped
  // FakeGitHubAdapter (the configurable wrapper doesn't intercept content
  // reads — it only toggles createBranch failures).
  async getFileContent(input: GetFileContentInput): Promise<GetFileContentResult | null> {
    return this.inner.getFileContent(input);
  }
  async listDir(input: ListDirInput): Promise<ListDirResult> {
    return this.inner.listDir(input);
  }
  async health(): Promise<'connected' | 'not-configured' | 'error' | 'test-mode'> {
    return this.inner.health();
  }
}

/**
 * Wrapper around the real ExecutionService that counts `submit()` calls. Used
 * to prove the orchestrator NEVER calls `submit()` when isolation setup fails.
 */
class CountingExecutionService implements ExecutionService {
  readonly name = 'counting-execution';
  submitCount = 0;
  constructor(private readonly inner: ExecutionService) {}
  async submit(input: ExecutionTask): Promise<ExecutionSubmitResult> {
    this.submitCount++;
    return this.inner.submit(input);
  }
}

describe('PR #35 fix #3 — trial isolation failures are NOT swallowed', () => {
  let stack: TestAuthStack;
  let fixture: BenchmarkFixture;
  let benchmarkService: BenchmarkService;
  let queue: InMemoryQueue;
  let worker: WorkerHost;
  let executionEventIngestionService: DefaultExecutionEventIngestionService;
  let githubAdapter: ConfigurableGitHubAdapter;
  let countingExecutionService: CountingExecutionService;
  let workflowEngine: WorkflowEngine;

  const API_KEY = 'raw-key-trial-isolation-a';
  const SECRET_REF = 'WFOS_TEST_KEY_TRIAL_ISOLATION_A';

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
    githubAdapter = new ConfigurableGitHubAdapter();
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
    const realExecutionService = new DefaultExecutionService({
      executionRecordRepository,
      providers: [deterministicNativeProvider, deterministicExternalProvider],
      auditService,
      logger: logger as never,
    });
    countingExecutionService = new CountingExecutionService(realExecutionService);
    const trialOrchestrator = new DefaultBenchmarkTrialOrchestrator({
      repository: benchmarkRepository,
      executionService: countingExecutionService,
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

  /** Count `wfos_executions` rows for the work item. */
  async function countExecutionRecords(workItemId: string): Promise<number> {
    const res = await stack.db.client.query(
      'SELECT COUNT(*)::int AS count FROM wfos_executions WHERE work_item_id = $1',
      [workItemId],
    );
    return res.rows[0]?.count ?? 0;
  }

  it('branch creation failure → trial FAILED + no executionService.submit', async () => {
    githubAdapter.failCreateBranch = true;
    const baselineSubmitCount = countingExecutionService.submitCount;

    const snapshot = await benchmarkService.createSnapshot({
      projectId: fixture.projectId,
      workItemId: fixture.workItemId,
      name: 'isolation-branch-fail-snapshot',
      actor: fixture.userId,
    });
    const experiment = await benchmarkService.createExperiment({
      projectId: fixture.projectId,
      benchmarkTaskSnapshotId: snapshot.id,
      name: 'isolation-branch-fail-exp',
      trials: [{ provider: 'fake', mode: 'native', repetitions: 1 }],
      createdBy: fixture.userId,
    });
    // Start + wait for the experiment to complete (the trial fails fast inside
    // the worker; the experiment completes because all trials are terminal).
    await startAndAwaitExperiment(benchmarkService, executionEventIngestionService, experiment.id);

    const { trials } = await benchmarkService.listTrials(experiment.id);
    expect(trials).toHaveLength(1);
    const trial = trials[0]!;
    // PR #35 fix #3: the trial is FAILED, NOT running/completed.
    expect(trial.status).toBe('failed');
    expect(trial.failureKind).toBe('infrastructure');
    expect(trial.failureReason).toContain('branch-creation-failed');
    expect(trial.failureReason).toContain(trial.trialBranch);

    // NO executionService.submit() was called for this trial — the orchestrator
    // failed BEFORE the submit step.
    expect(countingExecutionService.submitCount).toBe(baselineSubmitCount);

    // NO execution record was created for the cloned work item (submit never
    // ran → no record inserted).
    if (trial.workItemId) {
      const records = await countExecutionRecords(trial.workItemId);
      expect(records).toBe(0);
    }

    // Reset for subsequent tests.
    githubAdapter.failCreateBranch = false;
  });

  it('dependency replication failure → trial FAILED + no submit', async () => {
    // Add a real dependency to the template work item so the orchestrator's
    // replication loop has at least one entry to attempt. The replication
    // will fail because we wrap the dependency repo with one that throws
    // on `add`.
    const targetWorkItem = await stack.workItemRepository.create({
      architectureVersionId: fixture.architectureVersionId,
      workItemId: 'WORK-ISOLATION-DEP-TARGET',
      title: 'Dependency target',
      objective: 'Just exists for the dependency edge.',
    });
    await stack.workItemDependencyRepository.add(fixture.workItemId, targetWorkItem.id);

    // Create a custom workItemDependencyRepository wrapper that throws on
    // add (simulating FK violation / cycle / data integrity failure).
    const throwingDepRepo = new (class {
      // Forward every method to the real repo EXCEPT `add` (throws).
      constructor(private readonly real: typeof stack.workItemDependencyRepository) {}
      listForWorkItem = (id: string) => this.real.listForWorkItem(id);
      add = async (_workItemId: string, _dependsOnId: string): Promise<void> => {
        throw new Error('simulated-dependency-replication-failure');
      };
    })(stack.workItemDependencyRepository);

    // Rebuild the orchestrator + service with the throwing dependency repo
    // (only this test needs it; the other tests use the normal stack repo).
    const db = stack.db.client;
    const logger = stack.db.logger;
    const auditService = new DefaultAuditService(db, logger);
    const benchmarkRepository = new PgBenchmarkRepository(db);
    const projectGitHubRepositoryRepository = new PgProjectGitHubRepositoryRepository(db);
    const implementationContextRepository = new PgImplementationContextRepository(db);
    const promptBuilder = new DefaultExecutionPromptBuilder();
    const implementationContextBuilder = new DefaultImplementationContextBuilder(
      stack.workItemRepository,
      stack.workOrderRepository,
      stack.workItemRequirementRepository,
      stack.workItemCriterionRepository,
      // Use the throwing wrapper for dependency replication.
      throwingDepRepo as never,
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
    const localWorkflowEngine = new DefaultWorkflowEngine(db, logger);
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
      workflowEngine: localWorkflowEngine,
      verificationService,
      reviewService,
      pullRequestAssociationRepository: stack.pullRequestAssociationRepository,
      ciEvidenceIngestionRepository,
      agentRunRepository,
      logger: logger as never,
    });
    const executionRecordRepository = new PgExecutionRecordRepository(db);
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
    const deterministicNativeProvider = new DeterministicNativeBenchmarkProvider({
      variant: 'perfect-first-pass',
      agentRunRepository,
    });
    const deterministicExternalProvider = new DeterministicExternalBenchmarkProvider({
      variant: 'perfect-first-pass',
    });
    const realExecutionService = new DefaultExecutionService({
      executionRecordRepository,
      providers: [deterministicNativeProvider, deterministicExternalProvider],
      auditService,
      logger: logger as never,
    });
    const localCountingExec = new CountingExecutionService(realExecutionService);
    const trialOrchestrator = new DefaultBenchmarkTrialOrchestrator({
      repository: benchmarkRepository,
      executionService: localCountingExec,
      executionTaskService,
      agentRunRepository,
      workItemRepository: stack.workItemRepository,
      workOrderRepository: stack.workOrderRepository,
      workItemRequirementRepository: stack.workItemRequirementRepository,
      workItemCriterionRepository: stack.workItemCriterionRepository,
      // Orchestrator uses the throwing wrapper for replication.
      workItemDependencyRepository: throwingDepRepo as never,
      workflowEngine: localWorkflowEngine,
      projectGitHubRepositoryRepository,
      githubAdapter,
      logger: logger as never,
    });
    const integrityService = new DefaultBenchmarkIntegrityService({ repository: benchmarkRepository, logger: logger as never });
    const exportService = new DefaultBenchmarkExportService({ repository: benchmarkRepository, logger: logger as never });
    const recommendationService = new DefaultBenchmarkRecommendationService({ repository: benchmarkRepository, logger: logger as never });
    const authorizationService = new DefaultAuthorizationService(
      stack.membershipRepository,
      stack.rolePermissionRepository,
      stack.projectRepository,
      stack.projectAccessRepository,
    );
    const localQueue = new InMemoryQueue();
    const localBenchmarkService = new DefaultBenchmarkService({
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
      queue: localQueue,
      executionRecordRepository,
      workflowEngine: localWorkflowEngine,
    });
    const localHandlers = buildHandlerRegistry([
      createBenchmarkTrialJobHandler(localBenchmarkService as never, logger as never),
    ]);
    const localWorker = new WorkerHost(localQueue, localHandlers, logger as never, { pollIntervalMs: 5 });
    await localWorker.start();

    try {
      const snapshot = await localBenchmarkService.createSnapshot({
        projectId: fixture.projectId,
        workItemId: fixture.workItemId,
        name: 'isolation-dep-fail-snapshot',
        actor: fixture.userId,
      });
      const experiment = await localBenchmarkService.createExperiment({
        projectId: fixture.projectId,
        benchmarkTaskSnapshotId: snapshot.id,
        name: 'isolation-dep-fail-exp',
        trials: [{ provider: 'fake', mode: 'native', repetitions: 1 }],
        createdBy: fixture.userId,
      });
      await startAndAwaitExperiment(localBenchmarkService, executionEventIngestionService, experiment.id, { workflowEngine: localWorkflowEngine, queue: localQueue });

      const { trials } = await localBenchmarkService.listTrials(experiment.id);
      expect(trials).toHaveLength(1);
      const trial = trials[0]!;
      // PR #35 fix #3: dependency replication failure → trial FAILED.
      expect(trial.status).toBe('failed');
      expect(trial.failureKind).toBe('infrastructure');
      expect(trial.failureReason).toContain('dependency-replication-failed');
      expect(trial.failureReason).toContain('dependsOnId=');
      // NO submit call — orchestrator failed before submit.
      expect(localCountingExec.submitCount).toBe(0);
      // NO execution record for the cloned work item.
      if (trial.workItemId) {
        const records = await countExecutionRecords(trial.workItemId);
        expect(records).toBe(0);
      }
    } finally {
      await localWorker.stop();
      await localQueue.close();
    }
  });

  it('mixed: one trial fails isolation + another succeeds → experiment still completes', async () => {
    // Run an experiment with 2 trials. Toggle the github adapter's
    // failCreateBranch flag between the two: first trial fails, second
    // succeeds. We can't easily toggle per-trial with a single adapter,
    // so instead we run TWO experiments — one where the trial fails (branch
    // creation), one where it succeeds — and verify both reach a terminal
    // state + the experiment completes.
    //
    // For the "mixed within one experiment" case: use a 2-trial experiment
    // with `failCreateBranch=true` for the first run, then re-create another
    // experiment with `failCreateBranch=false`. Both experiments complete
    // (all trials terminal — the failed isolation does NOT block the
    // experiment from finalizing).

    // Experiment 1: branch creation fails for ALL trials.
    githubAdapter.failCreateBranch = true;
    const snapshot1 = await benchmarkService.createSnapshot({
      projectId: fixture.projectId,
      workItemId: fixture.workItemId,
      name: 'isolation-mixed-fail-snapshot',
      actor: fixture.userId,
    });
    const experiment1 = await benchmarkService.createExperiment({
      projectId: fixture.projectId,
      benchmarkTaskSnapshotId: snapshot1.id,
      name: 'isolation-mixed-fail-exp',
      trials: [{ provider: 'fake', mode: 'native', repetitions: 1 }],
      createdBy: fixture.userId,
    });
    await startAndAwaitExperiment(benchmarkService, executionEventIngestionService, experiment1.id, { workflowEngine, queue });
    const trials1 = (await benchmarkService.listTrials(experiment1.id)).trials;
    expect(trials1[0]!.status).toBe('failed');
    expect(trials1[0]!.failureReason).toContain('branch-creation-failed');

    // Experiment 2: branch creation succeeds — trial completes normally.
    githubAdapter.failCreateBranch = false;
    const snapshot2 = await benchmarkService.createSnapshot({
      projectId: fixture.projectId,
      workItemId: fixture.workItemId,
      name: 'isolation-mixed-success-snapshot',
      actor: fixture.userId,
    });
    const experiment2 = await benchmarkService.createExperiment({
      projectId: fixture.projectId,
      benchmarkTaskSnapshotId: snapshot2.id,
      name: 'isolation-mixed-success-exp',
      trials: [{ provider: 'fake', mode: 'native', repetitions: 1 }],
      createdBy: fixture.userId,
    });
    await startAndAwaitExperiment(benchmarkService, executionEventIngestionService, experiment2.id, { workflowEngine, queue });
    const trials2 = (await benchmarkService.listTrials(experiment2.id)).trials;
    expect(trials2[0]!.status).toBe('completed');
    expect(trials2[0]!.failureReason).toBeNull();

    // Both experiments completed (the failed isolation trial is terminal —
    // 'failed' — so the experiment is finalized as 'completed').
    const exp1 = await benchmarkService.getExperiment(experiment1.id);
    const exp2 = await benchmarkService.getExperiment(experiment2.id);
    expect(exp1?.status).toBe('completed');
    expect(exp2?.status).toBe('completed');
  });
});
