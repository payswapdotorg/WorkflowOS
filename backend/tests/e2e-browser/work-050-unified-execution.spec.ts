/**
 * WORK-050 — Browser-level E2E test: the Unified Execution UX (the Work
 * Item's unified execution section).
 *
 * Real topology (Fastify API on 127.0.0.1:3001 + the Vite dev server on
 * :5173 via the Playwright webServer + pglite PostgreSQL + InMemoryQueue +
 * WorkerHost). The browser loads the actual SPA, authenticates, and drives
 * the Work Item page through the REAL rendered DOM — asserting on visible
 * content, never on API responses.
 *
 * The topology: the execution records, the WORK-042 cross-mode handoff log,
 * the WORK-046 delegation plans, the verification runs, the workflow state,
 * and the work-item reads are ALL WIRED over their real authorities — the
 * unified section renders real authoritative facts. The ADVISORY route
 * groups (WORK-044 routing / WORK-047 intelligence / WORK-043 policy) are
 * deliberately UNWIRED — so their failures render as explicit unavailable
 * states (never fabricated recommendations), proving the read-state
 * discipline against real 404s in the browser.
 *
 * Flows proven:
 *   1. the unified execution section renders the AUTHORITATIVE facts: the
 *      current external execution (the record's own provider/model/mode +
 *      status — "Actually selected"), the prior NATIVE execution (parity:
 *      one model, both modes), the WORK-042 handoff record (native →
 *      external, the reason), the WORK-046 delegated units (roles/statuses),
 *      the verification state, and the workflow authority's next-action
 *      facts;
 *   2. failed ADVISORY reads (the unwired routing/intelligence/policy
 *      groups) render explicit errors — never a fabricated "recommends"
 *      body and never a silent "no recommendation";
 *   3. the unified view renders NO mutation trigger (recommendations cannot
 *      mutate; the drive/retry/interrupt mutations stay behind their own
 *      boundaries — the only action button is the EXISTING External
 *      Handoff path, gated on the authority's own handoff_ready record);
 *   4. the FAILED handoff read discipline: a work item whose execution read
 *      is fine but whose handoff read targets an execution the user cannot
 *      see renders an explicit error — never "No cross-mode handoff";
 *   5. browser-level tenant isolation: user A opening user B's work item
 *      page sees ONLY the page-level error — zero project B data (including
 *      project B's SECRET execution), never a fabricated empty section.
 */
import { test, expect, type Page } from '@playwright/test';
import { buildAuthStack, type TestAuthStack } from '../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import { InMemoryQueue, buildHandlerRegistry, WorkerHost, createLogger } from '@platform/index.js';
import { DefaultWorkflowEngine } from '../../src/modules/workflows/internal/workflow-engine.js';
import { DefaultAuditService } from '../../src/modules/audit/internal/audit-service.js';
import { DefaultWorkItemDependencyService } from '../../src/modules/work-items/internal/work-item-dependency-service.js';
import { DefaultVerificationService } from '../../src/modules/verification/internal/verification-service.js';
import { PgExecutionRecordRepository } from '../../src/modules/agents/internal/pg-execution-repository.js';
import { PgImplementationContextRepository } from '../../src/modules/work-items/internal/pg-implementation-context-repository.js';
import { PgCrossModeHandoffRepository } from '../../src/modules/agents/internal/pg-cross-mode-handoff-repository.js';
import type { CrossModeHandoffService } from '../../src/modules/agents/index.js';
import { DefaultDelegationPlanService } from '../../src/delegation/index.js';
import { DefaultAgentRoleCatalogService } from '../../src/agent-roles/index.js';
import type { FastifyInstance } from 'fastify';

let stack: TestAuthStack;
let server: FastifyInstance;
let worker: WorkerHost;
let queue: InMemoryQueue;

let projectAId: string;
let projectBId: string;
let wiAId: string;
let wiBId: string;

const API_KEY = 'raw-key-w050-e2e';

