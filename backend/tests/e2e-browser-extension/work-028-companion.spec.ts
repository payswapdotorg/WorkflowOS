/**
 * WORK-028 — Companion extension browser E2E.
 *
 * Proves the REAL extension (loaded unpacked into a persistent Chromium
 * context — MV3 service worker + content scripts) communicates with the REAL
 * WorkflowOS backend through the full §27 loop:
 *
 *   WorkflowOS SPA (Vite) → Start Implementation → External → Fake provider
 *   → Open with Companion → /companion/handoff#ref=… → extension bridge
 *   content script → background redeems the ONE-TIME handoff token
 *   (POST /api/companion/redeem, no API key) → session → fake provider
 *   extension page opens (auto lifecycle) → execution events reported with
 *   the scoped x-callback-token → WorkflowOS execution reaches `completed`.
 *
 * Also proves: the popup renders the completed session; the consumed handoff
 * token cannot be redeemed twice (409); COMPANION_HANDOFF_REDEEMED +
 * EXECUTION_STARTED/COMPLETED audit events exist; the one-time ref appears
 * in the URL fragment only.
 *
 * Requires: `cd extension && bun install && bun run build` beforehand.
 */
import { test, expect, chromium } from '@playwright/test';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import {
  PgExecutionRecordRepository,
  PgExecutionEventRepository,
  PgExecutionHandoffRepository,
  PgExecutionCallbackRepository,
} from '../../src/modules/agents/internal/pg-execution-repository.js';
import { NativeExecutionProvider } from '../../src/modules/agents/internal/native-execution-provider.js';
import { ExternalExecutionProvider } from '../../src/modules/agents/internal/external-execution-provider.js';
import { DefaultExecutionService } from '../../src/modules/agents/internal/execution-service.js';
import { DefaultExecutionHandoffService } from '../../src/modules/agents/internal/execution-handoff-service.js';
import { DefaultExecutionCallbackService } from '../../src/modules/agents/internal/execution-callback-service.js';
import { DefaultExecutionEventIngestionService } from '../../src/modules/agents/internal/execution-event-ingestion-service.js';
import { DefaultExecutionPromptBuilder } from '../../src/modules/work-items/internal/execution-prompt-builder.js';
import { DefaultExecutionTaskService } from '../../src/modules/work-items/internal/execution-task-service.js';
import type { FastifyInstance } from 'fastify';
import type { Worker } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIST = join(HERE, '..', '..', '..', 'extension', 'dist');

const API_KEY = 'raw-key-work028-browser-e2e';

let stack: TestIdentityStack;
let server: FastifyInstance;
let auditService: DefaultAuditService;
let workflowEngine: DefaultWorkflowEngine;
let project: { id: string };
let version: { id: string };
let requirementId: string;
let criterionId: string;

