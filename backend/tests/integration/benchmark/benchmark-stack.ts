/**
 * PR #35 follow-up (idempotency): shared benchmark service-stack builder for
 * the idempotency regression tests. Extracts the ~150-line wiring from
 * async-lifecycle.regression.test.ts's beforeAll into a reusable helper so
 * the new idempotency tests (trial-claim-idempotency +
 * trial-finalization-idempotency) can construct the full benchmark stack
 * without duplicating the boilerplate.
 *
 * The stack wires the SAME services as production (app.ts): the
 * DefaultBenchmarkService (which implements BenchmarkTrialRunner), the
 * DefaultBenchmarkTrialOrchestrator (which consumes ExecutionService), the
 * InMemoryQueue + WorkerHost (which dispatches `benchmark.trial` jobs), +
 * the DeterministicNative/ExternalBenchmarkProviders (for reproducible
 * outcomes). The FakeGitHubAdapter is exposed so tests can inspect
 * createBranch call counts (the claim-race side-effect signal).
 *
 * Boundary: test-infrastructure only. Mirrors the production composition
 * root (app.ts) — the benchmark remains an application-layer consumer of
 * the 17 frozen modules via their public barrels.
 */
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
  BenchmarkStartDeliveryOutboxRelay,
  createStartDeliveryRelayJobHandler,
} from '../../../src/benchmark/index.js';
import { InMemoryQueue, WorkerHost, buildHandlerRegistry } from '@platform/index.js';
import type { HandlerRegistry } from '@platform/index.js';
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
import type { DefaultBenchmarkService as BenchmarkServiceInstance } from '../../../src/benchmark/index.js';
import type { WorkflowEngine } from '../../../src/modules/workflows/index.js';

export interface BenchmarkStack {
  readonly authStack: TestAuthStack;
  readonly fixture: BenchmarkFixture;
  readonly benchmarkService: BenchmarkServiceInstance;
  readonly benchmarkRepository: PgBenchmarkRepository;
  readonly queue: InMemoryQueue;
  readonly worker: WorkerHost;
  /**
   * WORK-032 start-delivery durability: the benchmark start-delivery
   * outbox relay (the generic OutboxRelay implementation). Exposed so
   * tests can construct a SECOND WorkerHost (simulating a new worker
   * process boot → its boot sweep fires) against the same queue.
   */
  readonly startDeliveryRelay: BenchmarkStartDeliveryOutboxRelay;
  /** The handler registry (trial + start-delivery relay handlers). */
  readonly handlers: HandlerRegistry;
  readonly executionEventIngestionService: DefaultExecutionEventIngestionService;
  readonly workflowEngine: WorkflowEngine;
  readonly auditService: DefaultAuditService;
  readonly githubAdapter: FakeGitHubAdapter;
}

/**
 * Build the full benchmark service stack. Sets `process.env[secretRef]` to
 * the API key (the deterministic providers read it). Starts the WorkerHost
 * (pollIntervalMs=5 — fast for tests) UNLESS `startWorker: false` — the
 * start-delivery durability tests use that mode so enqueued
 * `benchmark.trial` jobs stay in the queue + enqueue counts are
 * deterministic. The caller MUST `stop()` the worker (safe on an unstarted
 * host) + `close()` the queue + `teardown()` the auth stack in afterAll.
 */
export async function buildBenchmarkStack(opts: {
  apiKey: string;
  secretRef: string;
  /** Variant for the deterministic providers — 'perfect-first-pass' yields verified delivery. */
  variant?: 'perfect-first-pass';
  /** Skip starting the WorkerHost (deterministic enqueue counting). Default: start it. */
  startWorker?: boolean;
}): Promise<BenchmarkStack> {
  process.env[opts.secretRef] = opts.apiKey;
  const stack = await buildAuthStack({ [opts.secretRef]: opts.apiKey });
  const fixture = await buildBenchmarkFixture(stack, opts.apiKey, opts.secretRef);

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
  const variant = opts.variant ?? 'perfect-first-pass';
  const deterministicNativeProvider = new DeterministicNativeBenchmarkProvider({
    variant,
    agentRunRepository,
  });
  const deterministicExternalProvider = new DeterministicExternalBenchmarkProvider({
    variant,
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
  const queue = new InMemoryQueue();
  const benchmarkService = new DefaultBenchmarkService({
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
    // WORK-032 start-delivery durability: the relay job handler, next to
    // the trial handler — mirroring the app.ts composition.
    createStartDeliveryRelayJobHandler(benchmarkService as never, logger as never),
  ]);
  // WORK-032 start-delivery durability: the outbox relay, constructed the
  // same way app.ts does. Passed to this stack's WorkerHost (its boot
  // sweep runs when the stack starts the worker) + exposed so tests can
  // build additional WorkerHosts simulating further process boots.
  const startDeliveryRelay = new BenchmarkStartDeliveryOutboxRelay({
    repository: benchmarkRepository,
    queue,
    logger: logger as never,
  });
  const worker = new WorkerHost(queue, handlers, logger as never, {
    pollIntervalMs: 5,
    outboxRelays: [startDeliveryRelay],
  });
  if (opts.startWorker !== false) {
    await worker.start();
  }

  return {
    authStack: stack,
    fixture,
    benchmarkService,
    benchmarkRepository,
    queue,
    worker,
    startDeliveryRelay,
    handlers,
    executionEventIngestionService,
    workflowEngine,
    auditService,
    githubAdapter,
  };
}

/**
 * Tear down the stack: stop the worker, close the queue, teardown the auth
 * stack (drops the pglite DB). Call in afterAll.
 */
export async function teardownBenchmarkStack(stack: BenchmarkStack): Promise<void> {
  await stack.worker.stop();
  await stack.queue.close();
  await stack.authStack.teardown();
}
