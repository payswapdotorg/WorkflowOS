/**
 * WORK-048 — Browser-level E2E test: the Developer Workbench.
 *
 * Real topology (Fastify API on 127.0.0.1:3001 + the Vite dev server on
 * :5173 via the Playwright webServer + pglite PostgreSQL). The browser loads
 * the actual SPA, authenticates, and drives the Workbench through the REAL
 * rendered DOM — asserting on visible content, never on API responses.
 *
 * Flows proven:
 *   1. the Workbench overview renders (project identity, attention derived
 *      from the authoritative graph, explicit "unavailable" ERRORS for the
 *      UNWIRED runtime/planning authorities — a failed read is an error,
 *      never an invented empty state);
 *   2. the Work Graph renders the fact-based groups (blocked / ready /
 *      completed) from the backend read model;
 *   3. the rollups render authoritative records (execution, PR identity,
 *      verification run, review) — and the UNWIRED surfaces (deployments,
 *      the WORK-049 Health tab's maintenance authority) render explicit
 *      "unavailable" ERRORS, never fake "No …" empty states (the PR #76
 *      review correction);
 *   4. the drill-down: Workbench → work item page → the WORK-048 sections
 *      (Objective, Dependencies, Merge Gates, the ADVISORY recommendation);
 *   5. browser-level tenant isolation: user A opening user B's project
 *      workbench sees ONLY the degraded "unavailable" states — zero project
 *      B data (authorization is server-side; the frontend has no
 *      authority) — and the failures render as ERRORS, provably never as
 *      fabricated "No executions"-style empty states.
 */
import { test, expect, type Page } from '@playwright/test';
import { buildIdentityStack, type TestIdentityStack } from '../helpers/test-identity-stack.js';
import { buildAuthPluginDeps, buildIdentityRouteDeps, buildOrganizationsRouteDeps } from '../helpers/test-identity-server.js';
import { loginWithServerSession } from '../helpers/browser-session.js';
import { buildServer } from '@api/server.js';
import { InMemoryQueue, buildHandlerRegistry, WorkerHost, createLogger, generateExecutionId } from '@platform/index.js';
import { DefaultWorkflowEngine } from '../../src/modules/workflows/internal/workflow-engine.js';
import { DefaultWorkflowOrchestrator } from '../../src/modules/workflows/internal/workflow-orchestrator.js';
import { GovernedPullRequestService } from '../../src/modules/workflows/internal/governed-pull-request-service.js';
import { FakePullRequestCreationPort } from '../helpers/fake-pr-creation-port.js';
import { AllowAllCheckpointGate } from '../helpers/allow-all-checkpoint-gate.js';
import { DefaultAgentGateway, FakeAgentAdapter } from '../../src/modules/agents/internal/agent-gateway.js';
import { PgAgentRunRepository } from '../../src/modules/agents/internal/pg-agent-repository.js';
import { DefaultLlmGateway, FakeLlmAdapter } from '../../src/modules/llm/internal/llm-gateway.js';
import { DefaultArchitectService } from '../../src/modules/llm/internal/architect-service.js';
import { DefaultGitHubAdapter } from '../../src/modules/github/internal/pg-github-repository.js';
import { DefaultWorkItemDependencyService } from '../../src/modules/work-items/internal/work-item-dependency-service.js';
import { DefaultAuditService } from '../../src/modules/audit/internal/audit-service.js';
import { PgExecutionRecordRepository } from '../../src/modules/agents/internal/pg-execution-repository.js';
import { PgImplementationContextRepository } from '../../src/modules/work-items/internal/pg-implementation-context-repository.js';
import { PgCiEvidenceIngestionRepository } from '../../src/modules/github/internal/pg-ci-evidence-repository.js';
import { PgGitHubInstallationRepository } from '../../src/modules/github/internal/pg-github-repository.js';
import { DefaultCiEvidenceIngestionService } from '../../src/modules/github/internal/ci-evidence-ingestion-service.js';
import { DefaultVerificationService } from '../../src/modules/verification/internal/verification-service.js';
import { DefaultReviewService } from '../../src/modules/reviews/internal/review-service.js';
import type { FastifyInstance } from 'fastify';