test.beforeAll(async () => {
  // The extension must be built first (CI workflow does this explicitly).
  test.skip(!existsSync(EXTENSION_DIST), 'extension/dist not built — run `cd extension && bun run build`');

  process.env.AGENT_PROVIDER_NAME = 'fake';
  process.env.AGENT_DEFAULT_MODEL = 'test-agent-model';
  process.env.AGENT_API_KEY = 'work028-test-agent-key';

  process.env['WFOS_TEST_WORK028_BROWSER_KEY'] = API_KEY;
  stack = await buildIdentityStack();
  const org = await stack.organizationRepository.create({ name: 'WORK-028 Browser E2E Org' });
  const user = await stack.userRepository.upsertByExternalId({
    externalId: 'work028-browser-user',
    displayName: 'WORK-028 Browser User',
  });
  await stack.membershipRepository.assign({ userId: user.id, organizationId: org.id, roleId: 'owner' });
  await stack.apiKeyProvisioner.provision({
    keyId: 'work028-browser-key',
    secretRef: 'WFOS_TEST_WORK028_BROWSER_KEY',
    externalId: 'work028-browser-user',
    label: 'WORK-028 Browser Key',
    rawKey: API_KEY,
  });
  project = await stack.projectRepository.create({ organizationId: org.id, name: 'WORK-028 Project' });
  await stack.projectAccessRepository.grant({ userId: user.id, projectId: project.id, roleId: 'owner' });

  // Architecture chain.
  const arch = await stack.architectureRepository.create({ projectId: project.id, name: 'W28 Arch' });
  version = await stack.architectureVersionRepository.create({
    architectureId: arch.id,
    contentInline: '# W28 constraints',
  });
  await stack.architectureVersionRepository.transitionState(version.id, 'frozen', user.id);
  const req = await stack.requirementRepository.create({
    architectureVersionId: version.id,
    requirementId: 'REQ-W028-001',
    title: 'Companion loop works',
    description: 'The extension completes a full execution lifecycle',
  });
  requirementId = req.id;
  const crit = await stack.acceptanceCriterionRepository.create({
    requirementId: req.id,
    criterionId: 'AC-W028-1',
    description: 'Execution completes via the Companion',
    verificationExpectation: 'integration-test',
  });
  criterionId = crit.id;

  // Backend topology (mirrors the work-027 spec + the companion route group).
  const capture = new CaptureStream();
  const logger = createLogger({ level: 'warn', destination: capture });
  const queue = new InMemoryQueue();
  const fakeAgent = new FakeAgentAdapter();
  const agentGateway = new DefaultAgentGateway(stack.db.client, logger, [fakeAgent], 3);
  const agentRunRepo = new PgAgentRunRepository(stack.db.client);
  const reviewService = new DefaultReviewService(stack.db.client, stack.workItemRepository, logger);
  auditService = new DefaultAuditService(stack.db.client, stack.db.logger);
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
    undefined, undefined, undefined,
    async (workItemId: string) => {
      const reviews = await reviewService.listReviewsForWorkItem(workItemId);
      return Promise.all(
        reviews
          .filter((r) => r.status === 'completed' && r.outcome !== null)
          .map(async (r) => {
            const findings = await reviewService.listFindingsForReview(r.id);
            return {
              reviewId: r.id, verdict: r.outcome ?? '', summary: r.summary ?? '',
              findings: findings.map((f) => f.description), createdAt: r.createdAt.toISOString(),
            };
          }),
      );
    },
  );

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
  const executionRecordRepo = new PgExecutionRecordRepository(stack.db.client);
  const executionService = new DefaultExecutionService({
    executionRecordRepository: executionRecordRepo,
    providers: [
      new NativeExecutionProvider({ agentGateway, agentRunRepository: agentRunRepo, logger }),
      new ExternalExecutionProvider(),
    ],
    auditService,
    logger,
  
  });
  const executionHandoffService = new DefaultExecutionHandoffService({
    executionRecordRepository: executionRecordRepo,
    handoffRepository: new PgExecutionHandoffRepository(stack.db.client),
    auditService,
    logger,
  });
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
  const agentProviderRegistryService = new DefaultAgentProviderRegistryService(
    new DefaultAgentProviderRegistry(stack.secretStore),
    new PgAgentProviderConfigRepository(stack.db.client),
    stack.secretStore,
  );

  server = await buildServer({
    queue,
    logger,
    health: {},
    auth: buildAuthPluginDeps(stack),
    identity: buildIdentityRouteDeps(stack),
    organizations: buildOrganizationsRouteDeps(stack),
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
      startImplementationService: new DefaultStartImplementationService({
        executionTaskService,
        executionService,
        logger,
      }),
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
      agentProviderConfigRepository: new PgAgentProviderConfigRepository(stack.db.client),
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
    // WORK-028: the token-only companion redemption endpoint the extension
    // calls (no API key — the one-time handoff token is the authority).
    companion: {
      executionHandoffService,
      executionCallbackService,
    },
  });
  await server.ready();
  await server.listen({ port: 3001, host: '127.0.0.1' });
});

test.afterAll(async () => {
  await server?.close();
  await stack?.teardown();
  delete process.env.AGENT_PROVIDER_NAME;
  delete process.env.AGENT_DEFAULT_MODEL;
  delete process.env.AGENT_API_KEY;
});

async function createReadyWorkItem(label: string) {
  const wi = await stack.workItemRepository.create({
    architectureVersionId: version.id,
    workItemId: label,
    title: label,
    objective: 'Prove the Companion extension loop',
    scope: 'Extension handoff end-to-end',
  });
  await stack.workItemRequirementRepository.associate(wi.id, requirementId);
  await stack.workItemCriterionRepository.associate(wi.id, criterionId);
  await stack.workOrderRepository.create({
    workItemId: wi.id,
    projectId: project.id,
    architectureVersionId: version.id,
    scope: 'Extension handoff end-to-end',
    outOfScope: 'Nothing',
    architectureConstraints: 'None',
    verificationRequirements: ['All tests pass'],
  });
  await workflowEngine.transition({ workItemId: wi.id, toState: 'ready', actor: 'w28-e2e' });
  return wi;
}

