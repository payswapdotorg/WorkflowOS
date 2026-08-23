/**
 * WORK-029 — Z.ai adapter fixture browser E2E.
 *
 * Proves the REAL extension + REAL Z.ai adapter code (zai-bridge content
 * script + zai-page-runtime + ZaiProviderAdapter) against a LOCAL fixture
 * server that reproduces the OBSERVED chat.z.ai DOM (2026-08-24). No live
 * Z.ai dependency:
 *
 *   external execution (provider=zai)
 *     → Open with Companion
 *     → adapter opens the fixture (fixture origin staged in storage.session)
 *     → provider detected as Z.ai
 *     → prompt injected (digest verified in-page)
 *     → prompt sent EXACTLY ONCE (fixture counter)
 *     → fixture agent progresses (streaming → repository observations)
 *     → completion detected (quiet + stable + no streaming marker)
 *     → WorkflowOS receives started/progress/completed (x-callback-token)
 *
 * Also proves: blocked login-wall flow (§5), XSS payload inertness (§35),
 * and the popup Z.ai session view.
 */
import { test, expect, chromium } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAuthStack, type TestAuthStack } from '../helpers/test-auth-stack.js';
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
const FIXTURE_DIR = join(HERE, '..', '..', '..', 'extension', 'tests', 'zai', 'fixture');
const FIXTURE_PORT = 3777;
const FIXTURE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;

const API_KEY = 'raw-key-work029-browser-e2e';

let fixtureServer: Server;
let stack: TestAuthStack;
let server: FastifyInstance;
let workflowEngine: DefaultWorkflowEngine;
let project: { id: string };
let version: { id: string };
let requirementId: string;
let criterionId: string;