let stack: TestIdentityStack;
let server: FastifyInstance;
let worker: WorkerHost;
let queue: InMemoryQueue;

let projectAId: string;
let projectBId: string;
let wi1Id: string; // WB-E2E-001 — draft (the blocker)
let wi2Id: string; // WB-E2E-002 — ready (the active item with all the records)

const API_KEY = 'raw-key-workbench-e2e';

test.beforeAll(async () => {
  process.env['WFOS_TEST_WORKBENCH_KEY'] = API_KEY;
  stack = await buildIdentityStack();

  const logger = createLogger({ level: 'warn', destination: process.stdout });
  const db = stack.db.client;

  // --- Project A (user A / org A): the workbench project --------------------
  const orgA = await stack.organizationRepository.create({ name: 'Workbench E2E Org A' });
  const userA = await stack.userRepository.upsertByExternalId({ externalId: 'workbench-e2e-user-a', displayName: 'User A' });
  await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
  const projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'Workbench E2E Project A' });
  await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
  projectAId = projectA.id;
  await stack.apiKeyProvisioner.provision({
    keyId: 'workbench-key', secretRef: 'WFOS_TEST_WORKBENCH_KEY', externalId: 'workbench-e2e-user-a', label: 'A', rawKey: API_KEY,
  });

  const archA = await stack.architectureRepository.create({ projectId: projectAId, name: 'Workbench Arch A' });
  const versionA = await stack.architectureVersionRepository.create({ architectureId: archA.id, contentInline: '# Workbench E2E A' });
  await stack.architectureVersionRepository.transitionState(versionA.id, 'frozen', userA.id);

  const wi1 = await stack.workItemRepository.create({
    architectureVersionId: versionA.id, workItemId: 'WB-E2E-001',
    title: 'First item (the blocker)', objective: 'Lay the foundation.', scope: 'src/foundation.ts',
    metadata: { baseCommit: 'workbench-e2e-baseline-00000000000000000001' },
  });
  const wi2 = await stack.workItemRepository.create({
    architectureVersionId: versionA.id, workItemId: 'WB-E2E-002',
    title: 'Second item (active)', objective: 'Build on the foundation.', scope: 'src/active.ts',
    metadata: { baseCommit: 'workbench-e2e-baseline-00000000000000000002' },
  });
  const wi3 = await stack.workItemRepository.create({
    architectureVersionId: versionA.id, workItemId: 'WB-E2E-003',
    title: 'Blocked item', objective: 'Waits on the first item.', scope: 'src/blocked.ts',
    metadata: { baseCommit: 'workbench-e2e-baseline-00000000000000000003' },
  });
  const wi4 = await stack.workItemRepository.create({
    architectureVersionId: versionA.id, workItemId: 'WB-E2E-004',
    title: 'Completed item', objective: 'Already done.', scope: 'src/done.ts',
    metadata: { baseCommit: 'workbench-e2e-baseline-00000000000000000004' },
  });
  wi1Id = wi1.id;
  wi2Id = wi2.id;
  // WB-E2E-003 depends on the incomplete WB-E2E-001 (the blocked edge).
  await stack.workItemDependencyRepository.add(wi3.id, wi1Id);
  // WB-E2E-004 is completed.
  await stack.workItemRepository.markCompleted(wi4.id, true);

  // The workflow authority: WB-E2E-002 reaches 'ready'.
  const auditService = new DefaultAuditService(db, stack.db.logger);
  const depService = new DefaultWorkItemDependencyService(db);
  queue = new InMemoryQueue();
  const workflowEngine = new DefaultWorkflowEngine(
    db, logger,
    (wiId: string) => depService.canBeginImplementation(wiId),
    auditService,
  );
  await workflowEngine.transition({ workItemId: wi2Id, toState: 'ready', actor: 'workbench-e2e' });

  // The /agents execution record for WB-E2E-002 (needs the WO + context FKs).
  const workOrder = await stack.workOrderRepository.create({
    workItemId: wi2Id, projectId: projectAId, architectureVersionId: versionA.id,
    scope: 'src/active.ts', verificationRequirements: ['unit-test'],
  });
  const contextRepo = new PgImplementationContextRepository(db);
  const ctx = await contextRepo.create({
    workItemId: wi2Id, revision: 1, kind: 'initial',
    content: { prompt: 'workbench e2e context' } as never,
  });
  const executionRepo = new PgExecutionRecordRepository(db);
  await executionRepo.create({
    executionId: 'exec-workbench-e2e-1', projectId: projectAId, workItemId: wi2Id,
    workOrderId: workOrder.id, implementationContextId: ctx.id,
    mode: 'native', provider: 'fake', model: 'fake-model',
    repositoryRef: 'pectoraux/workbench-e2e-a', branch: 'feat/wb-e2e-2',
    prompt: 'SECRET-FREE', promptDigest: 'digest-e2e-1',
  });

  // The GitHub-derived PR identity for WB-E2E-002.
  await stack.pullRequestAssociationRepository.create({
    workItemId: wi2Id, externalPrId: 'wb-e2e-pr-9001', provider: 'github',
    repositoryRef: 'pectoraux/workbench-e2e-a', branch: 'feat/wb-e2e-2', baseBranch: 'main',
    headCommit: 'workbenche2ehead0000000000000000000001',
  });

  // The /verification authority's run.
  const ciIngestionRepo = new PgCiEvidenceIngestionRepository(db);
  const installationRepo = new PgGitHubInstallationRepository(db);
  const ciEvidenceIngestionService = new DefaultCiEvidenceIngestionService(ciIngestionRepo, installationRepo, logger);
  const verificationService = new DefaultVerificationService(
    db, stack.requirementRepository, stack.acceptanceCriterionRepository,
    stack.architectureVersionRepository, stack.workItemRepository,
    stack.workItemRequirementRepository, stack.workItemCriterionRepository,
    stack.ciEvidenceRepository, stack.objectStore, stack.db.logger,
  );
  await verificationService.createRun({
    projectId: projectAId, workItemId: wi2Id, architectureVersionId: versionA.id,
    source: 'manual', sourceRef: 'workbench-e2e', executionId: 'exec-workbench-e2e-1',
  });

  // The /reviews authority's record.
  const reviewService = new DefaultReviewService(db, stack.workItemRepository, stack.db.logger);
  await reviewService.createReview({
    projectId: projectAId, workItemId: wi2Id, architectureVersionId: versionA.id,
    source: 'manual', executionId: 'exec-workbench-e2e-1', reviewer: 'workbench-e2e',
  });

  // The orchestrator (merge-readiness + next-work-item need it).
  const fakeLlm = new FakeLlmAdapter();
  const fakeAgent = new FakeAgentAdapter();
  const llmGateway = new DefaultLlmGateway(db, logger, [fakeLlm], 3);
  const architectService = new DefaultArchitectService(db, llmGateway, stack.workOrderRepository, logger);
  const agentGateway = new DefaultAgentGateway(db, logger, [fakeAgent], 3);
  const agentRunRepo = new PgAgentRunRepository(db);
  const orchestrator = new DefaultWorkflowOrchestrator(
    db, logger, queue, workflowEngine,
    stack.workItemRepository, stack.workOrderRepository, depService,
    stack.workItemCompletionService,
    stack.pullRequestAssociationRepository, agentGateway, agentRunRepo,
    architectService, verificationService, reviewService, new DefaultGitHubAdapter(),
    stack.architectureVersionRepository, stack.architectureRepository,
    stack.projectRepository, new AllowAllCheckpointGate(), generateExecutionId,
    new GovernedPullRequestService(db, new FakePullRequestCreationPort()),
  );

  // --- Project B (user B / org B — the tenant-isolation partner) ------------
  const orgB = await stack.organizationRepository.create({ name: 'Workbench E2E Org B' });
  const userB = await stack.userRepository.upsertByExternalId({ externalId: 'workbench-e2e-user-b', displayName: 'User B' });
  await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
  const projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'Workbench E2E Project B' });
  await stack.projectAccessRepository.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });
  projectBId = projectB.id;
  const archB = await stack.architectureRepository.create({ projectId: projectBId, name: 'Workbench Arch B' });
  const versionB = await stack.architectureVersionRepository.create({ architectureId: archB.id, contentInline: '# Workbench E2E B' });
  await stack.workItemRepository.create({
    architectureVersionId: versionB.id, workItemId: 'WB-B-E2E-001',
    title: 'SECRET project B item', objective: 'Must never be visible to user A.',
    metadata: { baseCommit: 'workbench-e2e-b-baseline-0000000000000001' },
  });

  // --- The server: the WORK-048 topology (the workbench route group over
  //     the owning authorities; runtime/planning/maintenance deliberately
  //     UNWIRED so their absence renders as explicit "unavailable"). ---------
  const handlers = buildHandlerRegistry([]);
  worker = new WorkerHost(queue, handlers, logger, { pollIntervalMs: 50 });

  server = await buildServer({
    queue,
    logger: stack.db.logger,
    auth: buildAuthPluginDeps(stack),
    identity: buildIdentityRouteDeps(stack),
    organizations: buildOrganizationsRouteDeps(stack),
    projects: {
      authorizationService: stack.authorizationService,
      projectRepository: stack.projectRepository,
      repositoryAssociationRepository: stack.repositoryAssociationRepository,
    },
    architecture: {
      authorizationService: stack.authorizationService,
      projectRepository: stack.projectRepository,
      architectureRepository: stack.architectureRepository,
      architectureVersionRepository: stack.architectureVersionRepository,
      architectureDecisionRepository: stack.architectureDecisionRepository,
      architectureChangeRequestRepository: stack.architectureChangeRequestRepository,
      architectureAssertionRepository: stack.architectureAssertionRepository,
      architectureService: stack.architectureService,
    },
    workItems: {
      authorizationService: stack.authorizationService,
      architectureRepository: stack.architectureRepository,
      architectureVersionRepository: stack.architectureVersionRepository,
      workItemRepository: stack.workItemRepository,
      workItemRequirementRepository: stack.workItemRequirementRepository,
      workItemCriterionRepository: stack.workItemCriterionRepository,
      workItemDependencyRepository: stack.workItemDependencyRepository,
      pullRequestAssociationRepository: stack.pullRequestAssociationRepository,
      workOrderRepository: stack.workOrderRepository,
    },
    workflow: {
      authorizationService: stack.authorizationService,
      projectRepository: stack.projectRepository,
      architectureRepository: stack.architectureRepository,
      architectureVersionRepository: stack.architectureVersionRepository,
      workItemRepository: stack.workItemRepository,
      workflowEngine,
      orchestrator,
    },
    verification: {
      authorizationService: stack.authorizationService,
      architectureRepository: stack.architectureRepository,
      architectureVersionRepository: stack.architectureVersionRepository,
      workItemRepository: stack.workItemRepository,
      requirementRepository: stack.requirementRepository,
      acceptanceCriterionRepository: stack.acceptanceCriterionRepository,
      verificationService,
      ciEvidenceIngestionService,
    },
    reviews: {
      authorizationService: stack.authorizationService,
      architectureRepository: stack.architectureRepository,
      architectureVersionRepository: stack.architectureVersionRepository,
      workItemRepository: stack.workItemRepository,
      reviewService,
    },
    audit: {
      authorizationService: stack.authorizationService,
      projectRepository: stack.projectRepository,
      architectureRepository: stack.architectureRepository,
      architectureVersionRepository: stack.architectureVersionRepository,
      workItemRepository: stack.workItemRepository,
      auditQuery: auditService,
    },
    workbench: {
      authorizationService: stack.authorizationService,
      workItemRepository: stack.workItemRepository,
      workItemDependencyRepository: stack.workItemDependencyRepository,
      dependencyService: depService,
      workflowEngine,
      executionRecordRepository: executionRepo,
      pullRequestAssociationRepository: stack.pullRequestAssociationRepository,
      verificationService,
      reviewService,
    },
  });
  await server.listen({ port: 3001, host: '127.0.0.1' });
  await worker.start();
});

