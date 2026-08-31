/**
 * WORK-032 Browser-level E2E test: Execution Benchmark end-to-end.
 *
 * Proves the benchmark UI works through a REAL browser against a REAL backend:
 *   - Real Fastify API (all routes wired, including the new /benchmarks routes)
 * - Real WorkerHost + in-memory queue
 * - Real PostgreSQL (pglite)
 * - Deterministic native + external benchmark providers (§37/§38 — no real LLM)
 *
 * Lifecycle:
 *   1. Login (set localStorage API key)
 *   2. Create fixture task (org, project, architecture, requirements, criteria,
 *      work item, work order, project↔GitHub repo link) via API
 *   3. POST /api/benchmarks/snapshots (freeze a snapshot)
 *   4. POST /api/benchmarks (create an experiment with native + external trials)
 *   5. POST /api/benchmarks/:id/start (run the experiment)
 *   6. Navigate to /benchmarks → BenchmarkListPage renders the experiment
 *   7. Navigate to /benchmarks/:id → BenchmarkDetailPage renders trials + metrics
 *   8. Navigate to /benchmarks/trials/:trialId → BenchmarkTrialPage renders detail
 */
import { test, expect, type Page } from '@playwright/test';
import { buildIdentityStack, type TestIdentityStack } from '../helpers/test-identity-stack.js';
import { buildAuthPluginDeps, buildIdentityRouteDeps, buildOrganizationsRouteDeps } from '../helpers/test-identity-server.js';
import { loginWithServerSession } from '../helpers/browser-session.js';
import { buildServer } from '@api/server.js';
import { InMemoryQueue, buildHandlerRegistry, WorkerHost } from '@platform/index.js';
import { DefaultWorkflowEngine } from '../../src/modules/workflows/internal/workflow-engine.js';
import { PgAgentRunRepository } from '../../src/modules/agents/internal/pg-agent-repository.js';
import { FakeGitHubAdapter } from '../../src/modules/github/internal/fake-github-adapter.js';
import { DefaultReviewService } from '../../src/modules/reviews/internal/review-service.js';
import { DefaultAuditService } from '../../src/modules/audit/internal/audit-service.js';
import { DefaultAuthorizationService } from '../../src/modules/auth/internal/authorization-service.js';
import { PgExecutionRecordRepository, PgExecutionEventRepository } from '../../src/modules/agents/internal/pg-execution-repository.js';
import { DefaultExecutionService } from '../../src/modules/agents/internal/execution-service.js';
import { DefaultExecutionEventIngestionService } from '../../src/modules/agents/internal/execution-event-ingestion-service.js';
import { DefaultExecutionTaskService } from '../../src/modules/work-items/internal/execution-task-service.js';
import { DefaultImplementationContextBuilder } from '../../src/modules/work-items/internal/implementation-context-builder.js';
import { DefaultExecutionPromptBuilder } from '../../src/modules/work-items/internal/execution-prompt-builder.js';
import { PgImplementationContextRepository } from '../../src/modules/work-items/internal/pg-implementation-context-repository.js';
import { PgProjectGitHubRepositoryRepository } from '../../src/modules/github/internal/pg-project-github-repository-repository.js';
import { PgCiEvidenceIngestionRepository } from '../../src/modules/github/internal/pg-ci-evidence-repository.js';
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
} from '../../src/benchmark/index.js';
import { driveExternalCompletions, driveDeliveryLifecycle, awaitExperimentCompleted } from '../integration/benchmark/benchmark-async-helpers.js';
import type { FastifyInstance } from 'fastify';

let stack: TestIdentityStack;
let server: FastifyInstance;
let queue: InMemoryQueue;
let worker: WorkerHost;
let benchmarkService: DefaultBenchmarkService;
let executionEventIngestionService: DefaultExecutionEventIngestionService;
let workflowEngine: DefaultWorkflowEngine;
let benchProjectId: string;
let benchWorkItemId: string;

const API_KEY = 'raw-key-bench-e2e';

