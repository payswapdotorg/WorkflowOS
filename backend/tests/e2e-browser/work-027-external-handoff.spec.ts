/**
 * WORK-027 — External Execution Handoff Browser E2E.
 *
 * Proves the WORKFLOWOS side of the external execution flow through the real
 * browser UI (Vite SPA → proxied API → real backend topology with pglite):
 *
 *   Work Item
 *     → Start Implementation (button)
 *     → Execution Mode dialog (● Native / ○ External)
 *     → External
 *     → choose Z.ai (from the readiness list)
 *     → submit (POST /work-items/:id/execution)
 *     → WorkflowOS shows handoff-ready (Executions card + handoff dialog)
 *     → Prepare External Session (one-time token issued + redeemed)
 *     → execution package appears (repository / branch / prompt expandable /
 *       verification requirements / return callback)
 *
 * Also proves the native path through the SAME dialog (Native → fake provider
 * → AgentRun appears).
 *
 * The test does NOT automate Z.ai (that is WORK-028's Companion extension) —
 * it proves the WorkflowOS handoff foundation is correct.
 */
import { test, expect, type Page } from '@playwright/test';
import { buildIdentityStack, type TestIdentityStack } from '../helpers/test-identity-stack.js';
import { buildAuthPluginDeps, buildIdentityRouteDeps, buildOrganizationsRouteDeps } from '../helpers/test-identity-server.js';
import { loginWithServerSession } from '../helpers/browser-session.js';
import { buildServer } from '@api/server.js';
import { InMemoryQueue, createLogger } from '@platform/index.js';
import { CaptureStream } from '../helpers/capture-stream.js';
import { DefaultWorkflowEngine } from '../../src/modules/workflows/internal/workflow-engine.js';
import { DefaultAgentGateway, FakeAgentAdapter } from '../../src/modules/agents/internal/agent-gateway.js';
import { PgAgentRunRepository } from '../../src/modules/agents/internal/pg-agent-repository.js';
import { PgAgentProviderConfigRepository } from '../../src/modules/agents/internal/pg-agent-provider-config-repository.js';
import { DefaultAgentProviderRegistryService } from '../../src/modules/agents/internal/agent-provider-registry-service.js';
import { DefaultAgentProviderRegistry } from '../../src/platform/default-agent-provider-registry.js';
import { DefaultReviewService } from '../../src/modules/reviews/internal/review-service.js';
import { DefaultAuditService } from '../../src/modules/audit/internal/audit-service.js';
import { PgImplementationContextRepository } from '../../src/modules/work-items/internal/pg-implementation-context-repository.js';
import { DefaultImplementationContextBuilder } from '../../src/modules/work-items/internal/implementation-context-builder.js';
import { DefaultStartImplementationService } from '../../src/modules/work-items/internal/start-implementation-service.js';
// WORK-027: execution provider abstraction internals.
import { PgExecutionRecordRepository, PgExecutionEventRepository, PgExecutionHandoffRepository, PgExecutionCallbackRepository } from '../../src/modules/agents/internal/pg-execution-repository.js';
import { DefaultExecutionCallbackService } from '../../src/modules/agents/internal/execution-callback-service.js';
import { NativeExecutionProvider } from '../../src/modules/agents/internal/native-execution-provider.js';
import { ExternalExecutionProvider } from '../../src/modules/agents/internal/external-execution-provider.js';
import { DefaultExecutionService } from '../../src/modules/agents/internal/execution-service.js';
import { DefaultExecutionHandoffService } from '../../src/modules/agents/internal/execution-handoff-service.js';
import { DefaultExecutionEventIngestionService } from '../../src/modules/agents/internal/execution-event-ingestion-service.js';
import { DefaultExecutionPromptBuilder } from '../../src/modules/work-items/internal/execution-prompt-builder.js';
import { DefaultExecutionTaskService } from '../../src/modules/work-items/internal/execution-task-service.js';
import type { FastifyInstance } from 'fastify';