test.afterAll(async () => {
  await worker.stop();
  await server.close();
  await stack.teardown();
});

async function login(page: Page): Promise<void> {
  // WORK-074: the demo-key localStorage login is RETIRED from the frontend
  // (the customer login path is the human login; the API-key path remains
  // automation-only). The specs seed a REAL server-side session through the
  // SAME SessionService the /auth routes use and attach the HttpOnly
  // `wfos_session` cookie — the production transport.
  const user = await stack.userRepository.upsertByExternalId({
    externalId: 'workbench-e2e-user-a',
    displayName: 'User A',
  });
  await loginWithServerSession(page, stack.sessionService, user.id);
  await page.goto('/');
}

test('the Workbench overview renders: project identity, attention from the authoritative graph, explicit unavailability for the unwired runtime', async ({ page }) => {
  await login(page);
  await page.goto(`/projects/${projectAId}/workbench`);

  // The project identity (the projects authority).
  await expect(page.getByRole('heading', { name: 'Workbench E2E Project A' })).toBeVisible({ timeout: 20_000 });

  // The attention derivation: WB-E2E-003 is blocked on the incomplete WB-E2E-001.
  await expect(page.getByText('WB-E2E-003 is blocked')).toBeVisible();

  // The health summary: the runtime authority is UNWIRED in this topology —
  // the workbench says so EXPLICITLY as an error (a failed read is an error,
  // never an invented status — and never a fabricated empty state).
  await expect(page.getByText(/Runtime status unavailable/i)).toBeVisible();

  // The planner is likewise UNWIRED: an explicit unavailable error, never a
  // silent "no recommendations" (the PR #76 review correction).
  await expect(page.getByText(/Planner recommendations unavailable/i)).toBeVisible();

  // The work state counts (the workflow authority's own values).
  await expect(page.getByRole('button', { name: 'Ready' })).toBeVisible();
});