test.beforeAll(async () => {
  process.env['WFOS_TEST_BENCH_KEY'] = API_KEY;
  stack = await buildIdentityStack();
  const db = stack.db.client;
  const logger = stack.db.logger;

  const org = await stack.organizationRepository.create({ name: 'Bench E2E Org' });
  const user = await stack.userRepository.upsertByExternalId({ externalId: 'bench-e2e-user', displayName: 'Bench User' });
  await stack.membershipRepository.assign({ userId: user.id, organizationId: org.id, roleId: 'owner' });
  const project = await stack.projectRepository.create({ organizationId: org.id, name: 'Bench E2E Project' });
  await stack.projectAccessRepository.grant({ userId: user.id, projectId: project.id, roleId: 'owner' });
  await stack.apiKeyProvisioner.provision({
    keyId: 'bench-key', secretRef: 'WFOS_TEST_BENCH_KEY', externalId: 'bench-e2e-user', label: 'Bench User', rawKey: API_KEY,
  });

  const arch = await stack.architectureRepository.create({ projectId: project.id, name: 'Bench E2E Arch' });
  const version = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: '# Bench E2E Architecture' });
  await stack.architectureVersionRepository.transitionState(version.id, 'frozen', user.id);
  const req = await stack.requirementRepository.create({
    architectureVersionId: version.id, requirementId: 'REQ-BENCH-E2E-001',
    title: 'Calculator adds', description: 'add(2,3)===5',
  });
  const crit = await stack.acceptanceCriterionRepository.create({
    requirementId: req.id, criterionId: 'AC-BENCH-E2E-001', description: 'add(2,3) returns 5', verificationExpectation: 'unit-test',
  });
  const workItem = await stack.workItemRepository.create({
    architectureVersionId: version.id, workItemId: 'WORK-BENCH-E2E-001',
    title: 'Calculator addition', objective: 'Add a calculator.', scope: 'src/calc.ts', outOfScope: 'sub',
    metadata: { baseCommit: 'bench-e2e-baseline-commit-0000000000000000001' },
  });
  await stack.workItemRequirementRepository.associate(workItem.id, req.id);
  await stack.workItemCriterionRepository.associate(workItem.id, crit.id);
  await stack.workOrderRepository.create({
    workItemId: workItem.id, projectId: project.id, architectureVersionId: version.id,
    requirementIds: [req.id], criterionIds: [crit.id], scope: 'src/calc.ts',
    verificationRequirements: ['unit-test: add(2,3)===5'],
  });
  benchProjectId = project.id;
  benchWorkItemId = workItem.id;
  const projectGitHubRepoRepo = new PgProjectGitHubRepositoryRepository(db);
  await projectGitHubRepoRepo.create({
    projectId: project.id, installationId: 'bench-install', owner: 'bench-org', repository: 'bench-repo', defaultBranch: 'main', linkType: 'linked',
  });

  // Wire services.
  const auditService = new DefaultAuditService(db, logger);
  const authorizationService = new DefaultAuthorizationService(stack.membershipRepository, stack.rolePermissionRepository, stack.projectRepository, stack.projectAccessRepository);
  // PR #35 review fix v2 / Blocker B: wire the workflow engine WITH the
  // `onTransition` callback so the benchmark service is auto-re-advanced
  // when a work item reaches `verified` or a terminal failure state. The
  // callback is a forward-reference closure over `benchmarkService` (which
  // is constructed below). By the time any transition fires (after
  // `buildApp` returns), the binding is assigned.
  workflowEngine = new DefaultWorkflowEngine(db, logger, undefined, undefined, async (workItemId, _from, to) => {
    if (
      benchmarkService &&
      (to === 'verified' || to === 'verification_failed' || to === 'implementation_blocked')
    ) {
      await benchmarkService.advanceTrialsForWorkItem(workItemId);
    }
  });
  const reviewService = new DefaultReviewService(db, stack.workItemRepository, logger);
  // PR #35 review fix: use a minimal verification stub — the benchmark
  // metric collector only reads listRunsForWorkItem / listEvidenceForRun /
  // listMappingsForRun. The deterministic providers don't drive verification,
  // so a stub returning empty arrays is sufficient + avoids the heavy
  // DefaultVerificationService 10-arg constructor.
  const verificationService = {
    listRunsForWorkItem: async () => [],
    listEvidenceForRun: async () => [],
    listMappingsForRun: async () => [],
  } as never;
  const ciEvidenceRepo = new PgCiEvidenceIngestionRepository(db);
  const agentRunRepository = new PgAgentRunRepository(db);
  const promptBuilder = new DefaultExecutionPromptBuilder();
  const contextRepo = new PgImplementationContextRepository(db);
  const contextBuilder = new DefaultImplementationContextBuilder(
    stack.workItemRepository, stack.workOrderRepository, stack.workItemRequirementRepository,
    stack.workItemCriterionRepository, stack.workItemDependencyRepository, stack.requirementRepository,
    stack.acceptanceCriterionRepository, stack.architectureVersionRepository, stack.architectureRepository,
    contextRepo, async () => null, async () => null, async () => [], async () => [],
  );
  const executionTaskService = new DefaultExecutionTaskService({
    workItemRepository: stack.workItemRepository, workOrderRepository: stack.workOrderRepository,
    architectureVersionRepository: stack.architectureVersionRepository, architectureRepository: stack.architectureRepository,
    implementationContextBuilder: contextBuilder, contextRepository: contextRepo, promptBuilder, logger,
  });
  const githubAdapter = new FakeGitHubAdapter();
  const benchRepo = new PgBenchmarkRepository(db);
  const snapshotService = new DefaultBenchmarkSnapshotService({
    repository: benchRepo, workItemRepository: stack.workItemRepository, workOrderRepository: stack.workOrderRepository,
    architectureVersionRepository: stack.architectureVersionRepository, architectureRepository: stack.architectureRepository,
    projectRepository: stack.projectRepository, implementationContextBuilder: contextBuilder, contextRepository: contextRepo,
    promptBuilder, projectGitHubRepositoryRepository: projectGitHubRepoRepo, githubAdapter, logger,
  });
  const integrityService = new DefaultBenchmarkIntegrityService({ repository: benchRepo, logger });
  const metricCollector = new DefaultBenchmarkMetricCollector({
    repository: benchRepo, workflowEngine, verificationService, reviewService,
    pullRequestAssociationRepository: stack.pullRequestAssociationRepository,
    ciEvidenceIngestionRepository: ciEvidenceRepo, agentRunRepository, logger,
  });
  const detNative = new DeterministicNativeBenchmarkProvider({ variant: 'perfect-first-pass', agentRunRepository });
  const detExternal = new DeterministicExternalBenchmarkProvider({ variant: 'perfect-first-pass' });
  const executionRecordRepository = new PgExecutionRecordRepository(db);
  const executionEventRepository = new PgExecutionEventRepository(db);
  const executionService = new DefaultExecutionService({ executionRecordRepository, providers: [detNative, detExternal], auditService, logger });
  // PR #35 review fix #4: the execution-event ingestion boundary — the test
  // simulates the Companion reporting external completion through this
  // authoritative boundary. PR #35 review fix v2 / Blocker A: wire the
  // `onExecutionTerminal` callback so the benchmark service is
  // auto-re-advanced when an external execution reaches a terminal state.
  // Forward-reference closure over `benchmarkService` (constructed below).
  executionEventIngestionService = new DefaultExecutionEventIngestionService({
    executionRecordRepository, eventRepository: executionEventRepository, auditService, logger,
    onExecutionTerminal: async (execId, _state) => {
      if (benchmarkService) {
        await benchmarkService.advanceTrialsForExecution(execId);
      }
    },
  });
  const trialOrchestrator = new DefaultBenchmarkTrialOrchestrator({
    repository: benchRepo, executionService, executionTaskService, agentRunRepository,
    workItemRepository: stack.workItemRepository, workOrderRepository: stack.workOrderRepository,
    workItemRequirementRepository: stack.workItemRequirementRepository, workItemCriterionRepository: stack.workItemCriterionRepository,
    workItemDependencyRepository: stack.workItemDependencyRepository, workflowEngine,
    projectGitHubRepositoryRepository: projectGitHubRepoRepo, githubAdapter, logger,
  });
  const exportService = new DefaultBenchmarkExportService({ repository: benchRepo, logger });
  const recommendationService = new DefaultBenchmarkRecommendationService({ repository: benchRepo, logger });
  queue = new InMemoryQueue();
  benchmarkService = new DefaultBenchmarkService({
    db, logger, repository: benchRepo, snapshotService, integrityService, metricCollector,
    trialOrchestrator, exportService, recommendationService, auditService, authorizationService,
    queue,
    executionRecordRepository,
    workflowEngine,
  });
  const handlers = buildHandlerRegistry([
    createBenchmarkTrialJobHandler(benchmarkService, logger),
  ]);
  worker = new WorkerHost(queue, handlers, logger, { pollIntervalMs: 5 });
  await worker.start();

  server = await buildServer({
    queue, logger,
    auth: buildAuthPluginDeps(stack),
    identity: buildIdentityRouteDeps(stack),
    organizations: buildOrganizationsRouteDeps(stack),
    projects: { authorizationService, projectRepository: stack.projectRepository, repositoryAssociationRepository: stack.repositoryAssociationRepository } as never,
    workItems: { authorizationService, workItemRepository: stack.workItemRepository, architectureRepository: stack.architectureRepository, architectureVersionRepository: stack.architectureVersionRepository } as never,
    workflow: { authorizationService, workflowEngine, workItemRepository: stack.workItemRepository, architectureRepository: stack.architectureRepository, architectureVersionRepository: stack.architectureVersionRepository } as never,
    agents: { authorizationService, agentRunRepository, agentProviderRegistryService: null } as never,
    verification: { authorizationService, verificationService, workItemRepository: stack.workItemRepository, architectureRepository: stack.architectureRepository, architectureVersionRepository: stack.architectureVersionRepository, requirementRepository: stack.requirementRepository, acceptanceCriterionRepository: stack.acceptanceCriterionRepository } as never,
    reviews: { authorizationService, reviewService, workItemRepository: stack.workItemRepository, architectureRepository: stack.architectureRepository, architectureVersionRepository: stack.architectureVersionRepository } as never,
    audit: { authorizationService, auditService, projectRepository: stack.projectRepository } as never,
    githubProvisioning: { authorizationService, githubAdapter, projectGitHubRepositoryRepository: projectGitHubRepoRepo } as never,
    execution: { authorizationService, workItemRepository: stack.workItemRepository, architectureRepository: stack.architectureRepository, architectureVersionRepository: stack.architectureVersionRepository, executionRecordRepository } as never,
    benchmark: { authorizationService, benchmarkService },
  });
  await server.listen({ port: 3001, host: '127.0.0.1' });
});