test.describe('WORKFLOWOS — WORK-028 Companion extension E2E', () => {
  test('full loop: Open with Companion → extension redeems → fake provider → events → completed', async () => {
    test.setTimeout(180_000);

    // --- 1. Launch the persistent context with the REAL extension loaded. ---
    const userDataDir = mkdtempSync(join(tmpdir(), 'wfos-companion-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium', // new headless supports MV3 extensions
      headless: true,
      args: [
        `--disable-extensions-except=${EXTENSION_DIST}`,
        `--load-extension=${EXTENSION_DIST}`,
        '--no-sandbox',
      ],
    });

    try {
      // Locate the extension's background service worker (proves MV3 boot).
      let sw: Worker | undefined = context.serviceWorkers().find((w) =>
        w.url().includes('background'),
      );
      if (!sw) {
        sw = (await context.waitForEvent('serviceworker', { timeout: 20_000 })) as Worker;
      }
      const extensionId = new URL(sw.url()).host;
      expect(extensionId).toBeTruthy();

      // --- 2. Drive the WorkflowOS SPA. ---
      const page =
        context.pages()[0] ?? (await context.newPage());
      await loginBrowser(page);

      const wi = await createReadyWorkItem('WORK-COMPANION-001');
      await page.goto(`/work-items/${wi.id}`);
      await expect(page.locator('h1')).toContainText('WORK-COMPANION-001');

      // --- 3. Start Implementation → External → Fake (test) provider. ---
      await page.getByRole('button', { name: /Start Implementation/ }).first().click();
      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toContainText('Start Implementation — WORK-COMPANION-001');
      await dialog.getByLabel('External execution').check();
      await dialog.locator('#execution-provider').selectOption('fake');
      await dialog.getByRole('button', { name: 'Start Implementation' }).click();

      // The external execution handoff dialog opens (handoff_ready).
      const handoffDialog = page.locator('[role="dialog"]');
      await expect(handoffDialog).toContainText('External Execution', { timeout: 15_000 });
      await expect(handoffDialog).toContainText('Ready for external handoff');

      // --- 4. Open with Companion → SPA navigates to the handoff page. ---
      await handoffDialog
        .getByRole('button', { name: /Open with Companion/ })
        .click();
      await page.waitForURL(/\/companion\/handoff#/, { timeout: 15_000 });

      // The URL fragment carries ONLY the one-time ref + execution id.
      const url = page.url();
      expect(url).toMatch(/#ref=wfht_[0-9a-f]+/);
      expect(url).not.toMatch(/wfct_|prompt/i);
      const ref = new URL(url).hash.match(/ref=(wfht_[0-9a-f]+)/)![1]!;
      const executionId = url.match(/exec=(wf_[0-9a-f]+)/)![1]!;

      // --- 5. The extension picks the handoff up (bridge content script +
      //     background redemption). The SPA page shows the connected state. ---
      await expect(page.getByText('Companion connected')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText(/Session opened with provider/i)).toBeVisible({
        timeout: 20_000,
      });

      // --- 6. The fake provider page opened + auto-ran. Poll WorkflowOS
      //     until the execution completes via the reported events. ---
      let finalStatus = '';
      for (let i = 0; i < 120; i++) {
        const res = await server.inject({
          method: 'GET',
          url: `/execution/${executionId}`,
          headers: { 'x-api-key': API_KEY },
        });
        if (res.statusCode === 200) {
          const body = res.json() as { execution: { status: string } };
          finalStatus = body.execution.status;
          if (finalStatus === 'completed') break;
        }
        await page.waitForTimeout(500);
      }
      expect(finalStatus, 'execution should complete via Companion events').toBe('completed');

      // --- 7. The popup renders the completed session. ---
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/ui/popup/index.html`);
      await expect(popup.locator('#work-item')).toHaveText('WORK-COMPANION-001');
      // WORK-029: the popup resolves display labels from the registry's
      // capability list — the fake provider renders as its display name.
      await expect(popup.locator('#provider')).toHaveText('Fake (test)');
      await expect(popup.locator('#branch')).toHaveText(/feat\/work-companion-001/);
      // WORK-029 §26: the status renders as "✓ <phase> · <status>" — the
      // fake-provider flow never updates the page phase, so assert the
      // terminal status as a substring (as the WORK-029 spec does).
      await expect(popup.locator('#status')).toContainText('completed');
      await popup.close();

      // --- 8. The fake provider tab exists (Companion-managed). ---
      const fakePage = context
        .pages()
        .find((p) => p.url().includes('ui/fake-provider/index.html'));
      expect(fakePage).toBeTruthy();

      // --- 9. Audit trail: companion redemption + execution lifecycle. ---
      const events = await auditService.listForProject(project.id, {});
      const types = events
        .filter((e) => e.executionId === executionId)
        .map((e) => e.eventType);
      expect(types).toContain('COMPANION_HANDOFF_REDEEMED');
      expect(types).toContain('EXECUTION_STARTED');
      expect(types).toContain('EXECUTION_COMPLETED');

      // --- 10. One-time semantics: the consumed ref cannot redeem twice. ---
      const replay = await server.inject({
        method: 'POST',
        url: '/companion/redeem',
        headers: { 'x-handoff-token': ref },
      });
      expect(replay.statusCode).toBe(409);
      expect((replay.json() as { error: string }).error).toBe('handoff-token-already-used');
    } finally {
      await context.close();
    }
  });
});

/** WORK-074: seed a REAL server-side session (the retired demo-key localStorage
 *  login is no longer read by the frontend — the HttpOnly cookie is the
 *  production transport). */
async function loginBrowser(page: import('@playwright/test').Page): Promise<void> {
  const user = await stack.userRepository.upsertByExternalId({
    externalId: 'work028-browser-user',
    displayName: 'WORK-028 Browser User',
  });
  await loginWithServerSession(page, stack.sessionService, user.id);
}