test('the Work Graph renders the fact-based groups from the backend read model', async ({ page }) => {
  await login(page);
  await page.goto(`/projects/${projectAId}/workbench?tab=graph`);
  await expect(page.getByTestId('work-graph-board')).toBeVisible({ timeout: 20_000 });

  // Blocked: WB-E2E-003 with its unsatisfied dependency on WB-E2E-001.
  await expect(page.getByText('WB-E2E-003').first()).toBeVisible();
  await expect(page.getByText('1 unsatisfied dependency (dependency authority)')).toBeVisible();

  // Ready: WB-E2E-002.
  await expect(page.getByText('WB-E2E-002').first()).toBeVisible();

  // Draft: WB-E2E-001 (the blocker itself).
  await expect(page.getByText('WB-E2E-001').first()).toBeVisible();

  // Completed: WB-E2E-004.
  await expect(page.getByText('WB-E2E-004').first()).toBeVisible();
});

test('the rollups render the AUTHORITATIVE records (execution, GitHub-derived PR identity, verification run, review)', async ({ page }) => {
  await login(page);
  await page.goto(`/projects/${projectAId}/workbench`);

  // Executions rollup: the safe execution record.
  await page.getByRole('tab', { name: /Executions/i }).click();
  await expect(page.getByText('exec-workbench-e2e-1')).toBeVisible({ timeout: 15_000 });

  // Changes rollup: the authoritative GitHub-derived identity.
  await page.getByRole('tab', { name: /Changes/i }).click();
  await expect(page.getByText('PR wb-e2e-pr-9001')).toBeVisible();

  // Verification rollup: the /verification authority's run.
  await page.getByRole('tab', { name: /Verification/i }).click();
  await expect(page.getByText(/Run /).first()).toBeVisible();

  // Reviews rollup: the /reviews authority's record.
  await page.getByRole('tab', { name: /Reviews/i }).click();
  await expect(page.getByText(/Review /).first()).toBeVisible();

  // Deployments: the runtime authority is UNWIRED — the read FAILS, so the
  // tab renders the explicit "Deployments unavailable" ERROR. It must NOT
  // render "No deployments": a failed read is never a genuine empty result
  // (the PR #76 review correction).
  await page.getByRole('tab', { name: /Deployments/i }).click();
  await expect(page.getByText(/Deployments unavailable/i)).toBeVisible();
  await expect(page.getByText('No deployments', { exact: true })).toHaveCount(0);

  // Health (WORK-049): the architecture walk SUCCEEDS (wired, frozen version)
  // but the maintenance authority itself is UNWIRED — the Health tab renders
  // the explicit "Maintenance health unavailable" error naming the
  // maintenance authority AND withholds the all-healthy conclusion
  // ("Health assessment incomplete" naming maintenance), never "No
  // architecture version" and never a fabricated "No health findings".
  await page.getByRole('tab', { name: /Health/i }).click();
  await expect(page.getByText(/Maintenance health unavailable — the maintenance authority/i)).toBeVisible();
  await expect(page.getByText(/Health assessment incomplete/i)).toBeVisible();
  await expect(page.getByText('No architecture version', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/No health findings/i)).toHaveCount(0);
});