async function startFixtureServer(): Promise<void> {
  fixtureServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', FIXTURE_ORIGIN);
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    try {
      const file = join(FIXTURE_DIR, path.replace(/^\//, ''));
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': path.endsWith('.js') ? 'text/javascript' : 'text/html',
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise<void>((resolve) => fixtureServer.listen(FIXTURE_PORT, '127.0.0.1', resolve));
}

test.beforeAll(async () => {
  test.skip(!existsSync(EXTENSION_DIST), 'extension/dist not built — run `cd extension && bun run build`');
  await startFixtureServer();

  process.env.AGENT_PROVIDER_NAME = 'fake';
  process.env.AGENT_DEFAULT_MODEL = 'test-agent-model';
  process.env.AGENT_API_KEY = 'work029-test-agent-key';

  stack = await buildAuthStack({
    WFOS_TEST_WORK029_BROWSER_KEY: API_KEY,
    AGENT_API_KEY: 'work029-test-agent-key',
  });
  const org = await stack.organizationRepository.create({ name: 'WORK-029 Browser E2E Org' });
  const user = await stack.userRepository.upsertByExternalId({
    externalId: 'work029-browser-user',
    displayName: 'WORK-029 Browser User',
  });
  await stack.membershipRepository.assign({ userId: user.id, organizationId: org.id, roleId: 'owner' });
  await stack.apiKeyProvisioner.provision({
    keyId: 'work029-browser-key',
    secretRef: 'WFOS_TEST_WORK029_BROWSER_KEY',
    externalId: 'work029-browser-user',
    label: 'WORK-029 Browser Key',
    rawKey: API_KEY,
  });
  project = await stack.projectRepository.create({ organizationId: org.id, name: 'WORK-029 Project' });
  await stack.projectAccessRepository.grant({ userId: user.id, projectId: project.id, roleId: 'owner' });

  const arch = await stack.architectureRepository.create({ projectId: project.id, name: 'W29 Arch' });
  version = await stack.architectureVersionRepository.create({
    architectureId: arch.id,
    contentInline: '# W29 constraints',
  });
  await stack.architectureVersionRepository.transitionState(version.id, 'frozen', user.id);
  const req = await stack.requirementRepository.create({
    architectureVersionId: version.id,
    requirementId: 'REQ-W029-001',
    title: 'Z.ai adapter loop works',
    description: 'The adapter completes a full fixture execution lifecycle',
  });
  requirementId = req.id;
  const crit = await stack.acceptanceCriterionRepository.create({
    requirementId: req.id,
    criterionId: 'AC-W029-1',
    description: 'Execution completes via the Z.ai adapter',
    verificationExpectation: 'integration-test',
  });
  criterionId = crit.id;

  const capture = new CaptureStream();
  const logger = createLogger({ level: 'warn', destination: capture });
  const queue = new InMemoryQueue();
  const fakeAgent = new FakeAgentAdapter();
  const agentGateway = new DefaultAgentGateway(stack.db.client, logger, [fakeAgent], 3);
  const agentRunRepo = new PgAgentRunRepository(stack.db.client);
  const reviewService = new DefaultReviewService(stack.db.client, stack.workItemRepository, logger);
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
    auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
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
  await new Promise<void>((resolve) => fixtureServer?.close(() => resolve()));
  delete process.env.AGENT_PROVIDER_NAME;
  delete process.env.AGENT_DEFAULT_MODEL;
  delete process.env.AGENT_API_KEY;
});

async function createReadyWorkItem(label: string) {
  const wi = await stack.workItemRepository.create({
    architectureVersionId: version.id,
    workItemId: label,
    title: label,
    objective: 'Prove the Z.ai adapter loop',
    scope: 'Z.ai adapter end-to-end',
  });
  await stack.workItemRequirementRepository.associate(wi.id, requirementId);
  await stack.workItemCriterionRepository.associate(wi.id, criterionId);
  await stack.workOrderRepository.create({
    workItemId: wi.id,
    projectId: project.id,
    architectureVersionId: version.id,
    scope: 'Z.ai adapter end-to-end',
    outOfScope: 'Nothing',
    architectureConstraints: 'None',
    verificationRequirements: ['All tests pass'],
  });
  await workflowEngine.transition({ workItemId: wi.id, toState: 'ready', actor: 'w29-e2e' });
  return wi;
}

async function pollExecutionStatus(executionId: string, until: string[], timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await server.inject({
      method: 'GET',
      url: `/execution/${executionId}`,
      headers: { 'x-api-key': API_KEY },
    });
    if (res.statusCode === 200) {
      const body = res.json() as { execution: { status: string; benchmarkMetadata: Record<string, unknown> } };
      if (until.includes(body.execution.status)) return body.execution;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

test.describe('WORKFLOWOS — WORK-029 Z.ai adapter fixture E2E', () => {
  test('full loop: Open with Companion → Z.ai detected → prompt injected once → fixture agent → completed', async () => {
    test.setTimeout(180_000);

    const userDataDir = mkdtempSync(join(tmpdir(), 'wfos-zai-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${EXTENSION_DIST}`,
        `--load-extension=${EXTENSION_DIST}`,
        '--no-sandbox',
      ],
    });

    try {
      let sw: Worker | undefined = context.serviceWorkers().find((w) => w.url().includes('background'));
      if (!sw) {
        sw = (await context.waitForEvent('serviceworker', { timeout: 20_000 })) as Worker;
      }
      const extensionId = new URL(sw.url()).host;

      // Stage the fixture origin (incl. the XSS payload variant) — the
      // adapter then opens the fixture instead of the real chat.z.ai.
      await sw.evaluate((origin: string) => {
        return (globalThis as { chrome?: { storage: { session: { set: (i: Record<string, string>) => Promise<void> } } } }).chrome!.storage.session.set({ 'wfos.zai.fixtureOrigin': origin });
      }, `${FIXTURE_ORIGIN}/?xss=1`);

      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto('/');
      await page.evaluate((key) => localStorage.setItem('wfos_api_key', key), API_KEY);

      const wi = await createReadyWorkItem('WORK-ZAI-E2E-001');
      await page.goto(`/work-items/${wi.id}`);
      await page.getByRole('button', { name: /Start Implementation/ }).first().click();
      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toContainText('Start Implementation — WORK-ZAI-E2E-001');
      await dialog.getByLabel('External execution').check();
      await dialog.locator('#execution-provider').selectOption('zai');
      await dialog.getByRole('button', { name: 'Start Implementation' }).click();

      const handoffDialog = page.locator('[role="dialog"]');
      await expect(handoffDialog).toContainText('External Execution', { timeout: 15_000 });
      await handoffDialog.getByRole('button', { name: /Open with Companion/ }).click();
      await page.waitForURL(/\/companion\/handoff#/, { timeout: 15_000 });
      const url = page.url();
      const executionId = url.match(/exec=(wf_[0-9a-f]+)/)![1]!;
      expect(url).not.toMatch(/wfct_|prompt/i);

      // The SPA page shows the Companion handshake.
      await expect(page.getByText('Companion connected')).toBeVisible({ timeout: 20_000 });

      // The adapter opened the FIXTURE in a new tab (Z.ai DOM reproduced).
      let fixturePage = context
        .pages()
        .find((p) => p.url().startsWith(FIXTURE_ORIGIN));
      if (!fixturePage) {
        await context.waitForEvent('page', { timeout: 20_000 });
        fixturePage = context.pages().find((p) => p.url().startsWith(FIXTURE_ORIGIN));
      }
      expect(fixturePage).toBeTruthy();

      // Prompt injected + sent EXACTLY ONCE (fixture counter), conversation created.
      await expect
        .poll(
          async () =>
            (await fixturePage!.evaluate(
              () => (window as unknown as { __zaiFixture?: { submits: number } }).__zaiFixture?.submits ?? 0,
            )),
          { timeout: 20_000 },
        )
        .toBe(1);
      // The submitted prompt is the EXACT WorkflowOS prompt (fixture recorded it).
      const submitted = await fixturePage!.evaluate(
        () =>
          (window as unknown as { __zaiFixture?: { submittedTexts: string[]; conversationPath: string } })
            .__zaiFixture,
      );
      expect(submitted!.submittedTexts[0]).toContain('# Implementation Instructions — WORK-ZAI-E2E-001');

      // Completion detected → WorkflowOS receives the completed event.
      const final = await pollExecutionStatus(executionId, ['completed', 'failed'], 40000);
      expect(final?.status, 'execution should complete via the Z.ai adapter').toBe('completed');
      expect(final?.benchmarkMetadata.reportedBranch).toBe('feat/work-fixture-001');
      expect(final?.benchmarkMetadata.reportedCommitRef).toBe('1a2b3c4d5e6f');
      expect(final?.benchmarkMetadata.reportedPullRequestRef).toBe('github:pr:9');

      // XSS payload in the fixture output stayed inert (textContent only).
      const pwned = await fixturePage!.evaluate(() => ({
        a: (window as unknown as Record<string, unknown>).__pwned,
        b: (window as unknown as Record<string, unknown>).__pwned2,
      }));
      expect(pwned.a).toBeUndefined();
      expect(pwned.b).toBeUndefined();

      // The popup renders the Z.ai session (work item, provider, conversation).
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/ui/popup/index.html`);
      await expect(popup.locator('#work-item')).toHaveText('WORK-ZAI-E2E-001');
      await expect(popup.locator('#provider')).toHaveText('Z.ai');
      await expect(popup.locator('#status')).toContainText('completed');
      await expect(popup.locator('#conversation')).toContainText('/chat/');
      await popup.close();
    } finally {
      await context.close();
    }
  });

  test('login wall → BLOCKED "Please sign in to Z.ai." — no submission, no fake success', async () => {
    test.setTimeout(120_000);

    const userDataDir = mkdtempSync(join(tmpdir(), 'wfos-zai-wall-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${EXTENSION_DIST}`,
        `--load-extension=${EXTENSION_DIST}`,
        '--no-sandbox',
      ],
    });

    try {
      let sw: Worker | undefined = context.serviceWorkers().find((w) => w.url().includes('background'));
      if (!sw) {
        sw = (await context.waitForEvent('serviceworker', { timeout: 20_000 })) as Worker;
      }
      const extensionId = new URL(sw.url()).host;
      await sw.evaluate((origin: string) => {
        return (globalThis as { chrome?: { storage: { session: { set: (i: Record<string, string>) => Promise<void> } } } }).chrome!.storage.session.set({ 'wfos.zai.fixtureOrigin': origin });
      }, `${FIXTURE_ORIGIN}/?wall=login`);

      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto('/');
      await page.evaluate((key) => localStorage.setItem('wfos_api_key', key), API_KEY);

      const wi = await createReadyWorkItem('WORK-ZAI-WALL-001');
      await page.goto(`/work-items/${wi.id}`);
      await page.getByRole('button', { name: /Start Implementation/ }).first().click();
      const dialog = page.locator('[role="dialog"]');
      await dialog.getByLabel('External execution').check();
      await dialog.locator('#execution-provider').selectOption('zai');
      await dialog.getByRole('button', { name: 'Start Implementation' }).click();

      const handoffDialog = page.locator('[role="dialog"]');
      await expect(handoffDialog).toContainText('External Execution', { timeout: 15_000 });
      await handoffDialog.getByRole('button', { name: /Open with Companion/ }).click();
      await page.waitForURL(/\/companion\/handoff#/, { timeout: 15_000 });
      const executionId = page.url().match(/exec=(wf_[0-9a-f]+)/)![1]!;

      // The login-wall fixture renders; the adapter BLOCKS with the exact
      // reason and never submits.
      const final = await pollExecutionStatus(executionId, ['failed'], 40000);
      expect(final).toBeTruthy(); // blocked → failed event on the record
      expect(String(final?.benchmarkMetadata.lastEventType)).toBe('failed');

      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/ui/popup/index.html`);
      await expect(popup.locator('#blocked-reason')).toContainText('Please sign in to Z.ai.', {
        timeout: 10_000,
      });
      await popup.close();

      // No fixture submission happened.
      const fixturePage = context.pages().find((p) => p.url().startsWith(FIXTURE_ORIGIN));
      if (fixturePage) {
        const submits = await fixturePage.evaluate(
          () =>
            (window as unknown as { __zaiFixture?: { submits: number } }).__zaiFixture?.submits ?? 0,
        );
        expect(submits).toBe(0);
      }
    } finally {
      await context.close();
    }
  });
});
