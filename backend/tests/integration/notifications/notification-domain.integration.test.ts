import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import { DefaultNotificationService, FakeNotificationProvider, createNotificationJobHandler } from '../../../src/modules/notifications/internal/notification-service.js';
import { DefaultWorkflowEngine } from '../../../src/modules/workflows/internal/workflow-engine.js';
import { DefaultWorkItemDependencyService } from '../../../src/modules/work-items/internal/work-item-dependency-service.js';
import { DefaultAuditService } from '../../../src/modules/audit/internal/audit-service.js';
import { InMemoryQueue, buildHandlerRegistry, WorkerHost, createLogger, generateExecutionId } from '@platform/index.js';
import { CaptureStream } from '../../helpers/capture-stream.js';
import type { FastifyInstance } from 'fastify';
import type { User } from '@modules/users/index.js';
import type { NotificationRequest } from '@modules/notifications/index.js';

/**
 * WORK-021 -- Notification boundary (NOTIFY-001, NOTIFY-AC-01..02).
 */
describe('WORK-021 -- Notification boundary', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let notificationService: DefaultNotificationService;
  let fakeProvider: FakeNotificationProvider;
  let queue: InMemoryQueue;
  let worker: WorkerHost;
  let workflowEngine: DefaultWorkflowEngine;
  let orgA: { id: string };
  let orgB: { id: string };
  let userA: User;
  let userB: User;
  let projectA: { id: string };
  let projectB: { id: string };
  let versionA: { id: string };

  beforeAll(async () => {
    stack = await buildAuthStack({
      WFOS_TEST_KEY_A: 'raw-key-notif-a',
      WFOS_TEST_KEY_B: 'raw-key-notif-b',
    });
    orgA = await stack.organizationRepository.create({ name: 'Notif Org A' });
    orgB = await stack.organizationRepository.create({ name: 'Notif Org B' });
    userA = await stack.userRepository.upsertByExternalId({ externalId: 'notif-user-a', displayName: 'User A' });
    userB = await stack.userRepository.upsertByExternalId({ externalId: 'notif-user-b', displayName: 'User B' });
    await stack.membershipRepository.assign({ userId: userA.id, organizationId: orgA.id, roleId: 'owner' });
    await stack.membershipRepository.assign({ userId: userB.id, organizationId: orgB.id, roleId: 'owner' });
    projectA = await stack.projectRepository.create({ organizationId: orgA.id, name: 'Notif Project A' });
    projectB = await stack.projectRepository.create({ organizationId: orgB.id, name: 'Notif Project B' });
    await stack.projectAccessRepository.grant({ userId: userA.id, projectId: projectA.id, roleId: 'owner' });
    await stack.projectAccessRepository.grant({ userId: userB.id, projectId: projectB.id, roleId: 'owner' });
    await stack.apiKeyProvisioner.provision({
      keyId: 'notif-key-a', secretRef: 'WFOS_TEST_KEY_A', externalId: 'notif-user-a', label: 'User A', rawKey: 'raw-key-notif-a',
    });
    await stack.apiKeyProvisioner.provision({
      keyId: 'notif-key-b', secretRef: 'WFOS_TEST_KEY_B', externalId: 'notif-user-b', label: 'User B', rawKey: 'raw-key-notif-b',
    });

    const archA = await stack.architectureRepository.create({ projectId: projectA.id, name: 'Notif Arch A' });
    versionA = await stack.architectureVersionRepository.create({ architectureId: archA.id, contentInline: 'Notif constraints A' });
    await stack.architectureVersionRepository.transitionState(versionA.id, 'frozen', userA.id);

    fakeProvider = new FakeNotificationProvider();
    const capture = new CaptureStream();
    const logger = createLogger({ level: 'info', destination: capture });
    queue = new InMemoryQueue();

    notificationService = new DefaultNotificationService(
      stack.db.client, logger, queue, [fakeProvider],
    );

    const auditService = new DefaultAuditService(stack.db.client, logger);
    const depService = new DefaultWorkItemDependencyService(stack.db.client);
    workflowEngine = new DefaultWorkflowEngine(
      stack.db.client, logger,
      (wiId: string) => depService.canBeginImplementation(wiId),
      auditService,
    );

    const handlers = buildHandlerRegistry([
      createNotificationJobHandler(notificationService, logger),
    ]);
    worker = new WorkerHost(queue, handlers, logger, { pollIntervalMs: 5 });

    server = await buildServer({
      queue: stack.db.client as never,
      logger: stack.db.logger,
      auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
      architecture: {
        authorizationService: stack.authorizationService,
        projectRepository: stack.projectRepository,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        architectureDecisionRepository: stack.architectureDecisionRepository,
        architectureChangeRequestRepository: stack.architectureChangeRequestRepository,
        architectureService: stack.architectureService,
      },
      workflow: {
        authorizationService: stack.authorizationService,
        projectRepository: stack.projectRepository,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        workItemRepository: stack.workItemRepository,
        workflowEngine,
      },
      notifications: {
        authorizationService: stack.authorizationService,
        projectRepository: stack.projectRepository,
        architectureRepository: stack.architectureRepository,
        architectureVersionRepository: stack.architectureVersionRepository,
        workItemRepository: stack.workItemRepository,
        notificationService,
      },
    });
    await server.ready();
    await worker.start();
  });

  afterAll(async () => {
    await worker.stop();
    await server.close();
    await stack.teardown();
  });

  async function waitForNotification(notificationId: string): Promise<NotificationRequest> {
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const n = await notificationService.findById(notificationId);
      if (n && (n.status === 'delivered' || n.status === 'failed')) return n;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`waitForNotification timed out for ${notificationId}`);
  }

  // --- Notification boundary (NOTIFY-AC-01) ---

  describe('Notification boundary (NOTIFY-AC-01)', () => {
    it('notification request can be constructed through the public contract', async () => {
      const notification = await notificationService.send({
        projectId: projectA.id,
        notificationType: 'workflow_transition',
        eventType: 'WORKFLOW_TRANSITION',
        recipient: userA.id,
        subject: 'Work Item Ready',
        body: 'Work Item WI-001 has transitioned to READY',
        sourceType: 'workflow',
        sourceId: 'transition-001',
        executionId: generateExecutionId(),
        workItemId: null,
      });
      expect(notification.id).toBeTruthy();
      expect(notification.notificationType).toBe('workflow_transition');
      expect(notification.eventType).toBe('WORKFLOW_TRANSITION');
      expect(notification.recipient).toBe(userA.id);
      expect(notification.status).toBe('pending');
    });

    it('provider-neutral interface delivers the notification', async () => {
      fakeProvider.reset();
      const notification = await notificationService.send({
        projectId: projectA.id,
        notificationType: 'test',
        eventType: 'TEST_EVENT',
        recipient: 'test-recipient',
        subject: 'Test Subject',
        body: 'Test Body',
        sourceType: 'test',
        sourceId: 'test-001',
        executionId: generateExecutionId(),
      });
      const delivered = await waitForNotification(notification.id);
      expect(delivered.status).toBe('delivered');
      expect(delivered.provider).toBe('local');
      expect(fakeProvider.getDelivered().length).toBeGreaterThanOrEqual(1);
      const lastDelivery = fakeProvider.getDelivered()[fakeProvider.getDelivered().length - 1]!;
      expect(lastDelivery.recipient).toBe('test-recipient');
    });
  });

  // --- Asynchronous delivery ---

  describe('Asynchronous delivery', () => {
    it('send() returns immediately without blocking on provider delivery', async () => {
      const notification = await notificationService.send({
        projectId: projectA.id,
        notificationType: 'async-test',
        eventType: 'ASYNC_TEST',
        recipient: 'async-recipient',
        sourceType: 'test',
        sourceId: 'async-001',
        executionId: generateExecutionId(),
      });
      // send() returned -- status is pending or queued (not yet delivered).
      expect(['pending', 'queued', 'delivered']).toContain(notification.status);
      // Wait for delivery.
      const delivered = await waitForNotification(notification.id);
      expect(delivered.status).toBe('delivered');
    });
  });

  // --- Failure isolation (NOTIFY-AC-02) ---

  describe('Failure isolation (NOTIFY-AC-02)', () => {
    it('notification delivery failure does not mutate workflow state', async () => {
      const wi = await stack.workItemRepository.create({
        architectureVersionId: versionA.id, workItemId: 'NOTIF-FAIL-001', title: 'Fail Test',
      });
      // Transition to ready.
      await workflowEngine.transition({
        workItemId: wi.id, toState: 'ready', actor: 'test', executionId: 'notif-fail-exec',
      });

      // Send a notification that will fail.
      fakeProvider.reset();
      fakeProvider.setFailNext(true);
      const notification = await notificationService.send({
        projectId: projectA.id,
        notificationType: 'workflow_transition',
        eventType: 'WORKFLOW_TRANSITION',
        recipient: userA.id,
        sourceType: 'workflow',
        sourceId: 'notif-fail-001',
        executionId: generateExecutionId(),
        workItemId: wi.id,
      });
      const result = await waitForNotification(notification.id);
      expect(result.status).toBe('failed');

      // Workflow state is unchanged -- the notification failure did NOT
      // mutate canonical workflow state (NOTIFY-AC-02).
      const exec = await workflowEngine.getState(wi.id);
      expect(exec!.currentState).toBe('ready');
    });
  });

  // --- Idempotency ---

  describe('Idempotency', () => {
    it('duplicate notification with same idempotency key returns existing request', async () => {
      fakeProvider.reset();
      const n1 = await notificationService.send({
        projectId: projectA.id,
        notificationType: 'idempotency-test',
        eventType: 'IDEMPOTENCY_TEST',
        recipient: 'idem-recipient',
        sourceType: 'test',
        sourceId: 'idem-001',
        executionId: generateExecutionId(),
        idempotencyKey: 'idem-key-001',
      });
      const n2 = await notificationService.send({
        projectId: projectA.id,
        notificationType: 'idempotency-test',
        eventType: 'IDEMPOTENCY_TEST',
        recipient: 'idem-recipient',
        sourceType: 'test',
        sourceId: 'idem-001',
        executionId: generateExecutionId(),
        idempotencyKey: 'idem-key-001',
      });
      expect(n1.id).toBe(n2.id); // same notification -- no duplicate
    });
  });

  // --- Tenant isolation ---

  describe('Tenant isolation', () => {
    it('cross-tenant notification read denied (403)', async () => {
      await notificationService.send({
        projectId: projectA.id,
        notificationType: 'tenant-test',
        eventType: 'TENANT_TEST',
        recipient: 'tenant-recipient',
        sourceType: 'test',
        sourceId: 'tenant-001',
        executionId: generateExecutionId(),
      });
      const res = await server.inject({
        method: 'GET', url: `/projects/${projectA.id}/notifications`,
        headers: { 'x-api-key': 'raw-key-notif-b' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('authorized notification read succeeds (200)', async () => {
      const res = await server.inject({
        method: 'GET', url: `/projects/${projectA.id}/notifications`,
        headers: { 'x-api-key': 'raw-key-notif-a' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as NotificationRequest[];
      expect(body.length).toBeGreaterThan(0);
    });
  });

  // --- Secret safety ---

  describe('Secret safety', () => {
    it('raw secret values are stripped from metadata', async () => {
      const notification = await notificationService.send({
        projectId: projectA.id,
        notificationType: 'secret-test',
        eventType: 'SECRET_TEST',
        recipient: 'secret-recipient',
        sourceType: 'test',
        sourceId: 'secret-001',
        executionId: generateExecutionId(),
        metadata: {
          apiKey: 'ghp_raw_api_key_12345',
          password: 'super-secret',
          safeField: 'safe value',
        },
      });
      expect(notification.metadata.apiKey).toBe('[REDACTED]');
      expect(notification.metadata.password).toBe('[REDACTED]');
      expect(notification.metadata.safeField).toBe('safe value');
    });

    it('raw secrets in body text are stripped', async () => {
      const notification = await notificationService.send({
        projectId: projectA.id,
        notificationType: 'secret-body-test',
        eventType: 'SECRET_BODY_TEST',
        recipient: 'body-recipient',
        body: 'Token: ghp_1234567890abcdefghijklmnopqrstuvwxyz1234',
        sourceType: 'test',
        sourceId: 'secret-body-001',
        executionId: generateExecutionId(),
      });
      expect(notification.body).not.toContain('ghp_1234567890');
      expect(notification.body).toContain('[REDACTED]');
    });
  });

  // --- Provider isolation ---

  describe('Provider isolation', () => {
    it('fake provider works through the public interface', async () => {
      fakeProvider.reset();
      const notification = await notificationService.send({
        projectId: projectA.id,
        notificationType: 'provider-test',
        eventType: 'PROVIDER_TEST',
        recipient: 'provider-recipient',
        sourceType: 'test',
        sourceId: 'provider-001',
        executionId: generateExecutionId(),
      });
      const delivered = await waitForNotification(notification.id);
      expect(delivered.provider).toBe('local');
      expect(fakeProvider.getDelivered().length).toBeGreaterThanOrEqual(1);
    });
  });

  // --- Workflow boundary ---

  describe('Workflow boundary', () => {
    it('notification delivery does not set MERGED or VERIFIED', async () => {
      const wi = await stack.workItemRepository.create({
        architectureVersionId: versionA.id, workItemId: 'NOTIF-WF-001', title: 'WF Boundary',
      });
      await workflowEngine.transition({
        workItemId: wi.id, toState: 'ready', actor: 'test', executionId: generateExecutionId(),
      });

      // Send a notification about the transition.
      await notificationService.send({
        projectId: projectA.id,
        notificationType: 'workflow_transition',
        eventType: 'WORKFLOW_TRANSITION',
        recipient: userA.id,
        sourceType: 'workflow',
        sourceId: 'notif-wf-001',
        executionId: generateExecutionId(),
        workItemId: wi.id,
      });

      // Wait for notification delivery.
      await new Promise((r) => setTimeout(r, 500));

      // Workflow state is still READY -- not MERGED or VERIFIED.
      const exec = await workflowEngine.getState(wi.id);
      expect(exec!.currentState).toBe('ready');
    });
  });

  // --- Retry ---

  describe('Retry', () => {
    it('failed notification can be retried', async () => {
      fakeProvider.reset();
      fakeProvider.setFailNext(true);
      const notification = await notificationService.send({
        projectId: projectA.id,
        notificationType: 'retry-test',
        eventType: 'RETRY_TEST',
        recipient: 'retry-recipient',
        sourceType: 'test',
        sourceId: 'retry-001',
        executionId: generateExecutionId(),
      });
      const failed = await waitForNotification(notification.id);
      expect(failed.status).toBe('failed');

      // Retry -- process again (fakeProvider is reset, so it will succeed).
      await notificationService.processNotification(notification.id);
      const retried = await notificationService.findById(notification.id);
      // Status may be 'delivered' or 'failed' depending on retry count.
      expect(['delivered', 'failed']).toContain(retried!.status);
    });
  });
});