test('the drill-down: Workbench → work item page → the WORK-048 sections (Objective, Dependencies, Merge Gates, ADVISORY recommendation)', async ({ page }) => {
  await login(page);
  await page.goto(`/projects/${projectAId}/workbench?tab=work`);
  await expect(page.getByText('WB-E2E-002').first()).toBeVisible({ timeout: 20_000 });

  // Drill into the active item.
  await page.getByText('WB-E2E-002').first().click();
  await expect(page.getByRole('heading', { name: /WB-E2E-002: Second item \(active\)/ })).toBeVisible({ timeout: 15_000 });

  // The WORK-048 objective card (the authoritative WorkItem fields).
  await expect(page.getByText('Build on the foundation.')).toBeVisible();
  await expect(page.getByText('src/active.ts').first()).toBeVisible();

  // The dependencies card: WB-E2E-002 has no dependencies.
  await expect(page.getByText('No dependencies — this item blocks on nothing.')).toBeVisible();

  // The merge gates card (the workflow authority's own verdict).
  await expect(page.getByText('Merge Gates')).toBeVisible();

  // The ADVISORY routing recommendation — rendered with advisory framing,
  // never as a decision (the routing authority may be unavailable in this
  // topology — which must ALSO be explicit, never fabricated).
  await expect(page.getByText('Routing Recommendation')).toBeVisible({ timeout: 15_000 });
});