test.afterAll(async () => {
  if (worker) await worker.stop();
  if (queue) await queue.close();
  if (server) await server.close();
  if (stack) await stack.teardown();
});

async function api(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<any> {
  const isGet = method === 'GET';
  const res = await fetch(`http://127.0.0.1:3001${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: isGet ? undefined : (body !== undefined ? JSON.stringify(body) : '{}'),
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = { raw: text, status: res.status }; }
  if (res.status >= 400) {
    throw new Error(`API ${method} ${path} → ${res.status}: ${text}`);
  }
  return json;
}

async function loginAndGo(page: Page, path: string) {
  // WORK-074: the demo-key localStorage login is RETIRED from the frontend —
  // seed a REAL server-side session and attach the HttpOnly cookie.
  const user = await stack.userRepository.upsertByExternalId({
    externalId: 'bench-e2e-user',
    displayName: 'Bench User',
  });
  await loginWithServerSession(page, stack.sessionService, user.id);
  await page.goto(`http://localhost:5173${path}`);
}

test('WORK-032 benchmark end-to-end through the real browser UI', async ({ page }) => {
  // 1. Create snapshot + experiment via API (using fixture ids from beforeAll).
  const snapshotRes = await api('/benchmarks/snapshots', 'POST', {
    projectId: benchProjectId, workItemId: benchWorkItemId, name: 'bench-e2e-snapshot', description: 'E2E benchmark',
  });
  expect(snapshotRes.snapshot).toBeTruthy();
  expect(snapshotRes.snapshot.promptDigest).toMatch(/^[0-9a-f]{64}$/);

  const experimentRes = await api('/benchmarks', 'POST', {
    projectId: benchProjectId, benchmarkTaskSnapshotId: snapshotRes.snapshot.id, name: 'bench-e2e-experiment',
    trials: [
      { provider: 'fake', mode: 'native', repetitions: 1 },
      { provider: 'fake', mode: 'external', repetitions: 1 },
    ],
  });
  expect(experimentRes.experiment).toBeTruthy();
  const experimentId = experimentRes.experiment.id;

  // 2. Start the experiment (async — PR #35 review fix v2 made
  // startExperiment enqueue benchmark.trial jobs + return immediately).
  // Drive the external trial's completion through the authoritative
  // execution-event-ingestion boundary (simulates the Companion). The
  // `onExecutionTerminal` callback (wired in beforeAll) auto-re-advances
  // the trial to the delivery phase. Drive the delivery lifecycle for
  // ALL trials (native + external) to `verified` (the `onTransition`
  // callback auto-re-advances each trial; the manual re-enqueue in
  // `driveDeliveryLifecycle` is idempotent). Then wait for the experiment
  // to reach 'completed'.
  await api(`/benchmarks/${experimentId}/start`, 'POST');
  await driveExternalCompletions(benchmarkService, executionEventIngestionService, experimentId);
  await driveDeliveryLifecycle(benchmarkService, workflowEngine, queue, experimentId);
  await awaitExperimentCompleted(benchmarkService, experimentId);
  const expFinal = await benchmarkService.getExperiment(experimentId);
  expect(expFinal?.status).toBe('completed');

  // 3. Navigate to the Benchmarks list page.
  await loginAndGo(page, `/benchmarks?projectId=${benchProjectId}`);
  await expect(page.getByRole('heading', { name: /Execution Benchmarks/i })).toBeVisible({ timeout: 15_000 });

  // 4. Navigate to the benchmark detail page.
  await page.goto(`http://localhost:5173/benchmarks/${experimentId}`);
  await expect(page.getByText(/bench-e2e-experiment/i)).toBeVisible({ timeout: 15_000 });

  // 5. Get a trial id + navigate to the trial detail page.
  const trialsRes = await api(`/benchmarks/${experimentId}/trials`);
  expect(trialsRes.trials.length).toBeGreaterThanOrEqual(1);
  const trialId = trialsRes.trials[0].id;
  await page.goto(`http://localhost:5173/benchmarks/trials/${trialId}`);
  // The trial page should render (smoke — just verify it doesn't crash).
  await page.waitForLoadState('networkidle');
});