const API_KEY = 'raw-key-work027-browser-e2e';
const AGENT_PROVIDER_NAME = 'fake';
const AGENT_MODEL = 'test-agent-model';
const AGENT_API_KEY = 'work027-test-agent-key';

let stack: TestIdentityStack;
let server: FastifyInstance;
let fakeAgent: FakeAgentAdapter;
let executionRecordRepo: PgExecutionRecordRepository;
let workflowEngine: DefaultWorkflowEngine;

test.beforeAll(async () => {
  process.env.AGENT_PROVIDER_NAME = AGENT_PROVIDER_NAME;
  process.env.AGENT_DEFAULT_MODEL = AGENT_MODEL;
  process.env.AGENT_API_KEY = AGENT_API_KEY;

  process.env.WFOS_TEST_WORK027_BROWSER_KEY = API_KEY;
  stack = await buildIdentityStack();

  const org = await stack.organizationRepository.create({ name: 'WORK-027 Browser E2E Org' });
  const user = await stack.userRepository.upsertByExternalId({
    externalId: 'work027-browser-user',
    displayName: 'WORK-027 Browser User',
  });
  await stack.membershipRepository.assign({ userId: user.id, organizationId: org.id, roleId: 'owner' });
  await stack.apiKeyProvisioner.provision({
    keyId: 'work027-browser-key',
    secretRef: 'WFOS_TEST_WORK027_BROWSER_KEY',
    externalId: 'work027-browser-user',
    label: 'WORK-027 Browser Key',
    rawKey: API_KEY,
  });

  const capture = new CaptureStream();
  const logger = createLogger({ level: 'warn', destination: capture });
  const queue = new InMemoryQueue();
  fakeAgent = new FakeAgentAdapter();

  const agentGateway = new DefaultAgentGateway(stack.db.client, logger, [fakeAgent], 3);
  const agentRunRepo = new PgAgentRunRepository(stack.db.client);
  const reviewService = new DefaultReviewService(stack.db.client, stack.workItemRepository, stack.db.logger);
  const auditService = new DefaultAuditService(stack.db.client, stack.db.logger);
  workflowEngine = new DefaultWorkflowEngine(stack.db.client, stack.db.logger);

  const implementationContextRepo = new PgImplementationContextRepository(stack.db.client);
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
    implementationContextRepo,
    undefined,
    undefined,
    undefined,
    async (workItemId: string) => {
      const reviews = await reviewService.listReviewsForWorkItem(workItemId);
      return Promise.all(
        reviews
          .filter((r) => r.status === 'completed' && r.outcome !== null)
          .map(async (r) => {
            const findings = await reviewService.listFindingsForReview(r.id);
            return {
              reviewId: r.id,
              verdict: r.outcome ?? '',
              summary: r.summary ?? '',
              findings: findings.map((f) => f.description),
              createdAt: r.createdAt.toISOString(),
            };
          }),
      );
    },
  );

  // WORK-027: execution provider abstraction (mirrors app.ts wiring).
  const executionTaskService = new DefaultExecutionTaskService({
    workItemRepository: stack.workItemRepository,
    workOrderRepository: stack.workOrderRepository,
    architectureVersionRepository: stack.architectureVersionRepository,
    architectureRepository: stack.architectureRepository,
    implementationContextBuilder,
    contextRepository: implementationContextRepo,
    promptBuilder: new DefaultExecutionPromptBuilder(),
    logger,
  });
  const nativeExecutionProvider = new NativeExecutionProvider({
    agentGateway,
    agentRunRepository: agentRunRepo,
    logger,
  });
  const externalExecutionProvider = new ExternalExecutionProvider();
  executionRecordRepo = new PgExecutionRecordRepository(stack.db.client);
  const executionService = new DefaultExecutionService({
    executionRecordRepository: executionRecordRepo,
    providers: [nativeExecutionProvider, externalExecutionProvider],
    auditService,
    logger,
  
  });
  const executionHandoffService = new DefaultExecutionHandoffService({
    executionRecordRepository: executionRecordRepo,
    handoffRepository: new PgExecutionHandoffRepository(stack.db.client),
    auditService,
    logger,
  });
  // PR #30 review fix #2: scoped event-ingestion callback credentials.
  const executionCallbackService = new DefaultExecutionCallbackService({
    executionRecordRepository: executionRecordRepo,
    callbackRepository: new PgExecutionCallbackRepository(stack.db.client),
    auditService,
    logger,
  });
  const executionEventIngestionService = new DefaultExecutionEventIngestionService({
    executionRecordRepository: executionRecordRepo,
    eventRepository: new PgExecutionEventRepository(stack.db.client),
    auditService,
    logger,
  });
  const startImplementationService = new DefaultStartImplementationService({
    executionTaskService,
    executionService,
    logger,
  });
  const agentProviderConfigRepository = new PgAgentProviderConfigRepository(stack.db.client);
  const agentProviderRegistryService = new DefaultAgentProviderRegistryService(
    new DefaultAgentProviderRegistry(stack.secretStore),
    agentProviderConfigRepository,
    stack.secretStore,
  );

  server = await buildServer({
    queue,
    logger,
    health: {},
    auth: buildAuthPluginDeps(stack),
    identity: buildIdentityRouteDeps(stack),
    organizations: buildOrganizationsRouteDeps(stack),
    projects: {
      authorizationService: stack.authorizationService,
      organizationRepository: stack.organizationRepository,
      membershipRepository: stack.membershipRepository,
      projectRepository: stack.projectRepository,
      projectAccessRepository: stack.projectAccessRepository,
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
    requirements: {
      authorizationService: stack.authorizationService,
      architectureRepository: stack.architectureRepository,
      architectureVersionRepository: stack.architectureVersionRepository,
      requirementRepository: stack.requirementRepository,
      requirementDependencyRepository: stack.requirementDependencyRepository,
      acceptanceCriterionRepository: stack.acceptanceCriterionRepository,
      evidenceReferenceRepository: stack.evidenceReferenceRepository,
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
      implementationContextBuilder,
      startImplementationService,
      executionTaskService,
      executionService,
      agentProviderRegistryService,
    },
    agents: {
      authorizationService: stack.authorizationService,
      projectRepository: stack.projectRepository,
      architectureRepository: stack.architectureRepository,
      architectureVersionRepository: stack.architectureVersionRepository,
      workItemRepository: stack.workItemRepository,
      agentGateway,
      agentRunRepository: agentRunRepo,
      queue,
      agentProviderRegistryService,
      agentProviderConfigRepository,
    },
    execution: {
      authorizationService: stack.authorizationService,
      workItemRepository: stack.workItemRepository,
      architectureRepository: stack.architectureRepository,
      architectureVersionRepository: stack.architectureVersionRepository,
      executionRecordRepository: executionRecordRepo,
      executionHandoffService,
      executionCallbackService,
      executionEventIngestionService,
    },
  });
  await server.ready();
  // 127.0.0.1:3001 — the Vite dev proxy target for /api.
  await server.listen({ port: 3001, host: '127.0.0.1' });
});