test('BROWSER-LEVEL TENANT ISOLATION: user A opening user B\'s project workbench sees ONLY degraded states — zero project B data', async ({ page }) => {
  await login(page);
  // User A has NO access to project B: every backend call 403s (server-side
  // authorization) and the workbench renders the explicit degraded states.
  await page.goto(`/projects/${projectBId}/workbench`);
  await expect(page.getByText(/Project details unavailable/i)).toBeVisible({ timeout: 20_000 });
  // The graph is unavailable — NOT project B's data.
  await expect(page.getByText(/work graph is unavailable/i)).toBeVisible();
  // No project B data ever renders (the SECRET item title must never appear).
  await expect(page.getByText('SECRET project B item')).toHaveCount(0);
  await expect(page.getByText('WB-B-E2E-001')).toHaveCount(0);

  // THE PR #76 REVIEW CORRECTION, proven in the real browser: the 403s are
  // ERRORS, never fabricated empty states. The executions rollup must say
  // "Executions unavailable" — and must NOT say "No executions".
  await page.getByRole('tab', { name: /Executions/i }).click();
  await expect(page.getByText(/Executions unavailable/i)).toBeVisible();
  await expect(page.getByText('No executions', { exact: true })).toHaveCount(0);

  // The workflow authority's next-item query also 403s: an explicit
  // "Next work item unavailable" — never a false "no eligible next item".
  await page.getByRole('tab', { name: /Overview/i }).click();
  await expect(page.getByText(/Next work item unavailable/i)).toBeVisible();
  await expect(page.getByText(/No eligible next work item/i)).toHaveCount(0);
});
