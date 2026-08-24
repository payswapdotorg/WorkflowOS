/**
 * PR #35 review fix v2 / Blocker C (regression): branch isolation MUST FAIL
 * CLOSED when a project↔GitHub repository link is missing — the orchestrator
 * must NOT silently skip branch creation + proceed to submit execution. A
 * snapshot can outlive its repository link (the link row may be removed
 * after the snapshot was frozen), so the orchestrator's branch isolation
 * step must be a hard gate.
 *
 * The previous implementation:
 *   ```
 *   const repoLink = await findByProject(snapshot.projectId);
 *   if (repoLink) { try { createBranch } catch { failTrial } }
 *   ```
 * skipped branch creation when `repoLink` was null/undefined, then proceeded
 * to `executionService.submit()` — pushing execution to an UNISOLATED branch
 * (no branch was created). This violated §6 trial isolation + corrupted
 * cross-trial state.
 *
 * The fix:
 *   ```
 *   const repoLink = await findByProject(snapshot.projectId);
 *   if (!repoLink) {
 *     return failTrial(trial.id, 'infrastructure', 'repository-link-missing');
 *   }
 *   ```
 *
 * These regression tests prove (the snapshot is frozen WHILE the link
 * exists, then the link is removed to simulate the snapshot-outliving-link
 * scenario; the orchestrator then runs against the snapshot + fails
 * closed):
 *   1. A snapshot whose project has NO project↔GitHub repository link → the
 *      trial is 'failed' with failureReason containing
 *      'repository-link-missing'.
 *   2. `executionService.submit` was NEVER called (CountingExecutionService
 *      spy → submitCount === 0).
 *   3. NO branch was created (SpyGitHubAdapter → createBranch call count 0).
 *   4. The experiment STILL completes (every trial is terminal — the failed
 *      trial is terminal 'failed').
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
} from '../../../src/modules/agents/internal/pg-execution-repository.js';
import { DefaultExecutionEventIngestionService } from '../../../src/modules/agents/internal/execution-event-ingestion-service.js';
import { FakeGitHubAdapter } from '../../../src/modules/github/internal/fake-github-adapter.js';
import { PgCiEvidenceIngestionRepository } from '../../../src/modules/github/internal/pg-ci-evidence-repository.js';
import { DefaultReviewService } from '../../../src/modules/reviews/internal/review-service.js';
import { DefaultAuthorizationService } from '../../../src/modules/auth/internal/authorization-service.js';
import { PgProjectGitHubRepositoryRepository } from '../../../src/modules/github/internal/pg-project-github-repository-repository.js';
import type { BenchmarkService } from '../../../src/benchmark/index.js';
import type { WorkflowEngine } from '../../../src/modules/workflows/index.js';
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
} from '../../../src/modules/github/internal/project-github-repository.types.js';

/**
 * Spy GitHubAdapter that counts `createBranch` calls. Wraps FakeGitHubAdapter
 * so the rest of the surface (signature verification, getRepositoryMetadata,
 * etc.) still works for the snapshot service + the orchestrator's branch
 * isolation path.
 */
class SpyGitHubAdapter implements GitHubAdapter {
  readonly name = 'github-spy-fake';
  private readonly inner = new FakeGitHubAdapter();
  createBranchCallCount = 0;

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
    this.createBranchCallCount++;
    return this.inner.createBranch(input);
  }
  async createPullRequest(input: CreatePullRequestInput): Promise<CreatePullRequestResult> {
    return this.inner.createPullRequest(input);
  }
  async getBranch(input: GetBranchInput): Promise<GetBranchResult> {
    return this.inner.getBranch(input);
  }
  async health(): Promise<'connected' | 'not-configured' | 'error' | 'test-mode'> {
    return this.inner.health();
  }
}

/**
 * Counting wrapper around the real ExecutionService — proves the
 * orchestrator NEVER called `submit()` (the trial failed at branch isolation
 * before reaching the submit step).
 */