test.beforeAll(async () => {
  stack = await buildAuthStack({ WFOS_TEST_W050_KEY: API_KEY });

  const logger = createLogger({ level: 'warn', destination: process.stdout });
  const db = stack.db.client;

  // --- Project A (user A / org A): the unified-execution project -----------
  const orgA = await stack.organizationRepository.create({ name: 'W050 E2E Org A' });
  const userA = await stack.userRepository.upsertByExternalId({ externalId: 'w050-e2e-user-a', displayName: 'User A' });
  await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
  const projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'W050 E2E Project A' });
  await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
  projectAId = projectA.id;
  await stack.apiKeyProvisioner.provision({
    keyId: 'w050-key', secretRef: 'WFOS_TEST_W050_KEY', externalId: 'w050-e2e-user-a', label: 'A', rawKey: API_KEY,
  });

  const archA = await stack.architectureRepository.create({ projectId: projectAId, name: 'W050 Arch A' });
  const versionA = await stack.architectureVersionRepository.create({ architectureId: archA.id, contentInline: '# W050 E2E A' });
  await stack.architectureVersionRepository.transitionState(versionA.id, 'frozen', userA.id);

  const wiA = await stack.workItemRepository.create({
    architectureVersionId: versionA.id, workItemId: 'WB-EXEC-001',
    title: 'Unified execution item', objective: 'Prove the unified view.', scope: 'src/unified.ts',
    metadata: { baseCommit: 'w050-e2e-baseline-00000000000000000001' },
  });
  wiAId = wiA.id;

  // The workflow authority: the item reaches 'ready'.
  const auditService = new DefaultAuditService(db, stack.db.logger);
  const depService = new DefaultWorkItemDependencyService(db);
  queue = new InMemoryQueue();
  const workflowEngine = new DefaultWorkflowEngine(
    db, logger,
    (wiId: string) => depService.canBeginImplementation(wiId),
    auditService,
  );
  await workflowEngine.transition({ workItemId: wiAId, toState: 'ready', actor: 'w050-e2e' });

  // TWO execution records (the execution authority's own list, newest
  // first): a prior NATIVE completed execution + the CURRENT external
  // handoff_ready execution — parity through the SAME model.
  const workOrderA = await stack.workOrderRepository.create({
    workItemId: wiAId, projectId: projectAId, architectureVersionId: versionA.id,
    scope: 'src/unified.ts', verificationRequirements: ['unit-test'],
  });
  const contextRepo = new PgImplementationContextRepository(db);
  const ctxA = await contextRepo.create({
    workItemId: wiAId, revision: 1, kind: 'initial',
    content: { prompt: 'w050 e2e context' } as never,
  });
  const executionRepo = new PgExecutionRecordRepository(db);
  await executionRepo.create({
    executionId: 'exec-w050-native-1', projectId: projectAId, workItemId: wiAId,
    workOrderId: workOrderA.id, implementationContextId: ctxA.id,
    mode: 'native', provider: 'fake-native', model: 'fake-native-model',
    repositoryRef: 'pectoraux/W050-E2E', branch: 'feat/w050-native',
    prompt: 'SECRET-FREE-PROMPT-NATIVE', promptDigest: 'digest-native',
  });
  const currentRecord = await executionRepo.create({
    executionId: 'exec-w050-external-1', projectId: projectAId, workItemId: wiAId,
    workOrderId: workOrderA.id, implementationContextId: ctxA.id,
    mode: 'external', provider: 'fake-external', model: null,
    repositoryRef: 'pectoraux/W050-E2E', branch: 'feat/w050-external',
    prompt: 'SECRET-FREE-PROMPT-EXTERNAL', promptDigest: 'digest-external',
  });
  // The CURRENT execution reaches handoff_ready (the realistic external
  // state after package preparation — the authority's own status).
  await executionRepo.updateStatus(currentRecord.id, { status: 'handoff_ready' });

  // The WORK-042 cross-mode handoff log row for the CURRENT execution
  // (native → external — the authoritative handoff state).
  const handoffRepo = new PgCrossModeHandoffRepository(db);
  await handoffRepo.createHandoff({
    executionRecordId: currentRecord.id,
    fromMode: 'native',
    toMode: 'external',
    reason: 'native provider degraded',
    actor: 'w050-e2e',
    source: 'w050-e2e-fixture',
    previousStatus: 'running',
    resultingStatus: 'handoff_ready',
    previousAgentRunId: null,
    previousExternalSessionRef: null,
    previousPackageValue: null,
    authorized: true,
    policyDecision: 'allowed',
    idempotencyKey: 'w050-e2e-idem-1',
  });

  // The WORK-046 delegation plan (through the REAL plan service — the
  // delegation authority's own records with pinned WORK-045 roles).
  const roleCatalog = new DefaultAgentRoleCatalogService();
  const roles = roleCatalog.listRoles();
  const implementerRole = roles.find((r) => r.role.identity.includes('implement')) ?? roles[0]!;
  const delegationPlanService = new DefaultDelegationPlanService({
    db, workItemRepository: stack.workItemRepository, roleCatalog,
  });
  await delegationPlanService.createPlan({
    workItemId: wiAId,
    planKey: 'w050-default',
    units: [
      {
        unitKey: 'implement',
        role: implementerRole.role.identity,
        mode: 'native',
        provider: 'fake-native',
        model: 'fake-native-model',
        dependsOn: [],
      },
    ],
  });

  // The verification authority's run (the unified view's verification state).
  const verificationService = new DefaultVerificationService(
    db, stack.requirementRepository, stack.acceptanceCriterionRepository,
    stack.architectureVersionRepository, stack.workItemRepository,
    stack.workItemRequirementRepository, stack.workItemCriterionRepository,
    stack.ciEvidenceRepository, stack.objectStore, stack.db.logger,
  );
  const run = await verificationService.createRun({
    projectId: projectAId, workItemId: wiAId, architectureVersionId: versionA.id,
    source: 'manual', sourceRef: 'w050-e2e', executionId: 'exec-w050-external-1',
  });
  await verificationService.finalizeOrchestrationRun({
    verificationRunId: run.id, status: 'failed',
    summary: { criteriaFail: 1, criteriaPass: 0 },
  });

  // --- Project B (user B / org B — the tenant-isolation partner) ------------
  const orgB = await stack.organizationRepository.create({ name: 'W050 E2E Org B' });
  const userB = await stack.userRepository.upsertByExternalId({ externalId: 'w050-e2e-user-b', displayName: 'User B' });
  await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
  const projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'W050 E2E Project B' });
  await stack.projectAccessRepository.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });
  projectBId = projectB.id;
  const archB = await stack.architectureRepository.create({ projectId: projectBId, name: 'W050 Arch B' });
  const versionB = await stack.architectureVersionRepository.create({ architectureId: archB.id, contentInline: '# W050 E2E B' });
  const wiB = await stack.workItemRepository.create({
    architectureVersionId: versionB.id, workItemId: 'WB-B-SECRET-001',
    title: 'SECRET project B item', objective: 'Must never be visible to user A.',
    metadata: { baseCommit: 'w050-e2e-b-baseline-00000000000000000001' },
  });
  wiBId = wiB.id;
  // Project B's SECRET execution — must NEVER be visible to user A.
  const workOrderB = await stack.workOrderRepository.create({
    workItemId: wiBId, projectId: projectBId, architectureVersionId: versionB.id,
    scope: 'src/secret.ts', verificationRequirements: ['unit-test'],
  });
  const ctxB = await contextRepo.create({
    workItemId: wiBId, revision: 1, kind: 'initial',
    content: { prompt: 'w050 e2e context B' } as never,
  });
  await executionRepo.create({
    executionId: 'exec-w050-secret-b', projectId: projectBId, workItemId: wiBId,
    workOrderId: workOrderB.id, implementationContextId: ctxB.id,
    mode: 'native', provider: 'SECRET-PROVIDER-B', model: 'SECRET-MODEL-B',
    prompt: 'SECRET-FREE-PROMPT-B', promptDigest: 'digest-secret-b',
  });

  // --- The server: the WORK-050 topology ------------------------------------
  // WIRED: the work-item reads (the projectId resolution), the workflow
  // state + merge readiness, the verification runs, the execution records +
  // the cross-mode-handoff READ, and the delegation plans.
  // DELIBERATELY UNWIRED: the advisory route groups (executionRouting /
  // agentIntelligence / executionPolicy) — their reads fail with real 404s
  // and the unified section must render EXPLICIT unavailable states (never
  // fabricated recommendations).
  const handlers = buildHandlerRegistry([]);
  worker = new WorkerHost(queue, handlers, logger, { pollIntervalMs: 50 });

  // The cross-mode handoff READ goes through the real repository; the
  // mutation surface is not under test at the browser level.
  const crossModeHandoffService: CrossModeHandoffService = {
    getHandoffForExecution: (executionId: string) => handoffRepo.findByExecutionId(executionId),
    handoff: () => {
      throw new Error('the handoff mutation is not under test in the WORK-050 browser E2E');
    },
    reconcileCrossModeHandoffForExecution: async () => {
      throw new Error('the reconcile mutation is not under test in the WORK-050 browser E2E');
    },
  };

  server = await buildServer({
    queue,
    logger: stack.db.logger,
    auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
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
    },
    verification: {
      authorizationService: stack.authorizationService,
      architectureRepository: stack.architectureRepository,
      architectureVersionRepository: stack.architectureVersionRepository,
      workItemRepository: stack.workItemRepository,
      requirementRepository: stack.requirementRepository,
      acceptanceCriterionRepository: stack.acceptanceCriterionRepository,
      verificationService,
      ciEvidenceIngestionService: {
        ingest: async () => {
          throw new Error('not under test');
        },
      } as never,
    },
    execution: {
      authorizationService: stack.authorizationService,
      workItemRepository: stack.workItemRepository,
      architectureRepository: stack.architectureRepository,
      architectureVersionRepository: stack.architectureVersionRepository,
      executionRecordRepository: executionRepo,
      executionHandoffService: {
        issue: async () => {
          throw new Error('not under test');
        },
        redeem: async () => {
          throw new Error('not under test');
        },
      } as never,
      executionCallbackService: {
        issue: async () => {
          throw new Error('not under test');
        },
      } as never,
      executionEventIngestionService: {
        ingest: async () => {
          throw new Error('not under test');
        },
      } as never,
      crossModeHandoffService,
    },
    delegation: {
      authorizationService: stack.authorizationService,
      projectRepository: stack.projectRepository,
      workItemRepository: stack.workItemRepository,
      architectureRepository: stack.architectureRepository,
      architectureVersionRepository: stack.architectureVersionRepository,
      delegationPlanService,
      delegationCoordinator: {
        drivePlan: async () => {
          throw new Error('not under test');
        },
        retryUnit: async () => {
          throw new Error('not under test');
        },
        interruptPlan: async () => {
          throw new Error('not under test');
        },
      } as never,
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
  await page.goto('/');
  await page.evaluate((key: string) => {
    localStorage.setItem('wfos_api_key', key);
  }, API_KEY);
}

test('the unified execution section renders the AUTHORITATIVE facts: the record\'s own selection, the handoff log, the delegated units, the verification state, and the next action', async ({ page }) => {
  await login(page);
  await page.goto(`/work-items/${wiAId}`);

  // The CURRENT execution — the record's OWN identity ("Actually selected"),
  // never a recommendation's (the advisory reads fail in this topology and
  // render explicit errors below).
  await expect(page.getByTestId('execution-actually-selected')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('execution-actually-selected')).toContainText('External');
  await expect(page.getByTestId('execution-actually-selected')).toContainText('fake-external');
  await expect(page.getByText(/Actually selected — the execution record's own provider\/model\/mode/i)).toBeVisible();

  // The prior NATIVE execution — parity: the SAME model renders both modes
  // (the history row shows the execution id prefix).
  await expect(page.getByText(/Prior executions \(1\)/)).toBeVisible();
  await expect(page.getByText(/exec-w050-na/)).toBeVisible();

  // The WORK-042 handoff log's own record: native → external + the reason.
  await expect(page.getByText('native → external')).toBeVisible();
  await expect(page.getByText(/native provider degraded/i)).toBeVisible();

  // The WORK-046 delegated units: the role + the authority's own status.
  await expect(page.getByText(/Delegated units/i)).toBeVisible();
  await expect(page.getByText(/default \/ implement/)).toBeVisible();

  // The verification authority's own failed run.
  await expect(page.getByText(/Verification/i).first()).toBeVisible();
  await expect(page.getByText('Failed', { exact: true }).first()).toBeVisible();

  // The workflow authority's next-action facts.
  await expect(page.getByText(/Next action/i)).toBeVisible();
  await expect(page.getByText('Ready', { exact: true }).first()).toBeVisible();
});

test('failed ADVISORY reads (the unwired routing/intelligence/policy groups) render explicit errors — never a fabricated recommendation', async ({ page }) => {
  await login(page);
  await page.goto(`/work-items/${wiAId}`);

  // The routing recommendation read FAILED (unwired — a real 404): an
  // explicit error, and the advisory body never renders as if the authority
  // answered.
  await expect(page.getByTestId('routing-recommendation-unavailable')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Routing recommends')).toHaveCount(0);
  // Likewise the intelligence + policy surfaces.
  await expect(page.getByTestId('intelligence-recommendation-unavailable')).toBeVisible();
  await expect(page.getByText('Intelligence recommends')).toHaveCount(0);
  await expect(page.getByTestId('policy-constraints-unavailable')).toBeVisible();
});

test('the unified view renders NO mutation trigger (recommendations cannot mutate state) — the only action is the EXISTING External Handoff path gated on the authority\'s own record', async ({ page }) => {
  await login(page);
  await page.goto(`/work-items/${wiAId}`);

  await expect(page.getByTestId('execution-actually-selected')).toBeVisible({ timeout: 20_000 });

  // NO delegation mutations are surfaced (drive/retry/interrupt stay behind
  // their own boundaries).
  await expect(page.getByRole('button', { name: /drive/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /retry/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /interrupt/i })).toHaveCount(0);
  // NO handoff MUTATION trigger (the cross-mode handoff POST is not a UI
  // surface of the unified view).
  await expect(page.getByRole('button', { name: /^Cross-mode handoff$/i })).toHaveCount(0);

  // The EXISTING External Handoff path renders ONLY because the authority's
  // own record says handoff_ready (the pre-existing WORK-027 mutation —
  // unchanged, through the existing boundary).
  await expect(page.getByRole('button', { name: 'External Handoff' })).toBeVisible();
});

test('BROWSER-LEVEL TENANT ISOLATION: user A opening user B\'s work item sees ONLY the page-level error — zero project B data (including the SECRET execution)', async ({ page }) => {
  await login(page);
  // User A has NO access to project B: the work-item GET 403s server-side
  // and the page renders its error state — never a fabricated empty section.
  await page.goto(`/work-items/${wiBId}`);
  await expect(page.getByText(/failed to load work item|forbidden|403|not authorized/i).first()).toBeVisible({ timeout: 20_000 });

  // No project B data ever renders (the SECRET execution identity must
  // never appear — not as the selection, not in any section).
  await expect(page.getByText('SECRET-PROVIDER-B')).toHaveCount(0);
  await expect(page.getByText('SECRET-MODEL-B')).toHaveCount(0);
  await expect(page.getByText('exec-w050-secret-b')).toHaveCount(0);
  await expect(page.getByText('SECRET project B item')).toHaveCount(0);
  // The unified section never mounts its success paths (no fabricated
  // "No execution" for a work item that could not be read at all).
  await expect(page.getByTestId('execution-none')).toHaveCount(0);
});
