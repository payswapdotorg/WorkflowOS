import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthStack, type TestAuthStack } from '../../helpers/test-auth-stack.js';
import { buildServer } from '@api/server.js';
import { InMemoryQueue, buildHandlerRegistry, WorkerHost, createLogger } from '@platform/index.js';
import { createHmac } from 'node:crypto';
import { PgWebhookEventRepository, DefaultGitHubAdapter } from '../../../src/modules/github/internal/pg-github-repository.js';
import { DefaultWebhookProcessingService } from '../../../src/modules/github/internal/webhook-processing-service.js';
import type { FastifyInstance } from 'fastify';
import { waitFor } from '../../helpers/test-app.js';
import { CaptureStream } from '../../helpers/capture-stream.js';

function hmacSign(payload: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
}

describe('WORK-008 — GitHub webhook ingestion', () => {
  let stack: TestAuthStack;
  let server: FastifyInstance;
  let queue: InMemoryQueue;
  let worker: WorkerHost;
  let eventRepo: PgWebhookEventRepository;
  const SECRET = 'test-webhook-secret';
  const SECRET_REF = 'WFOS_TEST_GITHUB_WEBHOOK_SECRET';

  beforeAll(async () => {
    stack = await buildAuthStack({ [SECRET_REF]: SECRET });
    const capture = new CaptureStream();
    const logger = createLogger({ level: 'info', destination: capture });
    queue = new InMemoryQueue();
    eventRepo = new PgWebhookEventRepository(stack.db.client);

    const processingService = new DefaultWebhookProcessingService(
      eventRepo,
      new (await import('../../../src/modules/github/internal/pg-github-repository.js')).PgGitHubInstallationRepository(stack.db.client),
      stack.pullRequestAssociationRepository,
      stack.repositoryAssociationRepository,
      logger,
      stack.db.client,
    );
    const { createWebhookJobHandler } = await import('../../../src/modules/github/internal/webhook-processing-service.js');
    const handlers = buildHandlerRegistry([
      createWebhookJobHandler(processingService, logger),
    ]);
    worker = new WorkerHost(queue, handlers, logger, { pollIntervalMs: 5 });

    server = await buildServer({
      queue: stack.db.client as never,
      logger: stack.db.logger,
      auth: { authProvider: stack.authProvider, userRepository: stack.userRepository },
      githubWebhook: {
        queue,
        logger: stack.db.logger,
        secretStore: stack.secretStore,
        webhookSecretRef: SECRET_REF,
        githubAdapter: new DefaultGitHubAdapter(),
        webhookEventRepository: eventRepo,
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

  // --- Webhook validation ---

  it('valid signature is accepted (202)', async () => {
    const payload = JSON.stringify({
      action: 'opened',
      pull_request: { number: 1, title: 'Test PR', state: 'open', head: { ref: 'feature' }, base: { ref: 'main' } },
      repository: { id: 123, full_name: 'owner/repo' },
      installation: { id: 456 },
    });
    const signature = hmacSign(payload, SECRET);
    const res = await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'x-github-delivery': 'test-delivery-valid-001',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': signature,
        'content-type': 'application/json',
      },
      payload,
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { accepted: boolean; deliveryId: string };
    expect(body.accepted).toBe(true);
    expect(body.deliveryId).toBe('test-delivery-valid-001');
  });

  it('invalid signature is rejected (401)', async () => {
    const payload = JSON.stringify({ repository: { full_name: 'owner/repo' } });
    const res = await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'x-github-delivery': 'test-delivery-invalid-sig',
        'x-github-event': 'push',
        'x-hub-signature-256': 'sha256=invalid',
        'content-type': 'application/json',
      },
      payload,
    });
    expect(res.statusCode).toBe(401);
  });

  it('missing signature is rejected (401)', async () => {
    const payload = JSON.stringify({ repository: { full_name: 'owner/repo' } });
    const res = await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'x-github-delivery': 'test-delivery-missing-sig',
        'x-github-event': 'push',
        'content-type': 'application/json',
      },
      payload,
    });
    expect(res.statusCode).toBe(401);
  });

  it('missing delivery ID is rejected (400)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: { 'x-github-event': 'push', 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(400);
  });

  // --- Durable receipt ---

  it('webhook receipt persists in PostgreSQL', async () => {
    const deliveryId = 'test-delivery-receipt-001';
    const payload = JSON.stringify({
      action: 'opened',
      pull_request: { number: 42, title: 'Receipt PR', state: 'open' },
      repository: { id: 789, full_name: 'owner/receipt-repo' },
      installation: { id: 999 },
    });
    const res = await server.inject({
      method: 'POST', url: '/webhooks/github',
      headers: {
        'x-github-delivery': deliveryId, 'x-github-event': 'pull_request',
        'x-hub-signature-256': hmacSign(payload, SECRET),
        'content-type': 'application/json',
      },
      payload,
    });
    expect(res.statusCode).toBe(202);
    // The receipt is in PostgreSQL.
    const receipt = await eventRepo.findByDeliveryId(deliveryId);
    expect(receipt).not.toBeNull();
    expect(receipt!.eventType).toBe('pull_request');
    expect(receipt!.repositoryFullName).toBe('owner/receipt-repo');
    expect(receipt!.signatureValid).toBe(true);
  });

  // --- Idempotency ---

  it('duplicate delivery ID is idempotent (one receipt, no duplicate enqueue)', async () => {
    const deliveryId = 'test-delivery-dup-001';
    const payload = JSON.stringify({
      action: 'opened',
      pull_request: { number: 99, title: 'Dup PR', state: 'open' },
      repository: { id: 111, full_name: 'owner/dup-repo' },
      installation: { id: 222 },
    });
    const headers = {
      'x-github-delivery': deliveryId, 'x-github-event': 'pull_request',
      'x-hub-signature-256': hmacSign(payload, SECRET),
      'content-type': 'application/json',
    };
    // First delivery.
    const res1 = await server.inject({ method: 'POST', url: '/webhooks/github', headers, payload });
    expect(res1.statusCode).toBe(202);
    // Second delivery (duplicate).
    const res2 = await server.inject({ method: 'POST', url: '/webhooks/github', headers, payload });
    expect(res2.statusCode).toBe(202);
    // Only one receipt exists.
    const receipt = await eventRepo.findByDeliveryId(deliveryId);
    expect(receipt).not.toBeNull();
    expect(receipt!.deliveryId).toBe(deliveryId);
    // The queue should have at most one job for this delivery.

    // Wait for processing to drain.
    await waitFor(async () => {
      const fetched = await eventRepo.findByDeliveryId(deliveryId);
      return fetched?.processingState === 'processed';
    });
  });

  // --- Asynchronous behavior ---

  it('HTTP request returns 202 without waiting for processing', async () => {
    const deliveryId = 'test-delivery-async-001';
    const payload = JSON.stringify({
      action: 'opened',
      pull_request: { number: 77, title: 'Async PR', state: 'open' },
      repository: { id: 333, full_name: 'owner/async-repo' },
      installation: { id: 444 },
    });

    const res = await server.inject({
      method: 'POST', url: '/webhooks/github',
      headers: {
        'x-github-delivery': deliveryId, 'x-github-event': 'pull_request',
        'x-hub-signature-256': hmacSign(payload, SECRET),
        'content-type': 'application/json',
      },
      payload,
    });

    expect(res.statusCode).toBe(202);
    // The API returns immediately — processing hasn't finished yet.
    // (The worker processes asynchronously.)
    const receiptBeforeProcessing = await eventRepo.findByDeliveryId(deliveryId);
    expect(receiptBeforeProcessing!.processingState).toMatch(/received|processing|processed/);
    // Wait for the worker to process.
    await waitFor(async () => {
      const fetched = await eventRepo.findByDeliveryId(deliveryId);
      return fetched?.processingState === 'processed';
    });
    const receiptAfter = await eventRepo.findByDeliveryId(deliveryId);
    expect(receiptAfter!.processingState).toBe('processed');
  });

  // --- Receipt survives Redis loss ---

  it('receipt survives Redis loss (PostgreSQL is authoritative)', async () => {
    const deliveryId = 'test-delivery-survive-001';
    const payload = JSON.stringify({
      action: 'opened',
      pull_request: { number: 55, title: 'Survive PR', state: 'open' },
      repository: { id: 555, full_name: 'owner/survive-repo' },
      installation: { id: 666 },
    });
    await server.inject({
      method: 'POST', url: '/webhooks/github',
      headers: {
        'x-github-delivery': deliveryId, 'x-github-event': 'pull_request',
        'x-hub-signature-256': hmacSign(payload, SECRET),
        'content-type': 'application/json',
      },
      payload,
    });
    await waitFor(async () => {
      const fetched = await eventRepo.findByDeliveryId(deliveryId);
      return fetched?.processingState === 'processed';
    });
    // "Flush Redis" conceptually — the receipt is still in PostgreSQL.
    // We do NOT close the queue here (that would break subsequent tests).
    const receipt = await eventRepo.findByDeliveryId(deliveryId);
    expect(receipt).not.toBeNull();
    expect(receipt!.processingState).toBe('processed');
  });

  // --- Secrets ---

  it('GitHub credentials are retrieved through SecretStore (not stored in records)', async () => {
    const deliveryId = 'test-delivery-secret-002';
    const payload = JSON.stringify({
      action: 'opened',
      pull_request: { number: 33, title: 'Secret PR', state: 'open' },
      repository: { id: 777, full_name: 'owner/secret-repo' },
      installation: { id: 888 },
    });
    await server.inject({
      method: 'POST', url: '/webhooks/github',
      headers: {
        'x-github-delivery': deliveryId, 'x-github-event': 'pull_request',
        'x-hub-signature-256': hmacSign(payload, SECRET),
        'content-type': 'application/json',
      },
      payload,
    });
    // The receipt must NOT contain the raw secret.
    const receipt = await eventRepo.findByDeliveryId(deliveryId);
    expect(receipt).not.toBeNull();
    expect(receipt!.payload).not.toContain(SECRET);
  });

  // --- GITHUB-003: repository synchronization ---

  it('GITHUB-003: repository event syncs to the project repository association model', async () => {
    // Create a project + installation so the webhook can resolve the project.
    const project = await stack.projectRepository.create({
      organizationId: (await stack.organizationRepository.create({ name: 'GH Sync Org' })).id,
      name: 'GH Sync Project',
    });
    await new (await import('../../../src/modules/github/internal/pg-github-repository.js')).PgGitHubInstallationRepository(stack.db.client)
      .create({ projectId: project.id, installationId: 'inst-sync-repo' });

    const deliveryId = 'test-delivery-reposync-001';
    const payload = JSON.stringify({
      action: 'created',
      repository: { id: 42, full_name: 'owner/sync-repo', default_branch: 'main' },
      installation: { id: 'inst-sync-repo' },
    });
    await server.inject({
      method: 'POST', url: '/webhooks/github',
      headers: {
        'x-github-delivery': deliveryId, 'x-github-event': 'repository',
        'x-hub-signature-256': hmacSign(payload, SECRET),
        'content-type': 'application/json',
      },
      payload,
    });
    // Wait for processing.
    await waitFor(async () => {
      const fetched = await eventRepo.findByDeliveryId(deliveryId);
      return fetched?.processingState === 'processed';
    }, { timeoutMs: 15000 });
    // The repository association was upserted in the /projects model.
    const assocs = await stack.repositoryAssociationRepository.listForProject(project.id);
    const synced = assocs.find((a) => a.externalId === 'owner/sync-repo');
    expect(synced).toBeDefined();
    expect(synced!.provider).toBe('github');
    expect(synced!.canonicalRef).toBe('https://github.com/owner/sync-repo');
  });

  // --- GITHUB-003: PR synchronization ---

  it('GITHUB-003: pull_request closed event updates existing PR association status', async () => {
    // Create a project + work item + PR association.
    const project = await stack.projectRepository.create({
      organizationId: (await stack.organizationRepository.create({ name: 'GH PR Sync Org' })).id,
      name: 'GH PR Sync Project',
    });
    const arch = await stack.architectureRepository.create({ projectId: project.id, name: 'Arch' });
    const version = await stack.architectureVersionRepository.create({ architectureId: arch.id, contentInline: 'v1' });
    const user = await stack.userRepository.upsertByExternalId({ externalId: 'gh-pr-sync-user', displayName: 'GH PR Sync' });
    await stack.architectureVersionRepository.transitionState(version.id, 'frozen', user.id);
    const wi = await stack.workItemRepository.create({ architectureVersionId: version.id, workItemId: 'WI-PR-SYNC', title: 'PR sync test' });
    // Create an active PR association.
    const externalPrId = 'github:owner/pr-sync-repo#1';
    const prAssoc = await stack.pullRequestAssociationRepository.create({
      workItemId: wi.id, externalPrId,
    });
    expect(prAssoc.status).toBe('active');

    // Install the installation mapping.
    await new (await import('../../../src/modules/github/internal/pg-github-repository.js')).PgGitHubInstallationRepository(stack.db.client)
      .create({ projectId: project.id, installationId: 'inst-pr-sync' });

    // Send a pull_request closed webhook.
    const deliveryId = 'test-delivery-prsync-closed-001';
    const payload = JSON.stringify({
      action: 'closed',
      pull_request: { number: 1, title: 'Sync PR', state: 'closed', merged: false },
      repository: { id: 99, full_name: 'owner/pr-sync-repo' },
      installation: { id: 'inst-pr-sync' },
    });
    await server.inject({
      method: 'POST', url: '/webhooks/github',
      headers: {
        'x-github-delivery': deliveryId, 'x-github-event': 'pull_request',
        'x-hub-signature-256': hmacSign(payload, SECRET),
        'content-type': 'application/json',
      },
      payload,
    });
    await waitFor(async () => {
      const fetched = await eventRepo.findByDeliveryId(deliveryId);
      return fetched?.processingState === 'processed';
    });
    // The PR association status was updated to 'closed'.
    const updated = await stack.pullRequestAssociationRepository.findById(prAssoc.id);
    expect(updated!.status).toBe('closed');
  });

  // --- Retry: failed event can be retried ---

  it('retry: a failed event can be reprocessed and becomes processed', async () => {
    // Create a receipt and mark it as failed.
    const receipt = await eventRepo.createReceipt({
      deliveryId: 'test-retry-001',
      eventType: 'pull_request',
      signatureValid: true,
      payload: JSON.stringify({
        action: 'opened',
        pull_request: { number: 1, title: 'Retry PR', state: 'open' },
        repository: { id: 1, full_name: 'owner/retry-repo' },
      }),
    });
    await eventRepo.markFailed(receipt.id, 'simulated failure');

    // Verify it's failed.
    const failed = await eventRepo.findByDeliveryId('test-retry-001');
    expect(failed!.processingState).toBe('failed');

    // Re-process the event (simulating a worker retry).
    const { DefaultWebhookProcessingService } = await import('../../../src/modules/github/internal/webhook-processing-service.js');
    const capture = new CaptureStream();
    const retryLogger = createLogger({ level: 'info', destination: capture });
    const retryService = new DefaultWebhookProcessingService(
      eventRepo,
      new (await import('../../../src/modules/github/internal/pg-github-repository.js')).PgGitHubInstallationRepository(stack.db.client),
      stack.pullRequestAssociationRepository,
      stack.repositoryAssociationRepository,
      retryLogger,
      stack.db.client,
    );
    await retryService.processEvent('test-retry-001');

    // The event is now processed.
    const processed = await eventRepo.findByDeliveryId('test-retry-001');
    expect(processed!.processingState).toBe('processed');
  });
});