class CountingExecutionService implements ExecutionService {
  readonly name = 'counting-execution-missing-repo-link';
  submitCount = 0;
  constructor(private readonly inner: ExecutionService) {}
  async submit(input: ExecutionTask): Promise<ExecutionSubmitResult> {
    this.submitCount++;
    return this.inner.submit(input);
  }
}

describe('PR #35 fix v2 / Blocker C — missing repo link fails closed', () => {
  let stack: TestAuthStack;
  let fixture: BenchmarkFixture;
  let benchmarkService: BenchmarkService;
  let queue: InMemoryQueue;
  let worker: WorkerHost;
  let executionEventIngestionService: DefaultExecutionEventIngestionService;
  let workflowEngine: WorkflowEngine;
  let githubAdapter: SpyGitHubAdapter;
  let countingExecutionService: CountingExecutionService;
  let projectGitHubRepositoryRepository: PgProjectGitHubRepositoryRepository;

  const API_KEY = 'raw-key-missing-repo-link-a';
  const SECRET_REF = 'WFOS_TEST_KEY_MISSING_REPO_LINK_A';

  beforeAll(async () => {
    process.env[SECRET_REF] = API_KEY;
    stack = await buildAuthStack({ [SECRET_REF]: API_KEY });
    // Use the standard fixture (which creates the project↔GitHub repo link
    // so the snapshot can be frozen with a resolved baseCommit). The test
    // DELETES the link before starting the experiment to simulate the
    // snapshot-outliving-link scenario (the brief's exact wording).
    fixture = await buildBenchmarkFixture(stack, API_KEY, SECRET_REF);

    const db = stack.db.client;
    const logger = stack.db.logger;
    const auditService = new DefaultAuditService(db, logger);
    const authorizationService = new DefaultAuthorizationService(
      stack.membershipRepository, stack.rolePermissionRepository, stack.projectRepository, stack.projectAccessRepository,
    );
    const benchmarkRepository = new PgBenchmarkRepository(db);
    projectGitHubRepositoryRepository = new PgProjectGitHubRepositoryRepository(db);
    githubAdapter = new SpyGitHubAdapter();
    const implementationContextRepository = new PgImplementationContextRepository(db);
    const promptBuilder = new DefaultExecutionPromptBuilder();
    const implementationContextBuilder = new DefaultImplementationContextBuilder(
      stack.workItemRepository, stack.workOrderRepository, stack.workItemRequirementRepository,
      stack.workItemCriterionRepository, stack.workItemDependencyRepository, stack.requirementRepository,
      stack.acceptanceCriterionRepository, stack.architectureVersionRepository, stack.architectureRepository,
      implementationContextRepository, async () => null, async () => null, async () => [], async () => [],
    );
    const snapshotService = new DefaultBenchmarkSnapshotService({
      repository: benchmarkRepository, workItemRepository: stack.workItemRepository,
      workOrderRepository: stack.workOrderRepository, architectureVersionRepository: stack.architectureVersionRepository,
      architectureRepository: stack.architectureRepository, projectRepository: stack.projectRepository,
      implementationContextBuilder, contextRepository: implementationContextRepository, promptBuilder,
      projectGitHubRepositoryRepository, githubAdapter, logger: logger as never,
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
    const executionTaskService = new DefaultExecutionTaskService({
      workItemRepository: stack.workItemRepository, workOrderRepository: stack.workOrderRepository,
      architectureVersionRepository: stack.architectureVersionRepository, architectureRepository: stack.architectureRepository,
      implementationContextBuilder, contextRepository: implementationContextRepository, promptBuilder, logger: logger as never,
    });
    const deterministicNativeProvider = new DeterministicNativeBenchmarkProvider({ variant: 'perfect-first-pass', agentRunRepository });
    const deterministicExternalProvider = new DeterministicExternalBenchmarkProvider({ variant: 'perfect-first-pass' });
    const executionRecordRepository = new PgExecutionRecordRepository(db);
    const executionEventRepository = new PgExecutionEventRepository(db);
    executionEventIngestionService = new DefaultExecutionEventIngestionService({
      executionRecordRepository, eventRepository: executionEventRepository, auditService, logger: logger as never,
    });
    const realExecutionService = new DefaultExecutionService({
      executionRecordRepository, providers: [deterministicNativeProvider, deterministicExternalProvider], auditService, logger: logger as never,
    });
    countingExecutionService = new CountingExecutionService(realExecutionService);
    const trialOrchestrator = new DefaultBenchmarkTrialOrchestrator({
      repository: benchmarkRepository, executionService: countingExecutionService, executionTaskService, agentRunRepository,
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

  /** Delete the project↔GitHub repository link (simulates snapshot-outliving-link). */
  async function deleteProjectRepoLink(): Promise<void> {
    // The PgProjectGitHubRepositoryRepository does not expose a delete-by-
    // project method; we delete directly via SQL.
    await stack.db.client.query(
      'DELETE FROM wfos_project_github_repositories WHERE project_id = $1',
      [fixture.projectId],
    );
  }

  it('missing project↔GitHub link → trial FAILED with repository-link-missing', async () => {
    // 1. Freeze a snapshot WHILE the project↔GitHub link exists (so the
    //    snapshot service can resolve the baseCommit). The snapshot is now
    //    immutable + outlives the link.
    const snapshot = await benchmarkService.createSnapshot({
      projectId: fixture.projectId, workItemId: fixture.workItemId, name: 'no-link-snapshot', actor: fixture.userId,
    });
    expect(snapshot.baseCommit).toBeTruthy();

    // 2. DELETE the project↔GitHub repository link (the snapshot now
    //    outlives its link — the brief's exact scenario).
    await deleteProjectRepoLink();

    // 3. Create an experiment + start it. The orchestrator's
    //    branch-isolation step finds NO link → fails CLOSED.
    const baselineSubmitCount = countingExecutionService.submitCount;
    const baselineBranchCount = githubAdapter.createBranchCallCount;

    const experiment = await benchmarkService.createExperiment({
      projectId: fixture.projectId, benchmarkTaskSnapshotId: snapshot.id, name: 'no-link-exp',
      trials: [{ provider: 'fake', mode: 'native', repetitions: 1 }], createdBy: fixture.userId,
    });
    // Start + wait for the experiment to complete (the trial fails fast
    // inside the worker at the branch-isolation step → the experiment
    // finalizes because all trials are terminal). The trial failed at
    // branch isolation — there is NO delivery phase to drive, so the
    // helper's driveDeliveryLifecycle skips terminal trials.
    await startAndAwaitExperiment(benchmarkService, executionEventIngestionService, experiment.id, { workflowEngine, queue });

    const { trials } = await benchmarkService.listTrials(experiment.id);
    expect(trials).toHaveLength(1);
    const trial = trials[0]!;
    // PR #35 fix v2 / Blocker C: the trial is FAILED (NOT silently
    // proceeding to submit). failureKind='infrastructure'.
    expect(trial.status).toBe('failed');
    expect(trial.failureKind).toBe('infrastructure');
    expect(trial.failureReason).toContain('repository-link-missing');

    // NO submit call — the orchestrator failed BEFORE the submit step.
    expect(countingExecutionService.submitCount).toBe(baselineSubmitCount);

    // NO branch was created — the orchestrator failed BEFORE the
    // createBranch step (the missing link is detected first).
    expect(githubAdapter.createBranchCallCount).toBe(baselineBranchCount);

    // The experiment is 'completed' (all trials terminal — the failed
    // isolation trial is terminal 'failed').
    const exp = await benchmarkService.getExperiment(experiment.id);
    expect(exp?.status).toBe('completed');
  });
});