test.afterAll(async () => {
  await server.close();
  await stack.teardown();
  delete process.env.AGENT_PROVIDER_NAME;
  delete process.env.AGENT_DEFAULT_MODEL;
  delete process.env.AGENT_API_KEY;
});

/** Helper: inject the API key + navigate to the app. */
async function loginAndNavigate(page: Page): Promise<void> {
  // WORK-074: the demo-key localStorage login is RETIRED from the frontend
  // (the customer login path is the human login; the API-key path remains
  // automation-only). The specs seed a REAL server-side session through the
  // SAME SessionService the /auth routes use and attach the HttpOnly
  // `wfos_session` cookie — the production transport.
  const user = await stack.userRepository.upsertByExternalId({
    externalId: 'work027-browser-user',
    displayName: 'WORK-027 Browser User',
  });
  await loginWithServerSession(page, stack.sessionService, user.id);
  await page.goto('/');
}

test.describe('WORKFLOWOS — WORK-027 External Execution Handoff Browser E2E', () => {
  test('drives the external handoff flow through the browser UI (mode → Z.ai → package)', async ({ page }) => {
    test.setTimeout(120_000);
    await loginAndNavigate(page);

    // ---------------------------------------------------------------
    // 1. Create the project + a READY work item with requirement,
    //    criterion + Work Order (via API/repositories — the UI flows under
    //    test are the execution-mode + handoff views).
    // ---------------------------------------------------------------
    const org = await stack.organizationRepository.create({ name: 'WORK-027 Project Org' });
    const user = await stack.userRepository.upsertByExternalId({
      externalId: 'work027-browser-user',
      displayName: 'WORK-027 Browser User',
    });
    await stack.membershipRepository.assign({ userId: user.id, organizationId: org.id, roleId: 'owner' });

    const projectRes = await server.inject({
      method: 'POST',
      url: `/organizations/${org.id}/projects`,
      headers: { 'x-api-key': API_KEY },
      payload: { name: 'WORK-027 External Project' },
    });
    expect(projectRes.statusCode).toBe(201);
    const projectId = (projectRes.json() as { id: string }).id;

    const archRes = await server.inject({
      method: 'POST',
      url: `/projects/${projectId}/architectures`,
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
      payload: { name: 'WORK-027 Architecture' },
    });
    expect(archRes.statusCode).toBe(201);
    const archId = (archRes.json() as { id: string }).id;

    const versionRes = await server.inject({
      method: 'POST',
      url: `/architectures/${archId}/versions`,
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
      payload: {
        contentInline:
          '# WORK-027 Architecture\n\n## Constraints\n- PostgreSQL is authoritative\n- Frontend is consumer only',
      },
    });
    expect(versionRes.statusCode).toBe(201);
    const versionId = (versionRes.json() as { id: string }).id;

    // WORK-051 round 1: the governed no-assertions declaration.
    const freezeRes = await server.inject({
      method: 'POST',
      url: `/architecture-versions/${versionId}/freeze`,
      headers: { 'x-api-key': API_KEY },
      payload: { allowEmptyAssertionSet: true },
    });
    expect(freezeRes.statusCode).toBe(200);

    const reqRes = await server.inject({
      method: 'POST',
      url: `/architecture-versions/${versionId}/requirements`,
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
      payload: {
        requirementId: 'REQ-W027-001',
        title: 'External handoff works',
        description: 'The external execution package contains everything needed',
      },
    });
    expect(reqRes.statusCode).toBe(201);
    const requirementId = (reqRes.json() as { id: string }).id;

    const critRes = await server.inject({
      method: 'POST',
      url: `/requirements/${requirementId}/criteria`,
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
      payload: {
        criterionId: 'AC-W027-1',
        description: 'Package includes the deterministic prompt',
        verificationExpectation: 'integration-test',
      },
    });
    expect(critRes.statusCode).toBe(201);
    const criterionId = (critRes.json() as { id: string }).id;

    const wiRes = await server.inject({
      method: 'POST',
      url: `/architecture-versions/${versionId}/work-items`,
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
      payload: {
        workItemId: 'WORK-EXT-E2E-001',
        title: 'External execution E2E',
        objective: 'Prove the external handoff flow',
        scope: 'Execution mode dialog + handoff package',
      },
    });
    expect(wiRes.statusCode).toBe(201);
    const workItemId = (wiRes.json() as { id: string }).id;

    await server.inject({
      method: 'POST',
      url: `/work-items/${workItemId}/requirements`,
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
      payload: { requirementId },
    });
    await server.inject({
      method: 'POST',
      url: `/work-items/${workItemId}/criteria`,
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
      payload: { criterionId },
    });
    await server.inject({
      method: 'POST',
      url: `/work-items/${workItemId}/work-orders`,
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
      payload: {
        scope: 'Execution mode dialog + handoff package',
        outOfScope: 'Nothing',
        architectureConstraints: 'None',
        verificationRequirements: ['All tests pass'],
      },
    });
    await workflowEngine.transition({ workItemId, toState: 'ready', actor: 'work027-browser-e2e' });

    // ---------------------------------------------------------------
    // 2. Open the Work Item page in the UI.
    // ---------------------------------------------------------------
    await page.goto(`/work-items/${workItemId}`);
    await expect(page.locator('h1')).toContainText('WORK-EXT-E2E-001');
    await expect(page.getByRole('button', { name: /Start Implementation/ })).toBeVisible();

    // ---------------------------------------------------------------
    // 3. Start Implementation → Execution Mode dialog.
    // ---------------------------------------------------------------
    await page.getByRole('button', { name: /Start Implementation/ }).first().click();

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Start Implementation — WORK-EXT-E2E-001');

    // Provider readiness grid (safe metadata from the registry).
    await expect(dialog.getByText('Z.ai')).toBeVisible();
    await expect(dialog.getByText('Native: Not configured').first()).toBeVisible();
    await expect(dialog.getByText('External: Available').first()).toBeVisible();
    await expect(dialog.getByText('ChatGPT')).toBeVisible();
    await expect(dialog.getByText('Claude')).toBeVisible();

    // ---------------------------------------------------------------
    // 4. Choose EXTERNAL + Z.ai.
    // ---------------------------------------------------------------
    await dialog.getByLabel('External execution').check();
    // WORK-028: 'fake' is also external-capable (test-mode catalog entry), so
    // the select may retain it — this test exercises the Z.ai flow explicitly.
    await dialog.locator('#execution-provider').selectOption('zai');
    await expect(dialog.locator('#execution-provider')).toHaveValue('zai');

    // ---------------------------------------------------------------
    // 5. Submit → WorkflowOS shows handoff-ready.
    // ---------------------------------------------------------------
    await dialog.getByRole('button', { name: 'Start Implementation' }).click();

    // The mode dialog closes and the External Execution handoff dialog opens
    // automatically (same [role=dialog] slot).
    const handoffDialog = page.locator('[role="dialog"]');
    await expect(handoffDialog).toContainText('External Execution', { timeout: 15_000 });
    await expect(handoffDialog).toContainText('Ready for external handoff');
    await expect(handoffDialog).toContainText('zai');

    // ---------------------------------------------------------------
    // 6. Prepare External Session → the execution package appears.
    // ---------------------------------------------------------------
    await handoffDialog.getByRole('button', { name: 'Prepare External Session' }).click();
    await expect(handoffDialog.getByText('feat/work-ext-e2e-001')).toBeVisible({ timeout: 15_000 });
    // Verification + callback sections.
    await expect(handoffDialog.getByText('Verification requirements')).toBeVisible();
    await expect(handoffDialog.getByText('All tests pass')).toBeVisible();
    await expect(handoffDialog.getByText(`/execution/wf_`)).toBeVisible();

    // Prompt is expandable + inspectable (deterministic, generated by WorkflowOS).
    await handoffDialog.getByRole('button', { name: /Prompt \(deterministic/ }).click();
    await expect(handoffDialog.getByText('# Implementation Instructions — WORK-EXT-E2E-001')).toBeVisible();
    await expect(handoffDialog.getByText('## Objective')).toBeVisible();
    await expect(handoffDialog.getByText('External handoff works')).toBeVisible();

    // The package contains no secrets (no token echo, no key material).
    const dialogText = await handoffDialog.innerText();
    expect(dialogText.toLowerCase()).not.toContain('wfht_');
    expect(dialogText.toLowerCase()).not.toContain('api_key');

    // ---------------------------------------------------------------
    // 7. Close the dialog → the unified execution section shows the external
    //    execution with its status (safe metadata only).
    // ---------------------------------------------------------------
    await page.keyboard.press('Escape');
    await expect(handoffDialog).toBeHidden();

    // The WORK-050 unified execution section (Implementation tab) shows the
    // external execution with its status — WorkflowOS shows handoff-ready.
    // (The former "Executions" card was superseded by the unified section:
    // the same authoritative execution record, rendered as "Actually
    // selected" with the record's own provider/mode.)
    await expect(page.getByTestId('execution-actually-selected')).toBeVisible();
    await expect(page.getByTestId('execution-actually-selected')).toContainText('External');
    await expect(page.getByTestId('execution-actually-selected')).toContainText('zai');
    // StatusBadge humanizes backend states ('handoff_ready' → 'Handoff Ready').
    await expect(page.getByText(/Handoff Ready|Submitted/i).first()).toBeVisible();

    // ---------------------------------------------------------------
    // 8. NATIVE mode through the same dialog (second work item) — the
    //    unchanged native path still produces an AgentRun.
    // ---------------------------------------------------------------
    const wi2Res = await server.inject({
      method: 'POST',
      url: `/architecture-versions/${versionId}/work-items`,
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
      payload: {
        workItemId: 'WORK-NATIVE-E2E-001',
        title: 'Native execution E2E',
        objective: 'Prove the native path through the new abstraction',
        scope: 'Execution mode dialog native mode',
      },
    });
    expect(wi2Res.statusCode).toBe(201);
    const wi2Id = (wi2Res.json() as { id: string }).id;
    await server.inject({
      method: 'POST',
      url: `/work-items/${wi2Id}/requirements`,
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
      payload: { requirementId },
    });
    await server.inject({
      method: 'POST',
      url: `/work-items/${wi2Id}/criteria`,
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
      payload: { criterionId },
    });
    await server.inject({
      method: 'POST',
      url: `/work-items/${wi2Id}/work-orders`,
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
      payload: { scope: 'Native mode', outOfScope: 'Nothing', verificationRequirements: [] },
    });
    await workflowEngine.transition({ workItemId: wi2Id, toState: 'ready', actor: 'work027-browser-e2e' });

    await page.goto(`/work-items/${wi2Id}`);
    await expect(page.locator('h1')).toContainText('WORK-NATIVE-E2E-001');
    await page.getByRole('button', { name: /Start Implementation/ }).first().click();

    const nativeDialog = page.locator('[role="dialog"]');
    await expect(nativeDialog).toBeVisible();
    // Native is the default; the fake provider is the configured native one.
    await expect(nativeDialog.locator('#execution-provider')).toHaveValue('fake');
    await nativeDialog.getByRole('button', { name: 'Start Implementation' }).click();
    await expect(nativeDialog).toBeHidden({ timeout: 15_000 });

    // The AgentRun from the (synchronous) native execution appears in the
    // Agent Runs card (StatusBadge humanizes 'success' → 'Success'). The
    // empty state disappears once loadAll() lands the refreshed list.
    await expect(page.getByText('No agent runs')).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText('fake').first()).toBeVisible();
    await expect(page.getByText('Success').first()).toBeVisible();

    // And the execution record exists server-side with mode native.
    const listRes = await server.inject({
      method: 'GET',
      url: `/work-items/${wi2Id}/executions`,
      headers: { 'x-api-key': API_KEY },
    });
    expect(listRes.statusCode).toBe(200);
    const { executions } = listRes.json() as { executions: Array<{ mode: string; status: string }> };
    expect(executions.length).toBeGreaterThan(0);
    expect(executions[0]!.mode).toBe('native');
    expect(executions[0]!.status).toBe('completed');
  });
});
